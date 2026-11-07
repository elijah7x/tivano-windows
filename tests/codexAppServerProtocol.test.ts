// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex wire layer: typed ids, message classification, codec roundtrip,
// and CodexRpc correlation/timeout/server-request semantics. The message
// corpus comes from the hand-built official-protocol fixture
// (tests/fixtures/codex-app-server/protocol-messages.json, pin 0.164.0
// / 6aaac694) — plus focused adversarial cases.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CodexRpc,
  CodexWireCodec,
  classifyMessage,
  parseRpcId,
  rpcIdKey,
  type CodexMessage,
  type RpcInbound,
} from "../src/main/codexAppServerProtocol";
import { ProtocolError } from "../src/main/stdioFrames";

const CATALOG = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/codex-app-server/protocol-messages.json", import.meta.url)),
    "utf8",
  ),
) as {
  valid: Array<{ name: string; direction: string; line: unknown }>;
  malformed: Array<{ name: string; line: unknown; raw?: boolean; expected: string }>;
};

function feedLine(codec: CodexWireCodec, line: unknown): CodexMessage[] {
  const raw = typeof line === "string" ? line : JSON.stringify(line);
  return codec.feed(Buffer.from(raw + "\n", "utf8"));
}

describe("parseRpcId", () => {
  it("accepts safe integers (incl. 0 and negatives)", () => {
    expect(parseRpcId(7)).toEqual({ kind: "int", value: 7 });
    expect(parseRpcId(0)).toEqual({ kind: "int", value: 0 });
    expect(parseRpcId(-3)).toEqual({ kind: "int", value: -3 });
  });
  it("accepts non-empty strings", () => {
    expect(parseRpcId("srv-9")).toEqual({ kind: "string", value: "srv-9" });
  });
  it("rejects floats, unsafe ints, empty/huge strings, other types", () => {
    for (const v of [1.5, Number.MAX_SAFE_INTEGER + 1, "", "x".repeat(300), null, true, {}, [], NaN])
      expect(parseRpcId(v)).toBeNull();
  });
  it("typed keys never collide: int 7 ≠ string '7'", () => {
    expect(rpcIdKey({ kind: "int", value: 7 })).not.toBe(rpcIdKey({ kind: "string", value: "7" }));
  });
});

describe("classifyMessage — official fixture corpus", () => {
  const codec = () => new CodexWireCodec(256 * 1024);
  it("every 'valid' entry decodes through the codec", () => {
    for (const entry of CATALOG.valid) {
      const c = codec();
      const frames = feedLine(c, entry.line);
      expect(frames, entry.name).toHaveLength(1);
      const f = frames[0]!;
      expect(["request", "response", "notification"]).toContain(f.kind);
    }
  });
  it("every 'malformed' entry with a BAD_* expectation is rejected", () => {
    for (const entry of CATALOG.malformed) {
      if (!entry.expected.startsWith("BAD_")) continue;
      const c = codec();
      expect(() => feedLine(c, entry.line), entry.name).toThrow(ProtocolError);
    }
  });
  it("a 'jsonrpc' member is tolerated but classified normally (documented)", () => {
    const c = codec();
    const f = feedLine(c, { jsonrpc: "2.0", method: "initialized" });
    expect(f[0]).toMatchObject({ kind: "notification", method: "initialized" });
  });
});

describe("classifyMessage — shape rules", () => {
  it("distinguishes request vs notification by id presence", () => {
    expect(classifyMessage({ id: 5, method: "m", params: {} })).toMatchObject({
      kind: "request",
      id: { kind: "int", value: 5 },
    });
    expect(classifyMessage({ method: "m" })).toMatchObject({ kind: "notification" });
    expect(classifyMessage({ method: "m", id: null })).toMatchObject({ kind: "notification" });
  });
  it("null-id response requires an error", () => {
    expect(() => classifyMessage({ id: null, result: {} })).toThrow(ProtocolError);
    expect(classifyMessage({ id: null, error: { code: -1, message: "x" } })).toMatchObject({
      kind: "response",
      id: null,
    });
  });
  it("string request ids stay typed", () => {
    expect(classifyMessage({ id: "srv-1", method: "m" })).toMatchObject({
      kind: "request",
      id: { kind: "string", value: "srv-1" },
    });
  });
});

