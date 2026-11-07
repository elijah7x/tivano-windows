// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// windowsTerminalHost — the TerminalHostHandle adapter that drives the
// job-helper's --terminal ConPTY mode. The helper IS the session host:
// one child process per terminal, launched with the TerminalSpec v1 as a
// base64url argv value; session control is bounded NDJSON on its
// stdin/stdout.
//
// Wire contract (mirrors terminal_mode.cpp — keep in lockstep):
//   adapter → helper: {"type":"input","data":"<base64 utf8>"}  ≤32KiB decoded
//                     {"type":"resize","cols":2..500,"rows":2..200}
//                     {"type":"ack","seq":N} · {"type":"pause"} ·
//                     {"type":"resume"} · {"type":"stop"}
//                     stdin EOF = forced teardown
//   helper → adapter: spawned / spawn-failed{code} / data{seq,b64} /
//                     exit{exitCode|null,forced} / cleanup{jobEmpty,
//                     outputComplete} / error{code}
//
// Cleanup claims come only from OBSERVED testimony — never inferred:
//   · after spawn, exit + cleanup{jobEmpty:true} and helper close 0/6
//     must agree; an early cleanup frame alone never releases ownership;
//   · pre-spawn helper classes 2/3/5 report nothing was ever created
//     (vacuous), 4 reports the proof FAILED;
//   · a child that provably never existed (spec rejected or spawn threw
//     before any process object) closes vacuously.
// Everything else — null/signal, unknown codes, contradictions — stays
// UNCONFIRMED. KILL_ON_JOB_CLOSE makes helper death the kernel's kill
// trigger; it is not an observed Job-empty proof, and this adapter never
// treats it as one. Ownership (capacity/dispose) is released only on a
// confirmed or vacuous claim; an unconfirmed host is never forgotten
// into success.
//
// NOT YET EXECUTED on Windows — this adapter and the helper behind it
// are wired for the compiled validation candidate only.
//
import { spawn, type ChildProcess } from "node:child_process";
import {
  JOB_HELPER_TERMINAL_SPEC_VERSION,
  helperCommandLineFits,
  PROCESS_TREE_UNSUPPORTED,
} from "./providerProcessLifecycle";
import type { TerminalHostHandle } from "./terminalService";

const CTRL_LINE_MAX = 512 * 1024;
const INPUT_CHUNK_BYTES = 32 * 1024; // decoded bytes per helper input frame
const INPUT_WIRE_MAX = 256 * 1024;   // mirrors the helper's native pending-input bound
const INPUT_POST_MAX = 256 * 1024;   // one post may not exceed the wire bound
const CONTROL_WIRE_MAX = 64 * 1024;
const HELPER_COLS_MIN = 2, HELPER_COLS_MAX = 500;
const HELPER_ROWS_MIN = 2, HELPER_ROWS_MAX = 200;
const HELPER_DATA_MAX = 4096;        // helper data frames carry ≤4096 raw bytes
const STDERR_CAP = 64 * 1024;
const B64_STRICT =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const clampDim = (v: number, lo: number, hi: number): number =>
  Number.isSafeInteger(v) ? Math.min(hi, Math.max(lo, v)) : lo;

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export interface WindowsTerminalHostOptions {
  /** Attested helper path — must already have passed packaged
   *  attestation with terminalCapable:true. The adapter refuses a plain
   *  string that was never attested: callers pass it only inside a
   *  compile-time candidate build. */
  helperPath: string;
  /** spawn seam for tests. */
  spawnImpl?: (argv: string[]) => ChildProcess;
}

/**
 * Build the TerminalSpec JSON + base64url argv from the service's
 * platform spawn message. Returns null when the spec cannot fit the
 * CreateProcessW command-line budget — the caller fails the spawn, never
 * truncates.
 */
