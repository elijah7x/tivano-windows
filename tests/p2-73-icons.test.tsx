// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-73 component and visual-fixture tests: distinct full-access
// (`exclamationmark.shield`) and independent review (`checkmark.seal`)
// icons across RuntimeModePicker, SettingsModal (Permissions + Hydra +
// Remote MCP), and HydraPanel/HydraReviewCard, including localized
// accessibility labels and geometry separation.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/store";
import { clientStore } from "../src/renderer/client";
import { HydraPanel, HydraReviewCard } from "../src/renderer/components/HydraPanel";
import {
  RUNTIME_MODES,
  RUNTIME_MODE_SYMBOL,
  RuntimeModePicker,
} from "../src/renderer/components/RuntimeModePicker";
import { SettingsModal } from "../src/renderer/components/SettingsModal";
import {
  CheckmarkSealIcon,
  FullAccessShieldIcon,
  HYDRA_REVIEW_SYMBOL,
  RuntimeModeIcon,
} from "../src/renderer/components/StatusIcons";
import { LanguageContext } from "../src/renderer/locale";
import type { HydraReview } from "../src/shared/hydraReview";
import type { AppInfo, ChatThread, LanguageId, RuntimeMode, Settings, Snapshot } from "../src/shared/types";

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
      invoke: async () => ({ providers: [], servers: [], enabled: false, listening: false, port: 0, clients: [] }),
      onEvent: () => () => {},
    },
  };
  const settings: Settings = {
    ...defaultSettings(),
    language,
    hydraEnabled: true,
    hydraReviewEnabled: true,
  };
  const review: HydraReview = {
    id: "rev-p273",
    batchId: "batch-p273",
    reviewer: "Codex gpt-5.4 · High",
    provider: "codex",
    findings: "Finding 1: src/app.ts:10 fix guard",
    findingCount: 1,
    diffBytes: 512,
    durationMs: 2400,
    accepted: 1,
    rejected: 0,
    createdAt: 1000,
  };
  const thread: ChatThread = {
    id: "thr-p273",
    title: "Icon vocabulary check",
    projectId: null,
    createdAt: 1000,
    updatedAt: 2000,
    runtimeMode: "fullAccess",
    messages: [],
    turn: null,
    sessionGrants: [],
    hydraEnabled: true,
    hydraReviews: [review],
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
    baselineTag: "v3.0.26",
    baselineCommit: "23ac46c6f2e922d62b1a388f3ead7c42260e2dd4",
    dataRoot: "C:\\synthetic\\data",
    providerId: "mock",
    providerLabel: "Mock Provider",
    mock: true,
    mode: "mock",
    realCli: { status: "not-configured" },
    home: "C:\\synthetic\\home",
    worktreesDir: "C:\\synthetic\\data\\worktrees",
  };
  return { settings, snapshot, thread, info };
}

function renderInLang(lang: LanguageId, node: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, node),
  );
}

function stripAttrs(svgHtml: string): string {
  return svgHtml
    .replace(/\s+(?:data-icon|class|aria-label|aria-hidden|role|focusable|width|height)="[^"]*"/g, "");
}

