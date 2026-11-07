// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// windowsTerminalHost — the TerminalHostHandle adapter that drives
// `tivano-job-helper --terminal`. Every test here runs a SIMULATED
// helper child (an EventEmitter standing in for the real process): the
// adapter's spec encoding, NDJSON framing, ack/credit forwarding, exit-
// class → cleanup-claim mapping and fail-closed protocol handling are
// all exercised without Windows. Real ConPTY acceptance lives in
// tests/windows/terminal-harness.mjs + scripts/windows/
// packaged-terminal-test.mjs on a real win32/x64 host — nothing here
// claims it.

import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  encodeTerminalSpec,
  spawnWindowsTerminalHost,
} from "../src/main/windowsTerminalHost";

const HELPER = "D:\\pkg\\resources\\job-helper\\tivano-job-helper.exe";

/** A fake helper child: stdin writes captured, stdout/stderr pushable,
 *  lifecycle events emittable — the same seams attestJobHelper uses. */
class FakeHelper extends EventEmitter {
  stdin = { writes: [] as string[], write: (s: string) => { this.stdin.writes.push(s); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
  /** Feed one NDJSON protocol line to the adapter. */
  frame(obj: Record<string, unknown>) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
  }
  ctrlLines() {
    return this.stdin.writes
      .flatMap((w) => w.split("\n"))
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
const asChild = (c: FakeHelper) =>
  c as unknown as import("node:child_process").ChildProcess;

interface Rig {
  host: ReturnType<typeof spawnWindowsTerminalHost>;
  child: FakeHelper;
  msgs: Record<string, unknown>[];
  exits: (number | null)[];
  argv: string[] | null;
}

function rig(): Rig {
  const child = new FakeHelper();
  const msgs: Record<string, unknown>[] = [];
  const exits: (number | null)[] = [];
  const r: Rig = {
    host: null as never, child, msgs, exits, argv: null,
  };
  r.host = spawnWindowsTerminalHost({
    helperPath: HELPER,
    spawnImpl: (argv) => { r.argv = argv; return asChild(child); },
  });
  r.host.onMessage((m) => msgs.push(m as Record<string, unknown>));
  r.host.onExit((c) => exits.push(c));
  return r;
}

/** Drive the adapter through ready → spawn → spawned. */
async function boot(r: Rig, spec: Partial<Record<string, unknown>> = {}) {
  // "ready" is emitted on a microtask after construction.
  await Promise.resolve();
  expect(r.msgs.some((m) => m.type === "ready")).toBe(true);
  r.host.post({
    type: "spawn", cols: 80, rows: 25,
    cwd: "D:\\work 目录", env: { SystemRoot: "C:\\Windows" },
    ...spec,
  });
}

const specFromArgv = (r: Rig) =>
  JSON.parse(Buffer.from(r.argv![1]!, "base64url").toString("utf8")) as Record<string, unknown>;

describe("encodeTerminalSpec", () => {
  it("produces TerminalSpec v1 with ownerPid and clamped dimensions", () => {
    const enc = encodeTerminalSpec(HELPER, {
      cols: 9999, rows: 1, cwd: "D:\\w", env: { A: "1" },
    })!;
    const spec = JSON.parse(Buffer.from(enc, "base64url").toString("utf8"));
    expect(spec.v).toBe(1);
    expect(spec.ownerPid).toBe(process.pid);
    expect(spec.cols).toBe(500); // clamped to the helper's bound
    expect(spec.rows).toBe(2);
    expect(spec.cwd).toBe("D:\\w");
    expect(spec.env).toEqual({ A: "1" });
    // No shell/args field exists — the shell is fixed inside the helper.
    expect("shell" in spec).toBe(false);
    expect("args" in spec).toBe(false);
  });
});

describe("spawnWindowsTerminalHost — session lifecycle", () => {
  it("launches --terminal with the encoded spec and forwards frames in order", async () => {
    const r = rig();
    await boot(r);
    expect(r.argv?.[0]).toBe("--terminal");
    const spec = specFromArgv(r);
    expect(spec.v).toBe(1);
    expect(spec.ownerPid).toBe(process.pid);
    expect(spec.cols).toBe(80);
    expect(spec.cwd).toBe("D:\\work 目录");
    expect(spec.env).toEqual({ SystemRoot: "C:\\Windows" });

    r.child.frame({ type: "spawned", pid: 4321 });
    r.child.frame({ type: "data", seq: 1, data: Buffer.from("hello 中文", "utf8").toString("base64") });
    r.child.frame({ type: "exit", exitCode: 7, forced: false });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    r.child.emit("close", 0);

    expect(r.msgs.map((m) => m.type)).toEqual(
      ["ready", "spawned", "data", "exit", "cleanup"],
    );
    expect(r.msgs[1]).toEqual({ type: "spawned", pid: 4321 });
    expect(r.msgs[2]).toEqual({ type: "data", seq: 1, data: "hello 中文" });
    expect(r.msgs[3]).toEqual({ type: "exit", exitCode: 7 });
    expect(r.msgs[4]).toEqual({ type: "cleanup", confirmed: true });
    expect(r.exits).toEqual([0]);
  });

  it("forwards input as chunked base64 frames", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "spawned", pid: 1 });
    r.host.post({ type: "input", data: "echo hi\r" });
    const ctrl = r.child.ctrlLines();
    expect(ctrl).toEqual([{ type: "input", data: Buffer.from("echo hi\r", "utf8").toString("base64") }]);
    // A >32KiB input splits into ≤32KiB decoded chunks.
    const big = "x".repeat(40 * 1024);
    r.host.post({ type: "input", data: big });
    const lines = r.child.ctrlLines().filter((m) => m.type === "input");
    expect(lines.length).toBe(3); // first small + two chunks
    const rejoined = lines.slice(1)
      .map((m) => Buffer.from(String(m.data), "base64").toString("utf8")).join("");
    expect(rejoined).toBe(big);
  });

  it("forwards ack/resize/pause/resume/stop verbatim after spawn only", async () => {
    const r = rig();
    await boot(r);
    // Before spawned: control messages are dropped, never sent.
    r.host.post({ type: "ack", seq: 1 });
    r.host.post({ type: "resize", cols: 10, rows: 10 });
    r.host.post({ type: "input", data: "x" });
    expect(r.child.ctrlLines()).toEqual([]);
    r.child.frame({ type: "spawned", pid: 9 });
    r.host.post({ type: "ack", seq: 4 });
    r.host.post({ type: "resize", cols: 9999, rows: 0 });
    r.host.post({ type: "pause" });
    r.host.post({ type: "resume" });
    r.host.post({ type: "shutdown" });
    expect(r.child.ctrlLines()).toEqual([
      { type: "ack", seq: 4 },
      { type: "resize", cols: 500, rows: 2 }, // clamped to helper bounds
      { type: "pause" },
      { type: "resume" },
      { type: "stop" },
    ]);
  });

  it("helper exit classes map to the cleanup claim — only observed testimony confirms", async () => {
    // The helper's own testimony: 0/6 = teardown completed with the Job
    // proven empty; 2/3/5 with no spawned ack = nothing ever created
    // (vacuous). 4 reports proof failure. null/signal and unknown codes
    // are DEATH WITHOUT TESTIMONY — a reap trigger, never proof.
    for (const [code, confirmed] of [
      [0, false], [6, false], [2, true], [3, true], [5, true],
      [4, false], [null, false], [17, false], [1, false],
    ] as const) {
      const r = rig();
      await boot(r);
      r.child.emit("close", code);
      const cleanup = r.msgs.find((m) => m.type === "cleanup");
      expect(cleanup, `code ${code}`).toEqual({ type: "cleanup", confirmed });
      expect(r.exits).toEqual([code]);
    }
  });

  it("a killed helper after spawned stays unconfirmed — no testimony", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "spawned", pid: 42 });
    r.host.kill();
    expect(r.child.killed).toBe(true);
    r.child.emit("close", null);
    expect(r.msgs.at(-1)).toEqual({ type: "cleanup", confirmed: false });
    expect(r.exits).toEqual([null]);
  });

  it("classes 2/3/5 after a spawned ack are contradictory — unconfirmed", async () => {
    // A spawned helper cannot exit 'nothing was created' — the sequence
    // itself is untrusted, so no vacuous claim is made.
    for (const code of [2, 3, 5] as const) {
      const r = rig();
      await boot(r);
      r.child.frame({ type: "spawned", pid: 42 });
      r.child.emit("close", code);
      expect(r.msgs.at(-1)).toEqual({ type: "cleanup", confirmed: false });
    }
  });

  it("output-incomplete cleanup surfaces a host-error, never a silent pass", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "spawned", pid: 1 });
    r.child.frame({ type: "exit", exitCode: 1, forced: true });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: false });
    expect(r.msgs.some((m) => m.type === "host-error" && m.message === "output-incomplete")).toBe(true);
    expect(r.msgs.some((m) => m.type === "cleanup")).toBe(false);
    r.child.emit("close", 6);
    expect(r.msgs.at(-1)).toEqual({ type: "cleanup", confirmed: true });
  });

  it("spawn-failed and error frames surface honestly", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "spawn-failed", code: "create-process" });
    r.child.frame({ type: "error", code: "credit-overflow" });
    expect(r.msgs[1]).toEqual({ type: "spawn-failed", message: "create-process" });
    expect(r.msgs[2]).toEqual({ type: "host-error", message: "credit-overflow" });
  });
});

