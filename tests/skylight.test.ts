// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-47 Weather window tests: modes (Porthole / Full window / Off),
// time-of-day sky periods, sub-agent-waiting wind (Hydra head & panel helper),
// porthole vs global precedence, pause state, StreamVeil, and Settings UI.

import { describe, expect, it } from "vitest";
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
  portholeWeatherFromSnapshot,
  resolveGlobalWeatherSnapshot,
  resolveHeroWeatherSnapshot,
  resolveSkyPeriod,
  resolveWeatherWindowMode,
  shouldStartPortholeHold,
  threadActivityStatus,
} from "../src/shared/skylight";
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
      createElement(WeatherWindowLayer, { threads: [awaitingThread], holdsSteady: true }),
    );
    expect(fullWind).toContain("weather-window-layer");
    expect(fullWind).toContain('data-weather="awaiting"');

    const fullIdle = renderToStaticMarkup(
      createElement(WeatherWindowLayer, { threads: [thread({})], holdsSteady: true }),
    );
    expect(fullIdle).toBe("");

    setModalCovered(true);
    const fullPaused = renderToStaticMarkup(
      createElement(WeatherWindowLayer, { threads: [awaitingThread], holdsSteady: true }),
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
