// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Antigravity (`agy`) provider adapter — drives `agy --input-format stream-json
// --output-format stream-json --print-timeout 0 --add-dir <cwd> --log-file <log>`,
// speaks `init` / `step_update` / `result` events, tails `--log-file` for `agy`
// retries, enforces per-turn error judging (P2-35/P2-59), pins Supervised to
// Default mode via `--settings {"agentMode":""}`, passes full `<base>-<effort>`
// model ids without `--effort`, never forwards or writes MCP configs, and
// implements one-shot Hydra review.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { openSync, readFileSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AdapterDisposeResult,
  ChildCleanupResult,
  ProviderAdapter,
  ProviderCallbacks,
  ProviderDescriptor,
  ProviderTurnHandle,
  ToolActivity,
  TurnContext,
} from "./provider";
import type { CodexModelOption, ProviderThreadBinding } from "../shared/types";
import {
  DEFAULT_TRANSPORT_LIMITS,
  StdioTransport,
  type SpawnImpl,
  type TransportLimits,
} from "./stdioTransport";
import { encodeJsonLine, ProtocolError, type WireCodec } from "./stdioFrames";
import { makeJobHelperSpawnImpl, PROCESS_TREE_UNSUPPORTED } from "./providerProcessLifecycle";
import {
  ANTIGRAVITY_PROTOCOL_PIN,
  ANTIGRAVITY_PROVIDER_ID,
  AntigravityConfigError,
  isUnsafeRemotePath,
  type AntigravityRuntimeConfig,
} from "./antigravityRuntimeConfig";

export const ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const ANTIGRAVITY_DEFAULT_START_TIMEOUT_MS = 90_000;
export const ANTIGRAVITY_DEFAULT_REVIEW_TIMEOUT_MS = 900_000;

/** Exact effort-suffixed base models listed by `agy models` (P2-59). */
export const ANTIGRAVITY_SUFFIXED_BASES = new Set([
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-4-argon",
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gpt-oss-120b",
]);

/** Seed catalog entries retained for Antigravity (retired Gemini models dropped). */
export const ANTIGRAVITY_SEED: readonly CodexModelOption[] = [
  {
    id: "gemini-4-neon",
    name: "Gemini 4 Neon",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    isDefault: true,
  },
  {
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
    efforts: ["low", "medium", "high"],
    defaultEffort: "high",
    isDefault: false,
  },
  {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    isDefault: false,
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    isDefault: false,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    efforts: ["low", "medium", "high"],
    defaultEffort: "high",
    isDefault: false,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    efforts: [],
    isDefault: false,
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    efforts: [],
    isDefault: false,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    efforts: ["medium"],
    defaultEffort: "medium",
    isDefault: false,
  },
];

const RETIRED_MODEL_PATTERNS = [
  /^gemini-2\./i,
  /^gemini-3\.(0|1|5)\b/i,
  /^gemini-3-(pro|flash)\b/i,
];

export function isRetiredAntigravityModel(id: string): boolean {
  const lower = id.trim().toLowerCase();
  return RETIRED_MODEL_PATTERNS.some((re) => re.test(lower));
}

function isModelSlug(text: string): boolean {
  if (!text) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
}

function effortRank(effort: string): number {
  const idx = (ANTIGRAVITY_EFFORTS as readonly string[]).indexOf(effort.toLowerCase());
  return idx >= 0 ? idx : 99;
}

export function sortAntigravityEfforts(efforts: Iterable<string>): string[] {
  const unique = Array.from(
    new Set(
      Array.from(efforts)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  );
  return unique.sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b));
}

function splitSuffixedSlug(slug: string): { base: string; effort: string } | null {
  // Longest suffix first so `-xhigh` is never matched as `-high`.
  for (const eff of ["medium", "xhigh", "high", "low", "max"] as const) {
    const suffix = `-${eff}`;
    if (slug.toLowerCase().endsWith(suffix) && slug.length > suffix.length) {
      return {
        base: slug.slice(0, slug.length - suffix.length),
        effort: eff,
      };
    }
  }
  return null;
}

function cleanDisplayName(rawName: string, effort?: string): string {
  let s = rawName.trim();
  if (effort) {
    const title = effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);
    const re = new RegExp(`\\s*[\\(\\[]?(?:${title}|${effort})[\\)\\]]?$`, "i");
    s = s.replace(re, "").trim();
  }
  return s;
}

export interface ParsedModelsResult {
  models: CodexModelOption[];
  /** Full `<base>-<effort>` slugs seen directly from `agy models`. */
  suffixedIds: Map<string, Set<string>>;
}

/**
 * Parse one raw TSV row of `agy models` (`slug\tDisplay Name`).
 * Ignores status chatter (`Fetching available models...`), headers, blanks, and retired Gemini models.
 */
export function parseModelRow(line: string): { id: string; name: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const tab = trimmed.indexOf("\t");
  const rawId = (tab >= 0 ? trimmed.slice(0, tab) : trimmed).trim();
  if (!isModelSlug(rawId)) return null;
  if (rawId.toLowerCase() === "id" || rawId.toLowerCase() === "model") return null;
  if (isRetiredAntigravityModel(rawId)) return null;
  const rawName = (tab >= 0 ? trimmed.slice(tab + 1) : "").trim();
  return { id: rawId, name: rawName || rawId };
}

/**
 * Parse `agy models` stdout into deduplicated catalog options + seed fallback.
 * Records every live `<base>-<effort>` slug in `suffixedIds` so model invocations
 * always send the full `agy` model id without `--effort`.
 */
export function parseModelsOutput(stdout: string): ParsedModelsResult {
  const rawRows: { id: string; name: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const row = parseModelRow(line);
    if (row) rawRows.push(row);
  }
  if (rawRows.length === 0) {
    throw new Error("`agy models` listed no models.");
  }

  const byBase = new Map<
    string,
    { id: string; name: string; efforts: Set<string>; suffixed: boolean; defaultEffort?: string }
  >();
  const suffixedIds = new Map<string, Set<string>>();

  for (const row of rawRows) {
    const split = splitSuffixedSlug(row.id);
    if (split) {
      const base = split.base;
      const set = suffixedIds.get(base) ?? new Set<string>();
      set.add(split.effort);
      suffixedIds.set(base, set);

      const cur = byBase.get(base) ?? {
        id: base,
        name: cleanDisplayName(row.name, split.effort) || base,
        efforts: new Set<string>(),
        suffixed: true,
      };
      cur.efforts.add(split.effort);
      if (!cur.defaultEffort && split.effort === "medium") cur.defaultEffort = "medium";
      byBase.set(base, cur);
      continue;
    }

    const seedMatch = ANTIGRAVITY_SEED.find((s) => s.id === row.id);
    const cur = byBase.get(row.id) ?? {
      id: row.id,
      name: row.name || seedMatch?.name || row.id,
      efforts: new Set<string>(seedMatch?.efforts ?? []),
      suffixed: false,
      ...(seedMatch?.defaultEffort ? { defaultEffort: seedMatch.defaultEffort } : {}),
    };
    byBase.set(row.id, cur);
  }

  const parsed: CodexModelOption[] = [];
  for (const item of byBase.values()) {
    const efforts = sortAntigravityEfforts(item.efforts);
    const seedMatch = ANTIGRAVITY_SEED.find((s) => s.id === item.id);
    const defaultEffort =
      efforts.includes("high")
        ? "high"
        : seedMatch?.defaultEffort && efforts.includes(seedMatch.defaultEffort)
          ? seedMatch.defaultEffort
          : efforts[efforts.length - 1];
    parsed.push({
      id: item.id,
      name: item.name,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      isDefault: item.id === "gemini-4-neon",
    });
  }

  const merged = addingSeedRows(parsed);
  for (const seed of ANTIGRAVITY_SEED) {
    if (ANTIGRAVITY_SUFFIXED_BASES.has(seed.id) && seed.efforts.length > 0 && !suffixedIds.has(seed.id)) {
      suffixedIds.set(seed.id, new Set(seed.efforts));
    }
  }
  return { models: merged, suffixedIds };
}

/** Merge active seed models when a partial CLI response omitted them. */
export function addingSeedRows(parsed: CodexModelOption[]): CodexModelOption[] {
  const byId = new Map<string, CodexModelOption>();
  for (const m of parsed) {
    if (!isRetiredAntigravityModel(m.id)) byId.set(m.id, m);
  }
  for (const seed of ANTIGRAVITY_SEED) {
    if (!byId.has(seed.id)) byId.set(seed.id, { ...seed, efforts: [...seed.efforts] });
  }
  const hasDefault = Array.from(byId.values()).some((m) => m.isDefault);
  if (!hasDefault) {
    const first = byId.values().next().value;
    if (first) byId.set(first.id, { ...first, isDefault: true });
  }
  return Array.from(byId.values());
}

