// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// A84 F26 — port of frozen ThreadActivityStatus.resolve + HeroWeather.resolve:
// every visible thread folds into one weather for the sidebar's skylight
// card. A failure outranks a pending decision, which outranks live work,
// which outranks an unread reply; the count is how many threads share the
// winning state.

import type { ChatThread } from "./types";

export type ThreadActivityStatus =
  | "idle"
  | "running"
  | "completed"
  | "approval"
  | "question"
  | "failed"
  | "interrupted";

/**
 * Frozen ThreadActivityStatus.resolve: pending decisions and live work stay
 * visible; terminal results are reminders only until they have been read.
 */
export function threadActivityStatus(th: ChatThread): ThreadActivityStatus {
  const turn = th.turn;
  if (turn?.approval?.status === "pending" || turn?.status === "waiting-approval")
    return "approval";
  if (turn?.question?.status === "pending") return "question";
  if (turn?.status === "running") return "running";
  if (!th.hasUnread) return "idle";
  switch (th.unreadStatus) {
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
}

export type HeroWeatherKind = "idle" | "failed" | "awaiting" | "running" | "done";

export interface HeroWeather {
  kind: HeroWeatherKind;
  /** How many threads share the winning state; 0 for idle. */
  count: number;
}

/** Frozen HeroWeather.resolve — the fold's precedence order. */
export function resolveHeroWeather(statuses: Iterable<ThreadActivityStatus>): HeroWeather {
  let failed = 0,
    awaiting = 0,
    running = 0,
    done = 0;
  for (const s of statuses) {
    if (s === "failed" || s === "interrupted") failed++;
    else if (s === "approval" || s === "question") awaiting++;
    else if (s === "running") running++;
    else if (s === "completed") done++;
  }
  if (failed > 0) return { kind: "failed", count: failed };
  if (awaiting > 0) return { kind: "awaiting", count: awaiting };
  if (running > 0) return { kind: "running", count: running };
  if (done > 0) return { kind: "done", count: done };
  return { kind: "idle", count: 0 };
}

/** Frozen HeroWeather.tag — the drafting tag beside the doll; idle shows none. */
export function heroWeatherTag(w: HeroWeather): string | null {
  switch (w.kind) {
    case "failed":
      return `FAIL · ${w.count}`;
    case "awaiting":
      return `WAIT · ${w.count}`;
    case "running":
      return `RUN · ${w.count}`;
    case "done":
      return `DONE · ${w.count}`;
    default:
      return null;
  }
}
