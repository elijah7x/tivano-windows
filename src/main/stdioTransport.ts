// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Stdio transport for ONE controlled child process: spawn (shell:false,
// no detached, no scripts), byte-budgeted NDJSON inbound, a single
// serialized stdin write queue with drain/backpressure handling, and a
// bounded dispose (graceful stdin end → SIGTERM → SIGKILL → CLOSE wait).
//
// "exit" only records code/signal; "close" is the sole proof that the
// process and its stdio ended. kill() returning true is never treated as
// an exit. No taskkill, no process-group or descendant reclamation —
// the fixture is guaranteed childless and treeTermination is unsupported.

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  ProtocolError,
  syntheticWireCodec,
  type Envelope,
  type WireCodec,
} from "./stdioFrames";
import type { ChildCleanupResult } from "./provider";

export interface SpawnSpec {
  /** Absolute executable path — never resolved via PATH. */
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TransportLimits {
  /** Per-frame byte cap (default 256 KiB). */
  frameBytes: number;
  /** Cumulative stdout bytes per process (default 8 MiB). */
  stdoutTotalBytes: number;
  /** Cumulative stderr bytes per process (default 1 MiB). */
  stderrTotalBytes: number;
  /** Retained stderr tail for diagnostics (default 32 KiB). */
  stderrTailBytes: number;
  /** Queued+in-flight stdin bytes (default 1 MiB). */
  stdinQueueBytes: number;
  /** Single stdin write watchdog — a write that neither calls back nor
   *  errors within this bound is fatal (default 10 s). */
  stdinWriteMs: number;
  /** Cooperative-close grace before SIGTERM (default 1000 ms). */
  shutdownGraceMs: number;
  /** Observation window after SIGTERM/SIGKILL (default 1000 ms). */
  killObserveMs: number;
  /** Frames dispatched synchronously before yielding to the loop. */
  frameBatchSize: number;
}

export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
  frameBytes: 256 * 1024,
  stdoutTotalBytes: 8 * 1024 * 1024,
  stderrTotalBytes: 1024 * 1024,
  stderrTailBytes: 32 * 1024,
  stdinQueueBytes: 1024 * 1024,
  stdinWriteMs: 10_000,
  shutdownGraceMs: 1000,
  killObserveMs: 1000,
  frameBatchSize: 64,
};

export class TransportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "SPAWN_FAILED"
      | "UNSUPPORTED_WINDOWS_SCRIPT"
      | "OUTPUT_LIMIT"
      | "STDERR_LIMIT"
      | "STDIN_QUEUE_LIMIT"
      | "STDIN_WRITE_FAILED"
      | "EPIPE",
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface TransportHooks<F = Envelope> {
  /** Validated inbound frame, in wire order. */
  onFrame(env: F): void;
  /** Malformed inbound data or an exceeded budget — fatal to this child. */
  onProtocolError(err: ProtocolError | TransportError): void;
  /** Process exit observed; stdio may still be open. */
  onExit(code: number | null, signal: string | null): void;
  /** Process AND stdio fully ended — the only teardown proof. */
  onClose(code: number | null, signal: string | null): void;
  /** spawn itself failed (ENOENT/EACCES — no child was created). */
  onSpawnError(err: Error): void;
}

export type SpawnImpl = (spec: SpawnSpec) => ChildProcess;

const defaultSpawnImpl: SpawnImpl = (spec) =>
  spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
  });

/** Bounded stderr diagnostics: total budget + retained tail only. */
class StderrDrain {
  total = 0;
  private tail = "";
  private readonly dec = new StringDecoder("utf8"); // replacement allowed
  constructor(private readonly limits: TransportLimits) {}
  feed(chunk: Buffer): boolean {
    this.total += chunk.byteLength;
    const text = this.dec.write(chunk);
    if (text) {
      this.tail += text;
      if (this.tail.length > this.limits.stderrTailBytes)
        this.tail = this.tail.slice(-this.limits.stderrTailBytes);
    }
    return this.total <= this.limits.stderrTotalBytes;
  }
  get tailText(): string {
    return this.tail;
  }
}

/**
 * One-shot write result. Passed to send(), it fires EXACTLY once — only
 * after send() returned true — with null on a completed write or the
 * failure otherwise (budget refusal, close, watchdog, inflight error,
 * discard). send() returning false is itself the settlement for
 * immediate refusal; the ack is then never called.
 */
export type WriteAck = (err: Error | null) => void;

interface QueuedWrite {
  buf: Buffer;
  ack?: WriteAck;
}

