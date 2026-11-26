// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-50 component and unit tests: WelcomeView (Work in a project / Just chat,
// folded expandable ready-provider strip, Install a coding agent first when
// 0 providers are ready, Start a chat gated until a provider is ready),
// NoThreadView fallback once a project/thread exists, ChatView routing, and
// en / zh-Hans / zh-Hant / ja / ko / fr localization.

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerProvider } from "../src/main/codexAppServerProvider";
import { resolveCodexHome, type CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import { Engine } from "../src/main/engine";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { defaultSettings, Store } from "../src/main/store";
import { ChatView } from "../src/renderer/components/ChatView";
import {
  CODEX_INSTALL_URL,
  NoThreadView,
  ProviderChecklist,
  WelcomeView,
  isProviderReady,
  resolveWelcomeProviders,
  type WelcomeProviderStatus,
} from "../src/renderer/components/WelcomeView";
import { translate } from "../src/renderer/i18n";
import { LanguageContext } from "../src/renderer/locale";
import type {
  AppInfo,
  ChatThread,
  CodexSetupState,
  LanguageId,
  Project,
  Settings,
} from "../src/shared/types";

const prevWindow = (globalThis as { window?: unknown }).window;

function stubWindow(platform: "win32" | "darwin" = "win32"): void {
  (globalThis as { window?: unknown }).window = {
    tivano: {
      platform,
      invoke: async () => ({}),
      onEvent: () => () => {},
    },
  };
}

function renderInLang(lang: LanguageId, node: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, node),
  );
}

function baseInfo(over: Partial<AppInfo> = {}): AppInfo {
  return {
    appVersion: "0.3.0",
    baselineTag: "v3.0.0",
    baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
    dataRoot: "C:\\synthetic\\data",
    providerId: "mock",
    providerLabel: "Mock Provider",
    mock: true,
    mode: "mock",
    realCli: { status: "not-configured" },
    home: "C:\\synthetic\\home",
    worktreesDir: "C:\\synthetic\\data\\worktrees",
    ...over,
  };
}

