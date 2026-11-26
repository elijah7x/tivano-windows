// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 — the frozen WorkingBlockView + WorkGroupSummary + WorkSteps set
// (ThreadTimeline.swift/TimelineRows.swift): the live indicator at the
// timeline's tail while a turn runs — rotating word or counted work
// summary, narrow elapsed time, chevron disclosure of thinking + tool
// steps. Shared by ChatView and HelperPanel, both being the same
// timeline in the frozen layout.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread, Message, Turn } from "../../shared/types";
import {
  WORKING_WORDS,
  WORKING_WORD_ROTATE_SECONDS,
  formatElapsed,
  workingWordIndex,
} from "../../shared/workingWords";
import { useAppPaused, useInView } from "../appActivity";
import { useT } from "../locale";
import { renderMarkdown } from "../markdown";
import { HydraStaveBar } from "./HydraStaveBar";

/** Frozen WorkGroupSummary.text — counted, past-tense parts joined " · ":
 *  "Ran 2 commands · Edited 1 file · 1 failed". Edit tools count distinct
 *  targets; our ToolNote carries no edits array so `title` is the path.
 *  Declined is the user's call, not a failure; empty means "Worked". */
export function workGroupLabel(msgs: Message[], t: (k: string, ...v: string[]) => string): string {
  let thoughts = 0;
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let fetches = 0;
  let tools = 0;
  let failed = 0;
  const edited = new Set<string>();
  for (const m of msgs) {
    if (m.kind === "reasoning") {
      thoughts += 1;
      continue;
    }
    if (m.kind !== "tool" || !m.tool) continue;
    if (m.tool.state === "failed") failed += 1;
    switch (m.tool.kind) {
      case "command": commands += 1; break;
      case "edit": edited.add(m.tool.title ?? ""); break;
      case "read": reads += 1; break;
      case "search": searches += 1; break;
      case "web": fetches += 1; break;
      default: tools += 1;
    }
  }
  const one = (n: number, singular: string, plural: string) =>
    t(n === 1 ? singular : plural, String(n));
  const parts: string[] = [];
  if (thoughts === 1) parts.push(t("Thought process"));
  if (thoughts > 1) parts.push(one(thoughts, "", "Thought %@ times"));
  if (commands > 0) parts.push(one(commands, "Ran 1 command", "Ran %@ commands"));
  if (edited.size > 0) parts.push(one(edited.size, "Edited 1 file", "Edited %@ files"));
  if (reads > 0) parts.push(one(reads, "Read 1 file", "Read %@ files"));
  if (searches > 0) parts.push(one(searches, "Searched once", "Searched %@ times"));
  if (fetches > 0) parts.push(one(fetches, "Fetched 1 page", "Fetched %@ pages"));
  if (tools > 0) parts.push(one(tools, "Called 1 tool", "Called %@ tools"));
  if (failed > 0) parts.push(t("%d failed", String(failed)));
  return parts.length === 0 ? t("Worked") : parts.join(" · ");
}

/**
 * P2-63 (frozen ThreadTimeline.WorkingTitleLabel): isolated rotating-word
 * leaf so neither elapsed ticks nor word flips re-evaluate `WorkingIndicator`
 * or `HydraStaveBar`. Rotates only at the 7-second word boundary and pauses
 * while inactive, minimized or out of view.
 */
