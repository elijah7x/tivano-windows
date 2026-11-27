// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-79 component tests: Chimera mark, live running count, adaptive-off
// behavior, click routing, panel focus sequence transitions, and archived
// head filtering.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = {
  tivano: {
    platform: "win32",
    invoke: () => Promise.resolve({ editors: [] }),
    onEvent: () => () => {},
  },
  matchMedia: () => ({ matches: true }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as { document?: unknown }).document = {
  documentElement: { dataset: {} },
  hasFocus: () => true,
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
};

import { clientStore } from "../src/renderer/client";
import { ChatView, nextHydraPanelState } from "../src/renderer/components/ChatView";
import { HydraMark, resolveHydraMarkClick } from "../src/renderer/components/HydraMark";
import { HydraPanel } from "../src/renderer/components/HydraPanel";
import { LanguageContext } from "../src/renderer/locale";
import type { ChatThread, LanguageId, Settings, Snapshot } from "../src/shared/types";

const prevSnapshot = clientStore.snapshot;

afterEach(() => {
  clientStore.snapshot = prevSnapshot;
});

const makeLead = (over: Partial<ChatThread> = {}): ChatThread =>
  ({
    id: "lead-p279",
    projectId: null,
    title: "Adaptive lead",
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    turn: null,
    sessionGrants: [],
    hydraEnabled: true,
    subagentMode: "adaptive",
    ...over,
  }) as ChatThread;

let seq = 0;
const makeHead = (
  status: "running" | "completed" | "stopped" | "failed",
  over: Partial<ChatThread> = {},
): ChatThread =>
  ({
    id: `head-p279-${++seq}`,
    projectId: null,
    title: `Head ${seq}`,
    createdAt: seq,
    updatedAt: seq,
    messages: [],
    turn:
      status === "running"
        ? ({ status: "running" } as ChatThread["turn"])
        : null,
    sessionGrants: [],
    hydraHead: {
      leadId: "lead-p279",
      headIndex: seq,
      name: `Role ${seq}`,
      task: "work",
      batchId: "b1",
      status,
      spawnedAt: seq,
    },
    ...over,
  }) as ChatThread;

const renderMark = (
  opts: {
    thread?: ChatThread;
    heads?: ChatThread[];
    settings?: Partial<Settings>;
    panelHidden?: boolean;
    lang?: LanguageId;
  } = {},
) =>
  renderToStaticMarkup(
    createElement(
      LanguageContext.Provider,
      { value: opts.lang ?? "en" },
      createElement(HydraMark, {
        thread: opts.thread ?? makeLead(),
        heads: opts.heads ?? [],
        settings: {
          hydraEnabled: true,
          hasSeenHydraIntro: true,
          ...(opts.settings ?? {}),
        } as Settings,
        panelHidden: opts.panelHidden ?? false,
        onTogglePanel: () => {},
      }),
    ),
  );

