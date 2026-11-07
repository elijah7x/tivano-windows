// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex app-server wire layer — independent from the synthetic NDJSON v1
// envelope. Protocol pin: Codex CLI 0.164.0 (rust-v0.164.0, commit
// 6aaac694803004a63c6f393d153c96d22521a6b9). This file implements ONLY the
// message-plane rules verified against the pinned schema/method registry:
//
//   · stdio JSONL, one JSON object per line, UTF-8, NO "jsonrpc" member
//   · client request: {id, method, params?}   response: {id, result|error}
//   · server request: {id, method, params?}   client answers {id, result|error}
//   · notification:  {method, params?}        (no id)
//   · ids are typed: integer 7 and string "7" are DIFFERENT ids and can
//     never alias a pending request or an approval.
//
// Behavior frozen from the Mac baseline (CodexSession.swift / JSONRPC.swift
// @ d31e093b): a response with "id": null is only meaningful when it carries
// an error AND exactly one request is in flight; unknown server requests get
// a -32601 error response rather than hanging; a mutating request whose
// deadline elapses poisons the connection (state unknown — never retried).

import { NdjsonLineDecoder, ProtocolError, encodeJsonLine, type WireCodec } from "./stdioFrames";

export class CodexProtocolError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CODEX_PROTOCOL_ERROR"
      | "CODEX_REQUEST_TIMEOUT"
      | "CODEX_CONNECTION_CLOSED"
      | "CODEX_WRITE_FAILED",
  ) {
    super(message);
    this.name = "CodexProtocolError";
  }
}

// ---- typed request ids ----------------------------------------------------

export type RpcId = { kind: "int"; value: number } | { kind: "string"; value: string };

/** int ids must be safe integers; string ids must be non-empty. */
export function parseRpcId(raw: unknown): RpcId | null {
  if (typeof raw === "number" && Number.isInteger(raw) && Number.isSafeInteger(raw))
    return { kind: "int", value: raw };
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 256)
    return { kind: "string", value: raw };
  return null;
}

/** Typed correlation key — "i:7" and "s:7" can never collide. */
export function rpcIdKey(id: RpcId): string {
  return id.kind === "int" ? `i:${id.value}` : `s:${id.value}`;
}

export function rpcIdWire(id: RpcId): number | string {
  return id.kind === "int" ? id.value : id.value;
}

// ---- inbound messages -----------------------------------------------------

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcInbound =
  | { kind: "request"; id: RpcId; method: string; params: unknown }
  | { kind: "response"; id: RpcId | null; result: unknown; error: RpcErrorObject | null }
  | { kind: "notification"; method: string; params: unknown };

function parseErrorObject(raw: unknown): RpcErrorObject | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.code !== "number" || !Number.isInteger(e.code)) return null;
  if (typeof e.message !== "string") return null;
  return "data" in e
    ? { code: e.code, message: e.message, data: e.data }
    : { code: e.code, message: e.message };
}

/**
 * Classify one parsed line. Throws ProtocolError(BAD_ENVELOPE) for shapes
 * that are not a legal Codex app-server message.
 */
export function classifyMessage(parsed: unknown): RpcInbound {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ProtocolError("codex message is not an object", "BAD_ENVELOPE");
  const o = parsed as Record<string, unknown>;
  const method = o.method;
  if (method !== undefined) {
    if (typeof method !== "string" || method.length === 0 || method.length > 256)
      throw new ProtocolError("codex method malformed", "BAD_ENVELOPE");
    const params = "params" in o ? o.params : undefined;
    if ("id" in o && o.id !== null) {
      const id = parseRpcId(o.id);
      if (!id) throw new ProtocolError("server request id malformed", "BAD_ENVELOPE");
      return { kind: "request", id, method, params };
    }
    return { kind: "notification", method, params };
  }
  // No method → response. It must carry id (null only tolerated with error).
  if (!("id" in o)) throw new ProtocolError("codex response missing id", "BAD_ENVELOPE");
  const hasResult = "result" in o;
  const hasError = "error" in o && o.error !== null;
  if (hasResult === hasError)
    throw new ProtocolError("response must carry exactly one of result/error", "BAD_ENVELOPE");
  const error = hasError ? parseErrorObject(o.error) : null;
  if (hasError && !error)
    throw new ProtocolError("error field is not {code:int,message:string}", "BAD_ENVELOPE");
  if (o.id === null) {
    if (!error) throw new ProtocolError("null response id without error", "BAD_ENVELOPE");
    return { kind: "response", id: null, result: undefined, error };
  }
  const id = parseRpcId(o.id);
  if (!id) throw new ProtocolError("response id malformed", "BAD_ENVELOPE");
  return { kind: "response", id, result: o.result, error };
}

// ---- outbound messages ----------------------------------------------------

export type RpcOutbound =
  | { kind: "request"; id: RpcId; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "result"; id: RpcId; result: unknown }
  | { kind: "error"; id: RpcId; error: RpcErrorObject };

