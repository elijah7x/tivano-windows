// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Session engine: stream ordering and per-thread isolation, approval
// allow/deny/session/always semantics, cancellation with late-event drops,
// duplicate resolution, error turns, recovery and double-send rejection.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/store";
import { Engine, EngineError } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type { AppEvent } from "../src/shared/ipc";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-eng-"));
  dirs.push(d);
  return d;
}

let events: AppEvent[];
function makeEngine(root: string, tickMs = 1): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs }), root, "0.0.0-test");
  engine.onEvent((e) => events.push(e));
  return { store, engine };
}

beforeEach(() => {
  events = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function pump(ms = 5000): void {
  vi.advanceTimersByTime(ms);
}

describe("turn streaming", () => {
  it("streams ordered chunks into the right thread and finishes", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "a");
    engine.sendTurn(t.id, "hello");
    pump();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    const asst = thread.messages.find((m) => m.role === "assistant")!;
    expect(thread.turn!.status).toBe("done");
    expect(asst.status).toBe("done");
    expect(asst.content).toContain("Mock Provider");
    // seq strictly increased; chunk events were ordered
    const chunks = events.filter((e) => e.type === "turn-chunk") as Array<{ seq: number }>;
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.seq).toBeGreaterThan(chunks[i - 1]!.seq);
  });

  it("persists a provider notice as a structured notice message with level and turnId", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "n");
    engine.sendTurn(t.id, "[mock:notice:warning] hi");
    pump();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    const notice = thread.messages.find((m) => m.kind === "notice")!;
    expect(notice.role).toBe("system");
    expect(notice.noticeLevel).toBe("warning");
    expect(notice.turnId).toBe(thread.turn!.id);
    expect(notice.content).toContain("warning notice");
  });

  it("F31: provider-generated title replaces the prompt fallback", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "fix the login flow");
    pump();
    await Promise.resolve(); // flush generateTitle microtask
    await Promise.resolve();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.title).toBe("Fix the login flow");
  });

  it("F31: textGeneration off keeps the prompt fallback", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    engine.setSettings({ textGeneration: "off" });
    const t = engine.createThread(null, "New thread");
    engine.sendTurn(t.id, "fix the login flow");
    pump();
    await Promise.resolve();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.title).toBe("fix the login flow");
  });

  it("F31: a user rename is never clobbered by a late generated title", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "New thread");
    engine.sendTurn(t.id, "fix the login flow");
    engine.renameThread(t.id, "My own name");
    pump();
    await Promise.resolve();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.title).toBe("My own name");
  });

  it("v2.2.34: keep-updated renames at the sixth completed turn, not before", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    engine.setSettings({ threadTitles: "updated" });
    const t = engine.createThread(null, "New thread");
    const send = async (p: string) => {
      engine.sendTurn(t.id, p);
      pump();
      await Promise.resolve(); // flush title microtasks
      await Promise.resolve();
    };
    await send("first work item");
    const snap = () => engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(snap().title).toBe("First work item");
    for (let i = 2; i <= 6; i++) await send(`follow up number ${i}`);
    expect(snap().title).toBe("First work item");
    await send("seventh totally different refactor");
    // Review context = last four user prompts → the new title is built
    // from later turns, not the first one.
    expect(snap().title).not.toBe("First work item");
    expect(snap().title).toContain("number 4");
  });

  it("v2.2.x: shelve round-trips and any real work wakes the project", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const p = engine.createProject("shelved-proj");
    engine.setProjectShelved(p.id, true);
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.isShelved).toBe(true);
    // A send into a shelved project wakes it (frozen real-work rule).
    const t = engine.createThread(p.id);
    engine.setProjectShelved(p.id, true);
    engine.sendTurn(t.id, "work resumes");
    pump();
    await Promise.resolve();
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.isShelved).toBeUndefined();
  });

  it("v2.2.x: createThread and moveThreadToProject wake the shelf", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const p = engine.createProject("wake-me");
    const a = engine.createProject("elsewhere");
    engine.setProjectShelved(p.id, true);
    engine.createThread(p.id);
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.isShelved).toBeUndefined();
    // Move a fresh (unstarted) thread into a shelved project → wakes it.
    engine.setProjectShelved(p.id, true);
    const t = engine.createThread(a.id);
    engine.moveThreadToProject(t.id, p.id);
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.isShelved).toBeUndefined();
  });

  it("v2.2.x: auto-shelve idles only past the window and exempts live chats", () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    engine.setSettings({ autoShelveDays: 3 });
    const p = engine.createProject("old");
    const t = engine.createThread(p.id);
    const proj = () => engine.snapshot().projects.find((x) => x.id === p.id)!;
    // Fresh → not shelved.
    engine.shelveIdleProjects();
    expect(proj().isShelved).toBeUndefined();
    // Age everything past 3 days — and deselect first: the fresh thread
    // is auto-selected, and an open chat is exempt by frozen rule.
    const stale = Date.now() - 4 * 86_400_000;
    (engine.snapshot().threads.find((x) => x.id === t.id)!).updatedAt = stale;
    store.update((d) => { d.ui.selectedThreadId = null; });
    engine.shelveIdleProjects(stale + 4 * 86_400_000);
    expect(proj().isShelved).toBe(true);
    // Manual unshelve restarts the clock even with a stale thread.
    engine.setProjectShelved(p.id, false);
    engine.shelveIdleProjects();
    expect(proj().isShelved).toBeUndefined();
  });

  it("v2.2.x: unread and open chats are never auto-shelved", () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    engine.setSettings({ autoShelveDays: 3 });
    const p = engine.createProject("unread-proj");
    const t = engine.createThread(p.id);
    const stale = Date.now() - 4 * 86_400_000;
    const th = engine.snapshot().threads.find((x) => x.id === t.id)!;
    th.updatedAt = stale;
    th.hasUnread = true;
    store.update((d) => { d.ui.selectedThreadId = null; });
    engine.shelveIdleProjects(stale + 4 * 86_400_000);
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.isShelved).toBeUndefined();
    // Open (selected) chat exempts too.
    th.hasUnread = false;
    store.update((d) => { d.ui.selectedThreadId = t.id; });
    engine.shelveIdleProjects(stale + 4 * 86_400_000);
    expect(engine.snapshot().projects.find((x) => x.id === p.id)!.isShelved).toBeUndefined();
  });

  it("v2.2.34: keep-updated never touches a user-set title", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    engine.setSettings({ threadTitles: "updated" });
    const t = engine.createThread(null, "New thread");
    engine.sendTurn(t.id, "first work item");
    pump();
    await Promise.resolve();
    engine.renameThread(t.id, "Pinned by me");
    for (let i = 2; i <= 8; i++) {
      engine.sendTurn(t.id, `more work ${i}`);
      pump();
    }
    await Promise.resolve();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.title).toBe("Pinned by me");
  });

  it("isolates simultaneous turns across threads", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const a = engine.createThread(null, "A");
    const b = engine.createThread(null, "B");
    engine.sendTurn(a.id, "first prompt AAA");
    engine.sendTurn(b.id, "second prompt BBB");
    pump();
    const snap = engine.snapshot();
    const ta = snap.threads.find((x) => x.id === a.id)!;
    const tb = snap.threads.find((x) => x.id === b.id)!;
    const ma = ta.messages.find((m) => m.role === "assistant")!;
    const mb = tb.messages.find((m) => m.role === "assistant")!;
    expect(ma.content).toContain("AAA");
    expect(ma.content).not.toContain("BBB");
    expect(mb.content).toContain("BBB");
    expect(mb.content).not.toContain("AAA");
    // every chunk event carried the correct thread id
    for (const e of events) {
      if (e.type === "turn-chunk") {
        const target = e.threadId === a.id ? ma : mb;
        expect(target.content).toContain((e.delta ?? "").trim());
      }
    }
  });

  it("rejects a second turn while one is running", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "slow [mock:slow]");
    expect(() => engine.sendTurn(t.id, "again")).toThrow(EngineError);
    pump();
  });
});

