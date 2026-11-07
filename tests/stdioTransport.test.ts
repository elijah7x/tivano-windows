// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// StdioTransport boundaries: real OS pipes via the controlled fixture cover
// spawn/handshake/close/backpressure; a scripted fake child covers EPIPE,
// queue limits, drain-order races, in-flight budgeting, the write watchdog,
// kill escalation and the exit-vs-close-vs-delivered distinctions no real
// process could be forced to produce deterministically.

import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  StdioTransport,
  TransportError,
  DEFAULT_TRANSPORT_LIMITS,
  type SpawnSpec,
  type TransportHooks,
} from "../src/main/stdioTransport";
import type { Envelope } from "../src/main/stdioFrames";

const FIXTURE = fileURLToPath(new URL("./fixtures/synthetic-stdio.mjs", import.meta.url));
const NODE = process.execPath;

interface Collected {
  frames: Envelope[];
  errors: Error[];
  exits: Array<{ code: number | null; signal: string | null }>;
  closes: Array<{ code: number | null; signal: string | null }>;
  spawnErrors: Error[];
}

function collect(): { hooks: TransportHooks; c: Collected } {
  const c: Collected = { frames: [], errors: [], exits: [], closes: [], spawnErrors: [] };
  return {
    c,
    hooks: {
      onFrame: (e) => c.frames.push(e),
      onProtocolError: (e) => c.errors.push(e),
      onExit: (code, signal) => c.exits.push({ code, signal }),
      onClose: (code, signal) => c.closes.push({ code, signal }),
      onSpawnError: (e) => c.spawnErrors.push(e),
    },
  };
}