export class StdioTransport<F = Envelope> {
  private child: ChildProcess | null = null;
  private readonly codec: WireCodec<F>;
  private stderrDrain!: StderrDrain;
  private queue: QueuedWrite[] = [];
  /** Bytes charged to the stdin budget: queued + currently in-flight. */
  private pendingBytes = 0;
  /** The single write currently handed to the stream, if any. */
  private inflight: QueuedWrite | null = null;
  private writing = false;
  /** write() returned false — kernel buffer full until the next drain. */
  private needsDrain = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private stdinEnded = false;
  private stdinDead = false;
  private frameBacklog: F[] = [];
  private flushingBacklog = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private closeInfo: { code: number | null; signal: string | null } | null = null;
  /** OS close was seen; the owner's onClose fires only after the bounded
   *  frame backlog has fully drained (close ≠ delivered). */
  private closeDelivered = false;
  private terminalSent = false;
  private disposed = false;
  private disposePromise: Promise<ChildCleanupResult> | null = null;
  private closeWaiters: Array<() => void> = [];

  constructor(
    private readonly spec: SpawnSpec,
    private readonly limits: TransportLimits,
    private readonly hooks: TransportHooks<F>,
    private readonly spawnImpl: SpawnImpl = defaultSpawnImpl,
    /**
     * Inbound/outbound wire codec. Defaults to the synthetic NDJSON v1
     * codec — the accepted behavior for every existing caller. A Codex
     * app-server connection injects its own independent codec instead;
     * nothing here ever interprets frame contents.
     */
    codec?: WireCodec<F>,
  ) {
    this.codec =
      codec ??
      (syntheticWireCodec({ maxFrameBytes: limits.frameBytes }) as unknown as WireCodec<F>);
    this.stderrDrain = new StderrDrain(limits);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }
  /** A child object exists — spawn() actually returned a handle. False
   *  means "confirmed never created" (start threw / never ran); that is
   *  PROVABLY different from "created but close not yet observed". */
  get hasChild(): boolean {
    return this.child !== null;
  }
  get exited(): boolean {
    return this.exitInfo !== null;
  }
  get closed(): boolean {
    return this.closeInfo !== null;
  }
  get exitCode(): number | null {
    return this.exitInfo?.code ?? this.closeInfo?.code ?? null;
  }
  get signal(): string | null {
    return this.exitInfo?.signal ?? this.closeInfo?.signal ?? null;
  }
  stderrTail(): string {
    return this.stderrDrain.tailText;
  }
  /** Number of real backpressure waits observed (write()=false → drain). */
  get drainWaitCount(): number {
    return this.drainWaits;
  }
  private drainWaits = 0;

  /** Throw UNSUPPORTED_WINDOWS_SCRIPT for .cmd/.bat — no shell fallback. */
  private assertExecutable(): void {
    if (/\.(cmd|bat)$/i.test(this.spec.executable))
      throw new TransportError(
        `script entrypoints are not spawnable executables: ${this.spec.executable}`,
        "UNSUPPORTED_WINDOWS_SCRIPT",
      );
  }