/**
 * Normalize model and effort flags for `agy` (P2-35, P2-59).
 *  - Claude models hosted on Antigravity never take `--effort`.
 *  - Effort is clamped strictly to what the model's catalog row advertises.
 *  - Unknown models pass only an explicitly requested effort (never an invented default).
 *  - Suffixed models emit `--model <base>-<effort>` with no `--effort`.
 */
export function normalizeModelAndEffort(
  model: string | undefined,
  effort: string | undefined,
  catalog: readonly CodexModelOption[] = ANTIGRAVITY_SEED,
  suffixedIds: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): { model?: string; effort?: string } {
  const rawModel = model?.trim();
  if (!rawModel) return {};

  const split = splitSuffixedSlug(rawModel);
  const base = split ? split.base : rawModel;

  if (base.toLowerCase().includes("claude")) {
    return { model: base };
  }

  const reqEffort = effort?.trim().toLowerCase() || undefined;
  const requestedOrSlugEffort = reqEffort ?? split?.effort;

  const catalogOpt =
    catalog.find((m) => m.id === base) ??
    catalog.find((m) => m.id === rawModel) ??
    ANTIGRAVITY_SEED.find((m) => m.id === base);

  const isSuffixedBase =
    ANTIGRAVITY_SUFFIXED_BASES.has(base) ||
    suffixedIds.has(base) ||
    (split !== null && (catalogOpt?.efforts.includes(split.effort) ?? false));

  const resolveArgs = (b: string, eff?: string): { model: string; effort?: string } => {
    if (
      eff &&
      (ANTIGRAVITY_SUFFIXED_BASES.has(b) || suffixedIds.get(b)?.has(eff))
    ) {
      return { model: `${b}-${eff}` };
    }
    return eff ? { model: b, effort: eff } : { model: b };
  };

  if (!catalogOpt && !suffixedIds.has(base)) {
    let resolved = requestedOrSlugEffort;
    if (!resolved) {
      if (base === "gpt-oss-120b") resolved = "medium";
      else if (base === "gemini-3.1-pro") resolved = "high";
    }
    if (base === "gemini-3.1-pro" && resolved === "medium") resolved = "high";
    else if (base === "gpt-oss-120b") resolved = "medium";
    return resolveArgs(base, resolved);
  }

  const supported =
    catalogOpt?.efforts ??
    (suffixedIds.has(base) ? sortAntigravityEfforts(suffixedIds.get(base)!) : []);
  if (supported.length === 0) {
    return { model: base };
  }

  let resolved: string | undefined;
  if (requestedOrSlugEffort && supported.includes(requestedOrSlugEffort)) {
    resolved = requestedOrSlugEffort;
  } else if (catalogOpt?.defaultEffort && supported.includes(catalogOpt.defaultEffort)) {
    resolved = catalogOpt.defaultEffort;
  } else {
    resolved = supported[supported.length - 1];
  }

  if (base === "gemini-3.1-pro" && resolved === "medium" && supported.includes("high")) {
    resolved = "high";
  } else if (base === "gpt-oss-120b" && supported.includes("medium")) {
    resolved = "medium";
  }

  return isSuffixedBase && resolved
    ? { model: `${base}-${resolved}` }
    : resolveArgs(base, resolved);
}

/** Map raw Antigravity CLI errors to user-actionable auth/runtime guidance. */
export function authHint(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes("authentication required") ||
    lower.includes("authentication failed") ||
    lower.includes("failed to authenticate") ||
    lower.includes("not signed in") ||
    lower.includes("not logged in") ||
    lower.includes("unauthenticated") ||
    lower.includes("no active account") ||
    lower.includes("credentials not found") ||
    lower.includes("invalid_grant") ||
    lower.includes("401") ||
    (lower.includes("login") &&
      (lower.includes("agy") || lower.includes("required") || lower.includes("failed")))
  ) {
    return "Antigravity is not signed in. Run `agy` once in Terminal to sign in.";
  }
  return raw;
}

export function agyError(opts: {
  stderr?: string;
  exitCode?: number | null;
  detail?: string;
}): string {
  const fromStdoutOrStderr = opts.detail?.trim() || extractAgyErrorLine(opts.stderr ?? "") || lastNonEmptyLines(opts.stderr ?? "");
  if (fromStdoutOrStderr) return authHint(fromStdoutOrStderr);
  if (opts.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0) {
    return "Antigravity stopped before finishing.";
  }
  return "Antigravity exited.";
}

function extractAgyErrorLine(tail: string): string | undefined {
  const prefix = "AGY_ERROR:";
  const lines = tail.split(/\r?\n/).reverse();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const payload = line.slice(prefix.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const shortError = typeof parsed.short_error === "string" ? parsed.short_error.trim() : "";
      if (!shortError) continue;
      const details: string[] = [];
      if (typeof parsed.status === "string" && parsed.status.trim()) details.push(`status: ${parsed.status.trim()}`);
      if (typeof parsed.reason === "string" && parsed.reason.trim()) details.push(`reason: ${parsed.reason.trim()}`);
      return details.length > 0 ? `${shortError} (${details.join(", ")})` : shortError;
    } catch {
      /* ignore malformed AGY_ERROR */
    }
  }
  return undefined;
}

function lastNonEmptyLines(text: string, limit = 6): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  return lines.slice(-limit).join("\n");
}

export function permissionDeniedMessage(
  toolName: string,
  runtimeMode: string,
): string {
  if (runtimeMode === "supervised") {
    return `Antigravity held back ${toolName} waiting for a permission it could not ask for. Use Full access for this chat.`;
  }
  return `Antigravity held back ${toolName} without prompting. Use Full access or add an allow rule in the CLI's settings.`;
}

/**
 * Antigravity transient vs permanent classification (P2-59).
 * Never layers app retries on top of `agy`'s own retries on 503/capacity/auth/quota;
 * returns true only for dropped connections, network timeouts, or startup timeouts
 * eligible for connection-drop auto-continue.
 */
export function isAntigravityTransientFailure(error: string): boolean {
  const text = error.toLowerCase();
  if (text.includes("print_timeout") || text.includes("print timeout")) {
    return false;
  }
  const permanentMarkers = [
    "503",
    "service unavailable",
    "no capacity",
    "capacity exhausted",
    "model_capacity_exhausted",
    "resource_exhausted",
    "quota",
    "credits",
    "billing",
    "429",
    "rate limit",
    "rate-limit",
    "too many requests",
    "sign in",
    "sign-in",
    "log in",
    "log-in",
    "not signed in",
    "not logged into",
    "unauthenticated",
    "unauthorized",
    "invalid_grant",
    "auth",
    "401",
    "403",
    "400",
    "404",
    "unknown model",
    "model not found",
    "invalid model selection",
    "unknown flag",
    "not supported for model",
    "unsupported",
    "held back",
    "permission",
    "denied",
    "executable",
    "not configured",
    "process tree",
    "cancelled",
    "canceled",
    "aborted",
  ];
  if (
    permanentMarkers.some((m) => text.includes(m)) ||
    (text.includes('has no "') && text.includes("effort"))
  ) {
    return false;
  }

  const transientMarkers = [
    "unexpected eof",
    "tls handshake timeout",
    "no such host",
    "i/o timeout",
    "connection reset",
    "broken pipe",
    "network issue",
    "network is down",
    "stream idle timeout",
    "http2:",
    "timeout awaiting response headers",
    "502",
    "500 ",
    "internal",
    "deadline_exceeded",
    "the stream was interrupted",
    "timed out",
    "timeout",
    "did not finish starting in time",
    "did not answer",
    "connection dropped",
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "epipe",
    "socket",
    "stream closed",
    "stopped before finishing",
    "antigravity exited",
  ];
  return transientMarkers.some((m) => text.includes(m));
}

export function retryLabelKey(reason: string): string {
  const lowered = reason.toLowerCase();
  if (lowered.includes("stream idle timeout")) {
    return "no response for 5 minutes";
  }
  if (lowered.endsWith(": eof") || lowered.includes("unexpected eof")) {
    return "connection dropped";
  }
  if (lowered.includes("no such host") || lowered.includes("i/o timeout")) {
    return "network/DNS error";
  }
  if (lowered.includes("429") || lowered.includes("resource_exhausted")) {
    return "rate limited";
  }
  if (lowered.includes("503") || lowered.includes("capacity")) {
    return "server busy";
  }
  return "request failed";
}

/**
 * Parse one line from `agy --log-file` into a retry notification if matched.
 * Matches both `run.go:... Run: attempt N failed (request failed: ...), retrying in ...`
 * (upstream `AntigravitySession.swift`) and exponential-backoff diagnostic lines.
 */
