// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// terminal-session — the SHARED session-side logic used by
// terminal-harness.mjs (win32-only runner) and exercised directly by
// terminal-session.test.ts on any host:
//
//   attachStdoutIngest  — THE actual helper-stdout ingestion: Buffer
//     chunks through a persistent StringDecoder (cross-chunk code
//     points stay intact), NDJSON line split, JSON parse, frame/data
//     bookkeeping and the original bounds/kill behavior — byte for
//     byte the same logic the harness used inline.
//   sessionReady        — the spawned→prompt wait with OPTIONAL
//     diagnostic stage records; waits/timeouts are injected by the
//     caller so the cadence stays identical (30s/15s, 50/60ms polls).
//   SessionDiagnostics  — opt-in evidence (TIVANO_TERMINAL_DIAGNOSTICS=1
//     only): bounded incremental raw captures, fixed counters, bounded
//     tails and ≤5 bounded snapshots per helper. Every create/write/
//     close failure is caught, retained and reported — diagnostics
//     NEVER throw across the runner's teardown path.
//   applyDiagnosticVerdict — the verdict merge: original result kept,
//     diagnostics failures force pass:false + cleanup:unknown while
//     APPENDING the original detail. Never an upgrade.
//
// Nothing here fakes Windows behavior: the module is transport/evidence
// plumbing only. All bounds below are hard limits, not hints.

import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DIAG_ENV = "TIVANO_TERMINAL_DIAGNOSTICS";
export const STDOUT_CAP = 256 * 1024;
export const STDERR_CAP = 64 * 1024;
export const LINE_MAX = 512 * 1024;
export const MAX_MSGS = 4096;
export const MAX_MALFORMED = 16;
export const DATA_CAP = 8 * 1024 * 1024;
export const TAIL_BYTES = 4096;
export const MAX_SNAPSHOTS = 5;
export const SNAPSHOT_MAX_BYTES = 64 * 1024;
export const MAX_STAGES = 64;
export const MAX_DIAG_ERRORS = 8;

const FRAME_KEYS = ["spawned", "spawn-failed", "data", "exit", "cleanup", "error"];
const realClock = { mono: () => performance.now(), wall: () => new Date().toISOString() };
const realIo = { openSync, writeSync, closeSync };

// ---------------- actual stdout ingestion ----------------
// Identical bounds and kill behavior to the previous inline handler:
// an over-long pending line, >4096 frames, >16 malformed lines or
// >8 MiB of decoded data kills the helper — diagnostic capture is
// completely separate and never triggers a kill.
export function attachStdoutIngest(cp, h, { send, kill }) {
  const decoder = new StringDecoder("utf8");
  const payloadDecoder = new StringDecoder("utf8");
  const drain = () => {
    for (;;) {
      const nl = h.line.indexOf("\n");
      if (h.line.length > LINE_MAX && (nl < 0 || nl > LINE_MAX)) {
        h.overflowed = true; h.line = ""; kill(); return;
      }
      if (nl < 0) break;
      const raw = h.line.slice(0, nl);
      h.line = h.line.slice(nl + 1);
      if (raw === "") continue;
      if (h.msgs.length >= MAX_MSGS || h.malformed.length >= MAX_MALFORMED) {
        h.overflowed = true; h.line = ""; kill(); return;
      }
      let m;
      try { m = JSON.parse(raw); h.diag?.noteParsed(true); }
      catch { h.malformed.push(raw.slice(0, 200)); h.diag?.noteParsed(false); continue; }
      h.msgs.push(m);
      h.diag?.noteFrame(m?.type);
      if (m.type === "data" && typeof m.data === "string") {
        h.dataBytes += Buffer.byteLength(m.data, "base64");
        if (h.dataBytes > DATA_CAP) {
          h.overflowed = true; h.line = ""; kill(); return;
        }
        h.dataText.push(payloadDecoder.write(Buffer.from(m.data, "base64")));
        if (h.autoAck && Number.isSafeInteger(m.seq)) send({ type: "ack", seq: m.seq });
      }
    }
  };
  cp.stdout.on("data", (chunk) => {
    h.diag?.feedStdout(chunk);          // bounded evidence — first, always
    if (h.overflowed) return;
    h.line += decoder.write(chunk);     // Buffer → utf8, cross-chunk safe
    drain();
  });
  cp.stdout.on("end", () => {
    if (h.overflowed) return;
    h.line += decoder.end();            // flush any decoder remnant
    drain();
    if (!h.overflowed) h.dataText.push(payloadDecoder.end());
  });
}

