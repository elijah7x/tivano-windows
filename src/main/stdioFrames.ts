// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Synthetic NDJSON v1 wire framing — explicitly NOT Codex JSON-RPC or any
// third-party protocol. One UTF-8 JSON object per LF-terminated line.
//
// Byte-level rules (enforced on raw bytes before decoding):
//  · LF (0x0A) splits frames — it can never appear inside a multi-byte
//    UTF-8 sequence, so byte-scanning is exact; CRLF tails are tolerated.
//  · Frame size is measured in BYTES, not string length.
//  · Empty lines, a leading BOM, invalid UTF-8 (fatal decoder), non-object
//    JSON, unknown v/type, oversized ids and non-integer seq all fail.
//  · Bytes left at EOF without a trailing LF are a truncated frame —
//    they are never guessed-complete.

import { ValidationError } from "../shared/validate";

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code:
      | "FRAME_TOO_LARGE"
      | "BAD_UTF8"
      | "BOM_REJECTED"
      | "EMPTY_LINE"
      | "BAD_JSON"
      | "BAD_ENVELOPE"
      | "TRUNCATED_TAIL"
      | "OUTPUT_LIMIT"
      | "HANDSHAKE_TIMEOUT"
      | "PREMATURE_EXIT"
      | "UNTERMINATED_STDIN",
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

const LF = 0x0a;
const CR = 0x0d;
const BOM = [0xef, 0xbb, 0xbf];

export const FRAME_TYPES = ["request", "response", "event"] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

export const MAX_ID_LEN = 128;

export interface Envelope {
  v: 1;
  type: FrameType;
  requestId: string;
  /** event frames carry turnId + monotonic seq. */
  turnId?: string;
  seq?: number;
  method?: string;
  params?: unknown;
  event?: string;
  payload?: unknown;
  /** response carries exactly one of result/error. */
  result?: unknown;
  error?: { code: string; message: string };
}

/** Structural envelope check — semantic method/event checks live above. */
export function parseEnvelope(raw: unknown): Envelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ProtocolError("frame is not an object", "BAD_ENVELOPE");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "type", "requestId", "turnId", "seq", "method", "params",
    "event", "payload", "result", "error",
  ]);
  for (const k of Object.keys(o))
    if (!allowed.has(k))
      throw new ProtocolError(`unexpected envelope key "${k}"`, "BAD_ENVELOPE");
  if (o.v !== 1) throw new ProtocolError("unsupported protocol version", "BAD_ENVELOPE");
  if (typeof o.type !== "string" || !(FRAME_TYPES as readonly string[]).includes(o.type))
    throw new ProtocolError(`unknown frame type ${String(o.type)}`, "BAD_ENVELOPE");
  if (typeof o.requestId !== "string" || o.requestId.length === 0 || o.requestId.length > MAX_ID_LEN)
    throw new ProtocolError("requestId missing or oversized", "BAD_ENVELOPE");
  if (o.turnId !== undefined && (typeof o.turnId !== "string" || o.turnId.length > MAX_ID_LEN))
    throw new ProtocolError("turnId malformed or oversized", "BAD_ENVELOPE");
  if (o.seq !== undefined && (!Number.isInteger(o.seq) || (o.seq as number) < 0))
    throw new ProtocolError("seq must be a non-negative integer", "BAD_ENVELOPE");
  if (o.type === "response") {
    const hasResult = "result" in o;
    const hasError = "error" in o;
    if (hasResult === hasError)
      throw new ProtocolError("response must carry exactly one of result/error", "BAD_ENVELOPE");
    if (hasError) {
      const e = o.error;
      if (
        typeof e !== "object" || e === null ||
        typeof (e as Record<string, unknown>).code !== "string" ||
        typeof (e as Record<string, unknown>).message !== "string"
      )
        throw new ProtocolError("error field is not {code,message}", "BAD_ENVELOPE");
    }
  }
  if (o.type === "request" && (typeof o.method !== "string" || o.method.length === 0))
    throw new ProtocolError("request frame missing method", "BAD_ENVELOPE");
  if (o.type === "event") {
    if (typeof o.turnId !== "string" || !Number.isInteger(o.seq))
      throw new ProtocolError("event frame missing turnId/seq", "BAD_ENVELOPE");
    if (typeof o.event !== "string" || o.event.length === 0)
      throw new ProtocolError("event frame missing event name", "BAD_ENVELOPE");
  }
  return o as unknown as Envelope;
}

export interface FrameDecoderLimits {
  /** Per-frame cap in BYTES (default 256 KiB). */
  maxFrameBytes: number;
}

/**
 * Transport-facing codec contract: raw inbound bytes → typed frames,
 * typed frames → bytes. The bounded byte pump in stdioTransport is
 * protocol-agnostic; the synthetic NDJSON v1 codec and the Codex
 * app-server JSONL codec are two independent implementations of it.
 */
export interface WireCodec<F> {
  /** Bytes received but not yet framed — for the cumulative stdout budget. */
  readonly pendingBytes: number;
  /** Returns the frames completed in this chunk. Throws ProtocolError. */
  feed(chunk: Uint8Array): F[];
  /** Flush at EOF — throws on a truncated tail. */
  finish(): void;
  /** Serialize one frame to bytes (incl. LF), enforcing the byte cap. */
  encode(frame: F, maxFrameBytes: number): Buffer;
}

