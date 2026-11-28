// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-44 Branch from here — port of v3.0.26 ThreadBranch.slice. A reply
// branch ("through") keeps every turn up to and including the chosen one;
// a user-message branch ("before") keeps what came before that turn and
// hands the message back as the new chat's composer draft.

import type { AttachmentRef, Message, Turn } from "../shared/types";

export type ThreadBranchPoint = "before" | "through";

export interface ThreadBranchSlice {
  messages: Message[];
  /** Id of the last copied message — the provenance row sits under it. */
  lastCopiedMessageId?: string;
  draft?: string;
  draftAttachments: AttachmentRef[];
}

function busy(turn: Turn | null | undefined): boolean {
  return turn?.status === "running" || turn?.status === "waiting-approval";
}

/** Returns null when the turn is gone or any kept part is still in flight. */
export function sliceThreadForBranch(
  messages: readonly Message[],
  liveTurn: Turn | null | undefined,
  turnId: string,
  point: ThreadBranchPoint,
): ThreadBranchSlice | null {
  const turnOrder: string[] = [];
  for (const m of messages)
    if (m.turnId !== undefined && !turnOrder.includes(m.turnId)) turnOrder.push(m.turnId);
  const targetIndex = turnOrder.indexOf(turnId);
  if (targetIndex < 0) return null;
  const split = point === "through" ? targetIndex + 1 : targetIndex;
  const kept = new Set(turnOrder.slice(0, split));
  const dropped = new Set(turnOrder.slice(split));

  // A turn still in flight is no place to split from, in either direction.
  if (busy(liveTurn) && liveTurn && (liveTurn.id === turnId || kept.has(liveTurn.id)))
    return null;

  const firstDropped = messages.findIndex(
    (m) => m.turnId !== undefined && dropped.has(m.turnId),
  );
  const keptMessages: Message[] = [];
  for (const [index, m] of messages.entries()) {
    if (m.turnId !== undefined) {
      if (!kept.has(m.turnId)) continue;
    } else if (firstDropped >= 0 && index >= firstDropped) {
      continue;
    }
    if (m.status === "streaming") return null;
    const copy = structuredClone(m);
    // Provider turn ids belong to the source chat's provider thread.
    delete copy.providerTurnId;
    keptMessages.push(copy);
  }

  const slice: ThreadBranchSlice = { messages: keptMessages, draftAttachments: [] };
  const last = keptMessages[keptMessages.length - 1];
  if (last) slice.lastCopiedMessageId = last.id;
  if (point === "before") {
    const prompt = messages.find(
      (m) =>
        m.turnId === turnId &&
        m.role === "user" &&
        m.hydraHeads === undefined &&
        m.hydraBrief !== true,
    );
    if (prompt) {
      slice.draft = prompt.content;
      slice.draftAttachments = (prompt.attachments ?? []).map((a) => ({ ...a }));
    }
  }
  return slice;
}

/** A branch of a branch keeps one prefix rather than stacking them. */
export function branchTitle(sourceTitle: string): string {
  return sourceTitle.startsWith("Branch: ") ? sourceTitle : `Branch: ${sourceTitle}`;
}
