// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shell: hydrates the snapshot, subscribes to the event channel, applies
// theme + language, and delegates link clicks to the http/https gate.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, clientStore, tryCall } from "./client";
import type { Snapshot } from "../shared/types";
import {
  SHORTCUT_COMMANDS,
  chordFromEvent,
  effectiveChord,
  sameChord,
  type ShortcutCommandId,
} from "../shared/shortcuts";
import { visibleThreads } from "../shared/threadOrder";
import { LanguageContext, useT } from "./locale";
import { translateError } from "./i18n";
import { applyTheme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { LinkPopover, type LinkPopoverState } from "./components/LinkPopover";
import { HelperPanel } from "./components/HelperPanel";
import { ensureTerminalBridge, setCodeFontOffset } from "./terminalRegistry";
import { fontSizeOffsets, resolveFontSizes, TYPE_DEFAULT } from "../shared/typeScale";
import { wallpaperBlurPx, wallpaperOpacity } from "../shared/wallpaper";
import { TerminalPanel } from "./components/TerminalPanel";
import { GitPanel } from "./components/GitPanel";

const store = clientStore;

/** F27 archiveThread prompt (frozen ArchiveThreadPrompt): Return
 *  archives the thread, the Delete button removes it entirely, Escape
 *  closes — the same two outcomes the sidebar's armed controls offer. */
function ArchivePrompt(props: {
  title: string;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
        if (e.key === "Enter") {
          e.preventDefault();
          props.onArchive();
        }
      }}
    >
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={t("Archive thread?")}>
        <h2>{t("Archive this thread?")}</h2>
        <p className="ckpt-note">{props.title}</p>
        <p className="ckpt-note">
          {t("Archiving keeps the thread and its history. Deleting removes it entirely.")}
        </p>
        <div className="modal-actions">
          <button className="primary" autoFocus onClick={props.onArchive}>
            {t("Archive")}
          </button>
          <button className="danger" onClick={props.onDelete}>
            {t("Delete thread")}
          </button>
          <button onClick={props.onClose}>{t("Cancel")}</button>
        </div>
      </div>
    </div>
  );
}

/** Sits inside LanguageContext so the dismiss label localizes correctly. */
function ErrorBanner(props: { text: string; onDismiss: () => void }): React.JSX.Element {
  const t = useT();
  return (
    <div className="banner error app-error" role="alert">
      <span className="grow">{translateError(t, props.text)}</span>
      <button className="icon-btn" aria-label={t("Dismiss")} onClick={props.onDismiss}>
        ×
      </button>
    </div>
  );
}

/** A81: the sidebar's edge hit-strip (frozen SidebarLayout drag zone). */
function SidebarEdge(props: {
  live: number;
  onBegin: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <div
      className="sidebar-edge"
      style={{ left: `${Math.max(0, props.live - 3)}px` }}
      onMouseDown={props.onBegin}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("Resize sidebar")}
    />
  );
}

