// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-40 audit follow-up: Off top-bar plain-helper indicator.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/store";
import { clientStore } from "../src/renderer/client";
import { ChatView } from "../src/renderer/components/ChatView";
import { LanguageContext } from "../src/renderer/locale";
import type { ChatThread, Settings, Snapshot } from "../src/shared/types";

const prevWindow = (globalThis as { window?: unknown }).window;
const prevSnapshot = clientStore.snapshot;
afterEach(() => {
  clientStore.snapshot = prevSnapshot;
  if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = prevWindow;
});

function renderWithLayout(autoOpens: boolean): string {
  (globalThis as { window?: unknown }).window = {
    tivano: { platform: "win32", invoke: async () => ({}), onEvent: () => () => {} },
  };
  const settings: Settings = { ...defaultSettings(), hydraAutoOpensPanels: autoOpens };
  const thread = {
    id: "lead", title: "Lead", projectId: null, createdAt: 1, updatedAt: 2,
    messages: [], turn: null, sessionGrants: [],
  } as ChatThread;
  const helper = {
    ...thread, id: "helper", parentThreadId: "lead", isInPanel: false,
    turn: { status: "running" },
  } as unknown as ChatThread;
  clientStore.snapshot = {
    projects: [], threads: [thread, helper], selectedThreadId: "lead", activeTurns: {}, settings,
  } as unknown as Snapshot;
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: "en" },
      createElement(ChatView, {
        thread, threads: [thread, helper], projects: [], providerLabel: "Mock Provider",
        mode: "mock", directory: "C:\\synthetic\\repo", sidebarCollapsed: true,
        onToggleSidebar: () => {}, settings,
      }),
    ),
  );
}

describe("Off top-bar helper indicator", () => {
  it("appears for a plain helper running outside its panel only under Off", () => {
    expect(renderWithLayout(false)).toContain("helper-working-btn");
    expect(renderWithLayout(false)).toContain('title="Show the sub-agent panel"');
    expect(renderWithLayout(true)).not.toContain("helper-working-btn");
  });
});
