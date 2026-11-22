// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
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

// The repaint watcher needs only a stub element/document — no DOM.
describe("P2-34 selection residue repaint", () => {
  function harness() {
    const writes: string[] = [];
    const style = {};
    Object.defineProperty(style, "transform", {
      get: () => writes[writes.length - 1] ?? "",
      set: (v: string) => writes.push(v),
    });
    const INSIDE = {} as Node;
    const OUTSIDE = {} as Node;
    let handler: (() => void) | null = null;
    const sel = { isCollapsed: false, anchorNode: INSIDE as Node, focusNode: INSIDE as Node };
    const doc = {
      getSelection: () => sel as unknown as Selection,
      addEventListener: (_t: string, f: () => void) => (handler = f),
      removeEventListener: () => {},
    } as unknown as Document;
    const el = {
      ownerDocument: doc,
      contains: (n: unknown) => n === INSIDE,
      style,
      offsetHeight: 1,
    } as unknown as HTMLElement;
    return { el, sel, INSIDE, OUTSIDE, writes, fire: () => handler?.() };
  }

  it("forces one paint pass when a selection that touched the element clears", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    watchSelectionResidue(h.el);
    h.fire(); // selection inside — just records `hadInside`
    expect(h.writes).toEqual([]);
    h.sel.anchorNode = h.OUTSIDE;
    h.sel.focusNode = h.OUTSIDE;
    h.fire(); // had → cleared: write + reflow + reset
    expect(h.writes).toEqual(["translateZ(0)", ""]);
  });

  it("does nothing when the selection never touched the element or stays", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    watchSelectionResidue(h.el);
    h.sel.anchorNode = h.OUTSIDE;
    h.sel.focusNode = h.OUTSIDE;
    h.fire();
    h.sel.anchorNode = h.INSIDE;
    h.fire();
    h.fire();
    expect(h.writes).toEqual([]);
  });

  it("a collapsed caret counts as no selection", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    watchSelectionResidue(h.el);
    h.fire();
    h.sel.isCollapsed = true;
    h.sel.anchorNode = h.OUTSIDE;
    h.sel.focusNode = h.OUTSIDE;
    h.fire();
    expect(h.writes).toEqual(["translateZ(0)", ""]);
  });
});
