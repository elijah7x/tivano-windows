// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Synthetic stdio provider: each turn runs ONE controlled child process —
// the in-repo tests/fixtures/synthetic-stdio.mjs script under an explicitly
// injected Node executable. The wire protocol is our own NDJSON v1 envelope
// (see docs/phase-2a-process.md); it is NOT Codex JSON-RPC and makes no
// claim about real provider behaviour. No network, no host CLI scanning,
// no inherited credentials — env is rebuilt from a small whitelist.
//
// Control plane (request/response, requestId-correlated):
//   handshake  → fixture identity + protocol version
//   stream     → admits a turn; events then carry the data
//   resolve    → answers a pending approval (once|deny only)
//   cancel     → best-effort stop notification (never awaited)
// Data plane (events on the stream request's requestId):
//   chunk / approval / done / error   (turnId + monotonic seq)

import { randomUUID } from "node:crypto";
import type {
  AdapterDisposeResult,
  ProviderAdapter,
  ProviderCallbacks,
  ProviderDescriptor,
  ProviderTurnHandle,
  TurnContext,
} from "./provider";
import { StdioTransport, DEFAULT_TRANSPORT_LIMITS, type SpawnSpec, type SpawnImpl, type TransportLimits } from "./stdioTransport";
import type { Envelope } from "./stdioFrames";

export const SYNTHETIC_PROVIDER_ID = "synthetic-stdio";
export const SYNTHETIC_PROVIDER_LABEL =
  "Synthetic stdio provider (controlled local child process — no real model, tools or network)";

/** Fixed scenarios; selected by main/test config only, never by prompts. */
export type SyntheticScenario =
  | "chat" | "slow" | "flood" | "badframe" | "stderr" | "earlyexit" | "nonutf8" | "hang";

export interface SyntheticLimits {
  transport: TransportLimits;
  /** ms for the handshake response after spawn (default 5000). */
  handshakeMs: number;
  /** ms from request admission to its response (default 10000). */
  requestMs: number;
  /** Max concurrent pending requests per connection (default 32). */
  maxPending: number;
  /** Max live synthetic children per adapter (default 4). */
  maxChildren: number;
}

export function defaultSyntheticLimits(): SyntheticLimits {
  return {
    transport: { ...DEFAULT_TRANSPORT_LIMITS },
    handshakeMs: 5000,
    requestMs: 10_000,
    maxPending: 32,
    maxChildren: 4,
  };
}

export class SyntheticProviderError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_NOT_CONFIGURED"
      | "SYNTHETIC_RUNTIME_NOT_CONFIGURED"
      | "SYNTHETIC_CAPACITY"
      | "HANDSHAKE_TIMEOUT"
      | "PREMATURE_EXIT"
      | "PROTOCOL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "SyntheticProviderError";
  }
}

interface PendingReq {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (v: Envelope) => void;
  reject: (e: Error) => void;
}

/**
 * One controlled child process = one turn. Exported as a test seam — the
 * protocol-level regressions drive pending requests directly; production
 * code only ever meets it through ProviderAdapter.
 */
export class Connection {
  readonly transport: StdioTransport;
  readonly id: string;
  private pending = new Map<string, PendingReq>();
  private reqSeq = 0;
  private streamRequestId: string | null = null;
  private lastEventSeq = 0;
  /** Absolute turn deadline: armed when the stream request is admitted and
   *  never re-armed — chunks/ACK/approval-wait do not extend it. */
  private deadlineTimer: NodeJS.Timeout | null = null;
  /** Wire-observed turn state for event/state combination validation. */
  private state: "awaiting-admission" | "running" | "awaiting-approval" | "awaiting-resolve" | "ended" = "awaiting-admission";
  /** Turn-level business terminal reached (done/error/cancel/deny). */
  terminal = false;
  /** Cancelled/invalidated — late frames are counted and dropped. */
  invalidated = false;
  dropped = 0;

