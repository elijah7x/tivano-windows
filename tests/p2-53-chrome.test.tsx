// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-53 component tests: floating tray sidebar, lean top bar (capsule +
// overflow menu + top-bar changes popover anchor), 8 consolidated Settings
// pages without search, unified button sizing, and en/zh-Hans copy.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointLedger } from "../src/main/checkpointLedger";
import { CheckpointService } from "../src/main/checkpointService";
import { CheckpointCoordinator } from "../src/main/checkpointTurns";
import { CodexAppServerProvider } from "../src/main/codexAppServerProvider";
import { resolveCodexRuntime } from "../src/main/codexRuntimeConfig";
import { Engine } from "../src/main/engine";
import { makeGitRunner } from "../src/main/gitExec";
import { resolveGitExecutable } from "../src/main/gitRuntimeConfig";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store, defaultSettings } from "../src/main/store";
import { requestValidators } from "../src/shared/ipc";
import { clientStore } from "../src/renderer/client";
import { ChatView } from "../src/renderer/components/ChatView";
import { CommandPalette } from "../src/renderer/components/CommandPalette";
import { HydraMark } from "../src/renderer/components/HydraMark";
import { OpenInItems } from "../src/renderer/components/OpenInMenu";
import { SETTINGS_PAGES, SettingsModal } from "../src/renderer/components/SettingsModal";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { ThreadChangesTab } from "../src/renderer/components/ThreadChangesTab";
import { translate } from "../src/renderer/i18n";
import { LanguageContext } from "../src/renderer/locale";
import type { AppInfo, ChatThread, LanguageId, Settings, Snapshot } from "../src/shared/types";

const prevWindow = (globalThis as { window?: unknown }).window;
const prevSnapshot = clientStore.snapshot;

function mockEnv(language: LanguageId = "en"): {
  settings: Settings;
  snapshot: Snapshot;
  thread: ChatThread;
  info: AppInfo;
} {
  (globalThis as { window?: unknown }).window = {
    tivano: {
      platform: "win32",
      invoke: async () => ({}),
      onEvent: () => () => {},
    },
  };
  const settings: Settings = {
    ...defaultSettings(),
    language,
  };
  const thread: ChatThread = {
    id: "thr-p2-53",
    title: "Calm window check",
    projectId: null,
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    turn: null,
    sessionGrants: [],
  };
  const snapshot = {
    projects: [],
    threads: [thread],
    selectedThreadId: thread.id,
    activeTurns: {},
    settings,
  } as unknown as Snapshot;
  clientStore.snapshot = snapshot;
  const info: AppInfo = {
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
    codex: {
      state: "fixture",
      protocolPin: "0.118.0",
      cliVersion: "unknown",
    },
  };
  return { settings, snapshot, thread, info };
}

function renderInLang(lang: LanguageId, node: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, node),
  );
}

