// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// makeGitRunnerViaJobHelper — HOST-side contract tests over an injected
// SpawnImpl. The REAL helper's 32-bit exit channel (1024+code) cannot be
// observed through a real process exit on POSIX (codes truncate to 8
// bits), so these drive the runner's full mapping/cancel/sticky matrix
// through a deterministic fake child; the real helper's native --run
// behavior is proven by tests/windows/helper-harness.mjs on win32.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { makeGitRunnerViaJobHelper } from "../src/main/gitExec";
import type { SpawnSpec } from "../src/main/stdioTransport";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tivano-p2j-run-"));
  dirs.push(d);
  return d;
};

interface FakeBehavior {
  /** Emit stdout/stderr data before any close. */
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  /** Close outcome emitted on the next tick (after output chunks). */
  close?: [number | null, string | null];
  /** When our stdin gets EOF: emit this close code (or null → ignore). */
  onEof?: number | null;
  /** On kill(): close with (null, SIGKILL) like a real killed child. */
  onKill?: [number | null, string | null];
  /** Emit a spawn "error" event before closing. */
  spawnError?: Error;
  processError?: Error;
  stdinError?: Error;
  /** Delay before the scheduled close — lets cancel/timeout race it. */
  closeDelayMs?: number;
}

class FakeHelperChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: Writable;
  pid: number | undefined = 43210;
  killedBy: string | null = null;
  constructor(private b: FakeBehavior) {
    super();
    if (b.spawnError) this.pid = undefined;
    this.stdin = new Writable({
      write: (_c, _e, cb) => cb(),
    });
    this.stdin.on("finish", () => {
      if (b.onEof !== undefined && b.onEof !== null)
        this.schedule(b.onEof, null, 0);
    });
    const emitOut = () => {
      if (b.processError) this.emit("error", b.processError);
      if (b.stdinError) this.stdin.emit("error", b.stdinError);
      if (b.stdout !== undefined) this.stdout.emit("data", Buffer.from(b.stdout));
      if (b.stderr !== undefined) this.stderr.emit("data", Buffer.from(b.stderr));
      if (b.close !== undefined) this.schedule(...b.close, b.closeDelayMs ?? 0);
      if (b.spawnError) {
        this.emit("error", b.spawnError);
        this.schedule(null, null, 0);
      }
    };
    setImmediate(emitOut);
  }
  private schedule(code: number | null, signal: string | null, ms: number): void {
    setTimeout(() => this.emit("close", code, signal), ms);
  }
  kill(sig?: string | number): boolean {
    this.killedBy = String(sig ?? "SIGTERM");
    const [c, s] = this.b.onKill ?? [null, "SIGKILL"];
    this.schedule(c, s, 0);
    return true;
  }
}

interface Fixture {
  runner: ReturnType<typeof makeGitRunnerViaJobHelper>;
  specs: SpawnSpec[];
  behavior: FakeBehavior;
}

/** Runner whose spawnImpl captures the spec and replays a scripted
 *  helper child. helperPath is a literal — never spawned in this mode. */
function fix(behavior: FakeBehavior, eofSettleMs = 200): Fixture {
  const specs: SpawnSpec[] = [];
  const runner = makeGitRunnerViaJobHelper("C:\\th\\tivano-job-helper.exe", "C:\\git\\git.exe", {
    eofSettleMs,
    spawnImpl: (spec) => {
      specs.push(spec);
      return new FakeHelperChild(behavior) as unknown as ChildProcess;
    },
  });
  return { runner, specs, behavior };
}

const runOpts = () => ({ cwd: tmp(), env: { A: "1" }, timeoutMs: 1000, maxBytes: 1024 });

