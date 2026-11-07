// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 — the frozen WorkingBlockView + WorkGroupSummary + WorkSteps set
// (ThreadTimeline.swift/TimelineRows.swift): the live indicator at the
// timeline's tail while a turn runs — rotating word or counted work
// summary, narrow elapsed time, chevron disclosure of thinking + tool
// steps. Shared by ChatView and HelperPanel, both being the same
// timeline in the frozen layout.

import { useEffect, useState } from "react";
import type { ChatThread, Message, Turn } from "../../shared/types";
import {
  WORKING_WORDS,
  formatElapsed,
  workingWordIndex,
} from "../../shared/workingWords";
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
 * F03 frozen WorkingIndicator label: quiet → "No response for N min…";
 * else tools → the group summary; else the seeded word rotating every 7
 * seconds of turn life. The right side is the narrow-format elapsed time,
 * both ticking once a second while the turn runs.
 */
export function WorkingLabel({ thread, turn }: { thread: ChatThread; turn: Turn }): React.JSX.Element {
  const t = useT();
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - turn.startedAt) / 1000);
  const liveWork = thread.messages.filter(
    (m) => m.turnId === turn.id && m.kind === "tool",
  );
  const quiet =
    turn.quietMinutes !== undefined ? t("No response for %@ min…", String(turn.quietMinutes)) : undefined;
  const label =
    quiet ??
    (liveWork.length > 0
      ? workGroupLabel(liveWork, t)
      : `${t(WORKING_WORDS[workingWordIndex(thread.id, elapsedSec)]!)}…`);
  return (
    <>
      <span className="work-label">{label}</span>
      <span className="work-elapsed">{formatElapsed(now - turn.startedAt)}</span>
    </>
  );
}

/** One tool step — the same row in the timeline and inside the running
 *  indicator's WorkSteps disclosure (frozen WorkSteps entries). */
export function ToolMsgRow({ m }: { m: Message }): React.JSX.Element | null {
  const t = useT();
  const note = m.tool;
  if (!note) return null;
  const title = note.titleKey
    ? t(note.titleKey, ...(note.titleParams ?? []).map(String))
    : (note.title ?? "");
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
      {note.detail && <pre className="tool-detail">{note.detail}</pre>}
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
  const [expanded, setExpanded] = useState(false);
  const [stepLimit, setStepLimit] = useState(60);
  // Frozen: thinking joins the disclosure only while showReasoning is on.
  const thinkingSteps = showReasoning
    ? thread.messages.filter((m) => m.turnId === turn.id && m.kind === "reasoning")
    : [];
  const liveWork = thread.messages.filter(
    (m) => m.turnId === turn.id && m.kind === "tool",
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
    <div className={showsCard ? "work-card" : "work-line"}>
      <button
        type="button"
        className="work-head"
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        title={canExpand ? t(expanded ? "Hide these steps" : "Show these steps") : undefined}
        onClick={() => canExpand && setExpanded((x) => !x)}
      >
        <WorkingLabel thread={thread} turn={turn} />
        {canExpand && (
          <span className={`work-chev${expanded ? " open" : ""}`} aria-hidden="true">
            ›
          </span>
        )}
      </button>
      {showsCard && (
        <HydraStaveBar
          messages={thread.messages.filter((m) => m.turnId === turn.id)}
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

