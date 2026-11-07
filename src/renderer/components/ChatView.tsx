// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Chat area: header with the labelled mock badge, message timeline with
// streaming/approval/error/interruption states, and the composer.

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread, CheckpointRecordView, CodexInfo, Message, Project, Settings, Turn } from "../../shared/types";
import { INTERRUPTED_MARKER } from "../../shared/types";
import { AttachChip } from "./AttachChip";
import { ToolMsgRow, WorkingIndicator } from "./WorkingIndicator";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { renderMarkdown } from "../markdown";
import { api, callApi, clientStore } from "../client";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { CheckpointPreviewDialog } from "./CheckpointPreviewDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { BranchMenu } from "./BranchMenu";
import { HydraMark } from "./HydraMark";
import { HydraPanel } from "./HydraPanel";
import { OpenInMenu } from "./OpenInMenu";
import { ScriptsDialog } from "./ScriptsDialog";
import { Composer } from "./Composer";
import { TimelineMinimap } from "./TimelineMinimap";
import { ThreadChangesTab } from "./ThreadChangesTab";
import { HydraBriefPill } from "./HydraBriefPill";
import { HydraStaveBar } from "./HydraStaveBar";
import { WorkingSpinner } from "./SpinnerCells";
import { HydraDelegationCard } from "./HydraDelegationCard";
import { HydraReportRow } from "./HydraReportRow";
import { MessagePopover } from "./MessagePopover";
import { NewThreadPrompt } from "./NewThreadPrompt";
import type { MessagePopoverState } from "./MessagePopover";
import { peelQuotes, quoteExcerpt } from "../../shared/replyQuote";
import {
  groupMessages,
  partitionGroup,
  formatDuration,
  type TimelineItem,
  type TurnGroup,
} from "../messageGroups";

/** F04 content ops: per-message copy of the raw markdown source. */
/** F20: the row a limit-waiting thread shows — honest countdown target,
 *  cancel, and hand-off to a new chat (frozen AutoContinue controls). */
function LimitWaitRow({ threadId, resumeAt }: { threadId: string; resumeAt: number }): React.JSX.Element {
  const t = useT();
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((resumeAt - Date.now()) / 1000));
  const when = new Date(resumeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="limit-wait" role="status">
      <span className="limit-wait-text">
        {t("Usage limit reached — continuing at")} {when}
        {seconds > 0 ? ` (${seconds}s)` : ""}
      </span>
      <button
        type="button"
        onClick={() => {
          void callApi("limit:cancel", { threadId }).catch(() => {});
        }}
      >
        {t("Cancel wait")}
      </button>
      <button
        type="button"
        onClick={() => {
          void callApi("limit:handoff", { threadId })
            .then((r) => {
              const made = r as { threadId: string; text: string };
              clientStore.setDraft(made.threadId, made.text);
              return callApi("threads:select", { id: made.threadId });
            })
            .catch(() => {});
        }}
      >
        {t("Hand off to a new chat")}
      </button>
    </div>
  );
}