export function WorkingTitleLeaf({
  threadId,
  startedAt,
  quietMinutes,
  workSummary,
  paused,
}: {
  threadId: string;
  startedAt: number;
  quietMinutes: number | undefined;
  workSummary: string | null;
  paused: boolean;
}): React.JSX.Element {
  const t = useT();
  const [step, setStep] = useState(() =>
    Math.floor(Math.max(0, (Date.now() - startedAt) / 1000) / WORKING_WORD_ROTATE_SECONDS),
  );
  const fixed =
    quietMinutes !== undefined
      ? t("No response for %@ min…", String(quietMinutes))
      : workSummary;
  useEffect(() => {
    if (fixed !== null || paused) return;
    const stepMs = WORKING_WORD_ROTATE_SECONDS * 1000;
    const sync = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      setStep(Math.floor(elapsed / stepMs));
    };
    sync();
    let timeoutId: number | undefined;
    let intervalId: number | undefined;
    const elapsed = Math.max(0, Date.now() - startedAt);
    const delay = stepMs - (elapsed % stepMs);
    timeoutId = window.setTimeout(() => {
      sync();
      intervalId = window.setInterval(sync, stepMs);
    }, delay);
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [fixed, paused, startedAt]);

  const label =
    fixed ??
    `${t(WORKING_WORDS[workingWordIndex(threadId, step * WORKING_WORD_ROTATE_SECONDS)]!)}…`;
  return <span className={`work-label${paused ? " paused" : ""}`}>{label}</span>;
}

/**
 * P2-63 (frozen HydraElapsedTime): isolated 1-second leaf for the narrow
 * duration text. Pauses when inactive, minimized or out of view, and
 * catches up immediately upon return.
 */
export function WorkingElapsedTime({
  startedAt,
  paused,
}: {
  startedAt: number;
  paused: boolean;
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (paused) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [paused, startedAt]);
  return <span className="work-elapsed">{formatElapsed(now - startedAt)}</span>;
}

/**
 * F03 frozen WorkingIndicator label: quiet → "No response for N min…";
 * else tools → the group summary; else the seeded word rotating every 7
 * seconds of turn life.
 */
export function WorkingLabel({
  thread,
  turn,
  paused = false,
  liveWork,
}: {
  thread: ChatThread;
  turn: Turn;
  paused?: boolean;
  liveWork?: Message[];
}): React.JSX.Element {
  const t = useT();
  const tools = useMemo(
    () =>
      liveWork ??
      thread.messages.filter((m) => m.turnId === turn.id && m.kind === "tool"),
    [liveWork, thread.messages, turn.id],
  );
  const workSummary = useMemo(
    () => (tools.length > 0 ? workGroupLabel(tools, t) : null),
    [tools, t],
  );
  return (
    <>
      <WorkingTitleLeaf
        threadId={thread.id}
        startedAt={turn.startedAt}
        quietMinutes={turn.quietMinutes}
        workSummary={workSummary}
        paused={paused}
      />
      <WorkingElapsedTime startedAt={turn.startedAt} paused={paused} />
    </>
  );
}

const FIXED_TOOL_LABELS = new Set([
  "Tool",
  "Web search",
  "Image",
  "Send out a head",
  "Brief a head",
  "Wait for heads",
  "Recall a head",
  "Resume a head",
  "List heads",
  "Agent",
]);

/** One tool step — the same row in the timeline and inside the running
 *  indicator's WorkSteps disclosure (frozen WorkSteps entries). */
export function ToolMsgRow({ m }: { m: Message }): React.JSX.Element | null {
  const t = useT();
  const note = m.tool;
  if (!note) return null;
  const title = note.titleKey
    ? t(note.titleKey, ...(note.titleParams ?? []).map(String))
    : note.title && FIXED_TOOL_LABELS.has(note.title)
      ? t(note.title)
      : (note.title ?? "");
  const detail =
    note.detail && FIXED_TOOL_LABELS.has(note.detail)
      ? t(note.detail)
      : note.detail;
  const stateLabel =
    note.state === "running" ? t("Running")
    : note.state === "completed" ? t("Completed")
    : note.state === "declined" ? t("Declined")
    : t("Failed");
  const kindLabel =
    note.kind === "command" ? t("Command")
    : note.kind === "read" ? t("Read")
    : note.kind === "search" ? t("Search")
    : note.kind === "edit" ? t("Edit")
    : note.kind === "mcp" ? "MCP"
    : note.kind === "web" ? t("Web")
    : note.kind === "agent" ? t("Agent")
    : t("Tool");
  return (
    <details
      className={`msg tool-row s-${note.state}`}
      open={note.state === "running"}
    >
      <summary>
        <span className="tool-kind">{kindLabel}</span>
        <span className="tool-title">{title}</span>
        <span className="tool-state">{stateLabel}</span>
      </summary>
      {detail && <pre className="tool-detail">{detail}</pre>}
    </details>
  );
}