  constructor(
    private readonly provider: SyntheticStdioProvider,
    private readonly ctx: TurnContext,
    private readonly cb: ProviderCallbacks,
    private readonly limits: SyntheticLimits,
    spec: SpawnSpec,
    spawnImpl: SpawnImpl | undefined,
  ) {
    this.id = randomUUID();
    this.transport = new StdioTransport(
      spec,
      this.limits.transport,
      {
        onFrame: (env) => this.onFrame(env),
        onProtocolError: (err) => this.onFatal(err),
        onExit: () => this.onExit(),
        onClose: () => this.onClose(),
        onSpawnError: (err) => this.onFatal(err),
      },
      spawnImpl,
    );
  }

  /** Unique requestId for this process lifetime (fresh per connection). */
  private nextRequestId(): string {
    return `c${this.id.slice(0, 8)}-r${++this.reqSeq}`;
  }

  /** register pending BEFORE writing — a fast child can answer instantly. */
  request(method: string, params: unknown, timeoutMs = this.limits.requestMs): Promise<Envelope> {
    return this.sendRequest(this.nextRequestId(), method, params, timeoutMs);
  }

  /** stream needs its requestId captured for event correlation. */
  private sendRequest(
    requestId: string,
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutCode: "HANDSHAKE_TIMEOUT" | "PROTOCOL_ERROR" = "PROTOCOL_ERROR",
  ): Promise<Envelope> {
    if (this.pending.size >= this.limits.maxPending)
      return Promise.reject(
        new SyntheticProviderError("PROTOCOL_ERROR", `pending limit ${this.limits.maxPending} reached`),
      );
    const promise = new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new SyntheticProviderError(timeoutCode, `${timeoutCode}: ${method} request timed out`),
        );
        this.transport.discardQueue();
        void this.transport.dispose();
      }, timeoutMs);
      this.pending.set(requestId, { method, timer, resolve, reject });
    });
    const ok = this.transport.send({ v: 1, type: "request", requestId, method, params });
    if (!ok) {
      const p = this.pending.get(requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(requestId);
      }
      return Promise.reject(
        new SyntheticProviderError("PROTOCOL_ERROR", `could not write ${method} request`),
      );
    }
    return promise;
  }

  /** Unawaited best-effort request — bounded, no ACK requirement. */
  notify(method: string, params: unknown): void {
    this.request(method, params, this.limits.requestMs).catch(() => {});
  }

  private settle(requestId: string): PendingReq | null {
    const p = this.pending.get(requestId);
    if (!p) return null;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    return p;
  }

  private onFrame(env: Envelope): void {
    if (this.invalidated || this.terminal) {
      // Legal shape but late/foreign — bounded drop count, no callbacks.
      this.drop(env);
      return;
    }
    if (env.type === "response") {
      const p = this.settle(env.requestId);
      if (!p) {
        this.drop(env); // unknown/duplicate/late response
        return;
      }
      if (env.error) {
        const err = new SyntheticProviderError("PROTOCOL_ERROR", env.error.message);
        p.reject(err);
        if (p.method !== "cancel") this.onFatal(err);
        return;
      }
      // The ACK's business schema is validated SYNCHRONOUSLY here — before
      // the waiter resolves and before the next frame in this batch is
      // routed — so an invalid admission can never be overtaken by a
      // same-chunk 'done' and still count as success.
      const badAck = this.validateAck(p.method, env);
      if (badAck) {
        const err = new SyntheticProviderError("PROTOCOL_ERROR", `bad ${p.method} ACK: ${badAck}`);
        p.reject(err);
        this.onFatal(err);
        return;
      }
      if (p.method === "stream" || p.method === "resolve") this.state = "running";
      p.resolve(env);
      return;
    }
    if (env.type === "event") {
      // Events must correlate to THIS turn's stream request and move forward.
      if (
        env.requestId !== this.streamRequestId ||
        env.turnId !== this.ctx.turnId ||
        typeof env.seq !== "number" ||
        env.seq <= this.lastEventSeq
      ) {
        this.drop(env);
        return;
      }
      // A malformed CURRENT-association frame is a protocol error, never a
      // silent drop — schema is checked before the seq is consumed.
      const malformed = this.validateEvent(env);
      if (malformed) {
        this.onFatal(
          new SyntheticProviderError("PROTOCOL_ERROR", `malformed ${env.event} event: ${malformed}`),
        );
        return;
      }
      this.lastEventSeq = env.seq;
      this.routeEvent(env);
      return;
    }
    this.drop(env); // inbound request frames are not part of this protocol
  }

  private drop(env: Envelope): void {
    this.dropped++;
    this.provider.noteDropped(env);
  }

  /**
   * Runtime schema/association check for a request's response result,
   * run synchronously at settle time. Returns a reason when invalid.
   * `cancel` stays best-effort — no ACK contract.
   */
  private validateAck(method: string, env: Envelope): string | null {
    const r = env.result;
    const obj =
      typeof r === "object" && r !== null && !Array.isArray(r)
        ? (r as Record<string, unknown>)
        : null;
    switch (method) {
      case "handshake":
        if (!obj) return "handshake result is not an object";
        if (obj.fixture !== "synthetic-stdio" || obj.protocolVersion !== 1)
          return "handshake returned unexpected identity";
        return null;
      case "stream":
        // Admission is only real when accepted===true AND the ACK binds
        // THIS turn — false/missing/wrong-type/foreign all fail closed.
        if (!obj) return "stream result is not an object";
        if (obj.accepted !== true) return "stream admission was not accepted";
        if (obj.turnId !== this.ctx.turnId) return "stream ACK carries a foreign turnId";
        return null;
      case "resolve":
        if (!obj) return "resolve result is not an object";
        if (obj.resolved !== true) return "resolve ACK did not confirm the resolution";
        return null;
      default:
        return null;
    }
  }

  /**
   * Runtime payload schema + state check for a frame that already passed
   * association/seq validation. Returns a reason string when malformed.
   */
  private validateEvent(env: Envelope): string | null {
    const payload = env.payload;
    if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload)))
      return "payload is not an object";
    const p = (payload ?? {}) as Record<string, unknown>;
    // While an approval is unresolved the ONLY legal turn event is a
    // business error. A "successful" done during the wait is a protocol
    // state error — it must never be honoured as if the user approved.
    if (this.state === "awaiting-approval" && env.event !== "error")
      return "event while awaiting approval resolution";
    if ((this.state === "awaiting-admission" || this.state === "awaiting-resolve") && env.event !== "error")
      return "event before successful request acknowledgement";
    switch (env.event) {
      case "chunk":
        if (typeof p.delta !== "string") return "delta must be a string";
        break;
      case "approval": {
        const a = p.approval;
        if (typeof a !== "object" || a === null || Array.isArray(a))
          return "approval field missing";
        const ap = a as Record<string, unknown>;
        if (typeof ap.title !== "string" || ap.title.length === 0)
          return "approval.title must be a non-empty string";
        if (ap.detail !== undefined && typeof ap.detail !== "string")
          return "approval.detail must be a string";
        if (ap.reason !== undefined && typeof ap.reason !== "string")
          return "approval.reason must be a string";
        if (!Array.isArray(ap.options)) return "approval.options must be an array";
        for (const o of ap.options) {
          if (typeof o !== "object" || o === null || typeof (o as Record<string, unknown>).id !== "string")
            return "approval option missing string id";
        }
        break;
      }
      case "done":
        if (p.outcome !== undefined && typeof p.outcome !== "string")
          return "outcome must be a string";
        break;
      case "error":
        if (p.message !== undefined && typeof p.message !== "string")
          return "message must be a string";
        break;
      default:
        return null; // structurally valid but unknown → bounded drop above
    }
    return null;
  }

  private routeEvent(env: Envelope): void {
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    switch (env.event) {
      case "chunk":
        this.cb.onChunk(env.seq!, payload.delta as string);
        break;
      case "approval": {
        const a = payload.approval as Record<string, unknown>;
        this.state = "awaiting-approval";
        this.cb.onApproval({
          kind: "action",
          headline: "Allow this action?",
          title: String(a.title),
          ...(typeof a.detail === "string" ? { detail: a.detail } : {}),
          ...(typeof a.reason === "string" ? { reason: a.reason } : {}),
          symbol: "exclamationmark.shield",
          // Synthetic approvals offer once/deny only — never the Mock's
          // session/always grants, and never trust wire text for scope.
          options: [
            { id: "deny", title: "Deny", role: "deny", scope: "none" },
            { id: "once", title: "Allow once", role: "approve", scope: "once" },
          ],
        });
        break;
      }
      case "done":
        this.state = "ended";
        this.terminal = true;
        this.clearDeadline();
        this.cb.onDone();
        void this.transport.dispose();
        break;
      case "error":
        this.state = "ended";
        this.terminal = true;
        this.clearDeadline();
        this.cb.onError(
          typeof payload.message === "string" ? payload.message : "synthetic turn failed",
        );
        void this.transport.dispose();
        break;
      default:
        this.drop(env);
    }
  }

  private onExit(): void {
    // exit records code/signal only — frames can still be in the pipe or in
    // the bounded backlog; the terminal judgement happens at close.
  }

  private onClose(): void {
    // Delivered close: every already-received frame has been processed.
    // Now — and only now — is "no terminal event" provable.
    this.clearDeadline();
    if (!this.terminal && !this.invalidated) {
      this.terminal = true;
      this.failAllPending("PREMATURE_EXIT", "child closed before completing the turn");
      this.cb.onError("PREMATURE_EXIT: child closed before completing the turn");
    } else {
      this.failAllPending("PREMATURE_EXIT", "child closed before completing the turn");
    }
    // Confirmed close → release callbacks/context/pending/timer refs.
    this.provider.release(this);
  }

  private onFatal(err: Error): void {
    if (this.terminal && this.invalidated) return;
    if (!this.terminal) {
      this.terminal = true;
      this.clearDeadline();
      this.failAllPending("PROTOCOL_ERROR", err.message);
      this.cb.onError(`protocol error: ${err.message}`);
    }
    void this.transport.dispose();
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /** Absolute stream deadline elapsed — the turn loses its terminal term. */
  private onTurnDeadline(): void {
    this.deadlineTimer = null;
    if (this.terminal || this.invalidated) return;
    this.onFatal(
      new SyntheticProviderError(
        "PROTOCOL_ERROR",
        `stream turn exceeded its ${this.limits.requestMs} ms deadline`,
      ),
    );
  }

  private failAllPending(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SyntheticProviderError(code as never, message));
      this.pending.delete(id);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
  get childClosed(): boolean {
    return this.transport.closed;
  }
  /**
   * Terminal with no child object ever created — provably dead (rejected
   * start, cancel/dispose before the deferred spawn). Distinct from
   * "child exists but close unconfirmed", which must keep ownership.
   */
  get confirmedChildless(): boolean {
    return this.terminal && !this.transport.hasChild;
  }

  async run(): Promise<void> {
    // Yield once so no business callback can fire before start() has
    // returned the handle — even when transport.start() throws or the
    // child finishes instantly, callbacks land after handle registration.
    await Promise.resolve();
    // A cancel()/dispose() landing before the deferred run must never
    // spawn. The connection is confirmed childless and releases itself —
    // capacity and references must not be held by a turn that could
    // never have produced a process.
    if (this.invalidated || this.terminal || this.provider.isDisposed) {
      this.terminal = true;
      this.provider.release(this);
      return;
    }
    try {
      this.transport.start();
    } catch (err) {
      // Refused BEFORE spawn (e.g. UNSUPPORTED_WINDOWS_SCRIPT) — no child
      // was ever created, so this is confirmed childless, not an
      // unconfirmed cleanup: fail the turn once and release.
      this.terminal = true;
      this.cb.onError((err as Error).message);
      this.provider.release(this);
      return;
    }
    if (this.transport.hasChild) this.provider.noteSpawned();
    try {
      const hs = await this.sendRequest(
        this.nextRequestId(),
        "handshake",
        { client: "tivano-windows", phase: "2a" },
        this.limits.handshakeMs,
        "HANDSHAKE_TIMEOUT",
      );
      // Cancel/dispose may have landed between the response and this
      // continuation — a dead turn sends nothing further.
      if (this.invalidated || this.terminal || this.provider.isDisposed) return;
      const result = hs.result as Record<string, unknown> | undefined;
      if (result?.fixture !== "synthetic-stdio" || result.protocolVersion !== 1)
        throw new SyntheticProviderError("PROTOCOL_ERROR", "handshake returned unexpected identity");
      const streamRequestId = this.nextRequestId();
      this.streamRequestId = streamRequestId;
      // The absolute turn deadline starts at stream admission and is never
      // re-armed — ACK/chunks/approval-wait do not extend it. (The stream
      // ACK itself is validated synchronously in the response path — see
      // validateAck — so a same-batch 'done' can never outrun a bad ACK.)
      const admittedAt = Date.now();
      await this.sendRequest(streamRequestId, "stream", {
        prompt: this.ctx.prompt,
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
      }, this.limits.requestMs);
      if (this.invalidated || this.terminal || this.provider.isDisposed) return;
      const remaining = Math.max(1, this.limits.requestMs - (Date.now() - admittedAt));
      this.deadlineTimer = setTimeout(() => this.onTurnDeadline(), remaining);
      this.deadlineTimer.unref();
    } catch (err) {
      if (!this.terminal) {
        this.terminal = true;
        this.clearDeadline();
        this.failAllPending("PROTOCOL_ERROR", (err as Error).message);
        this.cb.onError((err as Error).message);
        void this.transport.dispose();
      }
    }
  }

  cancel(): void {
    if (this.invalidated && this.terminal) return; // idempotent
    this.invalidated = true;
    this.terminal = true;
    this.clearDeadline();
    this.failAllPending("PREMATURE_EXIT", "cancelled");
    // Best-effort cancel notice — only meaningful to a real child, and
    // never awaited either way.
    if (this.transport.hasChild) this.notify("cancel", { turnId: this.ctx.turnId });
    void this.transport.dispose();
    // A childless cancel is confirmed-dead — release capacity now instead
    // of waiting for a close that can never arrive.
    this.provider.release(this);
  }

  resolve(approved: boolean): void {
    // A late resolve on a dead turn sends nothing and mints nothing.
    if (this.invalidated || this.terminal || this.provider.isDisposed) return;
    if (this.state !== "awaiting-approval") return;
    // Permission alone does not prove that the child accepted the request.
    if (approved) this.state = "awaiting-resolve";
    this.notify("resolve", { turnId: this.ctx.turnId, optionId: approved ? "once" : "deny" });
  }

  /** Internal: mark this connection dead without a business callback —
   *  used by the adapter's dispose sweep for never-spawned connections. */
  markDead(): void {
    this.terminal = true;
  }

  dispose(): Promise<import("./provider").ChildCleanupResult> {
    return this.transport.dispose();
  }
}

