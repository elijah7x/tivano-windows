// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F02 archive management: frozen `deleteArchivedThreads(ids:)` — deletes
// exactly the archived∩ids set through the ordinary delete path (turn
// cancel, provider session end, checkpoints, worktree cleanup, segment
// files swept on flush), never matching unarchived or unknown ids. Also
// covers the confirmBeforeDeleting setting (frozen default on).

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { TURNS_DIRNAME } from "../src/main/store";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-arch-"));
  dirs.push(d);
  return d;
}
function makeEngine(root: string): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("deleteArchivedThreads (F02)", () => {
  it("deletes only the archived threads in the id set", () => {
    const { engine } = makeEngine(freshRoot());
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    const live = engine.createThread(null);
    engine.archiveThread(a.id);
    engine.archiveThread(b.id);
    const deleted = engine.deleteArchivedThreads([a.id, live.id]);
    // `live` is not archived — frozen filters isArchived && ids.contains,
    // so this channel must not delete it even when asked.
    expect(deleted).toEqual([a.id]);
    const ids = engine.snapshot().threads.map((t) => t.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(live.id);
  });

  it("skips unknown ids and returns only what was deleted", () => {
    const { engine } = makeEngine(freshRoot());
    const a = engine.createThread(null);
    engine.archiveThread(a.id);
    const deleted = engine.deleteArchivedThreads([a.id, "does-not-exist", a.id]);
    expect(deleted).toEqual([a.id]);
    expect(engine.snapshot().threads).toHaveLength(0);
  });

  it("emits a thread-removed event per deleted thread and clears selection", () => {
    const { engine } = makeEngine(freshRoot());
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    engine.archiveThread(a.id);
    engine.archiveThread(b.id);
    const deleted = engine.deleteArchivedThreads([a.id, b.id]);
    expect(deleted).toHaveLength(2);
    expect(events.filter((t) => t === "thread-removed")).toHaveLength(2);
  });

  it("sweeps the deleted threads' segment files on flush", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    engine.archiveThread(a.id);
    store.flushNow();
    expect(existsSync(join(root, TURNS_DIRNAME, `${a.id}.json`))).toBe(true);
    expect(existsSync(join(root, TURNS_DIRNAME, `${b.id}.json`))).toBe(true);
    engine.deleteArchivedThreads([a.id]);
    store.flushNow();
    expect(existsSync(join(root, TURNS_DIRNAME, `${a.id}.json`))).toBe(false);
    expect(existsSync(join(root, TURNS_DIRNAME, `${b.id}.json`))).toBe(true);
  });

  it("persists the deletion — a reopened store no longer has the thread", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const a = engine.createThread(null);
    engine.archiveThread(a.id);
    engine.deleteArchivedThreads([a.id]);
    store.flushNow();
    store.close();
    const reopened = new Store(root);
    reopened.open();
    try {
      expect(reopened.state.threads.find((t) => t.id === a.id)).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});

describe("confirmBeforeDeleting (F02)", () => {
  it("defaults to the frozen 'on' when the store predates the field", () => {
    const { engine } = makeEngine(freshRoot());
    // Absent from a pre-A43 store → frozen default true at read sites.
    expect(engine.snapshot().settings.confirmBeforeDeleting ?? true).toBe(true);
  });

  it("persists an explicit off/on through setSettings", () => {
    const { engine } = makeEngine(freshRoot());
    engine.setSettings({ confirmBeforeDeleting: false });
    expect(engine.snapshot().settings.confirmBeforeDeleting).toBe(false);
    engine.setSettings({ confirmBeforeDeleting: true });
    expect(engine.snapshot().settings.confirmBeforeDeleting).toBe(true);
  });
});