describe("approvals", () => {
  function approvalTurn(engine: Engine, threadId: string): void {
    engine.sendTurn(threadId, "please [mock:approval] this");
    pump(50); // reach waiting-approval
  }

  it("allow once: turn resumes and completes", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    approvalTurn(engine, t.id);
    const turn = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!;
    expect(turn.status).toBe("waiting-approval");
    const approval = turn.approval!;
    expect(approval.status).toBe("pending");
    engine.resolveApproval(t.id, approval.id, "once");
    pump();
    const done = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!;
    expect(done.status).toBe("done");
    expect(done.approval!.resolvedOptionId).toBe("once");
  });

  it("deny: turn ends denied and produces no further chunks", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    approvalTurn(engine, t.id);
    const approval = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.approval!;
    const chunksBefore = events.filter((e) => e.type === "turn-chunk").length;
    engine.resolveApproval(t.id, approval.id, "deny");
    pump();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.turn!.status).toBe("denied");
    const asst = thread.messages.find((m) => m.role === "assistant")!;
    expect(asst.status).toBe("denied");
    expect(events.filter((e) => e.type === "turn-chunk").length).toBe(chunksBefore);
  });

  it("session grant auto-approves the next request on this thread only", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t1 = engine.createThread(null, "one");
    const t2 = engine.createThread(null, "two");
    approvalTurn(engine, t1.id);
    const a1 = engine.snapshot().threads.find((x) => x.id === t1.id)!.turn!.approval!;
    engine.resolveApproval(t1.id, a1.id, "session");
    pump();
    // second turn on same thread: approval auto-resolves
    engine.sendTurn(t1.id, "again [mock:approval]");
    pump();
    const done1 = engine.snapshot().threads.find((x) => x.id === t1.id)!.turn!;
    expect(done1.status).toBe("done");
    expect(done1.approval!.autoResolved).toBe(true);
    // but a different thread still asks the user
    engine.sendTurn(t2.id, "also [mock:approval]");
    pump(50);
    const turn2 = engine.snapshot().threads.find((x) => x.id === t2.id)!.turn!;
    expect(turn2.status).toBe("waiting-approval");
  });

  it("always grant persists into settings", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    approvalTurn(engine, t.id);
    const a = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.approval!;
    engine.resolveApproval(t.id, a.id, "always");
    pump();
    expect(engine.snapshot().settings.alwaysAllow).toContain("mock:write-notes");
  });

  it("duplicate/conflicting resolution is rejected", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    approvalTurn(engine, t.id);
    const a = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.approval!;
    engine.resolveApproval(t.id, a.id, "deny");
    expect(() => engine.resolveApproval(t.id, a.id, "once")).toThrow(EngineError);
    // same option again is a harmless no-op
    expect(() => engine.resolveApproval(t.id, a.id, "deny")).not.toThrow();
  });

  it("refuses a pending approval sitting on a terminal turn", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    approvalTurn(engine, t.id);
    const a = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.approval!;
    engine.resolveApproval(t.id, a.id, "deny"); // settle it: turn → denied
    // Stale/inconsistent state: the approval somehow shows pending again
    // (a bad load, a replayed event) — it must still be refused.
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    thread.turn!.approval!.status = "pending";
    delete thread.turn!.approval!.resolvedOptionId;
    expect(() => engine.resolveApproval(t.id, a.id, "always")).toThrow(EngineError);
    // And it must NOT have minted a grant while refusing.
    expect(engine.snapshot().settings.alwaysAllow).not.toContain("mock:write-notes");
    expect(thread.sessionGrants).not.toContain("mock:write-notes");
  });

  it("refuses to revive a waiting turn whose provider handle is gone", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    approvalTurn(engine, t.id);
    const a = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.approval!;
    // Simulate a stale request arriving after the live turn was torn down.
    (engine as unknown as { handles: Map<string, unknown> }).handles.delete(t.id);
    expect(() => engine.resolveApproval(t.id, a.id, "once")).toThrow(EngineError);
    const turn = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!;
    expect(turn.status).toBe("waiting-approval"); // unchanged, not "running"
    expect(turn.approval!.status).toBe("pending"); // not falsely resolved
  });
});

