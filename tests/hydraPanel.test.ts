// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-31 Hydra panel polish: the frozen PanelDragHandle slop, the
// floating-panel clamp, the shared Continue gate, and the frozen
// panelMenu row order and gates.

import { describe, expect, it } from "vitest";
import {
  hydraContinueEligible,
  hydraPanelClamp,
  hydraPanelDragBegun,
  hydraPanelMenuItems,
  HYDRA_PANEL_DRAG_SLOP,
} from "../src/renderer/components/HydraPanel";
import type { ChatThread } from "../src/shared/types";

const headInfo = (over: Partial<NonNullable<ChatThread["hydraHead"]>> = {}) =>
  ({
    leadId: "lead",
    headIndex: 0,
    name: "Ada",
    task: "work",
    status: "running",
    spawnedAt: 0,
    ...over,
  }) as NonNullable<ChatThread["hydraHead"]>;

describe("hydraPanelDragBegun (frozen PanelDragHandle slop)", () => {
  it("ignores a press that never moved 2px", () => {
    expect(HYDRA_PANEL_DRAG_SLOP).toBe(2);
    expect(hydraPanelDragBegun(0, 0)).toBe(false);
    expect(hydraPanelDragBegun(1, 1)).toBe(false);
    expect(hydraPanelDragBegun(1.9, 0)).toBe(false);
  });

  it("treats a 2px travel as a drag", () => {
    expect(hydraPanelDragBegun(2, 0)).toBe(true);
    expect(hydraPanelDragBegun(0, -2)).toBe(true);
    // Diagonal travel counts by distance, not per-axis.
    expect(hydraPanelDragBegun(1.5, 1.5)).toBe(true);
  });
});

describe("hydraPanelClamp (floated panel stays reachable)", () => {
  it("keeps a dragged-off panel partly inside the viewport", () => {
    // A 40px-tall strip keeps its whole height visible-cap: 40px must
    // stay grabbable on each axis (minVis = min(80, w, h)).
    expect(hydraPanelClamp(-9999, 40, 600, 40, 1280, 800).x).toBe(-560);
    expect(hydraPanelClamp(9999, 40, 600, 40, 1280, 800).x).toBe(1240);
    // Vertically: never above the top, never fully below the bottom.
    expect(hydraPanelClamp(10, -50, 600, 40, 1280, 800).y).toBe(0);
    expect(hydraPanelClamp(10, 9999, 600, 40, 1280, 800).y).toBe(760);
  });

  it("keeps an on-screen position untouched", () => {
    expect(hydraPanelClamp(120, 200, 600, 40, 1280, 800)).toEqual({
      x: 120,
      y: 200,
    });
  });
});

describe("hydraContinueEligible (frozen continueFailedHydraHead, bounded)", () => {
  it("continues a failed or stopped head that kept its own copy", () => {
    for (const status of ["failed", "stopped"] as const) {
      expect(
        hydraContinueEligible(
          headInfo({ status, baseTree: "abc" }),
          { worktreeDir: "C:\\tmp\\w" },
        ),
      ).toBe(true);
    }
  });

  it("keeps no Continue for running/completed or shared-checkout heads", () => {
    expect(
      hydraContinueEligible(headInfo({ status: "running", baseTree: "x" }), {
        worktreeDir: "C:\\tmp\\w",
      }),
    ).toBe(false);
    expect(
      hydraContinueEligible(headInfo({ status: "completed", baseTree: "x" }), {
        worktreeDir: "C:\\tmp\\w",
      }),
    ).toBe(false);
    // Own-copy flag absent → shared checkout → no Continue.
    expect(
      hydraContinueEligible(headInfo({ status: "failed" }), {
        worktreeDir: "C:\\tmp\\w",
      }),
    ).toBe(false);
    // Copy exists but the worktree path is gone.
    expect(
      hydraContinueEligible(headInfo({ status: "failed", baseTree: "x" }), {}),
    ).toBe(false);
  });
});

describe("hydraPanelMenuItems (frozen panelMenu order)", () => {
  const base = {
    hasHead: true,
    running: false,
    continueOk: false,
    floating: false,
    readOnly: false,
  };

  it("opens the head's chat first, then panel rows after a divider", () => {
    expect(hydraPanelMenuItems(base)).toEqual([
      "open",
      "sep",
      "dismiss",
    ]);
  });

  it("adds Stop for a running head and Continue under its gate", () => {
    expect(hydraPanelMenuItems({ ...base, running: true })).toEqual([
      "open",
      "stop",
      "sep",
      "dismiss",
    ]);
    expect(hydraPanelMenuItems({ ...base, continueOk: true })).toEqual([
      "open",
      "continue",
      "sep",
      "dismiss",
    ]);
    expect(
      hydraPanelMenuItems({ ...base, running: true, continueOk: true }),
    ).toEqual(["open", "continue", "stop", "sep", "dismiss"]);
  });

  it("drops head actions under readOnly but keeps open and dismiss", () => {
    expect(
      hydraPanelMenuItems({
        ...base,
        running: true,
        continueOk: true,
        readOnly: true,
      }),
    ).toEqual(["open", "sep", "dismiss"]);
  });

  it("offers Dock only while floating", () => {
    expect(hydraPanelMenuItems({ ...base, floating: true })).toEqual([
      "open",
      "sep",
      "dock",
      "dismiss",
    ]);
  });

  it("still dismisses a reviews-only panel with no heads", () => {
    expect(
      hydraPanelMenuItems({ ...base, hasHead: false }),
    ).toEqual(["sep", "dismiss"]);
  });
});
