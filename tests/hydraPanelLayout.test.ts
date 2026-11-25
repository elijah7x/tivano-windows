// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-40 floating panel layout: the three-way picker rides two persisted
// booleans (frozen settings.hydraAutoOpensPanels + hydraAutoPopsHeads).

import { describe, expect, it } from "vitest";
import {
  hydraPanelLayout,
  hydraPanelLayoutPatch,
} from "../src/shared/hydra";

describe("hydraPanelLayout (frozen PanelLayout binding)", () => {
  it("derives the layout from the two booleans", () => {
    expect(hydraPanelLayout({})).toBe("single");
    expect(hydraPanelLayout({ hydraAutoOpensPanels: true, hydraAutoPopsHeads: false })).toBe("single");
    expect(hydraPanelLayout({ hydraAutoOpensPanels: true, hydraAutoPopsHeads: true })).toBe("independent");
    expect(hydraPanelLayout({ hydraAutoOpensPanels: false })).toBe("off");
    // pops without auto-open still reads Off — panels never auto-open.
    expect(hydraPanelLayout({ hydraAutoOpensPanels: false, hydraAutoPopsHeads: true })).toBe("off");
  });

  it("round-trips through the patch writer", () => {
    expect(hydraPanelLayout(hydraPanelLayoutPatch("single"))).toBe("single");
    expect(hydraPanelLayout(hydraPanelLayoutPatch("independent"))).toBe("independent");
    expect(hydraPanelLayout(hydraPanelLayoutPatch("off"))).toBe("off");
  });

  it("Off writes autoOpens=false without touching pops semantics", () => {
    expect(hydraPanelLayoutPatch("off")).toEqual({
      hydraAutoOpensPanels: false,
      hydraAutoPopsHeads: false,
    });
  });
});
