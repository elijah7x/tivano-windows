// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 text generation — frozen `TextCleanup.singleLine` + `TextGeneration`
// title validation ported verbatim, plus P2-01 `TextGeneration.nextPrompt`
// JSON parsing and context assembly.

import type { Message } from "./types";

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

/**
 * P2-01 (frozen TextGeneration.nextPrompt): parse JSON `{"suggestion": string | null}`,
 * reject newlines, strip control characters, trim, and enforce the 240-char cap.
 */
export function extractNextPrompt(raw: string): string | null {
  const stripped = raw.replaceAll("```json", "").replaceAll("```", "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const suggestion = (parsed as Record<string, unknown>).suggestion;
  if (typeof suggestion !== "string") return null;
  if (/[\r\n]/.test(suggestion)) return null;
  const cleaned = suggestion.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  if (!cleaned || cleaned.length > 240) return null;
  return cleaned;
}

/**
 * P2-01 (frozen ThreadRuntime.promptPredictionContext): build an <=8000-char
 * conversation transcript starting with the first user request and up to the
 * 6 most recent user/assistant turns (full last assistant prefix up to 3000 chars).
 */
export function buildPredictionContext(
  messages: readonly Pick<Message, "role" | "content" | "turnId">[],
): string {
  const turns: { user: string; assistant: string }[] = [];
  const byTurnId = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.turnId) {
      let idx = byTurnId.get(m.turnId);
      if (idx === undefined) {
        idx = turns.length;
        turns.push({ user: "", assistant: "" });
        byTurnId.set(m.turnId, idx);
      }
      if (m.role === "user") {
        turns[idx]!.user = turns[idx]!.user ? `${turns[idx]!.user}\n${m.content}` : m.content;
      } else {
        turns[idx]!.assistant = turns[idx]!.assistant
          ? `${turns[idx]!.assistant}\n${m.content}`
          : m.content;
      }
    } else if (m.role === "user") {
      turns.push({ user: m.content, assistant: "" });
    } else if (turns.length > 0 && !turns[turns.length - 1]!.assistant) {
      turns[turns.length - 1]!.assistant = m.content;
    } else {
      turns.push({ user: "", assistant: m.content });
    }
  }
  const firstUser = turns[0]?.user ? singleLine(turns[0].user, 600) : "";
  const firstSection = firstUser ? [`First request: ${firstUser}`] : [];
  const tail = turns.slice(-6);
  const recent: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const t = tail[i]!;
    const lines: string[] = [];
    const u = singleLine(t.user, 600);
    if (u) lines.push(`User: ${u}`);
    const isLast = i === tail.length - 1;
    const a = isLast ? t.assistant.slice(0, 3000).trim() : singleLine(t.assistant, 600);
    if (a) lines.push(`Assistant: ${a}`);
    if (lines.length > 0) recent.push(lines.join("\n"));
  }
  while ([...firstSection, ...recent].join("\n").length > 8000 && recent.length > 0) {
    recent.shift();
  }
  return [...firstSection, ...recent].join("\n");
}
