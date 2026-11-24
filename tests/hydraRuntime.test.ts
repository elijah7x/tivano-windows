// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22 Hydra runtime — engine slice (frozen delegation loop): streamed
// delegation spawns rostered heads, heads report back as a batched
// message once the batch settles and the lead is idle, a stopped head
// reports honestly, refusals land in the lead's queue, and an
// interrupted lead turn never claims heads it didn't send.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import { visibleThreads } from "../src/shared/threadOrder";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-hydra-"));
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

function make(tickMs = 1) {
  const root = tmp();
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs }), root, "0.0.0-test");
  return { store, engine, root };
}

const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const heads = (engine: Engine, leadId: string) =>
  engine
    .snapshot()
    .threads.filter((t) => t.hydraHead?.leadId === leadId)
    .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt);

describe("F22 Hydra runtime (frozen delegation slice)", () => {
  it("a delegation block spawns rostered heads; their reports land batched", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "split this up [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 2);

    const team = heads(engine, lead.id);
    expect(team.map((h) => h.hydraHead!.name)).toEqual(["Hank", "Walter"]);
    // tickMs=1 heads can already be finished by first observation.
    expect(
      team.every((h) =>
        ["running", "completed"].includes(h.hydraHead!.status),
      ),
    ).toBe(true);
    // Heads live in the panel, never the sidebar order.
    expect(
      visibleThreads([], engine.snapshot().threads).some((t) => t.hydraHead),
    ).toBe(false);
    expect(lead.hydraSpawnCount).toBe(2);

    await waitFor(() =>
      heads(engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    // The batch's reports arrive together as one lead turn.
    await waitFor(() =>
      thread(engine, lead.id).messages.some(
        (m) => m.role === "user" && m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("Hank");
    expect(report.content).toContain("Walter");
    expect(report.content).toContain("are there already");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    store.close();
  });

  it("steering a finished head runs it again and reports fresh (frozen steer)", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "split this up [mock:hydra]");
    await waitFor(() =>
      heads(engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const hank = heads(engine, lead.id).find(
      (h) => h.hydraHead!.name === "Hank",
    )!;
    const firstBatch = hank.hydraHead!.batchId;

    engine.sendTurn(hank.id, "keep going on it");
    // The steer marks the head at work again and re-times it.
    expect(hank.hydraHead!.status).toBe("running");
    expect(hank.hydraHead!.batchId).toBe(`steer-${hank.turn!.id}`);
    await waitFor(() => hank.hydraHead!.status === "completed");
    expect(hank.hydraHead!.batchId).not.toBe(firstBatch);

    // Its report reaches the lead as a fresh, solo-batch message.
    await waitFor(
      () =>
        thread(engine, lead.id).messages.filter((m) =>
          m.content.includes("Hydra reports:"),
        ).length === 2,
    );
    const second = thread(engine, lead.id)
      .messages.filter((m) => m.content.includes("Hydra reports:"))
      .at(-1)!;
    expect(second.content).toContain("Hank");
    expect(second.content).not.toContain("Walter");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    store.close();
  });

  it("steering while a head still runs queues through the normal follow-up path", async () => {
    const { engine, store } = make(400); // slow: the head stays running
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 2 &&
        heads(engine, lead.id).every((h) => h.turn?.status === "running"),
    );
    const hank = heads(engine, lead.id)[0]!;
    // Busy: sendTurn throws — the frozen steering queue is the follow-up
    // path, which the composer drains when the turn ends.
    expect(() => engine.sendTurn(hank.id, "and one more thing")).toThrow();
    engine.enqueueFollowUp(hank.id, "and one more thing");
    // The queued steer goes out as its own turn once the running one ends.
    await waitFor(
      () =>
        hank.messages.some(
          (m) => m.role === "user" && m.content === "and one more thing",
        ),
      15_000,
    );
    store.close();
  }, 20_000);

  it("a second delegation turn wears the next roster names", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    // report turn lands and finishes
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) => m.content.includes("Hydra reports:")),
    );
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    engine.sendTurn(lead.id, "again [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 4);
    const names = heads(engine, lead.id).map((h) => h.hydraHead!.name);
    expect(names.slice(2)).toEqual(["Ada", "Otto"]);
    await waitFor(() => thread(engine, lead.id).turn?.status === "done", 15_000);
    store.close();
  });

  it("stopHydraHead turns a held head into an honest stopped report", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-wait]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    const head = heads(engine, lead.id)[0]!;
    engine.stopHydraHead(head.id);
    await waitFor(() => head.hydraHead!.status === "stopped");
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("stopped by the user");
    store.close();
  });

  it("a head parked on an approval is noted to the lead and returns to work", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-wait]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    const head = heads(engine, lead.id)[0]!;
    // Waiting is a turn state — the head record stays running so the
    // panel can read the pending reason off the turn (frozen).
    expect(head.hydraHead!.status).toBe("running");
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("is waiting for your answer"),
      ),
    );
    const note = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("is waiting for your answer"),
    )!;
    expect(note.kind).toBe("notice");
    expect(note.content).toContain(
      "Hank is waiting for your answer. Open it from the Hydra panel to reply.",
    );
    engine.resolveApproval(head.id, head.turn!.approval!.id, "once");
    await waitFor(() => head.hydraHead!.status === "completed");
    store.close();
  });

  it("a head parked on a question is noted and resumes when answered", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitq]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.question?.status === "pending",
    );
    const head = heads(engine, lead.id)[0]!;
    expect(head.turn?.status).toBe("running");
    expect(head.hydraHead!.status).toBe("running");
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("is waiting for your answer"),
      ),
    );
    engine.answerQuestion(head.id, "mock-q-1", { q1: ["continue"] });
    await waitFor(() => head.hydraHead!.status === "completed");
    store.close();
  });

  it("Hydra off refuses the delegation into the lead's queue", async () => {
    const { engine, store } = make();
    engine.setSettings({ hydraEnabled: false });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    expect(heads(engine, lead.id)).toHaveLength(0);
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra did not send the head"),
      ),
    );
    store.close();
  });

  it("an interrupted lead turn strips the block and notes unsent heads", async () => {
    const { engine, store } = make(50); // slow enough to cancel mid-block
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 1);
    engine.cancelTurn(lead.id);
    await waitFor(
      () => thread(engine, lead.id).turn?.status === "cancelled",
    );
    const msg = thread(engine, lead.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(msg.content).not.toContain("```hydra");
    expect(msg.content).toContain("never went out");
    await waitFor(
      () => heads(engine, lead.id)[0]!.hydraHead!.status === "completed",
    );
    store.close();
  });

  it("stopHydraHead rejects a non-head thread", () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    expect(() => engine.stopHydraHead(lead.id)).toThrow("not a hydra head");
    store.close();
  });

  it("head metadata survives a store round-trip", async () => {
    const { engine, store, root } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    store.close();

    const store2 = new Store(root);
    store2.open();
    const reloaded = store2.state.threads.find((t) => t.hydraHead);
    expect(reloaded?.hydraHead?.name).toBe("Hank");
    expect(reloaded?.hydraHead?.batchId).toBeTruthy();
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// A58 — F22 pair binding: the stored pair's cap/profiles/provider now
// participate in dispatch; over-cap delegations queue (frozen
// hydraWaiting) instead of refusing; a finished turn marks its block
// hydra-sent; the lead's policy rides its turns.

import { newHydraPair, newHeadProfile } from "../src/shared/hydra";

describe("A58 pair binding (frozen hydraLaunch slice)", () => {
  it("a page cap paces extra delegations through the waiting queue", async () => {
    const { engine, store } = make();
    engine.setSettings({ hydraMaxHeads: 1 });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    // Cap 1: the held head is out; parts two+three wait in hydraWaiting.
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    expect(heads(engine, lead.id)).toHaveLength(1);
    // Stopping the held head drains one waiting entry, which finishes
    // and drains the next — all three land as one batch report.
    engine.stopHydraHead(heads(engine, lead.id)[0]!.id);
    await waitFor(() => heads(engine, lead.id).length === 3);
    await waitFor(() =>
      heads(engine, lead.id).every((h) =>
        ["completed", "stopped"].includes(h.hydraHead!.status),
      ),
    );
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("Part two");
    expect(report.content).toContain("Part three");
    store.close();
  });

  it("a pair's own cap applies even without a page cap", async () => {
    const { engine, store } = make();
    const pair = { ...newHydraPair("mock"), maxHeads: 1 };
    engine.setSettings({ hydraPairs: [pair], lastHydraPairId: pair.id });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    // The pair's cap is honoured: one held, two queued.
    expect(heads(engine, lead.id)).toHaveLength(1);
    engine.stopHydraHead(heads(engine, lead.id)[0]!.id);
    await waitFor(() => heads(engine, lead.id).length === 3);
    store.close();
  });

  // #102 (audit follow-up on #95): the adaptive lock also counts the
  // cap-held waiting queue — frozen canSwitchChimeraMode requires
  // hydraWaitingCount == 0, not just no running/pending heads.
  it("the adaptive mode switch refuses while delegations wait under the cap", async () => {
    const { engine, store } = make();
    engine.setSettings({ hydraMaxHeads: 1 });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    // Two delegations sit in hydraWaiting AND the held head keeps the
    // lead busy — the combined guard refuses either way.
    expect(() => engine.setSubagentMode(lead.id, "adaptive")).toThrow(
      /switch modes/,
    );
    // Non-adaptive switches stay free (frozen: only the adaptive edge
    // is locked).
    expect(() => engine.setSubagentMode(lead.id, "same")).not.toThrow();
    store.close();
  });

  // The queued-cap scenario above always has the held head busy too, so
  // it cannot prove the queue term alone refuses. Isolate it: a stranded
  // hydraWaiting entry with no running heads and no pending reports —
  // hydraLeadBusy is false, so only the waiting-queue clause can throw.
  // (Queued entries share their head's batch, which keeps that head's
  // report pending — no public flow reaches queue>0 && !busy, so the
  // queue is seeded directly; reverting the clause fails this test.)
  it("the waiting queue alone locks the adaptive switch", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    const waiting = (
      engine as unknown as {
        hydraWaiting: Map<string, { d: { task: string }; batchId: string; queuedAt: number }[]>;
      }
    ).hydraWaiting;
    waiting.set(lead.id, [
      { d: { task: "stranded" }, batchId: "stranded-batch", queuedAt: 1 },
    ]);
    // Control: nothing is at work — no heads, no reports.
    expect(heads(engine, lead.id)).toHaveLength(0);
    expect(() => engine.setSubagentMode(lead.id, "adaptive")).toThrow(
      /switch modes/,
    );
    expect(() => engine.setSubagentMode(lead.id, "same")).not.toThrow();
    store.close();
  });

  it("leaving adaptive also refuses while delegations wait", async () => {
    const { engine, store } = make();
    engine.setSettings({ hydraMaxHeads: 1 });
    const lead = engine.createThread(null, "lead");
    engine.setSubagentMode(lead.id, "adaptive");
    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    expect(() => engine.setSubagentMode(lead.id, "same")).toThrow(
      /switch modes/,
    );
    store.close();
  });

  it("a profile-routed head wears the profile name and its model fields", async () => {
    const { engine, store } = make();
    const profile = {
      ...newHeadProfile("deep"),
      model: "fixture-deep",
      effort: "high",
    };
    const pair = { ...newHydraPair("mock"), headProfiles: [profile] };
    engine.setSettings({ hydraPairs: [pair], lastHydraPairId: pair.id });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-profile]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    const [routed, plain] = heads(engine, lead.id);
    expect(routed!.hydraHead!.profile).toBe("deep");
    expect(routed!.title).toContain("· deep");
    expect(routed!.codexModel).toBe("fixture-deep");
    expect(routed!.codexEffort).toBe("high");
    expect(plain!.hydraHead!.profile).toBeUndefined();
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    store.close();
  });

  it("a foreign-provider profile falls back to the shared fields", async () => {
    const { engine, store } = make();
    const profile = {
      ...newHeadProfile("deep"),
      provider: "other-provider",
      model: "fixture-deep",
    };
    const pair = { ...newHydraPair("mock"), headProfiles: [profile] };
    engine.setSettings({ hydraPairs: [pair], lastHydraPairId: pair.id });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-profile]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    const [first] = heads(engine, lead.id);
    // Unrunnable profile → unrouted: no profile mark, no foreign model.
    expect(first!.hydraHead!.profile).toBeUndefined();
    expect(first!.codexModel).toBeUndefined();
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    store.close();
  });

  it("a pair sending heads elsewhere keeps them local and says so once", async () => {
    const { engine, store } = make();
    const pair = {
      ...newHydraPair("mock"),
      workerProvider: "other-provider",
      workerModel: "foreign-model",
    };
    engine.setSettings({ hydraPairs: [pair], lastHydraPairId: pair.id });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    // The foreign worker model was never honoured — heads keep the
    // chat's own (none seeded).
    expect(heads(engine, lead.id).every((h) => h.codexModel === undefined)).toBe(
      true,
    );
    const notes = thread(engine, lead.id).messages.filter((m) =>
      m.content.includes("is not available in this build"),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain("other-provider");
    store.close();
  });

  it("a pair stored for another provider binds nothing", async () => {
    const { engine, store } = make();
    const pair = { ...newHydraPair("other-provider"), maxHeads: 1 };
    engine.setSettings({ hydraPairs: [pair], lastHydraPairId: pair.id });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    // The pair's cap would hold the second head back — it does not.
    await waitFor(() => heads(engine, lead.id).length === 2);
    store.close();
  });

  it("a completed lead turn marks its block hydra-sent", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra]");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    const msg = thread(engine, lead.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(msg.content).toContain("```hydra-sent");
    expect(msg.content).not.toMatch(/```hydra[ \t]*\n/);
    store.close();
  });

  it("the lead policy reaches the provider on a Hydra-on user turn", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "hello");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    // The mock echoes the bounded tail of the wire prompt — the
    // policy's own tail proves the preamble was delivered.
    const reply = thread(engine, lead.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(reply.content).toContain("settled or fixed yourself");
    // Hydra off — no policy.
    engine.setSettings({ hydraEnabled: false });
    const lead2 = engine.createThread(null, "lead2");
    engine.sendTurn(lead2.id, "hello");
    await waitFor(() => thread(engine, lead2.id).turn?.status === "done");
    const reply2 = thread(engine, lead2.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(reply2.content).not.toContain("settled or fixed yourself");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// P1-19 (2.2.12 parity): a head that cannot start ends failed — never
// running without a turn, never with its watchdog armed — and its
// explanation reaches the lead even while the lead is idle (frozen
// failHydraRoute + hydraHeadFinished's immediate flush). A routing
// error shows once, not again with each later message.

describe("P1-19 failed spawns (frozen failHydraRoute)", () => {
  it("an unroutable head ends failed; the routing note shows once", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-badroute]");
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status === "failed");
    // Failed at spawn: it never held a turn and no watchdog stays armed.
    expect(head.turn).toBeNull();
    expect(head.hydraHead!.summary).toContain("no project named ghost-proj");
    expect(
      (engine as unknown as { hydraWatchdogs: Map<string, unknown> })
        .hydraWatchdogs.has(head.id),
    ).toBe(false);
    // The routing error lands once on the lead's timeline…
    const notes = () =>
      thread(engine, lead.id).messages.filter(
        (m) =>
          m.kind === "notice" && m.content.includes("no project named ghost-proj"),
      );
    await waitFor(() => notes().length === 1);
    // …and inside the head's report, delivered once the lead is idle.
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("no project named ghost-proj");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    // A later lead turn must not re-show the routing error.
    engine.sendTurn(lead.id, "thanks");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    expect(notes()).toHaveLength(1);
    store.close();
  });

  it("a queued head that cannot start still flushes its report to an idle lead", async () => {
    const { engine, store } = make();
    engine.setSettings({ hydraMaxHeads: 1 });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitroute]");
    // Cap 1: the held head is out; the unroutable entry waits in
    // hydraWaiting until the slot frees.
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    // Stopping the held head frees the slot — the queued delegation
    // spawns while the lead is idle and fails at once; both reports
    // flush anyway rather than staying queued.
    engine.stopHydraHead(heads(engine, lead.id)[0]!.id);
    await waitFor(() => heads(engine, lead.id).length === 2);
    await waitFor(() =>
      heads(engine, lead.id).every((h) =>
        ["stopped", "failed"].includes(h.hydraHead!.status),
      ),
    );
    const failed = heads(engine, lead.id).find(
      (h) => h.hydraHead!.status === "failed",
    )!;
    expect(failed.turn).toBeNull();
    expect(failed.hydraHead!.summary).toContain("no project named ghost-proj");
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("no project named ghost-proj");
    expect(report.content).toContain("Hold for approval");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// P1-21 (2.0.22/2.2.12 parity): a head that failed with a non-transient
// error before it said anything or ran a tool is a startup failure — the
// report gives ONE cause per provider, with the error shown once. A
// transient error never produces provider-broken wording.

describe("P1-21 startup failures (frozen startupFailure + per-provider cause)", () => {
  it("quiet-fail heads with a sibling done read as likely temporary", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-failstart]");
    await waitFor(() => heads(engine, lead.id).length === 3);
    await waitFor(() =>
      heads(engine, lead.id).every((h) =>
        ["completed", "failed"].includes(h.hydraHead!.status),
      ),
    );
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    // Two heads failed the same way before any work: the error shows
    // once, the second names the first, and a completed sibling on the
    // same provider makes the cause read as likely temporary.
    expect(report.content).toContain("Same startup failure as Hank.");
    expect(report.content).toContain("likely temporary");
    expect(report.content).not.toContain("environment (its install");
    expect(report.content).not.toContain(
      "do it yourself or send it out again",
    );
    store.close();
  });

  it("a batch that all failed at start reads as the provider's environment", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-failall]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    await waitFor(() =>
      heads(engine, lead.id).every(
        (h) => h.hydraHead!.status === "failed",
      ),
    );
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("Same startup failure as Hank.");
    expect(report.content).toContain("before doing any work");
    expect(report.content).toContain(
      "environment (its install, sign-in, configuration or MCP servers)",
    );
    expect(report.content).toContain("Do their parts yourself");
    expect(report.content).not.toContain("likely temporary");
    expect(report.content).not.toContain(
      "do it yourself or send it out again",
    );
    store.close();
  });

  it("a transient quiet-fail keeps the generic take-over wording", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-failtransient]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    await waitFor(() =>
      heads(engine, lead.id).every((h) =>
        ["completed", "failed"].includes(h.hydraHead!.status),
      ),
    );
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain(
      "do it yourself or send it out again",
    );
    expect(report.content).not.toContain("before doing any work");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// P1-36 (v3.0.0 parity): sub-agent modes + the delegation budget —