/** F03 frozen WorkingBlockView — the live indicator at the timeline's
 *  tail while the turn runs. The label row carries the rotating word or
 *  the counted work summary (quiet text wins), the narrow elapsed time
 *  and, once thinking or tool steps exist, a chevron that opens them
 *  beneath. showsWorkingCard picks the card + stave bar; off is the
 *  one-line badge. Frozen stepLimit pages the oldest steps away. */
export function WorkingIndicator({
  thread,
  turn,
  showsCard,
  showReasoning,
}: {
  thread: ChatThread;
  turn: Turn;
  showsCard: boolean;
  showReasoning: boolean;
}): React.JSX.Element {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const appPaused = useAppPaused();
  const inView = useInView(rootRef);
  const paused = appPaused || !inView;
  const [expanded, setExpanded] = useState(false);
  const [stepLimit, setStepLimit] = useState(60);
  const turnMessages = useMemo(
    () => thread.messages.filter((m) => m.turnId === turn.id),
    [thread.messages, turn.id],
  );
  // Frozen: thinking joins the disclosure only while showReasoning is on.
  const thinkingSteps = useMemo(
    () => (showReasoning ? turnMessages.filter((m) => m.kind === "reasoning") : []),
    [showReasoning, turnMessages],
  );
  const liveWork = useMemo(
    () => turnMessages.filter((m) => m.kind === "tool"),
    [turnMessages],
  );
  const canExpand = thinkingSteps.length > 0 || liveWork.length > 0;
  const hiddenSteps = Math.max(0, thinkingSteps.length + liveWork.length - stepLimit);
  const visibleThinking = thinkingSteps.slice(Math.min(hiddenSteps, thinkingSteps.length));
  const visibleWork = liveWork.slice(Math.max(0, hiddenSteps - thinkingSteps.length));
  // Frozen TurnFinishedBlock.earlierStepsLabel.
  const nextPage = Math.min(60, hiddenSteps);
  const earlierLabel =
    nextPage === hiddenSteps
      ? t(hiddenSteps === 1 ? "Show 1 earlier step" : "Show %@ earlier steps", String(nextPage))
      : t("Show %@ earlier steps (%@ hidden)", String(nextPage), String(hiddenSteps));
  const mdLabels = { copy: t("Copy"), copied: t("Copied") };
  return (
    <div ref={rootRef} className={showsCard ? "work-card" : "work-line"}>
      <button
        type="button"
        className="work-head"
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        title={canExpand ? t(expanded ? "Hide these steps" : "Show these steps") : undefined}
        onClick={() => canExpand && setExpanded((x) => !x)}
      >
        <WorkingLabel thread={thread} turn={turn} paused={paused} liveWork={liveWork} />
        {canExpand && (
          <span className={`work-chev${expanded ? " open" : ""}`} aria-hidden="true">
            ›
          </span>
        )}
      </button>
      {showsCard && (
        <HydraStaveBar
          messages={turnMessages}
          tint="var(--accent)"
          status="running"
        />
      )}
      {expanded && canExpand && (
        <div className="work-steps">
          {hiddenSteps > 0 && (
            <button
              type="button"
              className="work-more"
              onClick={() => setStepLimit((x) => x + 60)}
            >
              {earlierLabel}
            </button>
          )}
          {visibleThinking.map((m) => (
            <div key={m.id} className="work-thinking">
              {renderMarkdown(m.content, mdLabels, m.status === "streaming")}
            </div>
          ))}
          {visibleWork.map((m) => (
            <ToolMsgRow key={m.id} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

