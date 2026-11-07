// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 timeline grouping (frozen TurnFinishedBlock bounded cut): messages
// carrying a turnId cluster into turn groups; a user message that lacks
// one (pre-A22 stores) is claimed by the next turn group it precedes.
// Untagged system rows (limit notes, send-now failures) stay lone rows.

import type { Message } from "../shared/types";

export interface TurnGroup {
  kind: "turn";
  turnId: string;
  messages: Message[];
}
export interface LoneRow {
  kind: "lone";
  message: Message;
}
export type TimelineItem = TurnGroup | LoneRow;

export function groupMessages(messages: readonly Message[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let pendingUsers: Message[] = [];
  let current: TurnGroup | null = null;

  const flushUsers = () => {
    for (const m of pendingUsers) items.push({ kind: "lone", message: m });
    pendingUsers = [];
  };
  const closeGroup = () => {
    if (current) items.push(current);
    current = null;
  };

  for (const m of messages) {
    if (m.turnId) {
      if (!current || current.turnId !== m.turnId) {
        closeGroup();
        current = { kind: "turn", turnId: m.turnId, messages: [] };
        // Users queued ahead of this group belong to the turn they started.
        for (const u of pendingUsers) current.messages.push(u);
        pendingUsers = [];
      }
      current.messages.push(m);
    } else if (m.role === "user") {
      pendingUsers.push(m);
    } else {
      flushUsers();
      closeGroup();
      items.push({ kind: "lone", message: m });
    }
  }
  flushUsers();
  closeGroup();
  return items;
}

/** Split a turn group into the step rows (frozen "this turn's steps" —
 *  reasoning/plan/todos/tool + provider notices) and the kept-open rows
 *  (user, assistant, untagged system notes). Step order is preserved. */
export function partitionGroup(g: TurnGroup): { steps: Message[]; open: Message[] } {
  const steps: Message[] = [];
  const open: Message[] = [];
  for (const m of g.messages) {
    // Frozen TimelineGroup.build: thinking is `continue`d before grouping —
    // it is never a step row, so it never counts toward the fold either.
    if (m.kind === "reasoning") continue;
    if (m.kind === "plan" || m.kind === "todos" || m.kind === "tool" || m.kind === "notice")
      steps.push(m);
    else open.push(m);
  }
  return { steps, open };
}

/** Frozen RelativeTime.duration port — narrow width, max 2 units,
 *  whole seconds rounded: "5s", "1m 20s", "2h 3m". */
export function formatDuration(startMs: number, endMs: number): string {
  const s = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}
