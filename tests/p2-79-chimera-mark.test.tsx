// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-79 component tests: Chimera mark, live running count, adaptive-off
// behavior, and sub-agent panel attributes/focus wiring.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

import { ChatView } from "../src/renderer/components/ChatView";
import { HydraMark, resolveHydraMarkClick } from "../src/renderer/components/HydraMark";
import { LanguageContext } from "../src/renderer/locale";
import type { ChatThread, LanguageId, Settings } from "../src/shared/types";

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

    const globalOffHtml = renderMark({
      thread: makeLead({ subagentMode: "adaptive" }),
      settings: { hydraEnabled: false },
    });
    expect(globalOffHtml).toContain('class="hydra-mark off"');
    expect(globalOffHtml).toContain("Sub-agents are off in Settings");
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

  it("wires live settings into ChatView and makes the sub-agent panel focusable", () => {
    const thread = makeLead();
    const running = makeHead("running");
    const openHtml = renderToStaticMarkup(
      createElement(ChatView, {
        thread,
        threads: [thread, running],
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

    const hiddenHtml = renderToStaticMarkup(
      createElement(ChatView, {
        thread,
        threads: [thread, running],
        providerLabel: "Mock",
        mode: "mock",
        settings: {
          hydraEnabled: true,
          hasSeenHydraIntro: true,
          hydraAutoOpensPanels: false,
        } as Settings,
      }),
    );
    expect(hiddenHtml).toContain('class="hydra-mark chimera"');
    expect(hiddenHtml).toContain('aria-expanded="false"');
    expect(hiddenHtml).not.toContain('class="hydra-panel');
  });

  it("handles click actions across adaptive, Hydra unread intro, and disabled-with-heads states", () => {
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
    // Off with zero heads toggles the switch popover.
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
  });
});