export interface SyntheticProviderOptions {
  /** Build the launch spec for a turn — executable/args/cwd/env fixed here. */
  makeSpec(workspaceDir: string, scenario: SyntheticScenario): SpawnSpec;
  /** Fixed scenario for every turn of this adapter instance. */
  scenario?: SyntheticScenario;
  limits?: Partial<SyntheticLimits>;
  spawnImpl?: SpawnImpl;
  /** Resolved executable + version recorded before any spawn. */
  runtimeInfo?: { executable: string; version: string };
}

export class SyntheticStdioProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  private readonly limits: SyntheticLimits;
  private readonly connections = new Set<Connection>();
  private disposed = false;
  /** Bounded diagnostics for tests/evidence, never for control flow.
   *  droppedLateFrames aggregates live AND already-released connections.
   *  turnsStarted counts start() reservations; spawnedChildren counts only
   *  transport starts that actually produced a child handle — a refused
   *  or cancelled-before-spawn start never inflates it. */
  readonly stats = { droppedLateFrames: 0, spawnedChildren: 0, turnsStarted: 0 };

  constructor(private readonly opts: SyntheticProviderOptions) {
    this.descriptor = {
      id: SYNTHETIC_PROVIDER_ID,
      label: SYNTHETIC_PROVIDER_LABEL,
      mode: "synthetic-stdio",
      synthetic: true,
      ...(opts.runtimeInfo ? { runtimeInfo: opts.runtimeInfo } : {}),
    };
    this.limits = { ...defaultSyntheticLimits(), ...(opts.limits ?? {}) };
    this.limits.transport = { ...DEFAULT_TRANSPORT_LIMITS, ...(opts.limits?.transport ?? {}) };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Live child processes only. A confirmed-childless connection (refused
   * start / cancelled before spawn) never occupies capacity — even in the
   * instant before release() removes it from the set.
   */
  get activeChildren(): number {
    let n = 0;
    for (const c of this.connections) if (c.transport.hasChild && !c.childClosed) n++;
    return n;
  }

  start(ctx: TurnContext, cb: ProviderCallbacks): ProviderTurnHandle {
    if (this.disposed)
      throw new SyntheticProviderError("PROTOCOL_ERROR", "provider already disposed");
    if (!ctx.workspace)
      throw new SyntheticProviderError(
        "WORKSPACE_NOT_CONFIGURED",
        "WORKSPACE_NOT_CONFIGURED: no authorized directory is bound to this project",
      );
    // Reserve before run() yields; concurrent starts must share the limit.
    if (this.connections.size >= this.limits.maxChildren)
      throw new SyntheticProviderError(
        "SYNTHETIC_CAPACITY",
        `SYNTHETIC_CAPACITY: at most ${this.limits.maxChildren} synthetic children may run at once`,
      );
    const spec = this.opts.makeSpec(ctx.workspace.directory, this.opts.scenario ?? "chat");
    const conn = new Connection(this, ctx, cb, this.limits, spec, this.opts.spawnImpl);
    this.connections.add(conn);
    // Reservation only — spawnedChildren is bumped by noteSpawned() when
    // transport.start() has actually produced a child handle.
    this.stats.turnsStarted++;
    // run() yields once before touching the child — no business callback
    // can fire before start() has returned the handle.
    void conn.run().catch(() => {});
    return {
      // The adapter retains the Connection (and its child) until close is
      // observed — dropping this handle never orphans the process.
      cancel: () => conn.cancel(),
      resume: (approved: boolean) => conn.resolve(approved),
    };
  }

  /** Aggregate a bounded drop into adapter-wide stats. */
  noteDropped(_env: Envelope): void {
    this.stats.droppedLateFrames++;
  }

  /** transport.start() produced a real child handle — count it. */
  noteSpawned(): void {
    this.stats.spawnedChildren++;
  }

  /**
   * A connection is released only when its end is PROVEN: either the
   * child's close was confirmed and every buffered frame delivered, or it
   * is confirmed childless (refused start / cancelled or disposed before
   * the deferred spawn — nothing can ever appear). A created-but-unclosed
   * child is never released: the adapter keeps ownership so a later
   * dispose() can retry the cleanup.
   */
  release(conn: Connection): void {
    if (!conn.childClosed && !conn.confirmedChildless) return;
    this.connections.delete(conn);
  }

  /** Test/evidence introspection — not part of the adapter contract. */
  connectionCount(): number {
    return this.connections.size;
  }

  async dispose(): Promise<AdapterDisposeResult> {
    this.disposed = true;
    // Confirmed-childless connections need no teardown proof — release
    // them first so the report covers only real child processes.
    for (const c of [...this.connections]) {
      if (!c.transport.hasChild) {
        c.markDead();
        this.release(c);
      }
    }
    const children = await Promise.all([...this.connections].map((c) => c.dispose()));
    let orphanedPending = 0;
    for (const c of this.connections) orphanedPending += c.pendingCount;
    return { children, orphanedPending };
  }
}