function outboundWire(m: RpcOutbound): Record<string, unknown> {
  switch (m.kind) {
    case "request": {
      const w: Record<string, unknown> = { id: rpcIdWire(m.id), method: m.method };
      if (m.params !== undefined) w.params = m.params;
      return w;
    }
    case "notification": {
      const w: Record<string, unknown> = { method: m.method };
      if (m.params !== undefined) w.params = m.params;
      return w;
    }
    case "result":
      return { id: rpcIdWire(m.id), result: m.result };
    case "error":
      return { id: rpcIdWire(m.id), error: m.error };
  }
}

export type CodexMessage = RpcInbound | RpcOutbound;

/**
 * Independent Codex JSONL codec: the shared byte framer plus Codex
 * message classification — NOT the synthetic envelope.
 */
export class CodexWireCodec implements WireCodec<CodexMessage> {
  private readonly lines: NdjsonLineDecoder;
  constructor(maxFrameBytes: number) {
    this.lines = new NdjsonLineDecoder({ maxFrameBytes });
  }
  get pendingBytes(): number {
    return this.lines.pendingBytes;
  }
  feed(chunk: Uint8Array): CodexMessage[] {
    return this.lines.feed(chunk).map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ProtocolError("codex frame is not valid JSON", "BAD_JSON");
      }
      return classifyMessage(parsed);
    });
  }
  finish(): void {
    this.lines.finish();
  }
  encode(m: CodexMessage, maxFrameBytes: number): Buffer {
    // The only shape that must never be written is an inbound "response"
    // envelope — server-request answers go out as "result"/"error".
    if (m.kind === "response")
      throw new ProtocolError("cannot encode an inbound response shape", "BAD_ENVELOPE");
    return encodeJsonLine(outboundWire(m as RpcOutbound), maxFrameBytes);
  }
}

export function codexWireCodec(maxFrameBytes: number): WireCodec<CodexMessage> {
  return new CodexWireCodec(maxFrameBytes);
}

// ---- correlated request/response session -----------------------------------

export interface CodexRpcOptions {
  /** Default per-request deadline (provider passes method-specific values). */
  requestTimeoutMs: number;
  /** Max concurrently unanswered client requests (default 64). */
  maxPending?: number;
  /**
   * Called when a MUTATING request's deadline elapsed — the wire state is
   * now unknown, so the owner must close the connection (never retry).
   */
  onMutatingTimeout?(method: string): void;
}

export interface CodexRpcHooks {
  /** A server-initiated request arrived; the owner decides the response. */
  onServerRequest(id: RpcId, method: string, params: unknown): void;
  onNotification(method: string, params: unknown): void;
  /** Transport delivered its close — pending is already failed. */
  onClosed(reason: string): void;
  /** Malformed wire data — fatal; the owner disposes the transport. */
  onFatal(err: Error): void;
}

interface PendingRequest {
  method: string;
  mutating: boolean;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface RpcTransportLike {
  /**
   * Queue a frame. false = refused (that IS the settlement — ack never
   * fires). true = queued; the optional one-shot `ack` fires exactly once
   * with the real write outcome. Queue admission is NOT write success.
   */
  send(m: CodexMessage, ack?: (err: Error | null) => void): boolean;
}

/**
 * Bidirectional JSON-RPC session over an injected transport send() — the
 * transport stays a dumb byte pipe; this class owns id correlation,
 * pending timeouts and server-request dispatch. Server ids NEVER enter
 * the client pending table.
 */
export class CodexRpc {
  private pending = new Map<string, PendingRequest>();
  private nextInt = 1;
  /** Successful-response settlements — lets teardown count what actually
   *  resolved during the close grace instead of pre-cleanup pendings. */
  private resolved = 0;
  /** Late/duplicate/foreign inbound drops — diagnostics only. */
  dropped = 0;

