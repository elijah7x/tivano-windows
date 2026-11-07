// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 text generation — frozen `TextCleanup.singleLine` + `TextGeneration`
// title validation ported verbatim. A generated reply only becomes a thread
// title when it reads like one; chatty model output is rejected.

/** Frozen TextCleanup.singleLine: first non-empty line, capped with "…". */
export function singleLine(text: string, limit = 120): string {
  const rest = text.replace(/^[\r\n]+/, "");
  const nl = rest.search(/[\r\n]/);
  const line = (nl === -1 ? rest : rest.slice(0, nl)).trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Swift `trimmingCharacters(in: "\"'`*#. ")` — strips those chars at BOTH ends. */
const TITLE_TRIM = /^["'`*#. ]+|["'`*#. ]+$/g;

/** Frozen TextGeneration.usable — does the reply read as a title? */
export function usableTitle(candidate: string): string | null {
  const title = candidate.trim();
  if (!title || title.length > 64) return null;
  if (title.split(/\s+/).filter(Boolean).length > 9) return null;
  if (title.includes("\n") || title.includes("?")) return null;
  const last = title[title.length - 1]!;
  if (":;,!…".includes(last)) return null;
  const lower = title.toLowerCase();
  const openers = [
    "i ", "i'", "sorry", "sure", "here", "please", "could you", "can you",
    "what ", "it seems", "it looks", "unfortunately", "there is no",
    "not enough", "need more", "maybe ", "the request", "this request",
  ];
  if (openers.some((o) => lower.startsWith(o))) return null;
  const phrases = [
    "more context", "meaningful title", "as an ai", "cannot", "can't", "unable to",
  ];
  if (phrases.some((p) => lower.includes(p))) return null;
  return title;
}

/**
 * Frozen threadTitle extraction: clean the reply, else fall back to its first
 * non-empty line — a model that answers with a sentence usually titles first.
 */
export function extractTitle(text: string): string | null {
  const cleaned = singleLine(text, 60).replace(TITLE_TRIM, "");
  const direct = usableTitle(cleaned);
  if (direct) return direct;
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ? usableTitle(firstLine.replace(TITLE_TRIM, "")) : null;
}
