// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// F03 quiet watchdog (frozen ThreadRuntime.watchQuiet): a silent running
// turn gets the "No response" readout at the label threshold, then one
// automatic interrupt at the stop threshold; turns parked on the user
// (approval/question) are exempt. Thresholds are env-injected so the
// frozen 5/10/30-minute semantics run in milliseconds.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-quiet-"));
  dirs.push(d);
  return d;
}

const ENV_KEYS = [
  "TIVANO_QUIET_TICK_MS",
  "TIVANO_QUIET_LABEL_MS",
  "TIVANO_QUIET_STOP_MS",
  "TIVANO_QUIET_TOOL_STOP_MS",
];
const savedEnv = new Map<string, string | undefined>();

function makeEngine(root: string): Engine {
  const store = new Store(root);
  store.open();
  return new Engine(store, new MockProvider({ tickMs: 5 }), root, "0.0.0-test");
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  process.env.TIVANO_QUIET_TICK_MS = "50";
  process.env.TIVANO_QUIET_LABEL_MS = "400";
  process.env.TIVANO_QUIET_STOP_MS = "1200";
  process.env.TIVANO_QUIET_TOOL_STOP_MS = "5000";
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function pump(ms: number): void {
  vi.advanceTimersByTime(ms);
}

describe("quiet watchdog (F03)", () => {
  it("labels a silent turn past the label threshold, then interrupts it at the stop threshold", () => {
    const engine = makeEngine(freshRoot());
    const t = engine.createThread(null, "q");
    engine.sendTurn(t.id, "hold [mock:quiet]");
    pump(200); // opening chunks land; the turn then goes silent
    const live = () => engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(live().turn?.status).toBe("running");

    pump(300); // quiet = ~500ms > label 400ms
    expect(live().turn?.quietMinutes).not.toBeUndefined();
    expect(live().turn?.status).toBe("running");

    pump(800); // quiet ≈1300ms > stop 1200ms
    expect(live().turn?.status).toBe("interrupted");
    const notice = [...live().messages].reverse().find((m) => m.kind === "notice");
    expect(notice?.noticeLevel).toBe("error");
    expect(notice?.content).toContain("stopped the turn");
  });

  it("never stops a turn parked on a pending approval", () => {
    const engine = makeEngine(freshRoot());
    const t = engine.createThread(null, "a");
    engine.sendTurn(t.id, "go [mock:approval]");
    pump(5000); // far past the stop threshold, but the card waits on the user
    const live = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(live.turn?.status).toBe("waiting-approval");
    expect(live.turn?.approval?.status).toBe("pending");
    expect(live.turn?.quietMinutes).toBeUndefined();
  });

  it("clears the quiet readout when the turn ends", () => {
    const engine = makeEngine(freshRoot());
    const t = engine.createThread(null, "q");
    engine.sendTurn(t.id, "hold [mock:quiet]");
    pump(600); // quietMinutes engaged
    expect(engine.snapshot().threads.find((x) => x.id === t.id)!.turn?.quietMinutes).not.toBeUndefined();
    pump(700); // stop threshold — interrupt clears the readout
    const turn = engine.snapshot().threads.find((x) => x.id === t.id)!.turn;
    expect(turn?.status).toBe("interrupted");
    expect(turn?.quietMinutes).toBeUndefined();
  });

  it("leaves an active turn alone while chunks keep arriving", () => {
    const engine = makeEngine(freshRoot());
    const t = engine.createThread(null, "ok");
    engine.sendTurn(t.id, "hello");
    pump(5000);
    const live = engine.snapshot().threads.find((x) => x.id === t.id)!;
    // Normal reply finishes fast — never reaches any quiet threshold.
    expect(live.turn?.status).toBe("done");
    expect(live.turn?.quietMinutes).toBeUndefined();
  });

  const headOf = (engine: Engine, leadId: string) =>
    engine.snapshot().threads.find((t) => t.hydraHead?.leadId === leadId)!;

  it("a head parked on an approval is never stopped or labelled", () => {
    const engine = makeEngine(freshRoot());
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-wait]");
    pump(400); // the held head is parked on its approval card
    const head = headOf(engine, lead.id);
    expect(head.turn?.status).toBe("waiting-approval");
    pump(5000); // far past every threshold — a waiting head is not silent
    expect(head.turn?.status).toBe("waiting-approval");
    expect(head.turn?.quietMinutes).toBeUndefined();
    expect(head.hydraHead!.status).toBe("running");
  });

  it("a head parked on a question is never stopped or labelled", () => {
    const engine = makeEngine(freshRoot());
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-waitq]");
    pump(400);
    const head = headOf(engine, lead.id);
    expect(head.turn?.question?.status).toBe("pending");
    pump(5000);
    expect(head.turn?.status).toBe("running");
    expect(head.turn?.question?.status).toBe("pending");
    expect(head.turn?.quietMinutes).toBeUndefined();
    expect(head.hydraHead!.status).toBe("running");
  });
});