  constructor(
    private readonly transport: RpcTransportLike,
    private readonly hooks: CodexRpcHooks,
    private readonly opts: CodexRpcOptions,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cumulative count of client requests settled by a SUCCESS response —
   *  lets teardown measure what resolved during the close grace instead
   *  of counting pre-cleanup pendings as orphans. */
  get resolvedCount(): number {
    return this.resolved;
  }

  /**
   * Synchronous lookup used by session-level admission: which method does
   * a still-pending outbound request id belong to? Lets a caller correlate
   * a response frame BEFORE the promise continuation runs (same-chunk
   * frames dispatch synchronously; microtasks run later).
   */
  pendingMethodFor(id: RpcId): string | null {
    return this.pending.get(rpcIdKey(id))?.method ?? null;
  }

  /** The single in-flight request's key, or null when zero/multiple. */
  solePendingKey(): string | null {
    if (this.pending.size !== 1) return null;
    return [...this.pending.keys()][0] ?? null;
  }

  private allocId(): RpcId {
    return { kind: "int", value: this.nextInt++ };
  }

  /**
   * Client request. `mutating` marks side-effect calls (thread/turn start,
   * resume, interrupt): their timeout rejects AND poisons the connection —
   * the answer may already have happened, so nothing is retried blindly.
   */
  request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; mutating?: boolean } = {},
    onAssigned?: (id: RpcId) => void,
  ): Promise<unknown> {
    const maxPending = this.opts.maxPending ?? 64;
    if (this.pending.size >= maxPending)
      return Promise.reject(
        new CodexProtocolError(`pending request limit ${maxPending} reached`, "CODEX_PROTOCOL_ERROR"),
      );
    const id = this.allocId();
    onAssigned?.(id);
    const key = rpcIdKey(id);
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs;
    const mutating = opts.mutating === true;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(
          new CodexProtocolError(
            `CODEX_REQUEST_TIMEOUT: ${method} did not answer within ${timeoutMs} ms`,
            "CODEX_REQUEST_TIMEOUT",
          ),
        );
        if (mutating) this.opts.onMutatingTimeout?.(method);
      }, timeoutMs);
      this.pending.set(key, { method, mutating, timer, resolve, reject });
    });
    const ok = this.transport.send({ kind: "request", id, method, params }, (err) => {
      // A frame that never completed its write can never have been seen by
      // the server — fail this request instead of hanging until timeout.
      // (A dead transport's teardown path also fails pending; either order
      // is idempotent.)
      if (!err) return;
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      clearTimeout(p.timer);
      p.reject(
        new CodexProtocolError(
          `CODEX_WRITE_FAILED: ${method} never reached the server: ${err.message}`,
          "CODEX_WRITE_FAILED",
        ),
      );
    });
    if (!ok) {
      const p = this.pending.get(key);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(key);
      }
      return Promise.reject(
        new CodexProtocolError(`CODEX_WRITE_FAILED: could not write ${method}`, "CODEX_WRITE_FAILED"),
      );
    }
    return promise;
  }

  /** Unawaited notification — fire-and-forget, never tracked. */
  notify(method: string, params?: unknown): boolean {
    return this.transport.send({ kind: "notification", method, params });
  }

  /**
   * Answer a server-initiated request. `false` = refused outright (no ack
   * will fire). `true` = queued; `onWritten` fires exactly once with the
   * actual write outcome — approval answers MUST key off it, not off the
   * queue boolean.
   */
  respond(id: RpcId, result: unknown, onWritten?: (err: Error | null) => void): boolean {
    return this.transport.send({ kind: "result", id, result }, onWritten);
  }

  respondError(
    id: RpcId,
    code: number,
    message: string,
    onWritten?: (err: Error | null) => void,
  ): boolean {
    return this.transport.send({ kind: "error", id, error: { code, message } }, onWritten);
  }

  /**
   * Frame-level attribution for the `id: null` edge: the method of the
   * single in-flight request, or null when zero/multiple are pending.
   * Lets the session synchronously attribute a bare error response.
   */
  solePendingMethod(): string | null {
    if (this.pending.size !== 1) return null;
    return [...this.pending.values()][0]!.method;
  }

  /** Dispatch one decoded inbound message (transport onFrame). */
  onFrame(m: CodexMessage): void {
    if (m.kind === "response") {
      this.settleResponse(m);
      return;
    }
    if (m.kind === "request") {
      this.hooks.onServerRequest(m.id, m.method, m.params);
      return;
    }
    if (m.kind === "notification") {
      this.hooks.onNotification(m.method, m.params);
      return;
    }
    this.dropped++;
  }

  private settleResponse(m: Extract<RpcInbound, { kind: "response" }>): void {
    if (m.id === null) {
      // A bare id:null frame can only ever carry an ERROR attribution —
      // a success response with no id is unattributable and dropped.
      if (m.error === null) {
        this.dropped++;
        return;
      }
      // Codex never read the request id: answerable only when exactly one
      // request is in flight (frozen Mac rule); otherwise a bounded drop.
      if (this.pending.size === 1) {
        const [key, p] = [...this.pending][0]!;
        this.pending.delete(key);
        clearTimeout(p.timer);
        p.reject(
          new CodexProtocolError(
            `${m.error!.code}: ${m.error!.message}`,
            "CODEX_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      this.dropped++;
      return;
    }
    const p = this.pending.get(rpcIdKey(m.id));
    if (!p) {
      this.dropped++; // unknown / late / duplicate response — never a crash
      return;
    }
    this.pending.delete(rpcIdKey(m.id));
    clearTimeout(p.timer);
    if (m.error) {
      p.reject(
        new CodexProtocolError(`${m.error.code}: ${m.error.message}`, "CODEX_PROTOCOL_ERROR"),
      );
    } else {
      this.resolved++;
      p.resolve(m.result);
    }
  }

  /** Reject every in-flight request (connection teardown). */
  failAllPending(message: string): void {
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexProtocolError(message, "CODEX_CONNECTION_CLOSED"));
      this.pending.delete(key);
    }
  }
}
