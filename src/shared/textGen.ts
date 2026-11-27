// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 / P2-18 / P2-01 text generation — frozen `TextCleanup.singleLine` +
// `TextGeneration` prompts, title/next-prompt validation, and Codex
// background-model resolution ported verbatim.

import type { CodexModelOption, Message, Settings } from "./types";

/**
 * Maintainer decision (P2-18): Automatic Codex text generation targets a
 * mini-tier Codex model at low effort, named in a single constant.
 * Because `CodexModelOption` carries no pricing/cost metadata, selection
 * prefers `CODEX_AUTOMATIC_TEXT_MODEL` first and otherwise falls back to
 * the first catalog entry whose id or name matches `\bmini\b`.
 */
export const CODEX_AUTOMATIC_TEXT_MODEL = "gpt-5.1-codex-mini";
export const CODEX_AUTOMATIC_TEXT_EFFORT = "low";

const MINI_TIER_RE = /\bmini\b/i;

function effortRank(effort: string): number | undefined {
  return (
    {
      none: 0,
      minimal: 1,
      low: 2,
      medium: 3,
      high: 4,
      xhigh: 5,
      "extra-high": 5,
      extra_high: 5,
      "extra high": 5,
      max: 6,
      ultra: 6,
    } as Record<string, number>
  )[effort.toLowerCase()];
}

export function orderedTextGenEfforts(values: readonly string[]): string[] {
  const ranked = values.map((v, i) => ({ i, v, r: effortRank(v) }));
  if (ranked.filter((x) => x.r !== undefined).length <= 1) return [...values];
  return ranked
    .sort((a, b) =>
      a.r !== undefined && b.r !== undefined && a.r !== b.r ? a.r - b.r : a.i - b.i,
    )
    .map((x) => x.v);
}

export function textGenEffortTitle(effort: string): string {
  if (effort === "xhigh" || effort === "extra-high") return "Extra High";
  if (effort === "") return "Default";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Locate the Automatic mini-tier Codex model in a catalog: prefers the
 * maintainer-named constant first, then any mini-tier catalog entry.
 */
export function findAutomaticCodexTextModel(
  models: readonly CodexModelOption[],
): CodexModelOption | null {
  const target = CODEX_AUTOMATIC_TEXT_MODEL.toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === target);
  if (exact) return exact;
  return (
    models.find((m) => MINI_TIER_RE.test(m.id) || MINI_TIER_RE.test(m.name)) ??
    null
  );
}

/** Frozen AppModel.textEngine lowEffort helper: "low" when supported, else defaultEffort. */
export function lowCodexEffort(model: CodexModelOption): string | undefined {
  if (model.efforts.includes(CODEX_AUTOMATIC_TEXT_EFFORT)) {
    return CODEX_AUTOMATIC_TEXT_EFFORT;
  }
  if (model.efforts.length === 0) return undefined;
  return model.defaultEffort;
}

export type TextGenerationPlan =
  | { enabled: false }
  | { enabled: true; model?: string | undefined; effort?: string | undefined };

/**
 * Resolve which Codex model and reasoning effort should execute a background
 * text-generation call (titles, commit messages, predictions).
 * Never falls back to the Codex default model unless `allowsDefaultModel` is
 * true AND no mini-tier model exists in the catalog.
 */
export function resolveTextGenerationPlan(
  settings: {
    textGeneration?: Settings["textGeneration"] | undefined;
    textGenerationModelID?: string | undefined;
    textGenerationEffort?: string | undefined;
  },
  models: readonly CodexModelOption[] | null,
  opts?: { allowsDefaultModel?: boolean | undefined },
): TextGenerationPlan {
  const choice = settings.textGeneration ?? "automatic";
  if (choice === "off") return { enabled: false };

  const resolveAutomatic = (): TextGenerationPlan => {
    if (models === null) return { enabled: true };
    const mini = findAutomaticCodexTextModel(models);
    if (mini) {
      const effort = lowCodexEffort(mini);
      return { enabled: true, model: mini.id, ...(effort ? { effort } : {}) };
    }
    if (opts?.allowsDefaultModel !== false) {
      const fallback = models.find((m) => m.isDefault) ?? models[0];
      if (fallback) {
        const effort = lowCodexEffort(fallback);
        return {
          enabled: true,
          model: fallback.id,
          ...(effort ? { effort } : {}),
        };
      }
    }
    return { enabled: false };
  };

  if (choice === "codex") {
    const modelID = settings.textGenerationModelID?.trim();
    if (!modelID) return resolveAutomatic();
    if (models === null) {
      return {
        enabled: true,
        model: modelID,
        ...(settings.textGenerationEffort ? { effort: settings.textGenerationEffort } : {}),
      };
    }
    const option = models.find((m) => m.id === modelID);
    if (!option) return resolveAutomatic();
    const chosenEffort =
      settings.textGenerationEffort &&
      option.efforts.includes(settings.textGenerationEffort)
        ? settings.textGenerationEffort
        : undefined;
    return {
      enabled: true,
      model: option.id,
      ...(chosenEffort ? { effort: chosenEffort } : {}),
    };
  }

  return resolveAutomatic();
}