describe("cancel and errors", () => {
  it("cancel stops the turn and drops late provider events", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "[mock:slow] go");
    pump(30);
    engine.cancelTurn(t.id);
    const chunksAfterCancel = events.filter((e) => e.type === "turn-chunk").length;
    pump();
    expect(events.filter((e) => e.type === "turn-chunk").length).toBe(chunksAfterCancel);
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.turn!.status).toBe("cancelled");
    expect(thread.messages.find((m) => m.role === "assistant")!.status).toBe("cancelled");
  });

  it("[mock:fail] ends the turn with a real error", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "boom [mock:fail]");
    pump();
    const turn = engine.snapshot().threads.find((x) => x.id === t.id)!.turn!;
    expect(turn.status).toBe("error");
    expect(turn.error).toContain("Synthetic provider error");
  });
});

describe("shutdown", () => {
  it("stops all provider timers so nothing writes during teardown", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "[mock:slow] go");
    pump(30);
    engine.shutdown();
    const chunks = events.filter((e) => e.type === "turn-chunk").length;
    pump(10000);
    expect(events.filter((e) => e.type === "turn-chunk").length).toBe(chunks);
  });

  it("marks in-flight turns interrupted instead of abandoning them", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "please [mock:approval] this");
    pump(50);
    expect(engine.snapshot().threads[0]!.turn!.status).toBe("waiting-approval");
    engine.shutdown();
    const thread = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(thread.turn!.status).toBe("interrupted");
    expect(thread.turn!.approval!.status).toBe("expired");
    const asst = thread.messages.find((m) => m.role === "assistant")!;
    expect(asst.status).toBe("interrupted");
    // The state persisted by shutdown survives a reload — no "running"
    // turn is left behind for the next launch.
    store.close();
    const { engine: engine2 } = makeEngine(root);
    const reloaded = engine2.snapshot().threads.find((x) => x.id === t.id)!;
    expect(reloaded.turn!.status).toBe("interrupted");
  });
});

