// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-39/P2-19 providers list: status dots map the Codex PROVIDER's own
// runtime state onto frozen ProviderListStatus (ready / needs attention /
// not installed); unknown states stay unmarked rather than guessed.

import { describe, expect, it } from "vitest";
import {
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
