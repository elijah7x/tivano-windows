// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-12-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-39/P2-19 providers list: status dots map the port's Codex CLI state
// onto frozen ProviderListStatus (ready / needs attention / not installed);
// unknown states stay unmarked rather than guessed.

import { describe, expect, it } from "vitest";
import {
  providerListStatus,
  providerStatusTitle,
  PROVIDER_LIST_STATUSES,
} from "../src/renderer/components/ProvidersSection";

const t = (s: string): string => s;

describe("providerListStatus (frozen ProviderListStatus)", () => {
  it("maps the CLI install states onto the list statuses", () => {
    expect(providerListStatus("installed")).toBe("ready");
    expect(providerListStatus("repair")).toBe("attention");
    expect(providerListStatus("foreign")).toBe("attention");
    expect(providerListStatus("absent")).toBe("notInstalled");
    expect(providerListStatus("unavailable")).toBe("notInstalled");
  });

  it("leaves unknown states unmarked instead of guessing", () => {
    expect(providerListStatus(undefined)).toBeNull();
    expect(providerListStatus("checking")).toBeNull();
    expect(providerListStatus("mystery")).toBeNull();
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
