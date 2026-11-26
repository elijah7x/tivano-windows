// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import { describe, expect, it } from "vitest";
import { chimeraPickProviderResolution } from "../src/shared/chimera";
import { identityPickTitle } from "../src/renderer/components/HydraSection";

describe("chimeraPickProviderResolution", () => {
  it("follows the lead whenever no model is set", () => {
    expect(chimeraPickProviderResolution(undefined, "codex")).toEqual({ kind: "follow" });
    expect(chimeraPickProviderResolution({ provider: "claude" }, "codex")).toEqual({
      kind: "follow",
    });
    expect(chimeraPickProviderResolution({ model: "  " }, "codex")).toEqual({
      kind: "follow",
    });
  });

  it("runs a model pick on the active provider when no provider was saved", () => {
    expect(chimeraPickProviderResolution({ model: "gpt-5" }, "codex")).toEqual({
      kind: "runs",
      providerId: "codex",
    });
  });

  it("runs a model pick on its saved provider when that provider is active", () => {
    expect(
      chimeraPickProviderResolution({ provider: "codex", model: "gpt-5" }, "codex"),
    ).toEqual({ kind: "runs", providerId: "codex" });
  });

  it("marks a saved foreign provider as unable to run here", () => {
    expect(
      chimeraPickProviderResolution({ provider: "claude", model: "opus" }, "codex"),
    ).toEqual({ kind: "unavailable", providerId: "claude" });
  });
});

describe("identityPickTitle", () => {
  const providers = [{ id: "codex", label: "Codex", ready: true, models: [] }];
  const t = (key: string, ...vars: string[]): string =>
    vars.reduce((out, value) => out.replace("%@", value), key);

  it("says Follow the lead only when no model is set", () => {
    expect(identityPickTitle(t, providers, undefined)).toBe("Follow the lead");
    expect(identityPickTitle(t, providers, { provider: "claude" })).toBe(
      "Follow the lead",
    );
  });

  it("names the active provider for a model pick without a saved provider", () => {
    expect(identityPickTitle(t, providers, { model: "gpt-5" })).toBe(
      "Provider: Codex",
    );
  });

  it("says when a saved provider cannot run here", () => {
    expect(
      identityPickTitle(t, providers, { provider: "claude", model: "opus" }),
    ).toBe("Claude cannot run here; the identity follows the lead");
  });
});
