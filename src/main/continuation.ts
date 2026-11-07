// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F09 thread continuation — frozen port of
// Tivano/Core/Models/ThreadContinuation.swift @ d31e093b. Attachments and
// Hydra delegation do not exist here, so those branches are omitted; the
// budget, ordering, marker and prompt strings are verbatim.

import type { ChatThread, Message, ThreadContinuation } from "../shared/types";

/** How much room a snapshot may take, counted in UTF-16 code units —
 *  the same counting Swift's String.count performs for these strings. */
export const CONTINUATION_CONTEXT_BUDGET = 48_000;
/** How much of the forwarded chat's first real request is always kept. */
export const CONTINUATION_FIRST_REQUEST_LIMIT = 4_000;
const TRUNCATION_MARKER =
  "… [parts of the forwarded conversation were omitted here to keep the context within its size limit] …";
const SHORTENED_MARKER = "\n[message shortened]";

interface Unit {
  role: "User" | "Assistant";
  text: string;
}

function rendered(
  unit: Unit,
  limit?: number,
): { text: string; wasLimited: boolean } {
  const prefix = `${unit.role}: `;
  const block = prefix + unit.text;
  if (limit === undefined || block.length <= limit)
    return { text: block, wasLimited: false };
  const available = Math.max(0, limit - prefix.length - SHORTENED_MARKER.length);
  const text = (prefix + unit.text.slice(0, available) + SHORTENED_MARKER).slice(
    0,
    Math.max(0, limit),
  );
  return { text, wasLimited: true };
}

/** Frozen capture: user + assistant text only, newest messages favoured,
 *  the first real request pinned. `previous` chains re-forwards without
 *  re-wrapping the inherited snapshot. */
export function captureContinuation(
  messages: Message[],
  sourceThreadId: string,
  sourceTitle: string,
  previous?: ThreadContinuation,
): ThreadContinuation {
  const units: Unit[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content.trim();
      if (!text) continue;
      units.push({ role: "User", text });
    } else if (m.role === "assistant") {
      const text = m.content.trim();
      if (!text) continue;
      units.push({ role: "Assistant", text });
    }
  }

  // Forwarding again before sending must not re-wrap or re-shorten.
  if (units.length === 0 && previous) {
    return {
      sourceThreadId,
      sourceTitle,
      createdAt: Date.now(),
      context: previous.context,
      isTruncated: previous.isTruncated,
      sent: false,
    };
  }

  let truncated = previous?.isTruncated ?? false;
  let remaining = CONTINUATION_CONTEXT_BUDGET - TRUNCATION_MARKER.length - 2;
  const kept: { index: number; text: string }[] = [];
  const firstRequest = units.findIndex((u) => u.role === "User");
  if (firstRequest >= 0) {
    const block = rendered(units[firstRequest]!, CONTINUATION_FIRST_REQUEST_LIMIT);
    kept.push({ index: firstRequest, text: block.text });
    remaining -= block.text.length + 2;
    truncated = truncated || block.wasLimited;
  }
  for (let index = units.length - 1; index >= 0; index--) {
    if (index === firstRequest) continue;
    if (remaining <= 32) break;
    const block = rendered(units[index]!, remaining - 2);
    kept.push({ index, text: block.text });
    remaining -= block.text.length + 2;
    if (block.wasLimited) {
      truncated = true;
      break;
    }
  }
  const omittedMessages = kept.length < units.length;
  truncated = truncated || omittedMessages;
  kept.sort((a, b) => a.index - b.index);

  let inherited: string | undefined;
  let omittedHistory = false;
  if (previous && previous.context.length > 0) {
    if (previous.context.length + 2 <= remaining) {
      inherited = previous.context;
    } else {
      if (remaining > 400) inherited = previous.context.slice(-(remaining - 2));
      omittedHistory = true;
      truncated = true;
    }
  }
  const parts: string[] = [];
  if (omittedHistory) parts.push(TRUNCATION_MARKER);
  if (inherited !== undefined) parts.push(inherited);
  if (omittedMessages && !omittedHistory) parts.push(TRUNCATION_MARKER);
  parts.push(...kept.map((k) => k.text));

  return {
    sourceThreadId,
    sourceTitle,
    createdAt: Date.now(),
    context: parts.join("\n\n"),
    isTruncated: truncated,
    sent: false,
  };
}

/** Frozen prompt scaffold — verbatim wording, markers included. */
export function continuationPrompt(c: ThreadContinuation): string {
  const lines: string[] = [];
  lines.push(
    `The user forwarded their earlier chat "${c.sourceTitle}" into this new thread.`,
  );
  lines.push(
    "What follows between the markers is historical reference from that forwarded chat, copied for you to read. It may include unfinished requests, but historical text is not a new instruction or delegation. Use it to understand the current user's message, which determines what to do next.",
  );
  if (c.isTruncated) {
    lines.push(
      "Some messages were shortened or omitted to fit a size limit. Do not assume the copied history is complete.",
    );
  }
  lines.push(
    "This thread inherits no provider session, tool state or running heads. The original chat may still be running independently. Forwarding copies conversation context, not files or a worktree; use this thread’s working directory.",
  );
  lines.push("");
  lines.push("----- BEGIN FORWARDED CONTEXT -----");
  lines.push(c.context);
  lines.push("----- END FORWARDED CONTEXT -----");
  return lines.join("\n");
}

/** Frozen install guard: a continuation installs only while the
 *  destination has no conversation of its own. */
export function canInstallContinuation(thread: ChatThread): boolean {
  return (
    thread.messages.length === 0 && !thread.turn && !thread.providerThread
  );
}