describe("event revisions", () => {
  it("stamps a strictly increasing rev; snapshot rev is a boundary", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "hello");
    pump();
    const revs = events.map((e) => e.rev ?? -1);
    for (let i = 1; i < revs.length; i++) expect(revs[i]!).toBeGreaterThan(revs[i - 1]!);
    const snap = engine.snapshot();
    expect(snap.rev).toBe(Math.max(...revs));
    // Every stamped event is already reflected in a snapshot taken now.
    expect(snap.rev).toBeGreaterThanOrEqual(events[events.length - 1]!.rev!);
  });
});

describe("recovery", () => {
  it("surfaces a recovered corrupt store through app info", () => {
    const root = freshRoot();
    writeFileSync(join(root, "store.json"), "{ not json !!!");
    const store = new Store(root);
    const res = store.open();
    expect(res.recoveredFrom).toBeTruthy();
    const engine = new Engine(store, new MockProvider(), root, "0.0.0-test");
    expect(engine.info.recoveredFrom).toBeUndefined();
    engine.noteStoreRecovery(res.recoveredFrom);
    expect(engine.info.recoveredFrom).toBe(res.recoveredFrom);
    expect(engine.snapshot().info.recoveredFrom).toBe(res.recoveredFrom);
  });

  it("marks in-flight turns interrupted on reopen without resuming them", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "please [mock:approval] this");
    pump(50);
    expect(engine.snapshot().threads[0]!.turn!.status).toBe("waiting-approval");
    store.close(); // simulate shutdown mid-approval

    const { engine: engine2 } = makeEngine(root);
    const recovered = engine2.recoverInFlight();
    const thread = engine2.snapshot().threads.find((x) => x.id === t.id)!;
    expect(recovered).toContain(t.id);
    expect(thread.turn!.status).toBe("interrupted");
    expect(thread.turn!.approval!.status).toBe("expired");
    const asst = thread.messages.find((m) => m.role === "assistant")!;
    expect(asst.status).toBe("interrupted");
    expect(asst.content).toContain("interrupted by restart");
    // no auto-continue: nothing emits chunks after recovery
    const chunks = events.filter((e) => e.type === "turn-chunk").length;
    pump();
    expect(events.filter((e) => e.type === "turn-chunk").length).toBe(chunks);
    // and the thread still accepts a new turn
    engine2.sendTurn(t.id, "fresh message");
    pump();
    expect(thread.title).toBeDefined();
    const again = engine2.snapshot().threads.find((x) => x.id === t.id)!;
    expect(again.turn!.status).toBe("done");
  });
});