export function parseAntigravityRetryLine(
  line: string,
): { attempt: number; reason?: string; labelKey: string; notice: string } | null {
  const goMatch = /run\.go:\d+\]\s*Run:\s*attempt\s+(\d+)\s+failed\s+\(request failed:\s+(.+?)\),\s*retrying in\s+([0-9.]+)(ms|s|m)/.exec(line);
  if (goMatch) {
    const attempt = Number(goMatch[1]) + 1;
    const reason = goMatch[2]!.trim();
    const labelKey = retryLabelKey(reason);
    return {
      attempt,
      reason: `request failed: ${reason}`,
      labelKey,
      notice: `Antigravity: the model request failed (${labelKey}); agy is retrying, attempt ${attempt}.`,
    };
  }
  if (/retrying with exponential backoff/i.test(line)) {
    const attemptMatch = /\battempt\s+(\d+)/i.exec(line);
    const attempt = attemptMatch ? Number(attemptMatch[1]) : 2;
    const statusMatch =
      /\b(?:status|code|http)\s*[:=]?\s*(\d{3})\b/i.exec(line) ??
      /\b(503|502|500|504|429|408)\b/.exec(line);
    const reason = statusMatch ? statusMatch[1]! : "transient error";
    const labelKey = retryLabelKey(reason);
    return {
      attempt,
      reason,
      labelKey,
      notice: `Antigravity: the model request failed (${labelKey}); agy is retrying, attempt ${attempt}.`,
    };
  }
  return null;
}

export interface AntigravityTurnOutcomeInput {
  interruptRequested: boolean;
  status?: string | undefined;
  finishedReason?: string | undefined;
  hasDeniedActions: boolean;
  hasReply: boolean;
  completedResponseIndex: number | null;
  latestCascadeErrorIndex: number | null;
  cascadeErrorMessages: ReadonlySet<string>;
  knownConversationErrors: ReadonlySet<string>;
  hasCompletedToolWork?: boolean;
  replyOnlyInResult?: boolean;
  resultError?: string | undefined;
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  stderr?: string | undefined;
}

export type AntigravityTurnOutcome =
  | { status: "done"; recovered: boolean }
  | { status: "interrupted"; recovered: false }
  | { status: "error"; message: string; recovered: false };