// ---------------- session-ready wait (shared, stage-recorded) ----------------
// Same two waits the harness always did — 30s spawned, then 15s for any
// prompt output — but every boundary is recorded when diagnostics are
// on. `prompt-wait` is "not-started" when spawned never arrived.
export async function sessionReady(h, { waitSpawned, waitPrompt }) {
  const diag = h.diag;
  diag?.stage("spawned-wait", "start", { boundMs: 30000 });
  let spawned;
  try { spawned = await waitSpawned(h); }
  catch (e) {
    diag?.stage("spawned-wait", "end", { result: "error" });
    diag?.stage("prompt-wait", "not-started", { reason: "spawned-error" });
    throw e;
  }
  diag?.stage("spawned-wait", "end", {
    result: spawned ? "success" : h.spawnError ? "error" : "timeout",
  });
  if (!spawned) {
    diag?.stage("prompt-wait", "not-started", { reason: "spawned-absent" });
    return false;
  }
  diag?.stage("prompt-wait", "start", { boundMs: 15000 });
  let ready;
  try { ready = await waitPrompt(h); }
  catch (e) {
    diag?.stage("prompt-wait", "end", { result: "error" });
    throw e;
  }
  diag?.stage("prompt-wait", "end", {
    result: ready ? "success" : h.spawnError ? "error" : "timeout",
  });
  return ready;
}

// ---------------- bounded diagnostics ----------------
const tailB64 = (text) => {
  const b = Buffer.from(text ?? "", "utf8").subarray(-TAIL_BYTES);
  return { bytes: b.length, base64: b.toString("base64") };
};

export class SessionDiagnostics {
  // I/O-free constructor: streams/snapshots open lazily so a create
  // failure lands as a recorded error, never an exception.
  constructor({ dir, pid, seq, caseName, clock, io, tailsSource }) {
    this.dir = dir; this.pid = pid; this.seq = seq; this.caseName = caseName ?? null;
    this.clock = clock ?? realClock;
    this.io = io ?? realIo;
    this.tailsSource = tailsSource ?? (() => ({ pendingLine: "", output: "" }));
    this.errors = [];
    this.fds = new Map();
    this.streams = {
      stdout: { file: `helper-${pid}-${seq}.stdout.bin`, cap: STDOUT_CAP, observedBytes: 0, retainedBytes: 0, broken: false },
      stderr: { file: `helper-${pid}-${seq}.stderr.bin`, cap: STDERR_CAP, observedBytes: 0, retainedBytes: 0, broken: false },
    };
    this.counters = { parsed: 0, malformed: 0, frames: Object.fromEntries([...FRAME_KEYS, "other"].map((k) => [k, 0])) };
    this.stages = [];
    this.stageStarts = new Map();
    this.snapshotsWritten = 0;
    this.snapshotsDropped = 0;
    this.closed = false;
  }

  _err(op, e) {
    if (this.errors.length < MAX_DIAG_ERRORS)
      this.errors.push(`${op}:${e?.code ?? e?.message ?? String(e)}`.slice(0, 160));
  }

  feedStdout(buf) { this._feed("stdout", buf); }
  feedStderr(buf) { this._feed("stderr", buf); }

  _feed(stream, buf) {
    if (this.closed) return;
    const st = this.streams[stream];
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    st.observedBytes += b.length;
    const room = st.cap - st.retainedBytes;
    if (room <= 0) return;
    const take = Math.min(room, b.length);
    if (st.broken) return;
    let fd = this.fds.get(stream);
    if (fd === undefined) {
      try {
        fd = this.io.openSync(join(this.dir, st.file), "wx", 0o600);
        this.fds.set(stream, fd);
      } catch (e) {
        st.broken = true; this._err(`create-${stream}`, e); return;
      }
    }
    let off = 0, attempts = 0;
    try {
      while (off < take && attempts++ < 8) {
        const w = this.io.writeSync(fd, b, off, take - off);
        if (w <= 0) { this._err(`write-${stream}-zero`, new Error("zero-byte write")); st.broken = true; break; }
        off += w;
      }
    } catch (e) {
      this._err(`write-${stream}`, e); st.broken = true;
    }
    st.retainedBytes += off;
    if (off < take && !st.broken) {
      this._err(`write-${stream}-incomplete`, new Error("short-write budget exhausted"));
      st.broken = true;
    }
    if (st.broken) {
      const cur = this.fds.get(stream);
      if (cur !== undefined) { try { this.io.closeSync(cur); } catch (e) { this._err(`close-${stream}`, e); } this.fds.delete(stream); }
    }
  }

