// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// P2-47 — v3.0.0 Weather window (AppModel+Weather.swift, HeroWeather.swift,
// ThreadActivityStatus.swift, SidebarPorthole.swift, AppSettings.swift):
// replaces the interactive v2 Skylight card with a three-mode Weather window
// (Porthole / Full window / Off) whose sky follows the time of day and whose
// weather folds visible threads — including sub-agents waiting on approval
// or answer — into wind (awaiting), sunlight (done) or rain (failed).

import type { ChatThread, Project, Settings, WeatherWindowMode } from "./types";

export type ThreadActivityStatus =
  | "idle"
  | "running"
  | "completed"
  | "approval"
  | "question"
  | "failed"
  | "interrupted";

export interface ThreadActivityOverrides {
  needsApproval?: boolean;
  needsAnswer?: boolean;
  isWorking?: boolean;
  flashStatus?: "done" | "error" | "interrupted" | undefined;
}

export function threadNeedsApproval(
  th: Pick<ChatThread, "turn">,
): boolean {
  const turn = th.turn;
  return turn?.approval?.status === "pending" || turn?.status === "waiting-approval";
}

export function threadNeedsAnswer(
  th: Pick<ChatThread, "turn" | "chimeraCasting">,
): boolean {
  return (
    th.turn?.question?.status === "pending" ||
    (th.chimeraCasting?.rows.length ?? 0) > 0
  );
}

/** Frozen ThreadRuntime.needsUserAttention: pending approval, question, or
 *  adaptive model-assignment wait. */
export function threadNeedsAttention(
  th: Pick<ChatThread, "turn" | "chimeraCasting">,
): boolean {
  return threadNeedsApproval(th) || threadNeedsAnswer(th);
}

/**
 * Frozen ThreadActivityStatus.resolve: pending decisions and live work stay
 * visible; terminal results are reminders only until they have been read
 * (or flashed briefly when a turn ends on the currently viewed thread).
 */
export function threadActivityStatus(
  th: ChatThread,
  overrides?: ThreadActivityOverrides,
): ThreadActivityStatus {
  const turn = th.turn;
  if (overrides?.needsApproval || threadNeedsApproval(th)) {
    return "approval";
  }
  if (overrides?.needsAnswer || threadNeedsAnswer(th)) {
    return "question";
  }
  if (overrides?.isWorking || turn?.status === "running") {
    return "running";
  }
  if (th.hasUnread) {
    switch (th.unreadStatus) {
      case "error":
        return "failed";
      case "interrupted":
        return "interrupted";
      default:
        return "completed";
    }
  }
  if (overrides?.flashStatus !== undefined) {
    switch (overrides.flashStatus) {
      case "error":
        return "failed";
      case "interrupted":
        return "interrupted";
      default:
        return "completed";
    }
  }
  return "idle";
}

export type WeatherKind = "idle" | "awaiting" | "done" | "failed";

export interface HeroWeather {
  kind: WeatherKind;
  /** How many threads share the winning state; 0 for idle. */
  count: number;
}

export interface HeroWeatherSnapshot {
  kind: WeatherKind;
  count: number;
  hasRunningWork: boolean;
  failed: number;
  awaiting: number;
  done: number;
}

/**
 * Frozen HeroWeather.resolveSnapshot — folds thread statuses into counts and
 * the global window weather (failure > awaiting > done > idle; live work stays quiet).
 */
export function resolveHeroWeatherSnapshot(
  statuses: Iterable<ThreadActivityStatus>,
): HeroWeatherSnapshot {
  let failed = 0;
  let awaiting = 0;
  let done = 0;
  let hasRunningWork = false;
  for (const s of statuses) {
    if (s === "failed" || s === "interrupted") failed++;
    else if (s === "approval" || s === "question") awaiting++;
    else if (s === "completed") done++;
    else if (s === "running") hasRunningWork = true;
  }
  if (failed > 0) {
    return { kind: "failed", count: failed, hasRunningWork, failed, awaiting, done };
  }
  if (awaiting > 0) {
    return { kind: "awaiting", count: awaiting, hasRunningWork, failed, awaiting, done };
  }
  if (done > 0) {
    return { kind: "done", count: done, hasRunningWork, failed, awaiting, done };
  }
  return { kind: "idle", count: 0, hasRunningWork, failed, awaiting, done };
}

/** Frozen SidebarPorthole.portholeWeather — waiting wind outranks rain and sun. */
export function portholeWeatherFromSnapshot(snapshot: HeroWeatherSnapshot): HeroWeather {
  if (snapshot.awaiting > 0) return { kind: "awaiting", count: snapshot.awaiting };
  if (snapshot.failed > 0) return { kind: "failed", count: snapshot.failed };
  if (snapshot.done > 0) return { kind: "done", count: snapshot.done };
  return { kind: "idle", count: 0 };
}

/**
 * Frozen AppModel.globalWeatherSnapshot: excludes archived threads, Hydra heads,
 * open panel helpers, and shelved-project threads; folds sub-agents (Hydra heads
 * and in-panel helpers) waiting on approval/question or running onto their parent
 * thread so a waiting sub-agent always brings the wind.
 */
