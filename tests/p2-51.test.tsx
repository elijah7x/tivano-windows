// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-51 component and behavior tests: 12 named accent colors + appearance
// split circle, single Copy / Copy all message right-click menu (code
// blocks keep their own copy button), and chat header More controls
// keeping expanded state across chat switches.

import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMImplementation } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

// Stub window/document for SSR renders of ChatView / OpenInItems / MessagePopover.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1280,
    innerHeight: 800,
    tivano: {
      platform: "win32",
      invoke: () => Promise.resolve({ editors: [] }),
      onEvent: () => () => {},
    },
    matchMedia: () => ({ matches: true }),
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

import { LanguageContext } from "../src/renderer/locale";
import {
  AppearanceSplitCircleButton,
  ThemePicker,
} from "../src/renderer/components/ThemePicker";
import {
  MessagePopover,
  markdownMessageText,
} from "../src/renderer/components/MessagePopover";
import { clientStore } from "../src/renderer/client";
import { ChatView } from "../src/renderer/components/ChatView";
import { CommandPalette } from "../src/renderer/components/CommandPalette";
import { HydraPanel } from "../src/renderer/components/HydraPanel";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { renderMarkdown } from "../src/renderer/markdown";
import type { ChatThread, LanguageId, Project, Settings } from "../src/shared/types";

function renderInLang(lang: LanguageId, node: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, node),
  );
}

const makeThread = (id: string, title: string): ChatThread =>
  ({
    id,
    projectId: "proj-1",
    title,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    turn: null,
    sessionGrants: [],
  }) as ChatThread;