function MsgCopyButton({ text }: { text: string }): React.JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`msg-copy${copied ? " done" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? t("Copied") : t("Copy")}
    </button>
  );
}

function statusLabel(t: (k: string) => string, m: Message): string | null {
  switch (m.status) {
    case "interrupted":
      return t("Interrupted");
    case "cancelled":
      return t("Turn cancelled");
    case "denied":
      return t("Turn denied");
    case "error":
      return t("Turn failed");
    default:
      return null;
  }
}

/** F22: the delegation card rendered in place of a fenced hydra block
 *  (frozen HydraDelegationBlock) — injected so markdown stays pure. */
const delegationCard = (body: string, sent: boolean): React.ReactNode =>
  createElement(HydraDelegationCard, { body, sent });

export function ChatView(props: {
  thread: ChatThread | null;
  /** F22: every thread — the Hydra panel resolves a lead's heads and a
   *  head's lead from it (heads never enter the sidebar). */
  threads?: ChatThread[];
  /** The thread's project — presence enables project-scoped actions
   *  (F12 scripts). */
  project?: Project | null;
  /** Every project — the new-thread prompt lists them for the
   *  affiliation switch (frozen NewThreadPrompt). */
  projects?: Project[];
  providerLabel: string;
  mode: "mock" | "synthetic-stdio" | "codex";
  codex?: CodexInfo;
  readOnly?: boolean;
  /** F15: the thread's working directory when provably available. */
  directory?: string | null;
  /** Which dock panel is open — terminal and Git share one slot. */
  dock?: "terminal" | "git" | null;
  onToggleDock?: (name: "terminal" | "git") => void;
  /** F20: scheduled auto-resume for a usage-limit wait, epoch ms. */
  limitResumeAt?: number;
  /** F01: snapshot settings — showReasoning gates the thinking blocks,
   *  showsWorkingCard picks the live working indicator's card/line
   *  form (frozen Conversation defaults). */
  settings?: Settings;
  /** Hydra intro's "Set up in Settings" — the modal lives on the shell. */
  onOpenSettings?: () => void;
}): React.JSX.Element {
  const t = useT();
  const endRef = useRef<HTMLDivElement>(null);
  // F03: scroll container for the conversation-outline rail.
  const timelineRef = useRef<HTMLDivElement>(null);
  const { thread } = props;

  // Per-turn checkpoint records — fetched by ledger identity, refetched
  // on "checkpoints-changed". A generation guard keeps late responses
  // from overwriting another thread's selection.
  const [ckpts, setCkpts] = useState<CheckpointRecordView[]>([]);
  const [previewTurn, setPreviewTurn] = useState<string | null>(null);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [msgMenu, setMsgMenu] = useState<MessagePopoverState | null>(null);
  const ckptGen = useRef(0);
  const threadId = thread?.id ?? null;
  useEffect(() => {
    setCkpts([]);
    setPreviewTurn(null);
    if (!threadId) return;
    const g = ++ckptGen.current;
    const refetch = () => {
      const mine = g;
      callApi("checkpoints:list", { threadId })
        .then((r) => {
          if (mine === ckptGen.current && Array.isArray(r))
            setCkpts(r as CheckpointRecordView[]);
        })
        .catch(() => {});
    };
    refetch();
    return api().onEvent((e) => {
      if (e.type === "checkpoints-changed" && e.threadId === threadId) refetch();
    });
  }, [threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, thread?.turn?.seq, thread?.turn?.status]);

  // F22: the lead's resolved heads for the mark and the panel (frozen
  // HydraButton.panelHeads). Runtime-only panel visibility — a new head
  // auto-shows it (frozen AppModel+Hydra spawn parity).
  const heads = useMemo(
    () =>
      (props.threads ?? []).filter((x) => x.hydraHead?.leadId === threadId),
    [props.threads, threadId],
  );
  const [hydraPanelHidden, setHydraPanelHidden] = useState(false);
  const headCount = useRef(0);
  // A84 (frozen StreamVeil): per-message veil bookkeeping — how much text
  // the latest flush added and the EMA of flush gaps that paces the fade.
  const veilRef = useRef(
    new Map<
      string,
      {
        len: number;
        ema: number | null;
        at: number;
        veil: { chars: number; ms: number } | null;
        veilUntil: number;
      }
    >(),
  );
  useEffect(() => {
    setHydraPanelHidden(false);
    headCount.current = 0;
    veilRef.current.clear();
  }, [threadId]);
  useEffect(() => {
    if (heads.length > headCount.current) setHydraPanelHidden(false);
    headCount.current = heads.length;
  }, [heads.length]);

  if (!thread) {
    return (
      <main className="chat">
        <div className="center-state">
          <p>{t("Pick a thread or start a new one")}</p>
        </div>
      </main>
    );
  }

  const turn = thread.turn;
  const waiting = turn?.status === "waiting-approval";
  const hadInterrupted = thread.messages.some((m) => m.status === "interrupted");
  const syntheticStdio = props.mode === "synthetic-stdio";
  const codex = props.mode === "codex" ? props.codex : undefined;
  const badgeText = syntheticStdio
    ? t("Synthetic stdio")
    : codex
      ? codex.state === "fixture"
        ? t("Codex fixture")
        : t("Codex")
      : t("Mock Provider");
  const badgeTitle = syntheticStdio
    ? t("Controlled local child process — no real model, tools or network")
    : codex
      ? codex.state === "fixture"
        ? t("Offline Codex protocol fixture — deterministic, no real CLI or model")
        : codex.state === "unconfigured"
          ? t("Codex app-server is not configured")
          : t("Codex app-server — real launch not yet verified")
      : t("Synthetic provider — no real model, tools or commands");

  return (
    <main className="chat">
      <header className="chat-head">
        <h1>{thread.title}</h1>
        <span className="badge mock" title={badgeTitle}>
          {badgeText}
        </span>
        {turn && (turn.status === "running" || waiting) && (
          <span className="badge">
            {waiting ? t("Waiting for approval") : `${t("Working")}`}
            {!waiting && <span className="dots" aria-hidden="true" />}
          </span>
        )}
        <HydraMark
          thread={thread}
          heads={heads}
          readOnly={props.readOnly === true}
          panelHidden={hydraPanelHidden}
          onTogglePanel={() => setHydraPanelHidden((h) => !h)}
          {...(props.onOpenSettings ? { onOpenSettings: props.onOpenSettings } : {})}
        />
        {thread && (
          <>
            <button
              className="head-action"
              title={t("Forward to new thread")}
              aria-label={t("Forward to new thread")}
              disabled={props.readOnly === true}
              onClick={() =>
                void callApi("threads:forward", { threadId: thread.id }).catch(() => {})
              }
            >
              {t("Forward")}
            </button>
            <OpenInMenu
              threadId={thread.id}
              hasDirectory={props.directory !== undefined && props.directory !== null}
              readOnly={props.readOnly === true}
            />
            {(props.directory !== undefined && props.directory !== null) && (
              <BranchMenu
                threadId={thread.id}
                worktree={thread.worktreeDir !== undefined}
                running={turn?.status === "running" || turn?.status === "waiting-approval"}
                readOnly={props.readOnly === true}
              />
            )}
            <button
              className="head-action"
              title={
                thread.worktreeDir
                  ? `${t("Thread worktree")} — ${thread.worktreeDir}`
                  : t("Run this thread in its own git worktree")
              }
              aria-label={t("Thread worktree")}
              disabled={props.readOnly === true}
              onClick={() => setWorktreeOpen(true)}
            >
              {thread.worktreeDir ? `⎇ ${t("Worktree")}` : t("Worktree")}
            </button>
            {props.project && (
              <button
                className="head-action"
                title={t("Run or edit project scripts")}
                aria-label={t("Scripts")}
                disabled={props.readOnly === true}
                onClick={() => setScriptsOpen(true)}
              >
                ▶ {t("Scripts")}
              </button>
            )}
            {/* Copy path lives inside the Open-in menu (frozen OpenInMenu). */}
          </>
        )}
        {props.onToggleDock && (
          <>
            <button
              className={`term-toggle ${props.dock === "terminal" ? "on" : ""}`}
              onClick={() => props.onToggleDock!("terminal")}
              aria-pressed={props.dock === "terminal"}
              title={t("Terminal")}
            >
              {t("Terminal")}
            </button>
            <button
              className={`term-toggle ${props.dock === "git" ? "on" : ""}`}
              onClick={() => props.onToggleDock!("git")}
              aria-pressed={props.dock === "git"}
              title={t("Git")}
            >
              {t("Git")}
            </button>
          </>
        )}
      </header>
      {thread && props.threads && (!hydraPanelHidden || !!thread.hydraHead) && (
        <HydraPanel
          thread={thread}
          threads={props.threads}
          readOnly={props.readOnly === true}
        />
      )}
      {props.readOnly && (
        <div className="banner error" role="alert">
          {t(
            "Closing failed earlier — the app is read-only and no new turns can start. Retry closing from the system menu.",
          )}
        </div>
      )}
      {hadInterrupted && (
        <div className="banner" role="status">
          {t("This thread had an interrupted turn. It was not resumed automatically.")}
        </div>
      )}
      {turn?.status === "error" && (
        <div className="banner error" role="alert">
          {t("Error")}: {turn.error ? translateError(t, turn.error) : null}
        </div>
      )}
      <div className="timeline-wrap">
      <div className="timeline" role="log" aria-live="polite" ref={timelineRef} data-chat-id={thread.id}>
        {thread.messages.length === 0 && (
          <NewThreadPrompt
            thread={thread}
            project={props.project ?? null}
            projects={props.projects ?? []}
          />
        )}
        {(() => {
          // A84 (frozen StreamVeil): the tail that just flushed dissolves
          // in once; the fade length follows an EMA of the gaps between
          // flushes, clamped 120–400ms. Settled text never animates.
          const veilFor = (m: Message): { chars: number; ms: number } | null => {
            if (m.status !== "streaming") {
              veilRef.current.delete(m.id);
              return null;
            }
            const now = performance.now();
            const rec = veilRef.current.get(m.id);
            const chars = m.content.length - (rec?.len ?? 0);
            const gap = rec ? now - rec.at : null;
            const ema =
              rec && chars > 0 && gap !== null
                ? rec.ema == null
                  ? gap
                  : rec.ema * 0.7 + gap * 0.3
                : (rec?.ema ?? null);
            if (chars <= 0) {
              // Frozen dissolve-in-once: within the fade window the same
              // veil stays mounted so the animation completes; settled
              // text (window past) renders plainly even mid-stream.
              if (rec?.veil && now < rec.veilUntil) return rec.veil;
              return null;
            }
            const ms = Math.min(400, Math.max(120, (ema ?? 80) * 3));
            const veil = { chars, ms };
            veilRef.current.set(m.id, {
              len: m.content.length,
              ema,
              at: now,
              veil,
              veilUntil: now + ms,
            });
            return veil;
          };
          const renderMessage = (m: Message): React.JSX.Element | null => {
          const ck = m.role === "assistant" && m.turnId
            ? ckpts.find((r) => r.turnId === m.turnId)
            : undefined;
          if (m.kind === "reasoning") {
            // Frozen TimelineGroup.build: thinking NEVER renders as a row
            // of its own — it only lives behind the running indicator's
            // chevron while the turn is live (and showReasoning is on).
            return null;
          }
          if (m.kind === "plan") {
            return (
              <details
                key={m.id}
                className={`msg plan-block ${m.status}`}
                open
              >
                <summary>
                  {t("Plan")}
                  {m.status === "streaming" && (
                    <span className="plan-spin">
                      <WorkingSpinner cellSize={3} />
                    </span>
                  )}
                </summary>
                <div className="plan-body">
                  {renderMarkdown(
                    m.content,
                    {
                      copy: t("Copy"),
                      copied: t("Copied"),
                      renderDelegation: delegationCard,
                    },
                    m.status === "streaming",
                    veilFor(m),
                  )}
                </div>
              </details>
            );
          }
          if (m.kind === "todos") {
            const steps = m.steps ?? [];
            const doneCount = steps.filter((st) => st.status === "done").length;
            return (
              <div key={m.id} className="msg todo-block" role="status">
                <div className="todo-head">
                  {t("Steps")} {doneCount}/{steps.length}
                </div>
                <ul className="todo-list">
                  {steps.map((st, i) => (
                    <li key={i} className={`todo-step s-${st.status}`}>
                      <span className="todo-mark" aria-hidden="true">
                        {st.status === "done" ? "✓" : st.status === "active" ? "▸" : "○"}
                      </span>
                      {st.text}
                    </li>
                  ))}
                </ul>
              </div>
            );
          }
          if (m.kind === "notice") {
            // Frozen NoticeRow: level glyph + tinted pill for warning/error,
            // plain inline text for info.
            const lv = m.noticeLevel ?? "info";
            return (
              <div key={m.id} className={`msg notice-row lv-${lv}`}>
                <span className="notice-glyph" aria-hidden="true">
                  {lv === "error" ? "⛔" : lv === "warning" ? "⚠" : "ⓘ"}
                </span>
                <span className="notice-text">{m.content}</span>
              </div>
            );
          }
          if (m.kind === "tool" && m.tool) {
            // Frozen: while the turn runs its tool entries fold into the
            // working indicator's chevron — never rows of their own.
            if (turn?.status === "running" && m.turnId === turn.id) return null;
            return <ToolMsgRow key={m.id} m={m} />;
          }
          // F04 (frozen MessagePopoverMenu): right-click opens the
          // message's context menu at the pointer — Copy, Copy as
          // markdown, the last fenced code block and Add to reply on
          // replies. A link target stays with the link popover; the
          // frozen "Edit from here" is revert, not in this build.
          const openMsgMenu = (e: React.MouseEvent) => {
            if (m.role !== "assistant" && m.role !== "user") return;
            const el = e.target as HTMLElement;
            if (el.closest("a[data-md-link]")) return;
            e.preventDefault();
            const article = el.closest("article.msg");
            const sel = window.getSelection();
            const selection =
              sel && !sel.isCollapsed && article && article.contains(sel.anchorNode)
                ? sel.toString()
                : null;
            const bodyEl = article?.querySelector(".msg-body");
            const plain = bodyEl
              ? Array.from(bodyEl.childNodes)
                  .map((n) => n.textContent ?? "")
                  .filter((s) => s !== "")
                  .join("\n")
              : m.content;
            setMsgMenu({
              text: m.content,
              selection: selection === "" ? null : selection,
              plain,
              role: m.role,
              threadId: thread.id,
              messageId: m.id,
              // F09: rewind rows only show for messages that belong to
              // a turn (system notes in this list carry no turnId).
              ...(m.turnId !== undefined ? { turnId: m.turnId } : {}),
              x: e.clientX,
              y: e.clientY,
            });
          };
          const peeled = m.role === "user" ? peelQuotes(m.content) : null;
          return (
            <article
              key={m.id}
              data-mid={m.id}
              className={`msg ${m.role} ${m.status}`}
              onContextMenu={openMsgMenu}
            >
              {(m.role === "assistant" || m.role === "user") && (
                <MsgCopyButton text={m.content} />
              )}
              {m.role === "assistant" ? (
                <div className="msg-body">
                  {renderMarkdown(
                    m.content.replaceAll(
                      `*${INTERRUPTED_MARKER}*`,
                      `*[${t("interrupted by restart — not resumed")}]*`,
                    ),
                    {
                      copy: t("Copy"),
                      copied: t("Copied"),
                      renderDelegation: delegationCard,
                    },
                    m.status === "streaming",
                    veilFor(m),
                  )}
                </div>
              ) : m.hydraBrief === true ? (
                // Frozen HydraBriefRow: the lead's brief arrives on the
                // head's thread as a pill — the markdown lives in its
                // popover, not in a raw user bubble.
                <div className="msg-body">
                  <HydraBriefPill
                    thread={thread}
                    {...(m.turnId !== undefined ? { turnId: m.turnId } : {})}
                    content={m.content}
                  />
                </div>
              ) : m.hydraHeads !== undefined ? (
                // Frozen HydraReportRow: a heads' report batch is a pill
                // on the user's side — the digest lives in its popover,
                // not in a raw-text bubble.
                <div className="msg-body">
                  <HydraReportRow heads={m.hydraHeads} content={m.content} />
                </div>
              ) : (
                <div className="msg-body">
                  {(peeled?.quotes ?? []).map((q) => (
                    <span className="quote-chip ro" key={q.id} title={q.text}>
                      <span className="quote-chip-text">{quoteExcerpt(q.text)}</span>
                    </span>
                  ))}
                  {peeled?.body ?? m.content}
                </div>
              )}
              {m.role === "user" && m.attachments && m.attachments.length > 0 && (
                <span className="msg-attach">
                  {m.attachments.map((a) => (
                    <AttachChip
                      key={a.id}
                      threadId={thread.id}
                      id={a.id}
                      name={a.name}
                      size={a.size}
                      ro
                    />
                  ))}
                </span>
              )}
              {m.role !== "user" && statusLabel(t, m) && (
                <span className="status-line">{statusLabel(t, m)}</span>
              )}
              {ck && (
                <div className={`ckpt-card s-${ck.status}`} role="status">
                  <span className="ckpt-state">
                    {ck.status === "complete"
                      ? t("Checkpoint captured")
                      : ck.status === "capturing"
                        ? t("Capturing checkpoint…")
                        : ck.status === "invalidated"
                          ? t("Checkpoint invalidated")
                          : t("Checkpoint unavailable")}
                  </span>
                  {ck.reason && <span className="ckpt-reason">{ck.reason}</span>}
                  {ck.touchedPaths.length > 0 && (
                    <span className="ckpt-paths">
                      {t("Files")}: {ck.touchedPaths.slice(0, 5).join(", ")}
                      {ck.touchedPaths.length > 5 ? ` +${ck.touchedPaths.length - 5}` : ""}
                    </span>
                  )}
                  {ck.status === "complete" && !ck.stale && (
                    <button
                      className="ckpt-preview-btn"
                      onClick={() => setPreviewTurn(ck.turnId)}
                    >
                      {t("Preview restore")}
                    </button>
                  )}
                  {ck.status === "complete" && ck.stale && (
                    <span className="ckpt-reason">{t("workspace changed — preview unavailable")}</span>
                  )}
                </div>
              )}
            </article>
          );
          };

          // F03 (frozen TurnFinishedBlock, bounded): messages cluster into
          // turn groups by turnId. The LIVE turn (thread.turn — running or
          // its last completed state) renders flat as before; earlier turns
          // keep user/assistant/system rows open while their work steps
          // fold into one "Worked for %@" details block. Undo/paging/
          // chronological toggles stay out of this cut.
          const items = groupMessages(thread.messages);
          const renderTurnSteps = (g: TurnGroup): React.ReactNode => {
            const { steps, open } = partitionGroup(g);
            if (g.turnId === turn?.id || steps.length === 0)
              return g.messages.map(renderMessage);
            const stepIds = new Set(steps.map((m) => m.id));
            const lastAssistant = [...open]
              .reverse()
              .find((m) => m.role === "assistant");
            const first = g.messages[0]!;
            const last = g.messages[g.messages.length - 1]!;
            const dur = formatDuration(first.ts, last.ts);
            const status = lastAssistant?.status;
            const stateLabel =
              status === "error" ? t("Failed after %@", dur)
              : status === "cancelled" || status === "denied" || status === "interrupted"
                ? t("Stopped after %@", dur)
                : t("Worked for %@", dur);
            const stepCount =
              steps.length === 1
                ? t("1 step")
                : t("%@ steps", String(steps.length));
            const fold = (
              <details
                key={`fold-${g.turnId}`}
                className="turn-steps"
                aria-label={t("Show this turn's steps")}
              >
                <summary>
                  <span className="turn-steps-label">{stateLabel}</span>
                  <span className="turn-steps-count">{stepCount}</span>
                  <span className="turn-steps-bar">
                    <HydraStaveBar
                      messages={g.messages}
                      tint="var(--accent)"
                      status={
                        status === "error" ? "failed"
                        : status === "cancelled" || status === "denied" || status === "interrupted" ? "stopped"
                        : "completed"
                      }
                    />
                  </span>
                </summary>
                <div className="turn-steps-body">{steps.map(renderMessage)}</div>
              </details>
            );
            const out: React.ReactNode[] = [];
            let inserted = false;
            for (const m of g.messages) {
              if (stepIds.has(m.id)) {
                if (!inserted) {
                  inserted = true;
                  out.push(fold);
                }
                continue;
              }
              out.push(renderMessage(m));
            }
            return out;
          };
          return items.map((item: TimelineItem) =>
            item.kind === "lone" ? renderMessage(item.message) : renderTurnSteps(item),
          );
        })()}
        {/* F03: frozen WorkingIndicator — the live working line at the
            timeline's tail while the turn runs. showsWorkingCard picks
            the card carrying the turn's progress bar; off renders the
            plain one-line badge (both share the header's live badge). */}
        {turn?.status === "running" && (
          <WorkingIndicator
            thread={thread}
            turn={turn}
            showsCard={props.settings?.showsWorkingCard !== false}
            showReasoning={props.settings?.showReasoning === true}
          />
        )}
        {turn?.approval && <ApprovalCard threadId={thread.id} approval={turn.approval} />}
        {turn?.question && <QuestionCard threadId={thread.id} question={turn.question} />}
        {props.limitResumeAt !== undefined && (
          <LimitWaitRow threadId={thread.id} resumeAt={props.limitResumeAt} />
        )}
        <div ref={endRef} />
      </div>
      {/* F03: frozen TimelineMinimap — one tick per user message on the
          timeline's leading edge, shown only when at least two exist. */}
      <TimelineMinimap messages={thread.messages} scrollRef={timelineRef} />
      </div>
      <ThreadChangesTab threadId={thread.id} />
      <Composer
        key={thread.id}
        thread={thread}
        mode={props.mode}
        readOnly={!!props.readOnly}
      />
      {msgMenu && (
        <MessagePopover state={msgMenu} onClose={() => setMsgMenu(null)} />
      )}
      {previewTurn && (
        <CheckpointPreviewDialog
          threadId={thread.id}
          turnId={previewTurn}
          onClose={() => setPreviewTurn(null)}
        />
      )}
      {worktreeOpen && <WorktreeDialog thread={thread} onClose={() => setWorktreeOpen(false)} />}
      {scriptsOpen && props.project && (
        <ScriptsDialog
          thread={thread}
          project={props.project}
          onClose={() => setScriptsOpen(false)}
          onRan={() => {
            if (props.dock !== "terminal") props.onToggleDock?.("terminal");
          }}
        />
      )}
    </main>
  );
}
