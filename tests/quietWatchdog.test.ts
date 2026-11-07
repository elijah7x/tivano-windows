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
});