describe("P1-35 continue (frozen sendContinuation)", () => {
  it("a failed turn shows continuable and resumes in the same session", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "boom [mock:fail]");
    pump();
    expect(engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.status).toBe("error");
    expect(engine.canContinueTurn(t.id)).toBe(true);

    engine.continueTurn(t.id);
    const th = engine.snapshot().threads.find((x) => x.id === t.id)!;
    const user = th.messages[th.messages.length - 2]!;
    expect(user.role).toBe("user");
    expect(user.content).toBe(
      "The previous turn ended with an error. Check the current files and your earlier tool results, then continue the task from where you left off without repeating work that is already done.",
    );
    expect(th.turn!.status).toBe("running");
    pump();
    expect(engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.status).toBe("done");
    expect(engine.canContinueTurn(t.id)).toBe(false);
  });

  it("a cancelled (stopped) turn is continuable too", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "[mock:slow] go");
    pump(30);
    engine.cancelTurn(t.id);
    expect(engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.status).toBe("cancelled");
    expect(engine.canContinueTurn(t.id)).toBe(true);
    engine.continueTurn(t.id);
    pump();
    expect(engine.snapshot().threads.find((x) => x.id === t.id)!.turn!.status).toBe("done");
  });

  it("refuses a running turn, an archived thread and a head", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "t");
    engine.sendTurn(t.id, "[mock:slow] go");
    expect(engine.canContinueTurn(t.id)).toBe(false);
    expect(() => engine.continueTurn(t.id)).toThrow(EngineError);
    engine.cancelTurn(t.id);

    const archived = engine.createThread(null, "a");
    engine.sendTurn(archived.id, "boom [mock:fail]");
    pump();
    engine.archiveThread(archived.id);
    expect(engine.canContinueTurn(archived.id)).toBe(false);
    expect(() => engine.continueTurn(archived.id)).toThrow(EngineError);

    const head = engine.createThread(null, "h");
    engine.sendTurn(head.id, "boom [mock:fail]");
    pump();
    head.hydraHead = {
      leadId: head.id,
      headIndex: 0,
      name: "hank",
      task: "t",
      batchId: "b",
      status: "failed",
      spawnedAt: Date.now(),
    };
    expect(engine.canContinueTurn(head.id)).toBe(false);
    expect(() => engine.continueTurn(head.id)).toThrow(EngineError);
  });

  it("continueHydraHead re-runs a stopped head in its retained copy", () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    const head = engine.createThread(null, "h");
    engine.sendTurn(head.id, "[mock:slow] go");
    pump(30);
    engine.cancelTurn(head.id);
    head.hydraHead = {
      leadId: head.id,
      headIndex: 0,
      name: "hank",
      task: "t",
      batchId: "b",
      status: "stopped",
      baseTree: "a".repeat(40),
      spawnedAt: Date.now(),
    };
    head.worktreeDir = root;
    store.update(() => {});

    expect(() => engine.continueHydraHead(head.id)).not.toThrow();
    expect(head.hydraHead.status).toBe("running");
    const user = head.messages[head.messages.length - 2]!;
    expect(user.content).toContain("continue the task from where you left off");
    pump();
    expect(head.turn!.status).toBe("done");
  });

  it("continueHydraHead refuses a running head, a non-head and a copy-less head", () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const plain = engine.createThread(null, "p");
    expect(() => engine.continueHydraHead(plain.id)).toThrow(EngineError);

    const noCopy = engine.createThread(null, "n");
    noCopy.hydraHead = {
      leadId: noCopy.id,
      headIndex: 0,
      name: "hank",
      task: "t",
      batchId: "b",
      status: "failed",
      spawnedAt: Date.now(),
    };
    expect(() => engine.continueHydraHead(noCopy.id)).toThrow(EngineError);

    // A head whose own copy was released also refuses (frozen
    // worktreePath gate) — never a silent re-capture.
    const released = engine.createThread(null, "x");
    released.hydraHead = {
      leadId: released.id,
      headIndex: 0,
      name: "hank",
      task: "t",
      batchId: "b",
      status: "stopped",
      baseTree: "a".repeat(40),
      spawnedAt: Date.now(),
    };
    expect(() => engine.continueHydraHead(released.id)).toThrow(EngineError);

    const running = engine.createThread(null, "r");
    running.hydraHead = {
      leadId: running.id,
      headIndex: 0,
      name: "hank",
      task: "t",
      batchId: "b",
      status: "running",
      baseTree: "a".repeat(40),
      spawnedAt: Date.now(),
    };
    expect(() => engine.continueHydraHead(running.id)).toThrow(EngineError);
  });
});