  start(): void {
    // A transport that began dispose can never spawn afterwards — the
    // owner checks cancellation before this, but the guard makes the
    // "no child after dispose" invariant hold even if it is violated.
    if (this.disposed) return;
    this.assertExecutable();
    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.spec);
    } catch (err) {
      // Synchronous spawn failure (never leaves a child).
      this.hooks.onSpawnError(err as Error);
      this.markClosed(null, null);
      return;
    }
    this.child = child;

    child.once("error", (err) => {
      this.stdinDead = true;
      this.failQueue(new TransportError(err.message, "STDIN_WRITE_FAILED"));
      if (!this.exitInfo) this.hooks.onSpawnError(err);
      // 'error' may be followed by close; nothing else to do here.
    });
    child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.stdinDead = true;
      this.hooks.onExit(code, signal);
    });
    child.once("close", (code, signal) => {
      this.markClosed(code, signal);
    });

    child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stdout!.once("end", () => this.onStdoutEnd());
    child.stderr!.on("data", (chunk: Buffer) => this.onStderr(chunk));
    // The drain listener is installed once — attaching it inside the write
    // callback would miss a drain that fires before the callback runs.
    child.stdin!.on("drain", () => {
      if (this.needsDrain) this.drainWaits++;
      this.needsDrain = false;
      this.pump();
    });
    const stdinHadPending = () => this.queue.length > 0 || this.inflight !== null;
    child.stdin!.once("error", (err) => {
      this.stdinDead = true;
      if (stdinHadPending())
        this.failQueue(
          new TransportError(
            err.message,
            (err as NodeJS.ErrnoException).code === "EPIPE" ? "EPIPE" : "STDIN_WRITE_FAILED",
          ),
        );
    });
    child.stdin!.once("close", () => {
      this.stdinDead = true;
      this.stdinEnded = true;
      // A quiet stdin close during teardown is normal — only fail when
      // bytes were actually in flight.
      if (stdinHadPending())
        this.failQueue(
          new TransportError("stdin closed while writes queued", "STDIN_WRITE_FAILED"),
        );
    });
  }

  // ---- inbound ---------------------------------------------------------

  private onStdout(chunk: Buffer): void {
    if (this.closeInfo) return;
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > this.limits.stdoutTotalBytes) {
      this.hooks.onProtocolError(
        new ProtocolError(
          `stdout exceeded ${this.limits.stdoutTotalBytes} bytes`,
          "OUTPUT_LIMIT",
        ),
      );
      this.terminate("SIGKILL");
      return;
    }
    let frames: F[];
    try {
      frames = this.codec.feed(chunk);
    } catch (err) {
      this.hooks.onProtocolError(err as ProtocolError);
      this.terminate("SIGKILL");
      return;
    }
    // Deliver at most a bounded batch synchronously; the rest drain via
    // setImmediate so a tiny-frame flood cannot starve timers/cancel.
    this.frameBacklog.push(...frames);
    if (!this.flushingBacklog) this.flushBacklog();
  }
  private stdoutBytes = 0;

  private flushBacklog(): void {
    this.flushingBacklog = true;
    let n = 0;
    while (this.frameBacklog.length > 0 && n < this.limits.frameBatchSize) {
      n++;
      const env = this.frameBacklog.shift()!;
      // Frames buffered before OS close still reach the owner — delivery
      // stops only once the delivered-close notification has fired.
      if (!this.closeDelivered) this.hooks.onFrame(env);
    }
    if (this.frameBacklog.length > 0) {
      setImmediate(() => this.flushBacklog());
    } else {
      this.flushingBacklog = false;
      if (this.closeInfo) this.deliverClose();
    }
  }

  private onStdoutEnd(): void {
    try {
      this.codec.finish();
    } catch (err) {
      if (!this.closeInfo) {
        this.hooks.onProtocolError(err as ProtocolError);
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    if (!this.stderrDrain.feed(chunk)) {
      this.hooks.onProtocolError(
        new TransportError(
          `stderr exceeded ${this.limits.stderrTotalBytes} bytes`,
          "STDERR_LIMIT",
        ),
      );
      this.terminate("SIGKILL");
    }
  }

  // ---- outbound (single serialized write queue) ------------------------

  /**
   * Queue one encoded frame. Returns false when over budget / not writable
   * — that false IS the refusal settlement and `ack` is never invoked.
   * When true is returned the optional `ack` fires exactly once: null after
   * the write actually completed, or the failure if the frame never made it
   * (close, watchdog, stream error, discard). Queue admission is NOT write
   * success.
   */
  send(frame: F, ack?: WriteAck): boolean {
    if (!this.child || this.stdinDead || this.stdinEnded || this.closeInfo) return false;
    let buf: Buffer;
    try {
      buf = this.codec.encode(frame, this.limits.frameBytes);
    } catch {
      return false;
    }
    // The budget charges queued + in-flight bytes — a write still counting
    // down to its callback is real occupied capacity.
    if (this.pendingBytes + buf.byteLength > this.limits.stdinQueueBytes) return false;
    this.queue.push({ buf, ...(ack ? { ack } : {}) });
    this.pendingBytes += buf.byteLength;
    this.pump();
    return true;
  }

  private pump(): void {
    if (this.writing || this.stdinDead || this.stdinEnded || this.needsDrain) return;
    const item = this.queue.shift();
    if (!item) return;
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.stdinDead = true;
      this.pendingBytes -= item.buf.byteLength;
      item.ack?.(new TransportError("stdin not writable", "STDIN_WRITE_FAILED"));
      this.failQueue(new TransportError("stdin not writable", "STDIN_WRITE_FAILED"));
      return;
    }
    this.writing = true;
    this.inflight = item;
    const settle = (err?: Error | null): void => {
      // Late/double callbacks (e.g. after the watchdog fired) cannot
      // double-decrement the budget or resurrect the queue.
      if (this.inflight !== item) return;
      this.inflight = null;
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      this.writing = false;
      this.pendingBytes -= item.buf.byteLength;
      // The write outcome is reported to THIS frame's waiter first — a
      // caller holding an ack learns the truth before anything else moves.
      item.ack?.(err ?? null);
      if (err) {
        this.stdinDead = true;
        this.failQueue(new TransportError(err.message, "STDIN_WRITE_FAILED"));
        return;
      }
      this.pump();
    };
    // A write that neither calls back nor errors inside the bound is a
    // wedged child — fatal, then escalate so no orphan lingers.
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      settle(new TransportError("stdin write did not complete", "STDIN_WRITE_FAILED"));
      this.terminate("SIGKILL");
    }, this.limits.stdinWriteMs);
    this.writeTimer.unref();
    try {
      const more = stdin.write(item.buf, (err) => settle(err ?? null));
      // Kernel buffer full → block the pump until drain. The persistent
      // drain listener covers drain-before-callback ordering; the write
      // callback covers callback-before-drain — either order unblocks.
      if (!more) this.needsDrain = true;
    } catch (err) {
      settle(err as Error);
    }
  }

  /** Settle every queued frame's ack exactly once, then release bytes. */
  private releaseQueue(err: Error | null): void {
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) {
      this.pendingBytes -= q.buf.byteLength;
      q.ack?.(err);
    }
  }

  private failQueue(err: TransportError): void {
    this.releaseQueue(err);
    if (!this.terminalSent && !this.closeInfo) {
      this.terminalSent = true;
      this.hooks.onProtocolError(err);
    }
  }

  /** Drop every not-yet-written frame; bytes already in the stream stay. */
  discardQueue(): void {
    this.releaseQueue(
      new TransportError("stdin write discarded by teardown", "STDIN_WRITE_FAILED"),
    );
  }

  // ---- lifecycle --------------------------------------------------------

  private markClosed(code: number | null, signal: string | null): void {
    if (this.closeInfo) return;
    this.closeInfo = { code, signal };
    this.stdinDead = true;
    // Settle every outstanding write exactly once — a close must never let
    // an ack-less frame pretend it was written.
    const closeErr = new TransportError(
      "process closed while writes were pending",
      "STDIN_WRITE_FAILED",
    );
    const inflight = this.inflight;
    this.inflight = null;
    if (inflight) {
      this.pendingBytes -= inflight.buf.byteLength;
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      inflight.ack?.(closeErr);
    }
    this.releaseQueue(closeErr);
    this.pendingBytes = 0;
    // Finish the codec at EOF — a truncated tail is still a protocol
    // error, and it must surface before the delivered close.
    try {
      this.codec.finish();
    } catch (err) {
      if (!this.terminalSent) {
        this.terminalSent = true;
        this.hooks.onProtocolError(err as ProtocolError);
      }
    }
    for (const w of this.closeWaiters.splice(0)) w();
    // OS close is recorded now, but the owner's onClose fires only after
    // the bounded backlog has delivered every already-received frame.
    if (this.frameBacklog.length > 0) {
      if (!this.flushingBacklog) this.flushBacklog();
    } else {
      this.deliverClose();
    }
  }

  private deliverClose(): void {
    if (this.closeDelivered || !this.closeInfo) return;
    this.closeDelivered = true;
    this.hooks.onClose(this.closeInfo.code, this.closeInfo.signal);
  }

  private onceClosed(): Promise<void> {
    if (this.closeInfo) return Promise.resolve();
    return new Promise((r) => this.closeWaiters.push(r));
  }

  private terminate(signal: "SIGTERM" | "SIGKILL"): void {
    const c = this.child;
    if (!c || this.closeInfo || this.exitInfo) return;
    try {
      c.kill(signal); // return value is NOT exit evidence
    } catch {
      /* already gone */
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Cooperative close then bounded escalation. Idempotent. Never throws —
   * an unconfirmed close is reported as CLEANUP_INCOMPLETE so the caller
   * keeps evidence instead of pretending teardown happened.
   */
  dispose(): Promise<ChildCleanupResult> {
    // Idempotent while in flight; once resolved, an UNCONFIRMED result is
    // retryable (the child may have since closed), a confirmed one is final.
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const attempt = (async () => {
      if (this.closeInfo) return this.result(true);
      // Confirmed never-created: nothing exists to prove — reporting
      // CLEANUP_INCOMPLETE here would be a fake teardown failure.
      if (!this.child) return this.result(true);
      // Cooperative: stop queueing, end stdin politely first.
      this.stdinEnded = true;
      this.discardQueue();
      try {
        this.child?.stdin?.end();
      } catch {
        /* may already be broken */
      }
      if (!(await this.raceClose(this.limits.shutdownGraceMs))) {
        this.terminate("SIGTERM");
        if (!(await this.raceClose(this.limits.killObserveMs))) {
          this.terminate("SIGKILL");
          await this.raceClose(this.limits.killObserveMs);
        }
      }
      const confirmed = this.closeInfo !== null;
      return this.result(confirmed);
    })();
    this.disposePromise = attempt.finally(() => {
      if (!this.closeInfo) this.disposePromise = null;
    });
    return attempt;
  }

  private raceClose(ms: number): Promise<boolean> {
    if (this.closeInfo) return Promise.resolve(true);
    return Promise.race([this.onceClosed().then(() => true), this.delay(ms).then(() => false)]);
  }

  private result(confirmed: boolean): ChildCleanupResult {
    return {
      pid: this.child?.pid,
      confirmed,
      exitCode: this.exitCode,
      signal: this.signal,
      ...(confirmed ? {} : { problem: "CLEANUP_INCOMPLETE" }),
    };
  }
}