describe("P2-79 Chimera mark and sub-agent panel button", () => {
  it("renders the Chimera mark in adaptive mode and omits the count badge when zero heads are running", () => {
    const html = renderMark({ heads: [makeHead("completed")] });
    expect(html).toContain('class="hydra-mark chimera"');
    expect(html).toContain('data-subagent-mode="adaptive"');
    expect(html).toContain("chimera-mark-icon");
    expect(html).not.toContain("hydra-mark-dots");
    expect(html).not.toContain("hydra-mark-badge");
    expect(html).toContain("Adaptive sub-agents");
    expect(html).toContain("Hide the panel");
    expect(html).toContain('aria-expanded="true"');
  });

  it("derives the working count live across 1, 2, archived, and zero running heads", () => {
    const h1 = makeHead("running");
    const h2 = makeHead("running");
    const hArchived = makeHead("running", { isArchived: true });
    const oneHtml = renderMark({ heads: [h1, makeHead("completed")], panelHidden: true });
    expect(oneHtml).toContain('<span class="hydra-mark-badge">1</span>');
    expect(oneHtml).toContain("1 sub-agent working");
    expect(oneHtml).toContain("Show the panel");
    expect(oneHtml).toContain('aria-expanded="false"');

    const twoHtml = renderMark({ heads: [h1, h2, hArchived] });
    expect(twoHtml).toContain('<span class="hydra-mark-badge">2</span>');
    expect(twoHtml).toContain("2 sub-agents working");

    const zeroAfterHtml = renderMark({
      heads: [makeHead("completed"), makeHead("stopped")],
    });
    expect(zeroAfterHtml).not.toContain("hydra-mark-badge");
  });

  it("reverts to the Hydra dots when adaptive is off or sub-agents are disabled", () => {
    const sameHtml = renderMark({ thread: makeLead({ subagentMode: "same" }) });
    expect(sameHtml).toContain("hydra-mark-dots");
    expect(sameHtml).not.toContain("chimera-mark-icon");
    expect(sameHtml).toContain('data-subagent-mode="same"');
    expect(sameHtml).toContain('aria-label="Hydra"');

    const presetHtml = renderMark({ thread: makeLead({ subagentMode: "preset" }) });
    expect(presetHtml).toContain("hydra-mark-dots");
    expect(presetHtml).not.toContain("chimera-mark-icon");

    const chatOffHtml = renderMark({
      thread: makeLead({ subagentMode: "adaptive", hydraEnabled: false }),
    });
    expect(chatOffHtml).toContain('class="hydra-mark off"');
    expect(chatOffHtml).toContain('data-subagent-mode="off"');
    expect(chatOffHtml).not.toContain("chimera-mark-icon");
    expect(chatOffHtml).toContain("Sub-agents are off for this chat");
    expect(chatOffHtml).toContain('aria-label="Sub-agents"');

    const globalOffHtml = renderMark({
      thread: makeLead({ subagentMode: "adaptive" }),
      settings: { hydraEnabled: false },
    });
    expect(globalOffHtml).toContain('class="hydra-mark off"');
    expect(globalOffHtml).toContain("Sub-agents are off in Settings");
    expect(globalOffHtml).toContain('aria-label="Sub-agents"');
    expect(globalOffHtml).not.toContain("chimera-mark-icon");
  });

  it("localizes adaptive tooltips and aria labels in zh-Hans", () => {
    const html = renderMark({
      lang: "zh-Hans",
      heads: [makeHead("running"), makeHead("running")],
      panelHidden: true,
    });
    expect(html).toContain("子代理已开启");
    expect(html).toContain("自适应子代理");
    expect(html).toContain("2 个子代理工作中");
    expect(html).toContain("显示面板");
  });

  it("wires live settings into ChatView (overriding stale clientStore) and excludes archived heads consistently", () => {
    const thread = makeLead();
    const active = makeHead("running");
    const archived = makeHead("running", { isArchived: true });
    clientStore.snapshot = {
      projects: [],
      threads: [thread, active, archived],
      selectedThreadId: thread.id,
      activeTurns: {},
      settings: { hydraEnabled: true, hasSeenHydraIntro: true },
    } as unknown as Snapshot;

    const openHtml = renderToStaticMarkup(
      createElement(ChatView, {
        thread,
        threads: [thread, active, archived],
        providerLabel: "Mock",
        mode: "mock",
        settings: {
          hydraEnabled: true,
          hasSeenHydraIntro: true,
          hydraAutoOpensPanels: true,
        } as Settings,
      }),
    );
    expect(openHtml).toContain('class="hydra-mark chimera"');
    expect(openHtml).toContain('<span class="hydra-mark-badge">1</span>');
    expect(openHtml).toContain('class="hydra-panel" tabindex="-1"');

    // Discriminate on props.settings vs clientStore.snapshot: global off in props overrides enabled store.
    const propsOffHtml = renderToStaticMarkup(
      createElement(ChatView, {
        thread,
        threads: [thread, active],
        providerLabel: "Mock",
        mode: "mock",
        settings: {
          hydraEnabled: false,
          hasSeenHydraIntro: true,
          hydraAutoOpensPanels: false,
        } as Settings,
      }),
    );
    expect(propsOffHtml).toContain('class="hydra-mark off"');
    expect(propsOffHtml).toContain("Sub-agents are off in Settings");
    expect(propsOffHtml).toContain('aria-expanded="false"');
    expect(propsOffHtml).not.toContain('class="hydra-panel');

    // Archived heads are excluded from both HydraMark and HydraPanel.
    const panelHtml = renderToStaticMarkup(
      createElement(HydraPanel, {
        thread,
        threads: [thread, active, archived],
      }),
    );
    expect(panelHtml).toContain("Heads · 1");
    expect(panelHtml).not.toContain(archived.hydraHead!.name);
  });

  it("resets panel focusSeq on hide, dismiss, disable-auto-open, and auto-open so remount never steals composer focus", () => {
    const init = { hidden: true, focusSeq: 0 };
    const shown = nextHydraPanelState(init, "toggle", true);
    expect(shown).toEqual({ hidden: false, focusSeq: 1 });

    // Hiding via toggle clears focusSeq so a later auto-open mounts with focusSeq === 0.
    const hiddenByToggle = nextHydraPanelState(shown, "toggle", true);
    expect(hiddenByToggle).toEqual({ hidden: true, focusSeq: 0 });
    expect(nextHydraPanelState(hiddenByToggle, "auto-open", true)).toEqual({
      hidden: false,
      focusSeq: 0,
    });

    // Opening via pill then dismissing with Escape/menu also clears focusSeq before auto-open.
    const shownByPill = nextHydraPanelState({ hidden: true, focusSeq: 0 }, "pill", true);
    expect(shownByPill).toEqual({ hidden: false, focusSeq: 1 });
    const dismissed = nextHydraPanelState(shownByPill, "dismiss", true);
    expect(dismissed).toEqual({ hidden: true, focusSeq: 0 });
    expect(nextHydraPanelState(dismissed, "auto-open", true)).toEqual({
      hidden: false,
      focusSeq: 0,
    });

    // Turning layout Off or switching threads clears any prior focusSeq.
    expect(nextHydraPanelState(shown, "disable-auto-open", false)).toEqual({
      hidden: true,
      focusSeq: 0,
    });
    expect(nextHydraPanelState(shown, "thread-change", false)).toEqual({
      hidden: true,
      focusSeq: 0,
    });
  });

  it("handles click actions across adaptive, Hydra unread intro, disabled, readOnly, and switch states", () => {
    // Read-only disables clicks regardless of heads or mode.
    expect(
      resolveHydraMarkClick({
        readOnly: true,
        hasHeads: true,
        isOn: true,
        isChimera: true,
        seenIntro: true,
        pop: null,
      }),
    ).toBe("none");
    // Adaptive mode with heads always toggles the panel even when intro is unread.
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: true,
        isOn: true,
        isChimera: true,
        seenIntro: false,
        pop: null,
      }),
    ).toBe("toggle-panel");
    // Disabled / adaptive-off chat with heads and unread intro toggles the panel instead of opening Meet Hydra.
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: true,
        isOn: false,
        isChimera: false,
        seenIntro: false,
        pop: null,
      }),
    ).toBe("toggle-panel");
    // Unread Hydra intro clicks remain idempotent when pop === "intro" is already open (HY-46).
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: true,
        isOn: true,
        isChimera: false,
        seenIntro: false,
        pop: "intro",
      }),
    ).toBe("open-intro");
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: true,
        isChimera: false,
        seenIntro: false,
        pop: "intro",
      }),
    ).toBe("open-intro");
    // Adaptive mode with zero heads toggles the adaptive idle note even before Hydra intro is seen.
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: true,
        isChimera: true,
        seenIntro: false,
        pop: null,
      }),
    ).toBe("open-idle");
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: true,
        isChimera: true,
        seenIntro: false,
        pop: "idle",
      }),
    ).toBe("close-pop");
    // Hydra mode with zero heads and seen intro toggles the Hydra idle explainer.
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: true,
        isChimera: false,
        seenIntro: true,
        pop: null,
      }),
    ).toBe("open-idle");
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: true,
        isChimera: false,
        seenIntro: true,
        pop: "idle",
      }),
    ).toBe("close-pop");
    // Off with zero heads toggles the switch popover open and closed.
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: false,
        isChimera: false,
        seenIntro: false,
        pop: null,
      }),
    ).toBe("open-switch");
    expect(
      resolveHydraMarkClick({
        readOnly: false,
        hasHeads: false,
        isOn: false,
        isChimera: false,
        seenIntro: false,
        pop: "switch",
      }),
    ).toBe("close-pop");
  });
});
