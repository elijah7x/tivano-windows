// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F04 reply quotes — frozen ReplyQuote + ComposerDraft.outgoingText: a
// message can lead with blockquote lines that ride ahead of the typed
// words, shown as chips in the chat box and peeled back into chips on
// the sent message.

export interface ReplyQuote {
  id: string;
  text: string;
}

let nextQuoteId = 0;

export function makeQuote(text: string): ReplyQuote {
  nextQuoteId += 1;
  return { id: `q${nextQuoteId}`, text };
}

/** Frozen ReplyQuote.excerpt: first non-empty line, whitespace
 *  collapsed, ellipsized past 72 chars. */
export function quoteExcerpt(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return "";
  const collapsed = line.split(/\s+/).filter((w) => w !== "").join(" ");
  return collapsed.length > 72 ? collapsed.slice(0, 72) + "…" : collapsed;
}

/** Frozen ReplyQuote.peel: leading `>` blocks up to a blank line that no
 *  further `>` line follows come back as quotes; the rest is the body.
 *  A leading "/command" line separated from the quotes by a blank line
 *  stays with the words. A message with no leading quote comes back
 *  whole. */
export function peelQuotes(text: string): { quotes: ReplyQuote[]; body: string } {
  const lines = text.split("\n");
  let command: string | undefined;
  if (
    lines.length > 2 &&
    lines[0]!.startsWith("/") &&
    lines[1] === "" &&
    lines[2]!.startsWith(">")
  ) {
    command = lines[0];
    lines.splice(0, 2);
  }
  const quotes: ReplyQuote[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith(">")) {
    const block: string[] = [];
    while (index < lines.length && lines[index]!.startsWith(">")) {
      let line = lines[index]!.slice(1);
      if (line.startsWith(" ")) line = line.slice(1);
      block.push(line);
      index += 1;
    }
    quotes.push(makeQuote(block.join("\n")));
    // One blank line separates a block from the next; a blank line
    // before the words stays for the trim below.
    if (
      index + 1 < lines.length &&
      lines[index] === "" &&
      lines[index + 1]!.startsWith(">")
    ) {
      index += 1;
    }
  }
  if (quotes.length === 0) return { quotes, body: text };
  let body = lines.slice(index).join("\n");
  while (body.startsWith("\n")) body = body.slice(1);
  if (command !== undefined) body = body === "" ? command : `${command} ${body}`;
  return { quotes, body };
}

/** Frozen ComposerDraft.outgoingText: every quote as a markdown
 *  blockquote, a blank line, then the typed words; a picked command is
 *  the leading "/name". */
export function serializeOutgoing(
  quotes: readonly ReplyQuote[],
  text: string,
  command?: { name: string },
): string {
  const body = (() => {
    if (quotes.length === 0) return text;
    const blocks = quotes.map((q) =>
      q.text
        .split("\n")
        .map((l) => (l === "" ? ">" : `> ${l}`))
        .join("\n"),
    );
    return blocks.join("\n\n") + "\n\n" + text;
  })();
  if (!command) return body;
  const head = `/${command.name}`;
  if (body.trim() === "") return head;
  if (quotes.length === 0) return `${head} ${body}`;
  return `${head}\n\n${body}`;
}

/** Frozen lastCodeBlock: the last whole fenced code block's code — a
 *  simple scan for lines starting with three backticks. */
export function lastCodeBlock(text: string): string | null {
  let last: string | null = null;
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (open !== null) {
        last = open.join("\n");
        open = null;
      } else {
        open = [];
      }
    } else if (open !== null) {
      open.push(line);
    }
  }
  return last;
}
