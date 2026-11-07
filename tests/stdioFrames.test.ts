// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// NDJSON v1 framing: byte-level LF boundaries, fatal UTF-8, explicit BOM
// rejection, byte caps, line buffering across arbitrary chunk splits, and
// the truncated-tail rule at EOF.

import { describe, expect, it } from "vitest";
import {
  NdjsonDecoder,
  ProtocolError,
  encodeFrame,
  parseEnvelope,
  type Envelope,
} from "../src/main/stdioFrames";

const LIMITS = { maxFrameBytes: 1024 };

function frameOf(env: Partial<Envelope> & { requestId: string }): Buffer {
  return encodeFrame({ v: 1, type: "response", result: { ok: true }, ...env } as Envelope, 4096);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as ProtocolError).code;
  }
  return "";
}

describe("NdjsonDecoder framing", () => {
  it("emits frames on LF boundaries only", () => {
    const d = new NdjsonDecoder(LIMITS);
    const f = frameOf({ requestId: "r1" });
    expect(d.feed(f)).toHaveLength(1);
    expect(d.feed(f)).toHaveLength(1);
  });

  it("reassembles a frame split across arbitrary chunk boundaries", () => {
    const d = new NdjsonDecoder(LIMITS);
    const f = frameOf({ requestId: "split-me" });
    const out: Envelope[] = [];
    for (let i = 0; i < f.byteLength; i++) out.push(...d.feed(f.subarray(i, i + 1)));
    expect(out).toHaveLength(1);
    expect(out[0]!.requestId).toBe("split-me");
  });

  it("collects several frames from one chunk in order", () => {
    const d = new NdjsonDecoder(LIMITS);
    const cat = Buffer.concat([
      frameOf({ requestId: "a" }),
      frameOf({ requestId: "b" }),
      frameOf({ requestId: "c" }),
    ]);
    const out = d.feed(cat);
    expect(out.map((e) => e.requestId)).toEqual(["a", "b", "c"]);
  });

  it("rejects a frame exceeding the byte cap even before LF", () => {
    const d = new NdjsonDecoder(LIMITS);
    expect(code(() => d.feed(Buffer.alloc(LIMITS.maxFrameBytes + 1, 0x61)))).toBe(
      "FRAME_TOO_LARGE",
    );
  });

  it("rejects a complete line whose bytes exceed the cap", () => {
    const d = new NdjsonDecoder(LIMITS);
    const big = Buffer.alloc(LIMITS.maxFrameBytes + 4, 0x61);
    big[big.byteLength - 1] = 0x0a;
    expect(code(() => d.feed(big))).toBe("FRAME_TOO_LARGE");
  });

  it("rejects a leading BOM at the byte layer", () => {
    const d = new NdjsonDecoder(LIMITS);
    const f = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frameOf({ requestId: "bom" })]);
    expect(code(() => d.feed(f))).toBe("BOM_REJECTED");
  });

  it("rejects invalid UTF-8 fatally", () => {
    const d = new NdjsonDecoder(LIMITS);
    expect(code(() => d.feed(Buffer.from([0xff, 0xfe, 0x0a])))).toBe("BAD_UTF8");
  });

  it("rejects empty lines", () => {
    const d = new NdjsonDecoder(LIMITS);
    expect(code(() => d.feed(Buffer.from("\n")))).toBe("EMPTY_LINE");
  });

  it("tolerates CRLF tails", () => {
    const d = new NdjsonDecoder(LIMITS);
    const line = Buffer.concat([frameOf({ requestId: "crlf" })]);
    line[line.byteLength - 1] = 0x0d; // turn \n into \r, then add \n
    const out = d.feed(Buffer.concat([line, Buffer.from([0x0a])]));
    expect(out[0]!.requestId).toBe("crlf");
  });

  it("finish() rejects unterminated trailing bytes", () => {
    const d = new NdjsonDecoder(LIMITS);
    d.feed(Buffer.from('{"v":1,"type":"response","requestId":"x"')); // no LF
    expect(code(() => d.finish())).toBe("TRUNCATED_TAIL");
  });

  it("finish() is clean after exact frames", () => {
    const d = new NdjsonDecoder(LIMITS);
    d.feed(frameOf({ requestId: "ok" }));
    expect(() => d.finish()).not.toThrow();
  });

  it("multi-byte UTF-8 (CJK + emoji) survives EVERY byte split position", () => {
    const payload = {
      v: 1, type: "event", requestId: "utf8", turnId: "t", seq: 1,
      event: "chunk",
      payload: { delta: "你好，世界 🌍🚀 emoji 组合 é" },
    };
    const wire = Buffer.from(JSON.stringify(payload) + "\n", "utf8");
    // Try every single split point: two chunks each time.
    for (let cut = 1; cut < wire.byteLength; cut++) {
      const d = new NdjsonDecoder(LIMITS);
      const out = [...d.feed(wire.subarray(0, cut)), ...d.feed(wire.subarray(cut))];
      expect(out).toHaveLength(1);
      expect((out[0]!.payload as { delta: string }).delta).toBe(
        "你好，世界 🌍🚀 emoji 组合 é",
      );
    }
    // And three-way splits inside a single multi-byte sequence.
    const d = new NdjsonDecoder(LIMITS);
    const firstCjk = wire.indexOf(0xe4); // start of 你
    const out = [
      ...d.feed(wire.subarray(0, firstCjk + 1)),
      ...d.feed(wire.subarray(firstCjk + 1, firstCjk + 2)),
      ...d.feed(wire.subarray(firstCjk + 2)),
    ];
    expect(out).toHaveLength(1);
  });

  it("one chunk may carry many frames; one frame may need many chunks", () => {
    const d = new NdjsonDecoder(LIMITS);
    const three = Buffer.concat([
      frameOf({ requestId: "m1" }),
      frameOf({ requestId: "m2" }),
      frameOf({ requestId: "m3" }),
    ]);
    expect(d.feed(three).map((e) => e.requestId)).toEqual(["m1", "m2", "m3"]);
    const d2 = new NdjsonDecoder(LIMITS);
    const f = frameOf({ requestId: "one-frame-many-chunks" });
    const parts = [
      f.subarray(0, 3),
      f.subarray(3, 17),
      f.subarray(17, f.byteLength - 2),
      f.subarray(f.byteLength - 2),
    ];
    const out: Envelope[] = [];
    for (const p of parts) out.push(...d2.feed(p));
    expect(out.map((e) => e.requestId)).toEqual(["one-frame-many-chunks"]);
  });

  it("a CR/LF pair split across chunks is still one CRLF tail", () => {
    const d = new NdjsonDecoder(LIMITS);
    const f = frameOf({ requestId: "crlf-split" });
    // Replace LF by CRLF then split between CR and LF.
    const crlf = Buffer.concat([f.subarray(0, f.byteLength - 1), Buffer.from([0x0d, 0x0a])]);
    const cut = f.byteLength; // right between \r and \n
    const out = [...d.feed(crlf.subarray(0, cut)), ...d.feed(crlf.subarray(cut))];
    expect(out).toHaveLength(1);
    expect(out[0]!.requestId).toBe("crlf-split");
  });

  it.each([
    ["bad utf-8 continuation", Buffer.from([0x61, 0xe4, 0x0a])],
    ["half JSON at EOF", Buffer.from('{"v":1,"type":"resp')],
    ["valid frame + unterminated tail", Buffer.concat([frameOf({ requestId: "k" }), Buffer.from('{"v"')])],
  ])("EOF failures: %s", (_label, bytes) => {
    const d = new NdjsonDecoder(LIMITS);
    // feed what parses; whatever remains unterminated must fail at finish.
    try {
      d.feed(bytes);
    } catch (e) {
      expect(["BAD_UTF8", "BAD_JSON", "BAD_ENVELOPE"]).toContain((e as ProtocolError).code);
      return;
    }
    expect(code(() => d.finish())).toBe("TRUNCATED_TAIL");
  });
});

