// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-39/P2-19 providers list: status dots map the Codex PROVIDER's own
// runtime state onto frozen ProviderListStatus (ready / needs attention /
// not installed); unknown states stay unmarked rather than guessed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexSetupState } from "../src/shared/types";
import {
  ProvidersSection,
  providerListStatus,
  providerStatusTitle,
  PROVIDER_LIST_STATUSES,
} from "../src/renderer/components/ProvidersSection";
import { ModelPicker } from "../src/renderer/components/ModelPicker";
import { ModelListSettings } from "../src/renderer/components/ModelListSettings";
import { clientStore } from "../src/renderer/client";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import { requestValidators } from "../src/shared/ipc";

const t = (s: string): string => s;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  clientStore.snapshot = null;
});

describe("providerListStatus (frozen ProviderListStatus)", () => {
  it("maps the Codex runtime states onto the list statuses", () => {
    // The active provider must never read "Not installed" (audit A1):
    // a configured or fixture runtime is the provider Tivano runs on.
    expect(providerListStatus("configured-unverified")).toBe("ready");
    expect(providerListStatus("fixture")).toBe("ready");
    expect(providerListStatus("unsupported")).toBe("attention");
    expect(providerListStatus("unconfigured")).toBe("notInstalled");
  });

  it("leaves unknown states unmarked instead of guessing", () => {
    expect(providerListStatus(undefined)).toBeNull();
    expect(providerListStatus(null)).toBeNull();
    expect(providerListStatus("mystery" as never)).toBeNull();
  });

  it("titles every status for the dot's label", () => {
    for (const s of PROVIDER_LIST_STATUSES) {
      expect(providerStatusTitle(t, s)).not.toBe("");
    }
    expect(providerStatusTitle(t, "ready")).toBe("Ready");
    expect(providerStatusTitle(t, "attention")).toBe("Needs attention");
    expect(providerStatusTitle(t, "notInstalled")).toBe("Not installed");
  });
});


describe("ProvidersSection component", () => {
  const codex = {
    savedExecutable: null,
    pendingExecutable: null,
    chooserBusy: false,
    providerOverride: null,
    launchProvider: "codex",
    effectiveSource: "fixture",
    effectiveExecutable: null,
    savedEffect: "none",
    runtime: { state: "configured-unverified", protocolPin: "test", cliVersion: "unknown" },
    mutable: true,
  } as CodexSetupState;
  const render = (enabled = true) =>
    renderToStaticMarkup(
      createElement(ProvidersSection, {
        codex,
        codexProviderEnabled: enabled,
        onCodexProviderEnabled: () => {},
        executablePathVisible: false,
        onExecutablePathVisible: () => {},
        codexRoute: "Codex CLI",
        renderCodexCard: ({ executablePath }) =>
          createElement("div", { "data-executable-path": String(executablePath) }, "codex-card-body"),
      }),
    );

  it("renders the compact rail, card-top switches and folded accounts row", () => {
    const html = render();
    expect(html).toContain("prov-rail");
    expect(html).toContain("prov-rail-expand");
    expect(html).toContain("prov-dot ready");
    expect(html).toContain("Check for updates");
    expect(html).toContain("Custom executable path");
    expect(html.indexOf("Custom executable path")).toBeLessThan(html.indexOf("codex-card-body"));
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain("provider-accounts");
    expect(html).toContain("Usage unavailable in this build");
    expect(html).toContain("configured — unverified");
    expect(html).not.toContain("In use");
    expect(html).toContain("codex-card-body");
    expect(html).toContain("data-executable-path=\"false\"");
  });

  it("passes the executable-path switch through to the Codex card", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersSection, {
        codex,
        codexProviderEnabled: true,
        onCodexProviderEnabled: () => {},
        executablePathVisible: true,
        onExecutablePathVisible: () => {},
        codexRoute: "Codex CLI",
        renderCodexCard: ({ executablePath }) =>
          createElement("div", { "data-executable-path": String(executablePath) }, "codex-card-body"),
      }),
    );
    expect(html).toContain("data-executable-path=\"true\"");
  });

  it("gates the Codex executable rows in the real settings surface", async () => {
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: () => Promise.resolve({}),
        onEvent: () => () => {},
      },
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
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
    const { SettingsModal } = await import("../src/renderer/components/SettingsModal");
    const info = {
      appVersion: "0.0.0-test", baselineTag: "v3.0.0", baselineCommit: "x",
      dataRoot: "C:/tmp/tivano-test", providerId: "mock", providerLabel: "Mock",
      mock: true, mode: "mock", realCli: { status: "not-configured" },
      home: "C:/tmp", worktreesDir: "C:/tmp/worktrees",
    };
    const render = (settings: Record<string, unknown>) =>
      renderToStaticMarkup(createElement(SettingsModal, {
        settings, info, threads: [], projects: [], tokenActivity: {}, onClose: () => {},
      } as never));

    expect(render({ providersShowExecutablePath: false })).not.toContain("Saved program");
    expect(render({})).not.toContain("Saved program");
    expect(render({ providersShowExecutablePath: true })).toContain("Saved program");
  });

  it("renders in-card provider choosing and hides a disabled provider", () => {
    const html = render(false);
    expect(html).toContain("active-providers-card");
    expect(html).toContain("Choose providers");
    expect(html).not.toContain("prov-rail");
    expect(html).not.toContain("No matching providers");
    expect(html).not.toContain("codex-card-body");
  });
});