describe("P2-01 composer next-prompt predictions", () => {
  it("returns scripted prediction after a completed turn and respects textGeneration=off", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "Predict");
    engine.sendTurn(t.id, "implement feature [mock:predict:Run the unit tests]");
    pump();
    await Promise.resolve();
    const res = await engine.predictNextPrompt(t.id);
    expect(res).toEqual({ prediction: "Run the unit tests" });

    engine.setSettings({ textGeneration: "off" });
    expect(await engine.predictNextPrompt(t.id)).toEqual({ prediction: null });
  });

  it("handles empty, invalid, and throwing provider predictions without interrupting the next turn", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const t = engine.createThread(null, "PredictErr");

    engine.sendTurn(t.id, "one [mock:predict-empty]");
    pump();
    expect(await engine.predictNextPrompt(t.id)).toEqual({ prediction: null });

    engine.sendTurn(t.id, "two [mock:predict-invalid]");
    pump();
    expect(await engine.predictNextPrompt(t.id)).toEqual({ prediction: null });

    engine.sendTurn(t.id, "three [mock:predict-fail]");
    pump();
    await expect(engine.predictNextPrompt(t.id)).resolves.toEqual({ prediction: null });

    // Next turn proceeds cleanly after a failed prediction.
    engine.sendTurn(t.id, "four [mock:predict:Check status]");
    pump();
    const snap = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(snap.turn?.status).toBe("done");
    expect(await engine.predictNextPrompt(t.id)).toEqual({ prediction: "Check status" });
  });

  it("discards stale prediction results if a new turn starts or textGeneration turns off mid-flight", async () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const base = new MockProvider({ tickMs: 1 });
    let resolvePred!: (v: string | null) => void;
    const spyProvider = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      generateNextPrompt: () =>
        new Promise<string | null>((r) => {
          resolvePred = r;
        }),
    });
    const engine = new Engine(store, spyProvider, root, "0.0.0-test");
    const t = engine.createThread(null, "Race");
    engine.sendTurn(t.id, "hello");
    pump();

    const p1 = engine.predictNextPrompt(t.id);
    engine.sendTurn(t.id, "follow up started before prediction returned");
    resolvePred(JSON.stringify({ suggestion: "Stale suggestion" }));
    expect(await p1).toEqual({ prediction: null });
    pump();

    const p2 = engine.predictNextPrompt(t.id);
    engine.setSettings({ textGeneration: "off" });
    resolvePred(JSON.stringify({ suggestion: "Disabled suggestion" }));
    expect(await p2).toEqual({ prediction: null });
  });

  it("skips prediction for external local-control turns, running turns, hydra heads, and queued follow-ups", async () => {
    const root = freshRoot();
    const { engine } = makeEngine(root);
    const ext = engine.createThread(null, "External");
    engine.sendTurn(ext.id, "from local control", { external: true });
    pump();
    expect(await engine.predictNextPrompt(ext.id)).toEqual({ prediction: null });

    const active = engine.createThread(null, "Running");
    engine.sendTurn(active.id, "still running");
    expect(await engine.predictNextPrompt(active.id)).toEqual({ prediction: null });
    pump();
    engine.enqueueFollowUp(active.id, "queued next");
    expect(await engine.predictNextPrompt(active.id)).toEqual({ prediction: null });

    const head = engine.createThread(null, "Head");
    head.hydraHead = {
      leadId: active.id,
      headIndex: 0,
      name: "Hank",
      task: "work",
      batchId: "b1",
      status: "completed",
      spawnedAt: 1,
    };
    head.turn = {
      id: "u1",
      threadId: head.id,
      status: "done",
      seq: 1,
      startedAt: 1,
      assistantMessageId: "m1",
    };
    expect(await engine.predictNextPrompt(head.id)).toEqual({ prediction: null });
  });
});