// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-47 Weather window tests: modes (Porthole / Full window / Off),
// time-of-day sky periods, sub-agent-waiting wind (Hydra head & panel helper),
// porthole vs global precedence, pause state, StreamVeil, and Settings UI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// Stub window/document for SSR component renders of Sidebar & SettingsModal.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1280,
    innerHeight: 800,
    tivano: {
      platform: "win32",
      invoke: () => Promise.resolve({}),
      onEvent: () => () => {},
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} },
    hasFocus: () => true,
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

import {
  nextWeatherPulseState,
  portholeWeatherFromSnapshot,
  resolveGlobalWeatherSnapshot,
  resolveHeroWeatherSnapshot,
  resolveSkyPeriod,
  resolveWeatherWindowMode,
  shouldPlayWeatherPulse,
  shouldStartPortholeHold,
  threadActivityStatus,
} from "../src/shared/skylight";
import { requestValidators } from "../src/shared/ipc";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import { ClientStore, WEATHER_FLASH_MS } from "../src/renderer/client";
import { setModalCovered, setWindowActive } from "../src/renderer/appActivity";
import { LanguageContext } from "../src/renderer/locale";
import {
  Skylight,
  WeatherWindowLayer,
  WeatherWindowThumbnail,
} from "../src/renderer/components/Skylight";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { SettingsModal } from "../src/renderer/components/SettingsModal";
import { renderMarkdown } from "../src/renderer/markdown";
import type {
  AppInfo,
  ChatThread,
  LanguageId,
  Project,
  Settings,
  Snapshot,
} from "../src/shared/types";

const thread = (over: Partial<ChatThread>): ChatThread =>
  ({
    id: over.id ?? "t1",
    projectId: null,
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    turn: null,
    sessionGrants: [],
    ...over,
  }) as ChatThread;

const baseInfo: AppInfo = {
  appVersion: "test",
  baselineTag: "v3.0.0",
  baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
  dataRoot: "C:/tivano-test",
  providerId: "mock",
  providerLabel: "Mock",
  mock: true,
  mode: "mock",
  realCli: { status: "not-configured" },
  home: "C:/tivano-test",
  worktreesDir: "C:/tivano-test/worktrees",
};

function renderInLang(lang: LanguageId, node: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, node),
  );
}