describe("CodexWireCodec roundtrip", () => {
  it("encodes every outbound shape without a jsonrpc member", () => {
    const c = new CodexWireCodec(256 * 1024);
    const cases: CodexMessage[] = [
      { kind: "request", id: { kind: "int", value: 1 }, method: "initialize", params: {} },
      { kind: "notification", method: "initialized" },
      { kind: "result", id: { kind: "string", value: "srv-1" }, result: { decision: "accept" } },
      { kind: "error", id: { kind: "int", value: 9 }, error: { code: -32601, message: "no" } },
    ];
    for (const m of cases) {
      const buf = c.encode(m, 256 * 1024);
      const parsed = JSON.parse(buf.toString("utf8").trim());
      expect(parsed).not.toHaveProperty("jsonrpc");
      expect(feedLine(new CodexWireCodec(256 * 1024), parsed)[0]).toBeDefined();
    }
  });
  it("refuses to encode an inbound response shape", () => {
    const c = new CodexWireCodec(256 * 1024);
    expect(() =>
      c.encode({ kind: "response", id: null, result: undefined, error: null }, 1000),
    ).toThrow(ProtocolError);
  });
  it("frames mid-line chunks and rejects oversize lines", () => {
    const c = new CodexWireCodec(64);
    const msg = JSON.stringify({ method: "m", params: { x: "y".repeat(80) } });
    expect(() => c.feed(Buffer.from(msg + "\n"))).toThrow(/frame/);
    const c2 = new CodexWireCodec(1024);
    const half = Buffer.from(JSON.stringify({ method: "ok" }).slice(0, 5));
    expect(c2.feed(half)).toEqual([]);
    expect(c2.feed(Buffer.from(JSON.stringify({ method: "ok" }).slice(5) + "\n"))).toHaveLength(1);
  });
});

// ---- CodexRpc -------------------------------------------------------------

function fakeTransport() {
  const sent: unknown[] = [];
  return {
    sent,
    transport: { send: (m: unknown) => (sent.push(m), true) },
  };
}
function rpcHooks() {
  return {
    onServerRequest: vi.fn(),
    onNotification: vi.fn(),
    onClosed: vi.fn(),
    onFatal: vi.fn(),
  };
}
const req = (line: object): RpcInbound => classifyMessage(line) as RpcInbound;

