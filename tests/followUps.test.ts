// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F08 follow-up queue engine tests (frozen ThreadRuntime parity): queue
// drains ONLY after a completed turn; stopped/failed turns wait; bundles
// merge into one message; send-now and interrupt-send fire the moment
// the stop lands; persistence survives restart but never auto-sends.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine, EngineError } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type { CheckpointCoordinator } from "../src/main/checkpointTurns";
import type { ChatThread } from "../src/shared/types";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-followups-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}
const threadOf = (engine: Engine, id: string): ChatThread =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const userTexts = (engine: Engine, id: string) =>
  threadOf(engine, id).messages.filter((m) => m.role === "user").map((m) => m.content);
const turnStatus = (engine: Engine, id: string) => threadOf(engine, id).turn?.status;

describe("F08 follow-up queue", () => {
  it("queued behind a running turn; drains IN ORDER once it completes", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] first");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "second");
    engine.enqueueFollowUp(th.id, "third");
    expect(threadOf(engine, th.id).followUps).toHaveLength(2);
    // Approval resolves → turn completes → both drain in order.
    const approval = threadOf(engine, th.id).turn!.approval!;
    engine.resolveApproval(th.id, approval.id, "once");
    await waitFor(() => userTexts(engine, th.id).length >= 3);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    expect(userTexts(engine, th.id)).toEqual([
      "[mock:approval] first",
      "second",
      "third",
    ]);
    expect(threadOf(engine, th.id).followUps ?? []).toHaveLength(0);
    store.close();
  });

  it("a stopped turn never drains the queue — it waits for the user", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] work");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "later");
    engine.cancelTurn(th.id);
    await waitFor(() => turnStatus(engine, th.id) === "cancelled");
    await new Promise((r) => setTimeout(r, 80));
    expect(userTexts(engine, th.id)).toEqual(["[mock:approval] work"]);
    expect(threadOf(engine, th.id).followUps).toHaveLength(1);
    // Enqueueing more while idle must NOT flush either (still blocked).
    engine.enqueueFollowUp(th.id, "later2");
    await new Promise((r) => setTimeout(r, 80));
    expect(userTexts(engine, th.id)).toEqual(["[mock:approval] work"]);
    expect(threadOf(engine, th.id).followUps).toHaveLength(2);
    store.close();
  });

  it("bundleFollowUp moves the dragged item right after the bundle's last member", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "A");
    engine.enqueueFollowUp(th.id, "B");
    engine.enqueueFollowUp(th.id, "C");
    engine.enqueueFollowUp(th.id, "D");
    let items = threadOf(engine, th.id).followUps!;
    // Bundle A+B first, then drag D onto the bundle — D lands right after B.
    engine.bundleFollowUp(th.id, items[1]!.id, items[0]!.id);
    items = threadOf(engine, th.id).followUps!;
    engine.bundleFollowUp(th.id, items[3]!.id, items[0]!.id);
    items = threadOf(engine, th.id).followUps!;
    expect(items.map((i) => i.text)).toEqual(["A", "B", "D", "C"]);
    expect(items[2]!.bundleId).toBe(items[0]!.bundleId);
    expect(items[3]!.bundleId).toBeUndefined();
    // Bundling onto an item in the MIDDLE of a bundle shares the SAME id.
    engine.bundleFollowUp(th.id, items[3]!.id, items[1]!.id);
    items = threadOf(engine, th.id).followUps!;
    expect(items.map((i) => i.text)).toEqual(["A", "B", "D", "C"]);
    expect(items[3]!.bundleId).toBe(items[0]!.bundleId);
    store.close();
  });

  it("bundle merge produces one merged turn text", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "first part");
    engine.enqueueFollowUp(th.id, "second part");
    const items = threadOf(engine, th.id).followUps!;
    engine.bundleFollowUp(th.id, items[1]!.id, items[0]!.id);
    const approval = threadOf(engine, th.id).turn!.approval!;
    engine.resolveApproval(th.id, approval.id, "once");
    await waitFor(() => userTexts(engine, th.id).length >= 2);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    expect(userTexts(engine, th.id)).toEqual([
      "[mock:approval] hold",
      "first part\n\nsecond part",
    ]);
    store.close();
  });

  it("interruptAndSend fires the draft the moment the stop lands", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] running");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.interruptAndSend(th.id, "send this now");
    await waitFor(() => userTexts(engine, th.id).length >= 2);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    expect(userTexts(engine, th.id)).toEqual([
      "[mock:approval] running",
      "send this now",
    ]);
    store.close();
  });

  it("sendFollowUpNow while running: stop lands, queued text goes out", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] busy");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "queued one");
    engine.enqueueFollowUp(th.id, "queued two");
    const first = threadOf(engine, th.id).followUps![0]!;
    engine.sendFollowUpNow(th.id, first.id);
    // The stop lands → "queued one" fires as its own turn; once THAT
    // completes, the queue drains normally (frozen completed-drain).
    await waitFor(() => userTexts(engine, th.id).length >= 3);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    expect(userTexts(engine, th.id)).toEqual([
      "[mock:approval] busy",
      "queued one",
      "queued two",
    ]);
    store.close();
  });

  it("send-now during a pendingSend-fired turn fires right behind it", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:slow] grinding");
    await waitFor(() => turnStatus(engine, th.id) === "running");
    engine.interruptAndSend(th.id, "draft fired on stop");
    engine.enqueueFollowUp(th.id, "front of queue");
    const item = threadOf(engine, th.id).followUps![0]!;
    engine.sendFollowUpNow(th.id, item.id);
    await waitFor(() => userTexts(engine, th.id).length >= 3);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    // pendingSend (interrupt-send draft) lands first, the send-now item's
    // own pendingSend right behind it — strict order, none lost.
    expect(userTexts(engine, th.id)).toEqual([
      "[mock:slow] grinding",
      "draft fired on stop",
      "front of queue",
    ]);
    store.close();
  });

  it("interruptAndSend while a send is latched behind the stop queues in front, never overwrites", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] running");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    // 2.2.12 window: this port's cancelTurn→endTurn lands the stop
    // synchronously, so a latched+busy state survives only when the
    // cancel path itself fails mid-flight (a dead provider pipe, or —
    // here — a coordinator whose latch throws). The first message stays
    // armed behind a turn that never stopped.
    let failOnce = true;
    engine.attachCheckpoints({
      turnCancelled: () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("cancel-path failure");
        }
      },
      turnEnded: () => {},
      closing: () => {},
    } as unknown as CheckpointCoordinator);
    expect(() => engine.interruptAndSend(th.id, "first")).toThrow("cancel-path failure");
    const pending = (engine as unknown as { pendingSends: Map<string, string> })
      .pendingSends;
    expect(pending.get(th.id)).toBe("first");
    expect(turnStatus(engine, th.id)).toBe("waiting-approval"); // still busy
    // The second message must NOT overwrite the armed send — it queues
    // at the front of followUps instead.
    engine.interruptAndSend(th.id, "second");
    expect(threadOf(engine, th.id).followUps!.map((i) => i.text)).toEqual(["second"]);
    expect(pending.get(th.id)).toBe("first"); // unchanged
    // Nothing is lost: the latched send fires the moment the stop lands,
    // the queued message drains right behind its completed turn.
    engine.cancelTurn(th.id);
    await waitFor(() => userTexts(engine, th.id).length >= 3);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    expect(userTexts(engine, th.id)).toEqual([
      "[mock:approval] running",
      "first",
      "second",
    ]);
    store.close();
  });

  it("sendFollowUpNow while idle sends immediately even after a stop", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] x");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "explicit");
    engine.cancelTurn(th.id);
    await waitFor(() => turnStatus(engine, th.id) === "cancelled");
    const item = threadOf(engine, th.id).followUps![0]!;
    engine.sendFollowUpNow(th.id, item.id);
    await waitFor(() => userTexts(engine, th.id).length >= 2);
    expect(userTexts(engine, th.id)[1]).toBe("explicit");
    store.close();
  });

  it("move, remove, update and unbundle keep queue order honest", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "one");
    engine.enqueueFollowUp(th.id, "two");
    engine.enqueueFollowUp(th.id, "three");
    let items = threadOf(engine, th.id).followUps!;
    const [one, two, three] = items;
    // Move "three" before "one".
    engine.moveFollowUp(th.id, three!.id, one!.id, false);
    expect(threadOf(engine, th.id).followUps!.map((i) => i.text)).toEqual([
      "three",
      "one",
      "two",
    ]);
    // Bundle "one" onto "three" — both share one bundle id.
    engine.bundleFollowUp(th.id, one!.id, three!.id);
    items = threadOf(engine, th.id).followUps!;
    expect(items[0]!.bundleId).toBeTruthy();
    expect(items[1]!.bundleId).toBe(items[0]!.bundleId);
    expect(items[2]!.bundleId).toBeUndefined();
    // Removing the first bundle member leaves "one" bundled alone → tidy
    // dissolves the single-member bundle.
    engine.removeFollowUp(th.id, three!.id);
    items = threadOf(engine, th.id).followUps!;
    expect(items.map((i) => i.text)).toEqual(["one", "two"]);
    expect(items.every((i) => !i.bundleId)).toBe(true);
    // Update keeps order + text.
    engine.updateFollowUp(th.id, items[0]!.id, "one edited");
    expect(threadOf(engine, th.id).followUps![0]!.text).toBe("one edited");
    // Unbundle a bundled pair keeps both items.
    engine.bundleFollowUp(th.id, items[1]!.id, items[0]!.id);
    engine.unbundleFollowUp(th.id, items[1]!.id);
    items = threadOf(engine, th.id).followUps!;
    expect(items).toHaveLength(2);
    store.close();
  });

  it("bounds: full queue, empty text and unknown ids are rejected", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    for (let i = 0; i < 32; i++) engine.enqueueFollowUp(th.id, `q${i}`);
    expect(() => engine.enqueueFollowUp(th.id, "overflow")).toThrow(EngineError);
    expect(() => engine.enqueueFollowUp(th.id, "   ")).toThrow(EngineError);
    expect(() => engine.removeFollowUp(th.id, "nope")).toThrow(EngineError);
    expect(() => engine.updateFollowUp(th.id, "nope", "x")).toThrow(EngineError);
    expect(() => engine.sendFollowUpNow(th.id, "nope")).toThrow(EngineError);
    expect(() => engine.enqueueFollowUp("nope", "x")).toThrow(EngineError);
    store.close();
  });

  it("the queue survives restart — and restart never auto-sends", async () => {
    const root = tmp();
    const { engine, store } = make(root);
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => turnStatus(engine, th.id) === "waiting-approval");
    engine.enqueueFollowUp(th.id, "still here");
    engine.enqueueFollowUp(th.id, "and me");
    store.close();

    const r2 = make(root);
    r2.engine.recoverInFlight();
    const restored = r2.engine.snapshot().threads.find((t) => t.id === th.id)!;
    // Restart marked the in-flight turn interrupted; the queue persisted.
    expect(restored.followUps!.map((i) => i.text)).toEqual(["still here", "and me"]);
    expect(restored.turn?.status).toBe("interrupted");
    await new Promise((r) => setTimeout(r, 100));
    // Interrupted last status → no drain on its own, queue untouched.
    expect(restored.followUps).toHaveLength(2);
    expect(restored.messages.filter((m) => m.role === "user")).toHaveLength(1);
    r2.store.close();
  });

  it("enqueue while idle sends immediately (nothing to queue behind)", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.enqueueFollowUp(th.id, "right away");
    await waitFor(() => userTexts(engine, th.id).length >= 1);
    expect(userTexts(engine, th.id)).toEqual(["right away"]);
    await waitFor(() => turnStatus(engine, th.id) === "done");
    store.close();
  });
});