afterEach(() => {
  clientStore.snapshot = prevSnapshot;
  if (prevWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

describe("P2-53 window chrome simplification", () => {
  it("renders the sidebar with floating tray chrome class", () => {
    const { snapshot } = mockEnv("en");
    const html = renderInLang(
      "en",
      createElement(Sidebar, {
        snapshot,
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    );
    expect(html).toContain('class="sidebar sidebar-tray"');
    expect(html).toContain('aria-label="Thread list"');
    expect(html).toContain('class="sidebar-foot"');
  });

  it("keeps only daily controls in the top bar and places secondary actions in the overflow button", () => {
    const { settings, thread } = mockEnv("en");
    const html = renderInLang(
      "en",
      createElement(ChatView, {
        thread,
        threads: [thread],
        projects: [],
        providerLabel: "Mock Provider",
        mode: "mock",
        directory: "C:\\synthetic\\repo",
        dock: "terminal",
        onToggleDock: () => {},
        sidebarCollapsed: true,
        onToggleSidebar: () => {},
        settings,
      }),
    );
    expect(html).toContain("sidebar-reopen");
    expect(html).toContain("chat-top-controls");
    expect(html).toContain("chrome-capsule");
    expect(html).toContain("more-controls-btn");
    expect(html).toContain('title="Terminal"');
    expect(html).toContain('title="Git"');
    // Secondary actions and standalone Open in must NOT live as separate top-bar buttons.
    expect(html).not.toContain('title="Forward to new thread"');
    expect(html).not.toContain('title="Open in another app"');
    expect(html).not.toContain("composer-changes-anchor");
  });

  it("renders all 8 consolidated Settings pages with no search field", () => {
    const { settings, snapshot, thread, info } = mockEnv("en");
    expect(SETTINGS_PAGES.map((p) => p.id)).toEqual([
      "appearance",
      "conversation",
      "models",
      "hydra",
      "connections",
      "shortcuts",
      "storage",
      "about",
    ]);

    const html = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        onClose: () => {},
      }),
    );
    for (const p of SETTINGS_PAGES) {
      expect(html).toContain(`data-settings-page="${p.id}"`);
      expect(html).toContain(p.label.replaceAll("&", "&amp;"));
    }
    expect(html).not.toContain('type="search"');
    expect(html.toLowerCase()).not.toContain("search settings");

    const connectionsHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "connections",
        onClose: () => {},
      }),
    );
    expect(connectionsHtml).toContain("settings-btn-compact");
    expect(connectionsHtml).toContain('data-testid="local-control-section"');
    expect(connectionsHtml).toContain("Local control");
    expect(connectionsHtml).toContain("CLI command");
    expect(connectionsHtml).not.toContain(">Alpha<");
    expect(connectionsHtml).not.toContain("Switch Alpha on to try its features.");

    const storageHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "storage",
        onClose: () => {},
      }),
    );
    expect(storageHtml).toContain("Archive");

    const aboutHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "about",
        onClose: () => {},
      }),
    );
    expect(aboutHtml).toContain("Droppy Code by Jordy Spruit");
    expect(aboutHtml).toContain('aria-controls="settings-panel-about"');
    expect(aboutHtml).toContain('id="settings-panel-about"');
    expect(aboutHtml).toContain('aria-labelledby="settings-tab-about"');

    const openInHtml = renderInLang(
      "en",
      createElement(OpenInItems, {
        threadId: thread.id,
        hasDirectory: true,
        open: true,
        onClose: () => {},
        itemProps: { "data-openin-item": "true" },
      }),
    );
    expect(openInHtml).toContain('data-openin-item="true"');
    expect(openInHtml).toContain("File Explorer");
    expect(openInHtml).toContain("Copy path");

    for (const [pageId, expectedText] of [
      ["conversation", "New threads"],
      ["models", "Codex CLI"],
      ["hydra", "Sub-agent"],
      ["shortcuts", "Shortcuts"],
    ] as const) {
      const pageHtml = renderInLang(
        "en",
        createElement(SettingsModal, {
          settings,
          info,
          threads: [thread],
          projects: snapshot.projects,
          tokenActivity: {},
          initialPage: pageId,
          onClose: () => {},
        }),
      );
      expect(pageHtml).toContain(`data-page="${pageId}"`);
      expect(pageHtml).toContain(expectedText);
    }

    const paletteHtml = renderInLang(
      "en",
      createElement(CommandPalette, {
        snapshot,
        selectedThreadId: thread.id,
        onClose: () => {},
        onToggleDock: () => {},
        onToggleChanges: () => {},
        onOpenSettings: () => {},
      }),
    );
    expect(paletteHtml).toContain("Toggle changes");

    const changesIdleHtml = renderInLang(
      "en",
      createElement(ThreadChangesTab, {
        threadId: thread.id,
        toggleSeq: 0,
      }),
    );
    expect(changesIdleHtml).toBe("");

    const markHtml = renderInLang(
      "en",
      createElement(HydraMark, {
        thread,
        heads: [],
        panelHidden: false,
        onTogglePanel: () => {},
        onOpenSettings: () => {},
      }),
    );
    expect(markHtml).toContain("hydra-mark");
  });

  it("localizes Settings pages and top-bar strings in zh-Hans", () => {
    expect(translate("zh-Hans", "More controls")).toBe("更多控件");
    expect(translate("zh-Hans", "Models & Providers")).toBe("模型与服务商");
    expect(translate("zh-Hans", "Connections")).toBe("连接");
    expect(translate("zh-Hans", "Storage")).toBe("存储空间");
    expect(translate("zh-Hans", "Version & About")).toBe("版本与关于");
    expect(translate("zh-Hans", "No changes yet")).toBe("暂无改动");

    const { settings, snapshot, thread, info } = mockEnv("zh-Hans");
    const zhModal = renderInLang(
      "zh-Hans",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        onClose: () => {},
      }),
    );
    expect(zhModal).toContain("模型与服务商");
    expect(zhModal).toContain("连接");
    expect(zhModal).toContain("版本与关于");

    const zhConnections = renderInLang(
      "zh-Hans",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "connections",
        onClose: () => {},
      }),
    );
    expect(zhConnections).toContain("本地控制");
    expect(zhConnections).toContain("命令行命令");
    expect(zhConnections).not.toContain(">Alpha<");
  });

  it("defines CSS rules for the tray sidebar, top-bar popover, and Settings button sizing", () => {
    const css = readFileSync(
      join(__dirname, "..", "src", "renderer", "styles.css"),
      "utf8",
    );
    expect(css).toContain(".sidebar.sidebar-tray");
    expect(css).toContain("border-radius: 16px");
    expect(css).toContain('.thread-changes-pop[data-anchor="topbar"]');
    expect(css).toContain(".chrome-capsule");
    expect(css).toContain(".settings-nav");
    expect(css).toContain("height: 28px");
    expect(css).toContain(".settings-modal .ml-newgroup");
    expect(css).toContain(".settings-modal .choice.hydra-remove");
    expect(css).toContain(".settings-modal .ml-remove:hover:not(:disabled)");
    expect(css).toContain(".settings-btn-compact");
    expect(css).toContain("height: 24px");
    expect(css).toContain(".settings-modal .wp-btn.danger:hover:not(:disabled)");
  });

  it("runs a real Codex fixture turn + Git CheckpointService + Engine.threadChanges flow on this platform", async () => {
    const resolvedGit = resolveGitExecutable(process.env, { platform: process.platform });
    expect(resolvedGit.kind).toBe("resolved");
    if (resolvedGit.kind !== "resolved") return;
    const gitExe = resolvedGit.executable;

    const root = mkdtempSync(join(tmpdir(), "tivano-p253-flow-"));
    const dataRoot = join(root, "data");
    const repoDir = join(root, "repo");
    const fakeHome = join(root, "home");
    const emptyCfg = join(fakeHome, "empty-gitconfig");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(emptyCfg, "");

    const git = (args: string[]) =>
      execFileSync(gitExe, args, {
        cwd: repoDir,
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: emptyCfg,
        },
        encoding: "utf8",
      });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "p253@example.com"]);
    git(["config", "user.name", "p253"]);
    writeFileSync(join(repoDir, "tracked.txt"), "base line\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);

    const store = new Store(dataRoot);
    store.open();
    const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
    const runtime = resolveCodexRuntime(
      {
        TIVANO_CODEX_FIXTURE: join(__dirname, "fixtures", "codex-app-server.mjs"),
        TIVANO_CODEX_NODE: process.execPath,
      },
      dataRoot,
    );
    expect(runtime.mode).toBe("fixture");

    let engine!: Engine;
    const provider = new CodexAppServerProvider({
      config: runtime,
      clientVersion: "0.3.0-test",
      lookupBinding: (tid) => engine.lookupProviderThread(tid),
      bindThread: (tid, b) => engine.bindProviderThread(tid, b),
      onThreadNotice: (tid, text, level) => engine.onThreadNotice(tid, text, level),
    });
    engine = new Engine(store, provider, dataRoot, "0.3.0-test", paths);

    const events: string[] = [];
    const unsub = engine.onEvent((e) => events.push(e.type));
    const ckptService = new CheckpointService({
      paths,
      projects: () => engine.snapshot().projects,
      threads: () => engine.snapshot().threads,
      mutable: () => !engine.readOnly,
      dataRoot,
      gitExe,
      platform: process.platform,
      runner: makeGitRunner(gitExe),
    });
    const checkpoints = new CheckpointCoordinator({
      service: ckptService,
      ledger: new CheckpointLedger(join(dataRoot, "checkpoints"), dataRoot),
      paths,
      projects: () => engine.snapshot().projects,
      threads: () => engine.snapshot().threads,
      threadMessages: (id) => engine.readThreadMessages(id),
      emit: (e) => {
        events.push(e.type);
      },
    });
    engine.attachCheckpoints(checkpoints);

    try {
      const proj = engine.createProject("p253-real-flow");
      paths.registerUser(proj.id, realpathSync(repoDir));
      const thread = engine.createThread(proj.id, "changes");
      const turn = engine.sendTurn(thread.id, "ckptfile please");

      const deadline = Date.now() + 20_000;
      let complete = false;
      let lastDiag: unknown = null;
      while (Date.now() < deadline) {
        const snap = engine.snapshot();
        const th = snap.threads.find((t) => t.id === thread.id);
        if (th?.turn?.status === "error" || th?.turn?.status === "cancelled") {
          throw new Error(`turn ended unexpectedly: ${JSON.stringify(th.turn)}`);
        }
        const recs = engine.listCheckpoints(thread.id);
        const rec = recs.find((r) => r.turnId === turn.id);
        lastDiag = { turn: th?.turn, rec, events: [...events] };
        const turnDone =
          th?.turn?.status === "done" ||
          (th?.turn == null &&
            th?.messages.some((m) => m.turnId === turn.id && m.status === "done"));
        if (turnDone && rec?.status === "complete") {
          complete = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!complete) throw new Error(`timed out: ${JSON.stringify(lastDiag)}`);
      expect(complete).toBe(true);
      expect(events).toContain("checkpoints-changed");
      expect(readFileSync(join(repoDir, "tracked.txt"), "utf8")).toContain("checkpoint line");
      expect(readFileSync(join(repoDir, "fixture-checkpoint.txt"), "utf8").length).toBeGreaterThan(0);

      const changesPayload = requestValidators["checkpoints:changes"]({ threadId: thread.id });
      const summary = await engine.threadChanges(changesPayload.threadId);
      expect(summary).not.toBeNull();
      expect(summary!.files).toHaveLength(2);
      expect(summary!.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "tracked.txt", additions: 1, deletions: 0, binary: false }),
          expect.objectContaining({ path: "fixture-checkpoint.txt", reason: "base-unknown" }),
        ]),
      );
      expect(summary!.additions).toBe(1);
      expect(summary!.deletions).toBe(0);

      const diffPayload = requestValidators["checkpoints:changes-diff"]({
        threadId: thread.id,
        path: "tracked.txt",
      });
      const diff = await engine.threadChangeDiff(diffPayload.threadId, diffPayload.path);
      expect(diff.kind).toBe("text");
      if (diff.kind === "text") {
        expect(diff.patch).toContain("+checkpoint line");
      }
      expect((await engine.threadChangeDiff(thread.id, ".git/HEAD")).kind).toBe("unavailable");
      expect(translate("zh-Hans", "%@ files")).toBe("%@ 个文件");
    } finally {
      unsub();
      await checkpoints.dispose();
      await provider.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