describe("spawnWindowsTerminalHost — fail-closed protocol handling", () => {
  it("a malformed JSON line kills the session — never guessed", async () => {
    const r = rig();
    await boot(r);
    r.child.stdout.emit("data", Buffer.from("{not json\n"));
    expect(r.msgs.some((m) => m.type === "host-error")).toBe(true);
    expect(r.child.killed).toBe(true);
  });

  it("a data frame with invalid UTF-8 is a protocol violation, not mojibake", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "spawned", pid: 1 });
    r.child.frame({ type: "data", seq: 1, data: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") });
    expect(r.msgs.some((m) => m.type === "host-error" && m.message === "data-utf8")).toBe(true);
    expect(r.child.killed).toBe(true);
  });

  it("a duplicated spawned frame is a violation", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "spawned", pid: 1 });
    r.child.frame({ type: "spawned", pid: 2 });
    expect(r.msgs.some((m) => m.type === "host-error")).toBe(true);
    expect(r.child.killed).toBe(true);
  });

  it("an unknown frame type is a violation", async () => {
    const r = rig();
    await boot(r);
    r.child.frame({ type: "surprise" });
    expect(r.child.killed).toBe(true);
  });

  it("a control line over the bound is a violation", async () => {
    const r = rig();
    await boot(r);
    r.child.stdout.emit("data", Buffer.from(`${"x".repeat(600 * 1024)}\n`));
    expect(r.child.killed).toBe(true);
  });

  it("kill() before spawn closes vacuously; after spawn death is unproven", async () => {
    const r = rig();
    r.host.kill();
    expect(r.msgs.at(-1)).toEqual({ type: "cleanup", confirmed: true });
    expect(r.exits).toEqual([null]);

    const r2 = rig();
    await boot(r2);
    r2.child.frame({ type: "spawned", pid: 5 });
    r2.host.kill();
    expect(r2.child.killed).toBe(true);
    // A kill request followed by a null close is death without testimony:
    // KILL_ON_JOB_CLOSE is the kernel's reap trigger, not an observed
    // Job-empty proof — the claim stays unconfirmed.
    r2.child.emit("close", null);
    expect(r2.msgs.at(-1)).toEqual({ type: "cleanup", confirmed: false });
    expect(r2.exits).toEqual([null]);
  });

  it("stdin EOF after close is handled — no late frames", async () => {
    const r = rig();
    await boot(r);
    r.child.emit("close", 0);
    r.child.frame({ type: "data", seq: 1, data: "eA==" });
    expect(r.msgs.filter((m) => m.type === "data")).toHaveLength(0);
  });
});