describe("quiet watchdog on Hydra heads (P2-06, frozen)", () => {
  const headOf = (engine: Engine, leadId: string) =>
    engine.snapshot().threads.find((t) => t.hydraHead?.leadId === leadId)!;

  it("stops a silent head past the stop threshold and marks it stalled", () => {
    const engine = makeEngine(freshRoot());
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-quiet]");
    pump(400); // lead streams the block; the head spawns mid-stream
    expect(headOf(engine, lead.id).hydraHead).toBeTruthy();
    pump(1500); // silent past the 1200ms stop, stable across two looks
    const head = headOf(engine, lead.id);
    expect(head.hydraHead!.status).toBe("stopped");
    expect(head.hydraHead!.stopReason).toBe("stalled");
    expect(head.hydraHead!.stalledNote).toContain(
      "no edits or tool calls for 10 minutes",
    );
    const report = engine
      .snapshot()
      .threads.find((t) => t.id === lead.id)!
      .messages.find((m) => m.content.includes("Hydra reports:"));
    expect(report?.content).toContain("stopped by Tivano");
    expect(report?.content).toContain("you can continue it");
  });

  it("a user stop keeps the head stopped, never stalled", () => {
    const engine = makeEngine(freshRoot());
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-quiet]");
    pump(400);
    const head = headOf(engine, lead.id);
    engine.stopHydraHead(head.id);
    pump(100);
    expect(head.hydraHead!.status).toBe("stopped");
    expect(head.hydraHead!.stopReason).toBeUndefined();
    const report = engine
      .snapshot()
      .threads.find((t) => t.id === lead.id)!
      .messages.find((m) => m.content.includes("Hydra reports:"));
    expect(report?.content).toContain("stopped by the user before finishing");
    expect(report?.content).not.toContain("stopped by Tivano");
  });

  it("a held head stays exempt — pending approval is not silent", () => {
    const engine = makeEngine(freshRoot());
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-wait]");
    pump(5000); // far past the stop threshold, but the card waits on the user
    const head = headOf(engine, lead.id);
    expect(head.turn?.status).toBe("waiting-approval");
    expect(head.hydraHead!.status).toBe("running");
    expect(head.hydraHead!.stopReason).toBeUndefined();
  });

  it("the stalled marker survives a store round-trip and clears on continue", () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 5 }), root, "0.0.0-test");
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "go [mock:hydra-quiet]");
    pump(400);
    pump(1500);
    const head = headOf(engine, lead.id);
    expect(head.hydraHead!.stopReason).toBe("stalled");
    store.close();

    const store2 = new Store(root);
    store2.open();
    const reloaded = store2.state.threads.find((t) => t.hydraHead)!;
    expect(reloaded.hydraHead?.status).toBe("stopped");
    expect(reloaded.hydraHead?.stopReason).toBe("stalled");

    // Continuing the reloaded head reuses the stopped-head path and the
    // marker is gone the moment it runs again.
    const engine2 = new Engine(
      store2,
      new MockProvider({ tickMs: 5 }),
      root,
      "0.0.0-test",
    );
    engine2.sendTurn(reloaded.id, "smaller step now");
    const head2 = engine2.snapshot().threads.find((t) => t.id === reloaded.id)!;
    expect(head2.hydraHead!.status).toBe("running");
    expect(head2.hydraHead!.stopReason).toBeUndefined();
    expect(head2.hydraHead!.stalledNote).toBeUndefined();
    pump(200);
    store2.close();
  });
});