// ---- F02 archive (engine half) ---------------------------------------------

describe("archive", () => {
  it("archives, keeps the record, persists across reopen, restores", async () => {
    const root = tmp();
    const { store, engine } = make(root);
    const th = engine.createThread(null, "keep me");
    engine.archiveThread(th.id);
    expect(threadOf(engine, th.id)?.isArchived).toBe(true);
    engine.shutdown();
    store.close();

    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const reopened = threadOf(engine2, th.id)!;
    expect(reopened.isArchived).toBe(true);
    engine2.unarchiveThread(th.id);
    expect(threadOf(engine2, th.id)?.isArchived).toBe(false);
    engine2.shutdown();
    store2.close();
  });

  it("archiving the selected thread clears the selection", () => {
    const { store, engine } = make();
    const th = engine.createThread(null, "sel");
    engine.selectThread(th.id);
    engine.archiveThread(th.id);
    expect(threadOf(engine, th.id)?.isArchived).toBe(true);
    // Snapshot-level selection must be gone — the row left the list.
    expect(engine.snapshot().selectedThreadId).toBeNull();
    engine.shutdown();
    store.close();
  });

  it("archive does not cancel a running turn; unarchive is a no-op when live", async () => {
    const { store, engine } = make();
    const th = engine.createThread(null, "run");
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => threadOf(engine, th.id)?.turn?.status === "waiting-approval");
    engine.archiveThread(th.id);
    const after = threadOf(engine, th.id)!;
    expect(after.isArchived).toBe(true);
    expect(after.turn?.status).toBe("waiting-approval");
    engine.unarchiveThread(th.id);
    engine.unarchiveThread(th.id); // idempotent
    engine.shutdown();
    store.close();
  });
});

