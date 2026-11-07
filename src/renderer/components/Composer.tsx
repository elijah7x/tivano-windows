// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Composer: multiline input, Enter sends / Shift+Enter newline. While a
// turn runs (F08 frozen parity): Enter stops the turn and sends the
// moment the stop lands; Ctrl/Cmd+Enter or Queue steers behind it. The
// draft lives in the client store keyed by thread id — switching
// threads, remounts and failed sends never lose text.

import { useEffect, useRef, useState } from "react";
import type { ChatThread, DownloadItem } from "../../shared/types";
import {
  builtinSlashCommands,
  slashQueryAt,
  slashSuggestions,
  type SlashCommand,
} from "../../shared/slashCommands";
import { mentionQueryAt } from "../../shared/fileMention";
import { quoteExcerpt } from "../../shared/replyQuote";
import { useT } from "../locale";
import { api, clientStore, tryCall } from "../client";
import { chordLabel, effectiveChord } from "../../shared/shortcuts";
import { AttachChip } from "./AttachChip";
import { ModelPicker } from "./ModelPicker";
import { RuntimeModePicker } from "./RuntimeModePicker";
import { FollowUpQueue } from "./FollowUpQueue";

/** F05: compact byte size for download rows — 1.2 MB / 340 KB / 512 B. */
function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** F19: compact token count — 12.8k under 1M, 1.2M above. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** F19 context ring — the last provider-reported context-window reading.
 *  Click opens a small popover with the raw numbers. Absent entirely
 *  until a provider reports (no fabricated ring). */