export function buildThreadTitlePrompt(message: string): string {
  return [
    "Write a title for this coding task so the user can recognize it weeks later.",
    "Rules: 3 to 7 words, under 40 characters, sentence case, no quotes, no trailing punctuation.",
    "Name the subject and the outcome. Do not copy the request word for word.",
    "The request may be a word or two, or come with attachments; even then, reply with",
    "your single best title and nothing else. Never ask a question, never explain,",
    "never mention the request or the word title.",
    "Reply with the title only.",
    "",
    "Request:",
    message.slice(0, 4_000),
  ].join("\n");
}

export function buildRefreshedTitlePrompt(current: string, context: string): string {
  return [
    "Decide whether the current title still describes this coding conversation.",
    "If it still summarizes the work the conversation is doing now, reply with KEEP only.",
    "If the work has substantially changed direction, write a new title.",
    "Rules for a new title: 3 to 7 words, under 40 characters, sentence case, no quotes, no trailing punctuation.",
    "Name the subject and the outcome. Do not copy the request word for word.",
    "Never ask a question, never explain, never mention the request or the word title.",
    "Reply with KEEP or the new title only.",
    "",
    "Current title:",
    current,
    "",
    "Conversation:",
    context.slice(0, 3_000),
  ].join("\n");
}

export function extractRefreshedTitle(currentTitle: string, text: string): string | null {
  const marker = text.trim().replace(/^["']+|["']+$/g, "");
  if (marker.toUpperCase() === "KEEP") return null;
  const title = extractTitle(text);
  if (!title || title === currentTitle) return null;
  return title;
}

export function buildCommitMessagePrompt(
  summary: string,
  patch: string,
  instructions: string,
): string {
  const extra = instructions ? `\nFollow these instructions too: ${instructions}\n` : "";
  return [
    "Write a git commit message for the changes below.",
    "Rules: an imperative subject line of at most 72 characters with no trailing period. Optionally add a blank line and a few short bullet points. Reply with the message only, without code fences.",
    extra,
    "Changed files:",
    summary.slice(0, 6_000),
    "",
    "Patch:",
    patch.slice(0, 40_000),
  ]
    .filter((line, i) => !(i === 2 && extra === ""))
    .join("\n");
}

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
  if (/[\r\n\u000B\u000C\u0085\u2028\u2029]/.test(suggestion)) return null;
  const cleaned = suggestion
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
  if (!cleaned || Array.from(cleaned).length > 240) return null;
  return cleaned;
}

export const NEXT_PROMPT_HEADER =
  "Predict this user's next message from the whole conversation below.";

/** P2-01 (frozen TextGeneration.nextPrompt): prompt template sent to one-shot text engines. */
export function buildNextPromptRequest(context: string): string {
  return [
    `${NEXT_PROMPT_HEADER} Write it as the user would, in the user's language and voice, as one short single-line message, ideally under 120 characters and never over 240. Say only the next request itself; do not add process steps the user has not asked for, such as reviewing or confirming first. First consider whether the user would want to adjust, verify or reuse what was just produced; do not invent unrelated tasks. If no next message is reasonably likely, the suggestion is null. Reply with JSON only: {"suggestion": string or null}.`,
    "",
    "Conversation:",
    Array.from(context).slice(0, 8000).join(""),
  ].join("\n");
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
    const a = isLast
      ? Array.from(t.assistant).slice(0, 3000).join("").trim()
      : singleLine(t.assistant, 600);
    if (a) lines.push(`Assistant: ${a}`);
    if (lines.length > 0) recent.push(lines.join("\n"));
  }
  while ([...firstSection, ...recent].join("\n").length > 8000 && recent.length > 0) {
    recent.shift();
  }
  return [...firstSection, ...recent].join("\n");
}