// five rounds per request, at most two refunded all-empty batches, the
// queued-heads note on the lead's wire prompt, and an authored message
// (never a report/refusal turn) restarting the count.

const budget = (engine: Engine) =>
  engine as unknown as {
    hydraRounds: Map<string, number>;
    hydraRefunds: Map<string, number>;
    hydraBudgetGen: Map<string, number>;
  };

describe("P1-36 sub-agent modes and the delegation budget", () => {
  it("the 5-round budget refuses the 6th delegation round", { timeout: 20000 }, async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "split [mock:hydra-loop]");
    await waitFor(() =>
      thread(engine, lead.id).messages.some(
        (m) =>
          m.role === "user" &&
          m.content.includes("used all 5 of its rounds of heads"),
      ),
    );
    // The refusal drains as a non-authored turn: the spent budget and
    // the request's generation both survive it (frozen refuse-turn
    // semantics — a refusal never restarts the count).
    await waitFor(() =>
      thread(engine, lead.id).messages.some(
        (m) =>
          m.role === "assistant" &&
          m.content.includes("Fixed reply from the **Mock Provider**"),
      ),
    );
    expect(budget(engine).hydraRounds.get(lead.id)).toBe(5);
    expect(budget(engine).hydraBudgetGen.get(lead.id)).toBe(1);
    store.close();
  });

  it("all-empty batches refund their round — at most twice a request", { timeout: 20000 }, async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "split [mock:hydra-loop-fail]");
    await waitFor(() =>
      thread(engine, lead.id).messages.some(
        (m) =>
          m.role === "user" &&
          m.content.includes("used all 5 of its rounds of heads"),
      ),
    );
    // Rounds 1+2 refunded (7 heads spawned over 5 net rounds), then
    // the refund tap closed and the budget refused the next block.
    await waitFor(() => budget(engine).hydraRefunds.get(lead.id) === 2);
    expect(heads(engine, lead.id)).toHaveLength(7);
    expect(budget(engine).hydraRounds.get(lead.id)).toBe(5);
    store.close();
  });

  it("a batch that did something is never refunded", { timeout: 15000 }, async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    // Two quiet-fail heads plus one that completes: the batch is not
    // all-empty, so no round comes back.
    engine.sendTurn(lead.id, "split [mock:hydra-failstart]");
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    expect(budget(engine).hydraRefunds.get(lead.id) ?? 0).toBe(0);
    expect(budget(engine).hydraRounds.get(lead.id)).toBe(1);
    store.close();
  });

  it("the report-turn prompt sees the refunded round", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    const e = engine as any;
    // A lead that spent its 5th round on an all-fail batch: the refund
    // lands BEFORE the report turn's prompt is built, so the lead is
    // told it may delegate again, not "no more heads".
    budget(engine).hydraRounds.set(lead.id, 5);
    e.hydraBudgetGen.set(lead.id, 1);
    e.hydraBatchGen.set("b1", 1);
    e.hydraPendingReports.set(lead.id, [
      {
        headIndex: 0,
        task: "probe",
        status: "failed",
        text: "boom",
        batchId: "b1",
        copyPath: "c:/scratch/b1",
      },
    ]);
    e.flushHydraReports(lead.id);
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    const reply = thread(engine, lead.id)
      .messages.filter((m) => m.role === "assistant")
      .at(-1)!.content;
    expect(reply).toContain("send heads out again for exactly that");
    expect(reply).not.toContain("Send out no more heads");
    expect(budget(engine).hydraRounds.get(lead.id)).toBe(4);
    store.close();
  });

  it("an authored message restarts the budget", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "split [mock:hydra]");
    await waitFor(() =>
      heads(engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    // The report turn is non-authored: the spent round stays charged.
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    expect(budget(engine).hydraRounds.get(lead.id)).toBe(1);
    engine.sendTurn(lead.id, "next request");
    expect(budget(engine).hydraRounds.get(lead.id) ?? 0).toBe(0);
    expect(budget(engine).hydraBudgetGen.get(lead.id)).toBe(2);
    store.close();
  });

  it("cap-held delegations announce themselves on the lead's next prompt", async () => {
    const { engine, store } = make();
    engine.setSettings({ hydraMaxHeads: 1 });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    // Two delegations wait under cap 1 — the next lead prompt opens
    // with the frozen queued-heads note.
    engine.sendTurn(lead.id, "keep going");
    await waitFor(() =>
      thread(engine, lead.id).messages.some(
        (m) =>
          m.role === "assistant" &&
          m.content.includes("queued, not lost"),
      ),
    );
    const reply = thread(engine, lead.id).messages.find(
      (m) => m.role === "assistant" && m.content.includes("queued, not lost"),
    )!;
    expect(reply.content).toContain("2 of your tasks are queued");
    expect(reply.content).toContain("the cap allows 1 head at once");
    store.close();
  });

  it("Same-model ignores the saved pair's cap; Preset honours it", async () => {
    const { engine, store } = make();
    const pair = { ...newHydraPair("mock"), maxHeads: 1 };
    engine.setSettings({ hydraPairs: [pair], lastHydraPairId: pair.id });
    // Derived Preset: the chat inherits the last pair — cap 1 holds
    // two of the three delegations back.
    const lead = engine.createThread(null, "lead");
    expect(lead.subagentMode).toBeUndefined();
    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    expect(heads(engine, lead.id)).toHaveLength(1);
    // Same-model: the pair's cap no longer applies — all three go out.
    const lead2 = engine.createThread(null, "lead2");
    engine.setSubagentMode(lead2.id, "same");
    expect(thread(engine, lead2.id).subagentMode).toBe("same");
    engine.sendTurn(lead2.id, "go [mock:hydra-waitmany]");
    await waitFor(() => heads(engine, lead2.id).length === 3);
    store.close();
  });

  it("the adaptive mode's role instruction reaches the provider", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.setSubagentMode(lead.id, "adaptive");
    expect(engine.snapshot().settings.subagentModeDefault).toBe("adaptive");
    engine.sendTurn(lead.id, "hello");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    const reply = thread(engine, lead.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(reply.content).toContain('job title in "role"');
    store.close();
  });

  it("a `role` entry lands as the head's task (frozen Chimera field)", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-role]");
    await waitFor(() => heads(engine, lead.id).length === 1);
    expect(heads(engine, lead.id)[0]!.hydraHead!.task).toBe("Outline it");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// P1-37 (v3.0.0 parity): adaptive sub-agent identities — the six built-ins
