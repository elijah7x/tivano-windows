// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-54 component tests: Settings > Connections chip consolidation +
// Settings > Storage reorganization in English and zh-Hans.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageContext } from "../src/renderer/locale";
import { McpSection } from "../src/renderer/components/McpSection";
import { StorageSection } from "../src/renderer/components/StorageSection";
import { SettingsModal } from "../src/renderer/components/SettingsModal";
import { defaultSettings } from "../src/main/store";
import type {
  AppInfo,
  ChatThread,
  Project,
  Settings,
} from "../src/shared/types";
import type { StorageUsageReport } from "../src/shared/storage";

const renderIn = (lang: "en" | "zh-Hans", node: React.ReactElement) =>
  renderToStaticMarkup(createElement(LanguageContext.Provider, { value: lang }, node));

const baseInfo: AppInfo = {
  appVersion: "0.1.0",
  providerId: "mock",
  providerLabel: "Mock provider",
  mock: true,
  mode: "mock",
  realCli: { status: "not-configured" },
  baselineTag: "v3.0.0",
  baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
  dataRoot: "C:/synthetic/data",
  home: "C:/synthetic/home",
  worktreesDir: "C:/synthetic/data/worktrees",
};

const sampleProjects: Project[] = [
  { id: "p1", name: "Repo Alpha", createdAt: 1000, expanded: true },
];

const sampleThreads: ChatThread[] = Array.from({ length: 7 }, (_, i) => ({
  id: `t-${i}`,
  projectId: "p1",
  title: `Archived chat ${i}`,
  isArchived: true,
  createdAt: 1000 + i * 100,
  updatedAt: 2000 + i * 100,
  messages: [],
  turn: null,
  sessionGrants: [],
}));

const sampleUsage: StorageUsageReport = {
  chatsBytes: 4000,
  attachmentsBytes: 1000,
  patchesBytes: 0,
  diagnostics: { totalBytes: 500, cleanableBytes: 300, supported: true },
  updates: { totalBytes: 0, cleanableBytes: 0, supported: false },
  worktrees: [
    {
      id: "p1/wt-1",
      name: "wt-1",
      sizeBytes: 6000,
      buildFilesSizeBytes: 2500,
      buildFolderCount: 1,
      isRegistered: true,
      changedFiles: 1,
      branch: "feat/demo",
      lastCommitAt: null,
      isIdle: true,
      canRemove: false,
      removeReason: "uncommitted-changes",
      usedByThreadTitle: null,
      usedByArchived: false,
    },
  ],
  worktreesDir: "C:/synthetic/data/worktrees",
};

describe("McpSection compact chips (P2-54)", () => {
  it("renders connected servers on top, category chips, chip summaries, and + Custom last", () => {
    const settings: Settings = {
      ...defaultSettings(),
      mcpServers: [
        {
          id: "fetch",
          name: "Fetch",
          transport: "stdio",
          command: "uvx",
          args: ["mcp-server-fetch"],
        },
      ],
    };

    const html = renderIn("en", createElement(McpSection, { settings, home: "C:/home" }));
    expect(html).toContain("Connected servers take priority");
    expect(html).toContain('data-testid="mcp-connected-list"');
    expect(html).toContain('data-server="fetch"');
    expect(html).toContain('data-testid="mcp-chip-wall"');
    expect(html).toContain("Developer");
    expect(html).toContain("Drives a real browser");
    expect(html.endsWith("Custom</button></div><p class=\"codex-note\">Connected servers reach every provider")).toBe(false);
    const chipWallEnd = html.indexOf('data-testid="mcp-custom-chip"');
    const lastCatalogChip = html.lastIndexOf('data-entry=');
    expect(chipWallEnd).toBeGreaterThan(lastCatalogChip);

    const zhHtml = renderIn(
      "zh-Hans",
      createElement(McpSection, {
        settings: { ...settings, language: "zh-Hans" },
        home: "C:/home",
      }),
    );
    expect(zhHtml).toContain("优先使用已连接的服务器");
    expect(zhHtml).toContain("添加服务器");
    expect(zhHtml).toContain("自定义");
  });
});

describe("StorageSection reorganized UI (P2-54)", () => {
  it("renders overview Free up button, 5 latest archived chats, worktree summary, and advanced toggle", () => {
    const settings: Settings = { ...defaultSettings(), language: "en" };
    const html = renderIn(
      "en",
      createElement(StorageSection, {
        threads: sampleThreads,
        projects: sampleProjects,
        settings,
        worktreesDir: baseInfo.worktreesDir,
        initialUsage: sampleUsage,
      }),
    );

    expect(html).toContain("Tivano data");
    expect(html).toContain("Free up 2.8 KB…");
    expect(html).toContain("Find a chat");
    // Only 5 latest archived chats shown inline (t-6..t-2), not t-0
    expect(html).toContain("Archived chat 6");
    expect(html).not.toContain("Archived chat 0");
    expect(html).toContain("Show all 7 archived chats");
    expect(html).toContain("1 worktrees");
    expect(html).toContain("1 not used by an active chat");
    expect(html).toContain("1 with uncommitted changes");
    expect(html).toContain("Start review chat");
    expect(html).toContain("Diagnostics and update files");

    const zhHtml = renderIn(
      "zh-Hans",
      createElement(StorageSection, {
        threads: sampleThreads,
        projects: sampleProjects,
        settings: { ...settings, language: "zh-Hans" },
        worktreesDir: baseInfo.worktreesDir,
        initialUsage: sampleUsage,
      }),
    );
    expect(zhHtml).toContain("Tivano 数据");
    expect(zhHtml).toContain("释放 2.8 KB…");
    expect(zhHtml).toContain("显示全部 7 个已归档对话");
    expect(zhHtml).toContain("开始检查对话");
    expect(zhHtml).toContain("诊断与更新文件");
  });
});

describe("SettingsModal Connections + Storage consolidation (P2-54)", () => {
  it("places Local control, Remote MCP, and Code hosts inside Connections and replaces Archive with Storage", () => {
    const settings: Settings = { ...defaultSettings(), language: "en" };
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async () => ({}),
        onEvent: () => () => {},
      },
    };
    let html = "";
    try {
      html = renderIn(
        "en",
        createElement(SettingsModal, {
          settings,
          info: baseInfo,
          threads: sampleThreads,
          projects: sampleProjects,
          tokenActivity: {},
          onClose: () => {},
        }),
      );
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWindow;
    }

    const connStart = html.indexOf('data-testid="connections-section"');
    const alphaStart = html.indexOf("<h3>Alpha</h3>");
    const lcPos = html.indexOf('data-testid="local-control-section"');
    const rmPos = html.indexOf('data-testid="remote-mcp-section"');
    const forgePos = html.indexOf('data-testid="forge-section"');
    expect(connStart).toBeGreaterThan(-1);
    expect(lcPos).toBeGreaterThan(connStart);
    expect(rmPos).toBeGreaterThan(connStart);
    expect(forgePos).toBeGreaterThan(connStart);
    expect(forgePos).toBeLessThan(alphaStart);
    expect(html).toContain("Code hosts");
    expect(html).toContain("<h3>Storage</h3>");
    expect(html).not.toContain("<h3>Archive</h3>");
  });
});
