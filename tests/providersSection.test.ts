// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-39/P2-19 providers list: status dots map the Codex PROVIDER's own
// runtime state onto frozen ProviderListStatus (ready / needs attention /
// not installed); unknown states stay unmarked rather than guessed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CodexSetupState } from "../src/shared/types";
import {
  ProvidersSection,
  providerListStatus,
  providerStatusTitle,
  PROVIDER_LIST_STATUSES,
} from "../src/renderer/components/ProvidersSection";

const t = (s: string): string => s;

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
        renderCodexCard: () => createElement("div", null, "codex-card-body"),
      }),
    );

  it("renders the compact rail, card-top switches and folded accounts row", () => {
    const html = render();
    expect(html).toContain("prov-rail");
    expect(html).toContain("prov-rail-expand");
    expect(html).toContain("prov-dot ready");
    expect(html).toContain("Check for updates");
    expect(html).toContain("Custom executable path");
    expect(html).toContain("provider-accounts");
    expect(html).toContain("Usage unavailable in this build");
    expect(html).toContain("codex-card-body");
  });

  it("renders in-card provider choosing and hides a disabled provider", () => {
    const html = render(false);
    expect(html).toContain("active-providers-card");
    expect(html).toContain("Choose providers");
    expect(html).toContain("No matching providers");
    expect(html).not.toContain("codex-card-body");
  });
});