function ContextMeter({ thread }: { thread: ChatThread }): React.JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useState(false);
  const usage = thread.contextUsage;
  if (!usage) return null;
  const fraction =
    usage.windowTokens && usage.windowTokens > 0
      ? Math.min(Math.max(usage.usedTokens / usage.windowTokens, 0), 1)
      : null;
  const pct = fraction === null ? null : Math.round(fraction * 100);
  const R = 6;
  const CIRC = 2 * Math.PI * R;
  return (
    <span className="ctx-meter">
      <button
        className={`ctx-ring${pct !== null && pct > 85 ? " warn" : ""}`}
        title={
          pct !== null
            ? t("%@ of the context window used", `${pct}%`)
            : t("Context window")
        }
        aria-label={t("Context window")}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r={R} fill="none" className="ctx-track" />
          {fraction !== null && (
            <circle
              cx="8.5"
              cy="8.5"
              r={R}
              fill="none"
              className="ctx-fill"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - fraction)}
              transform="rotate(-90 8.5 8.5)"
            />
          )}
        </svg>
      </button>
      {open && (
        <div className="ctx-pop" role="dialog" aria-label={t("Usage")}>
          <div className="ctx-pop-head">{t("Usage")}</div>
          <div className="ctx-pop-row">
            {usage.windowTokens
              ? t("%@ / %@ tokens", fmtTokens(usage.usedTokens), fmtTokens(usage.windowTokens))
              : t("%@ tokens used", fmtTokens(usage.usedTokens))}
          </div>
          {pct !== null && (
            <div className="ctx-pop-row dim">
              {t("%@ of the context window used", `${pct}%`)}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

export function Composer(props: {
  thread: ChatThread;
  mode?: "mock" | "synthetic-stdio" | "codex";
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useT();
  const { thread } = props;
  const running =
    thread.turn?.status === "running" ||
    thread.turn?.status === "waiting-approval";
  const text = clientStore.draft(thread.id);
  const command = clientStore.draftCommand(thread.id);
  const attachments = clientStore.draftAttachments(thread.id);
  const quotes = clientStore.draftQuotes(thread.id);
  // F09: non-undefined while "Edit from here" has armed the composer —
  // the next sendDraft reroutes to threads:resend and rewinds first.
  const editTarget = clientStore.editTarget(thread.id);
  const pending = clientStore.isPending(thread.id);
  const readOnly = !!props.readOnly;
  const [attachNote, setAttachNote] = useState<string | null>(null);

  const attachNoteFor = (dropped: number) =>
    setAttachNote(
      dropped === 0
        ? null
        : dropped === 1
          ? t("One file was left out: a message holds %d attachments", "8")
          : t("%d files were left out: a message holds %d attachments", String(dropped), "8"),
    );

  const attach = async () => {
    const r = await clientStore.attachFiles(thread.id);
    if (r.canceled) return;
    // Frozen attach(): the over-cap leftovers land as an inline notice.
    attachNoteFor(r.dropped);
  };

  // F05 downloads popover — frozen DownloadsPopover: the attach button
  // lists the newest downloads first (settings.recentDownloadsPicker,
  // default on); "Choose Files…" reaches the ordinary dialog.
  const dlPicker =
    clientStore.snapshot?.settings.recentDownloadsPicker !== false;
  const [dlOpen, setDlOpen] = useState(false);
  const [dlItems, setDlItems] = useState<DownloadItem[] | null>(null);
  const toggleDownloads = async () => {
    if (dlOpen) {
      setDlOpen(false);
      return;
    }
    setDlOpen(true);
    setDlItems(null);
    try {
      const items = (await api().invoke("downloads:list", {})) as DownloadItem[];
      setDlItems(items);
    } catch {
      setDlItems([]);
    }
  };
  const pickDownload = async (id: string) => {
    setDlOpen(false);
    const r = await clientStore.attachDownloads(thread.id, [id]);
    attachNoteFor(r.dropped);
  };

  // F05 paste/drop — frozen ComposerTextView.paste: file URLs and
  // textless image data attach instead of inserting text. The renderer
  // ships the bytes it already holds; a path never crosses the bridge.
  const attachFileList = async (list: FileList | File[]) => {
    const files: { name: string; data: Uint8Array }[] = [];
    for (const f of Array.from(list).slice(0, 32)) {
      try {
        const data = new Uint8Array(await f.arrayBuffer());
        const ext = f.type.startsWith("image/") ? f.type.slice(6).split(";")[0] : "";
        const name = f.name || (ext ? `pasted-image.${ext}` : `pasted-file-${files.length + 1}`);
        files.push({ name, data });
      } catch {
        // Unreadable files are skipped, like unreadable dialog picks.
      }
    }
    if (!files.length) return;
    const r = await clientStore.attachBlobs(thread.id, files);
    attachNoteFor(r.dropped);
  };

  // F05 slash + @-mention suggestions — frozen
  // ComposerView.SuggestionState: the whitespace-bounded word under the
  // caret opens the draft with "/" or begins with "@". Escape hides the
  // menu until the text changes.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [selIdx, setSelIdx] = useState(0);
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  const slash = readOnly ? null : slashQueryAt(text, caret);
  const mention = readOnly || slash ? null : mentionQueryAt(text, caret);
  const mode = props.mode ?? clientStore.snapshot?.info.mode ?? "mock";
  const recent = clientStore.snapshot?.recentCommands?.[mode] ?? [];
  const slashItems =
    slash && dismissedText !== text
      ? slashSuggestions(
          builtinSlashCommands(clientStore.snapshot?.info.supportsCompact === true),
          slash.query,
          recent,
        )
      : [];

  // @-mention results come from main's file index — the request is
  // re-issued per keystroke and a stale answer (caret moved on, like the
  // frozen Task.isCancelled drop) is discarded instead of applied.
  const [fileItems, setFileItems] = useState<string[]>([]);
  useEffect(() => {
    if (!mention || dismissedText === text) {
      setFileItems([]);
      return;
    }
    let live = true;
    const q = mention.query;
    void api()
      .invoke("mention:search", { threadId: thread.id, query: q })
      .then((r) => {
        if (live) setFileItems((r as { paths: string[] }).paths);
      })
      .catch(() => {
        if (live) setFileItems([]);
      });
    return () => {
      live = false;
    };
  }, [mention?.start, mention?.query, dismissedText, text, thread.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileRows =
    mention && dismissedText !== text ? fileItems : [];
  const items = slashItems;
  const suggestOpen = items.length > 0 || fileRows.length > 0;
  const sel = Math.min(selIdx, Math.max(0, (items.length || fileRows.length) - 1));

  const pick = (c: SlashCommand) => {
    clientStore.setDraftCommand(thread.id, {
      name: c.name,
      detail: c.detail,
      isBuiltIn: c.isBuiltIn,
    });
    setSelIdx(0);
    setCaret(0);
    taRef.current?.focus();
  };
  const pickFile = (path: string) => {
    if (!mention) return;
    // Frozen pick(): replace the typed "@query" word with "@path ".
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`;
    clientStore.setDraft(thread.id, next);
    setSelIdx(0);
    const pos = mention.start + path.length + 2;
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };
  const providerName =
    props.mode === "synthetic-stdio"
      ? t("Synthetic stdio")
      : props.mode === "codex"
        ? t("Codex")
        : t("Mock Provider");

  const send = () => {
    if (readOnly) return;
    // F09: an armed edit always takes the resend path — queueing an
    // edited message behind the running turn would silently skip the
    // rewind; the engine refuses resend while busy with a clear error.
    if (running && !editTarget) void clientStore.interruptSendDraft(thread.id);
    else void clientStore.sendDraft(thread.id);
  };
  const queue = () => {
    if (readOnly) return;
    void clientStore.queueDraft(thread.id);
  };

  // The queue hint reflects the effective queueChat binding — it tracks
  // remaps and disappears when the command is cleared.
  const isDarwin = api().platform === "darwin";
  const queueChord = effectiveChord(
    "queueChat",
    clientStore.snapshot?.settings.shortcuts,
    isDarwin,
  );
  const queueTitle = queueChord
    ? t("Queue behind the running turn (%@)", chordLabel(queueChord, isDarwin))
    : t("Queue behind the running turn");

  return (
    <div
      className="composer"
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (readOnly) return;
        const fl = e.dataTransfer?.files;
        if (fl && fl.length > 0) {
          e.preventDefault();
          void attachFileList(fl);
        }
      }}
    >
      <div className="composer-modes">
        <RuntimeModePicker thread={thread} readOnly={readOnly} />
        <div className="imode-toggle" role="group" aria-label={t("Interaction mode")}>
          {(["build", "plan"] as const).map((m) => (
            <button
              key={m}
              className={`imode${(thread.interactionMode ?? "build") === m ? " on" : ""}`}
              aria-pressed={(thread.interactionMode ?? "build") === m}
              disabled={readOnly}
              onClick={() =>
                tryCall("threads:set-interaction-mode", { threadId: thread.id, mode: m })
              }
            >
              {m === "build" ? t("Build") : t("Plan")}
            </button>
          ))}
        </div>
        {props.mode === "codex" && <ModelPicker thread={thread} readOnly={readOnly} />}
        <span className="composer-modes-end">
          <ContextMeter thread={thread} />
        </span>
      </div>
      {editTarget && (
        <div className="edit-banner" role="status">
          <span className="edit-banner-text">
            {t("Editing an earlier message — sending rewinds the chat to before it; file changes are kept.")}
          </span>
          <button
            className="edit-banner-x"
            aria-label={t("Cancel edit")}
            title={t("Cancel edit")}
            onClick={() => clientStore.clearEditTarget(thread.id)}
          >
            ×
          </button>
        </div>
      )}
      <FollowUpQueue thread={thread} readOnly={readOnly} />
      {(command || attachments.length > 0 || quotes.length > 0) && (
        <div className="composer-chips">
          {command && (
            <span className="cmd-chip" title={t(command.detail)}>
              <span className="cmd-chip-name">/{command.name}</span>
              <button
                className="cmd-chip-x"
                aria-label={t("Remove command")}
                disabled={readOnly}
                onClick={() => clientStore.setDraftCommand(thread.id, undefined)}
              >
                ×
              </button>
            </span>
          )}
          {quotes.map((q) => (
            <span className="quote-chip" key={q.id} title={q.text}>
              <span className="quote-chip-text">{quoteExcerpt(q.text)}</span>
              <button
                className="quote-chip-x"
                aria-label={t("Remove quote")}
                disabled={readOnly}
                onClick={() => clientStore.removeDraftQuote(thread.id, q.id)}
              >
                ×
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <AttachChip
              key={a.id}
              threadId={thread.id}
              id={a.id}
              name={a.name}
              size={a.size}
              readOnly={readOnly}
              onRemove={() => void clientStore.removeDraftAttachment(thread.id, a.id)}
            />
          ))}
        </div>
      )}
      {attachNote && <div className="composer-note">{attachNote}</div>}
      {suggestOpen && (
        <div
          className="suggest-menu"
          role="listbox"
          aria-label={
            items.length > 0
              ? t("Commands · Recently used first")
              : t("Files")
          }
        >
          {items.length > 0 ? (
            <>
              <div className="suggest-head">{t("Commands · Recently used first")}</div>
              {items.map((c, i) => (
                <button
                  key={c.name}
                  role="option"
                  aria-selected={i === sel}
                  className={`suggest-row${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSelIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c);
                  }}
                >
                  <span className="suggest-name">/{c.name}</span>
                  <span className="suggest-detail">{t(c.detail)}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="suggest-head">{t("Files")}</div>
              {fileRows.map((p, i) => (
                <button
                  key={p}
                  role="option"
                  aria-selected={i === sel}
                  className={`suggest-row${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSelIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickFile(p);
                  }}
                >
                  <span className="suggest-name">
                    {p.slice(p.lastIndexOf("/") + 1)}
                  </span>
                  <span className="suggest-detail">{p}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <textarea
        ref={taRef}
        aria-label={t("Message")}
        placeholder={
          readOnly
            ? t("read-only: close failed earlier — no new work is accepted")
            : thread.interactionMode === "plan"
              ? t("Describe what you want to plan")
              : t("Ask %@ to build, fix or explain.", providerName)
        }
        value={text}
        rows={2}
        disabled={readOnly}
        onChange={(e) => {
          clientStore.setDraft(thread.id, e.target.value);
          setCaret(e.target.selectionStart);
          if (dismissedText !== null && e.target.value !== dismissedText)
            setDismissedText(null);
          setSelIdx(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onPaste={(e) => {
          if (readOnly) return;
          const fl = e.clipboardData?.files;
          if (fl && fl.length > 0) {
            e.preventDefault();
            void attachFileList(fl);
          }
          // No files → the default text paste proceeds untouched.
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (suggestOpen) {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelIdx((i) => Math.max(0, i - 1));
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const rows = items.length || fileRows.length;
              setSelIdx((i) => Math.min(rows - 1, i + 1));
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissedText(text);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const item = items.length > 0 ? items[sel] : fileRows[sel];
              if (item === undefined) return;
              if (items.length > 0) pick(item as SlashCommand);
              else pickFile(item as string);
              return;
            }
          }
          if (e.key === "Backspace" && text === "" && command) {
            e.preventDefault();
            clientStore.setDraftCommand(thread.id, undefined);
            return;
          }
          // Frozen backspace order: the command chip goes first, then
          // the last reply quote peels off the next empty backspace.
          if (e.key === "Backspace" && text === "" && !command && quotes.length > 0) {
            e.preventDefault();
            clientStore.removeDraftQuote(thread.id, quotes[quotes.length - 1]!.id);
            return;
          }
          // After the command and quotes are gone the last attachment
          // chip peels off on the next empty backspace.
          if (e.key === "Backspace" && text === "" && !command && attachments.length > 0) {
            e.preventDefault();
            const last = attachments[attachments.length - 1];
            if (last) void clientStore.removeDraftAttachment(thread.id, last.id);
            return;
          }
          if (e.key !== "Enter") return;
          if (e.shiftKey) return; // newline
          // ⌘↵/Ctrl+↵ is the queueChat command — the app-level shortcut
          // dispatcher owns it (queues while running, sends while idle).
          if (e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          send();
        }}
      />
      {dlPicker ? (
        <span className="dl-anchor">
          <button
            className={`attach-btn${dlOpen ? " on" : ""}`}
            title={t("Attach files")}
            aria-label={t("Attach files")}
            aria-expanded={dlOpen}
            disabled={readOnly}
            onClick={() => void toggleDownloads()}
          >
            📎
          </button>
          {dlOpen && (
            <div
              className="suggest-menu dl-menu"
              role="menu"
              aria-label={t("Recent downloads")}
            >
              <div className="suggest-head">{t("Recent downloads")}</div>
              {dlItems === null ? (
                <div className="dl-loading" aria-label={t("Loading")}>…</div>
              ) : dlItems.length === 0 ? (
                <div className="dl-empty">
                  {t("No downloads yet. Anything you download appears here.")}
                </div>
              ) : (
                dlItems.map((d) => (
                  <button
                    key={d.id}
                    role="menuitem"
                    className="suggest-row dl-row"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void pickDownload(d.id);
                    }}
                  >
                    <span className="dl-icon" aria-hidden="true">
                      {d.isImage ? "🖼" : "📄"}
                    </span>
                    <span className="suggest-name">{d.name}</span>
                    <span className="suggest-detail dl-size">
                      {d.size > 0 ? fmtSize(d.size) : ""}
                    </span>
                  </button>
                ))
              )}
              <div className="dl-sep" />
              <button
                role="menuitem"
                className="suggest-row dl-row"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDlOpen(false);
                  void api().invoke("downloads:reveal", {});
                }}
              >
                <span className="dl-icon" aria-hidden="true">📂</span>
                <span className="suggest-name">
                  {t(isDarwin ? "Show in Finder" : "Show in File Explorer")}
                </span>
              </button>
              <button
                role="menuitem"
                className="suggest-row dl-row"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDlOpen(false);
                  void attach();
                }}
              >
                <span className="dl-icon" aria-hidden="true">📄</span>
                <span className="suggest-name">{t("Choose Files…")}</span>
              </button>
            </div>
          )}
        </span>
      ) : (
        <button
          className="attach-btn"
          title={t("Attach files")}
          aria-label={t("Attach files")}
          disabled={readOnly}
          onClick={() => void attach()}
        >
          📎
        </button>
      )}
      {running ? (
        <>
          <button
            className="queue-btn"
            title={queueTitle}
            // Queued entries are text-only — an attachment-only draft
            // cannot queue (Send consumes the chips directly).
            disabled={readOnly || (!text.trim() && !command) || pending}
            onClick={queue}
          >
            {t("Queue")}
          </button>
          <button onClick={() => tryCall("turns:cancel", { threadId: thread.id })}>
            {t("Stop")}
          </button>
        </>
      ) : (
        <button
          className="primary"
          onClick={send}
          disabled={readOnly || (!text.trim() && !command && !attachments.length) || pending}
        >
          {t("Send")}
        </button>
      )}
      {/* F22/F26 frozen ComposerWorkingDots — accent dots wave along the
          pill's bottom while a turn runs; performanceMode and reduced
          motion take it out in CSS. */}
      {running && <div className="work-dots" aria-hidden="true" />}
    </div>
  );
}