describe("threadActivityStatus & weather fold (P2-47)", () => {
  it("resolves pending approval/question, running, and unread terminal states", () => {
    expect(
      threadActivityStatus(
        thread({ turn: { status: "waiting-approval" } as ChatThread["turn"] }),
      ),
    ).toBe("approval");
    expect(
      threadActivityStatus(
        thread({
          turn: {
            status: "running",
            question: { status: "pending" },
          } as ChatThread["turn"],
        }),
      ),
    ).toBe("question");
    expect(
      threadActivityStatus(thread({ turn: { status: "running" } as ChatThread["turn"] })),
    ).toBe("running");
    expect(threadActivityStatus(thread({ hasUnread: true, unreadStatus: "error" }))).toBe(
      "failed",
    );
    expect(
      threadActivityStatus(thread({ hasUnread: true, unreadStatus: "interrupted" })),
    ).toBe("interrupted");
    expect(threadActivityStatus(thread({ hasUnread: true, unreadStatus: "done" }))).toBe(
      "completed",
    );
    expect(threadActivityStatus(thread({ hasUnread: false, unreadStatus: "error" }))).toBe(
      "idle",
    );
    expect(threadActivityStatus(thread({}))).toBe("idle");
  });

  it("folds global snapshot (failed > awaiting > done > idle; running stays quiet) and porthole (awaiting > failed > done)", () => {
    const snap = resolveHeroWeatherSnapshot([
      "completed",
      "running",
      "question",
      "failed",
      "completed",
    ]);
    expect(snap).toEqual({
      kind: "failed",
      count: 1,
      hasRunningWork: true,
      failed: 1,
      awaiting: 1,
      done: 2,
    });
    expect(portholeWeatherFromSnapshot(snap)).toEqual({ kind: "awaiting", count: 1 });

    const runOnly = resolveHeroWeatherSnapshot(["running"]);
    expect(runOnly).toEqual({
      kind: "idle",
      count: 0,
      hasRunningWork: true,
      failed: 0,
      awaiting: 0,
      done: 0,
    });
    expect(portholeWeatherFromSnapshot(runOnly)).toEqual({ kind: "idle", count: 0 });
  });

  it("wires waiting sub-agents (Hydra heads and panel helpers) to bring the wind", () => {
    const lead = thread({ id: "lead-1", turn: { status: "running" } as ChatThread["turn"] });
    const headWaitingApproval = thread({
      id: "head-1",
      hydraHead: {
        leadId: "lead-1",
        headIndex: 0,
        name: "Scout",
        task: "check",
        batchId: "b1",
        status: "running",
        spawnedAt: 1,
      },
      turn: {
        status: "waiting-approval",
        approval: { status: "pending" },
      } as ChatThread["turn"],
    });

    const snapApproval = resolveGlobalWeatherSnapshot([lead, headWaitingApproval]);
    expect(snapApproval.kind).toBe("awaiting");
    expect(snapApproval.awaiting).toBe(1);
    expect(portholeWeatherFromSnapshot(snapApproval)).toEqual({ kind: "awaiting", count: 1 });

    const headWaitingQuestion = thread({
      id: "head-2",
      hydraHead: {
        leadId: "lead-1",
        headIndex: 1,
        name: "Builder",
        task: "ask",
        batchId: "b1",
        status: "running",
        spawnedAt: 2,
      },
      turn: {
        status: "running",
        question: { status: "pending" },
      } as ChatThread["turn"],
    });
    const snapQuestion = resolveGlobalWeatherSnapshot([lead, headWaitingQuestion]);
    expect(snapQuestion.kind).toBe("awaiting");
    expect(portholeWeatherFromSnapshot(snapQuestion)).toEqual({ kind: "awaiting", count: 1 });

    const helperWaiting = thread({
      id: "helper-1",
      parentThreadId: "lead-1",
      isInPanel: true,
      turn: {
        status: "running",
        question: { status: "pending" },
      } as ChatThread["turn"],
    });
    const snapHelper = resolveGlobalWeatherSnapshot([lead, helperWaiting]);
    expect(snapHelper.kind).toBe("awaiting");
    expect(portholeWeatherFromSnapshot(snapHelper)).toEqual({ kind: "awaiting", count: 1 });

    // Shelved projects and archived threads are excluded from the fold.
    const shelvedProj: Project = {
      id: "p-shelved",
      name: "Old",
      createdAt: 1,
      expanded: false,
      isShelved: true,
    };
    const shelvedFail = thread({
      id: "t-shelved",
      projectId: "p-shelved",
      hasUnread: true,
      unreadStatus: "error",
    });
    expect(resolveGlobalWeatherSnapshot([shelvedFail], [shelvedProj]).kind).toBe("idle");

    // Archived threads, in-panel helpers (as standalone rows), and finished Hydra heads
    // never linger as awaiting/done/failed; running work still sets hasRunningWork.
    const archivedFail = thread({
      id: "t-arch",
      isArchived: true,
      hasUnread: true,
      unreadStatus: "error",
    });
    const finishedHead = thread({
      id: "head-done",
      hydraHead: {
        leadId: "lead-1",
        headIndex: 2,
        name: "Done",
        task: "done",
        batchId: "b1",
        status: "completed",
        spawnedAt: 3,
      },
      turn: {
        status: "waiting-approval",
        approval: { status: "pending" },
      } as ChatThread["turn"],
    });
    const inPanelDone = thread({
      id: "helper-done",
      parentThreadId: "lead-1",
      isInPanel: true,
      hasUnread: true,
      unreadStatus: "error",
    });
    const foldRunning = resolveGlobalWeatherSnapshot([
      thread({ id: "lead-1", turn: { status: "running" } as ChatThread["turn"] }),
      archivedFail,
      finishedHead,
      inPanelDone,
    ]);
    expect(foldRunning).toEqual({
      kind: "idle",
      count: 0,
      hasRunningWork: true,
      failed: 0,
      awaiting: 0,
      done: 0,
    });

    // finishFlashes surfaces sun/rain on the viewed thread without double-counting unread.
    const viewedDone = resolveGlobalWeatherSnapshot(
      [thread({ id: "sel-1" }), thread({ id: "bg-1", hasUnread: true, unreadStatus: "done" })],
      undefined,
      { "sel-1": "done", "bg-1": "done" },
    );
    expect(viewedDone.kind).toBe("done");
    expect(viewedDone.done).toBe(2);
  });

  it("resolves weatherWindowMode with legacy showsSkylight fallback and time-of-day sky periods", () => {
    expect(resolveWeatherWindowMode(undefined)).toBe("porthole");
    expect(resolveWeatherWindowMode({ showsSkylight: false })).toBe("off");
    expect(resolveWeatherWindowMode({ weatherWindowMode: "full", showsSkylight: false })).toBe(
      "full",
    );
    expect(resolveWeatherWindowMode({ weatherWindowMode: "off" })).toBe("off");

    const atHour = (h: number) => new Date(2026, 10, 25, h, 30, 0);
    expect(resolveSkyPeriod(atHour(6))).toBe("dawn");
    expect(resolveSkyPeriod(atHour(13))).toBe("day");
    expect(resolveSkyPeriod(atHour(18))).toBe("dusk");
    expect(resolveSkyPeriod(atHour(23))).toBe("night");
    expect(resolveSkyPeriod(atHour(2))).toBe("night");

    expect(shouldStartPortholeHold({ kind: "idle", count: 0 }, { kind: "done", count: 1 })).toBe(
      true,
    );
    expect(
      shouldStartPortholeHold({ kind: "awaiting", count: 1 }, { kind: "failed", count: 1 }),
    ).toBe(true);
    expect(
      shouldStartPortholeHold({ kind: "done", count: 1 }, { kind: "done", count: 1 }),
    ).toBe(false);
  });
});