// ---- F02 pin (engine half) -------------------------------------------------

describe("pin", () => {
  it("pins, persists across reopen, unpins", async () => {
    const root = tmp();
    const { store, engine } = make(root);
    const th = engine.createThread(null, "pin me");
    engine.setThreadPinned(th.id, true);
    expect(threadOf(engine, th.id).isPinned).toBe(true);
    engine.setThreadPinned(th.id, true); // idempotent no-op
    engine.shutdown();
    store.close();
    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    expect(threadOf(engine2, th.id).isPinned).toBe(true);
    engine2.setThreadPinned(th.id, false);
    expect(threadOf(engine2, th.id).isPinned).toBe(false);
    engine2.shutdown();
    store2.close();
  });

  it("archiving clears the pin (frozen parity); restore stays unpinned", () => {
    const { store, engine } = make();
    const th = engine.createThread(null, "pin then archive");
    engine.setThreadPinned(th.id, true);
    engine.archiveThread(th.id);
    expect(threadOf(engine, th.id).isPinned).toBe(false);
    engine.unarchiveThread(th.id);
    expect(threadOf(engine, th.id).isPinned).toBe(false);
    engine.shutdown();
    store.close();
  });
});

// ---- F15 threadDirectory (engine half) ------------------------------------

describe("threadDirectory", () => {
  it("null without a project; the bound directory when live", () => {
    const { store, engine } = make();
    const lone = engine.createThread(null, "no project");
    expect(engine.threadDirectory(lone.id)).toBeNull();
    const proj = engine.createProject("proj");
    const th = engine.createThread(proj.id, "with project");
    // A project created in-app has no directory → still null, honestly.
    expect(engine.threadDirectory(th.id)).toBeNull();
    engine.shutdown();
    store.close();
  });
});

