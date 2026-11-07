// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01/F02 affiliation ordering tests (frozen parity):
// moveThread reorders inside one affiliation and inherits the target's
// pin; moveThreadToProject gates on never-started threads and clears the
// provider binding; moveProject reorders the project array; nil
// sortOrder stays on top; everything persists across a store reopen.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { threadsInAffiliation } from "../src/shared/threadOrder";
import type { ChatThread } from "../src/shared/types";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-threadmove-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}
const order = (engine: Engine, projectId: string | null): string[] =>
  threadsInAffiliation(engine.snapshot().threads, projectId).map((t) => t.id);
const threadOf = (engine: Engine, id: string): ChatThread =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const tick = () => new Promise((r) => setTimeout(r, 2));

describe("F01/F02 thread ordering + affiliation moves", () => {
  it("reorders inside an affiliation and renumbers the whole section", async () => {
    const { engine, store } = make();
    const p = engine.createProject("proj");
    const a = engine.createThread(p.id, "a");
    await tick();
    const b = engine.createThread(p.id, "b");
    await tick();
    const c = engine.createThread(p.id, "c");
    // New threads (nil sortOrder) lead the section, newest first.
    expect(order(engine, p.id)).toEqual([c.id, b.id, a.id]);
    // Drop c below b: [b, c, a].
    expect(engine.moveThread(c.id, b.id, true)).toBe(true);
    expect(order(engine, p.id)).toEqual([b.id, c.id, a.id]);
    expect(order(engine, p.id).map((id) => threadOf(engine, id).sortOrder)).toEqual([0, 1, 2]);
    // A fresh thread still leads — it has no sortOrder yet.
    const d = engine.createThread(p.id, "d");
    expect(order(engine, p.id)).toEqual([d.id, b.id, c.id, a.id]);
    store.close();
  });

  it("a dragged thread inherits the target's pin state", async () => {
    const { engine, store } = make();
    const a = engine.createThread(null, "a");
    engine.setThreadPinned(a.id, true);
    await tick();
    const c = engine.createThread(null, "c");
    // Unpinned c drops ABOVE pinned a → c takes the pin.
    expect(engine.moveThread(c.id, a.id, false)).toBe(true);
    expect(threadOf(engine, c.id).isPinned).toBe(true);
    await tick();
    // Pinned c drops onto unpinned b → c loses the pin.
    const b = engine.createThread(null, "b");
    await tick();
    expect(engine.moveThread(c.id, b.id, true)).toBe(true);
    expect(threadOf(engine, c.id).isPinned).toBe(false);
    store.close();
  });

  it("refuses reorder across affiliations, unknown targets, and self", () => {
    const { engine, store } = make();
    const p = engine.createProject("proj");
    const inP = engine.createThread(p.id, "in-p");
    const solo = engine.createThread(null, "solo");
    expect(engine.moveThread(solo.id, inP.id, true)).toBe(false);
    expect(engine.moveThread(solo.id, solo.id, true)).toBe(false);
    expect(order(engine, null)).toEqual([solo.id]);
    store.close();
  });

  it("a no-op drop returns false and rewrites nothing", async () => {
    const { engine, store } = make();
    const a = engine.createThread(null, "a");
    await tick();
    const b = engine.createThread(null, "b");
    // Order is [b, a]; dropping b ABOVE a keeps it — a true no-op.
    expect(engine.moveThread(b.id, a.id, false)).toBe(false);
    expect(threadOf(engine, a.id).sortOrder).toBeUndefined();
    expect(threadOf(engine, b.id).sortOrder).toBeUndefined();
    store.close();
  });

  it("moves a never-started thread to a project: gate passes, binding cleared", () => {
    const { engine, store } = make();
    const p = engine.createProject("proj");
    engine.toggleProject(p.id, false);
    const th = engine.createThread(null, "clean");
    // Give it a provider binding — applyThreadAffiliation must clear it.
    store.update(() => {
      threadOf(engine, th.id).providerThread = {
        providerId: "codex",
        codexThreadId: "codex-xyz",
        cwd: "/tmp/x",
        codexHomeId: "home",
        schemaPin: "pin",
        cliVersion: "0.0",
        savedAt: Date.now(),
      };
    });
    expect(engine.moveThreadToProject(th.id, p.id)).toBe(true);
    const moved = threadOf(engine, th.id);
    expect(moved.projectId).toBe(p.id);
    expect(moved.providerThread).toBeUndefined();
    expect(moved.sortOrder).toBeUndefined();
    // Target project expands (frozen applyThreadAffiliation).
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.expanded).toBe(true);
    // Nil sortOrder → top of the destination section.
    expect(order(engine, p.id)[0]).toBe(th.id);
    store.close();
  });

  it("moves a never-started thread to standalone", () => {
    const { engine, store } = make();
    const p = engine.createProject("proj");
    const th = engine.createThread(p.id, "clean");
    expect(engine.moveThreadToProject(th.id, null)).toBe(true);
    expect(threadOf(engine, th.id).projectId).toBeNull();
    expect(order(engine, null)[0]).toBe(th.id);
    store.close();
  });

  it("refuses to move a thread that has started, is archived, or is waiting", async () => {
    const { engine, store } = make();
    const p = engine.createProject("proj");
    const started = engine.createThread(null, "started");
    engine.sendTurn(started.id, "hello");
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.moveThreadToProject(started.id, p.id)).toBe(false);
    const archived = engine.createThread(null, "arch");
    engine.archiveThread(archived.id);
    expect(engine.moveThreadToProject(archived.id, p.id)).toBe(false);
    // Moving to the same affiliation is a no-op true (frozen parity).
    const clean = engine.createThread(p.id, "same");
    expect(engine.moveThreadToProject(clean.id, p.id)).toBe(true);
    store.close();
  });

  it("reorders projects by rewriting the array order", () => {
    const { engine, store } = make();
    const a = engine.createProject("a");
    const b = engine.createProject("b");
    const c = engine.createProject("c");
    expect(engine.snapshot().projects.map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(engine.moveProject(c.id, a.id, false)).toBe(true);
    expect(engine.snapshot().projects.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(engine.moveProject(c.id, c.id, true)).toBe(false);
    store.close();
  });

  it("ordering and affiliation changes survive a store reopen", () => {
    const root = tmp();
    const { engine, store } = make(root);
    const p = engine.createProject("proj");
    const a = engine.createThread(p.id, "a");
    const b = engine.createThread(p.id, "b");
    engine.moveThread(a.id, b.id, true);
    const solo = engine.createThread(null, "solo");
    engine.moveThreadToProject(solo.id, p.id);
    const q = engine.createProject("q");
    engine.moveProject(q.id, p.id, false);
    store.close();
    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    expect(order(engine2, p.id)).toEqual([solo.id, b.id, a.id]);
    expect(engine2.snapshot().projects.map((x) => x.id)).toEqual([q.id, p.id]);
    store2.close();
  });
});
