// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// F09 conversation rewind (frozen ThreadRuntime.revert/resend, bounded):
// the target turn and everything after it leave the timeline, queued
// follow-ups go with them, the provider binding drops so the next turn
// opens a fresh conversation, files are always kept (in-place restore
// stays disabled), and resend sends the edited text from the rewound
// point. Refuses while a turn runs or the lead's heads are working.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-revert-"));
  dirs.push(d);
  return d;
}
function makeEngine(root: string): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const pump = (ms = 6000) => vi.advanceTimersByTime(ms);
const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;

describe("conversation rewind (F09)", () => {
  it("removes the target turn and everything after it, keeps earlier", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "first");
    pump();
    const turn2 = engine.sendTurn(t.id, "second");
    pump();
    engine.sendTurn(t.id, "third");
    pump();
    expect(thread(engine, t.id).messages.filter((m) => m.role === "user")).toHaveLength(3);

    engine.revertTurn(t.id, turn2.id);
    const cur = thread(engine, t.id);
    const users = cur.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users.map((u) => u.slice(-20))).toEqual(["first"]);
    expect(cur.turn).toBeNull();
    // The honest files-kept notice marks the rewind point.
    expect(cur.messages.some((m) => m.role === "system" && m.content.includes("File changes were kept"))).toBe(true);
  });

  it("drops queued follow-ups — they answered a rewound timeline", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    const turn = engine.sendTurn(t.id, "work");
    pump();
    // Queued items only sit while a turn runs — seed a leftover row the
    // way a crash mid-queue would have persisted it.
    (thread(engine, t.id).followUps ??= []).push({
      id: "fu-stale",
      text: "stale queue",
      createdAt: 1,
    });
    engine.revertTurn(t.id, turn.id);
    expect(thread(engine, t.id).followUps).toEqual([]);
  });

  it("clears the provider binding so the next turn opens a fresh conversation", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    const turn = engine.sendTurn(t.id, "hello");
    pump();
    // Simulate a bound provider conversation (codex resume identity).
    thread(engine, t.id).providerThread = {
      providerId: "codex",
      codexThreadId: "ct-1",
      cwd: "c:/x",
      codexHomeId: "h",
      schemaPin: "p",
      cliVersion: "unknown",
      savedAt: 1,
    };
    engine.revertTurn(t.id, turn.id);
    expect(thread(engine, t.id).providerThread).toBeUndefined();
  });

  it("resend rewinds then sends the edited text as a fresh turn", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    const turn = engine.sendTurn(t.id, "original ask");
    pump();
    engine.resendTurn(t.id, turn.id, "edited ask");
    pump();
    const cur = thread(engine, t.id);
    const users = cur.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users.some((u) => u.endsWith("edited ask"))).toBe(true);
    expect(users.some((u) => u.endsWith("original ask"))).toBe(false);
    expect(cur.turn?.status).toBe("done");
    expect(cur.turn!.id).not.toBe(turn.id);
  });

  it("refuses while a turn is still running", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    const turn = engine.sendTurn(t.id, "still going");
    expect(() => engine.revertTurn(t.id, turn.id)).toThrow(/running/);
  });

  it("refuses while the lead's hydra heads are working", () => {
    const { engine } = makeEngine(freshRoot());
    const lead = engine.createThread(null);
    const turn = engine.sendTurn(lead.id, "lead work");
    pump();
    const head = engine.createThread(null);
    head.hydraHead = {
      leadId: lead.id,
      headIndex: 0,
      name: "Hank",
      task: "t",
      batchId: "b",
      status: "running",
      spawnedAt: Date.now(),
    };
    expect(() => engine.revertTurn(lead.id, turn.id)).toThrow(/agents/);
    head.hydraHead!.status = "completed";
    expect(() => engine.revertTurn(lead.id, turn.id)).not.toThrow();
  });

  it("throws on a turn that is not in the thread", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "x");
    pump();
    expect(() => engine.revertTurn(t.id, "no-such-turn")).toThrow(/no longer/);
  });

  it("revertPreview counts the removed turns (no ledger → files 0)", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "one");
    pump();
    const turn2 = engine.sendTurn(t.id, "two");
    pump();
    engine.sendTurn(t.id, "three");
    pump();
    expect(engine.revertPreview(t.id, turn2.id)).toEqual({ turns: 2, files: 0 });
    expect(() => engine.revertPreview(t.id, "nope")).toThrow(/no longer/);
  });

  it("persists the rewound timeline across reopen", () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "keep me");
    pump();
    const turn2 = engine.sendTurn(t.id, "drop me");
    pump();
    engine.revertTurn(t.id, turn2.id);
    store.close?.();
    const store2 = new Store(root);
    store2.open();
    const reloaded = store2.state.threads.find((x) => x.id === t.id)!;
    const users = reloaded.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users.map((u) => u.slice(-20))).toEqual(["keep me"]);
    expect(reloaded.turn).toBeNull();
  });
});