export function App(): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** One dock slot shared by the terminal and Git panels — hiding the
   *  terminal never stops its sessions (they live in the registry pool). */
  const [dock, setDock] = useState<"terminal" | "git" | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** F27: sidebar visibility is a window-level toggle (frozen
   *  toggleSidebar, ⌘B) — collapsing never touches thread state. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** A81: the sidebar's edge drag (frozen SidebarLayout) — live width
   *  while held, settled/persisted only on release; <110 collapses. */
  const [edgeDrag, setEdgeDrag] = useState<number | null>(null);
  /** F27 archiveThread (⌘W): frozen "asks to archive; Delete is a click
   *  away" prompt for the SELECTED thread. */
  const [archivePrompt, setArchivePrompt] = useState(false);
  /** F04 link popover — frozen LinkPopover: one transient menu anchored
   *  under the right-clicked chat link; null = closed. */
  const [linkPop, setLinkPop] = useState<LinkPopoverState | null>(null);
  /** F26: installed wallpaper picture, fetched by basename over
   *  `wallpaper:data` — the renderer never holds a filesystem path. */
  const [wpUrl, setWpUrl] = useState<string | null>(null);
  /** F25 floating helper: the docked panel's side + reserved width
   *  while the chat column must keep clear of it (frozen
   *  sitsBesideComposer); null = the panel merely overlays a corner. */
  const [helperDock, setHelperDock] = useState<{
    side: "left" | "right";
    px: number;
  } | null>(null);
  const { snapshot, lastError } = useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.view,
  );

  useEffect(() => {
    // Subscribe FIRST (events buffer), then fetch the snapshot: its rev
    // boundary filters out anything already reflected in it. `disposed`
    // invalidates this cycle's late resolve under StrictMode replay.
    ensureTerminalBridge();
    let disposed = false;
    const gen = store.beginHydration();
    const detach = api().onEvent((e) => store.onBridgeEvent(e));
    api()
      .invoke("state:get", {})
      .then((s) => {
        if (disposed) return;
        store.hydrate(s as Snapshot, gen);
        setReady(true);
      })
      .catch((e: Error) => {
        if (!disposed) setFatal(e.message);
      });
    return () => {
      disposed = true;
      detach();
    };
  }, []);

  // F27 configurable shortcuts (frozen ShortcutStore dispatch): every
  // command's effective chord is the stored override or the frozen
  // default; a cleared binding answers to nothing. `mod` is Cmd on
  // macOS, Ctrl on Windows/Linux — captured per event via the bridge's
  // literal platform.
  useEffect(() => {
    const isDarwin = api().platform === "darwin";
    const overrides = snapshot?.settings.shortcuts;
    const run = (id: ShortcutCommandId) => {
      const snap = store.view.snapshot;
      const sel = snap?.threads.find((t) => t.id === snap.selectedThreadId) ?? null;
      switch (id) {
        case "commandPalette":
          setPaletteOpen((v) => !v);
          return;
        case "openSettings":
          setSettingsOpen(true);
          return;
        case "toggleSidebar":
          setSidebarCollapsed((v) => !v);
          return;
        case "toggleTerminal":
          setDock((d) => (d === "terminal" ? null : "terminal"));
          return;
        case "toggleChanges":
          setDock((d) => (d === "git" ? null : "git"));
          return;
        case "showMainWindow":
          tryCall("window:focus", {});
          return;
        case "newThread": {
          // Frozen newThreadLocation: "standalone" detaches the ordinary
          // new thread from the current project; "recent" (default)
          // follows the latest chat's location. The decision resolves
          // main-side (locationDefault) so a chord fired while a
          // settings event is in flight still reads the live value.
          void api()
            .invoke("threads:create", {
              projectId: sel?.projectId ?? null,
              locationDefault: true,
            })
            .then((t) =>
              api().invoke("threads:select", { id: (t as { id: string }).id }),
            )
            .catch((e) => store.reportError(String(e instanceof Error ? e.message : e)));
          return;
        }
        case "newWorktreeThread": {
          // Frozen: a thread in its own git worktree — create, select,
          // then bind a worktree through the real lifecycle (failures
          // surface honestly; the thread itself is never faked-bound).
          // applyWorkspaceDefault:false — the explicit call below owns the
          // worktree binding; a "worktree" default must not start a second.
          void api()
            .invoke("threads:create", {
              projectId: sel?.projectId ?? null,
              applyWorkspaceDefault: false,
            })
            .then((t) => {
              const tid = (t as { id: string }).id;
              return api()
                .invoke("threads:select", { id: tid })
                .then(() => api().invoke("threads:create-worktree", { threadId: tid }));
            })
            .then((r) => {
              const res = r as { kind?: string; reason?: string };
              if (res.kind === "unavailable")
                store.reportError(`worktree: ${res.reason ?? "unavailable"}`);
            })
            .catch((e) => store.reportError(String(e instanceof Error ? e.message : e)));
          return;
        }
        case "addProject":
          tryCall("projects:open-directory", {});
          return;
        case "stopTurn":
          if (sel) tryCall("turns:cancel", { threadId: sel.id });
          return;
        case "queueChat":
          // Composer parity: Ctrl/Cmd+Enter queues while a turn runs,
          // otherwise it sends.
          if (sel)
            if (sel.turn?.status === "running" || sel.turn?.status === "waiting-approval")
              void clientStore.queueDraft(sel.id);
            else void clientStore.sendDraft(sel.id);
          return;
        case "togglePlanMode":
          if (sel)
            tryCall("threads:set-interaction-mode", {
              threadId: sel.id,
              mode: (sel.interactionMode ?? "build") === "plan" ? "build" : "plan",
            });
          return;
        case "previousThread":
        case "nextThread": {
          if (!snap) return;
          const order = visibleThreads(snap.projects, snap.threads);
          const idx = order.findIndex((t) => t.id === snap.selectedThreadId);
          const next =
            idx === -1
              ? order[0]
              : order[(idx + (id === "nextThread" ? 1 : order.length - 1)) % order.length];
          if (next) tryCall("threads:select", { id: next.id });
          return;
        }
        case "runScript": {
          if (!snap || !sel?.projectId) return;
          const first = snap.projects.find((p) => p.id === sel.projectId)?.scripts?.[0];
          if (first) tryCall("scripts:run", { threadId: sel.id, scriptId: first.id });
          return;
        }
        case "archiveThreadDirect":
          if (sel) tryCall("threads:archive", { id: sel.id });
          return;
        case "archiveThread":
          if (sel) setArchivePrompt(true);
          return;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const chord = chordFromEvent(e, isDarwin);
      for (const id of SHORTCUT_COMMANDS) {
        const ch = effectiveChord(id, overrides, isDarwin);
        if (ch && sameChord(ch, chord)) {
          e.preventDefault();
          run(id);
          return;
        }
      }
      // A82 frozen AppCommands chords that never joined the remappable
      // registry: mod+1…9 opens the Nth thread in sidebar order, and
      // mod+=/+ step every font size up, mod+- down, mod+0 resets.
      const snap = store.view.snapshot;
      if (chord.mod && !chord.ctrl && !chord.alt) {
        const digit = /^Digit([1-9])$/.exec(chord.key);
        if (digit && !chord.shift && snap) {
          const order = visibleThreads(snap.projects, snap.threads);
          const th = order[Number(digit[1]) - 1];
          if (th) {
            e.preventDefault();
            tryCall("threads:select", { id: th.id });
            return;
          }
        }
        if (
          chord.key === "Equal" ||
          chord.key === "NumpadAdd" ||
          (!chord.shift && (chord.key === "Minus" || chord.key === "NumpadSubtract")) ||
          (!chord.shift && chord.key === "Digit0")
        ) {
          e.preventDefault();
          if (chord.key === "Digit0") {
            tryCall("settings:set", {
              fontSizes: {
                ui: TYPE_DEFAULT.ui,
                content: TYPE_DEFAULT.content,
                code: TYPE_DEFAULT.code,
              },
            });
            return;
          }
          const cur = resolveFontSizes(snap?.settings.fontSizes);
          const d = chord.key === "Minus" || chord.key === "NumpadSubtract" ? -1 : 1;
          tryCall("settings:set", {
            fontSizes: {
              ui: cur.ui + d,
              content: cur.content + d,
              code: cur.code + d,
            },
          });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot?.settings.shortcuts]);

  useEffect(() => {
    if (snapshot) {
      document.documentElement.lang = snapshot.settings.language === "zh-Hans" ? "zh-Hans" : "en";
    }
  }, [snapshot?.settings.language]);

  // F26: frozen AppTheme — resolve the palette onto :root; themes with no
  // fixed scheme (Breeze, System) follow the OS and re-resolve live.
  useEffect(() => {
    if (!snapshot) return;
    const theme = snapshot.settings.theme;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyTheme(document.documentElement, theme, mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [snapshot?.settings.theme]);

  // F26: frozen performanceMode — the flag lives on <html> so one CSS
  // block can strip every rendered effect the build actually has.
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.settings.performanceMode === true)
      document.documentElement.dataset.performance = "1";
    else delete document.documentElement.dataset.performance;
  }, [snapshot?.settings.performanceMode]);

  // F26: push the frozen TypeScale offsets into the three CSS vars; the
  // code offset also reaches live xterm instances (terminals scale with
  // the code category like the frozen diff/code views).
  useEffect(() => {
    if (!snapshot) return;
    const off = fontSizeOffsets(snapshot.settings.fontSizes);
    const root = document.documentElement;
    root.style.setProperty("--fs-ui-off", `${off.ui}px`);
    root.style.setProperty("--fs-content-off", `${off.content}px`);
    root.style.setProperty("--fs-code-off", `${off.code}px`);
    setCodeFontOffset(off.code);
  }, [snapshot?.settings.fontSizes]);

  // F26 wallpaper layer: refetch the picture whenever the installed
  // basename changes. Performance Mode keeps the setting but the frozen
  // solid fallback means nothing is painted (see .has-wp below).
  useEffect(() => {
    const file = snapshot?.settings.wallpaper?.file;
    if (!file) {
      setWpUrl(null);
      return;
    }
    let live = true;
    void api()
      .invoke("wallpaper:data", { file })
      .then((r) => {
        if (live) setWpUrl((r as { dataUrl: string } | null)?.dataUrl ?? null);
      })
      .catch(() => {
        if (live) setWpUrl(null);
      });
    return () => {
      live = false;
    };
  }, [snapshot?.settings.wallpaper?.file]);

  // Delegate markdown link clicks to the http/https-only external opener.
  // In-page navigation itself is denied by the main-process lockdown.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      // Code-block copy — writes the plain code text to the OS clipboard.
      const btn = el.closest("button[data-md-copy]");
      if (btn) {
        e.preventDefault();
        const code = btn.closest(".md-preblock")?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard.writeText(code);
        const copied = btn.getAttribute("data-label-copied") ?? "Copied";
        const back = btn.getAttribute("data-label-copy") ?? "Copy";
        btn.textContent = copied;
        window.setTimeout(() => {
          btn.textContent = back;
        }, 1200);
        return;
      }
      const a = el.closest("a[data-md-link]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) tryCall("links:open-external", { url: href });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // F04: right-click on a chat link opens the frozen LinkPopover under
  // the link's own bounds (Open Link / Copy Link). A re-open on another
  // link just moves the menu there.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[data-md-link]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (!href) return;
      const rect = a.getBoundingClientRect();
      // F25: the timeline the link sits in is the merge target's chat —
      // a helper panel's links spawn helpers OF THE HELPER (frozen
      // MergeRequestTarget per chat view).
      const host = a.closest("[data-chat-id]");
      const chatId = host?.getAttribute("data-chat-id") ?? undefined;
      setLinkPop({ href, x: rect.left, y: rect.bottom + 4, chatId });
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);

  if (fatal) {
    return (
      <div className="center-state">
        <p role="alert">Failed to load: {fatal}</p>
      </div>
    );
  }
  if (!ready || !snapshot) {
    return (
      <div className="center-state" role="status">
        <p className="dots">Loading</p>
      </div>
    );
  }

  const selected = snapshot.threads.find((t) => t.id === snapshot.selectedThreadId) ?? null;
  // F25: the selected chat's helper, while its panel is open (frozen
  // SubagentPanel — closed helpers drop to the sidebar instead).
  const helper = selected
    ? (snapshot.threads.find(
        (t) => t.parentThreadId === selected.id && t.isInPanel && !t.isArchived,
      ) ?? null)
    : null;

  // F26: the frozen window paints the picture at backdropOpacity under
  // glass on a TRANSPARENT window. Ours is opaque — honest mapping: the
  // picture fills the app at that opacity over the solid base, softness
  // becomes a CSS blur, and Performance Mode falls back to solid.
  const wp = snapshot.settings.wallpaper;
  const wpOn =
    !!wp && !!wpUrl && snapshot.settings.performanceMode !== true;

  // A81 frozen SidebarLayout: default 268, bounds 210–440, drag past
  // 110 collapses (session-only, like ⌘B); a collapsed edge drags back
  // open from 0. The persisted setting only changes on release.
  const sidebarResting = snapshot.settings.sidebarWidth ?? 268;
  const sidebarLive = edgeDrag ?? (sidebarCollapsed ? 0 : sidebarResting);
  const beginEdgeDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const anchor = sidebarCollapsed ? 0 : sidebarResting;
    const x0 = e.clientX;
    let last = anchor;
    const move = (ev: MouseEvent) => {
      last = Math.min(440, Math.max(0, anchor + (ev.clientX - x0)));
      setEdgeDrag(last);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setEdgeDrag(null);
      if (last < 110) {
        setSidebarCollapsed(true);
      } else {
        const settled = Math.max(210, last);
        setSidebarCollapsed(false);
        tryCall("settings:set", { sidebarWidth: settled });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  return (
    <LanguageContext.Provider value={snapshot.settings.language}>
      <div
        className={`app${wpOn ? " has-wp" : ""}`}
        style={{ "--sidebar-w": `${sidebarLive}px` } as React.CSSProperties}
      >
        {wpOn && (
          <div
            className="wp-backdrop"
            style={{
              backgroundImage: `url(${wpUrl})`,
              opacity: wallpaperOpacity(snapshot.settings.backdropOpacity),
              filter: `blur(${wallpaperBlurPx(wp?.softness ?? 0)}px)`,
            }}
          />
        )}
        {sidebarLive > 0 && (
          <Sidebar
            snapshot={snapshot}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
          />
        )}
        <SidebarEdge live={sidebarLive} onBegin={beginEdgeDrag} />
        <div className="chat-stack">
          <div
            className="chat-row"
            style={
              helperDock?.side === "left"
                ? { paddingLeft: `${helperDock.px}px` }
                : helperDock
                  ? { paddingRight: `${helperDock.px}px` }
                  : undefined
            }
          >
          <ChatView
            thread={selected}
            threads={snapshot.threads}
            project={
              selected?.projectId
                ? (snapshot.projects.find((p) => p.id === selected.projectId) ?? null)
                : null
            }
            directory={
              selected?.projectId
                ? (snapshot.projects.find(
                    (p) => p.id === selected.projectId && p.directoryStatus === "available",
                  )?.directory ?? null)
                : null
            }
            providerLabel={snapshot.info.providerLabel}
            mode={snapshot.info.mode}
            {...(snapshot.info.codex ? { codex: snapshot.info.codex } : {})}
            readOnly={!!snapshot.readOnly}
            projects={snapshot.projects}
            dock={dock}
            onToggleDock={(name) => setDock((cur) => (cur === name ? null : name))}
            {...(selected && store.limitResumes[selected.id]
              ? { limitResumeAt: store.limitResumes[selected.id] }
              : {})}
            settings={snapshot.settings}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          </div>
          {helper && (
            <HelperPanel
              thread={helper}
              parentTitle={selected?.title ?? ""}
              readOnly={!!snapshot.readOnly}
              size={snapshot.settings.helperPanelSize}
              onDock={setHelperDock}
              onClose={() => tryCall("threads:close-helper", { id: helper.id })}
            />
          )}
          {dock === "terminal" && selected && (
            <TerminalPanel
              thread={selected}
              readOnly={!!snapshot.readOnly}
              height={snapshot.settings.terminalHeight ?? 260}
              onHide={() => setDock(null)}
            />
          )}
          {dock === "git" && selected && (
            <GitPanel key={selected.id} thread={selected} readOnly={!!snapshot.readOnly} />
          )}
        </div>
        {settingsOpen && (
          <SettingsModal
            settings={snapshot.settings}
            info={snapshot.info}
            threads={snapshot.threads}
            projects={snapshot.projects}
            tokenActivity={snapshot.tokenActivity}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            snapshot={snapshot}
            selectedThreadId={snapshot.selectedThreadId}
            onClose={() => setPaletteOpen(false)}
            onToggleDock={(name) => setDock((cur) => (cur === name ? null : name))}
            onOpenSettings={() => {
              setPaletteOpen(false);
              setSettingsOpen(true);
            }}
          />
        )}
        {linkPop && (
          <LinkPopover state={linkPop} onClose={() => setLinkPop(null)} />
        )}
        {archivePrompt && selected && (
          <ArchivePrompt
            title={selected.title}
            onArchive={() => {
              setArchivePrompt(false);
              tryCall("threads:archive", { id: selected.id });
            }}
            onDelete={() => {
              setArchivePrompt(false);
              tryCall("threads:delete", { id: selected.id });
            }}
            onClose={() => setArchivePrompt(false)}
          />
        )}
        {lastError && <ErrorBanner text={lastError} onDismiss={() => store.clearError()} />}
      </div>
    </LanguageContext.Provider>
  );
}
