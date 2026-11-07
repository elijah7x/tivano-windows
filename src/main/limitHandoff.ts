// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F20: port of the frozen LimitHandoff — the message a chat that stopped
// on its provider's usage limit hands to the new chat taking the work
// over: the request it was answering and what it had already done in
// that turn, so another model can finish it. Bounded verbatim (40 lines,
// 400 chars per quote, 20 paths).

import type { ChatThread } from "../shared/types";

function flatten(text: string): string {
  return text.split(/\s+/).filter((x) => x.length > 0).join(" ");
}

/** The hand-off text for the chat's last turn. `touchedPaths` are the
 *  checkpoint ledger's provider-declared edits for that turn — when no
 *  ledger exists the files block is honestly omitted. */
export function limitHandoffText(
  thread: ChatThread,
  touchedPaths: readonly string[],
): string {
  const lastTurn = thread.turn;
  const turnMessages = lastTurn
    ? thread.messages.filter((m) => m.turnId === lastTurn.id || m.id === lastTurn.assistantMessageId)
    : thread.messages;

  let request: string | null = null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.role === "user") {
      request = flatten(m.content);
      break;
    }
  }
  const requestText = request ?? "(the request was not recorded)";

  const lines: string[] = [];
  for (const m of turnMessages) {
    if (lines.length >= 40) break;
    if (m.role === "assistant") {
      const flat = flatten(m.content);
      if (!flat) continue;
      lines.push(
        flat.length > 400 ? `- It said: ${flat.slice(0, 400)}…` : `- It said: ${flat}`,
      );
    } else if (m.kind === "tool" && m.tool) {
      let line = `- It ran: ${m.tool.title ?? m.tool.titleKey ?? m.tool.kind}`;
      if (m.tool.detail) line += ` (${flatten(m.tool.detail).slice(0, 140)})`;
      lines.push(line);
    }
  }

  const paths = touchedPaths.slice(0, 20);

  const blocks: string[] = [];
  blocks.push(
    `Continue the work from the chat "${thread.title}". It stopped when its provider's usage limit was reached, and it will not continue there.`,
  );
  blocks.push(`The request it was answering:\n\n${requestText}`);
  if (lines.length > 0)
    blocks.push(`What it had already done in that turn:\n\n${lines.join("\n")}`);
  if (paths.length > 0)
    blocks.push(`Files it had changed:\n\n${paths.map((p) => `- ${p}`).join("\n")}`);
  blocks.push("Take it over from here and finish it, asking me about anything unclear.");
  return blocks.join("\n\n");
}