describe("makeGitRunnerViaJobHelper — injected --run contract", () => {
  it("maps helper exits 1024..1279 back to Git codes 0..255 exactly", async () => {
    const f = fix({ close: [1024, null] });
    const h = f.runner.run(["status"], runOpts());
    const r = await h.done;
    expect(r.code).toBe(0);
    expect(r.executorFailed).toBeUndefined();
    expect(r.signal).toBeNull();
    // The helper received the ENCODED spawn spec for the real git.exe.
    expect(f.specs).toHaveLength(1);
    expect(f.specs[0]!.executable).toBe("C:\\git\\git.exe");
    expect(f.specs[0]!.args).toEqual(["status"]);
  });

  it.each([
    [1024, 0],
    [1066, 42],
    [1279, 255],
  ])("helper exit %i → Git exit %i", async (raw, want) => {
    const f = fix({ close: [raw, null] });
    const r = await f.runner.run(["x"], runOpts()).done;
    expect(r.code).toBe(want);
    expect(r.executorFailed).toBeUndefined();
  });

  it("preserves stdout/stderr byte-exactly — fake status text never drives the code", async () => {
    const f = fix({
      stdout: "payload-exit=99\nreal output",
      stderr: "payload exited 7\ndiag text",
      close: [1066, null],
    });
    const r = await f.runner.run(["x"], runOpts()).done;
    expect(r.code).toBe(42);
    expect(r.stdout).toBe("payload-exit=99\nreal output");
    expect(r.stderr).toBe("payload exited 7\ndiag text");
    expect(r.executorFailed).toBeUndefined();
  });

  it.each([
    [2, "helper-rejected-spec"],
    [3, "helper-setup-failed"],
    [5, "helper-spawn-failed"],
    [6, "payload-force-terminated"],
    [4, "cleanup-unproven"],
  ])("helper class exit %i → executorFailed %s", async (raw, want) => {
    const f = fix({ close: [raw, null] });
    const r = await f.runner.run(["x"], runOpts()).done;
    expect(r.executorFailed).toBe(want);
    expect(r.code).toBeNull();
  });

  it("helper exit 4 is STICKY: unproven cleanup recorded, later spawns refused", async () => {
    const f = fix({ close: [4, null] });
    const r1 = await f.runner.run(["x"], runOpts()).done;
    expect(r1.executorFailed).toBe("cleanup-unproven");
    const lost = f.runner.unprovenCleanups?.() ?? [];
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("4");
    const r2 = await f.runner.run(["x"], runOpts()).done;
    expect(r2.executorFailed).toBe("helper-cleanup-unproven");
    expect(r2.code).toBeNull();
    expect(f.specs).toHaveLength(1); // second run never spawned
  });

  it("a contract-violating helper exit is executor failure + sticky", async () => {
    const f = fix({ close: [200, null] });
    const r = await f.runner.run(["x"], runOpts()).done;
    expect(r.executorFailed).toBe("helper-contract-violation:200");
    expect((f.runner.unprovenCleanups?.() ?? []).length).toBe(1);
    const r2 = await f.runner.run(["x"], runOpts()).done;
    expect(r2.executorFailed).toBe("helper-cleanup-unproven");
  });

  it("cancel delivers stdin-EOF first — helper's forced class, no kill", async () => {
    // Helper answers EOF with its proven forced-cleanup class (6).
    const f = fix({ onEof: 6, closeDelayMs: 60_000 });
    const h = f.runner.run(["x"], runOpts());
    h.cancel();
    const r = await h.done;
    expect(r.cancelled).toBe(true);
    expect(r.executorFailed).toBe("payload-force-terminated");
    expect((f.runner.unprovenCleanups?.() ?? [])).toHaveLength(0);
    expect(f.runner.active().size).toBe(0);
  });

  it("escalates ONLY after the settle bound — killed helper = unproven, sticky", async () => {
    // Helper ignores EOF entirely; the runner's own bound must kill it.
    const f = fix({ onEof: null, closeDelayMs: 60_000 }, 150);
    const h = f.runner.run(["x"], runOpts());
    const t0 = Date.now();
    h.cancel();
    const r = await h.done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140); // settle honored
    expect(r.cancelled).toBe(true);
    expect(r.executorFailed).toBe("helper-terminated-without-exit");
    const lost = f.runner.unprovenCleanups?.() ?? [];
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("killed");
    const r2 = await f.runner.run(["x"], runOpts()).done;
    expect(r2.executorFailed).toBe("helper-cleanup-unproven");
  });

  it("timeout follows the same EOF-first path (helper class, not kill)", async () => {
    const f = fix({ onEof: 6, closeDelayMs: 60_000 }, 2000);
    const h = f.runner.run(["x"], { ...runOpts(), timeoutMs: 120 });
    const r = await h.done;
    expect(r.timedOut).toBe(true);
    expect(r.executorFailed).toBe("payload-force-terminated");
  });

  it("overflow: retained bytes bounded, EOF-first escalation, honest flags", async () => {
    const f = fix({ stdout: Buffer.alloc(65536, 0x41), onEof: 6, closeDelayMs: 60_000 }, 2000);
    const r = await f.runner.run(["x"], { ...runOpts(), maxBytes: 1024 }).done;
    expect(r.overflowed).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024);
    expect(r.executorFailed).toBe("payload-force-terminated");
  });

  it("helper spawn failure → executorFailed + spawnError, no sticky cleanup", async () => {
    const f = fix({ spawnError: new Error("spawn ENOENT") });
    const r = await f.runner.run(["x"], runOpts()).done;
    expect(r.code).toBeNull();
    expect(r.executorFailed).toBe("helper-spawn-failed");
    expect(r.spawnError).toBe("spawn ENOENT");
    expect(f.runner.unprovenCleanups?.() ?? []).toHaveLength(0);
  });

  it("oversized spec refuses BEFORE spawn — spec-rejected (real spawnImpl)", async () => {
    // Production spawnImpl (encode + budget) — the throw is the gate.
    const runner = makeGitRunnerViaJobHelper("C:\\th\\tivano-job-helper.exe", "C:\\git\\git.exe");
    const r = await runner
      .run(["x".repeat(40000)], runOpts())
      .done;
    expect(r.executorFailed).toBe("spec-rejected");
    expect(r.spawnError).toBeDefined();
    expect(runner.active().size).toBe(0);
  });

  it("a missing helper executable is an executor failure, not a Git negative", async () => {
    // Real spawnImpl against a nonexistent helper path — the 'error'
    // event is REAL (Node emits it for ENOENT), close follows.
    const runner = makeGitRunnerViaJobHelper(join(tmp(), "no-helper.exe"), "C:\\git\\git.exe");
    const r = await runner.run(["x"], runOpts()).done;
    expect(r.code).toBeNull();
    expect(r.executorFailed).toBeDefined();
    expect(r.spawnError).toBeDefined();
  });
});


describe("helper errors after spawn", () => {
  it("an error on an existing process cannot bypass missing cleanup proof", async () => {
    const f = fix({ processError: new Error("kill failed"), close: [null, null] });
    const r = await f.runner.run([], runOpts()).done;
    expect(r.spawnError).toBeUndefined();
    expect(r.executorFailed).toBe("helper-terminated-without-exit");
    expect(f.runner.unprovenCleanups!()).toHaveLength(1);
  });
  it("handles asynchronous stdin EPIPE and still requires the exit contract", async () => {
    const f = fix({ stdinError: new Error("EPIPE"), close: [1024, null] });
    const r = await f.runner.run([], runOpts()).done;
    expect(r.executorFailed).toBe("helper-stdio-error");
    expect(r.spawnError).toBeUndefined();
    expect(f.runner.unprovenCleanups!()).toHaveLength(0);
  });
});
