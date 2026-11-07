// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// Deterministic tests for the SHARED session ingestion + opt-in
// diagnostics in terminal-session.mjs — the same code paths the
// win32-only harness runs. No Windows behavior is faked or asserted;
// these prove transport parsing, capture bounds and error handling.

import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SNAPSHOTS,
  STDERR_CAP,
  STDOUT_CAP,
  SessionDiagnostics,
  applyDiagnosticVerdict,
  attachStdoutIngest,
  sessionReady,
} from "./terminal-session.mjs";

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ts-diag-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeCp() {
  const cp: any = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.killed = false;
  cp.kill = () => { cp.killed = true; };
  return cp;
}
function fakeH(cp: any, over: Record<string, unknown> = {}) {
  return {
    cp, autoAck: true, msgs: [] as any[], stderr: [] as any[], line: "",
    dataBytes: 0, dataText: [] as string[],
    overflowed: false, spawnError: null, malformed: [] as string[],
    diag: null as SessionDiagnostics | null,
    sent: [] as any[],
    output() { return this.dataText.join(""); },
    ...over,
  };
}
const ingest = (cp: any, h: any) =>
  attachStdoutIngest(cp, h, { send: (o) => h.sent.push(o), kill: () => cp.kill() });
const feed = (cp: any, s: string | Buffer) =>
  cp.stdout.emit("data", Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8"));

// Memory IO: deterministic injectable fs for SessionDiagnostics.
function memIo(over: Partial<Record<string, unknown>> = {}) {
  const files = new Map<string, Buffer>();
  let nextFd = 100;
  const fds = new Map<number, string>();
  const io = {
    files,
    openSync: (p: string, flag: string) => {
      if (flag === "wx" && files.has(p)) { const e: any = new Error("exists"); e.code = "EEXIST"; throw e; }
      const fd = nextFd++; fds.set(fd, p); files.set(p, Buffer.alloc(0)); return fd;
    },
    writeSync: (fd: number, buf: Buffer, off: number, len: number) => {
      const p = fds.get(fd); if (p === undefined) { const e: any = new Error("bad fd"); e.code = "EBADF"; throw e; }
      const cur = files.get(p)!;
      files.set(p, Buffer.concat([cur, buf.subarray(off, off + len)]));
      return len;
    },
    closeSync: (fd: number) => { fds.delete(fd); },
    ...over,
  } as any;
  return io;
}

const tickClock = () => {
  let mono = 1000, wallN = Date.parse("2026-10-28T00:00:00.000Z");
  return {
    mono: () => mono, wall: () => new Date(wallN).toISOString(),
    advance: (ms: number) => { mono += ms; wallN += ms; },
  };
};

describe("attachStdoutIngest — actual shared NDJSON path", () => {
  it("parses frames byte-by-byte, split and coalesced identically", () => {
    const wire =
      '{"type":"spawned","pid":6404}\n' +
      '{"type":"data","seq":1,"data":"' + Buffer.from("hi").toString("base64") + '"}\n' +
      '{"type":"exit","exitCode":7,"forced":false}\n';
    for (const mode of ["bytes", "halves", "whole"] as const) {
      const cp = fakeCp(), h = fakeH(cp);
      ingest(cp, h);
      if (mode === "bytes") for (const b of Buffer.from(wire, "utf8")) feed(cp, Buffer.from([b]));
      else if (mode === "halves") {
        feed(cp, wire.slice(0, 31));
        feed(cp, wire.slice(31));
      } else feed(cp, wire);
      expect(h.msgs.map((m: any) => m.type)).toEqual(["spawned", "data", "exit"]);
      expect(h.output()).toBe("hi");
      expect(h.sent).toEqual([{ type: "ack", seq: 1 }]);
      expect(h.malformed).toEqual([]);
      expect(h.overflowed).toBe(false);
    }
  });

  it("keeps multi-byte UTF-8 intact across chunk splits", () => {
    const cp = fakeCp(), h = fakeH(cp);
    ingest(cp, h);
    const line = Buffer.from('{"type":"data","seq":1,"data":"5Lit5paH"}\n', "utf8");
    feed(cp, line.subarray(0, line.length - 4)); // split mid-frame
    feed(cp, line.subarray(line.length - 4));
    expect(h.msgs).toHaveLength(1);
    expect(h.output()).toBe("中文");
    // A raw multibyte char split across chunks must not corrupt the line.
    const cp2 = fakeCp(), h2 = fakeH(cp2);
    ingest(cp2, h2);
    const raw = Buffer.from('{"type":"error","code":"中文-err"}\n', "utf8");
    const idx = raw.indexOf(Buffer.from("中", "utf8"));
    feed(cp2, raw.subarray(0, idx + 1));   // split inside the 3-byte char
    feed(cp2, raw.subarray(idx + 1));
    expect(h2.msgs[0]).toEqual({ type: "error", code: "中文-err" });
  });

  it("decodes UTF-8 across separate data frames and still ACKs each frame", () => {
    const cp = fakeCp(), h = fakeH(cp);
    ingest(cp, h);
    const bytes = Buffer.from("ascii-ok e\u0301 中文🌟", "utf8");
    for (const [i, byte] of bytes.entries()) {
      feed(cp, JSON.stringify({ type: "data", seq: i + 1, data: Buffer.from([byte]).toString("base64") }) + "\n");
    }
    cp.stdout.emit("end");
    expect(h.output()).toBe("ascii-ok e\u0301 中文🌟");
    expect(h.dataBytes).toBe(bytes.length);
    expect(h.sent).toEqual([...bytes].map((_, i) => ({ type: "ack", seq: i + 1 })));
    expect(h.overflowed).toBe(false);
  });

  it("flushes incomplete payload UTF-8 at EOF and isolates session decoders", () => {
    const cp = fakeCp(), h = fakeH(cp), cp2 = fakeCp(), h2 = fakeH(cp2);
    ingest(cp, h); ingest(cp2, h2);
    feed(cp, JSON.stringify({ type: "data", seq: 1, data: Buffer.from([0xe4]).toString("base64") }) + "\n");
    feed(cp2, JSON.stringify({ type: "data", seq: 1, data: Buffer.from("safe").toString("base64") }) + "\n");
    expect(h.output()).toBe("");
    expect(h.sent).toEqual([{ type: "ack", seq: 1 }]);
    cp.stdout.emit("end"); cp2.stdout.emit("end");
    expect(h.output()).toBe("�");
    expect(h2.output()).toBe("safe");
  });

  it("keeps original bounds: oversize pending line kills, malformed counted", () => {
    const cp = fakeCp(), h = fakeH(cp);
    ingest(cp, h);
    feed(cp, "not-json\n");
    expect(h.malformed).toHaveLength(1);
    feed(cp, "x".repeat(513 * 1024)); // >512KiB pending, no newline
    expect(h.overflowed).toBe(true);
    expect(cp.killed).toBe(true);
  });

  it("autoAck=off sends no acks; unterminated tail is not a frame", () => {
    const cp = fakeCp(), h = fakeH(cp, { autoAck: false });
    ingest(cp, h);
    feed(cp, '{"type":"data","seq":9,"data":"aGk="}\n{"type":"spawned"');
    cp.stdout.emit("end");
    expect(h.msgs.map((m: any) => m.type)).toEqual(["data"]);
    expect(h.line).toBe('{"type":"spawned"');
    expect(h.sent).toEqual([]);
    // decoder.end() flushes a partial UTF-8 remnant as U+FFFD.
    const cp2 = fakeCp(), h2 = fakeH(cp2);
    ingest(cp2, h2);
    feed(cp2, Buffer.concat([Buffer.from('{"x":"'), Buffer.from("中", "utf8").subarray(0, 1)]));
    cp2.stdout.emit("end");
    expect(h2.line.endsWith("�")).toBe(true);
  });
});

describe("SessionDiagnostics — bounded capture, stages, snapshots", () => {
  const diag = (dir: string, io?: any, clock?: any) =>
    new SessionDiagnostics({
      dir, pid: 4242, seq: 1, caseName: "t", clock, io,
      tailsSource: () => ({ pendingLine: "tail-pending", output: "tail-output" }),
    });

  it("captures incrementally at exact cap then truncates — parsing unaffected", async () => {
    const dir = freshDir(), io = memIo();
    const d = diag(dir, io);
    d.feedStdout(Buffer.alloc(STDOUT_CAP, 0x61)); // exactly at cap
    expect(d.streams.stdout.retainedBytes).toBe(STDOUT_CAP);
    expect(d.streams.stdout.observedBytes).toBe(STDOUT_CAP);
    d.feedStdout(Buffer.from("overflow!", "utf8"));
    expect(d.streams.stdout.retainedBytes).toBe(STDOUT_CAP);
    expect(d.streams.stdout.observedBytes).toBe(STDOUT_CAP + 9);
    await d.finalize();
    const file = [...io.files.keys()].find((p) => p.endsWith(".stdout.bin"))!;
    expect(io.files.get(file)!.length).toBe(STDOUT_CAP);
    expect(io.files.get(file)!.subarray(0, 3).toString()).toBe("aaa");
  });

  it("single oversized chunk is truncated, later writes still append", async () => {
    const dir = freshDir(), io = memIo();
    const d = diag(dir, io);
    d.feedStderr(Buffer.alloc(STDERR_CAP + 5000, 0x62));
    expect(d.streams.stderr.retainedBytes).toBe(STDERR_CAP);
    d.feedStderr(Buffer.from("more"));
    await d.finalize();
    const f = [...io.files.keys()].find((p) => p.endsWith(".stderr.bin"))!;
    expect(io.files.get(f)!.length).toBe(STDERR_CAP);
  });

  it("exclusive create never overwrites an earlier run", () => {
    const dir = freshDir(), io = memIo();
    const file = join(dir, "helper-4242-1.stdout.bin");
    io.files.set(file, Buffer.from("EARLIER"));
    const d = diag(dir, io);
    d.feedStdout("new");
    expect(io.files.get(file)!.toString()).toBe("EARLIER");
    expect(d.errors.some((e) => e.includes("create-stdout"))).toBe(true);
    expect(d.streams.stdout.observedBytes).toBe(3);
  });

  it("short writes loop to completion; zero-write is an error, not a hang", async () => {
    const dir = freshDir();
    const io = memIo();
    const orig = io.writeSync;
    io.writeSync = (fd: number, b: Buffer, o: number, l: number) => orig(fd, b, o, Math.min(3, l));
    const d = diag(dir, io);
    d.feedStdout("0123456789");
    await d.finalize();
    const f = [...io.files.keys()].find((p) => p.endsWith(".stdout.bin"))!;
    expect(io.files.get(f)!.toString()).toBe("0123456789");

    const io2 = memIo();
    io2.writeSync = () => 0;
    const d2 = diag(freshDir(), io2);
    d2.feedStdout("xyz");
    expect(d2.errors.some((e) => e.includes("zero"))).toBe(true);
    expect(d2.streams.stdout.broken).toBe(true);
  });

  it("write/close failures are caught and retained, never thrown", async () => {
    const dir = freshDir();
    const io = memIo();
    io.writeSync = () => { const e: any = new Error("disk full"); e.code = "ENOSPC"; throw e; };
    io.closeSync = () => { const e: any = new Error("bad close"); e.code = "EBADF"; throw e; };
    const d = diag(dir, io);
    d.feedStdout("abc");
    await expect(d.finalize()).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining("write-stdout")]),
    );
    expect(d.errors.length).toBeGreaterThanOrEqual(1);
    expect(d.errors.length).toBeLessThanOrEqual(8);
    expect(d.streams.stdout.broken).toBe(true);
  });

  it("stage boundaries produce bounded snapshots with counters and tails", async () => {
    const dir = freshDir(), io = memIo(), clock = tickClock();
    const d = diag(dir, io, clock);
    d.noteParsed(true); d.noteParsed(false); d.noteFrame("spawned"); d.noteFrame("weird");
    d.stage("spawned-wait", "start", { boundMs: 30000 });
    clock.advance(15000);
    d.stage("spawned-wait", "end", { result: "timeout" });
    d.feedStdout("RAW-BYTES");
    await d.finalize();
    const snaps = [...io.files.keys()].filter((p) => p.includes(".snap-"));
    expect(snaps.length).toBeGreaterThanOrEqual(2); // stage ends + final
    const final = JSON.parse(io.files.get(snaps.at(-1)!)!.toString("utf8"));
    expect(final.counters.frames.spawned).toBe(1);
    expect(final.counters.frames.other).toBe(1);
    expect(final.counters.parsed).toBe(1);
    expect(final.counters.malformed).toBe(1);
    expect(Buffer.from(final.tails.pendingLine.base64, "base64").toString()).toBe("tail-pending");
    expect(final.stages.at(-1).elapsedMs).toBe(15000);
    expect(JSON.stringify(final).length).toBeLessThan(64 * 1024);
  });

  it("parsing continues after stdout capture fills — capture ≠ parser", async () => {
    const dir = freshDir(), io = memIo();
    const cp = fakeCp(), h = fakeH(cp);
    h.diag = diag(dir, io);
    ingest(cp, h);
    // One data line carrying ~300KiB base64 payload: capture truncates
    // mid-line at 256KiB, the parser still sees the whole <512KiB line.
    const big = `{"type":"data","seq":1,"data":"${Buffer.alloc(300 * 1024).toString("base64")}"}`;
    expect(big.length).toBeGreaterThan(STDOUT_CAP);
    expect(big.length).toBeLessThan(512 * 1024);
    feed(cp, `${big}\n`);
    expect(h.diag!.streams.stdout.retainedBytes).toBe(STDOUT_CAP);
    expect(h.diag!.streams.stdout.observedBytes).toBeGreaterThan(h.diag!.streams.stdout.retainedBytes);
    expect(h.diag!.streams.stdout.observedBytes).toBeGreaterThan(STDOUT_CAP);
    expect(h.msgs).toHaveLength(1);
    feed(cp, '{"type":"exit","exitCode":0,"forced":false}\n');
    expect(h.msgs).toHaveLength(2);
    expect(h.malformed).toEqual([]);
    await h.diag!.finalize();
  });

  it("cap boundary may split a UTF-8 char — capture stays byte-safe", async () => {
    const dir = freshDir(), io = memIo();
    const d = diag(dir, io);
    d.feedStdout(Buffer.alloc(STDOUT_CAP - 1, 0x61));
    d.feedStdout(Buffer.from("中", "utf8")); // 3 bytes, only first fits
    expect(d.streams.stdout.retainedBytes).toBe(STDOUT_CAP);
    await d.finalize();
    const f = [...io.files.keys()].find((p) => p.endsWith(".stdout.bin"))!;
    const bytes = io.files.get(f)!;
    expect(bytes.length).toBe(STDOUT_CAP);
    expect(bytes[bytes.length - 1]).toBe(Buffer.from("中", "utf8")[0]);
  });

  it("tails are bounded to 4KiB and byte-safe base64", async () => {
    const dir = freshDir(), io = memIo();
    const d = new SessionDiagnostics({
      dir, pid: 1, seq: 2, caseName: "t", io,
      tailsSource: () => ({ pendingLine: "x".repeat(6000), output: "o".repeat(5000) }),
    });
    await d.finalize();
    const f = [...io.files.keys()].find((p) => p.includes(".snap-"))!;
    const snap = JSON.parse(io.files.get(f)!.toString("utf8"));
    expect(snap.tails.pendingLine.bytes).toBe(4096);
    expect(snap.tails.output.bytes).toBe(4096);
    expect(Buffer.from(snap.tails.pendingLine.base64, "base64").toString()).toBe("x".repeat(4096));
  });

  it("caps snapshots at 5 and counts drops", async () => {
    const dir = freshDir(), io = memIo();
    const d = diag(dir, io);
    for (let i = 0; i < 9; i++) d.stage(`s${i}`, "start");
    await d.finalize();
    expect(d.snapshotsWritten).toBe(MAX_SNAPSHOTS);
    expect(d.snapshotsDropped).toBeGreaterThan(0);
  });
});