// ---- F28 unread marks (engine half) ---------------------------------------

describe("unread", () => {
  it("a finished turn on an UNSELECTED thread becomes unread; select clears", async () => {
    const { store, engine } = make();
    const a = engine.createThread(null, "a");
    const b = engine.createThread(null, "b");
    engine.selectThread(a.id);
    engine.sendTurn(b.id, "work");
    await waitFor(() => threadOf(engine, b.id).turn?.status === "done");
    expect(threadOf(engine, b.id).hasUnread).toBe(true);
    expect(threadOf(engine, b.id).unreadStatus).toBe("done");
    engine.selectThread(b.id);
    expect(threadOf(engine, b.id).hasUnread).toBe(false);
    expect(threadOf(engine, b.id).unreadStatus).toBeUndefined();
    engine.shutdown();
    store.close();
  });

  it("a turn ending on the SELECTED thread leaves no unread", async () => {
    const { store, engine } = make();
    const th = engine.createThread(null, "watched");
    engine.selectThread(th.id);
    engine.sendTurn(th.id, "work");
    await waitFor(() => threadOf(engine, th.id).turn?.status === "done");
    expect(threadOf(engine, th.id).hasUnread).toBeFalsy();
    engine.shutdown();
    store.close();
  });

  it("a user-cancelled turn is never unread", async () => {
    const { store, engine } = make();
    const a = engine.createThread(null, "a");
    const b = engine.createThread(null, "b");
    engine.selectThread(a.id);
    engine.sendTurn(b.id, "[mock:approval] hold");
    await waitFor(() => threadOf(engine, b.id).turn?.status === "waiting-approval");
    engine.cancelTurn(b.id);
    expect(threadOf(engine, b.id).hasUnread).toBeFalsy();
    engine.shutdown();
    store.close();
  });

  it("crash recovery marks the interrupted turn unread (frozen parity)", async () => {
    const root = tmp();
    const { store, engine } = make(root);
    const th = engine.createThread(null, "crash");
    engine.selectThread(th.id);
    engine.sendTurn(th.id, "[mock:approval] hold");
    await waitFor(() => threadOf(engine, th.id).turn?.status === "waiting-approval");
    engine.shutdown();
    store.close();
    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    engine2.recoverInFlight();
    const t2 = threadOf(engine2, th.id);
    expect(t2.turn?.status).toBe("interrupted");
    expect(t2.hasUnread).toBe(true);
    expect(t2.unreadStatus).toBe("interrupted");
    engine2.shutdown();
    store2.close();
  });
});