// plus custom presets numbered in the policy, "identity" entries resolving
// to a preset prompt + model pick, and the auto-dispatch note.

describe("P1-37 adaptive sub-agent identities", () => {
  it("the adaptive policy lists identities and the auto-dispatch note", async () => {
    const { engine, store } = make();
    const lead = engine.createThread(null, "lead");
    engine.setSubagentMode(lead.id, "adaptive");
    engine.setSettings({ chimeraAutoDispatch: true });
    engine.sendTurn(lead.id, "hello");
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    const reply = thread(engine, lead.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(reply.content).toContain("sub-agent identities");
    expect(reply.content).toContain("1. Scout:");
    expect(reply.content).toContain("6. Writer:");
    expect(reply.content).toContain('"identity"');
    expect(reply.content).toContain("Heads go out at once");
    expect(reply.content).toContain("replaces any Hydra delegation rules");
    store.close();
  });

  it("an identity entry sends the preset prompt and its model pick", async () => {
    const { engine, store } = make();
    engine.setSettings({
      chimeraPresets: [
        {
          id: "c1",
          name: "Deep",
          specialty: "You dig deep for roots.",
          pick: { model: "deep-model" },
          enabled: true,
        },
      ],
    });
    const lead = engine.createThread(null, "lead");
    engine.setSubagentMode(lead.id, "adaptive");
    engine.sendTurn(lead.id, "go [mock:hydra-identity]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    const first = heads(engine, lead.id)[0]!;
    // identity 1 -> the custom preset: its prompt rides the brief and
    // its pick supplies the head model; the unnumbered head follows
    // the lead (no pick).
    const brief = first.messages.find((m) => m.role === "user")!.content;
    expect(brief).toContain("You dig deep for roots.");
    expect(first.codexModel).toBe("deep-model");
    expect(first.hydraHead!.task).toBe("Scout");
    expect(heads(engine, lead.id)[1]!.codexModel).not.toBe("deep-model");
    store.close();
  });

  it("identity numbers skip disabled presets (frozen usable numbering)", async () => {
    const { engine, store } = make();
    engine.setSettings({
      chimeraPresets: [
        { id: "b-scout", builtin: "scout", enabled: false },
        { id: "b-builder", builtin: "builder" },
      ],
    });
    const lead = engine.createThread(null, "lead");
    engine.setSubagentMode(lead.id, "adaptive");
    engine.sendTurn(lead.id, "go [mock:hydra-identity]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    const brief = heads(engine, lead.id)[0]!.messages.find(
      (m) => m.role === "user",
    )!.content;
    expect(brief).toContain("You implement a clearly specified feature");
    expect(brief).not.toContain("You explore the codebase fast");
    store.close();
  });
});

describe("P2-62 Hydra finish-signal & unread suppression (frozen AppModel.turnFinished)", () => {
  it("suppresses chime, notify, and unread on Hydra heads and on the lead until all heads finish", async () => {
    const { engine, store } = make();
    const signals: {
      threadId: string;
      status: string;
      chime: boolean;
      notify: string | null;
      silent: boolean;
    }[] = [];
    engine.onEvent((e) => {
      if (e.type === "finish-signal") signals.push(e);
    });
    engine.setSettings({ hydraMaxHeads: 1 });
    const watcher = engine.createThread(null, "watcher");
    const lead = engine.createThread(null, "lead");
    engine.selectThread(watcher.id);

    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        thread(engine, lead.id).turn?.status === "done" &&
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );

    // Lead finished dispatching while a head is running + two are queued:
    // no chime, no notification, and no unread mark yet.
    const leadDispatchSignals = signals.filter((s) => s.threadId === lead.id);
    expect(leadDispatchSignals.length).toBeGreaterThanOrEqual(1);
    expect(leadDispatchSignals[0]).toMatchObject({
      status: "done",
      chime: false,
      notify: null,
      silent: false,
    });
    expect(thread(engine, lead.id).hasUnread).toBeFalsy();

    // Stop the held head so the queued heads run and finish, flushing the report turn.
    engine.stopHydraHead(heads(engine, lead.id)[0]!.id);
    await waitFor(() => heads(engine, lead.id).length === 3);
    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");

    // None of the Hydra head threads ever emitted a finish-signal or marked unread.
    const headIds = new Set(heads(engine, lead.id).map((h) => h.id));
    expect(signals.filter((s) => headIds.has(s.threadId))).toEqual([]);
    for (const h of heads(engine, lead.id)) {
      expect(h.hasUnread).toBeFalsy();
    }

    // Once the report turn completes with no heads left out, the lead chimes,
    // notifies, and marks unread (since watcher is selected).
    const leadFinalSignal = signals.filter((s) => s.threadId === lead.id).at(-1);
    expect(leadFinalSignal).toMatchObject({
      status: "done",
      chime: true,
      notify: "done",
      silent: true,
    });
    expect(thread(engine, lead.id).hasUnread).toBe(true);
    store.close();
  });

  it("drops unlaunchable hydraWaiting entries when Hydra is turned off so future lead turns still signal", async () => {
    const { engine, store } = make();
    const signals: {
      threadId: string;
      status: string;
      chime: boolean;
      notify: string | null;
      silent: boolean;
    }[] = [];
    engine.onEvent((e) => {
      if (e.type === "finish-signal") signals.push(e);
    });
    engine.setSettings({ hydraMaxHeads: 1 });
    const watcher = engine.createThread(null, "watcher");
    const lead = engine.createThread(null, "lead");
    engine.selectThread(watcher.id);

    engine.sendTurn(lead.id, "go [mock:hydra-waitmany]");
    await waitFor(
      () =>
        thread(engine, lead.id).turn?.status === "done" &&
        heads(engine, lead.id).length === 1 &&
        heads(engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );

    // Disable Hydra globally while two delegations sit in hydraWaiting.
    engine.setSettings({ hydraEnabled: false });
    engine.stopHydraHead(heads(engine, lead.id)[0]!.id);

    await waitFor(() =>
      thread(engine, lead.id).messages.some((m) =>
        m.content.includes("Hydra reports:"),
      ),
    );
    await waitFor(() => thread(engine, lead.id).turn?.status === "done");
    expect(heads(engine, lead.id)).toHaveLength(1);

    const afterReport = signals.filter((s) => s.threadId === lead.id).at(-1);
    expect(afterReport).toMatchObject({
      status: "done",
      chime: true,
      notify: "done",
      silent: true,
    });
    expect(thread(engine, lead.id).hasUnread).toBe(true);

    // A later turn on the lead also signals normally instead of remaining wedged.
    const countBefore = signals.filter((s) => s.threadId === lead.id).length;
    engine.sendTurn(lead.id, "ordinary follow-up");
    await waitFor(
      () => signals.filter((s) => s.threadId === lead.id).length > countBefore,
    );
    expect(signals.filter((s) => s.threadId === lead.id).at(-1)).toMatchObject({
      status: "done",
      chime: true,
      notify: "done",
      silent: true,
    });
    store.close();
  });
});