export function encodeTerminalSpec(
  helperPath: string,
  msg: { cols: number; rows: number; cwd: string; env: Record<string, string> },
): string | null {
  const spec = {
    v: JOB_HELPER_TERMINAL_SPEC_VERSION,
    ownerPid: process.pid, // the helper verifies this is its real parent
    cols: clampDim(msg.cols, HELPER_COLS_MIN, HELPER_COLS_MAX),
    rows: clampDim(msg.rows, HELPER_ROWS_MIN, HELPER_ROWS_MAX),
    cwd: msg.cwd,
    env: msg.env,
  };
  const encoded = Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
  if (!helperCommandLineFits(helperPath, encoded, "terminal")) return null;
  return encoded;
}

/**
 * One terminal session. `ready` is emitted asynchronously so the service
 * can attach listeners first; the helper process itself is only spawned
 * when the service's `spawn` message arrives (cols/rows/cwd/env live in
 * that message, not at factory time).
 */
export function spawnWindowsTerminalHost(
  opts: WindowsTerminalHostOptions,
): TerminalHostHandle {
  let child: ChildProcess | null = null;
  let spawnSent = false;
  let spawnConfirmed = false;
  let spawnFailReported = false;
  let cleanupFrameSeen = false;
  let cleanupProved = false;     // helper's cleanup{jobEmpty:true} observed
  let cleanupEmitted = false;
  let exitFrameSeen = false;
  let exited = false;
  let killRequested = false;
  let cancelled = false;         // shutdown requested before spawned — latched
  let stdinBroken = false;
  let nextSeq = 1;
  let inputPending = 0;          // wire bytes written whose callbacks are pending
  let controlPending = 0;
  let protocolFailed = false;
  let stopSent = false;
  let stdoutBuf = "";
  let stderrBytes = 0;
  const msgCbs: ((m: unknown) => void)[] = [];
  const exitCbs: ((code: number | null) => void)[] = [];

  const emitMsg = (m: unknown): void => {
    for (const cb of [...msgCbs]) {
      try { cb(m); } catch { /* listener errors must not kill the adapter */ }
    }
  };
  const emitExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const cb of [...exitCbs]) {
      try { cb(code); } catch { /* ignore */ }
    }
  };
  const emitCleanup = (confirmed: boolean): void => {
    if (cleanupEmitted) return;
    cleanupEmitted = true;
    emitMsg({ type: "cleanup", confirmed });
  };
  const emitSpawnFailed = (message: string): void => {
    if (spawnFailReported || spawnConfirmed) return;
    spawnFailReported = true;
    emitMsg({ type: "spawn-failed", message });
  };

  const stdinWritableBytes = (): number => {
    const wl = (child?.stdin as { writableLength?: unknown } | null | undefined)
      ?.writableLength;
    return typeof wl === "number" && Number.isFinite(wl) && wl > 0 ? wl : 0;
  };

  const writableLen = (line: string): number => Buffer.byteLength(line, "utf8");

  /**
   * Control frames have a small reserved budget separate from input.
   * An exhausted or broken channel fails closed rather than growing an
   * unbounded queue; stop is coalesced and may escalate to process kill.
   */
  const writeCtrl = (obj: Record<string, unknown>): boolean => {
    if (!child?.stdin || exited || stdinBroken || protocolFailed) return false;
    const line = JSON.stringify(obj) + "\n";
    const bytes = writableLen(line);
    if (controlPending + bytes > CONTROL_WIRE_MAX ||
        stdinWritableBytes() + bytes > INPUT_WIRE_MAX + CONTROL_WIRE_MAX) {
      failProtocol("control-overflow");
      return false;
    }
    controlPending += bytes;
    try {
      child.stdin.write(line, () => { controlPending -= bytes; });
      return true;
    } catch {
      controlPending -= bytes;
      stdinBroken = true;
      return false;
    }
  };

  /**
   * Bounded input write: refuses when stream-buffered bytes plus our own
   * callback-pending bytes would exceed the wire bound (the helper's
   * native pending-input bound). False ⇒ the caller fails visibly.
   */
  const writeInput = (obj: Record<string, unknown>): boolean => {
    if (!child || exited || stdinBroken) return false;
    const line = JSON.stringify(obj) + "\n";
    const bytes = writableLen(line);
    if (stdinWritableBytes() + inputPending + bytes > INPUT_WIRE_MAX) return false;
    inputPending += bytes;
    try {
      child!.stdin!.write(line, () => { inputPending -= bytes; });
      return true;
    } catch {
      inputPending -= bytes;
      stdinBroken = true;
      return false;
    }
  };

  const kill = (): void => {
    killRequested = true;
    const c = child;
    if (!c || exited) {
      // Provably nothing exists (or the outcome is already reported) —
      // the only vacuous-confirmation path.
      emitCleanup(true);
      emitExit(null);
      return;
    }
    try { c.kill("SIGKILL"); } catch { /* a kill REQUEST is not proof */ }
    // Death resolves at 'close' — a killed helper is the kernel's reap
    // trigger, not an observed Job-empty proof.
  };

  const failProtocol = (code: string): void => {
    if (protocolFailed) return;
    protocolFailed = true;
    stdoutBuf = "";
    emitMsg({ type: "host-error", message: code });
    // A protocol violation means the session is untrusted — force the
    // helper down; the close path reports cleanup honestly.
    kill();
  };

  /** Visible input failure: stalled or overflowing input is a liveness
   *  failure, never silently dropped keystrokes. Attempt the bounded
   *  graceful stop first, then force the process down. */
  const failInput = (code: string): void => {
    emitMsg({ type: "host-error", message: code });
    cancelled = true;
    writeCtrl({ type: "stop" });
    kill();
  };

  const handleLine = (line: string): void => {
    let doc: unknown;
    try { doc = JSON.parse(line); } catch {
      failProtocol("ctrl-json"); return;
    }
    const m = doc as Record<string, unknown>;
    if (!m || typeof m !== "object" || typeof m.type !== "string") {
      failProtocol("ctrl-shape"); return;
    }
    switch (m.type) {
      case "spawned": {
        if (!spawnSent || spawnConfirmed ||
            !Number.isSafeInteger(m.pid) || (m.pid as number) <= 0) {
          failProtocol("spawned-order"); return;
        }
        spawnConfirmed = true;
        if (!cancelled && !killRequested) emitMsg({ type: "spawned", pid: m.pid });
        return;
      }
      case "spawn-failed": {
        if (typeof m.code !== "string" || spawnConfirmed) {
          failProtocol("spawnfailed-shape"); return;
        }
        emitSpawnFailed(m.code);
        return;
      }
      case "data": {
        if (!spawnConfirmed || cleanupFrameSeen) { failProtocol("data-order"); return; }
        if (!Number.isSafeInteger(m.seq) || (m.seq as number) !== nextSeq) {
          failProtocol("data-seq"); return;
        }
        if (typeof m.data !== "string" || !B64_STRICT.test(m.data)) {
          failProtocol("data-base64"); return;
        }
        const raw = Buffer.from(m.data, "base64");
        if (!raw.length || raw.length > HELPER_DATA_MAX || raw.toString("base64") !== m.data) {
          failProtocol("data-size-or-encoding"); return;
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } catch {
          failProtocol("data-utf8"); return;
        }
        nextSeq += 1;
        emitMsg({ type: "data", seq: m.seq, data: text });
        return;
      }
      case "exit": {
        if (!spawnConfirmed || exitFrameSeen) {
          failProtocol("exit-order"); return;
        }
        const codeOk =
          m.exitCode === null ||
          (typeof m.exitCode === "number" && Number.isSafeInteger(m.exitCode));
        if (!codeOk || typeof m.forced !== "boolean") {
          failProtocol("exit-shape"); return;
        }
        exitFrameSeen = true;
        emitMsg({
          type: "exit",
          ...(typeof m.exitCode === "number" ? { exitCode: m.exitCode } : {}),
        });
        return;
      }
      case "cleanup": {
        if (!spawnConfirmed || !exitFrameSeen || cleanupFrameSeen) {
          failProtocol("cleanup-order"); return;
        }
        if (typeof m.jobEmpty !== "boolean" ||
            typeof m.outputComplete !== "boolean") {
          failProtocol("cleanup-shape"); return;
        }
        cleanupFrameSeen = true;
        if (m.jobEmpty === true) cleanupProved = true;
        if (m.outputComplete === false)
          emitMsg({ type: "host-error", message: "output-incomplete" });
        return;
      }
      case "error": {
        if (typeof m.code !== "string") { failProtocol("error-shape"); return; }
        emitMsg({ type: "host-error", message: m.code });
        return;
      }
      default:
        failProtocol("ctrl-unknown");
        return;
    }
  };

  const onClose = (code: number | null): void => {
    // 'close' — stdio fully flushed; every emitted frame has been seen.
    // Wait for protocol testimony AND the consistent helper close. A
    // frame emitted before a later I/O/cleanup failure is not success.
    // Classes 2/3/5 with no spawned ack are the helper's report that
    //     nothing was ever created (vacuous).
    // null/signal, class 4, unknown codes and contradictory sequences
    // stay unconfirmed — death is a reap trigger, not a proof.
    if (stdoutBuf.trim()) {
      protocolFailed = true;
      emitMsg({ type: "host-error", message: "ctrl-truncated" });
      stdoutBuf = "";
    }
    const provedEmpty = (code === 0 || code === 6) && exitFrameSeen && cleanupProved;
    const neverCreated = !spawnConfirmed &&
      (code === 2 || code === 3 || code === 5);
    const confirmed = !protocolFailed && (provedEmpty || neverCreated);
    if (!spawnConfirmed && !cancelled && !killRequested &&
        code !== 0 && code !== 6) {
      emitSpawnFailed(`helper-exit:${code === null ? "killed" : code}`);
    }
    emitCleanup(confirmed);
    emitExit(code);
  };

  const launch = (spawnMsg: Record<string, unknown>): void => {
    const encoded = encodeTerminalSpec(opts.helperPath, {
      cols: Number(spawnMsg.cols),
      rows: Number(spawnMsg.rows),
      cwd: String(spawnMsg.cwd ?? ""),
      env: (spawnMsg.env ?? {}) as Record<string, string>,
    });
    if (encoded === null) {
      emitSpawnFailed(
        `${PROCESS_TREE_UNSUPPORTED}: terminal spec exceeds the helper ` +
          "command-line budget — refusing before an impossible CreateProcessW",
      );
      // Controller-proven never-created: the refusal happened before any
      // process object existed — the host closes vacuously so service
      // capacity/dispose can forget it honestly.
      emitCleanup(true);
      emitExit(null);
      return;
    }
    const argv = ["--terminal", encoded];
    try {
      child = opts.spawnImpl?.(argv) ?? spawn(opts.helperPath, argv, {
        env: {}, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      emitSpawnFailed(`spawn:${errText(e)}`);
      emitCleanup(true); // spawn threw — no process ever existed
      emitExit(null);
      return;
    }
    const c = child;
    c.stdout?.on("data", (chunk: Buffer | string) => {
      if (exited || protocolFailed) return;
      stdoutBuf += chunk.toString();
      for (;;) {
        const i = stdoutBuf.indexOf("\n");
        if (i < 0) {
          if (stdoutBuf.length > CTRL_LINE_MAX) failProtocol("ctrl-line-size");
          return;
        }
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (line.length > CTRL_LINE_MAX) { failProtocol("ctrl-line-size"); return; }
        handleLine(line);
        if (exited || protocolFailed) return;
      }
    });
    c.stderr?.on("data", (chunk: Buffer | string) => {
      // Diagnostics channel only — bounded, never parsed as protocol.
      stderrBytes = Math.min(STDERR_CAP, stderrBytes + Buffer.byteLength(chunk));
      // Keep draining after the retained diagnostic budget; blocking this
      // pipe would stall the helper's independent shutdown writer.
    });
    // Stream 'error' events (incl. asynchronous EPIPE) must not escape as
    // main-process throws, and a pipe error is never cleanup testimony.
    const onStreamError = (which: string, hard: boolean) => (e: unknown) => {
      if (which === "stdin") stdinBroken = true;
      emitMsg({ type: "host-error", message: `${which}:${errText(e)}` });
      if (hard) kill(); // protocol transport dead — force down; close resolves
    };
    if (c.stdin && typeof (c.stdin as { on?: unknown }).on === "function") {
      (c.stdin as unknown as { on(ev: string, cb: (e: unknown) => void): void })
        .on("error", onStreamError("stdin", true));
    }
    if (c.stdout && typeof c.stdout.on === "function") {
      c.stdout.on("error", onStreamError("stdout", true));
    }
    if (c.stderr && typeof c.stderr.on === "function") {
      c.stderr.on("error", onStreamError("stderr", false));
    }
    c.once("error", (e) => {
      // ChildProcess 'error' is not exclusively spawn failure — it can
      // fire at runtime or from a failed control operation while the
      // helper is still live. It is never an exit or cleanup proof:
      // report visibly and keep ownership until a real 'close'.
      emitMsg({ type: "host-error", message: `child:${errText(e)}` });
    });
    c.once("close", onClose);
  };

  const post = (msg: unknown): void => {
    const m = msg as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || typeof m.type !== "string") return;
    switch (m.type) {
      case "spawn": {
        if (spawnSent || exited || cancelled) return;
        spawnSent = true;
        launch(m);
        return;
      }
      case "input": {
        if (!spawnConfirmed || cancelled || killRequested || exited) return;
        if (typeof m.data !== "string" || m.data.length === 0) return;
        if (Buffer.byteLength(m.data, "utf8") > INPUT_POST_MAX) {
          failInput("input-overflow"); return;
        }
        const bytes = Buffer.from(m.data, "utf8");
        for (let off = 0; off < bytes.length; off += INPUT_CHUNK_BYTES) {
          const frame = {
            type: "input",
            data: bytes.subarray(off, off + INPUT_CHUNK_BYTES).toString("base64"),
          };
          if (!writeInput(frame)) { failInput("input-overflow"); return; }
        }
        return;
      }
      case "resize": {
        if (!spawnConfirmed || cancelled || killRequested) return;
        const cols = clampDim(Number(m.cols), HELPER_COLS_MIN, HELPER_COLS_MAX);
        const rows = clampDim(Number(m.rows), HELPER_ROWS_MIN, HELPER_ROWS_MAX);
        writeCtrl({ type: "resize", cols, rows });
        return;
      }
      case "ack": {
        if (!spawnConfirmed || cancelled || killRequested ||
            !Number.isSafeInteger(m.seq)) return;
        writeCtrl({ type: "ack", seq: m.seq });
        return;
      }
      case "pause": {
        if (spawnConfirmed && !cancelled && !killRequested) writeCtrl({ type: "pause" });
        return;
      }
      case "resume": {
        if (spawnConfirmed && !cancelled && !killRequested) writeCtrl({ type: "resume" });
        return;
      }
      case "shutdown": {
        // Graceful teardown, deliverable at ANY session stage — the
        // helper's control reader dispatches stop even before 'spawned'
        // acknowledges. Latch cancellation so a late spawned cannot
        // resurrect the session; escalate to kill when the control
        // channel is already dead.
        if (exited || stopSent) return;
        stopSent = true;
        cancelled = true;
        if (child) {
          if (!writeCtrl({ type: "stop" })) kill();
        } else {
          emitCleanup(true); // never created — vacuous release
          emitExit(null);
        }
        return;
      }
      default:
        return;
    }
  };

  // The service attaches listeners right after the factory returns.
  queueMicrotask(() => emitMsg({ type: "ready" }));

  return {
    post,
    kill,
    onMessage(cb) { msgCbs.push(cb); },
    onExit(cb) { exitCbs.push(cb); },
  };
}
