// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F28 dock/taskbar badge: frozen AppModel.updateDockBadge — count of
// unread non-archived threads, driven by the injected OS hook.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-badge-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}

function spy() {
  const calls: number[] = [];
  return { calls, set: (n: number) => calls.push(n) };
}
const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;

describe("F28 dock badge (frozen updateDockBadge)", () => {
  it("reports the current count on attach, then tracks unread transitions", async () => {
    const { engine } = make();
    const s = spy();
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    engine.selectThread(a.id);
    engine.attachBadgeUpdater(s.set);
    expect(s.calls.at(-1)).toBe(0);

    // Turn finishes on the unselected thread → unread → badge 1.
    engine.sendTurn(b.id, "work");
    await waitFor(() => thread(engine, b.id).turn?.status === "done");
    expect(s.calls.at(-1)).toBe(1);

    // Selecting the thread spends the mark → badge 0 (frozen markRead).
    engine.selectThread(b.id);
    expect(s.calls.at(-1)).toBe(0);
  });

  it("counts multiple unread threads and excludes archived ones", async () => {
    const { engine } = make();
    const sel = engine.createThread(null);
    const x = engine.createThread(null);
    const y = engine.createThread(null);
    engine.selectThread(sel.id);
    const s = spy();
    engine.attachBadgeUpdater(s.set);

    engine.sendTurn(x.id, "one");
    engine.sendTurn(y.id, "two");
    await waitFor(
      () =>
        thread(engine, x.id).turn?.status === "done" &&
        thread(engine, y.id).turn?.status === "done",
    );
    expect(s.calls.at(-1)).toBe(2);

    engine.archiveThread(y.id);
    expect(s.calls.at(-1)).toBe(1);

    engine.deleteThread(x.id);
    expect(s.calls.at(-1)).toBe(0);
  });

  it("hydrated unread marks count after a restart", async () => {
    const root = tmp();
    const { store, engine } = make(root);
    const sel = engine.createThread(null);
    const bg = engine.createThread(null);
    engine.selectThread(sel.id);
    engine.sendTurn(bg.id, "persist me");
    await waitFor(() => thread(engine, bg.id).turn?.status === "done");
    expect(thread(engine, bg.id).hasUnread).toBe(true);
    engine.shutdown();
    store.close();

    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const s = spy();
    engine2.attachBadgeUpdater(s.set);
    expect(s.calls.at(-1)).toBe(1);
  });
});
