// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-12-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-34 sidebar thread rows: no archive affordance on hover (archive lives
// in the row ⋯/context menu so a stray click cannot archive) — frozen
// SidebarView RowActionsButton + ThreadActions.make order.

import { describe, expect, it } from "vitest";
import {
  THREAD_ROW_HOVER_ACTIONS,
  threadRowMenuItems,
} from "../src/renderer/components/Sidebar";

describe("P2-34 thread row action surfaces", () => {
  it("the hover strip never offers archive", () => {
    expect(THREAD_ROW_HOVER_ACTIONS).not.toContain("archive");
  });

  it("the hover strip keeps the immediate affordances plus the menu", () => {
    expect(THREAD_ROW_HOVER_ACTIONS).toEqual(["reveal", "pin", "rename", "menu", "delete"]);
  });

  it("the row menu carries archive in frozen order", () => {
    const items = threadRowMenuItems({ isHelper: false, hasWorktree: false });
    expect(items).toEqual(["rename", "pin", "forward", "archive", "delete"]);
    expect(items.indexOf("archive")).toBeGreaterThan(items.indexOf("rename"));
  });

  it("a helper row's menu drops Pin (a helper keeps its place)", () => {
    expect(threadRowMenuItems({ isHelper: true, hasWorktree: false })).not.toContain("pin");
  });

  it("reveal only appears when the thread owns a worktree", () => {
    expect(threadRowMenuItems({ isHelper: false, hasWorktree: false })).not.toContain("reveal");
    expect(threadRowMenuItems({ isHelper: false, hasWorktree: true })).toContain("reveal");
  });
});
