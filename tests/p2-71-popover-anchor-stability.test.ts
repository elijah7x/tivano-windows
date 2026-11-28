// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-71 unit & component tests: stable popover placement for thread overflow,
// model/effort and combo lists across long-idle first open, async font/layout
// settling, real anchor movement, and constrained-window placement.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/store";
import { clientStore } from "../src/renderer/client";
import { ChatView } from "../src/renderer/components/ChatView";
import { ModelListSettings } from "../src/renderer/components/ModelListSettings";
import { ModelPicker } from "../src/renderer/components/ModelPicker";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { LanguageContext } from "../src/renderer/locale";
import { anchoredPopoverStyle, readViewportBounds } from "../src/renderer/useAnchoredPopover";
import {
  anchorPopover,
  pointToAnchor,
  stepAnchoredPopover,
  type AnchorRect,
  type PopoverSize,
  type ViewportBounds,
} from "../src/shared/popoverAnchor";
import type { ChatThread, CodexModelCatalog, Snapshot } from "../src/shared/types";

const prevWindow = (globalThis as { window?: unknown }).window;
const prevSnapshot = clientStore.snapshot;

afterEach(() => {
  if (prevWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
  clientStore.snapshot = prevSnapshot;
});

describe("P2-71 stable popover placement", () => {
  it("captures initial placement and ignores long-idle subpixel jitter on repeat passes", () => {
    const anchor: AnchorRect = { left: 210, right: 234, top: 140, bottom: 164, width: 24, height: 24 };
    const popover: PopoverSize = { width: 196, height: 188 };
    const viewport: ViewportBounds = { width: 1280, height: 800 };

    const first = stepAnchoredPopover(null, {
      anchor,
      popover,
      viewport,
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(first.position).toEqual({
      left: 38,
      top: 168,
      maxWidth: 1264,
      maxHeight: 624,
      side: "bottom",
    });

    // Simulate long-idle ticks / subpixel layout jitter (< 0.5px) — exact same reference returned.
    const jittered = stepAnchoredPopover(first, {
      anchor: { left: 210.2, right: 234.2, top: 140.25, bottom: 164.25, width: 24, height: 24 },
      popover: { width: 196.3, height: 188.4 },
      viewport: { width: 1280, height: 800 },
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(jittered).toBe(first);
  });

  it("keeps start-aligned menus stationary and keeps top-anchored model/combo popovers pinned on async font/layout settling", () => {
    // 1. Start-aligned menu (e.g. context menu): font metric settling changes width/height slightly.
    const ctxState = stepAnchoredPopover(null, {
      anchor: pointToAnchor(300, 200),
      popover: { width: 190, height: 170 },
      viewport: { width: 1280, height: 800 },
      preferredSide: "bottom",
      align: "start",
      constrainSideHeight: true,
      gap: 0,
    });
    const ctxSettled = stepAnchoredPopover(ctxState, {
      anchor: pointToAnchor(300, 200),
      popover: { width: 198, height: 176 },
      viewport: { width: 1280, height: 800 },
      preferredSide: "bottom",
      align: "start",
      constrainSideHeight: true,
      gap: 0,
    });
    expect(ctxSettled.position).toBe(ctxState.position);
    expect(ctxSettled.position).toEqual({
      left: 300,
      top: 200,
      maxWidth: 1264,
      maxHeight: 592,
      side: "bottom",
    });

    // 2. Top-anchored model/effort & combo list: opens compact while catalog/fonts settle,
    //    then expands to two-column combo+model list while keeping bottom edge pinned to anchor.top - 6.
    const modelBtn: AnchorRect = { left: 320, right: 440, top: 680, bottom: 708, width: 120, height: 28 };
    const compact = stepAnchoredPopover(null, {
      anchor: modelBtn,
      popover: { width: 310, height: 140 },
      viewport: { width: 1280, height: 800 },
      preferredSide: "top",
      align: "start",
      constrainSideHeight: true,
      gap: 6,
    });
    expect(compact.position.side).toBe("top");
    expect(compact.position.left).toBe(320);
    expect(compact.position.top + 140).toBe(674);

    const expandedCombos = stepAnchoredPopover(compact, {
      anchor: modelBtn,
      popover: { width: 520, height: 420 },
      viewport: { width: 1280, height: 800 },
      preferredSide: "top",
      align: "start",
      constrainSideHeight: true,
      gap: 6,
    });
    expect(expandedCombos.position.side).toBe("top");
    expect(expandedCombos.position.left).toBe(320);
    expect(expandedCombos.position.top + 420).toBe(674);
  });

  it("handles constrained-window placement for model/combo lists and thread overflow without overlapping trigger", () => {
    // Narrow + short window: two-column combo+model popover (520x420) clamps horizontally
    // and constrains maxHeight above the trigger so it scrolls instead of overlapping the button.
    const trigger: AnchorRect = { left: 280, right: 400, top: 380, bottom: 408, width: 120, height: 28 };
    const constrainedViewport: ViewportBounds = { width: 620, height: 440 };
    const modelPos = anchorPopover({
      anchor: trigger,
      popover: { width: 520, height: 420 },
      viewport: constrainedViewport,
      preferredSide: "top",
      align: "start",
      constrainSideHeight: true,
      gap: 6,
      margin: 8,
    });
    expect(modelPos.side).toBe("top");
    expect(modelPos.left).toBe(620 - 520 - 8);
    expect(modelPos.maxWidth).toBe(604);
    expect(modelPos.maxHeight).toBe(366);
    expect(modelPos.top).toBe(8);
    expect(modelPos.top + modelPos.maxHeight).toBeLessThanOrEqual(trigger.top - 6);

    // Bottom-edge thread overflow button in a short window flips to "top" cleanly.
    const bottomThreadOverflow: AnchorRect = {
      left: 214,
      right: 238,
      top: 402,
      bottom: 426,
      width: 24,
      height: 24,
    };
    const overflowPos = anchorPopover({
      anchor: bottomThreadOverflow,
      popover: { width: 196, height: 184 },
      viewport: constrainedViewport,
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
      margin: 8,
    });
    expect(overflowPos.side).toBe("top");
    expect(overflowPos.left).toBe(238 - 196);
    expect(overflowPos.top).toBe(402 - 4 - 184);
    expect(overflowPos.top).toBeGreaterThanOrEqual(8);
  });

  it("repositions on real anchor movement or viewport resize and preserves sticky side while settling", () => {
    const initial = stepAnchoredPopover(null, {
      anchor: { left: 900, right: 932, top: 24, bottom: 52, width: 32, height: 28 },
      popover: { width: 220, height: 160 },
      viewport: { width: 1000, height: 700 },
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(initial.position.left).toBe(932 - 220);
    expect(initial.position.top).toBe(56);

    // Real anchor shift (>= 0.5px) moves the menu along with the trigger.
    const shifted = stepAnchoredPopover(initial, {
      anchor: { left: 900, right: 932, top: 36, bottom: 64, width: 32, height: 28 },
      popover: { width: 220, height: 160 },
      viewport: { width: 1000, height: 700 },
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(shifted.position.top).toBe(68);

    // Viewport shrinks sharply -> clamps left inside the narrower window.
    const resized = stepAnchoredPopover(shifted, {
      anchor: { left: 900, right: 932, top: 36, bottom: 64, width: 32, height: 28 },
      popover: { width: 220, height: 160 },
      viewport: { width: 640, height: 700 },
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(resized.position.left).toBe(640 - 220 - 8);
    expect(resized.position.maxWidth).toBe(624);
  });

  it("flips sticky bottom menu to top when async content grows in a constrained bottom slot", () => {
    const nearBottomBtn: AnchorRect = { left: 400, right: 432, top: 370, bottom: 398, width: 32, height: 28 };
    const viewport: ViewportBounds = { width: 800, height: 500 };

    const loading = stepAnchoredPopover(null, {
      anchor: nearBottomBtn,
      popover: { width: 210, height: 72 },
      viewport,
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(loading.position.side).toBe("bottom");

    // Async openin:editors / branch list loads many items -> flips cleanly above button.
    const loaded = stepAnchoredPopover(loading, {
      anchor: nearBottomBtn,
      popover: { width: 210, height: 320 },
      viewport,
      preferredSide: "bottom",
      align: "end",
      constrainSideHeight: true,
      gap: 4,
    });
    expect(loaded.position.side).toBe("top");
    expect(loaded.position.top).toBe(370 - 4 - 320);
  });
});

describe("P2-71 hook helpers and SSR rendering", () => {
  it("builds safe viewport bounds and fixed styles", () => {
    expect(readViewportBounds()).toEqual({ width: 1280, height: 800 });
    (globalThis as { window?: unknown }).window = { innerWidth: 720, innerHeight: 480 };
    expect(readViewportBounds()).toEqual({ width: 720, height: 480 });

    expect(anchoredPopoverStyle(null)).toBeUndefined();
    expect(
      anchoredPopoverStyle({
        left: 12,
        top: 34,
        maxWidth: 500,
        maxHeight: 300,
        side: "top",
      }),
    ).toEqual({
      position: "fixed",
      left: 12,
      top: 34,
      right: "auto",
      bottom: "auto",
      maxWidth: 500,
      maxHeight: 300,
      transform: "none",
    });
  });

  it("renders popover-hosting components cleanly in SSR without window dimensions", () => {
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async () => ({}),
        onEvent: () => () => {},
      },
    };
    const settings = {
      ...defaultSettings(),
      language: "en" as const,
      hydraEnabled: true,
      hydraPairs: [
        {
          id: "pair-1",
          provider: "codex" as const,
          orchestratorModel: "gpt-a",
          workerModel: "gpt-b",
          name: "Alpha Combo",
          headProfiles: [],
        },
      ],
    };
    const thread: ChatThread = {
      id: "t-1",
      projectId: null,
      title: "Thread One",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: null,
      sessionGrants: [],
      codexModel: "gpt-a",
    };
    const snapshot: Snapshot = {
      projects: [],
      threads: [thread],
      settings,
      selectedThreadId: thread.id,
      info: {
        appVersion: "test",
        baselineTag: "v3.0.26",
        baselineCommit: "23ac46c6f2e922d62b1a388f3ead7c42260e2dd4",
        dataRoot: "C:/tivano-test",
        providerId: "mock",
        providerLabel: "Mock",
        mock: true,
        mode: "mock",
        realCli: { status: "not-configured" },
        home: "C:/tivano-test",
        worktreesDir: "C:/tivano-test/worktrees",
      },
      rev: 0,
      tokenActivity: {},
    };
    clientStore.snapshot = snapshot;
    const catalog: CodexModelCatalog = {
      state: "ready",
      models: [
        { id: "gpt-a", name: "GPT A", efforts: ["low", "high"], defaultEffort: "low", isDefault: true },
        { id: "gpt-b", name: "GPT B", efforts: ["medium"], defaultEffort: "medium", isDefault: false },
      ],
    };

    const pickerHtml = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: "en" },
        createElement(ModelPicker, {
          thread,
          initialCatalog: catalog,
          initialOpen: true,
        }),
      ),
    );
    expect(pickerHtml).toContain("model-picker-pop two-col");
    expect(pickerHtml).toContain("Alpha Combo");

    const sidebarHtml = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: "en" },
        createElement(Sidebar, {
          snapshot,
          onOpenSettings: () => {},
          onOpenPalette: () => {},
        }),
      ),
    );
    expect(sidebarHtml).toContain("Thread One");

    const chatHtml = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: "en" },
        createElement(ChatView, {
          thread,
          threads: [thread],
          directory: "/repo",
          providerLabel: "Mock",
          mode: "mock",
          settings,
          topControlsExpanded: true,
          onSetTopControlsExpanded: () => {},
        }),
      ),
    );
    expect(chatHtml).toContain("more-controls-menu");

    const modelListHtml = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: "en" },
        createElement(ModelListSettings, {
          initialCatalog: catalog,
        }),
      ),
    );
    expect(modelListHtml).toContain("ml-settings");
  });
});