function matchesKnownError(resultError: string, knownErrors: ReadonlySet<string>): boolean {
  if (knownErrors.has(resultError)) return true;
  for (const known of knownErrors) {
    if (!known) continue;
    if (resultError.includes(known)) return true;
    if (known.endsWith("…") && known.length > 1 && resultError.startsWith(known.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

/**
 * Per-turn error judging matching upstream `AntigravitySession.turnOutcome` (P2-35, P2-59):
 *  - `agy`'s result status/error are conversation-sticky: an earlier error step is repeated
 *    on later results with `finished_reason: "error"`.
 *  - When this turn had a cascade error step, recovery requires a completed `agent_response`
 *    after it with new reply text and no denied actions.
 *  - Without a cascade error this turn, a reply (streamed or in `result.response`) with no
 *    denied actions succeeds when `result.error` matches an error seen in an earlier turn.
 */
export function antigravityTurnOutcome(
  input: AntigravityTurnOutcomeInput,
): AntigravityTurnOutcome {
  if (input.interruptRequested) {
    return { status: "interrupted", recovered: false };
  }
  const rawReason = input.finishedReason?.trim();
  const finishedReason = rawReason && rawReason.length > 0 ? rawReason : undefined;
  if (finishedReason === "interrupted") {
    return { status: "interrupted", recovered: false };
  }
  if (finishedReason && !(finishedReason === "error" && input.status === "ERROR")) {
    return {
      status: "error",
      message: authHint(input.resultError?.trim() || "Antigravity stopped before finishing."),
      recovered: false,
    };
  }

  switch (input.status) {
    case "SUCCESS":
      return { status: "done", recovered: false };
    case "CANCELED":
    case "INTERRUPTED":
      return { status: "interrupted", recovered: false };
    case "WAITING":
      return input.hasDeniedActions
        ? { status: "error", message: "Antigravity held back actions waiting for permission.", recovered: false }
        : { status: "done", recovered: false };
    default: {
      if (!input.hasReply || input.hasDeniedActions) {
        const msg = input.resultError?.trim();
        return {
          status: "error",
          message: msg
            ? authHint(msg)
            : agyError({
                ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
                ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
              }),
          recovered: false,
        };
      }
      const resultErr = input.resultError?.trim() ?? "";
      if (input.latestCascadeErrorIndex !== null) {
        const okAfter =
          input.completedResponseIndex !== null &&
          input.completedResponseIndex > input.latestCascadeErrorIndex &&
          (resultErr === "" || matchesKnownError(resultErr, input.cascadeErrorMessages));
        if (!okAfter) {
          return {
            status: "error",
            message: authHint(resultErr || "Antigravity stopped before finishing."),
            recovered: false,
          };
        }
      } else if (resultErr === "") {
        if (input.completedResponseIndex === null) {
          return {
            status: "error",
            message: "Antigravity stopped before finishing.",
            recovered: false,
          };
        }
      } else {
        const isStale =
          matchesKnownError(resultErr, input.knownConversationErrors) &&
          (input.completedResponseIndex !== null || input.replyOnlyInResult === true);
        if (!isStale) {
          return {
            status: "error",
            message: authHint(resultErr),
            recovered: false,
          };
        }
      }
      return { status: "done", recovered: true };
    }
  }
}

export function isToolDenialOutput(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("permission check failed") ||
    lowered.includes("denied permission") ||
    lowered.includes("permission denied") ||
    lowered.includes("requires approval") ||
    lowered.includes("waiting for permission") ||
    lowered.includes("action denied")
  );
}

function classifyToolKind(name: string): ToolActivity["kind"] {
  switch (name) {
    case "run_command":
    case "send_command_input":
    case "command_status":
    case "wait":
    case "wait_5_seconds":
    case "schedule":
      return "command";
    case "view_file":
    case "view_file_outline":
    case "view_code_item":
    case "view_content_chunk":
    case "read_resource":
    case "read_browser_page":
    case "capture_browser_screenshot":
    case "capture_browser_console_logs":
      return "read";
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
    case "notebook_execution":
      return "edit";
    case "list_dir":
    case "grep_search":
    case "find_by_name":
    case "list_resources":
    case "list_browser_pages":
      return "search";
    case "search_web":
    case "read_url_content":
    case "open_browser_url":
    case "browser_click_element":
    case "browser_drag_pixel_to_pixel":
    case "browser_get_dom":
    case "browser_get_network_request":
    case "browser_input":
    case "browser_list_network_requests":
    case "browser_mouse_down":
    case "browser_mouse_up":
    case "browser_move_mouse":
    case "browser_press_key":
    case "browser_refresh_page":
    case "browser_resize_window":
    case "browser_scroll":
    case "browser_scroll_dom":
    case "browser_select_option":
    case "click_browser_pixel":
    case "execute_browser_javascript":
      return "web";
    case "invoke_subagent":
    case "browser_subagent":
    case "define_subagent":
    case "manage_subagents":
      return "agent";
    case "call_mcp_tool":
      return "mcp";
    default: {
      const n = name.toLowerCase();
      if (n.includes("read") || n.includes("view") || n.includes("list_dir")) return "read";
      if (n.includes("write") || n.includes("edit") || n.includes("replace") || n.includes("patch"))
        return "edit";
      if (n.includes("search") || n.includes("grep") || n.includes("find")) return "search";
      if (n.includes("command") || n.includes("bash") || n.includes("run_")) return "command";
      if (n.includes("web") || n.includes("url") || n.includes("browser")) return "web";
      if (n.includes("agent") || n.includes("task")) return "agent";
      return "other";
    }
  }
}

function strInParams(params: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function extractToolPath(params: Record<string, unknown>): string | undefined {
  return strInParams(params, [
    "AbsolutePath",
    "TargetFile",
    "NotebookPath",
    "FilePath",
    "File",
    "file",
    "path",
    "Path",
    "file_path",
    "target_file",
    "DirectoryPath",
    "directory",
    "dir",
  ]);
}

function humanizeToolName(name: string): string {
  const words = name.split("_").filter(Boolean);
  if (words.length === 0) return name;
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(" ");
}

function makeToolActivityBase(
  itemId: string,
  name: string,
  params: Record<string, unknown>,
  cwd: string,
): ToolActivity {
  const kind = classifyToolKind(name);
  const rawPath = extractToolPath(params);
  const relPath =
    rawPath && isAbsolute(rawPath) && !isUnsafeRemotePath(rawPath)
      ? relative(cwd, rawPath).replace(/\\/g, "/") || basename(rawPath)
      : rawPath;
  switch (kind) {
    case "command": {
      const cmd = strInParams(params, ["CommandLine", "command", "Command"]);
      return { itemId, kind, title: cmd ? cmd.slice(0, 120) : humanizeToolName(name), status: "started" };
    }
    case "read": {
      const title = relPath ?? strInParams(params, ["Url", "URL", "url"]) ?? humanizeToolName(name);
      const start = typeof params.StartLine === "number" ? params.StartLine : undefined;
      const end = typeof params.EndLine === "number" ? params.EndLine : undefined;
      const detail = start !== undefined ? (end !== undefined && end > start ? `L${start}–${end}` : `L${start}`) : undefined;
      return { itemId, kind, title, ...(detail ? { detail } : {}), status: "started" };
    }
    case "edit":
      return { itemId, kind, title: relPath ?? humanizeToolName(name), status: "started" };
    case "search": {
      const pattern = strInParams(params, ["Query", "query", "Pattern", "pattern"]);
      const folder = strInParams(params, ["SearchPath", "SearchDirectory", "DirectoryPath", "Path", "path"]);
      if (pattern) {
        return { itemId, kind, title: pattern, ...(folder ? { detail: folder } : {}), status: "started" };
      }
      return { itemId, kind, title: folder ?? humanizeToolName(name), status: "started" };
    }
    case "web": {
      const subject = strInParams(params, ["Url", "URL", "url", "query", "Query"]);
      return { itemId, kind, title: subject ?? humanizeToolName(name), status: "started" };
    }
    case "agent": {
      const task = strInParams(params, ["Task", "task", "Prompt", "prompt", "Description", "description"]);
      return { itemId, kind, title: task ? task.slice(0, 96) : humanizeToolName(name), status: "started" };
    }
    case "mcp": {
      const server = strInParams(params, ["ServerName", "server_name", "Server", "server"]) ?? "MCP";
      const tool = strInParams(params, ["ToolName", "tool_name", "Tool", "tool"]) ?? "tool";
      return { itemId, kind, title: `${server} · ${tool}`, status: "started" };
    }
    default:
      return { itemId, kind: "other", title: humanizeToolName(name), status: "started" };
  }
}

function extractStepErrorMessage(step: Record<string, unknown>): string | undefined {
  const errField = step.error;
  const errObjMsg =
    errField && typeof errField === "object" && typeof (errField as Record<string, unknown>).message === "string"
      ? String((errField as Record<string, unknown>).message)
      : undefined;
  const errStr = typeof errField === "string" ? errField : undefined;
  const errMessage = typeof step.error_message === "string" ? step.error_message : undefined;
  const candidates: (string | undefined)[] = [errObjMsg, errStr, errMessage];

  const stepType = typeof step.step_type === "string" ? step.step_type.toLowerCase() : "";
  const state = typeof step.state === "string" ? step.state : "";
  if (stepType.includes("error") || state === "ERROR") {
    candidates.push(
      typeof step.text === "string" ? step.text : undefined,
      typeof step.message === "string" ? step.message : undefined,
      typeof step.text_delta === "string" ? step.text_delta : undefined,
    );
  }
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (trimmed) {
      return trimmed.length > 500 ? `${trimmed.slice(0, 499)}…` : trimmed;
    }
  }
  return undefined;
}

/**
 * Pure one-shot stream-json parser matching `AntigravitySession.oneShotReply` (P1-38/P2-35).
 */
export function oneShotReplyFromStream(
  output: string,
): { reply: string | null; result: Record<string, unknown> | null } {
  let reply = "";
  let replyIndex: number | null = null;
  let replyAfterError = false;
  let completedIndex: number | null = null;
  let latestError: { index: number; message: string } | null = null;
  const errorMessages = new Set<string>();
  let completedToolWork = false;
  let result: Record<string, unknown> | null = null;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      message = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (message.event === "result") {
      if (message.result && typeof message.result === "object") {
        result = message.result as Record<string, unknown>;
      }
      break;
    }
    if (message.event !== "step_update" || !message.step_update || typeof message.step_update !== "object") {
      continue;
    }
    const step = message.step_update as Record<string, unknown>;
    const index = typeof step.step_index === "number" ? step.step_index : 0;
    const stepType = typeof step.step_type === "string" ? step.step_type : "";
    const state = typeof step.state === "string" ? step.state : "";

    if (stepType === "agent_response") {
      if (state === "ERROR") {
        const err = extractStepErrorMessage(step);
        if (err) {
          latestError = { index, message: err };
          errorMessages.add(err);
          completedIndex = null;
          replyAfterError = false;
          reply = "";
          continue;
        }
      }
      if (state === "DONE") completedIndex = index;
      const text = typeof step.text_delta === "string" ? step.text_delta : "";
      if (!text) continue;
      if (replyIndex === index) reply += text;
      else {
        reply = text;
        replyIndex = index;
      }
      if (text.trim().length > 0) replyAfterError = true;
    } else if (stepType === "tool") {
      completedIndex = null;
      const info = step.tool_info as Record<string, unknown> | undefined;
      if (state === "DONE" && !info?.error) completedToolWork = true;
    } else {
      const err = extractStepErrorMessage(step);
      if (err) {
        latestError = { index, message: err };
        errorMessages.add(err);
        completedIndex = null;
        replyAfterError = false;
        reply = "";
      }
    }
  }

  if (!result) return { reply: null, result: null };
  const response = typeof result.response === "string" && result.response.trim() ? result.response.trim() : null;
  const streamed = reply.trim() ? reply.trim() : null;
  const denied = Array.isArray(result.denied_actions) && result.denied_actions.length > 0;
  const outcome = antigravityTurnOutcome({
    interruptRequested: false,
    status: typeof result.status === "string" ? result.status : undefined,
    finishedReason: typeof result.finished_reason === "string" ? result.finished_reason : undefined,
    hasDeniedActions: denied,
    hasReply: latestError === null ? streamed !== null || response !== null : replyAfterError,
    completedResponseIndex: completedIndex,
    latestCascadeErrorIndex: latestError?.index ?? null,
    cascadeErrorMessages: errorMessages,
    knownConversationErrors: new Set<string>(),
    hasCompletedToolWork: completedToolWork,
    replyOnlyInResult: streamed === null && response !== null,
    resultError: typeof result.error === "string" ? result.error : undefined,
  });
  if (outcome.status !== "done") return { reply: null, result };
  const text = result.status === "SUCCESS" ? (response ?? streamed) : (streamed ?? response);
  return { reply: text, result };
}

/**
 * Tolerant NDJSON codec for Antigravity `stream-json` stdout lines:
 * ignores empty lines and non-JSON startup chatter while strictly framing
 * UTF-8 LF lines inside the byte budget.
 */
export class AntigravityNdjsonCodec implements WireCodec<Record<string, unknown>> {
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private finished = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(private readonly maxFrameBytes: number) {}

  get pendingBytes(): number {
    return this.buffered;
  }

  feed(chunk: Uint8Array): Record<string, unknown>[] {
    this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.buffered += chunk.byteLength;
    const out: Record<string, unknown>[] = [];
    for (;;) {
      const nl = this.findLf();
      if (nl < 0) {
        if (this.buffered > this.maxFrameBytes) {
          throw new ProtocolError(
            `antigravity frame exceeded ${this.maxFrameBytes} bytes`,
            "FRAME_TOO_LARGE",
          );
        }
        break;
      }
      const lineBuf = this.take(nl);
      if (lineBuf.byteLength > this.maxFrameBytes) {
        throw new ProtocolError(
          `antigravity frame exceeded ${this.maxFrameBytes} bytes`,
          "FRAME_TOO_LARGE",
        );
      }
      const raw = this.decoder.decode(lineBuf).trim();
      if (!raw) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Non-JSON diagnostic line emitted on stdout — ignored cleanly.
      }
    }
    return out;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.chunks.length = 0;
    this.buffered = 0;
  }

  encode(frame: Record<string, unknown>, maxFrameBytes: number): Buffer {
    return encodeJsonLine(frame, maxFrameBytes);
  }

  private findLf(): number {
    let seen = 0;
    for (const c of this.chunks) {
      const idx = c.indexOf(0x0a);
      if (idx >= 0) return seen + idx;
      seen += c.byteLength;
    }
    return -1;
  }

  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let rem = n;
    while (rem > 0) {
      const head = this.chunks[0]!;
      if (head.byteLength <= rem) {
        parts.push(head);
        this.chunks.shift();
        rem -= head.byteLength;
      } else {
        parts.push(head.subarray(0, rem));
        this.chunks[0] = head.subarray(rem);
        rem = 0;
      }
    }
    while (this.chunks.length > 0 && this.chunks[0]!.byteLength === 0) this.chunks.shift();
    if (this.chunks.length > 0) {
      if (this.chunks[0]!.byteLength === 1) this.chunks.shift();
      else this.chunks[0] = this.chunks[0]!.subarray(1);
    }
    this.buffered -= n + 1;
    const joined = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    if (joined.byteLength > 0 && joined[joined.byteLength - 1] === 0x0d) {
      return joined.subarray(0, joined.byteLength - 1);
    }
    return joined;
  }
}

/** Polls `--log-file` strictly while a turn is active, skipping pre-turn bytes. */
class AntigravityLogTailer {
  private timer: NodeJS.Timeout | null = null;
  private offset = 0;
  private partial = "";
  private active = false;
  private seenAttempts = new Set<number>();
  private seenNotices = new Set<string>();

  constructor(
    private readonly logPath: string,
    private readonly onRetry: (parsed: { attempt: number; reason?: string; notice: string }) => void,
    private readonly pollMs = 400,
  ) {}