describe("Weather window components (P2-47)", () => {
  it("renders non-interactive porthole following sky period and weather states", () => {
    setWindowActive(true);
    setModalCovered(false);

    const lead = thread({ id: "lead-1" });
    const headWaiting = thread({
      id: "head-1",
      hydraHead: {
        leadId: "lead-1",
        headIndex: 0,
        name: "Scout",
        task: "check",
        batchId: "b1",
        status: "running",
        spawnedAt: 1,
      },
      turn: {
        status: "running",
        question: { status: "pending" },
      } as ChatThread["turn"],
    });

    const windHtml = renderToStaticMarkup(
      createElement(Skylight, {
        threads: [lead, headWaiting],
        clockOverride: new Date(2026, 10, 25, 22, 15, 0),
      }),
    );
    expect(windHtml).not.toContain("<button");
    expect(windHtml).toContain('aria-hidden="true"');
    expect(windHtml).toContain('data-weather="awaiting"');
    expect(windHtml).toContain('data-sky="night"');
    expect(windHtml).toContain("ph-breeze");
    expect(windHtml).toContain("ph-doll sway");
    expect(windHtml).toContain("ph-lit-window");

    const doneHtml = renderToStaticMarkup(
      createElement(Skylight, {
        threads: [thread({ hasUnread: true, unreadStatus: "done" })],
        clockOverride: new Date(2026, 10, 25, 13, 0, 0),
      }),
    );
    expect(doneHtml).toContain('data-weather="done"');
    expect(doneHtml).toContain('data-sky="day"');
    expect(doneHtml).toContain("ph-sun");

    const failedHtml = renderToStaticMarkup(
      createElement(Skylight, {
        threads: [thread({ hasUnread: true, unreadStatus: "error" })],
        clockOverride: new Date(2026, 10, 25, 6, 30, 0),
      }),
    );
    expect(failedHtml).toContain('data-weather="failed"');
    expect(failedHtml).toContain('data-sky="dawn"');
    expect(failedHtml).toContain("ph-rain");

    setModalCovered(true);
    const pausedHtml = renderToStaticMarkup(
      createElement(Skylight, {
        threads: [lead, headWaiting],
        clockOverride: new Date(2026, 10, 25, 18, 0, 0),
      }),
    );
    expect(pausedHtml).toContain('data-paused="true"');
    expect(pausedHtml).toContain('data-sky="dusk"');
    expect(pausedHtml).not.toContain("ph-doll sway");
    setModalCovered(false);
  });

  it("renders Full window layer only when active and non-idle, and respects Sidebar mode switching", () => {
    setWindowActive(true);
    setModalCovered(false);

    const awaitingThread = thread({
      turn: { status: "waiting-approval", approval: { status: "pending" } } as ChatThread["turn"],
    });
    const fullWind = renderToStaticMarkup(
      createElement(WeatherWindowLayer, { threads: [awaitingThread] }),
    );
    expect(fullWind).toContain("weather-window-layer");
    expect(fullWind).toContain('data-weather="awaiting"');

    const fullIdle = renderToStaticMarkup(
      createElement(WeatherWindowLayer, { threads: [thread({})] }),
    );
    expect(fullIdle).toBe("");

    setModalCovered(true);
    const fullPaused = renderToStaticMarkup(
      createElement(WeatherWindowLayer, { threads: [awaitingThread] }),
    );
    expect(fullPaused).toBe("");
    setModalCovered(false);

    const makeSnapshot = (settings: Partial<Settings>): Snapshot => ({
      projects: [],
      threads: [awaitingThread],
      settings: {
        theme: "system",
        language: "en",
        alwaysAllow: [],
        ...settings,
      },
      selectedThreadId: null,
      info: baseInfo,
      rev: 1,
      tokenActivity: {},
    });

    const sidebarPorthole = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: makeSnapshot({ weatherWindowMode: "porthole" }),
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(sidebarPorthole).toContain("skylight");

    const sidebarFull = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: makeSnapshot({ weatherWindowMode: "full" }),
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(sidebarFull).not.toContain("skylight");

    const sidebarOff = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: makeSnapshot({ weatherWindowMode: "off" }),
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(sidebarOff).not.toContain("skylight");
  });

  it("renders Settings > Appearance > Weather window with Porthole / Full window / Off in en and zh-Hans", () => {
    const baseSettings: Settings = {
      theme: "system",
      language: "en",
      alwaysAllow: [],
      weatherWindowMode: "porthole",
    };

    const enHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings: baseSettings,
        info: baseInfo,
        threads: [],
        projects: [],
        tokenActivity: {},
        initialPage: "appearance",
        onClose: () => {},
      }),
    );
    expect(enHtml).toContain("Weather window");
    expect(enHtml).toContain("Porthole");
    expect(enHtml).toContain("Full window");
    expect(enHtml).toContain("Off");
    expect(enHtml).toContain(
      "A small window above the thread list: wind when waiting on you, sunlight when a turn finishes, rain when one fails.",
    );

    const zhHtml = renderInLang(
      "zh-Hans",
      createElement(SettingsModal, {
        settings: { ...baseSettings, language: "zh-Hans", weatherWindowMode: "full" },
        info: baseInfo,
        threads: [],
        projects: [],
        tokenActivity: {},
        initialPage: "appearance",
        onClose: () => {},
      }),
    );
    expect(zhHtml).toContain("天气窗");
    expect(zhHtml).toContain("舷窗");
    expect(zhHtml).toContain("落地窗");
    expect(zhHtml).toContain("关闭");
    expect(zhHtml).toContain("在等待你回答或确认时拂过微风、完成时洒下暖阳、失败时落下细雨。");

    expect(renderToStaticMarkup(createElement(WeatherWindowThumbnail, { mode: "porthole" }))).toContain("wt-porthole");
    expect(renderToStaticMarkup(createElement(WeatherWindowThumbnail, { mode: "full" }))).toContain("wt-full");
  });

  it("drives Full window pulse/release transitions without re-pulsing on count drop or cutting off finish flashes", () => {
    expect(shouldPlayWeatherPulse({ kind: "awaiting", count: 1 }, { kind: "awaiting", count: 2 })).toBe(true);
    expect(shouldPlayWeatherPulse({ kind: "awaiting", count: 2 }, { kind: "awaiting", count: 1 })).toBe(false);

    // Mount with awaiting -> starts pulse.
    const p1 = nextWeatherPulseState(null, { kind: "awaiting", count: 1 }, { kind: "awaiting", count: 1 }, false, false);
    expect(p1).toEqual({
      state: { kind: "awaiting", count: 1, releasing: false, expired: false },
      action: "pulse",
    });

    // Count decrease stays quiet (no restart even if expired).
    const pDrop = nextWeatherPulseState(
      { kind: "awaiting", count: 2, releasing: false, expired: true },
      { kind: "awaiting", count: 2 },
      { kind: "awaiting", count: 1 },
      false,
      false,
    );
    expect(pDrop.action).toBe("none");

    // awaiting -> idle enters release when not running.
    const pRel = nextWeatherPulseState(p1.state, { kind: "awaiting", count: 1 }, { kind: "idle", count: 0 }, false, false);
    expect(pRel).toEqual({
      state: { kind: "awaiting", count: 1, releasing: true, expired: false },
      action: "release",
    });

    // done -> idle (after finish flash expires or markRead) preserves the 7.3s pulse,
    // while starting new running work stops it immediately.
    const donePulse = { kind: "done" as const, count: 1, releasing: false, expired: false };
    const pKeep = nextWeatherPulseState(donePulse, { kind: "done", count: 1 }, { kind: "idle", count: 0 }, false, false);
    expect(pKeep).toEqual({ state: donePulse, action: "none" });
    const pStop = nextWeatherPulseState(donePulse, { kind: "done", count: 1 }, { kind: "idle", count: 0 }, true, false);
    expect(pStop).toEqual({ state: null, action: "clear" });

    // Paused clears immediately.
    const pPaused = nextWeatherPulseState(donePulse, { kind: "done", count: 1 }, { kind: "done", count: 1 }, false, true);
    expect(pPaused).toEqual({ state: null, action: "clear" });
  });
});