describe("CodexRpc", () => {
  it("correlates int and string responses strictly", async () => {
    const { transport, sent } = fakeTransport();
    const rpc = new CodexRpc(transport, rpcHooks(), { requestTimeoutMs: 1000 });
    const p1 = rpc.request("a/method", {});
    const p2 = rpc.request("b/method", {});
    const [m1, m2] = sent as Array<{ kind: string; id: { kind: string; value: number }; method: string }>;
    expect(m1).toMatchObject({ kind: "request", method: "a/method", id: { kind: "int", value: 1 } });
    expect(m2).toMatchObject({ kind: "request", method: "b/method", id: { kind: "int", value: 2 } });
    // String id "1" must NOT settle int request 1.
    rpc.onFrame(req({ id: "1", result: { wrong: true } }));
    expect(rpc.dropped).toBe(1);
    rpc.onFrame(req({ id: 2, result: { ok: 2 } }));
    rpc.onFrame(req({ id: 1, result: { ok: 1 } }));
    await expect(p1).resolves.toEqual({ ok: 1 });
    await expect(p2).resolves.toEqual({ ok: 2 });
  });

  it("rejects on RPC error objects and counts late/unknown responses", async () => {
    const { transport } = fakeTransport();
    const rpc = new CodexRpc(transport, rpcHooks(), { requestTimeoutMs: 1000 });
    const p = rpc.request("x/y", {});
    rpc.onFrame(req({ id: 1, error: { code: -32602, message: "bad params" } }));
    await expect(p).rejects.toThrow("-32602: bad params");
    rpc.onFrame(req({ id: 1, result: {} })); // late — already settled
    rpc.onFrame(req({ id: 99, result: {} })); // foreign
    expect(rpc.dropped).toBe(2);
  });

  it("id:null error resolves only when exactly one request is pending", async () => {
    const { transport } = fakeTransport();
    const rpc = new CodexRpc(transport, rpcHooks(), { requestTimeoutMs: 1000 });
    const solo = rpc.request("only/one", {});
    rpc.onFrame(req({ id: null, error: { code: -32700, message: "parse error" } }));
    await expect(solo).rejects.toThrow("-32700");
    const a = rpc.request("a", {});
    const b = rpc.request("b", {});
    rpc.onFrame(req({ id: null, error: { code: -32700, message: "which?" } }));
    expect(rpc.dropped).toBe(1); // ambiguous → bounded drop, both still pending
    rpc.failAllPending("closed");
    await expect(a).rejects.toThrow("closed");
    await expect(b).rejects.toThrow("closed");
  });

  it("request deadlines reject; mutating timeouts poison via the hook", async () => {
    const onMutating = vi.fn();
    const { transport } = fakeTransport();
    const rpc = new CodexRpc(transport, rpcHooks(), {
      requestTimeoutMs: 40,
      onMutatingTimeout: onMutating,
    });
    await expect(rpc.request("slow/read", {})).rejects.toThrow("CODEX_REQUEST_TIMEOUT");
    await expect(rpc.request("turn/start", {}, { mutating: true })).rejects.toThrow(
      "CODEX_REQUEST_TIMEOUT",
    );
    expect(onMutating).toHaveBeenCalledWith("turn/start");
  });

  it("per-request timeoutMs overrides the default", async () => {
    const { transport } = fakeTransport();
    const rpc = new CodexRpc(transport, rpcHooks(), { requestTimeoutMs: 60_000 });
    await expect(
      rpc.request("quick", {}, { timeoutMs: 30 }),
    ).rejects.toThrow("CODEX_REQUEST_TIMEOUT");
  });

  it("a failed write rejects the request immediately", async () => {
    const rpc = new CodexRpc({ send: () => false }, rpcHooks(), { requestTimeoutMs: 1000 });
    await expect(rpc.request("m", {})).rejects.toThrow("CODEX_WRITE_FAILED");
    expect(rpc.pendingCount).toBe(0);
  });

  it("server requests dispatch to the hook and never enter the pending table", async () => {
    const { transport, sent } = fakeTransport();
    const hooks = rpcHooks();
    const rpc = new CodexRpc(transport, hooks, { requestTimeoutMs: 1000 });
    const p = rpc.request("client/method", {});
    rpc.onFrame(req({ id: 1, method: "item/commandExecution/requestApproval", params: {} }));
    expect(hooks.onServerRequest).toHaveBeenCalledWith(
      { kind: "int", value: 1 },
      "item/commandExecution/requestApproval",
      {},
    );
    expect(rpc.pendingCount).toBe(1); // only OUR request pending
    // Answer the server request — its id never aliases ours.
    expect(rpc.respond({ kind: "int", value: 1 }, { decision: "accept" })).toBe(true);
    const written = sent.at(-1) as { kind: string; id: unknown; result: unknown };
    expect(written).toEqual({
      kind: "result",
      id: { kind: "int", value: 1 },
      result: { decision: "accept" },
    });
    rpc.onFrame(req({ id: 1, result: { fine: true } }));
    await expect(p).resolves.toEqual({ fine: true });
  });

  it("pending cap refuses new requests", async () => {
    const { transport } = fakeTransport();
    const rpc = new CodexRpc(transport, rpcHooks(), { requestTimeoutMs: 5000, maxPending: 2 });
    const a = rpc.request("a", {});
    const b = rpc.request("b", {});
    await expect(rpc.request("c", {})).rejects.toThrow("pending request limit");
    rpc.failAllPending("x");
    await expect(a).rejects.toThrow("x");
    await expect(b).rejects.toThrow("x");
  });
});
