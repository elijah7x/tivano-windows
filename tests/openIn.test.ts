// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F15 "Open in" remainder: installed-editor discovery exposes only
// {id,name}, unknown editors refuse honestly, and the engine's
// project/worktree reveal targets resolve real stored paths only.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { installedEditors, openWithEditor } from "../src/main/openIn";
import { Store } from "../src/main/store";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-openin-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}

describe("F15 installed editors (frozen Workspace.installedEditors)", () => {
  it("exposes only id + display name — no executable path crosses out", () => {
    const list = installedEditors(true);
    expect(Array.isArray(list)).toBe(true);
    for (const ed of list) {
      expect(Object.keys(ed).sort()).toEqual(["id", "name"]);
      expect(ed.id.length).toBeGreaterThan(0);
      expect(ed.name.length).toBeGreaterThan(0);
    }
    // Terminal.app is always present on the macOS dev host.
    if (process.platform === "darwin") {
      expect(list.some((e) => e.id === "terminal" && e.name === "Terminal")).toBe(true);
    }
  });

  it("caches the discovery result per launch (frozen looked-up-once)", () => {
    const a = installedEditors();
    const b = installedEditors();
    expect(a).toEqual(b);
  });

  it("an unknown editor id refuses instead of guessing", () => {
    expect(() => openWithEditor("/tmp", "definitely-not-an-editor")).toThrow(
      /editor is not available/,
    );
  });
});

describe("F15 reveal targets (engine-resolved, never renderer-supplied)", () => {
  it("projectDirectory returns the bound directory or honest null", () => {
    const { store, engine } = make();
    const p = engine.createProject("bound");
    expect(engine.projectDirectory(p.id)).toBeNull();
    const dir = tmp();
    store.update((d) => {
      d.projects.find((x) => x.id === p.id)!.directory = dir;
    });
    expect(engine.projectDirectory(p.id)).toBe(dir);
    expect(() => engine.projectDirectory("no-such-id")).toThrow(/project not found/);
  });

  it("threadWorktreePath surfaces only a recorded worktree", () => {
    const { store, engine } = make();
    const t = engine.createThread(null, "plain");
    expect(engine.threadWorktreePath(t.id)).toBeNull();
    store.update(() => {
      t.worktreeDir = "/recorded/worktree";
    });
    expect(engine.threadWorktreePath(t.id)).toBe("/recorded/worktree");
    expect(() => engine.threadWorktreePath("no-such-id")).toThrow();
  });

  it("threadDirectory reports a missing worktree as unavailable, not as the project dir", () => {
    const { store, engine } = make();
    const p = engine.createProject("p");
    const dir = tmp();
    store.update((d) => {
      d.projects.find((x) => x.id === p.id)!.directory = dir;
    });
    const t = engine.createThread(p.id);
    store.update(() => {
      t.worktreeDir = "/dead/worktree";
    });
    expect(engine.threadDirectory(t.id)).toBeNull();
  });
});
