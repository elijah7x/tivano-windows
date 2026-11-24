// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-40 component coverage (frozen floating_panel_checks): the three
// panel layouts render their frozen surfaces — Single docks the team
// panel, Independent pops later running heads, Off hides the panel and
// ends the timeline with a working pill. HelpersWorkingRow parity:
// plain helpers and dismissed panels surface the same pill.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// SSR has no DOM — the bridge stub keeps components that read
// api().platform during render (OpenInMenu) honest under node.
(globalThis as { window?: unknown }).window = {
  tivano: {
    platform: "win32",
    invoke: () => Promise.resolve({ editors: [] }),
    onEvent: () => () => {},
  },
  matchMedia: () => ({ matches: true }),
};
(globalThis as { document?: unknown }).document = {
  documentElement: { dataset: {} },
  hasFocus: () => true,
};
import { ChatView } from "../src/renderer/components/ChatView";
import { HelperPanel } from "../src/renderer/components/HelperPanel";
import { HydraMark } from "../src/renderer/components/HydraMark";
import type { ChatThread, Settings } from "../src/shared/types";

const lead = (over: Partial<ChatThread> = {}): ChatThread =>
  ({
    id: "lead",
    projectId: null,
    title: "Lead chat",
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    turn: null,
    sessionGrants: [],
    ...over,
  }) as ChatThread;

let seq = 0;
const head = (status: "running" | "completed" | "stopped" | "failed"): ChatThread =>
  ({
    id: `head-${++seq}`,
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
      leadId: "lead",
      headIndex: seq,
      name: `Walter ${seq}`,
      task: "work",
      batchId: "b",
      status,
      spawnedAt: seq,
    },
  }) as ChatThread;

const helper = (over: Partial<ChatThread> = {}): ChatThread =>
  ({
    id: `helper-${++seq}`,
    projectId: null,
    title: `Helper ${seq}`,
    createdAt: 100 + seq,
    updatedAt: 100 + seq,
    messages: [],
    turn: { status: "running" } as ChatThread["turn"],
    sessionGrants: [],
    parentThreadId: "lead",
    ...over,
  }) as ChatThread;

const view = (settings: Partial<Settings>, threads: ChatThread[], t: ChatThread) =>
  renderToStaticMarkup(
    createElement(ChatView, {
      thread: t,
      threads,
      providerLabel: "Mock",
      mode: "mock",
      settings: settings as Settings,
    }),
  );

describe("P2-40 floating panel layouts", () => {
  it("Off hides the team panel and shows the working pill for running heads", () => {
    const t = lead();
    const html = view(
      { hydraAutoOpensPanels: false, hydraAutoPopsHeads: false },
      [t, head("running"), head("running")],
      t,
    );
    expect(html).not.toContain('class="hydra-panel');
    expect(html).toContain("hydra-working-pill");
    expect(html).toContain("2 sub-agents working");
  });

  it("Single docks the team panel and pops nothing", () => {
    const t = lead();
    const html = view(
      { hydraAutoOpensPanels: true, hydraAutoPopsHeads: false },
      [t, head("running"), head("running")],
      t,
    );
    expect(html).toContain('class="hydra-panel"');
    expect(html).not.toContain("helper-panel float");
    expect(html).not.toContain("hydra-working-pill");
  });

  it("Independent pops only later RUNNING heads — finished heads never pop", () => {
    const t = lead();
    const html = view(
      { hydraAutoOpensPanels: true, hydraAutoPopsHeads: true },
      [t, head("running"), head("running"), head("completed")],
      t,
    );
    expect(html).toContain('class="hydra-panel"');
    // heads.slice(1) → [running, completed]; only the running one pops.
    const pops = html.match(/helper-panel float/g) ?? [];
    expect(pops).toHaveLength(1);
    expect(html).toContain('data-corner="');
  });

  it("Off covers a plain helper running outside any panel", () => {
    const t = lead();
    const html = view(
      { hydraAutoOpensPanels: false, hydraAutoPopsHeads: false },
      [t, helper({ title: "Walter" })],
      t,
    );
    expect(html).toContain("hydra-working-pill");
    expect(html).toContain("Walter is working");
  });

  it("a folded helper (closeHelper mid-run) still shows the pill under Single", () => {
    const t = lead();
    const html = view(
      { hydraAutoOpensPanels: true, hydraAutoPopsHeads: false },
      [t, helper({ title: "Folded", isInPanel: false })],
      t,
    );
    expect(html).toContain("hydra-working-pill");
    expect(html).toContain("Folded is working");
  });

  it("a paneled helper does not surface the pill", () => {
    const t = lead();
    const html = view(
      { hydraAutoOpensPanels: true, hydraAutoPopsHeads: false },
      [t, helper({ isInPanel: true })],
      t,
    );
    expect(html).not.toContain("hydra-working-pill");
  });
});

describe("P2-40 top-bar indicator", () => {
  it("offers Show the panel while the panel is hidden", () => {
    const t = lead();
    const html = renderToStaticMarkup(
      createElement(HydraMark, {
        thread: t,
        heads: [head("running")],
        panelHidden: true,
        onTogglePanel: () => {},
      }),
    );
    expect(html).toContain("hydra-mark");
    expect(html).toContain("Show the panel");
  });
});

describe("P2-40 panel chrome (close never stops work)", () => {
  const panel = (thread: ChatThread) =>
    renderToStaticMarkup(
      createElement(HelperPanel, {
        thread,
        parentTitle: "Lead chat",
        readOnly: false,
        onDock: () => {},
        onClose: () => {},
      }),
    );

  it("a hydra head reads Sub-agent · parent and closes with Dismiss", () => {
    const html = panel(head("running"));
    expect(html).toContain("Sub-agent · Lead chat");
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain("Move to sidebar");
    // A working head still gets its own stop — Dismiss is separate.
    expect(html).toContain("helper-stop");
  });

  it("a plain helper reads Helper for parent and closes into the sidebar", () => {
    const html = panel(helper({ title: "H" }));
    expect(html).toContain("Helper for Lead chat");
    expect(html).toContain('aria-label="Move to sidebar"');
    expect(html).not.toContain("Dismiss");
  });
});