afterEach(() => {
  clientStore.snapshot = prevSnapshot;
  if (prevWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

describe("P2-73 distinct full-access and review icons", () => {
  it("assigns distinct icon identifiers and distinct SVG geometry to full access and independent review", () => {
    expect(RUNTIME_MODE_SYMBOL.fullAccess).toBe("exclamationmark.shield");
    expect(HYDRA_REVIEW_SYMBOL).toBe("checkmark.seal");
    expect(RUNTIME_MODE_SYMBOL.fullAccess).not.toBe(HYDRA_REVIEW_SYMBOL);

    const symbols = RUNTIME_MODES.map((m) => RUNTIME_MODE_SYMBOL[m]);
    expect(new Set(symbols).size).toBe(RUNTIME_MODES.length);
    expect(symbols).not.toContain(HYDRA_REVIEW_SYMBOL);

    const shieldHtml = renderToStaticMarkup(
      createElement(FullAccessShieldIcon, { label: "Full access" }),
    );
    const sealHtml = renderToStaticMarkup(
      createElement(CheckmarkSealIcon, { label: "Independent review" }),
    );

    expect(shieldHtml).toContain('data-icon="exclamationmark.shield"');
    expect(shieldHtml).toContain('role="img"');
    expect(shieldHtml).toContain('aria-label="Full access"');
    expect(shieldHtml).toContain("<circle");

    expect(sealHtml).toContain('data-icon="checkmark.seal"');
    expect(sealHtml).toContain('role="img"');
    expect(sealHtml).toContain('aria-label="Independent review"');
    expect(sealHtml).not.toContain("<circle");

    expect(stripAttrs(shieldHtml)).not.toBe(stripAttrs(sealHtml));
  });

  it("renders RuntimeModePicker with exclamationmark.shield for fullAccess and distinct icons for other modes", () => {
    const { thread } = mockEnv("en");
    const fullHtml = renderInLang(
      "en",
      createElement(RuntimeModePicker, {
        thread: { ...thread, runtimeMode: "fullAccess" },
        readOnly: false,
      }),
    );
    expect(fullHtml).toContain('data-runtime-mode="fullAccess"');
    expect(fullHtml).toContain('data-icon="exclamationmark.shield"');
    expect(fullHtml).toContain('aria-label="Full access"');
    expect(fullHtml).not.toContain('data-icon="checkmark.seal"');

    const zhHtml = renderInLang(
      "zh-Hans",
      createElement(RuntimeModePicker, {
        thread: { ...thread, runtimeMode: "fullAccess" },
        readOnly: false,
      }),
    );
    expect(zhHtml).toContain('data-icon="exclamationmark.shield"');
    expect(zhHtml).toContain('aria-label="完全访问"');

    const modeSvgs = new Set<string>();
    for (const mode of RUNTIME_MODES) {
      const html = renderInLang(
        "en",
        createElement(RuntimeModePicker, {
          thread: { ...thread, runtimeMode: mode },
          readOnly: false,
        }),
      );
      expect(html).toContain(`data-icon="${RUNTIME_MODE_SYMBOL[mode]}"`);
      const iconMatch = html.match(/<svg[\s\S]*?<\/svg>/);
      expect(iconMatch).toBeTruthy();
      modeSvgs.add(stripAttrs(iconMatch![0]));
    }
    expect(modeSvgs.size).toBe(RUNTIME_MODES.length);
  });

  it("renders checkmark.seal in HydraReviewCard and HydraPanel with localized accessibility labels", () => {
    const { thread } = mockEnv("en");
    const review = thread.hydraReviews![0]!;

    const cardEn = renderInLang("en", createElement(HydraReviewCard, { review }));
    expect(cardEn).toContain('data-icon="checkmark.seal"');
    expect(cardEn).toContain('role="img"');
    expect(cardEn).toContain('aria-label="Independent review"');
    expect(cardEn).not.toContain('data-icon="exclamationmark.shield"');

    const cardZh = renderInLang("zh-Hans", createElement(HydraReviewCard, { review }));
    expect(cardZh).toContain('data-icon="checkmark.seal"');
    expect(cardZh).toContain('aria-label="独立审查"');

    const panelHtml = renderInLang(
      "en",
      createElement(HydraPanel, { thread, threads: [thread] }),
    );
    expect(panelHtml).toContain('data-icon="checkmark.seal"');
    expect(panelHtml).toContain('aria-label="Independent review"');
    expect(panelHtml).not.toContain('data-icon="exclamationmark.shield"');
  });

  it("uses distinct full-access and independent-review icons in SettingsModal pages", () => {
    const { settings, snapshot, thread, info } = mockEnv("en");

    const convHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "conversation",
        onClose: () => {},
      }),
    );
    for (const mode of RUNTIME_MODES as readonly RuntimeMode[]) {
      expect(convHtml).toContain(`data-icon="${RUNTIME_MODE_SYMBOL[mode]}"`);
    }
    expect(convHtml).not.toContain('data-icon="checkmark.seal"');

    const hydraHtml = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings,
        info,
        threads: [thread],
        projects: snapshot.projects,
        tokenActivity: {},
        initialPage: "hydra",
        onClose: () => {},
      }),
    );
    expect(hydraHtml).toContain('data-icon="checkmark.seal"');
    expect(hydraHtml).not.toContain('data-icon="exclamationmark.shield"');

    const connHtml = renderInLang(
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
    expect(connHtml).toContain('data-testid="remote-mcp-full-access-toggle"');
    expect(connHtml).toContain('data-icon="exclamationmark.shield"');
    expect(connHtml).not.toContain('data-icon="checkmark.seal"');

    const iconSvgs = RUNTIME_MODES.map((m) =>
      stripAttrs(renderToStaticMarkup(createElement(RuntimeModeIcon, { mode: m }))),
    );
    expect(new Set(iconSvgs).size).toBe(RUNTIME_MODES.length);
  });
});