describe("sessionReady — stage evidence with original timeouts", () => {
  const readyDiag = (dir: string, clock: any) =>
    new SessionDiagnostics({ dir, pid: 1, seq: 1, caseName: "t", clock });

  it("spawned ok + prompt timeout → false, distinct stage evidence", async () => {
    const dir = freshDir(), clock = tickClock();
    const h: any = { diag: readyDiag(dir, clock), spawnError: null };
    const ready = await sessionReady(h, {
      waitSpawned: async () => ({ type: "spawned", pid: 1 }),
      waitPrompt: async () => { clock.advance(15000); return false; },
    });
    expect(ready).toBe(false);
    const st = h.diag.stages;
    expect(st.map((s: any) => `${s.name}:${s.event}:${s.result ?? ""}`)).toEqual([
      "spawned-wait:start:",
      "spawned-wait:end:success",
      "prompt-wait:start:",
      "prompt-wait:end:timeout",
    ]);
    expect(st[3].elapsedMs).toBe(15000);
    expect(st[0].utc).toContain("2026-10-28");
  });

  it("no spawned → false, prompt wait never started", async () => {
    const dir = freshDir(), clock = tickClock();
    const h: any = { diag: readyDiag(dir, clock), spawnError: null };
    const ready = await sessionReady(h, {
      waitSpawned: async () => { clock.advance(30000); return null; },
      waitPrompt: async () => { throw new Error("must not run"); },
    });
    expect(ready).toBe(false);
    expect(h.diag.stages.at(-1)).toMatchObject({ name: "prompt-wait", event: "not-started" });
    expect(h.diag.stages).toHaveLength(3);
  });

  it("diagnostics disabled → no stages, same boolean contract", async () => {
    const h: any = { diag: null };
    expect(await sessionReady(h, { waitSpawned: async () => null, waitPrompt: async () => true })).toBe(false);
    const h2: any = { diag: null };
    expect(await sessionReady(h2, { waitSpawned: async () => ({}), waitPrompt: async () => true })).toBe(true);
  });
});