/**
 * Byte-level NDJSON line framer shared by every line-delimited wire:
 * LF split, per-frame byte cap, empty-line rejection, explicit BOM
 * rejection, fatal UTF-8, truncated-tail rejection at EOF. It yields
 * decoded line STRINGS — the per-line schema decision belongs to the
 * concrete codec layered on top.
 */
export class NdjsonLineDecoder {
  private buf: Buffer[] = [];
  private buffered = 0;
  // ignoreBOM:true keeps a BOM as U+FEFF — it is then rejected explicitly
  // by the byte-level BOM check instead of being silently stripped.
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  constructor(protected readonly limits: FrameDecoderLimits) {}

  /** Bytes received but not yet framed — for the cumulative stdout budget. */
  get pendingBytes(): number {
    return this.buffered;
  }

  feed(chunk: Uint8Array): string[] {
    this.buf.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.buffered += chunk.byteLength;
    const lines: string[] = [];
    for (;;) {
      const pos = this.scanLf();
      if (pos < 0) {
        if (this.buffered > this.limits.maxFrameBytes)
          throw new ProtocolError(
            `frame exceeded ${this.limits.maxFrameBytes} bytes without LF`,
            "FRAME_TOO_LARGE",
          );
        break;
      }
      const line = this.takeBytes(pos); // excludes the LF
      lines.push(this.decodeLineBytes(line));
    }
    return lines;
  }

  private finished = false;
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.buffered > 0)
      throw new ProtocolError("EOF with unterminated trailing bytes", "TRUNCATED_TAIL");
  }

  private scanLf(): number {
    let seen = 0;
    for (const b of this.buf) {
      const at = b.indexOf(LF);
      if (at >= 0) return seen + at;
      seen += b.byteLength;
    }
    return -1;
  }

  private takeBytes(n: number): Buffer {
    const out: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.buf[0]!;
      if (head.byteLength <= need) {
        out.push(head);
        this.buf.shift();
        need -= head.byteLength;
      } else {
        out.push(head.subarray(0, need));
        this.buf[0] = head.subarray(need);
        need = 0;
      }
    }
    this.buffered -= n;
    // Drop ONLY the LF byte — the head chunk may carry more frames after it.
    this.buf[0] = this.buf[0]!.subarray(1);
    if (this.buf[0]!.byteLength === 0) this.buf.shift();
    this.buffered -= 1;
    const joined = out.length === 1 ? out[0]! : Buffer.concat(out);
    // Tolerate CRLF: strip one trailing CR before byte-count checks.
    if (joined.byteLength > 0 && joined[joined.byteLength - 1] === CR)
      return joined.subarray(0, joined.byteLength - 1);
    return joined;
  }

  /** Byte-level checks then whole-line fatal UTF-8 decode → line string. */
  private decodeLineBytes(line: Buffer): string {
    if (line.byteLength > this.limits.maxFrameBytes)
      throw new ProtocolError(`frame of ${line.byteLength} bytes exceeds limit`, "FRAME_TOO_LARGE");
    if (line.byteLength === 0)
      throw new ProtocolError("empty line", "EMPTY_LINE");
    if (
      line.byteLength >= 3 &&
      line[0] === BOM[0] && line[1] === BOM[1] && line[2] === BOM[2]
    )
      throw new ProtocolError("BOM-prefixed frame rejected", "BOM_REJECTED");
    try {
      // Whole-line decode: a line ending mid-codepoint is invalid UTF-8.
      return this.decoder.decode(line, { stream: false });
    } catch {
      throw new ProtocolError("invalid UTF-8 in frame", "BAD_UTF8");
    }
  }
}

/**
 * Incremental NDJSON decoder over raw stdout bytes. feed() returns the
 * envelopes completed in this chunk; finish() flushes at EOF and rejects
 * a truncated tail. Also usable directly as the transport WireCodec.
 */
export class NdjsonDecoder implements WireCodec<Envelope> {
  private readonly lines: NdjsonLineDecoder;

  constructor(private readonly limits: FrameDecoderLimits) {
    this.lines = new NdjsonLineDecoder(limits);
  }

  get pendingBytes(): number {
    return this.lines.pendingBytes;
  }

  feed(chunk: Uint8Array): Envelope[] {
    return this.lines.feed(chunk).map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ProtocolError("frame is not valid JSON", "BAD_JSON");
      }
      return parseEnvelope(parsed);
    });
  }

  finish(): void {
    this.lines.finish();
  }

  encode(env: Envelope, maxFrameBytes: number): Buffer {
    return encodeJsonLine(env, maxFrameBytes);
  }
}

/** The synthetic wire codec — the default codec of StdioTransport. */
export function syntheticWireCodec(limits: FrameDecoderLimits): WireCodec<Envelope> {
  return new NdjsonDecoder(limits);
}

/** Serialize one JSON value as one LF-terminated line, byte-capped. */
export function encodeJsonLine(value: unknown, maxFrameBytes: number): Buffer {
  const buf = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (buf.byteLength > maxFrameBytes)
    throw new ProtocolError(`outbound frame exceeds ${maxFrameBytes} bytes`, "FRAME_TOO_LARGE");
  return buf;
}

/** Serialize one frame. Throws if it exceeds the byte cap — never emit partial. */
export function encodeFrame(env: Envelope, maxFrameBytes: number): Buffer {
  return encodeJsonLine(env, maxFrameBytes);
}
