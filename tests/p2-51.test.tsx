// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-51 component and behavior tests: 12 named accent colors + appearance
// split circle, single Copy / Copy all message right-click menu (code
// blocks keep their own copy button), and chat header More controls
// keeping expanded state across chat switches.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import { ChatView } from "../src/renderer/components/ChatView";
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
});