describe("lead diagnostic regressions", () => {
  it("exhausted short-write budgets cannot produce a pass", async () => {
    const io = memIo();
    const write = io.writeSync;
    io.writeSync = (fd: number, b: Buffer, o: number, n: number) => write(fd, b, o, Math.min(n, 1));
    const d = new SessionDiagnostics({ dir: freshDir(), pid: 1, seq: 1, io });
    d.feedStdout(Buffer.alloc(100));
    await d.finalize();
    expect(d.streams.stdout.broken).toBe(true);
    expect(d.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("write-stdout-incomplete"),
      expect.stringContaining("snap-incomplete"),
    ]));
    expect(applyDiagnosticVerdict({ pass: true, detail: "original" }, d.errors))
      .toMatchObject({ pass: false, cleanup: "unknown", detail: expect.stringContaining("original") });
  });

  it("reserves the fifth snapshot for final state", async () => {
    const io = memIo();
    const d = new SessionDiagnostics({ dir: freshDir(), pid: 1, seq: 1, io });
    for (let i = 0; i < 8; i++) d.stage("spawned-wait", "start");
    await d.finalize();
    const snapshots = [...io.files.values()].map((b: Buffer) => JSON.parse(b.toString()));
    expect(snapshots).toHaveLength(5);
    expect(snapshots.at(-1).kind).toBe("final");
  });

  it("rejects a multibyte snapshot exceeding the serialized byte cap", async () => {
    const io = memIo();
    const d = new SessionDiagnostics({ dir: freshDir(), pid: 1, seq: 1, io, caseName: "中".repeat(30000) });
    await d.finalize();
    expect(io.files.size).toBe(0);
    expect(d.errors).toEqual(expect.arrayContaining([expect.stringContaining("snap-size")]));
  });

  it.each(["spawned", "prompt"])("records %s wait rejection without swallowing it", async (which) => {
    const io = memIo();
    const d = new SessionDiagnostics({ dir: freshDir(), pid: 1, seq: 1, io });
    const failure = new Error("wait rejected");
    await expect(sessionReady({ diag: d }, {
      waitSpawned: async () => { if (which === "spawned") throw failure; return {}; },
      waitPrompt: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(d.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: `${which}-wait`, event: "end", result: "error" }),
    ]));
    await d.finalize();
  });
});

describe("applyDiagnosticVerdict", () => {
  it("forces pass:false + cleanup:unknown, appends original detail", () => {
    const res = applyDiagnosticVerdict(
      { pass: true, detail: "all good", cleanup: "clean" },
      ["write-stdout:ENOSPC"],
    );
    expect(res.pass).toBe(false);
    expect(res.cleanup).toBe("unknown");
    expect(res.detail).toBe("all good; diagnostics:write-stdout:ENOSPC");
    const res2 = applyDiagnosticVerdict(
      { pass: false, detail: "orig-fail", cleanup: "unknown" },
      ["close-stderr:EBADF"],
    );
    expect(res2.detail).toContain("orig-fail");
    expect(res2.detail).toContain("diagnostics:");
    expect(applyDiagnosticVerdict({ pass: true }, [])).toEqual({ pass: true });
  });
});
