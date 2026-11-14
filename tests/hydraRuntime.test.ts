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