  noteFrame(type) {
    this.counters.frames[FRAME_KEYS.includes(type) ? type : "other"]++;
  }
  noteParsed(ok) { if (ok) this.counters.parsed++; else this.counters.malformed++; }

  // stage boundary → one bounded snapshot file (≤5 per helper).
  stage(name, event, extra = {}) {
    if (this.closed) return;
    const entry = { name, event, utc: this.clock.wall(), monoMs: this.clock.mono(), ...extra };
    if (event === "start") this.stageStarts.set(name, entry.monoMs);
    if (event !== "start" && this.stageStarts.has(name))
      entry.elapsedMs = entry.monoMs - this.stageStarts.get(name);
    if (this.stages.length < MAX_STAGES) this.stages.push(entry);
    this._snapshot(`stage-${name}-${event}`);
  }

  _snapshotObj(kind) {
    const tails = this.tailsSource();
    const streamOut = {};
    for (const [k, s] of Object.entries(this.streams))
      streamOut[k] = {
        file: s.file, cap: s.cap,
        observedBytes: s.observedBytes, retainedBytes: s.retainedBytes,
        truncated: s.observedBytes !== s.retainedBytes || s.broken,
        broken: s.broken,
      };
    return {
      v: 1, kind, case: this.caseName, pid: this.pid, seq: this.seq,
      wallUtc: this.clock.wall(), monoMs: this.clock.mono(),
      streams: streamOut,
      counters: { parsed: this.counters.parsed, malformed: this.counters.malformed, frames: { ...this.counters.frames } },
      stages: this.stages.slice(-MAX_STAGES),
      tails: { pendingLine: tailB64(tails.pendingLine), output: tailB64(tails.output) },
      errors: this.errors.slice(0, MAX_DIAG_ERRORS),
      snapshotsWritten: this.snapshotsWritten,
      snapshotsDropped: this.snapshotsDropped,
    };
  }

  _snapshot(kind) {
    const limit = kind === "final" ? MAX_SNAPSHOTS : MAX_SNAPSHOTS - 1;
    if (this.snapshotsWritten >= limit) { this.snapshotsDropped++; return; }
    const obj = this._snapshotObj(kind);
    let json = JSON.stringify(obj);
    if (Buffer.byteLength(json, "utf8") > SNAPSHOT_MAX_BYTES) { obj.tails = { droppedToFit: true }; json = JSON.stringify(obj); }
    if (Buffer.byteLength(json, "utf8") > SNAPSHOT_MAX_BYTES) { obj.stages = obj.stages.slice(-8); json = JSON.stringify(obj); }
    if (Buffer.byteLength(json, "utf8") > SNAPSHOT_MAX_BYTES) {
      this._err("snap-size", new Error("snapshot exceeds byte limit"));
      return;
    }
    const file = `helper-${this.pid}-${this.seq}.snap-${this.snapshotsWritten + 1}.json`;
    let fd;
    try {
      fd = this.io.openSync(join(this.dir, file), "wx", 0o600);
    } catch (e) { this._err("snap-create", e); return; }
    this.snapshotsWritten++;
    const b = Buffer.from(json, "utf8");
    let off = 0, attempts = 0;
    try {
      while (off < b.length && attempts++ < 16) {
        const w = this.io.writeSync(fd, b, off, b.length - off);
        if (w <= 0) { this._err("snap-zero-write", new Error("zero-byte write")); break; }
        off += w;
      }
    } catch (e) { this._err("snap-write", e); }
    if (off < b.length) this._err("snap-incomplete", new Error("snapshot write incomplete"));
    try { this.io.closeSync(fd); } catch (e) { this._err("snap-close", e); }
  }

  // Close streams first so their errors land in the FINAL snapshot —
  // the post-cleanup state is the most complete record.
  async finalize() {
    if (this.closed) return this.errors;
    this.closed = true;
    for (const [name, fd] of this.fds) {
      try { this.io.closeSync(fd); } catch (e) { this._err(`close-${name}`, e); }
    }
    this.fds.clear();
    this._snapshot("final");
    return this.errors;
  }
}

// ---------------- verdict merge ----------------
// Original result preserved verbatim in detail; diagnostic failures
// only ever force failure — never upgrade anything to clean.
export function applyDiagnosticVerdict(res, errors) {
  if (!errors?.length) return res;
  const base = res && typeof res === "object" ? res : {};
  const detail = `${base.detail ?? ""}; diagnostics:${errors.slice(0, MAX_DIAG_ERRORS).join(";").slice(0, 300)}`;
  return { ...base, pass: false, detail, cleanup: "unknown" };
}