describe("Weather window settings persistence & ClientStore finish flashes (P2-47)", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "tivano-sky-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    vi.useRealTimers();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("validates settings:set and persists weatherWindowMode / showsSkylight / lastWeatherWindowMode", () => {
    for (const m of ["porthole", "full", "off"] as const) {
      expect(requestValidators["settings:set"]({ weatherWindowMode: m }).weatherWindowMode).toBe(m);
    }
    expect(() => requestValidators["settings:set"]({ weatherWindowMode: "banner" })).toThrow();
    expect(requestValidators["settings:set"]({ showsSkylight: false }).showsSkylight).toBe(false);

    const root = tmp();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");

    engine.setSettings({ weatherWindowMode: "full" });
    expect(engine.snapshot().settings).toMatchObject({
      weatherWindowMode: "full",
      lastWeatherWindowMode: "full",
      showsSkylight: true,
    });

    // Legacy showsSkylight=false turns off and preserves lastWeatherWindowMode; true restores "full".
    engine.setSettings({ showsSkylight: false });
    expect(engine.snapshot().settings).toMatchObject({
      weatherWindowMode: "off",
      lastWeatherWindowMode: "full",
      showsSkylight: false,
    });
    engine.setSettings({ showsSkylight: true });
    expect(engine.snapshot().settings).toMatchObject({
      weatherWindowMode: "full",
      showsSkylight: true,
    });

    store.close();
    const store2 = new Store(root);
    store2.open();
    expect(store2.state.settings.weatherWindowMode).toBe("full");
    expect(store2.state.settings.lastWeatherWindowMode).toBe("full");
    store2.close();
  });

  it("flashes weatherFlashes on finish-signal for the viewed thread and clears on expiry or new run", () => {
    vi.useFakeTimers();
    const cs = new ClientStore(async () => ({}));
    const th = thread({ id: "t-view" });
    const snap: Snapshot = {
      projects: [],
      threads: [th],
      settings: { theme: "system", language: "en", alwaysAllow: [], weatherWindowMode: "porthole" },
      selectedThreadId: "t-view",
      info: baseInfo,
      rev: 1,
      tokenActivity: {},
    };
    cs.hydrate(snap, cs.beginHydration());

    cs.apply({
      type: "finish-signal",
      rev: 2,
      threadId: "t-view",
      status: "done",
      chime: false,
      notify: "done",
      silent: false,
    });
    expect(cs.view.weatherFlashes).toEqual({ "t-view": "done" });
    expect(resolveGlobalWeatherSnapshot(cs.snapshot!.threads, cs.snapshot!.projects, cs.view.weatherFlashes).kind).toBe("done");

    vi.advanceTimersByTime(WEATHER_FLASH_MS + 10);
    expect(cs.view.weatherFlashes).toEqual({});

    // A failure flash is cleared immediately when a new turn begins running.
    cs.apply({
      type: "finish-signal",
      rev: 3,
      threadId: "t-view",
      status: "error",
      chime: false,
      notify: "failed",
      silent: false,
    });
    expect(cs.view.weatherFlashes).toEqual({ "t-view": "error" });
    cs.apply({
      type: "thread-updated",
      rev: 4,
      thread: thread({ id: "t-view", turn: { status: "running" } as ChatThread["turn"] }),
    });
    expect(cs.view.weatherFlashes).toEqual({});
  });
});