  startTurn(): void {
    this.seenAttempts.clear();
    this.seenNotices.clear();
    this.partial = "";
    try {
      this.offset = !isUnsafeRemotePath(this.logPath) && existsSync(this.logPath) ? statSync(this.logPath).size : 0;
    } catch {
      this.offset = 0;
    }
    this.active = true;
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  stopTurn(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll(): void {
    if (!this.active || isUnsafeRemotePath(this.logPath)) return;
    let fd: number | null = null;
    try {
      const st = statSync(this.logPath);
      if (st.size < this.offset) this.offset = 0;
      if (st.size <= this.offset) return;
      const toRead = Math.min(st.size - this.offset, 256 * 1024);
      const buf = Buffer.allocUnsafe(toRead);
      fd = openSync(this.logPath, "r");
      const n = readSync(fd, buf, 0, toRead, this.offset);
      this.offset += n;
      const chunk = this.partial + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseAntigravityRetryLine(line);
        if (parsed && !this.seenAttempts.has(parsed.attempt) && !this.seenNotices.has(parsed.notice)) {
          this.seenAttempts.add(parsed.attempt);
          this.seenNotices.add(parsed.notice);
          this.onRetry(parsed);
        }
      }
    } catch {
      /* log file may not exist yet or rotated cleanly */
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

interface SessionSignature {
  cwd: string;
  runtimeMode: string;
  interactionMode: string;
  model?: string;
  effort?: string;
}

function sameSignature(a: SessionSignature, b: SessionSignature): boolean {
  return (
    a.cwd === b.cwd &&
    a.runtimeMode === b.runtimeMode &&
    a.interactionMode === b.interactionMode &&
    a.model === b.model &&
    a.effort === b.effort
  );
}

interface ThreadSession {
  threadId: string;
  sessionId?: string;
  launchId: string;
  logFile: string;
  signature: SessionSignature;
  transport: StdioTransport<Record<string, unknown>> | null;
  knownErrors: Set<string>;
  lastOutputAt: number;
  activeTurn: ActiveTurnState | null;
}

interface ActiveTurnState {
  turnId: string;
  launchId: string;
  cwd: string;
  seq: number;
  assistantText: string;
  streamedText: boolean;
  hadToolWork: boolean;
  latestCascadeError: { index: number; message: string } | null;
  cascadeErrorMessages: Set<string>;
  completedAgentResponseIndex: number | null;
  replyAfterCascadeError: boolean;
  priorErrorsSnapshot: Set<string>;
  reportedErrors: Set<string>;
  resultStatus?: string;
  resultFinishedReason?: string;
  resultError?: string;
  resultText?: string;
  hasDeniedActions: boolean;
  deniedNames: string[];
  hasReply: boolean;
  replyOnlyInResult: boolean;
  editBaselines: Map<string, string | null>;
  editPaths: Map<string, string>;
  touchedPaths: Set<string>;
  toolStates: Map<string, ToolActivity>;
  cancelled: boolean;
  settled: boolean;
  settle: (exitInfo?: { code: number | null; signal: string | null }) => void;
  initReceived: boolean;
  startTimer: NodeJS.Timeout | null;
  tailer: AntigravityLogTailer;
  callbacks: ProviderCallbacks;
  runtimeMode: string;
}

export interface AntigravityProviderDeps {
  config: AntigravityRuntimeConfig;
  lookupBinding?: (threadId: string) => ProviderThreadBinding | undefined;
  bindThread?: (threadId: string, binding: ProviderThreadBinding) => Promise<void>;
  onThreadNotice?: (threadId: string, text: string, level: "info" | "warning" | "error") => void;
  startTimeoutMs?: number;
  reviewTimeoutMs?: number;
  logPollMs?: number;
  spawnImpl?: SpawnImpl;
  runCommandOverride?: (
    exe: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export class AntigravityProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  private readonly sessions = new Map<string, ThreadSession>();
  private readonly settingsSupportCache = new Map<string, boolean>();
  private cachedCatalog: CodexModelOption[] | null = null;
  private readonly suffixedIds = new Map<string, Set<string>>();
  private disposed = false;

  constructor(private readonly deps: AntigravityProviderDeps) {
    this.descriptor = {
      id: ANTIGRAVITY_PROVIDER_ID,
      label: "Antigravity",
      mode: "antigravity",
      synthetic: deps.config.mode === "fixture",
      ...(deps.config.mode === "fixture" && deps.config.fixtureScript
        ? { runtimeInfo: { executable: deps.config.fixtureScript, version: ANTIGRAVITY_PROTOCOL_PIN } }
        : deps.config.executable
          ? { runtimeInfo: { executable: deps.config.executable, version: ANTIGRAVITY_PROTOCOL_PIN } }
          : {}),
    };
  }

  /** Last timestamp (ms) any frame or output was observed for a thread session. */
  lastOutputAt(threadId: string): number | undefined {
    return this.sessions.get(threadId)?.lastOutputAt;
  }

  private get startTimeoutMs(): number {
    return this.deps.startTimeoutMs ?? ANTIGRAVITY_DEFAULT_START_TIMEOUT_MS;
  }

  private get reviewTimeoutMs(): number {
    return this.deps.reviewTimeoutMs ?? ANTIGRAVITY_DEFAULT_REVIEW_TIMEOUT_MS;
  }

  private transportLimits(): TransportLimits {
    return {
      ...DEFAULT_TRANSPORT_LIMITS,
      frameBytes: 4 * 1024 * 1024,
      stdoutTotalBytes: 32 * 1024 * 1024,
      stderrTotalBytes: 2 * 1024 * 1024,
      stdinWriteMs: 15_000,
    };
  }

  private effectiveSpawn(): SpawnImpl {
    if (this.deps.spawnImpl) return this.deps.spawnImpl;
    if (this.deps.config.mode === "real") {
      const cap = this.deps.config.treeCapability;
      if (!cap.supported || !cap.helperPath) {
        throw new AntigravityConfigError(PROCESS_TREE_UNSUPPORTED, cap.reason ?? "process-tree capability unsupported");
      }
      return makeJobHelperSpawnImpl(cap.helperPath);
    }
    return (spec) =>
      spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
      });
  }

  private resolveTarget(): { exe: string; baseArgs: string[] } {
    if (this.deps.config.mode === "fixture") {
      if (!this.deps.config.fixtureNode || !this.deps.config.fixtureScript) {
        throw new AntigravityConfigError(
          "ANTIGRAVITY_FIXTURE_INVALID",
          "Antigravity fixture paths are missing",
        );
      }
      return {
        exe: this.deps.config.fixtureNode,
        baseArgs: [this.deps.config.fixtureScript],
      };
    }
    if (this.deps.config.mode === "real" && this.deps.config.executable) {
      if (!this.deps.config.treeCapability.supported) {
        throw new AntigravityConfigError(
          PROCESS_TREE_UNSUPPORTED,
          this.deps.config.treeCapability.reason ?? "process-tree capability unsupported",
        );
      }
      return {
        exe: this.deps.config.executable,
        baseArgs: [],
      };
    }
    throw new AntigravityConfigError(
      "ANTIGRAVITY_NOT_CONFIGURED",
      this.deps.config.realUnavailableReason ??
        "Antigravity is not configured — install `agy` or select its executable in Settings",
    );
  }

  private async runBoundedCli(
    args: string[],
    opts: { cwd: string; timeoutMs: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { exe, baseArgs } = this.resolveTarget();
    const fullArgs = [...baseArgs, ...args];
    if (this.deps.runCommandOverride) {
      return this.deps.runCommandOverride(exe, fullArgs, {
        cwd: opts.cwd,
        env: this.deps.config.env,
        timeoutMs: opts.timeoutMs,
      });
    }
    return await new Promise((resolve, reject) => {
      const impl = this.effectiveSpawn();
      const child: ChildProcess = impl({
        executable: exe,
        args: fullArgs,
        cwd: opts.cwd,
        env: this.deps.config.env,
      });
      child.stdin?.end();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error(`Antigravity CLI timed out after ${opts.timeoutMs} ms`));
      }, opts.timeoutMs);
      child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
      child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
  }

  /** Probe `agy --help` for `--settings`; cached per exe path+size+mtime; defaults true on error. */
  async supportsSettingsFlag(): Promise<boolean> {
    if (this.deps.config.mode === "unconfigured") return true;
    const keyTarget =
      this.deps.config.mode === "fixture"
        ? this.deps.config.fixtureScript ?? "fixture"
        : this.deps.config.executable ?? "real";
    let cacheKey = keyTarget;
    try {
      if (!isUnsafeRemotePath(keyTarget)) {
        const st = statSync(keyTarget);
        cacheKey = `${keyTarget}:${st.size}:${st.mtimeMs}`;
      }
    } catch {
      /* fallback key */
    }
    const hit = this.settingsSupportCache.get(cacheKey);
    if (hit !== undefined) return hit;

    let supported = true;
    try {
      const res = await this.runBoundedCli(["--help"], {
        cwd: this.deps.config.logDir,
        timeoutMs: 5_000,
      });
      const text = `${res.stdout}\n${res.stderr}`;
      if (res.code === 0 && text.trim().length > 0) {
        supported = text.includes("--settings");
      }
    } catch {
      supported = true;
    }
    this.settingsSupportCache.set(cacheKey, supported);
    return supported;
  }

  async modelCatalog(): Promise<CodexModelOption[] | null> {
    if (this.deps.config.mode === "unconfigured") {
      throw new Error(
        this.deps.config.realUnavailableReason ??
          "Antigravity is not configured — install `agy` or set it in Settings",
      );
    }
    const res = await this.runBoundedCli(["models"], {
      cwd: this.deps.config.logDir,
      timeoutMs: 30_000,
    });
    if (res.code !== 0) {
      const msg = res.stderr.trim() || res.stdout.trim() || "`agy models` failed.";
      throw new Error(authHint(msg));
    }
    if (!res.stdout.trim()) {
      throw new Error("`agy models` produced no output.");
    }
    const parsed = parseModelsOutput(res.stdout);
    this.cachedCatalog = parsed.models;
    this.suffixedIds.clear();
    for (const [k, v] of parsed.suffixedIds) this.suffixedIds.set(k, v);
    return parsed.models;
  }

  private buildStreamArgs(opts: {
    logFile: string;
    sessionId?: string;
    runtimeMode: string;
    interactionMode: string;
    model?: string;
    effort?: string;
    supportsSettings: boolean;
    addDirs: string[];
  }): string[] {
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "0",
      "--log-file",
      opts.logFile,
    ];
    for (const dir of opts.addDirs) {
      args.push("--add-dir", dir);
    }
    const norm = normalizeModelAndEffort(
      opts.model,
      opts.effort,
      this.cachedCatalog ?? ANTIGRAVITY_SEED,
      this.suffixedIds,
    );
    if (norm.model) args.push("--model", norm.model);
    if (norm.effort) args.push("--effort", norm.effort);
    if (opts.interactionMode === "plan") {
      args.push("--mode", "plan");
    } else if (opts.runtimeMode === "supervised") {
      // P2-59: pin Default mode so Supervised does not inherit accept-edits.
      if (opts.supportsSettings) {
        args.push("--settings", '{"agentMode":""}');
      }
    } else {
      args.push("--mode", "accept-edits");
    }
    if (opts.interactionMode !== "plan" && opts.runtimeMode === "fullAccess") {
      args.push("--dangerously-skip-permissions");
    }
    if (opts.sessionId) {
      args.push("--conversation", opts.sessionId);
    }
    // P2-35: connected MCP servers NEVER reach agy and none is written for it.
    return args;
  }

  start(context: TurnContext, callbacks: ProviderCallbacks): ProviderTurnHandle {
    let cancelled = false;
    let activeTurnRef: ActiveTurnState | null = null;
    const threadId = context.threadId;

    void (async () => {
      try {
        if (this.disposed || cancelled) return;
        this.resolveTarget();
        const supportsSettings = await this.supportsSettingsFlag();
        if (this.disposed || cancelled) return;

        const cwd = context.workspace?.directory ?? process.cwd();
        const runtimeMode = context.runtimeMode ?? "supervised";
        const interactionMode = context.interactionMode ?? "build";
        const norm = normalizeModelAndEffort(
          context.model,
          context.effort,
          this.cachedCatalog ?? ANTIGRAVITY_SEED,
          this.suffixedIds,
        );
        const sig: SessionSignature = {
          cwd,
          runtimeMode,
          interactionMode,
          ...(norm.model ? { model: norm.model } : {}),
          ...(norm.effort ? { effort: norm.effort } : {}),
        };

        let session = this.sessions.get(threadId);
        if (session && (!session.transport || !sameSignature(session.signature, sig))) {
          await this.teardownSessionTransport(session);
        }

        if (!session) {
          const existingBinding = this.deps.lookupBinding?.(threadId);
          session = {
            threadId,
            ...(existingBinding?.codexThreadId ? { sessionId: existingBinding.codexThreadId } : {}),
            launchId: randomUUID().slice(0, 8),
            logFile: join(this.deps.config.logDir, `${threadId}.log`),
            signature: sig,
            transport: null,
            knownErrors: new Set<string>(),
            lastOutputAt: Date.now(),
            activeTurn: null,
          };
          this.sessions.set(threadId, session);
        } else {
          session.signature = sig;
          if (!session.transport) {
            session.launchId = randomUUID().slice(0, 8);
          }
        }

        const tailer = new AntigravityLogTailer(
          session.logFile,
          (parsed) => {
            if (parsed.reason) session!.knownErrors.add(parsed.reason.trim());
            callbacks.onNotice?.(parsed.notice, "info");
          },
          this.deps.logPollMs ?? 400,
        );
        const turn: ActiveTurnState = {
          turnId: context.turnId,
          launchId: session.launchId,
          cwd,
          seq: 1,
          assistantText: "",
          streamedText: false,
          hadToolWork: false,
          latestCascadeError: null,
          cascadeErrorMessages: new Set<string>(),
          completedAgentResponseIndex: null,
          replyAfterCascadeError: false,
          priorErrorsSnapshot: new Set<string>(session.knownErrors),
          reportedErrors: new Set<string>(),
          hasDeniedActions: false,
          deniedNames: [],
          hasReply: false,
          replyOnlyInResult: false,
          editBaselines: new Map(),
          editPaths: new Map(),
          touchedPaths: new Set(),
          toolStates: new Map(),
          cancelled: false,
          settled: false,
          settle: () => {},
          initReceived: !!session.transport,
          startTimer: null,
          tailer,
          callbacks,
          runtimeMode,
        };
        activeTurnRef = turn;
        session.activeTurn = turn;
        tailer.startTurn();

        const settleTurn = (exitInfo?: { code: number | null; signal: string | null }) => {
          if (turn.settled) return;
          turn.settled = true;
          if (turn.startTimer) {
            clearTimeout(turn.startTimer);
            turn.startTimer = null;
          }
          turn.tailer.poll();
          turn.tailer.stopTurn();
          if (session!.activeTurn === turn) session!.activeTurn = null;

          if (turn.touchedPaths.size > 0) {
            callbacks.onFileChanges?.(Array.from(turn.touchedPaths));
          }

          if (
            !turn.initReceived &&
            !turn.cancelled &&
            !turn.streamedText &&
            !turn.resultText &&
            !turn.hadToolWork
          ) {
            const fallbackErr = turn.resultError ?? turn.latestCascadeError?.message;
            const detail =
              exitInfo !== undefined
                ? agyError({
                    ...(session!.transport ? { stderr: session!.transport.stderrTail() } : {}),
                    exitCode: exitInfo.code,
                    ...(fallbackErr ? { detail: fallbackErr } : {}),
                  })
                : fallbackErr ?? "Antigravity did not finish starting in time.";
            callbacks.onError(authHint(detail));
            return;
          }

          const outcome = antigravityTurnOutcome({
            interruptRequested: turn.cancelled,
            status: turn.resultStatus,
            finishedReason: turn.resultFinishedReason,
            hasDeniedActions: turn.hasDeniedActions,
            hasReply: turn.hasReply,
            completedResponseIndex: turn.completedAgentResponseIndex,
            latestCascadeErrorIndex: turn.latestCascadeError?.index ?? null,
            cascadeErrorMessages: turn.cascadeErrorMessages,
            knownConversationErrors: turn.priorErrorsSnapshot,
            hasCompletedToolWork: turn.hadToolWork,
            replyOnlyInResult: turn.replyOnlyInResult,
            resultError: turn.resultError,
            ...(exitInfo ? { exitCode: exitInfo.code, signal: exitInfo.signal } : {}),
            ...(session!.transport ? { stderr: session!.transport.stderrTail() } : {}),
          });

          if (turn.resultError?.trim()) {
            session!.knownErrors.add(turn.resultError.trim());
          }
          for (const err of turn.cascadeErrorMessages) {
            session!.knownErrors.add(err.trim());
          }

          if (outcome.status === "interrupted") {
            callbacks.onInterrupted?.();
          } else if (outcome.status === "error") {
            if (turn.resultStatus === "WAITING" && turn.deniedNames.length > 0) {
              callbacks.onError(
                `Antigravity held back ${turn.deniedNames.join(", ")} waiting for a permission it could not ask for. Use Full access for this chat.`,
              );
            } else {
              callbacks.onError(outcome.message);
            }
          } else {
            if (
              outcome.recovered &&
              turn.latestCascadeError !== null &&
              turn.resultError?.trim() &&
              !turn.reportedErrors.has(`result|${turn.resultError.trim()}`)
            ) {
              turn.reportedErrors.add(`result|${turn.resultError.trim()}`);
              callbacks.onNotice?.(`Antigravity: ${turn.resultError.trim()}`, "warning");
            }
            callbacks.onDone();
          }
        };
        turn.settle = settleTurn;

        if (!session.transport) {
          const { exe, baseArgs } = this.resolveTarget();
          const cliArgs = this.buildStreamArgs({
            logFile: session.logFile,
            ...(session.sessionId ? { sessionId: session.sessionId } : {}),
            runtimeMode,
            interactionMode,
            ...(context.model ? { model: context.model } : {}),
            ...(context.effort ? { effort: context.effort } : {}),
            supportsSettings,
            addDirs: [cwd],
          });
          const limits = this.transportLimits();
          const transport = new StdioTransport<Record<string, unknown>>(
            {
              executable: exe,
              args: [...baseArgs, ...cliArgs],
              cwd,
              env: this.deps.config.env,
            },
            limits,
            {
              onFrame: (frame) => {
                session!.lastOutputAt = Date.now();
                const t = session!.activeTurn;
                if (!t || t.settled) return;
                this.handleFrame(session!, t, frame, () => t.settle());
              },
              onProtocolError: (err) => {
                const t = session!.activeTurn;
                if (t && !t.settled) {
                  t.resultError = err.message;
                  t.settle();
                }
                void this.teardownSessionTransport(session!);
              },
              onSpawnError: (err) => {
                const t = session!.activeTurn;
                if (t && !t.settled) {
                  t.resultError = err.message;
                  t.settle({ code: null, signal: null });
                }
                session!.transport = null;
              },
              onExit: () => {},
              onClose: (code, signal) => {
                session!.transport = null;
                const t = session!.activeTurn;
                if (t && !t.settled) {
                  t.settle({ code, signal });
                }
              },
            },
            this.effectiveSpawn(),
            new AntigravityNdjsonCodec(limits.frameBytes),
          );
          session.transport = transport;
          transport.start();
        }

        if (!turn.initReceived) {
          turn.startTimer = setTimeout(() => {
            if (turn.settled || turn.initReceived) return;
            turn.resultError =
              "Antigravity did not answer. Is `agy` signed in? Run `agy` once in Terminal.";
            settleTurn();
            void this.teardownSessionTransport(session!);
          }, this.startTimeoutMs);
          turn.startTimer.unref?.();
        }

        const sent = session.transport.send(
          {
            event: "user",
            message: {
              content: context.prompt,
            },
          },
          (err) => {
            if (err && !turn.settled) {
              turn.resultError = err.message;
              settleTurn();
            }
          },
        );
        if (!sent && !turn.settled) {
          turn.resultError = "Antigravity input stream could not accept prompt.";
          settleTurn();
        }
      } catch (err) {
        if (!cancelled) {
          callbacks.onError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return {
      cancel: () => {
        cancelled = true;
        if (activeTurnRef) {
          activeTurnRef.cancelled = true;
          if (activeTurnRef.startTimer) {
            clearTimeout(activeTurnRef.startTimer);
            activeTurnRef.startTimer = null;
          }
          activeTurnRef.tailer.stopTurn();
        }
        const sess = this.sessions.get(threadId);
        if (sess) {
          void this.teardownSessionTransport(sess);
        }
      },
      resume: () => {
        /* Antigravity stream-json handles permissions upfront via --mode / --settings */
      },
    };
  }

  private recordStepError(
    session: ThreadSession,
    turn: ActiveTurnState,
    step: Record<string, unknown>,
    index: number,
  ): boolean {
    const message = extractStepErrorMessage(step);
    if (!message) return false;
    turn.latestCascadeError = { index, message };
    turn.cascadeErrorMessages.add(message);
    session.knownErrors.add(message);
    turn.completedAgentResponseIndex = null;
    turn.replyAfterCascadeError = false;
    const key = `${index}|${message}`;
    if (!turn.reportedErrors.has(key)) {
      turn.reportedErrors.add(key);
      turn.callbacks.onNotice?.(`Antigravity: ${message}`, "warning");
    }
    return true;
  }

  private handleFrame(
    session: ThreadSession,
    turn: ActiveTurnState,
    frame: Record<string, unknown>,
    onResult: () => void,
  ): void {
    const event = typeof frame.event === "string" ? frame.event : "";
    if (!turn.initReceived && event === "init") {
      turn.initReceived = true;
      if (turn.startTimer) {
        clearTimeout(turn.startTimer);
        turn.startTimer = null;
      }
    }

    if (event === "init") {
      const cid = typeof frame.conversation_id === "string" ? frame.conversation_id.trim() : "";
      if (cid) {
        const prevCid = session.sessionId;
        session.sessionId = cid;
        if (cid !== prevCid) {
          void this.deps
            .bindThread?.(session.threadId, {
              providerId: "antigravity",
              codexThreadId: cid,
              cwd: session.signature.cwd,
              codexHomeId: "antigravity-host",
              schemaPin: ANTIGRAVITY_PROTOCOL_PIN,
              cliVersion: ANTIGRAVITY_PROTOCOL_PIN,
              savedAt: Date.now(),
            })
            .catch(() => {});
        }
        if (session.signature.model) {
          turn.callbacks.onModelReport?.(session.signature.model, session.signature.effort ?? null);
        }
      }
      return;
    }

    if (event === "step_update") {
      if (!turn.initReceived) {
        turn.initReceived = true;
        if (turn.startTimer) {
          clearTimeout(turn.startTimer);
          turn.startTimer = null;
        }
      }
      const step =
        frame.step_update && typeof frame.step_update === "object"
          ? (frame.step_update as Record<string, unknown>)
          : {};
      const index = typeof step.step_index === "number" ? step.step_index : 0;
      const stepType = typeof step.step_type === "string" ? step.step_type : "";
      const state = typeof step.state === "string" ? step.state : "";

      if (stepType === "agent_response") {
        const usage = step.usage as Record<string, unknown> | undefined;
        if (usage) {
          const used =
            (Number(usage.input_tokens ?? 0) || 0) +
            (Number(usage.cache_read_tokens ?? 0) || 0) +
            (Number(usage.output_tokens ?? 0) || 0);
          if (used > 0) turn.callbacks.onUsage?.({ usedTokens: used });
        }
        if (state === "ERROR" && this.recordStepError(session, turn, step, index)) {
          return;
        }
        if (state === "DONE") {
          turn.completedAgentResponseIndex = index;
        }
        const delta = typeof step.text_delta === "string" ? step.text_delta : "";
        if (delta.length > 0) {
          turn.streamedText = true;
          turn.assistantText += delta;
          if (delta.trim().length > 0) turn.replyAfterCascadeError = true;
          turn.callbacks.onChunk(turn.seq++, delta);
        }
        return;
      }

      if (stepType === "tool") {
        turn.completedAgentResponseIndex = null;
        const info =
          step.tool_info && typeof step.tool_info === "object"
            ? (step.tool_info as Record<string, unknown>)
            : {};
        const name =
          (typeof step.tool_name === "string" ? step.tool_name.trim() : "") ||
          (typeof info.name === "string" ? info.name.trim() : "");
        if (!name) return;

        const itemId = `agy-${turn.launchId}-tool-${index}`;
        const params =
          info.parameters && typeof info.parameters === "object"
            ? (info.parameters as Record<string, unknown>)
            : {};
        const errObj =
          info.error && typeof info.error === "object"
            ? (info.error as Record<string, unknown>)
            : undefined;
        const errMsg = typeof errObj?.message === "string" ? errObj.message : undefined;

        if (!turn.toolStates.has(itemId)) {
          const activity = makeToolActivityBase(itemId, name, params, turn.cwd);
          const rawPath = extractToolPath(params);
          if (activity.kind === "edit" && rawPath && !isUnsafeRemotePath(rawPath)) {
            const absPath = isAbsolute(rawPath) ? rawPath : join(turn.cwd, rawPath);
            if (!isUnsafeRemotePath(absPath)) {
              turn.editPaths.set(itemId, absPath);
              if (state === "ACTIVE" && !turn.editBaselines.has(absPath)) {
                try {
                  turn.editBaselines.set(absPath, readFileSync(absPath, "utf8"));
                } catch {
                  turn.editBaselines.set(absPath, null);
                }
              }
            }
          }
          turn.toolStates.set(itemId, activity);
          turn.callbacks.onToolActivity?.(activity);
          if (state === "ACTIVE") return;
        }

        const existing = turn.toolStates.get(itemId);
        if (!existing) return;

        if (state === "ERROR" || (state === "DONE" && errMsg !== undefined)) {
          const message = errMsg?.trim() || "The tool failed.";
          if (isToolDenialOutput(message)) {
            turn.hasDeniedActions = true;
            const deniedLabel = existing.title ?? "a tool call";
            if (!turn.deniedNames.includes(deniedLabel)) {
              turn.deniedNames.push(deniedLabel);
            }
          }
          const done: ToolActivity = {
            ...existing,
            status: "failed",
            detail: message.slice(0, 8192),
          };
          turn.toolStates.set(itemId, done);
          turn.callbacks.onToolActivity?.(done);
        } else if (state === "DONE") {
          turn.hadToolWork = true;
          const editAbs = turn.editPaths.get(itemId);
          if (existing.kind === "edit" && editAbs && !isUnsafeRemotePath(editAbs)) {
            const before = turn.editBaselines.get(editAbs);
            let after: string | null = null;
            try {
              after = readFileSync(editAbs, "utf8");
            } catch {
              after = null;
            }
            if (before !== after) {
              const rel = relative(turn.cwd, editAbs).replace(/\\/g, "/");
              if (rel && !rel.startsWith("../") && rel !== "..") {
                turn.touchedPaths.add(rel);
              }
            }
          }
          const output = typeof info.output === "string" && info.output.length > 0 ? info.output : undefined;
          const done: ToolActivity = {
            ...existing,
            status: "completed",
            ...(output ? { detail: output.slice(0, 8192) } : {}),
          };
          turn.toolStates.set(itemId, done);
          turn.callbacks.onToolActivity?.(done);
        }
        return;
      }

      if (stepType === "user_input" || stepType === "checkpoint") {
        return;
      }

      this.recordStepError(session, turn, step, index);
      return;
    }

    if (event === "result") {
      if (!turn.initReceived) {
        turn.initReceived = true;
        if (turn.startTimer) {
          clearTimeout(turn.startTimer);
          turn.startTimer = null;
        }
      }
      const result =
        frame.result && typeof frame.result === "object"
          ? (frame.result as Record<string, unknown>)
          : {};

      const usage = result.usage as Record<string, unknown> | undefined;
      if (usage) {
        const total =
          typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : (Number(usage.input_tokens ?? 0) || 0) + (Number(usage.output_tokens ?? 0) || 0);
        if (total > 0) {
          turn.callbacks.onUsage?.({ usedTokens: total, sessionTotalTokens: total });
        }
      }

      const response = typeof result.response === "string" ? result.response : undefined;
      const responseHasText = !!response && response.trim().length > 0;
      const hasReply = turn.streamedText || responseHasText;
      const replyOnlyInResult = !turn.streamedText && responseHasText;
      if (!turn.streamedText && responseHasText) {
        turn.resultText = response;
        turn.assistantText = response!;
        turn.callbacks.onChunk(turn.seq++, response!);
      }

      const rawDenied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
      const deniedNames = rawDenied
        .map((d) => {
          if (!d || typeof d !== "object") return undefined;
          const rec = d as Record<string, unknown>;
          return typeof rec.display_name === "string" && rec.display_name.trim()
            ? rec.display_name.trim()
            : typeof rec.action === "string" && rec.action.trim()
              ? rec.action.trim()
              : undefined;
        })
        .filter((x): x is string => x !== undefined);
      if (deniedNames.length > 0) {
        turn.hasDeniedActions = true;
        for (const n of deniedNames) {
          if (!turn.deniedNames.includes(n)) turn.deniedNames.push(n);
        }
        turn.callbacks.onNotice?.(
          `Antigravity held back ${deniedNames.join(", ")} without prompting. Use Full access or add an allow rule in the CLI's settings.`,
          "warning",
        );
      }

      const cid = typeof result.conversation_id === "string" ? result.conversation_id.trim() : "";
      if (cid) {
        const prevCid = session.sessionId;
        session.sessionId = cid;
        if (cid !== prevCid) {
          void this.deps
            .bindThread?.(session.threadId, {
              providerId: "antigravity",
              codexThreadId: cid,
              cwd: session.signature.cwd,
              codexHomeId: "antigravity-host",
              schemaPin: ANTIGRAVITY_PROTOCOL_PIN,
              cliVersion: ANTIGRAVITY_PROTOCOL_PIN,
              savedAt: Date.now(),
            })
            .catch(() => {});
        }
      }

      if (typeof result.status === "string") turn.resultStatus = result.status;
      if (typeof result.finished_reason === "string") turn.resultFinishedReason = result.finished_reason;
      if (typeof result.error === "string") turn.resultError = result.error;
      turn.hasReply = turn.latestCascadeError === null ? hasReply : turn.replyAfterCascadeError;
      turn.replyOnlyInResult = replyOnlyInResult;

      onResult();
    }
  }

  /**
   * P1-38/P2-35 Hydra independent review: one-shot `--mode plan` stream-json
   * call with one automatic retry after 3s ONLY for transient connection/process
   * failures (`isAntigravityTransientFailure`).
   */
  async generateHydraReview(
    prompt: string,
    opts: { cwd: string; readableDirs: string[]; model?: string; effort?: string },
  ): Promise<string | null> {
    if (this.deps.config.mode === "unconfigured") return null;
    try {
      return await this.oneShotReviewReply(prompt, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isAntigravityTransientFailure(msg)) throw err;
      await new Promise((r) => setTimeout(r, 3_000));
      return await this.oneShotReviewReply(prompt, opts);
    }
  }

  private async oneShotReviewReply(
    prompt: string,
    opts: { cwd: string; readableDirs: string[]; model?: string; effort?: string },
  ): Promise<string | null> {
    const { exe, baseArgs } = this.resolveTarget();
    const supportsSettings = await this.supportsSettingsFlag();
    const logFile = join(this.deps.config.logDir, `review-${randomUUID()}.log`);
    const dirs = opts.readableDirs.length > 0 ? opts.readableDirs : [opts.cwd];
    const cliArgs = this.buildStreamArgs({
      logFile,
      runtimeMode: "supervised",
      interactionMode: "plan",
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      supportsSettings,
      addDirs: dirs,
    });
    const limits = this.transportLimits();
    return await new Promise<string | null>((resolve, reject) => {
      const frames: Record<string, unknown>[] = [];
      let settled = false;

      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cb();
      };

      const resolveFromFrames = (exitCode?: number | null) => {
        const ndjson = frames.map((f) => JSON.stringify(f)).join("\n");
        const parsed = oneShotReplyFromStream(ndjson);
        if (parsed.reply !== null) {
          finish(() => resolve(parsed.reply));
          return;
        }
        const errText =
          typeof parsed.result?.error === "string" && parsed.result.error.trim()
            ? authHint(parsed.result.error.trim())
            : agyError({
                stderr: transport.stderrTail(),
                ...(exitCode !== undefined ? { exitCode } : {}),
              });
        finish(() => reject(new Error(errText)));
      };

      const transport = new StdioTransport<Record<string, unknown>>(
        {
          executable: exe,
          args: [...baseArgs, ...cliArgs],
          cwd: opts.cwd,
          env: this.deps.config.env,
        },
        limits,
        {
          onFrame: (frame) => {
            if (settled) return;
            frames.push(frame);
            if (frame.event === "result") {
              void transport.dispose().catch(() => {});
              resolveFromFrames();
            }
          },
          onProtocolError: (err) => finish(() => reject(err)),
          onSpawnError: (err) => finish(() => reject(err)),
          onExit: () => {},
          onClose: (code) => {
            if (!settled) resolveFromFrames(code);
          },
        },
        this.effectiveSpawn(),
        new AntigravityNdjsonCodec(limits.frameBytes),
      );

      const timer = setTimeout(() => {
        void transport.dispose().catch(() => {});
        finish(() => reject(new Error("Antigravity review timed out")));
      }, this.reviewTimeoutMs);
      timer.unref?.();

      transport.start();
      transport.send({
        event: "user",
        message: { content: prompt },
      });
    });
  }

  private async teardownSessionTransport(session: ThreadSession): Promise<ChildCleanupResult | null> {
    const t = session.transport;
    session.transport = null;
    if (!t) return null;
    try {
      return await t.dispose();
    } catch (err) {
      return {
        pid: undefined,
        confirmed: false,
        exitCode: null,
        signal: null,
        problem: err instanceof Error ? err.message : String(err),
      };
    }
  }

  endSession(localThreadId: string): void {
    const sess = this.sessions.get(localThreadId);
    if (!sess) return;
    this.sessions.delete(localThreadId);
    if (sess.activeTurn?.startTimer) clearTimeout(sess.activeTurn.startTimer);
    sess.activeTurn?.tailer.stopTurn();
    void this.teardownSessionTransport(sess);
  }

  async dispose(): Promise<AdapterDisposeResult> {
    this.disposed = true;
    const children: ChildCleanupResult[] = [];
    for (const [, sess] of this.sessions) {
      if (sess.activeTurn?.startTimer) clearTimeout(sess.activeTurn.startTimer);
      sess.activeTurn?.tailer.stopTurn();
      const res = await this.teardownSessionTransport(sess);
      if (res) children.push(res);
    }
    this.sessions.clear();
    return {
      children,
      orphanedPending: 0,
    };
  }
}

/** Convenience probe for unit tests / diagnostics using execFileSync directly if needed. */
export function agyVersionProbe(exe: string): string | null {
  if (isUnsafeRemotePath(exe)) return null;
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}
