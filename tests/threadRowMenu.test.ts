// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-34 sidebar thread rows: no archive affordance on hover (archive lives
// in the row ⋯/context menu so a stray click cannot archive) — frozen
// SidebarView RowActionsButton + ThreadActions.make order.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ChatThread, Snapshot } from "../src/shared/types";
import {
  Sidebar,
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

  it("renders the row hover strip without an archive affordance", () => {
    const thread: ChatThread = {
      id: "t1",
      projectId: null,
      title: "Demo thread",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: null,
      sessionGrants: [],
    };
    const snapshot: Snapshot = {
      projects: [],
      threads: [thread],
      settings: {
        theme: "system",
        language: "en",
        alwaysAllow: [],
        showsSkylight: false,
      },
      selectedThreadId: null,
      info: {
        appVersion: "test",
        baselineTag: "v3.0.0",
        baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
        dataRoot: "C:/tivano-test",
        providerId: "mock",
        providerLabel: "Mock",
        mock: true,
        mode: "mock",
        realCli: { status: "not-configured" },
        home: "C:/tivano-test",
        worktreesDir: "C:/tivano-test/worktrees",
      },
      rev: 0,
      tokenActivity: {},
    };
    const g = globalThis as { window?: unknown };
    const priorWindow = g.window;
    g.window = {
      tivano: {
        platform: "win32",
        invoke: () => Promise.resolve(null),
        onEvent: () => () => {},
      },
    };
    try {
      const html = renderToStaticMarkup(
        createElement(Sidebar, { snapshot, onOpenSettings: () => {}, onOpenPalette: () => {} }),
      );
      const rowActions = html.match(/<span class="row-actions">(.*?)<\/span>/)?.[1] ?? "";
      expect(rowActions).toContain('title="Pin thread"');
      expect(rowActions).toContain('title="Thread actions"');
      expect(rowActions).not.toContain('title="Archive thread"');
      expect(html).not.toContain('title="Archive thread"');
    } finally {
      if (priorWindow === undefined) delete g.window;
      else g.window = priorWindow;
    }
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
    let blurHandler: (() => void) | null = null;
    const removed: string[] = [];
    const frames: Array<() => void> = [];
    const sel = { isCollapsed: false, anchorNode: INSIDE as Node, focusNode: INSIDE as Node };
    const win = {
      requestAnimationFrame: (f: () => void) => frames.push(f),
      addEventListener: (_t: string, f: () => void) => (blurHandler = f),
      removeEventListener: (t: string) => removed.push(`win:${t}`),
    } as unknown as Window;
    const doc = {
      defaultView: win,
      getSelection: () => sel as unknown as Selection,
      addEventListener: (_t: string, f: () => void) => (handler = f),
      removeEventListener: (t: string) => removed.push(`doc:${t}`),
    } as unknown as Document;
    const el = {
      ownerDocument: doc,
      contains: (n: unknown) => n === INSIDE,
      style,
    } as unknown as HTMLElement;
    return {
      el, sel, INSIDE, OUTSIDE, writes, removed,
      fire: () => handler?.(),
      blur: () => blurHandler?.(),
      paintFrame: () => frames.splice(0).forEach((f) => f()),
    };
  }

  it("holds a promoted layer across one frame when a touched selection clears", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    watchSelectionResidue(h.el);
    h.fire(); // selection inside — just records `hadInside`
    expect(h.writes).toEqual([]);
    h.sel.anchorNode = h.OUTSIDE;
    h.sel.focusNode = h.OUTSIDE;
    h.fire();
    // The first painted frame promotes the layer; the second demotes it.
    // Writing both in the selectionchange task (or clearing in the first
    // rAF) collapses to none→none before paint and repaints nothing.
    expect(h.writes).toEqual([]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)"]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)", ""]);
  });

  it("keeps a live selection across window blur and repaints when it later clears", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    watchSelectionResidue(h.el);
    h.fire(); // live selection inside
    h.blur();
    expect(h.writes).toEqual([]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)"]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)", ""]);
    // Chromium keeps the selection across blur. When the user returns and
    // clicks away, this is still a had→cleared transition and repaints.
    h.sel.anchorNode = h.OUTSIDE;
    h.sel.focusNode = h.OUTSIDE;
    h.fire();
    expect(h.writes).toEqual(["translateZ(0)", ""]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)", "", "translateZ(0)"]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)", "", "translateZ(0)", ""]);
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

  it("a collapsed caret inside the element counts as no selection", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    watchSelectionResidue(h.el);
    h.fire(); // real selection inside
    // Caret stays INSIDE but collapses — only !isCollapsed distinguishes
    // this from a still-live selection (anchor position alone cannot).
    h.sel.isCollapsed = true;
    h.fire();
    expect(h.writes).toEqual([]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)"]);
    h.paintFrame();
    expect(h.writes).toEqual(["translateZ(0)", ""]);
  });

  it("removes both listeners on cleanup", async () => {
    const { watchSelectionResidue } = await import("../src/renderer/selectionRepaint");
    const h = harness();
    const unwatch = watchSelectionResidue(h.el);
    unwatch();
    expect(h.removed).toEqual(["doc:selectionchange", "win:blur"]);
  });
});