const sampleProject: Project = {
  id: "proj-1",
  name: "Demo",
  createdAt: 1,
  expanded: true,
  scripts: [
    {
      id: "s-1",
      name: "Test",
      command: "npm test",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ],
};

describe("P2-51 accent colors & appearance toggle", () => {
  it("renders localized accent name and appearance split circle in en and zh-Hans", () => {
    const enPicker = renderInLang(
      "en",
      createElement(ThemePicker, {
        value: "breeze",
        appearanceMode: "system",
        osDark: true,
        onChange: () => {},
      }),
    );
    expect(enPicker).toContain("Avocado");
    expect(enPicker).toContain("#7BA58F");

    const zhPicker = renderInLang(
      "zh-Hans",
      createElement(ThemePicker, {
        value: "claude",
        appearanceMode: "light",
        osDark: false,
        onChange: () => {},
      }),
    );
    expect(zhPicker).toContain("珊瑚红");
    expect(zhPicker).toContain("#B5654A");

    const enSplitSys = renderInLang(
      "en",
      createElement(AppearanceSplitCircleButton, {
        mode: "system",
        onChange: () => {},
      }),
    );
    expect(enSplitSys).toContain('title="Match System"');
    expect(enSplitSys).toContain('data-appearance-mode="system"');

    const zhSplitDark = renderInLang(
      "zh-Hans",
      createElement(AppearanceSplitCircleButton, {
        mode: "dark",
        onChange: () => {},
      }),
    );
    expect(zhSplitDark).toContain('title="深色"');
    expect(zhSplitDark).toContain('data-appearance-mode="dark"');

    const osAccentPicker = renderInLang(
      "en",
      createElement(ThemePicker, {
        value: "system",
        appearanceMode: "light",
        osDark: false,
        systemAccentHex: "D13438",
        onChange: () => {},
      }),
    );
    expect(osAccentPicker).toContain("System Accent");
    expect(osAccentPicker).toContain("#D13438");
    expect(osAccentPicker).not.toContain("#0A6DFF");
  });
});

describe("P2-51 message right-click Copy / Copy all menu", () => {
  const baseState = {
    text: "Hello **world**\n\n```ts\nconst x = 1;\n```",
    role: "assistant" as const,
    threadId: "t-1",
    messageId: "m-1",
    x: 100,
    y: 120,
  };

  it("shows Copy all when nothing is selected and omits retired copy rows", () => {
    const html = renderInLang(
      "en",
      createElement(MessagePopover, {
        state: { ...baseState, selection: null },
        onClose: () => {},
      }),
    );
    expect(html).toContain("Copy all");
    expect(html).toContain("Add to reply");
    expect(html).not.toContain("Copy message as markdown");
    expect(html).not.toContain("Copy last code block");

    const zhHtml = renderInLang(
      "zh-Hans",
      createElement(MessagePopover, {
        state: { ...baseState, selection: null },
        onClose: () => {},
      }),
    );
    expect(zhHtml).toContain("复制全文");
    expect(zhHtml).toContain("添加到回复");
  });

  it("shows Copy when a selection is active", () => {
    const html = renderInLang(
      "en",
      createElement(MessagePopover, {
        state: { ...baseState, selection: "world" },
        onClose: () => {},
      }),
    );
    expect(html).toContain(">Copy<");
    expect(html).not.toContain("Copy all");

    const zhHtml = renderInLang(
      "zh-Hans",
      createElement(MessagePopover, {
        state: { ...baseState, selection: "world" },
        onClose: () => {},
      }),
    );
    expect(zhHtml).toContain(">复制<");
    expect(zhHtml).not.toContain("复制全文");
  });

  it("user prompt keeps Edit from here and Rewind to this turn alongside Copy all", () => {
    const html = renderInLang(
      "en",
      createElement(MessagePopover, {
        state: {
          ...baseState,
          role: "user",
          turnId: "turn-1",
          selection: null,
        },
        onClose: () => {},
      }),
    );
    expect(html).toContain("Copy all");
    expect(html).toContain("Edit from here");
    expect(html).toContain("Rewind to this turn");
    expect(html).not.toContain("Copy message as markdown");
  });

  it("markdownMessageText keeps markdown + code blocks and strips hydra delegation fences", () => {
    const source = [
      "Intro **bold**",
      "",
      "```hydra-sent",
      '{"task":"delegate"}',
      "```",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
    ].join("\n");
    expect(markdownMessageText(source)).toBe(
      "Intro **bold**\n\n\n```ts\nconst a = 1;\n```",
    );
  });

  it("code blocks keep their own Copy button", () => {
    const codeHtml = renderToStaticMarkup(
      createElement("div", null, renderMarkdown("```ts\nconst x = 1;\n```", {
        copy: "Copy",
        copied: "Copied",
      })),
    );
    expect(codeHtml).toContain('data-md-copy="1"');
    expect(codeHtml).toContain(">Copy<");
  });
});

describe("P2-51 persistent chat header More controls", () => {
  it("hides secondary controls when collapsed and keeps expanded state across chat switches", () => {
    const threadA = makeThread("t-a", "Chat A");
    const threadB = makeThread("t-b", "Chat B");
    const settings = { theme: "breeze", language: "en", alwaysAllow: [] } as Settings;

    const collapsedHtml = renderInLang(
      "en",
      createElement(ChatView, {
        thread: threadA,
        threads: [threadA, threadB],
        project: sampleProject,
        projects: [sampleProject],
        directory: "/repo",
        providerLabel: "Mock",
        mode: "mock",
        dock: null,
        onToggleDock: () => {},
        settings,
        topControlsExpanded: false,
        onSetTopControlsExpanded: () => {},
      }),
    );
    expect(collapsedHtml).toContain("more-controls-btn");
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).toContain('aria-label="More controls"');
    expect(collapsedHtml).toContain("Terminal");
    expect(collapsedHtml).not.toContain("more-controls-menu");
    expect(collapsedHtml).not.toContain("Forward to new thread");

    const expandedChatBHtml = renderInLang(
      "zh-Hans",
      createElement(ChatView, {
        thread: threadB,
        threads: [threadA, threadB],
        project: sampleProject,
        projects: [sampleProject],
        directory: "/repo",
        providerLabel: "Mock",
        mode: "mock",
        dock: null,
        onToggleDock: () => {},
        settings,
        topControlsExpanded: true,
        onSetTopControlsExpanded: () => {},
      }),
    );
    expect(expandedChatBHtml).toContain("more-controls-btn active");
    expect(expandedChatBHtml).toContain('aria-expanded="true"');
    expect(expandedChatBHtml).toContain('aria-label="更多控件"');
    expect(expandedChatBHtml).toContain("more-controls-menu");
    expect(expandedChatBHtml).toContain("转发到新对话");
    expect(expandedChatBHtml).toContain("线程 worktree");
    expect(expandedChatBHtml).toContain("脚本");
  });

  it("keeps shell-owned expanded state through a stateful thread-switch control press", async () => {
    const threadA = makeThread("t-a", "Chat A");
    const threadB = makeThread("t-b", "Chat B");
    type Listener = (event: { target?: unknown; key?: string }) => void;
    const listeners = new Map<string, Set<Listener>>();
    const addListener = (type: string, fn: Listener) => {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(fn);
      listeners.set(type, bucket);
    };
    const removeListener = (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    };
    const doc = new DOMImplementation().createDocument(null, "html", null) as unknown as Document;
    const originalCreateTextNode = doc.createTextNode.bind(doc);
    Object.defineProperty(doc, "createTextNode", {
      configurable: true,
      value: (data: string) => {
        const node = originalCreateTextNode(data) as unknown as { data: string };
        Object.defineProperty(node, "nodeValue", {
          configurable: true,
          get: () => node.data,
          set: (value: string) => {
            node.data = String(value);
          },
        });
        return node;
      },
    });
    const originalCreateElement = doc.createElement.bind(doc);
    Object.defineProperty(doc, "createElement", {
      configurable: true,
      value: (tagName: string) => {
        const el = originalCreateElement(tagName) as unknown as {
          contains?: (other: unknown) => boolean;
          closest?: (selector: string) => unknown;
          parentNode?: unknown;
        };
        Object.defineProperty(el, "contains", {
          configurable: true,
          value: (other: unknown) => {
            let node = other as { parentNode?: unknown } | null;
            while (node) {
              if (node === el) return true;
              node = (node.parentNode ?? null) as { parentNode?: unknown } | null;
            }
            return false;
          },
        });
        Object.defineProperty(el, "closest", {
          configurable: true,
          value: (selector: string) => {
            const matches = (candidate: unknown): boolean => {
              const node = candidate as {
                nodeType?: number;
                getAttribute?: (name: string) => string | null;
                hasAttribute?: (name: string) => boolean;
              };
              if (!node || node.nodeType !== 1 || typeof node.getAttribute !== "function") return false;
              if (selector === "[data-thread-switch]") return node.hasAttribute?.("data-thread-switch") === true;
              if (selector.startsWith("."))
                return (node.getAttribute("class") ?? "").split(/\s+/).includes(selector.slice(1));
              return false;
            };
            let node: unknown = el;
            while (node) {
              if (matches(node)) return node;
              node = (node as { parentNode?: unknown }).parentNode ?? null;
            }
            return null;
          },
        });
        Object.defineProperty(el, "querySelector", { configurable: true, value: () => null });
        Object.defineProperty(el, "querySelectorAll", { configurable: true, value: () => [] });
        Object.defineProperty(el, "scrollIntoView", { configurable: true, value: () => {} });
        Object.defineProperty(el, "getBoundingClientRect", {
          configurable: true,
          value: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        });
        Object.defineProperty(el, "style", { configurable: true, value: {} });
        Object.defineProperty(el, "addEventListener", { configurable: true, value: () => {} });
        Object.defineProperty(el, "removeEventListener", { configurable: true, value: () => {} });
        Object.defineProperty(el, "dispatchEvent", { configurable: true, value: () => true });
        Object.defineProperty(el, "children", {
          configurable: true,
          get: () => (el as unknown as { childNodes: ArrayLike<unknown> }).childNodes,
        });
        Object.defineProperty(el, "options", {
          configurable: true,
          get: () => (el as unknown as { childNodes: ArrayLike<unknown> }).childNodes,
        });
        return el;
      },
    });
    const head = doc.createElement("head");
    const body = doc.createElement("body");
    doc.documentElement.appendChild(head);
    doc.documentElement.appendChild(body);
    Object.defineProperty(doc, "head", { configurable: true, value: head });
    Object.defineProperty(doc, "body", { configurable: true, value: body });
    Object.defineProperty(doc, "addEventListener", { configurable: true, value: () => {} });
    Object.defineProperty(doc, "removeEventListener", { configurable: true, value: () => {} });
    Object.defineProperty(doc, "dispatchEvent", { configurable: true, value: () => true });
    function HTMLIFrameElement(): void {}
    const testWindow = {
      document: doc,
      HTMLIFrameElement,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: addListener,
      removeEventListener: removeListener,
      dispatchEvent: () => true,
      setTimeout,
      clearTimeout,
      tivano: {
        platform: "win32",
        invoke: (channel: string) => {
          if (channel === "checkpoints:changes") return Promise.resolve(null);
          if (channel === "checkpoints:list") return Promise.resolve([]);
          return Promise.resolve({ editors: [] });
        },
        onEvent: () => () => {},
      },
      matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
      getSelection: () => null,
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    };
    Object.defineProperty(doc, "defaultView", { configurable: true, value: testWindow });
    const globals = globalThis as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevAct = globals.IS_REACT_ACT_ENVIRONMENT;
    const prevClientSnapshot = clientStore.snapshot;
    const prevRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    const prevCancelRaf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    globals.window = testWindow;
    globals.document = doc;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = testWindow.requestAnimationFrame;
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = testWindow.cancelAnimationFrame;
    clientStore.snapshot = {
      projects: [],
      threads: [threadA, threadB],
      selectedThreadId: threadA.id,
      activeTurns: {},
      settings: { theme: "breeze", language: "en", alwaysAllow: [], hasSeenHydraIntro: true },
    } as unknown as typeof clientStore.snapshot;

    let switchToB: (() => void) | null = null;
    function Harness(): React.ReactElement {
      // Same ownership shape as App: the shell holds both the selected thread
      // and the More-controls expansion, passing them into ChatView together.
      const [expanded, setExpanded] = useState(true);
      const [threadId, setThreadId] = useState(threadA.id);
      const thread = threadId === threadA.id ? threadA : threadB;
      const selectThread = (id: string) => setThreadId(id);
      switchToB = () => selectThread(threadB.id);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            "data-thread-switch": "true",
            onClick: () => selectThread(threadB.id),
          },
          "switch thread",
        ),
        createElement(ChatView, {
          thread,
          threads: [threadA, threadB],
          project: null,
          projects: [],
          directory: "/repo",
          providerLabel: "Mock",
          mode: "mock",
          dock: null,
          onToggleDock: () => {},
          settings: { theme: "breeze", language: "en", alwaysAllow: [] } as Settings,
          topControlsExpanded: expanded,
          onSetTopControlsExpanded: setExpanded,
        }),
      );
    }

    const container = doc.createElement("div") as unknown as Element;
    Object.defineProperty(container, "addEventListener", { configurable: true, value: () => {} });
    Object.defineProperty(container, "removeEventListener", { configurable: true, value: () => {} });
    Object.defineProperty(container, "dispatchEvent", { configurable: true, value: () => true });
    body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      expect(container.textContent).toContain("Forward to new thread");
      expect(container.textContent).toContain("Chat A");

      const switchControl = (container as unknown as {
        getElementsByTagName: (name: string) => ArrayLike<Element>;
      }).getElementsByTagName("button")[0] as Element;
      expect(switchControl.getAttribute("data-thread-switch")).toBe("true");
      await act(async () => {
        for (const fn of listeners.get("mousedown") ?? []) fn({ target: switchControl });
        // In the real controls this same press invokes threads:select/click after
        // mousedown; here the shell setter is the App-level thread-switch path.
        switchToB?.();
      });
      expect(container.textContent).toContain("Forward to new thread");
      expect(container.textContent).toContain("Chat B");

      const ordinaryOutside = doc.createElement("div") as unknown as Element;
      await act(async () => {
        for (const fn of listeners.get("mousedown") ?? []) fn({ target: ordinaryOutside });
      });
      expect(container.textContent).not.toContain("Forward to new thread");
      await act(async () => {
        root.unmount();
      });
    } finally {
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevAct === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
      else globals.IS_REACT_ACT_ENVIRONMENT = prevAct;
      if (prevRaf === undefined) delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      else (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = prevRaf;
      if (prevCancelRaf === undefined) delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
      else (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = prevCancelRaf;
      clientStore.snapshot = prevClientSnapshot;
    }
  });

  it("marks real thread-switch controls in the sidebar, command palette, and Hydra panel", () => {
    const paletteMarkup = renderInLang(
      "en",
      createElement(CommandPalette, {
        snapshot: {
          projects: [],
          threads: [makeThread("t-palette", "Palette target")],
          selectedThreadId: null,
          activeTurns: {},
          settings: { theme: "breeze", language: "en", alwaysAllow: [] },
        } as never,
        selectedThreadId: null,
        onClose: () => {},
        onToggleDock: () => {},
        onToggleChanges: () => {},
        onOpenSettings: () => {},
      }),
    );
    expect(paletteMarkup).toContain('data-thread-switch="true"');
    expect(paletteMarkup).toContain("palette-item");

    const sidebarThread = makeThread("t-sidebar", "Sidebar target");
    const sidebarMarkup = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot: {
          projects: [sampleProject],
          threads: [sidebarThread],
          selectedThreadId: sidebarThread.id,
          activeTurns: {},
          settings: { theme: "breeze", language: "en", alwaysAllow: [] },
          info: null,
          rev: 0,
        } as never,
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(sidebarMarkup).toContain('data-thread-id="t-sidebar"');
    expect(sidebarMarkup).toContain('data-thread-switch="true"');

    const lead = makeThread("t-lead", "Hydra lead");
    const head = {
      ...makeThread("t-head", "Hydra head"),
      hydraHead: {
        leadId: lead.id,
        headIndex: 0,
        name: "Builder",
        task: "Synthetic head task",
        batchId: "t-head",
        status: "completed",
        spawnedAt: 2,
      },
    } as ChatThread;
    const hydraMarkup = renderInLang(
      "en",
      createElement(HydraPanel, {
        thread: lead,
        threads: [lead, head],
      }),
    );
    expect(hydraMarkup).toContain("hydra-open");
    expect(hydraMarkup).toContain('data-thread-switch="true"');
  });
});