describe("P2-39 provider hiding across model surfaces", () => {
  const thread = {
    id: "t1", projectId: null, title: "chat", createdAt: 0, updatedAt: 0,
    messages: [], turn: null, sessionGrants: [],
  } as never;

  it("keeps unrelated sub-agent controls while hiding Codex model controls", () => {
    clientStore.snapshot = {
      settings: { codexProviderEnabled: false, hydraEnabled: true },
      threads: [], projects: [],
    } as never;
    const html = renderToStaticMarkup(createElement(ModelPicker, { thread }));
    expect(html).toContain("subagent-mode-select");
    expect(html).not.toContain('aria-label="Model"');
    expect(html).not.toContain('aria-label="Effort"');
    expect(html).not.toContain("model-note");
  });

  it("hides Settings > Models when the only provider is hidden", () => {
    clientStore.snapshot = {
      settings: { codexProviderEnabled: false },
      threads: [], projects: [],
    } as never;
    const html = renderToStaticMarkup(createElement(ModelListSettings));
    expect(html).toContain("Codex is hidden in Providers");
    expect(html).not.toContain("Hide outdated models");
    expect(html).not.toContain("Search models");

    clientStore.snapshot = {
      settings: { codexProviderEnabled: true },
      threads: [], projects: [],
    } as never;
    const enabledHtml = renderToStaticMarkup(createElement(ModelListSettings));
    expect(enabledHtml).toContain("Hide outdated models");
    expect(enabledHtml).toContain("Search models");
  });

  it("validates and durably persists both provider surface switches", () => {
    expect(
      requestValidators["settings:set"]({
        codexProviderEnabled: false,
        providersShowExecutablePath: true,
      }),
    ).toEqual({ codexProviderEnabled: false, providersShowExecutablePath: true });

    const root = mkdtempSync(join(tmpdir(), "tivano-providers-"));
    roots.push(root);
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    engine.setSettings({ codexProviderEnabled: false, providersShowExecutablePath: true });
    expect(engine.snapshot().settings.codexProviderEnabled).toBe(false);
    expect(engine.snapshot().settings.providersShowExecutablePath).toBe(true);
    engine.shutdown();
    store.close();

    const reopened = new Store(root);
    reopened.open();
    expect(reopened.state.settings.codexProviderEnabled).toBe(false);
    expect(reopened.state.settings.providersShowExecutablePath).toBe(true);
    reopened.close();
  });
});