/**
 * A stdin backed by a REAL Writable — not an always-true fake write():
 * writableLength, backpressure return values and flush callbacks all
 * behave like Node's actual pipe transport. `held` stalls the drain the
 * way a saturated helper pipe does.
 */
class Sink extends Writable {
  lines: string[] = [];
  held = false;
  private pendingCbs: (() => void)[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: (e?: Error | null) => void) {
    this.lines.push(chunk.toString());
    if (this.held) this.pendingCbs.push(cb);
    else cb();
  }
  release() {
    this.held = false;
    for (const cb of this.pendingCbs.splice(0)) cb();
  }
  ctrlLines() {
    return this.lines.join("").split("\n").filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

class StreamChild extends EventEmitter {
  stdin = new Sink();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
  frame(obj: Record<string, unknown>) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
  }
}

function streamRig() {
  const child = new StreamChild();
  const msgs: Record<string, unknown>[] = [];
  const exits: (number | null)[] = [];
  const host = spawnWindowsTerminalHost({
    helperPath: HELPER,
    spawnImpl: () => child as unknown as import("node:child_process").ChildProcess,
  });
  host.onMessage((m) => msgs.push(m as Record<string, unknown>));
  host.onExit((c) => exits.push(c));
  return { host, child, msgs, exits };
}

describe("spawnWindowsTerminalHost — backpressure and ownership regressions", () => {
  it("shutdown before 'spawned' delivers stop and latches cancellation", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.host.post({ type: "shutdown" });
    expect(r.child.stdin.ctrlLines().some((m) => m.type === "stop")).toBe(true);
    // A late spawned cannot resurrect the session: no spawned message
    // upward, input is refused, no replacement is launched.
    r.child.frame({ type: "spawned", pid: 77 });
    expect(r.msgs.some((m) => m.type === "spawned")).toBe(false);
    r.host.post({ type: "input", data: "late" });
    expect(r.child.stdin.ctrlLines().some((m) => m.type === "input")).toBe(false);
    // Teardown still flows: exit/cleanup frames validate normally.
    r.child.frame({ type: "exit", exitCode: null, forced: true });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    r.child.emit("close", 6);
    expect(r.msgs.some((m) => m.type === "cleanup" && m.confirmed === true)).toBe(true);
    expect(r.exits).toEqual([6]);
  });

  it("an oversized spec releases the never-created host vacuously", async () => {
    const r = streamRig();
    await Promise.resolve();
    let launches = 0;
    void launches;
    r.host.post({
      type: "spawn", cols: 80, rows: 25,
      cwd: "D:\\" + "x".repeat(40000), env: {},
    });
    expect(r.msgs.some((m) => m.type === "spawn-failed")).toBe(true);
    expect(r.msgs.some((m) => m.type === "cleanup" && m.confirmed === true)).toBe(true);
    expect(r.exits).toHaveLength(1);
  });

  it("a stalled stdin crosses the wire bound → visible failure + teardown", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    r.child.stdin.held = true; // saturated helper pipe
    for (let i = 0; i < 20; i++) r.host.post({ type: "input", data: "x".repeat(65536) });
    expect(r.child.stdin.writableLength).toBeLessThanOrEqual(512 * 1024);
    expect(r.msgs.some((m) => m.type === "host-error" && m.message === "input-overflow")).toBe(true);
    expect(r.child.killed).toBe(true); // forced teardown, not silent drop
  });

