// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F29 task sleep prevention (frozen TaskSleepPrevention port): a token
// is held only while work runs and the mode is not off; mode switches
// re-issue the token; shutdown/wait-lifecycles release it; failures
// degrade honestly to off.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine, type SleepBlocker } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-sleep-"));
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

/** Fake OS blocker — records exactly what the engine asked the OS for. */
function fakeBlocker(failStart = false) {
  const calls: string[] = [];
  let next = 1;
  const blocker: SleepBlocker = {
    start: (mode) => {
      calls.push(`start:${mode}`);
      if (failStart) throw new Error("powerSaveBlocker unavailable");
      return next++;
    },
    stop: (id) => calls.push(`stop:${id}`),
  };
  return { blocker, calls };
}

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  engine.limitMarginMs = 0;
  return { store, engine };
}

describe("F29 task sleep prevention", () => {
  it("holds no token while off, even with a running turn", async () => {
    const { engine } = make();
    const { blocker, calls } = fakeBlocker();
    engine.attachSleepBlocker(blocker);
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "work");
    await waitFor(() => engine.snapshot().threads[0]!.turn?.status === "done");
    expect(calls).toEqual([]);
    expect(engine.snapshot().sleepPreventionActive).toBeUndefined();
  });

  it("starts the app token on a running turn and stops it at end", async () => {
    const { engine } = make();
    const { blocker, calls } = fakeBlocker();
    engine.attachSleepBlocker(blocker);
    engine.setSettings({ taskSleepMode: "system" });
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "[mock:approval] hold");
    await waitFor(
      () => engine.snapshot().threads[0]!.turn?.status === "waiting-approval",
    );
    expect(calls).toEqual(["start:app"]);
    expect(engine.snapshot().sleepPreventionActive).toBe(true);
    // Resolve the approval so the turn completes → token released.
    const turn = engine.snapshot().threads[0]!.turn!;
    engine.resolveApproval(tid, turn.approval!.id, "once");
    await waitFor(() => engine.snapshot().threads[0]!.turn?.status === "done");
    expect(calls).toEqual(["start:app", "stop:1"]);
    expect(engine.snapshot().sleepPreventionActive).toBeUndefined();
  });

  it("display mode maps to the display token", async () => {
    const { engine } = make();
    const { blocker, calls } = fakeBlocker();
    engine.attachSleepBlocker(blocker);
    engine.setSettings({ taskSleepMode: "display" });
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "[mock:approval] hold");
    await waitFor(
      () => engine.snapshot().threads[0]!.turn?.status === "waiting-approval",
    );
    expect(calls).toEqual(["start:display"]);
    engine.cancelTurn(tid);
    await waitFor(() => engine.snapshot().threads[0]!.turn?.status === "cancelled");
    expect(calls).toEqual(["start:display", "stop:1"]);
  });

  it("switching modes mid-turn re-issues the token", async () => {
    const { engine } = make();
    const { blocker, calls } = fakeBlocker();
    engine.attachSleepBlocker(blocker);
    engine.setSettings({ taskSleepMode: "system" });
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "[mock:approval] hold");
    await waitFor(
      () => engine.snapshot().threads[0]!.turn?.status === "waiting-approval",
    );
    engine.setSettings({ taskSleepMode: "display" });
    expect(calls).toEqual(["start:app", "stop:1", "start:display"]);
    engine.setSettings({ taskSleepMode: "off" });
    expect(calls).toEqual(["start:app", "stop:1", "start:display", "stop:2"]);
    // Turn still running — off mode holds nothing.
    expect(engine.snapshot().sleepPreventionActive).toBeUndefined();
    engine.cancelTurn(tid);
  });

  it("a limit wait counts as running work (frozen isWaitingForLimit)", async () => {
    const { engine } = make();
    const { blocker, calls } = fakeBlocker();
    engine.attachSleepBlocker(blocker);
    engine.setSettings({ taskSleepMode: "system", autoContinueAfterLimit: true });
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "[mock:limit:1] wait for me");
    await waitFor(() => engine.snapshot().limitResumesAt?.[tid] !== undefined);
    // Turn failed but the wait keeps the guard busy.
    expect(calls).toContain("start:app");
    engine.cancelLimitWait(tid);
    await waitFor(() => !engine.snapshot().sleepPreventionActive);
  });

  it("a blocker start failure degrades honestly to off", async () => {
    const { engine } = make();
    const { blocker } = fakeBlocker(true);
    engine.attachSleepBlocker(blocker);
    engine.setSettings({ taskSleepMode: "system" });
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "work");
    await waitFor(() => engine.snapshot().threads[0]!.turn?.status === "done");
    expect(engine.snapshot().sleepPreventionActive).toBeUndefined();
  });

  it("shutdown releases a held token", async () => {
    const { engine } = make();
    const { blocker, calls } = fakeBlocker();
    engine.attachSleepBlocker(blocker);
    engine.setSettings({ taskSleepMode: "system" });
    const tid = engine.createThread(null).id;
    engine.sendTurn(tid, "[mock:approval] hold");
    await waitFor(
      () => engine.snapshot().threads[0]!.turn?.status === "waiting-approval",
    );
    expect(calls).toEqual(["start:app"]);
    engine.shutdown();
    expect(calls).toEqual(["start:app", "stop:1"]);
    expect(engine.snapshot().sleepPreventionActive).toBeUndefined();
  });
});
