// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-53 component tests: floating tray sidebar, lean top bar (capsule +
// overflow menu + top-bar changes popover anchor), 8 consolidated Settings
// pages without search, unified button sizing, and en/zh-Hans copy.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMImplementation } from "@xmldom/xmldom";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/store";
import { clientStore, type TivanoApi } from "../src/renderer/client";
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

type GlobalDomSlots = {
  window?: unknown;
  document?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function setRuntimeProp(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
  });
}

function patchEventTarget(target: object): void {
  setRuntimeProp(target, "addEventListener", () => {});
  setRuntimeProp(target, "removeEventListener", () => {});
  setRuntimeProp(target, "dispatchEvent", () => true);
}

/**
 * Minimal DOM mount harness for interaction-path component tests. The project
 * intentionally carries no browser-DOM test dependency; the XML document
 * already present in the dev dependency tree supplies the node tree, with the
 * few HTML/event gaps React touches patched here.
 */
function installMountedDom(invoke: TivanoApi["invoke"]): {
  document: Document;
  cleanup: () => void;
} {
  const globals = globalThis as GlobalDomSlots;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const doc = new DOMImplementation().createDocument(null, "html", null) as Document;
  const originalCreateTextNode = doc.createTextNode.bind(doc);
  setRuntimeProp(doc, "createTextNode", (data: string) => {
    const node = originalCreateTextNode(data);
    Object.defineProperty(node, "nodeValue", {
      configurable: true,
      get: () => node.data,
      set: (value: string) => {
        node.data = String(value);
      },
    });
    return node;
  });
  const head = doc.createElement("head");
  const body = doc.createElement("body");
  doc.documentElement.appendChild(head);
  doc.documentElement.appendChild(body);
  setRuntimeProp(doc, "head", head);
  setRuntimeProp(doc, "body", body);
  patchEventTarget(doc);
  function HTMLIFrameElement(): void {}
  const bridge: TivanoApi = {
    platform: "win32",
    invoke,
    onEvent: () => () => {},
  };
  const testWindow = {
    document: doc,
    HTMLIFrameElement,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    tivano: bridge,
  };
  setRuntimeProp(doc, "defaultView", testWindow);
  globals.document = doc;
  globals.window = testWindow;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    document: doc,
    cleanup: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
      if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
      else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

function patchMountContainer(container: Element): Element {
  patchEventTarget(container);
  return container;
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
    expect(connectionsHtml).toContain('data-testid="local-control-toggle"');
    expect(connectionsHtml).toContain("Local control");
    expect(connectionsHtml).toContain("CLI command");
    expect(connectionsHtml).not.toContain(">Alpha<");
    expect(connectionsHtml).not.toContain("Switch Alpha on to try its features.");

    const connectionsEnabledHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings: { ...settings, externalControlEnabled: true },
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "connections",
        onClose: () => {},
      }),
    );
    expect(connectionsEnabledHtml).toContain('aria-checked="true" data-testid="local-control-toggle"');

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

  it("mounts ThreadChangesTab and toggles the empty popover through toggleSeq", async () => {
    const { thread } = mockEnv("en");
    const dom = installMountedDom(async (channel) => {
      if (channel === "checkpoints:changes") return null;
      throw new Error(`unexpected IPC channel in ThreadChangesTab mount test: ${channel}`);
    });
    try {
      const container = patchMountContainer(dom.document.createElement("div"));
      dom.document.body.appendChild(container);
      const root = createRoot(container);
      const tree = (toggleSeq: number): React.ReactElement =>
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(ThreadChangesTab, { threadId: thread.id, toggleSeq }),
        );

      await act(async () => {
        root.render(tree(0));
      });
      expect(container.toString()).not.toContain("thread-changes-pop");

      await act(async () => {
        root.render(tree(1));
      });
      const openHtml = container.toString();
      expect(openHtml).toContain('class="thread-changes-pop"');
      expect(openHtml).toContain('data-anchor="topbar"');
      expect(openHtml).toContain("No changes yet");

      await act(async () => {
        root.render(tree(2));
      });
      expect(container.toString()).not.toContain("thread-changes-pop");
      await act(async () => {
        root.unmount();
      });
    } finally {
      dom.cleanup();
    }
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
    const ruleBlock = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = css.match(new RegExp(`(?:^|\\n)([^}]*${escaped}[^}]*)\\{([^}]*)\\}`, "m"));
      expect(match, `missing CSS rule for ${selector}`).toBeTruthy();
      return match?.[0] ?? "";
    };

    expect(css).toContain(".sidebar.sidebar-tray");
    expect(css).toContain("border-radius: 16px");
    expect(css).toContain('.thread-changes-pop[data-anchor="topbar"]');
    expect(css).toContain(".chrome-capsule");
    expect(css).toContain(".settings-nav");

    const regularRule = ruleBlock(".settings-modal .modal-actions button");
    expect(regularRule).toContain(".settings-modal .choice,");
    expect(regularRule).toContain(".settings-modal .ml-newgroup,");
    expect(regularRule).toContain("min-height: 28px");
    expect(regularRule).toContain("height: 28px");

    const regularHeightRule = ruleBlock(".settings-modal .theme-btn");
    expect(regularHeightRule).toContain(".settings-modal .appearance-btn");
    expect(regularHeightRule).toContain(".settings-modal .shortcut-chord");
    expect(regularHeightRule).toContain(".settings-modal .shortcut-recording");
    expect(regularHeightRule).toContain(".settings-modal .ml-newgroup-rail");
    expect(regularHeightRule).toContain("min-height: 28px");
    expect(regularHeightRule).toContain("height: 28px");
    expect(regularHeightRule).toContain("padding-top: 0");
    expect(regularHeightRule).toContain("padding-bottom: 0");

    const modelIconRule = ruleBlock(".ml-tune, .ml-remove, .ml-add");
    expect(modelIconRule).toContain(".ml-icobtn");
    expect(modelIconRule).toContain("width: 24px");
    expect(modelIconRule).toContain("min-width: 24px");
    expect(modelIconRule).toContain("height: 24px");
    expect(modelIconRule).toContain("min-height: 24px");
    expect(modelIconRule).toContain("padding: 0");

    const hydraRemoveRule = ruleBlock(".settings-modal .choice.hydra-remove");
    expect(hydraRemoveRule).toContain("width: 24px");
    expect(hydraRemoveRule).toContain("min-height: 24px");
    expect(hydraRemoveRule).toContain("height: 24px");

    const compactRule = ruleBlock(".settings-modal .settings-btn-compact");
    expect(compactRule).toContain(".settings-modal .shortcut-mini.settings-btn-compact");
    expect(compactRule).toContain("min-height: 24px");
    expect(compactRule).toContain("height: 24px");

    const destructiveRule = ruleBlock(".settings-modal .wp-btn.danger:hover:not(:disabled)");
    expect(destructiveRule).toContain(".settings-modal .ml-remove:hover:not(:disabled)");
    expect(destructiveRule).toContain("color: var(--danger)");
  });
});