  it("drain after a stall resumes bounded writes", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    r.child.stdin.held = true;
    r.host.post({ type: "input", data: "a".repeat(40000) }); // 2 frames, under bound
    expect(r.child.stdin.writableLength).toBeGreaterThan(0);
    expect(r.msgs.some((m) => m.type === "host-error")).toBe(false);
    r.child.stdin.release();
    // Writable flush + write-callbacks settle asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
    r.host.post({ type: "input", data: "b".repeat(1000) });
    await new Promise((resolve) => setImmediate(resolve));
    const inputs = r.child.stdin.ctrlLines().filter((m) => m.type === "input");
    expect(inputs.length).toBe(3);
    expect(r.msgs.some((m) => m.type === "host-error")).toBe(false);
  });

  it("stop is never refused behind queued input", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    r.child.stdin.held = true;
    r.host.post({ type: "input", data: "a".repeat(120000) }); // queued, under bound
    const before = r.child.stdin.writableLength;
    r.host.post({ type: "shutdown" });
    // The control frame is accepted into the stream buffer — never
    // refused because keystrokes are queued ahead of it.
    expect(r.child.stdin.writableLength).toBeGreaterThan(before);
    r.child.stdin.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.child.stdin.ctrlLines().some((m) => m.type === "stop")).toBe(true);
  });

  it("a single post larger than the wire bound fails without partial frames", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    r.host.post({ type: "input", data: "x".repeat(300 * 1024) });
    expect(r.child.stdin.ctrlLines().filter((m) => m.type === "input")).toHaveLength(0);
    expect(r.msgs.some((m) => m.type === "host-error" && m.message === "input-overflow")).toBe(true);
    expect(r.child.killed).toBe(true);
  });

  it("a runtime 'error' on a live helper is reported, not reclaimed", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    r.child.emit("error", new Error("synthetic process-control failure"));
    expect(r.msgs.some((m) => m.type === "host-error")).toBe(true);
    expect(r.msgs.some((m) => m.type === "cleanup")).toBe(false);
    expect(r.exits).toHaveLength(0);
    // Ownership resolves only after the complete protocol and real close.
    r.child.frame({ type: "exit", exitCode: 0, forced: false });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    r.child.emit("close", 0);
    expect(r.exits).toEqual([0]);
    expect(r.msgs.some((m) => m.type === "cleanup" && m.confirmed === true)).toBe(true);
  });

  it("stdin EPIPE is a visible failure, never a cleanup claim", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    expect(() => r.child.stdin.emit("error", new Error("synthetic EPIPE"))).not.toThrow();
    expect(r.msgs.some((m) => m.type === "host-error")).toBe(true);
    expect(r.child.killed).toBe(true);
    r.child.emit("close", null);
    expect(r.msgs.at(-1)).toEqual({ type: "cleanup", confirmed: false });
  });

  it("strict inbound frames: base64, seq and lifecycle all fail closed", async () => {
    const r = streamRig();
    await Promise.resolve();
    r.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r.child.frame({ type: "spawned", pid: 9 });
    r.child.frame({ type: "data", seq: 1, data: Buffer.from("ok").toString("base64") });
    r.child.frame({ type: "data", seq: 3, data: "eA==" }); // gap → violation
    expect(r.msgs.some((m) => m.type === "host-error" && m.message === "data-seq")).toBe(true);
    expect(r.msgs.filter((m) => m.type === "data")).toHaveLength(1);

    const r2 = streamRig();
    await Promise.resolve();
    r2.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r2.child.frame({ type: "spawned", pid: 9 });
    r2.child.frame({ type: "data", seq: 1, data: "aGk= extra" });
    expect(r2.msgs.some((m) => m.type === "host-error" && m.message === "data-base64")).toBe(true);
    expect(r2.msgs.filter((m) => m.type === "data")).toHaveLength(0);

    const r3 = streamRig();
    await Promise.resolve();
    r3.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r3.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true }); // pre-spawned
    expect(r3.msgs.some((m) => m.type === "host-error" && m.message === "cleanup-order")).toBe(true);
    expect(r3.msgs.some((m) => m.type === "cleanup" && m.confirmed === true)).toBe(false);

    const r4 = streamRig();
    await Promise.resolve();
    r4.host.post({ type: "spawn", cols: 80, rows: 25, cwd: "D:\\w", env: {} });
    r4.child.frame({ type: "spawned", pid: 9 });
    r4.child.frame({ type: "exit", exitCode: 0, forced: false });
    r4.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: "yes" as unknown as boolean });
    expect(r4.msgs.some((m) => m.type === "host-error" && m.message === "cleanup-shape")).toBe(true);
  });
});