describe("StreamVeil (A84)", () => {
  const html = (src: string, veil?: { chars: number; ms: number } | null) =>
    renderToStaticMarkup(
      createElement("div", {}, renderMarkdown(src, undefined, true, veil)),
    );

  it("veils only the trailing flushed characters", () => {
    const out = html("hello world", { chars: 5, ms: 200 });
    expect(out).toContain('class="md-veil"');
    expect(out).toContain("world");
    expect(out.indexOf("hello")).toBeLessThan(out.indexOf("md-veil"));
  });
  it("carries the cadence duration as a CSS var", () => {
    expect(html("abc def", { chars: 3, ms: 175 })).toContain("--veil-d:175ms");
  });
  it("no veil without streaming or without a veil window", () => {
    expect(html("hello", { chars: 5, ms: 200 })).not.toBe("undefined");
    const settled = renderToStaticMarkup(
      createElement("div", {}, renderMarkdown("hello", undefined, false, { chars: 2, ms: 200 })),
    );
    expect(settled).not.toContain("md-veil");
    expect(html("hello", null)).not.toContain("md-veil");
  });
  it("veils inside the mended last block only", () => {
    const out = html("done para\n\nnew **bo", { chars: 2, ms: 200 });
    expect(out).toContain("md-veil");
    // the earlier paragraph stays untouched; only the trailing "bo" veils
    expect(out.match(/md-veil/g)?.length).toBe(1);
  });
});

