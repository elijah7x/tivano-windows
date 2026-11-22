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
  it("ignores a press that never moved 2px on either axis", () => {
    expect(HYDRA_PANEL_DRAG_SLOP).toBe(2);
    expect(hydraPanelDragBegun(0, 0)).toBe(false);
    expect(hydraPanelDragBegun(1, 1)).toBe(false);
    expect(hydraPanelDragBegun(1.9, 0)).toBe(false);
    // Frozen DragHandleView checks per axis, so a sub-2px diagonal is
    // still a click even though its distance exceeds 2px.
    expect(hydraPanelDragBegun(1.5, 1.5)).toBe(false);
  });

  it("treats a 2px travel on either axis as a drag", () => {
    expect(hydraPanelDragBegun(2, 0)).toBe(true);
    expect(hydraPanelDragBegun(0, -2)).toBe(true);
    expect(hydraPanelDragBegun(-2, 1)).toBe(true);
    expect(hydraPanelDragBegun(1, 3)).toBe(true);
  });
});

describe("hydraPanelClamp (floated panel stays reachable)", () => {
  it("keeps a dragged-off panel partly inside the viewport", () => {
    // A 600x40 strip keeps 80px visible horizontally (min(80, w)) and
    // its whole 40px height vertically (min(80, h)) — per-axis caps.
    expect(hydraPanelClamp(-9999, 40, 600, 40, 1280, 800).x).toBe(-520);
    expect(hydraPanelClamp(9999, 40, 600, 40, 1280, 800).x).toBe(1200);
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
    hasDismiss: true,
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

  it("never opens with a bare divider and never renders a dead Dismiss", () => {
    // A reviews-only panel with no heads: panel rows alone, no sep.
    expect(
      hydraPanelMenuItems({ ...base, hasHead: false }),
    ).toEqual(["dismiss"]);
    expect(
      hydraPanelMenuItems({ ...base, hasHead: false, floating: true }),
    ).toEqual(["dock", "dismiss"]);
    // A host that cannot hide the panel gets no dead Dismiss row.
    expect(
      hydraPanelMenuItems({ ...base, hasDismiss: false }),
    ).toEqual(["open"]);
    expect(
      hydraPanelMenuItems({ ...base, hasHead: false, hasDismiss: false }),
    ).toEqual([]);
  });
});