function specFor(dir: string, scenario: string): SpawnSpec {
  return {
    executable: NODE,
    args: [FIXTURE, `--scenario=${scenario}`],
    cwd: dir,
    env: {},
  };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Scripted child for edge cases real processes can't produce on demand. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4321;
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

/**
 * Fully scripted stdin — records every write and hands the test complete
 * control over write() return values, callback timing and drain emission.
 * This is how drain-before-callback vs callback-before-drain are made
 * deterministic instead of racy.
 */
class ScriptedStdin extends EventEmitter {
  written: Buffer[] = [];
  pending: Array<(err?: Error | null) => void> = [];
  destroyed = false;
  writable = true;
  ended = false;
  /** Queue of return values for the next write() calls (default true). */
  returns: boolean[] = [];
  /** When true, write() never invokes its callback until complete() runs. */
  holdCallbacks = true;
  write(buf: Buffer, cb: (err?: Error | null) => void): boolean {
    this.written.push(Buffer.from(buf));
    this.pending.push(cb);
    if (!this.holdCallbacks) cb(null);
    return this.returns.length ? this.returns.shift()! : true;
  }
  complete(i = 0, err?: Error | null): void {
    this.pending[i]?.(err ?? null);
  }
  end(): void {
    this.ended = true;
    this.writable = false;
    this.emit("close");
  }
  destroy(err?: Error): void {
    this.destroyed = true;
    this.writable = false;
    if (err) this.emit("error", err);
    this.emit("close");
  }
}

class ScriptedChild extends EventEmitter {
  stdin = new ScriptedStdin();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 5150;
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeSpec(): SpawnSpec {
  return { executable: "/bin/fake", args: [], cwd: "/", env: {} };
}

describe("StdioTransport with the real fixture child", () => {
  it("round-trips handshake + stream and confirms a clean close", async () => {
    const { hooks, c } = collect();
    const t = new StdioTransport(specFor("/tmp", "chat"), { ...DEFAULT_TRANSPORT_LIMITS }, hooks);
    t.start();
    expect(t.pid).toBeTypeOf("number");
    expect(
      t.send({ v: 1, type: "request", requestId: "hs", method: "handshake", params: {} }),
    ).toBe(true);
    await waitFor(() => c.frames.some((f) => f.requestId === "hs" && f.type === "response"));
    const hs = c.frames.find((f) => f.requestId === "hs")!;
    expect((hs.result as Record<string, unknown>).fixture).toBe("synthetic-stdio");
    const res = await t.dispose();
    expect(res.confirmed).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(c.closes).toHaveLength(1);
  });

  it("reports kill() as not-proof — a close event is required", async () => {
    const { hooks, c } = collect();
    const t = new StdioTransport(specFor("/tmp", "hang"), { ...DEFAULT_TRANSPORT_LIMITS }, hooks);
    t.start();
    const res = await t.dispose();
    expect(res.confirmed).toBe(true);
    expect(c.exits.length).toBeGreaterThanOrEqual(1);
    expect(c.closes).toHaveLength(1);
  });
});

describe("StdioTransport scripted child boundaries", () => {
  function fakeTransport(overrides: Partial<typeof DEFAULT_TRANSPORT_LIMITS> = {}) {
    const { hooks, c } = collect();
    const child = new FakeChild();
    const t = new StdioTransport(
      fakeSpec(),
      { ...DEFAULT_TRANSPORT_LIMITS, ...overrides },
      hooks,
      () => child as never,
    );
    return { t, c, child };
  }

  it("refuses .cmd/.bat executables before spawning", () => {
    const { hooks } = collect();
    const t = new StdioTransport(
      { ...fakeSpec(), executable: "C:\\tools\\thing.bat" },
      DEFAULT_TRANSPORT_LIMITS,
      hooks,
      () => new FakeChild() as never,
    );
    expect(() => t.start()).toThrow(TransportError);
    expect(() => t.start()).toThrow(/script/i);
  });

  it("queued stdin bytes beyond the budget are refused", () => {
    const { t } = fakeTransport({ stdinQueueBytes: 512 });
    t.start();
    const big = "x".repeat(600);
    expect(
      t.send({ v: 1, type: "request", requestId: "r1", method: "m", params: { d: big } }),
    ).toBe(false);
  });

  it("an EPIPE-class stdin failure is surfaced and the queue fails closed", async () => {
    const { t, c, child } = fakeTransport();
    t.start();
    // Destroy then send synchronously — pump() sees the dead stream and
    // fails the queued write instead of pretending it was delivered.
    child.stdin.destroy(new Error("EPIPE: write EPIPE"));
    t.send({ v: 1, type: "request", requestId: "r1", method: "m", params: {} });
    await waitFor(() => c.errors.length > 0);
    expect((c.errors[0] as TransportError).code).toMatch(/EPIPE|STDIN_WRITE_FAILED/);
    // Once dead, further sends are refused rather than silently queued.
    expect(t.send({ v: 1, type: "request", requestId: "r2", method: "m", params: {} })).toBe(false);
  });

  it("exit without close does NOT count as teardown", async () => {
    const { t, c, child } = fakeTransport();
    t.start();
    child.emit("exit", 0, null);
    expect(t.exited).toBe(true);
    expect(t.closed).toBe(false);
    expect(c.closes).toHaveLength(0);
    child.emit("close", 0, null);
    await waitFor(() => c.closes.length === 1);
    expect(t.closed).toBe(true);
  });

  it("dispose escalates SIGTERM → SIGKILL and reports unconfirmed close", async () => {
    const { t, child } = fakeTransport({
      shutdownGraceMs: 50,
      killObserveMs: 50,
    });
    t.start();
    const res = await t.dispose();
    expect(res.confirmed).toBe(false);
    expect(res.problem).toBe("CLEANUP_INCOMPLETE");
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stdout cumulative budget kills the child and reports OUTPUT_LIMIT", async () => {
    const { t, c, child } = fakeTransport({ stdoutTotalBytes: 256 });
    t.start();
    child.stdout.write(Buffer.alloc(300, 0x61));
    await waitFor(() => c.errors.length > 0);
    expect((c.errors[0] as TransportError).code).toBe("OUTPUT_LIMIT");
    expect(child.killed).toContain("SIGKILL");
  });

  it("stderr cumulative budget kills the child and keeps a bounded tail", async () => {
    const { t, c, child } = fakeTransport({ stderrTotalBytes: 256, stderrTailBytes: 64 });
    t.start();
    child.stderr.write(Buffer.alloc(300, 0x62));
    await waitFor(() => c.errors.length > 0);
    expect((c.errors[0] as TransportError).code).toBe("STDERR_LIMIT");
    expect(t.stderrTail().length).toBeLessThanOrEqual(64);
  });

  it("a frame split mid-wire still lands intact over a real pipe", async () => {
    const { hooks, c } = collect();
    const t = new StdioTransport(specFor("/tmp", "chat"), DEFAULT_TRANSPORT_LIMITS, hooks);
    t.start();
    t.send({ v: 1, type: "request", requestId: "hs", method: "handshake", params: {} });
    await waitFor(() => c.frames.some((f) => f.requestId === "hs"));
    t.send({
      v: 1,
      type: "request",
      requestId: "s1",
      method: "stream",
      params: { prompt: "hi", threadId: "t1", turnId: "u1" },
    });
    await waitFor(() => c.frames.some((f) => f.type === "event" && f.event === "done"));
    await t.dispose();
    expect(c.errors).toHaveLength(0);
  });

  it("real pipe backpressure: paused stdin → write=false → drain → all delivered", async () => {
    const { hooks, c } = collect();
    const spec = specFor("/tmp", "chat");
    spec.args = [FIXTURE, "--scenario=chat", "--pause-ms=600"];
    const t = new StdioTransport(spec, { ...DEFAULT_TRANSPORT_LIMITS }, hooks);
    t.start();
    // A serialized pump writes one frame at a time — small frames fit the
    // kernel buffer even while the child pauses. Real backpressure needs
    // bytes exceeding the writable's highWaterMark: one big frame (~180KB
    // > pipe hwm) → write() genuinely returns false → drain resumes it.
    const big = {
      v: 1,
      type: "request",
      requestId: "bp-big",
      method: "handshake",
      params: { pad: "x".repeat(180_000) },
    } as Envelope;
    const small = (i: number): Envelope => ({
      v: 1,
      type: "request",
      requestId: `bp-${i}`,
      method: "handshake",
      params: { i },
    });
    for (let i = 0; i < 8; i++) expect(t.send(small(i))).toBe(true);
    expect(t.send(big)).toBe(true);
    for (let i = 8; i < 12; i++) expect(t.send(small(i))).toBe(true);
    // The paused child cannot drain the kernel buffer — the big write
    // MUST hit write()=false and wait for a real drain.
    await waitFor(() => t.drainWaitCount >= 1, 8000);
    // After resume every request is delivered and answered, in order.
    await waitFor(
      () => c.frames.filter((f) => f.type === "response" && f.requestId.startsWith("bp-")).length === 13,
      15000,
    );
    const ids = c.frames
      .filter((f) => f.requestId.startsWith("bp-"))
      .map((f) => f.requestId);
    expect(new Set(ids).size).toBe(13); // all delivered, each exactly once
    const res = await t.dispose();
    expect(res.confirmed).toBe(true);
    expect(c.errors).toHaveLength(0);
  }, 20000);
});

describe("stdin backpressure ordering (scripted)", () => {
  function scriptedTransport(overrides: Partial<typeof DEFAULT_TRANSPORT_LIMITS> = {}) {
    const { hooks, c } = collect();
    const child = new ScriptedChild();
    const t = new StdioTransport(
      fakeSpec(),
      { ...DEFAULT_TRANSPORT_LIMITS, ...overrides },
      hooks,
      () => child as never,
    );
    return { t, c, child, stdin: child.stdin };
  }

  const req = (id: string): Envelope => ({
    v: 1,
    type: "request",
    requestId: id,
    method: "m",
    params: {},
  });

  it("drain BEFORE write callback — order kept, no re-send", async () => {
    const { t, stdin } = scriptedTransport();
    stdin.returns = [false, true, true]; // first write reports full buffer
    t.start();
    expect(t.send(req("a"))).toBe(true);
    expect(t.send(req("b"))).toBe(true);
    expect(t.send(req("c"))).toBe(true);
    // write a committed; drain arrives BEFORE its callback fires.
    stdin.emit("drain");
    stdin.holdCallbacks = false; // subsequent writes complete inline
    stdin.complete(0);
    await waitFor(() => stdin.written.length === 3);
    const payloads = stdin.written.map((b) => JSON.parse(b.toString()).requestId);
    expect(payloads).toEqual(["a", "b", "c"]);
    expect(stdin.pending).toHaveLength(3); // each written exactly once
  });

  it("callback BEFORE drain — pump stays parked until drain", async () => {
    const { t, stdin } = scriptedTransport();
    stdin.returns = [false, true, true];
    t.start();
    t.send(req("a"));
    t.send(req("b"));
    t.send(req("c"));
    stdin.complete(0); // cb first — drain still owed
    await new Promise((r) => setTimeout(r, 30));
    expect(stdin.written).toHaveLength(1); // pump correctly parked
    stdin.holdCallbacks = false;
    stdin.emit("drain");
    await waitFor(() => stdin.written.length === 3);
    const payloads = stdin.written.map((b) => JSON.parse(b.toString()).requestId);
    expect(payloads).toEqual(["a", "b", "c"]);
  });

  it("in-flight bytes count against the stdin budget until the callback", async () => {
    const f1 = req("one");
    const size1 = Buffer.byteLength(JSON.stringify(f1) + "\n");
    // Budget exactly fits one frame — a second send while in-flight fails.
    const { t, stdin } = scriptedTransport({ stdinQueueBytes: size1 });
    t.start();
    expect(t.send(f1)).toBe(true); // in flight, cb held
    expect(t.send(req("two"))).toBe(false); // in-flight bytes still charged
    stdin.complete(0);
    await waitFor(() => stdin.written.length === 1);
    // After completion the budget frees — the next frame is accepted.
    expect(t.send(req("two"))).toBe(true);
    stdin.complete(1);
    await waitFor(() => stdin.written.length === 2);
    expect(stdin.written.map((b) => JSON.parse(b.toString()).requestId)).toEqual(["one", "two"]);
  });

  it("a write that neither calls back nor errors hits the write watchdog", async () => {
    const { t, c, child } = scriptedTransport({ stdinWriteMs: 50 });
    t.start();
    t.send(req("stuck"));
    await waitFor(() => c.errors.length > 0, 3000);
    expect((c.errors[0] as TransportError).code).toBe("STDIN_WRITE_FAILED");
    expect(child.killed).toContain("SIGKILL");
    // The wedged stream is dead — further sends are refused, not queued.
    expect(t.send(req("after"))).toBe(false);
  });

  it("close while awaiting drain fails the queue without re-sending", async () => {
    const { t, stdin, child } = scriptedTransport();
    stdin.returns = [false];
    t.start();
    t.send(req("x"));
    t.send(req("y"));
    const before = stdin.written.length;
    child.emit("close", 0, null);
    await waitFor(() => t.closed);
    expect(stdin.written.length).toBe(before); // queued bytes never re-sent
  });
});

describe("close-before-drain ordering", () => {
  function scriptedTransport(overrides: Partial<typeof DEFAULT_TRANSPORT_LIMITS> = {}) {
    const { hooks, c } = collect();
    const child = new ScriptedChild();
    const t = new StdioTransport(
      fakeSpec(),
      { ...DEFAULT_TRANSPORT_LIMITS, ...overrides },
      hooks,
      () => child as never,
    );
    return { t, c, child };
  }

  const evt = (seq: number): Envelope => ({
    v: 1,
    type: "event",
    requestId: "s1",
    turnId: "u1",
    seq,
    event: "chunk",
    payload: { delta: `d${seq}` },
  });
  const line = (e: Envelope) => Buffer.from(JSON.stringify(e) + "\n", "utf8");

  it("the bounded backlog fully drains BEFORE close is delivered (8/8)", async () => {
    const { t, c, child } = scriptedTransport({ frameBatchSize: 1 });
    t.start();
    // Eight valid frames arrive in one chunk; with batchSize=1 the backlog
    // is still draining when exit+close land — every frame must still be
    // delivered before onClose fires.
    child.stdout.write(Buffer.concat(Array.from({ length: 8 }, (_, i) => line(evt(i + 1)))));
    await waitFor(() => c.frames.length >= 1, 3000); // drain has begun
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await waitFor(() => c.closes.length === 1, 3000);
    expect(c.frames).toHaveLength(8);
    expect(c.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(c.closes).toHaveLength(1); // close reported exactly once, after frames
  });

  it("exit → stdout completes the frame → close: frames still delivered", async () => {
    const { t, c, child } = scriptedTransport();
    t.start();
    child.emit("exit", 0, null);
    // Data already in the pipe is delivered after exit — exit alone is
    // never the terminal judgement.
    child.stdout.write(line(evt(1)));
    child.stdout.write(line(evt(2)));
    await waitFor(() => c.frames.length === 2);
    child.emit("close", 0, null);
    await waitFor(() => c.closes.length === 1);
    expect(c.frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("an unterminated tail at close is a protocol error BEFORE the close", async () => {
    const { t, c, child } = scriptedTransport();
    t.start();
    child.stdout.write(Buffer.from('{"v":1,"type":"event"')); // no LF
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await waitFor(() => c.closes.length === 1);
    expect(c.errors.length).toBeGreaterThanOrEqual(1);
    expect((c.errors[0] as TransportError & { code: string }).code).toBe("TRUNCATED_TAIL");
  });
});