import { threadNeedsAttention } from "../src/shared/skylight";
import { ChimeraCastingCard } from "../src/renderer/components/ChimeraCastingCard";

describe("P2-76 model-assignment wait surfaces", () => {
  const casting = {
    batchId: "batch-1",
    rows: [
      { id: "r1", role: "Scout", task: "Inspect core" },
      { id: "r2", role: "Builder", task: "Patch bug" },
    ],
  };

  it("treats chimeraCasting as question-grade attention for weather and sidebar", () => {
    const waiting = thread({
      id: "lead-wait",
      title: "Waiting lead",
      updatedAt: 10,
      chimeraCasting: casting,
    });
    const secondWait = thread({
      id: "lead-wait-2",
      title: "Second waiting lead",
      updatedAt: 20,
      chimeraCasting: {
        batchId: "batch-2",
        rows: [{ id: "r3", role: "Reviewer", task: "Check diff" }],
      },
    });
    const idle = thread({ id: "idle-1", title: "Idle thread", updatedAt: 30 });

    expect(threadNeedsAttention(waiting)).toBe(true);
    expect(threadNeedsAttention(idle)).toBe(false);
    expect(threadActivityStatus(waiting)).toBe("question");

    const globalSnap = resolveGlobalWeatherSnapshot([waiting, idle]);
    expect(globalSnap.kind).toBe("awaiting");
    expect(globalSnap.awaiting).toBe(1);
    expect(portholeWeatherFromSnapshot(globalSnap).kind).toBe("awaiting");

    const makeSnapshot = (threads: ChatThread[]): Snapshot => ({
      projects: [],
      threads,
      settings: { theme: "system", language: "en", alwaysAllow: [] },
      selectedThreadId: null,
      info: baseInfo,
      rev: 1,
      tokenActivity: {},
    });

    const sidebarWithWait = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: makeSnapshot([waiting, secondWait, idle]),
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(sidebarWithWait).toContain("attention-group");
    expect(sidebarWithWait).toContain("Needs attention");
    expect(sidebarWithWait).toContain("dot question");
    expect(sidebarWithWait).toContain("Awaiting your answer");

    // Clearing the first casting still keeps secondWait in Needs attention;
    // clearing both drops the section cleanly.
    const clearedOne = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: makeSnapshot([thread({ id: "lead-wait", title: "Waiting lead" }), secondWait, idle]),
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(clearedOne).toContain("Needs attention");

    const clearedAll = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: makeSnapshot([idle]),
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(clearedAll).not.toContain("Needs attention");
    expect(clearedAll).not.toContain("attention-group");

    // Staying on question when casting clears while a question remains pending.
    const questionAlsoPending = thread({
      id: "lead-q",
      title: "Question lead",
      turn: {
        status: "running",
        question: { providerKey: "q1", status: "pending", questions: [] },
      } as unknown as ChatThread["turn"],
    });
    expect(threadNeedsAttention(questionAlsoPending)).toBe(true);
    expect(threadActivityStatus(questionAlsoPending)).toBe("question");

    const cardHtml = renderInLang(
      "en",
      createElement(ChimeraCastingCard, {
        threadId: "lead-wait",
        casting,
        mode: "mock",
      }),
    );
    expect(cardHtml).toContain("Assign models");
    expect(cardHtml).toContain("2 roles waiting for a model");
    expect(cardHtml).toContain("Send none");
    expect(cardHtml).toContain("Send 2");
  });

  it("fires ClientStore OS notification for attention-signal only when thread is unseen", () => {
    const notifications: Array<{ title: string; opts: NotificationOptions | undefined }> = [];
    const origNotification = (globalThis as { Notification?: unknown }).Notification;
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: NotificationOptions) {
        notifications.push({ title, opts });
      }
      close() {}
    }
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;

    try {
      const store = new ClientStore();
      const t1 = thread({ id: "t-att", title: "Cast thread", chimeraCasting: { batchId: "b", rows: [{ id: "r", role: "Scout", task: "x" }] } });
      const t2 = thread({ id: "t-other", title: "Other" });
      const gen1 = store.beginHydration();
      store.hydrate(
        {
          projects: [],
          threads: [t1, t2],
          settings: { theme: "system", language: "en", alwaysAllow: [] },
          selectedThreadId: "t-other",
          info: baseInfo,
          rev: 1,
          tokenActivity: {},
        },
        gen1,
      );

      // Unseen because t-other is selected -> fires notification with sound.
      store.apply({ type: "attention-signal", threadId: "t-att", reason: "casting", rev: 2 });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.title).toBe("Cast thread");
      expect(notifications[0]!.opts?.body).toBe("Waiting for your decision.");
      expect(notifications[0]!.opts?.silent).toBe(false);
      expect(notifications[0]!.opts?.tag).toBe("tivano-attention-t-att");

      // Selected & focused -> suppressed.
      const gen2 = store.beginHydration();
      store.hydrate(
        {
          projects: [],
          threads: [t1, t2],
          settings: { theme: "system", language: "en", alwaysAllow: [] },
          selectedThreadId: "t-att",
          info: baseInfo,
          rev: 3,
          tokenActivity: {},
        },
        gen2,
      );
      store.apply({ type: "attention-signal", threadId: "t-att", reason: "casting", rev: 4 });
      expect(notifications).toHaveLength(1);
    } finally {
      (globalThis as { Notification?: unknown }).Notification = origNotification;
    }
  });
});