describe("parseEnvelope structure", () => {
  it("accepts request/response/event shapes", () => {
    expect(
      parseEnvelope({ v: 1, type: "request", requestId: "r", method: "handshake" }).type,
    ).toBe("request");
    expect(
      parseEnvelope({ v: 1, type: "response", requestId: "r", result: {} }).type,
    ).toBe("response");
    expect(
      parseEnvelope({ v: 1, type: "event", requestId: "r", turnId: "t", seq: 1, event: "chunk" })
        .event,
    ).toBe("chunk");
  });

  it.each([
    [{}, "BAD_ENVELOPE"],
    [{ v: 2, type: "request", requestId: "r", method: "x" }, "BAD_ENVELOPE"],
    [{ v: 1, type: "request", requestId: "r" }, "BAD_ENVELOPE"], // no method
    [{ v: 1, type: "response", requestId: "r" }, "BAD_ENVELOPE"], // neither result nor error
    [
      { v: 1, type: "response", requestId: "r", result: {}, error: { code: "x", message: "y" } },
      "BAD_ENVELOPE",
    ],
    [{ v: 1, type: "response", requestId: "r", error: { code: "x" } }, "BAD_ENVELOPE"],
    [{ v: 1, type: "event", requestId: "r", turnId: "t", seq: 0.5, event: "c" }, "BAD_ENVELOPE"],
    [{ v: 1, type: "mystery", requestId: "r" }, "BAD_ENVELOPE"],
    [{ v: 1, type: "response", requestId: "r", result: {}, extra: 1 }, "BAD_ENVELOPE"],
    ["not an object", "BAD_ENVELOPE"],
    [[1, 2], "BAD_ENVELOPE"],
  ])("rejects %j as %s", (input, want) => {
    expect(code(() => parseEnvelope(input))).toBe(want);
  });

  it("rejects oversized requestId", () => {
    const env = { v: 1, type: "response", requestId: "x".repeat(200), result: {} };
    expect(code(() => parseEnvelope(env))).toBe("BAD_ENVELOPE");
  });
});

describe("encodeFrame", () => {
  it("refuses to emit an oversized frame", () => {
    expect(
      code(() =>
        encodeFrame(
          { v: 1, type: "response", requestId: "r", result: "x".repeat(2048) },
          1024,
        ),
      ),
    ).toBe("FRAME_TOO_LARGE");
  });
});