afterEach(() => {
  if (prevWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

describe("P2-50 first-launch WelcomeView & readiness rules", () => {
  it("resolves provider readiness accurately across mock, synthetic-stdio, and codex states", () => {
    const mockProviders = resolveWelcomeProviders(baseInfo({ mode: "mock" }));
    expect(mockProviders.filter(isProviderReady).map((p) => p.id)).toEqual(["mock"]);
    expect(mockProviders.find((p) => p.id === "codex")?.isInstalled).toBe(false);

    const stdioProviders = resolveWelcomeProviders(
      baseInfo({
        mode: "synthetic-stdio",
        providerId: "synthetic-stdio",
        providerLabel: "Synthetic stdio",
      }),
    );
    expect(stdioProviders.filter(isProviderReady).map((p) => p.id)).toEqual([
      "synthetic-stdio",
    ]);

    const codexFixture = resolveWelcomeProviders(
      baseInfo({
        mode: "codex",
        providerId: "codex",
        providerLabel: "Codex",
        codex: {
          state: "fixture",
          protocolPin: "0.164.0+6aaac694",
          cliVersion: "unknown",
        },
      }),
    );
    expect(codexFixture.filter(isProviderReady)).toHaveLength(1);

    const codexConfigured = resolveWelcomeProviders(
      baseInfo({
        mode: "codex",
        providerId: "codex",
        providerLabel: "Codex",
        codex: {
          state: "configured-unverified",
          protocolPin: "0.164.0+6aaac694",
          cliVersion: "unknown",
        },
      }),
    );
    expect(codexConfigured.filter(isProviderReady)).toHaveLength(1);

    const codexUnconfigured = resolveWelcomeProviders(
      baseInfo({
        mode: "codex",
        providerId: "codex",
        providerLabel: "Codex",
        codex: {
          state: "unconfigured",
          protocolPin: "0.164.0+6aaac694",
          cliVersion: "unknown",
        },
      }),
    );
    expect(codexUnconfigured.filter(isProviderReady)).toHaveLength(0);
    expect(codexUnconfigured[0]?.installURL).toBe(CODEX_INSTALL_URL);

    const codexPendingRestart = resolveWelcomeProviders(
      baseInfo({
        mode: "codex",
        providerId: "codex",
        providerLabel: "Codex",
        codex: {
          state: "unconfigured",
          protocolPin: "0.164.0+6aaac694",
          cliVersion: "unknown",
        },
      }),
      {
        savedExecutable: "C:\\synthetic\\codex.exe",
        pendingExecutable: null,
        chooserBusy: false,
        providerOverride: null,
        launchProvider: "codex",
        effectiveSource: "none",
        effectiveExecutable: null,
        savedEffect: "pending-restart",
        runtime: null,
        mutable: true,
      } satisfies CodexSetupState,
    );
    expect(codexPendingRestart[0]?.statusSummary).toBe("Takes effect on next launch");
  });

  it("renders the two-option WelcomeView with collapsed 1-provider strip when ready", () => {
    stubWindow();
    const html = renderInLang(
      "en",
      createElement(WelcomeView, {
        info: baseInfo({ mode: "mock" }),
        onOpenSettings: () => {},
      }),
    );
    expect(html).toContain("Where shall we begin today?");
    expect(html).toContain("Work in a project");
    expect(html).toContain("Add a project folder");
    expect(html).toContain("Just chat");
    expect(html).toContain("Start a chat");
    expect(html).toContain("1 provider ready");
    expect(html).toContain("Manage");
    expect(html).toContain('aria-expanded="false"');
    // Collapsed by default: the checklist itself is folded away until expanded.
    expect(html).not.toContain('id="welcome-provider-checklist"');
    expect(html).not.toContain("Install a coding agent first");
    // Start a chat must NOT be disabled when a provider is ready.
    expect(html).toMatch(/data-testid="welcome-start-chat"(?![^>]*disabled)/);

    // Expanding shows the checklist rows.
    const expandedHtml = renderInLang(
      "en",
      createElement(WelcomeView, {
        info: baseInfo({ mode: "mock" }),
        defaultExpanded: true,
        onOpenSettings: () => {},
      }),
    );
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain('id="welcome-provider-checklist"');
    expect(expandedHtml).toContain("Mock Provider");
    expect(expandedHtml).toContain("Codex");
    expect(expandedHtml).toContain("Install");
  });

  it("lists what to install and disables Start a chat when no provider is ready", () => {
    stubWindow();
    const html = renderInLang(
      "en",
      createElement(WelcomeView, {
        info: baseInfo({
          mode: "codex",
          providerId: "codex",
          providerLabel: "Codex",
          codex: {
            state: "unconfigured",
            protocolPin: "0.164.0+6aaac694",
            cliVersion: "unknown",
          },
        }),
        onOpenSettings: () => {},
      }),
    );
    expect(html).toContain("Install a coding agent first");
    expect(html).toContain("Codex");
    expect(html).toContain("Install");
    expect(html).not.toContain("1 provider ready");
    // Start a chat is disabled while no provider is ready; Add a project folder stays enabled.
    expect(html).toMatch(/data-testid="welcome-start-chat"[^>]*disabled=""/);
    expect(html).toMatch(/data-testid="welcome-add-project"(?![^>]*disabled)/);
  });

  it("keeps Start a chat disabled while providers are checking, and formats N providers ready", () => {
    stubWindow();
    const checkingProviders: WelcomeProviderStatus[] = [
      {
        id: "codex",
        name: "Codex",
        routePrefix: "Codex CLI",
        routeKey: "ChatGPT plan or API key",
        statusSummary: "Checking…",
        isChecking: true,
        isInstalled: false,
        auth: "signedOut",
      },
    ];
    const checkingHtml = renderInLang(
      "en",
      createElement(WelcomeView, {
        info: baseInfo(),
        providers: checkingProviders,
      }),
    );
    expect(checkingHtml).toMatch(/data-testid="welcome-start-chat"[^>]*disabled=""/);
    expect(checkingHtml).not.toContain("Install a coding agent first");
    expect(checkingHtml).toContain("Checking…");

    const twoReady: WelcomeProviderStatus[] = [
      {
        id: "codex",
        name: "Codex",
        routePrefix: "Codex CLI",
        routeKey: "ChatGPT plan or API key",
        statusSummary: "Ready",
        isChecking: false,
        isInstalled: true,
        auth: "signedIn",
      },
      {
        id: "mock",
        name: "Mock Provider",
        routeKey: "Synthetic provider",
        statusSummary: "Ready",
        isChecking: false,
        isInstalled: true,
        auth: "signedIn",
      },
    ];
    const twoHtml = renderInLang(
      "en",
      createElement(WelcomeView, {
        info: baseInfo(),
        providers: twoReady,
      }),
    );
    expect(twoHtml).toContain("2 providers ready");
    expect(twoHtml).toMatch(/data-testid="welcome-start-chat"(?![^>]*disabled)/);

    const checklistHtml = renderInLang(
      "en",
      createElement(ProviderChecklist, { providers: checkingProviders }),
    );
    expect(checklistHtml).toContain("Checking…");
  });

  it("routes ChatView empty state to WelcomeView on first launch and NoThreadView once data exists", () => {
    stubWindow();
    const settings: Settings = { ...defaultSettings(), language: "en" };

    const firstLaunch = renderInLang(
      "en",
      createElement(ChatView, {
        thread: null,
        threads: [],
        projects: [],
        providerLabel: "Mock Provider",
        mode: "mock",
        settings,
      }),
    );
    expect(firstLaunch).toContain('data-testid="welcome-view"');
    expect(firstLaunch).toContain("Where shall we begin today?");
    expect(firstLaunch).not.toContain('data-testid="no-thread-view"');

    const withProject = renderInLang(
      "en",
      createElement(ChatView, {
        thread: null,
        threads: [],
        projects: [{ id: "p1", name: "Proj", createdAt: 1, expanded: true } satisfies Project],
        providerLabel: "Mock Provider",
        mode: "mock",
        settings,
      }),
    );
    expect(withProject).toContain('data-testid="no-thread-view"');
    expect(withProject).toContain("Pick a thread or start a new one");
    expect(withProject).toContain("New thread");
    expect(withProject).not.toContain('data-testid="welcome-view"');

    const withArchivedThread = renderInLang(
      "en",
      createElement(ChatView, {
        thread: null,
        threads: [
          {
            id: "t1",
            projectId: null,
            title: "Archived",
            createdAt: 1,
            updatedAt: 1,
            messages: [],
            turn: null,
            sessionGrants: [],
            isArchived: true,
          } satisfies ChatThread,
        ],
        projects: [],
        providerLabel: "Mock Provider",
        mode: "mock",
        settings,
      }),
    );
    expect(withArchivedThread).toContain('data-testid="no-thread-view"');
    expect(withArchivedThread).not.toContain('data-testid="welcome-view"');

    const noThreadDarwin = renderInLang(
      "en",
      createElement(NoThreadView, { settings }),
    );
    expect(noThreadDarwin).toContain("Pick a thread or start a new one");
  });

  it("localizes WelcomeView strings in zh-Hans and all P2-49 languages", () => {
    stubWindow();
    const zhReady = renderInLang(
      "zh-Hans",
      createElement(WelcomeView, {
        info: baseInfo({ mode: "mock" }),
        defaultExpanded: true,
      }),
    );
    expect(zhReady).toContain("今天从哪里开始？");
    expect(zhReady).toContain("在项目里工作");
    expect(zhReady).toContain("添加项目文件夹");
    expect(zhReady).toContain("直接对话");
    expect(zhReady).toContain("开始对话");
    expect(zhReady).toContain("1 个服务商可用");
    expect(zhReady).toContain("管理");
    expect(zhReady).toContain("安装");

    const zhUnconfigured = renderInLang(
      "zh-Hans",
      createElement(WelcomeView, {
        info: baseInfo({
          mode: "codex",
          providerId: "codex",
          providerLabel: "Codex",
          codex: {
            state: "unconfigured",
            protocolPin: "0.164.0+6aaac694",
            cliVersion: "unknown",
          },
        }),
      }),
    );
    expect(zhUnconfigured).toContain("先安装一个编程智能体");
    expect(zhUnconfigured).toContain("未配置");

    for (const lang of ["zh-Hans", "zh-Hant", "ja", "ko", "fr"] as const) {
      expect(translate(lang, "Where shall we begin today?")).not.toBe(
        "Where shall we begin today?",
      );
      expect(translate(lang, "This task's parent is unavailable.")).not.toBe(
        "This task's parent is unavailable.",
      );
      expect(translate(lang, "%lld providers ready")).toContain("%lld");
    }
  });
});

describe("P2-50 standalone task-workspaces for Just chat on Codex", () => {
  const roots: string[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      try {
        await cleanups.pop()!();
      } catch {
        /* best effort */
      }
    }
    while (roots.length) {
      try {
        rmSync(roots.pop()!, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  async function waitFor(cond: () => boolean, ms = 12000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  function makeCodexEngine(): {
    root: string;
    store: Store;
    engine: Engine;
    provider: CodexAppServerProvider;
  } {
    const root = mkdtempSync(join(tmpdir(), "tivano-p250-codex-"));
    roots.push(root);
    const store = new Store(root);
    store.open();
    const { codexHome, codexHomeId } = resolveCodexHome(root);
    const fixture = fileURLToPath(
      new URL("./fixtures/codex-app-server.mjs", import.meta.url),
    );
    const config: CodexRuntimeConfig = {
      mode: "fixture",
      configuredFrom: "fixture",
      fixtureScript: fixture,
      fixtureNode: process.execPath,
      codexHome,
      codexHomeId,
      args: [],
      env: { CODEX_HOME: codexHome },
      treeCapability: { supported: false, platform: process.platform, reason: "fixture" },
    };
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    let engine!: Engine;
    const provider = new CodexAppServerProvider({
      config,
      lookupBinding: (t) => engine.lookupProviderThread(t),
      bindThread: (t, b) => engine.bindProviderThread(t, b),
      onThreadNotice: (t, text, level) => engine.onThreadNotice(t, text, level),
    });
    engine = new Engine(store, provider, root, "0.3.0-test", paths);
    cleanups.push(async () => {
      await provider.dispose();
      store.close();
    });
    return { root, store, engine, provider };
  }

  it("lets a Just chat standalone thread send, complete, and rewind on Codex", async () => {
    const { root, engine } = makeCodexEngine();
    const thread = engine.createThread(null);
    engine.sendTurn(thread.id, "hello from just chat");

    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id);
      return t?.turn?.status === "done";
    });

    const after = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    const assistant = after.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toMatch(/fixture response/);

    const expectedTaskDir = realpathSync(join(root, "task-workspaces", thread.id));
    expect(existsSync(expectedTaskDir)).toBe(true);
    expect(after.providerThread?.cwd).toBe(expectedTaskDir);

    // Rewinding on the standalone Codex thread also resolves its task workspace.
    const firstTurnId = after.turn!.id;
    await engine.revertTurn(thread.id, firstTurnId);
    const rewound = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(rewound.turn).toBeNull();

    // Deleting the standalone thread cleans up its task workspace directory.
    engine.deleteThread(thread.id);
    expect(existsSync(expectedTaskDir)).toBe(false);
  });

  it("shares the parent standalone thread task workspace with spawned helpers", async () => {
    const { root, engine } = makeCodexEngine();
    const parent = engine.createThread(null, "Parent");
    const helper = engine.spawnHelper(parent.id, "Helper", "answer directly");

    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === helper.id);
      return t?.turn?.status === "done";
    });

    const afterHelper = engine.snapshot().threads.find((x) => x.id === helper.id)!;
    const parentTaskDir = realpathSync(join(root, "task-workspaces", parent.id));
    expect(afterHelper.providerThread?.cwd).toBe(parentTaskDir);
    expect(existsSync(join(root, "task-workspaces", helper.id))).toBe(false);
  });

  it("refuses a non-directory obstruction at task-workspaces/<id> without spawning", () => {
    const { root, engine, provider } = makeCodexEngine();
    const thread = engine.createThread(null);
    const base = join(root, "task-workspaces");
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    const created = paths.ensureTaskWorkspace(thread.id);
    rmSync(created.directory, { recursive: true, force: true });
    writeFileSync(join(base, thread.id), "not a directory");

    const turn = engine.sendTurn(thread.id, "should fail");
    expect(turn.status).toBe("cancelled");
    expect(provider.sessionCount()).toBe(0);
    const after = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(after.messages.at(-1)?.content).toContain("WORKSPACE_INVALID");
  });
});