export function resolveGlobalWeatherSnapshot(
  threads: readonly ChatThread[],
  projects?: readonly Project[],
  finishFlashes?: Readonly<Record<string, "done" | "error" | "interrupted">>,
): HeroWeatherSnapshot {
  const shelvedIds = new Set<string>();
  if (projects) {
    for (const p of projects) {
      if (p.isShelved) shelvedIds.add(p.id);
    }
  }

  const workingParents = new Set<string>();
  const approvalParents = new Set<string>();
  const questionParents = new Set<string>();

  for (const th of threads) {
    if (th.isArchived) continue;
    const parentId = th.hydraHead?.leadId ?? (th.isInPanel ? th.parentThreadId : undefined);
    if (!parentId) continue;

    // A finished/stopped Hydra head must not linger as waiting/working; only active
    // heads (or active turns on helpers) propagate to the parent.
    const active = th.hydraHead ? th.hydraHead.status === "running" : true;
    if (!active) continue;

    if (th.turn?.approval?.status === "pending" || th.turn?.status === "waiting-approval") {
      approvalParents.add(parentId);
    }
    if (th.turn?.question?.status === "pending") {
      questionParents.add(parentId);
    }
    if (th.turn?.status === "running" || th.hydraHead?.status === "running") {
      workingParents.add(parentId);
    }
  }

  const visibleStatuses: ThreadActivityStatus[] = [];
  for (const th of threads) {
    if (th.isArchived) continue;
    if (th.hydraHead) continue;
    if (th.isInPanel && th.parentThreadId) continue;
    if (th.projectId && shelvedIds.has(th.projectId)) continue;
    visibleStatuses.push(
      threadActivityStatus(th, {
        needsApproval: approvalParents.has(th.id),
        needsAnswer: questionParents.has(th.id),
        isWorking: workingParents.has(th.id),
        flashStatus: finishFlashes?.[th.id],
      }),
    );
  }

  return resolveHeroWeatherSnapshot(visibleStatuses);
}

/** Frozen AppSettings.resolveWeatherWindowMode: defaults to "porthole", migrates showsSkylight=false -> "off". */
export function resolveWeatherWindowMode(
  settings?: Pick<Settings, "weatherWindowMode" | "showsSkylight"> | null,
): WeatherWindowMode {
  if (
    settings?.weatherWindowMode === "porthole" ||
    settings?.weatherWindowMode === "full" ||
    settings?.weatherWindowMode === "off"
  ) {
    return settings.weatherWindowMode;
  }
  if (settings?.showsSkylight === false) return "off";
  return "porthole";
}

export type SkyPeriod = "dawn" | "day" | "dusk" | "night";

/** Frozen PortholeWeatherView.SkyPeriod.resolve: sky follows local time of day. */
export function resolveSkyPeriod(date: Date = new Date()): SkyPeriod {
  const hour = date.getHours();
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "dusk";
  return "night";
}

export const PORTHOLE_HOLD_MS = 8000;
export const FULL_WINDOW_PULSE_MS = 7300;
export const FULL_WINDOW_RELEASE_MS = 950;

export function portholeStrength(w: HeroWeather): [number, number] {
  switch (w.kind) {
    case "idle":
      return [0, 0];
    case "done":
      return [1, w.count];
    case "failed":
      return [2, w.count];
    case "awaiting":
      return [3, w.count];
  }
}

export function comparePortholeStrength(a: HeroWeather, b: HeroWeather): number {
  const [ar, ac] = portholeStrength(a);
  const [br, bc] = portholeStrength(b);
  return ar !== br ? ar - br : ac - bc;
}

/** Frozen SidebarPorthole.shouldStartHold: hold brief finish/error flashes for 8s. */
export function shouldStartPortholeHold(previous: HeroWeather, live: HeroWeather): boolean {
  if (
    (previous.kind === "idle" || previous.kind === "awaiting") &&
    (live.kind === "done" || live.kind === "failed")
  ) {
    return true;
  }
  if (previous.kind === "done" && live.kind === "failed") return true;
  if (
    (previous.kind === "done" && live.kind === "done") ||
    (previous.kind === "failed" && live.kind === "failed")
  ) {
    return live.count > previous.count;
  }
  return false;
}

/** Frozen GlobalWeatherLayer.shouldPlay: replay only on kind change or count increase. */
export function shouldPlayWeatherPulse(previous: HeroWeather, next: HeroWeather): boolean {
  if (next.kind === "idle") return false;
  if (previous.kind === next.kind) return next.count > previous.count;
  return true;
}

export interface WeatherPulseState {
  kind: Exclude<WeatherKind, "idle">;
  count: number;
  releasing: boolean;
  expired: boolean;
}

export type WeatherPulseAction = "none" | "clear" | "pulse" | "release";

/**
 * Pure state transition for GlobalWeatherLayer's 7.3s pulse / 0.95s awaiting
 * release machine so production transitions and unit tests share one path.
 */
export function nextWeatherPulseState(
  cur: WeatherPulseState | null,
  previous: HeroWeather,
  live: HeroWeather,
  hasRunningWork: boolean,
  paused: boolean,
): { state: WeatherPulseState | null; action: WeatherPulseAction } {
  if (paused) {
    return { state: null, action: "clear" };
  }
  if (live.kind === "idle") {
    if (hasRunningWork) {
      return { state: null, action: "clear" };
    }
    if (previous.kind === "awaiting" && cur && !cur.expired && !cur.releasing) {
      return { state: { ...cur, releasing: true }, action: "release" };
    }
    return { state: cur, action: "none" };
  }
  if (cur === null || cur.releasing || shouldPlayWeatherPulse(previous, live)) {
    return {
      state: { kind: live.kind, count: live.count, releasing: false, expired: false },
      action: "pulse",
    };
  }
  return { state: cur, action: "none" };
}

export const WEATHER_WINDOW_LABEL: Record<WeatherWindowMode, string> = {
  porthole: "Porthole",
  full: "Full window",
  off: "Off",
};

export const WEATHER_WINDOW_DETAIL: Record<WeatherWindowMode, string> = {
  porthole:
    "A small window above the thread list: wind when waiting on you, sunlight when a turn finishes, rain when one fails.",
  full: "Shows subtle wind when waiting on you, sunlight when a turn finishes, and rain when one fails.",
  off: "No weather.",
};
