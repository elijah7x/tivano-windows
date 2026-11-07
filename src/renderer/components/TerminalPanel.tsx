// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Embedded terminal panel: explicit create/select/close/restart for the
// selected thread's sessions. Nothing ever auto-spawns — the panel opens
// empty and a shell starts only from the New-terminal button. xterm
// instances live in terminalRegistry (not React state), so thread switches
// and panel toggles preserve screen state and keep output draining.

import { useEffect, useReducer, useRef, useState } from "react";
import type { ChatThread, TerminalInfo } from "../../shared/types";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { callApi } from "../client";
import {
  allEntries,
  ensureEntry,
  ensureTerminalBridge,
  entryOf,
  parkHolder,
  setThreadTerminals,
  subscribeTerminals,
  terminalReasonLabel,
  terminalsOf,
  terminalRevision,
} from "../terminalRegistry";

const stateDot = (s: TerminalInfo): string => s.state;

export function TerminalPanel(props: {
  thread: ChatThread;
  readOnly: boolean;
  /** Persisted drawer height (frozen terminalHeight, default 260). */
  height: number;
  onHide: () => void;
}): React.JSX.Element {
  const t = useT();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  // A81: top-edge resize (frozen TerminalResizeHandle) — live while held,
  // clamped 140–760 and persisted only on release.
  const [dragH, setDragH] = useState<number | null>(null);
  const panelH = dragH ?? props.height;
  const beginResize = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY;
    const anchor = props.height;
    let last = anchor;
    const move = (ev: MouseEvent) => {
      last = Math.min(760, Math.max(140, anchor + (y0 - ev.clientY)));
      setDragH(last);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setDragH(null);
      if (last !== anchor) {
        void callApi("settings:set", { terminalHeight: last });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const poolRef = useRef<HTMLDivElement | null>(null);

  // Bridge + list hydration once per thread; entries are created eagerly so
  // hidden terminals keep draining (StrictMode-safe: every step idempotent).
  useEffect(() => {
    setNotice(null);
    ensureTerminalBridge();
    let active = true;
    const off = subscribeTerminals(bump);
    const revision = terminalRevision();
    callApi("terminals:list", { threadId: props.thread.id })
      .then((list) => {
        if (!active) return;
        const infos = list as TerminalInfo[];
        if (!setThreadTerminals(props.thread.id, infos, revision)) return;
        for (const info of infos) ensureEntry(info);
        bump();
      })
      .catch(() => {});
    return () => { active = false; off(); };
  }, [props.thread.id]);

  const sessions = terminalsOf(props.thread.id);
  const sel = sessions.find((s) => s.id === selectedId) ?? sessions.at(-1) ?? null;

  // Park the selected holder in the visible slot, everything else in the
  // hidden pool; refit on selection/incarnation/size changes.
  useEffect(() => {
    const slot = slotRef.current;
    const pool = poolRef.current;
    if (!slot || !pool) return;
    for (const s of sessions) ensureEntry(s);
    // Park EVERY live entry — including other threads' — or a holder left
    // in the visible slot from a previous thread would keep rendering.
    for (const e of allEntries()) {
      parkHolder(e, e.info.id === sel?.id ? slot : pool);
    }
    if (!sel) return;
    const e = entryOf(sel.id);
    if (!e) return;
    let raf = 0;
    const doFit = (): void => {
      try {
        e.fit.fit();
      } catch {
        /* zero-size during transitions — the observer retries */
      }
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(slot);
    raf = requestAnimationFrame(doFit);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [sel?.id, sel?.incarnation, sessions.length]);

  // Focus follows the visible terminal — keystrokes never leak to chat.
  useEffect(() => {
    if (!sel || sel.state !== "running") return;
    const e = entryOf(sel.id);
    e?.term.focus();
  }, [sel?.id, sel?.incarnation, sel?.state]);

  const create = (): void => {
    setNotice(null);
    void callApi("terminals:create", { threadId: props.thread.id, cols: 120, rows: 30 })
      .then((r) => {
        const res = r as { terminal?: TerminalInfo; unavailable?: string };
        if (res.unavailable) setNotice(res.unavailable);
        else if (res.terminal) setSelectedId(res.terminal.id);
      })
      .catch(() => {});
  };

  const restart = (): void => {
    if (!sel) return;
    void callApi("terminals:restart", { terminalId: sel.id }).catch(() => {});
  };

  const close = (): void => {
    if (!sel) return;
    void callApi("terminals:close", { terminalId: sel.id }).catch(() => {});
  };

  const stateLine = (s: TerminalInfo): string | null => {
    switch (s.state) {
      case "starting":
        return t("Starting…");
      case "exited":
        return s.exitCode !== undefined
          ? `${t("Exited")} (${s.exitCode})`
          : t("Exited");
      case "error":
        return `${t("Terminal error")}: ${
          s.reason ? terminalReasonLabel(t, translateError, s.reason) : t("Unknown")
        }`;
      case "closing":
        return t("Closing…");
      default:
        return null;
    }
  };

  return (
    <section
      className="term-panel"
      aria-label={t("Terminal")}
      style={{ height: `${panelH}px` }}
    >
      <div
        className="term-resize"
        onMouseDown={beginResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("Resize terminal")}
      />
      <header className="term-head">
        <div className="term-tabs" role="tablist" aria-label={t("Terminal sessions")}>
          {sessions.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === sel?.id}
              className={`term-tab ${s.id === sel?.id ? "selected" : ""} ${stateDot(s)}`}
              title={s.cwd}
              onClick={() => setSelectedId(s.id)}
            >
              {s.title.replace(/^Terminal /, `${t("Terminal")} `)}
              {s.state !== "running" && s.state !== "starting" && (
                <span className="term-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
        <div className="term-actions">
          <button
            className="term-btn"
            onClick={create}
            disabled={props.readOnly}
            title={t("Open a new terminal in the project directory")}
          >
            + {t("New terminal")}
          </button>
          <button
            className="term-btn"
            onClick={restart}
            disabled={!sel || props.readOnly || sel.state === "closing"}
            title={t("Restart this terminal")}
          >
            {t("Restart")}
          </button>
          <button
            className="term-btn"
            onClick={close}
            disabled={!sel}
            title={t("Close this terminal")}
          >
            {t("Close")}
          </button>
          <button
            className="icon-btn"
            onClick={props.onHide}
            aria-label={t("Hide terminal panel")}
            title={t("Hide terminal panel")}
          >
            ×
          </button>
        </div>
      </header>
      {notice && (
        <div className="banner" role="status">
          {terminalReasonLabel(t, translateError, notice)}
        </div>
      )}
      {sel?.cwd && (
        <div className="term-cwd" title={sel.cwd}>
          {sel.cwd}
        </div>
      )}
      <div className="term-body">
        <div ref={slotRef} className="term-slot" />
        {sel && sel.state !== "running" && (
          <div className="term-overlay" role="status">
            <p>{stateLine(sel)}</p>
            {(sel.state === "exited" || sel.state === "error") && (
              <button className="term-btn" onClick={restart} disabled={props.readOnly}>
                {t("Restart")}
              </button>
            )}
          </div>
        )}
        {!sel && (
          <div className="term-empty center-state">
            <p>{t("No terminal open — open one to work in this project's directory")}</p>
            <button className="term-btn" onClick={create} disabled={props.readOnly}>
              + {t("New terminal")}
            </button>
          </div>
        )}
        <div ref={poolRef} className="term-pool" aria-hidden="true" />
      </div>
    </section>
  );
}
