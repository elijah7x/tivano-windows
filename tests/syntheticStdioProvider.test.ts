// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// SyntheticStdioProvider over the real fixture: handshake correlation,
// turn events, approval once/deny (never session/always), cancel, the
// error/exit matrix, capacity, and dispose() reporting real child closes.

import { mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SyntheticStdioProvider,
  SyntheticProviderError,
  Connection,
  defaultSyntheticLimits,
  type SyntheticScenario,
} from "../src/main/syntheticStdioProvider";
import type { ProviderCallbacks, TurnContext } from "../src/main/provider";
import type { ApprovalRequest } from "../src/shared/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/synthetic-stdio.mjs", import.meta.url));
const NODE = process.execPath;

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "tivano-ws-"));
}

function providerFor(scenario: SyntheticScenario, limits = {}): SyntheticStdioProvider {
  return new SyntheticStdioProvider({
    scenario,
    runtimeInfo: { executable: NODE, version: process.version },
    limits,
    makeSpec: (dir, sc) => ({
      executable: NODE,
      args: [FIXTURE, `--scenario=${sc}`],
      cwd: dir,
      env: {},
    }),
  });
}

interface CollectedCb {
  chunks: string[];
  approvals: Array<Omit<ApprovalRequest, "id" | "turnId" | "status">>;
  done: boolean;
  errors: string[];
}

function cbCollect(): { cb: ProviderCallbacks; c: CollectedCb } {
  const c: CollectedCb = { chunks: [], approvals: [], done: false, errors: [] };
  return {
    c,
    cb: {
      onChunk: (_seq, delta) => c.chunks.push(delta),
      onApproval: (r) => c.approvals.push(r),
      onDone: () => (c.done = true),
      onError: (m) => c.errors.push(m),
    },
  };
}

function ctx(prompt = "hello", workspaceDir?: string): TurnContext {
  return {
    prompt,
    threadId: "thread-1",
    turnId: "turn-1",
    ...(workspaceDir
      ? { workspace: { projectId: "p1", directory: workspaceDir } }
      : {}),
  };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Scripted child that emits exact wire bytes on demand. */
class ScriptedChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 777;
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    // Behave like a dying-but-closing process so dispose() can confirm.
    setTimeout(() => {
      this.emit("exit", null, "SIGKILL");
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, "SIGKILL");
    }, 5);
    return true;
  }
  /** Write one or more complete NDJSON frames to the wire. */
  send(...envs: Record<string, unknown>[]): void {
    for (const e of envs) this.stdout.write(JSON.stringify(e) + "\n");
  }
  finishWire(code = 0): void {
    this.emit("exit", code, null);
    this.stdout.end();
    this.stdin.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

const HS = (requestId: string) => ({
  v: 1,
  type: "response",
  requestId,
  result: { fixture: "synthetic-stdio", protocolVersion: 1, pid: 777 },
});

function scriptedProvider(child: ScriptedChild, limits = {}): SyntheticStdioProvider {
  return new SyntheticStdioProvider({
    // Scripted children die instantly on kill — keep grace windows short.
    limits: {
      transport: { shutdownGraceMs: 20, killObserveMs: 20 } as never,
      ...limits,
    },
    makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
    spawnImpl: () => child as never,
  });
}

/**
 * Drive a connection far enough that the stream request is admitted:
 * answers handshake + stream as the provider writes them.
 */
async function admitTurn(child: ScriptedChild): Promise<string> {
  let streamRequestId: string | null = null;
  let acc = "";
  child.stdin.on("data", (d: Buffer) => {
    acc += d.toString();
    let i;
    while ((i = acc.indexOf("\n")) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      let env;
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      if (env.method === "handshake") child.send(HS(env.requestId));
      if (env.method === "stream") {
        streamRequestId = env.requestId;
        child.send({
          v: 1,
          type: "response",
          requestId: env.requestId,
          result: { accepted: true, turnId: env.params?.turnId },
        });
      }
    }
  });
  const deadline = Date.now() + 4000;
  while (!streamRequestId && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  if (!streamRequestId) throw new Error("stream was not admitted");
  await new Promise((r) => setTimeout(r, 30)); // let the ack land
  return streamRequestId!;
}

describe("SyntheticStdioProvider lifecycle", () => {
  it("a chat turn runs handshake → stream → chunks → done → confirmed close", async () => {
    const p = providerFor("chat");
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    p.start(ctx("hello", ws), cb);
    await waitFor(() => c.done);
    expect(c.chunks.join("")).toContain("controlled local child process");
    expect(c.errors).toHaveLength(0);
    const res = await p.dispose();
    // A delivered-close connection is released — the real proof is that the
    // spawned child DID close and the adapter tracked it.
    expect(res.children.every((x) => x.confirmed)).toBe(true);
    expect(p.stats.spawnedChildren).toBe(1);
    await waitFor(() => p.connectionCount() === 0);
  });

  it("start throws WORKSPACE_NOT_CONFIGURED without a grant", () => {
    const p = providerFor("chat");
    const { cb } = cbCollect();
    expect(() => p.start(ctx("hi"), cb)).toThrowError(SyntheticProviderError);
    expect(() => p.start(ctx("hi"), cb)).toThrowError(/WORKSPACE_NOT_CONFIGURED/);
  });

  it("capacity limit refuses an extra concurrent child", async () => {
    const p = providerFor("hang", { maxChildren: 1 });
    const { cb } = cbCollect();
    const ws = tmpWorkspace();
    p.start(ctx("one", ws), cb);
    await waitFor(() => p.activeChildren >= 1);
    expect(() => p.start(ctx("two", ws), cb)).toThrowError(/SYNTHETIC_CAPACITY/);
    await p.dispose();
  });

  it("approval offers exactly once/deny — never session or always", async () => {
    const p = providerFor("chat");
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    const handle = p.start(ctx("[syn:approval] please", ws), cb);
    await waitFor(() => c.approvals.length === 1);
    const approval = c.approvals[0]!;
    expect(approval.options.map((o) => o.id).sort()).toEqual(["deny", "once"]);
    expect(approval.options.every((o) => o.scope === "once" || o.scope === "none")).toBe(true);
    handle.resume(true);
    await waitFor(() => c.done);
    const res = await p.dispose();
    expect(res.children.every((x) => x.confirmed)).toBe(true);
  });

  it("cancel ends the turn and the child exits — no callbacks afterwards", async () => {
    const p = providerFor("chat");
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    const handle = p.start(ctx("[syn:approval] blocked", ws), cb);
    await waitFor(() => c.approvals.length === 1);
    handle.cancel();
    const res = await p.dispose();
    expect(res.children.every((x) => x.confirmed)).toBe(true);
    expect(c.done).toBe(false);
  });

  it("[syn:fail] surfaces a synthetic error event", async () => {
    const p = providerFor("chat");
    const { cb, c } = cbCollect();
    p.start(ctx("[syn:fail]", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("synthetic failure");
    await p.dispose();
  });

  it("earlyexit → PREMATURE_EXIT turn error", async () => {
    const p = providerFor("earlyexit");
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length > 0);
    expect(c.errors[0]).toContain("PREMATURE_EXIT");
    await p.dispose();
  });

  it("badframe → protocol error turn failure", async () => {
    const p = providerFor("badframe");
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length > 0);
    expect(c.errors[0]).toMatch(/protocol|JSON/i);
    await p.dispose();
  });

  it("stderr flood is killed by the budget, not silently ignored", async () => {
    const p = providerFor("stderr");
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length > 0, 15000);
    await p.dispose();
  });

  it("a hung child is cancelled and its close is still confirmed", async () => {
    const p = providerFor("hang");
    const { cb } = cbCollect();
    const handle = p.start(ctx("hang me", tmpWorkspace()), cb);
    await waitFor(() => p.activeChildren >= 1);
    handle.cancel();
    const res = await p.dispose();
    expect(res.children.every((x) => x.confirmed)).toBe(true);
  });

  it("dispose is idempotent and never throws", async () => {
    const p = providerFor("chat");
    const { cb } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const [a, b] = await Promise.all([p.dispose(), p.dispose()]);
    expect(a.children.length).toBe(b.children.length);
    const again = await p.dispose();
    expect(again.children.every((x) => x.confirmed)).toBe(true);
  });

  it("start after dispose is refused", async () => {
    const p = providerFor("chat");
    await p.dispose();
    const { cb } = cbCollect();
    expect(() => p.start(ctx("hi", tmpWorkspace()), cb)).toThrowError(/disposed/);
  });

  it("handshake timeout kills the child and errors the turn", async () => {
    // A fake spawn that never writes anything → handshake deadline fires.
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    class MuteChild extends EventEmitter {
      stdin = new PassThrough();
      stdout = new PassThrough();
      stderr = new PassThrough();
      pid = 999;
      killed: string[] = [];
      kill(s?: string) {
        this.killed.push(s ?? "SIGTERM");
        setTimeout(() => {
          this.emit("exit", null, "SIGKILL");
          this.emit("close", null, "SIGKILL");
        }, 5);
        return true;
      }
    }
    const child = new MuteChild();
    const p = new SyntheticStdioProvider({
      limits: { handshakeMs: 80, transport: { shutdownGraceMs: 30, killObserveMs: 30 } as never },
      makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
      spawnImpl: () => child as never,
    });
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length > 0);
    expect(c.errors[0]).toContain("HANDSHAKE_TIMEOUT");
    await p.dispose();
  });
});

describe("R1-02 — exit is bookkeeping, delivered close decides", () => {
  it("exit then late stdout frames then close → done delivered, NO premature error", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const streamRequestId = await admitTurn(child);
    // exit lands BEFORE the done frame reaches the parent — the old code
    // reported PREMATURE_EXIT at exit; only close may judge.
    child.emit("exit", 0, null);
    child.send(
      { v: 1, type: "event", requestId: streamRequestId, turnId: "turn-1", seq: 1, event: "chunk", payload: { delta: "tail" } },
      { v: 1, type: "event", requestId: streamRequestId, turnId: "turn-1", seq: 2, event: "done", payload: {} },
    );
    child.stdout.end();
    child.emit("close", 0, null);
    await waitFor(() => c.done);
    expect(c.errors).toHaveLength(0);
    expect(c.chunks.join("")).toContain("tail");
    await p.dispose();
    expect(p.connectionCount()).toBe(0);
  });

  it("zero exit code with no terminal event still reports PREMATURE_EXIT at close", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await admitTurn(child);
    child.finishWire(0); // clean exit AND close — but no done event ever came
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("PREMATURE_EXIT");
    expect(c.done).toBe(false);
    await p.dispose();
  });
});

describe("R1-03 — payload schema + state on the current association", () => {
  const base = { v: 1, type: "event", requestId: "", turnId: "turn-1", seq: 0 };

  it("delta:number then done → ONE protocol error, zero success terminal", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const srid = await admitTurn(child);
    child.send(
      { ...base, requestId: srid, seq: 1, event: "chunk", payload: { delta: 42 } },
      { ...base, requestId: srid, seq: 2, event: "done", payload: {} },
    );
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toMatch(/malformed chunk event/);
    await waitFor(() => child.killed.length > 0, 3000); // fail-closed
    await new Promise((r) => setTimeout(r, 50));
    expect(c.done).toBe(false); // the later done cannot resurrect the turn
    await p.dispose();
  });

  it("each malformed kind fails exactly once: chunk/approval/done/error/state", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["chunk", { delta: 1 }],
      ["chunk", {}], // missing delta
      ["approval", { approval: { title: 5, options: [] } }],
      ["approval", { approval: { title: "x", options: "no" } }],
      ["done", { outcome: 7 }],
      ["error", { message: [] }],
    ];
    for (const [event, payload] of cases) {
      const child = new ScriptedChild();
      const p = scriptedProvider(child);
      const { cb, c } = cbCollect();
      p.start(ctx("hi", tmpWorkspace()), cb);
      const srid = await admitTurn(child);
      child.send({ ...base, requestId: srid, seq: 1, event, payload });
      await waitFor(() => c.errors.length === 1);
      expect(c.errors[0]).toMatch(new RegExp(`malformed ${event}`));
      expect(c.done).toBe(false);
      await p.dispose();
    }
  }, 20000);

  it("an event while awaiting-approval is a protocol error, not a drop", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const srid = await admitTurn(child);
    child.send({
      ...base,
      requestId: srid,
      seq: 1,
      event: "approval",
      payload: { approval: { title: "T", options: [{ id: "once" }] } },
    });
    await waitFor(() => c.approvals.length === 1);
    // A second approval while awaiting resolution → state violation.
    child.send({
      ...base,
      requestId: srid,
      seq: 2,
      event: "approval",
      payload: { approval: { title: "T2", options: [{ id: "once" }] } },
    });
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toMatch(/awaiting approval/);
    expect(c.approvals).toHaveLength(1); // not re-delivered
    await p.dispose();
  });

  it("late/foreign/duplicate frames are bounded drops — valid current frames still land", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const srid = await admitTurn(child);
    child.send(
      { ...base, requestId: "WRONG", seq: 1, event: "chunk", payload: { delta: "x" } }, // foreign requestId
      { ...base, requestId: srid, turnId: "other", seq: 1, event: "chunk", payload: { delta: "x" } }, // foreign turnId
      { ...base, requestId: srid, seq: 1, event: "chunk", payload: { delta: "one" } }, // seq 1 ok
      { ...base, requestId: srid, seq: 1, event: "chunk", payload: { delta: "dup" } }, // duplicate seq
      { ...base, requestId: srid, seq: 0, event: "chunk", payload: { delta: "back" } }, // regressed seq
      { ...base, requestId: srid, seq: 2, event: "chunk", payload: { delta: "two" } },
      { ...base, requestId: "ghost", type: "response", result: {} }, // unknown response id
      { ...base, requestId: srid, seq: 3, event: "done", payload: {} },
    );
    await waitFor(() => c.done);
    expect(c.chunks).toEqual(["one", "two"]);
    expect(c.errors).toHaveLength(0);
    await waitFor(() => p.connectionCount() === 0);
    expect(p.stats.droppedLateFrames).toBe(5); // 2 foreign + dup + regressed + ghost response
    await p.dispose();
  });
});

describe("R1-03 — correlation", () => {
  it("out-of-order responses on ONE connection land on their own waiters", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb } = cbCollect();
    const conn = new Connection(
      p,
      ctx("hi", tmpWorkspace()),
      cb,
      defaultSyntheticLimits(),
      { executable: "/x", args: [], cwd: "/", env: {} },
      () => child as never,
    );
    conn.transport.start();
    const reqs: Array<{ requestId: string; method: string }> = [];
    let acc = "";
    child.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        reqs.push(JSON.parse(acc.slice(0, i)));
        acc = acc.slice(i + 1);
      }
    });
    const r1 = conn.request("m1", {});
    const r2 = conn.request("m2", {});
    await waitFor(() => reqs.length === 2);
    const [reqA, reqB] = [reqs[0]!, reqs[1]!];
    // Answer the SECOND request first — each waiter must still get its own.
    child.send({ v: 1, type: "response", requestId: reqB.requestId, result: { who: "second" } });
    child.send({ v: 1, type: "response", requestId: reqA.requestId, result: { who: "first" } });
    const [a, b] = await Promise.all([r1, r2]);
    expect((a.result as Record<string, unknown>).who).toBe("first");
    expect((b.result as Record<string, unknown>).who).toBe("second");
    // A duplicate response for a settled id is a bounded drop, not a crash.
    child.send({ v: 1, type: "response", requestId: reqA.requestId, result: { who: "dup" } });
    await waitFor(() => p.stats.droppedLateFrames === 1);
    await p.dispose();
  });

  it("two interleaved turns keep their own events — cross frames drop", async () => {
    const p = scriptedProvider(new ScriptedChild());
    const childA = new ScriptedChild();
    const childB = new ScriptedChild();
    const { cb: cbA, c: cA } = cbCollect();
    const { cb: cbB, c: cB } = cbCollect();
    const limits = defaultSyntheticLimits();
    const spec = { executable: "/x", args: [], cwd: "/", env: {} };
    const connA = new Connection(
      p,
      { prompt: "a", threadId: "tA", turnId: "turnA", workspace: { projectId: "p", directory: tmpWorkspace() } },
      cbA,
      limits,
      spec,
      () => childA as never,
    );
    const connB = new Connection(
      p,
      { prompt: "b", threadId: "tB", turnId: "turnB", workspace: { projectId: "p", directory: tmpWorkspace() } },
      cbB,
      limits,
      spec,
      () => childB as never,
    );
    void connA.run();
    void connB.run();
    const [srA, srB] = await Promise.all([admitTurn(childA), admitTurn(childB)]);
    // Cross-wire contamination: childB emits an event with turnA's id.
    childB.send({
      v: 1, type: "event", requestId: srB, turnId: "turnA", seq: 1,
      event: "chunk", payload: { delta: "CONTAMINANT" },
    });
    childA.send(
      { v: 1, type: "event", requestId: srA, turnId: "turnA", seq: 1, event: "chunk", payload: { delta: "A1" } },
      { v: 1, type: "event", requestId: srA, turnId: "turnA", seq: 2, event: "done", payload: {} },
    );
    childB.send(
      { v: 1, type: "event", requestId: srB, turnId: "turnB", seq: 2, event: "chunk", payload: { delta: "B1" } },
      { v: 1, type: "event", requestId: srB, turnId: "turnB", seq: 3, event: "done", payload: {} },
    );
    await waitFor(() => cA.done && cB.done);
    expect(cA.chunks).toEqual(["A1"]);
    expect(cB.chunks).toEqual(["B1"]); // contaminant dropped, never delivered
    await p.dispose();
  });
});

describe("R1-04 — absolute stream deadline + finite fixture", () => {
  it("requestMs=40: admitted-but-silent stream times out before 150ms", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child, { requestMs: 40 });
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await admitTurn(child); // admitted — then silence forever
    const t0 = Date.now();
    await waitFor(() => c.errors.length === 1, 3000);
    expect(Date.now() - t0).toBeLessThan(150);
    expect(c.errors[0]).toMatch(/deadline|timed out/i);
    await p.dispose();
  });

  it("chunks do NOT re-arm the deadline — steady traffic still times out", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child, { requestMs: 60 });
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const srid = await admitTurn(child);
    // Trickle chunks every ~15ms — under a naive per-event timer this
    // would run forever; the absolute deadline must still fire.
    for (let seq = 1; seq <= 20 && c.errors.length === 0; seq++) {
      child.send({ v: 1, type: "event", requestId: srid, turnId: "turn-1", seq, event: "chunk", payload: { delta: "x" } });
      await new Promise((r) => setTimeout(r, 15));
    }
    await waitFor(() => c.errors.length === 1, 3000);
    expect(c.errors[0]).toMatch(/deadline|timed out/i);
    await p.dispose();
  });

  it("the hang fixture exits inside its own watchdog even with no parent action", async () => {
    // Spawn the fixture directly: no stdin writes, no dispose — the
    // process must still die by its own finite bound.
    const { spawn } = await import("node:child_process");
    const child = spawn(NODE, [FIXTURE, "--scenario=hang", "--watchdog-ms=300"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const t0 = Date.now();
    const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("R1-06 — connection release, callback timing, drop stats", () => {
  it("confirmed close releases the connection; the set returns to baseline", async () => {
    const p = providerFor("chat");
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    expect(p.connectionCount()).toBe(0);
    p.start(ctx("one", ws), cb);
    await waitFor(() => c.done);
    await waitFor(() => p.connectionCount() === 0); // released after delivered close
    p.start(ctx("two", ws), cb);
    await waitFor(() => c.chunks.length >= 4);
    await waitFor(() => p.connectionCount() === 0);
    await p.dispose();
  });

  it("a synchronous transport rejection still fires callbacks AFTER start() returns", async () => {
    const p = new SyntheticStdioProvider({
      makeSpec: (dir) => ({ executable: "C:\\tool\\thing.bat", args: [], cwd: dir, env: {} }),
    });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("hi", tmpWorkspace()), cb);
    // The handle exists BEFORE any error callback could have fired.
    expect(typeof handle.cancel).toBe("function");
    expect(c.errors).toHaveLength(0); // not yet — must not be synchronous
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toMatch(/script|bat/i);
    await p.dispose();
  });

  it("droppedLateFrames aggregates across released connections", async () => {
    const child1 = new ScriptedChild();
    const p = scriptedProvider(child1);
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const srid = await admitTurn(child1);
    child1.send(
      { v: 1, type: "event", requestId: srid, turnId: "turn-1", seq: 1, event: "done", payload: {} },
      { v: 1, type: "event", requestId: srid, turnId: "turn-1", seq: 2, event: "chunk", payload: { delta: "late" } },
    );
    child1.finishWire(0);
    await waitFor(() => c.done);
    await waitFor(() => p.connectionCount() === 0);
    // The post-terminal frame was a legal-shape late drop — counted once,
    // still visible after the connection was released.
    expect(p.stats.droppedLateFrames).toBe(1);
    await p.dispose();
  });
});

/**
 * Answer handshake correctly and the stream request with a caller-chosen
 * result; `then` fires right after the stream response is written so a
 * follow-up frame can share the very same stdout chunk.
 */
function driveAckProbe(
  child: ScriptedChild,
  streamResult: unknown,
  then?: (srid: string, turnId: string) => void,
): void {
  let acc = "";
  child.stdin.on("data", (d: Buffer) => {
    acc += d.toString();
    let i;
    while ((i = acc.indexOf("\n")) >= 0) {
      const env = JSON.parse(acc.slice(0, i));
      acc = acc.slice(i + 1);
      if (env.method === "handshake") child.send(HS(env.requestId));
      if (env.method === "stream") {
        child.send({ v: 1, type: "response", requestId: env.requestId, result: streamResult });
        then?.(env.requestId, env.params?.turnId);
      }
    }
  });
}

describe("lead integration — reservations and response ordering", () => {
  it("reserves capacity before deferred spawn and releases a cancelled reservation", async () => {
    const children: ScriptedChild[] = [];
    const p = new SyntheticStdioProvider({
      limits: { maxChildren: 2, transport: { shutdownGraceMs: 10, killObserveMs: 10 } as never },
      makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
      spawnImpl: () => {
        const child = new ScriptedChild();
        children.push(child);
        return child as never;
      },
    });
    const { cb } = cbCollect();
    const context = ctx("capacity", tmpWorkspace());
    try {
      const first = p.start(context, cb);
      p.start({ ...context, turnId: "second" }, cb);
      expect(p.activeChildren).toBe(0);
      expect(() => p.start({ ...context, turnId: "overflow" }, cb)).toThrowError(/CAPACITY/);
      first.cancel();
      p.start({ ...context, turnId: "replacement" }, cb);
      await Promise.resolve();
      expect(children).toHaveLength(2);
      expect(p.activeChildren).toBe(2);
    } finally {
      await p.dispose();
    }
  });

  it.each(["stream-error", "stream-no-ack", "resolve-error", "resolve-no-ack"])(
    "%s cannot be overtaken by same-chunk done",
    async (mode) => {
      const child = new ScriptedChild();
      const p = scriptedProvider(child);
      const { cb, c } = cbCollect();
      let streamId = "";
      let acc = "";
      const terminalBatch = (requestId: string, seq: number) => {
        const frames: Record<string, unknown>[] = [];
        if (mode.endsWith("error")) frames.push({
          v: 1, type: "response", requestId,
          error: { code: "REJECTED", message: "scripted refusal" },
        });
        frames.push({ v: 1, type: "event", requestId: streamId,
          turnId: "turn-1", seq, event: "done", payload: {} });
        child.stdout.write(frames.map((f) => JSON.stringify(f) + "\n").join(""));
      };
      child.stdin.on("data", (d: Buffer) => {
        acc += d.toString();
        let i;
        while ((i = acc.indexOf("\n")) >= 0) {
          const env = JSON.parse(acc.slice(0, i));
          acc = acc.slice(i + 1);
          if (env.method === "handshake") child.send(HS(env.requestId));
          if (env.method === "stream") {
            streamId = env.requestId;
            if (mode.startsWith("stream")) terminalBatch(env.requestId, 1);
            else child.send(
              { v: 1, type: "response", requestId: streamId, result: { accepted: true, turnId: "turn-1" } },
              { v: 1, type: "event", requestId: streamId, turnId: "turn-1", seq: 1,
                event: "approval", payload: { approval: { title: "step", options: [{ id: "once" }] } } },
            );
          }
          if (env.method === "resolve") terminalBatch(env.requestId, 2);
        }
      });
      try {
        const handle = p.start(ctx("ordering", tmpWorkspace()), cb);
        await waitFor(() => mode.startsWith("resolve") ? c.approvals.length === 1 : c.done || c.errors.length > 0);
        if (mode.startsWith("resolve")) {
          handle.resume(true);
          await waitFor(() => c.done || c.errors.length > 0);
        }
        expect(c.done).toBe(false);
        expect(c.errors).toHaveLength(1);
        expect(c.chunks).toHaveLength(0);
      } finally {
        await p.dispose();
      }
    },
  );
});

describe("R2-01 — refused/never-created children release capacity", () => {
  it("rejected executables spawn nothing, hold nothing, and a valid turn still runs", async () => {
    let executable = "/not-executed.cmd";
    let spawned = 0;
    let lastChild: ScriptedChild | null = null;
    const p = new SyntheticStdioProvider({
      limits: { transport: { shutdownGraceMs: 10, killObserveMs: 10 } as never },
      makeSpec: (dir) => ({ executable, args: [], cwd: dir, env: {} }),
      spawnImpl: () => {
        spawned++;
        lastChild = new ScriptedChild();
        return lastChild as never;
      },
    });
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    for (let i = 0; i < 4; i++) {
      p.start({ ...ctx("x", ws), turnId: `u${i}` }, cb);
      await new Promise((r) => setTimeout(r, 2));
    }
    await waitFor(() => c.errors.length === 4);
    expect(c.errors.every((e) => e.includes("not-executed.cmd"))).toBe(true);
    expect(spawned).toBe(0); // spawn() was never even attempted
    await waitFor(() => p.connectionCount() === 0); // released — nothing to wait on
    expect(p.activeChildren).toBe(0);
    expect(p.stats.spawnedChildren).toBe(0);
    expect(p.stats.turnsStarted).toBe(4);
    // Capacity is genuinely free: a valid executable runs a normal turn
    // through the same adapter — including a >maxChildren history.
    executable = "/x";
    const { cb: cb2, c: c2 } = cbCollect();
    p.start({ ...ctx("ok", ws), turnId: "good" }, cb2);
    await waitFor(() => spawned === 1);
    const srid = await admitTurn(lastChild!);
    lastChild!.send({ v: 1, type: "event", requestId: srid, turnId: "good", seq: 1, event: "done", payload: {} });
    await waitFor(() => c2.done);
    expect(c2.errors).toHaveLength(0);
    lastChild!.finishWire(0);
    await waitFor(() => p.connectionCount() === 0);
    const res = await p.dispose();
    expect(res.children).toHaveLength(0);
    expect(res.orphanedPending).toBe(0);
    expect(p.stats.spawnedChildren).toBe(1); // only the real child counted
    expect(p.stats.turnsStarted).toBe(5);
  });

  it("a synchronous spawnImpl throw is confirmed-childless too", async () => {
    const p = new SyntheticStdioProvider({
      makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
      spawnImpl: () => {
        throw new Error("spawn blew up");
      },
    });
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length === 1);
    await waitFor(() => p.connectionCount() === 0);
    expect(p.activeChildren).toBe(0);
    expect(p.stats.spawnedChildren).toBe(0);
    const res = await p.dispose();
    expect(res.children).toHaveLength(0);
  });

  it("a real child that never closes keeps ownership and blocks clean exit", async () => {
    const child = new ScriptedChild();
    child.kill = () => true; // records nothing, NEVER emits exit/close
    const p = new SyntheticStdioProvider({
      limits: { transport: { shutdownGraceMs: 10, killObserveMs: 10 } as never },
      makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
      spawnImpl: () => child as never,
    });
    const { cb } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => p.activeChildren >= 1);
    const res1 = await p.dispose();
    expect(res1.children).toHaveLength(1);
    expect(res1.children[0]!.confirmed).toBe(false);
    expect(res1.children[0]!.problem).toBe("CLEANUP_INCOMPLETE");
    expect(p.connectionCount()).toBe(1); // still owned — not abandoned
    const res2 = await p.dispose(); // retry is consistent
    expect(res2.children[0]!.confirmed).toBe(false);
    expect(p.connectionCount()).toBe(1);
  });
});

describe("R2-02 — cancel/dispose before the deferred run never spawns", () => {
  it("start() then immediate cancel() — zero spawn, zero callbacks, zero leftovers", async () => {
    let spawned = 0;
    const p = new SyntheticStdioProvider({
      makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
      spawnImpl: () => {
        spawned++;
        return new ScriptedChild() as never;
      },
    });
    const { cb, c } = cbCollect();
    const h = p.start(ctx("hi", tmpWorkspace()), cb);
    h.cancel(); // lands before run()'s first await resumes
    await new Promise((r) => setTimeout(r, 40));
    expect(spawned).toBe(0);
    expect(c.errors).toHaveLength(0);
    expect(c.done).toBe(false);
    expect(c.approvals).toHaveLength(0);
    await waitFor(() => p.connectionCount() === 0);
    expect(p.activeChildren).toBe(0);
    const res = await p.dispose();
    expect(res.children).toHaveLength(0);
    expect(res.orphanedPending).toBe(0);
  });

  it("start() then immediate provider.dispose() — zero spawn", async () => {
    let spawned = 0;
    const p = new SyntheticStdioProvider({
      makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
      spawnImpl: () => {
        spawned++;
        return new ScriptedChild() as never;
      },
    });
    const { cb, c } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    const res = await p.dispose();
    await new Promise((r) => setTimeout(r, 40));
    expect(spawned).toBe(0);
    expect(c.errors).toHaveLength(0);
    expect(res.children).toHaveLength(0);
    expect(res.orphanedPending).toBe(0);
    expect(p.connectionCount()).toBe(0);
  });

  it("cancel during the handshake wait sends no stream/resolve and leaves no pending", async () => {
    const child = new ScriptedChild();
    const methods: string[] = [];
    let hsRequestId: string | null = null;
    let acc = "";
    child.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const env = JSON.parse(acc.slice(0, i));
        acc = acc.slice(i + 1);
        methods.push(env.method);
        if (env.method === "handshake") hsRequestId = env.requestId;
      }
    });
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    const h = p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => hsRequestId !== null);
    h.cancel();
    // The handshake answer arrives AFTER the cancel — the dead turn must
    // not proceed to a stream request.
    child.send(HS(hsRequestId!));
    await new Promise((r) => setTimeout(r, 40));
    expect(methods).not.toContain("stream");
    expect(methods).not.toContain("resolve");
    expect(c.errors).toHaveLength(0);
    expect(c.done).toBe(false);
    // The child did exist — the cancel's transport.dispose escalated a
    // kill onto it and the confirmed close released the connection
    // (children may already be empty at dispose() — ownership ended at
    // confirmed close, which is exactly the required behaviour).
    expect(child.killed.length).toBeGreaterThan(0);
    const res = await p.dispose();
    expect(res.children.every((x) => x.confirmed)).toBe(true);
    await waitFor(() => p.connectionCount() === 0);
  });

  it("provider.dispose during the handshake wait sends no stream either", async () => {
    const child = new ScriptedChild();
    const methods: string[] = [];
    let acc = "";
    child.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        methods.push(JSON.parse(acc.slice(0, i)).method);
        acc = acc.slice(i + 1);
      }
    });
    const p = scriptedProvider(child);
    const { cb } = cbCollect();
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => methods.includes("handshake"));
    const res = await p.dispose();
    await new Promise((r) => setTimeout(r, 30));
    expect(methods).not.toContain("stream");
    expect(res.children).toHaveLength(1);
    expect(res.children[0]!.confirmed).toBe(true);
  });
});

describe("R2-04 — invalid business ACKs fail closed synchronously", () => {
  const badAcks: Array<[string, unknown]> = [
    ["accepted:false", { accepted: false, turnId: "turn-1" }],
    ["missing accepted", { turnId: "turn-1" }],
    ["foreign turnId", { accepted: true, turnId: "foreign" }],
    ["missing turnId", { accepted: true }],
    ["non-object result", "ok"],
  ];
  for (const [name, result] of badAcks) {
    it(`stream ACK ${name} fails once — a later done cannot override`, async () => {
      const child = new ScriptedChild();
      const p = scriptedProvider(child);
      const { cb, c } = cbCollect();
      driveAckProbe(child, result, (srid) =>
        // A well-formed done for THIS association right behind the bad ACK.
        child.send({ v: 1, type: "event", requestId: srid, turnId: "turn-1", seq: 1, event: "done", payload: {} }),
      );
      p.start(ctx("hi", tmpWorkspace()), cb);
      await waitFor(() => c.errors.length === 1);
      expect(c.errors[0]).toMatch(/ACK|protocol/i);
      await new Promise((r) => setTimeout(r, 30));
      expect(c.errors).toHaveLength(1); // exactly one failure
      expect(c.done).toBe(false);
      child.finishWire(0);
      await waitFor(() => p.connectionCount() === 0);
      await p.dispose();
    });
  }

  it("an invalid ACK followed by done in the SAME stdout chunk still fails once", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    let acc = "";
    child.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const env = JSON.parse(acc.slice(0, i));
        acc = acc.slice(i + 1);
        if (env.method === "handshake") child.send(HS(env.requestId));
        if (env.method === "stream") {
          // ONE write carrying response+done — the ACK check must run
          // before the batch's next frame is routed.
          child.stdout.write(
            JSON.stringify({ v: 1, type: "response", requestId: env.requestId, result: { accepted: false, turnId: "foreign" } }) +
              "\n" +
              JSON.stringify({ v: 1, type: "event", requestId: env.requestId, turnId: "turn-1", seq: 1, event: "done", payload: {} }) +
              "\n",
          );
        }
      }
    });
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.errors.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.done).toBe(false);
    expect(c.errors).toHaveLength(1);
    child.finishWire(0);
    await waitFor(() => p.connectionCount() === 0);
    await p.dispose();
  });

  it("a VALID ACK + events in the same chunk still completes normally", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    let acc = "";
    child.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const env = JSON.parse(acc.slice(0, i));
        acc = acc.slice(i + 1);
        if (env.method === "handshake") child.send(HS(env.requestId));
        if (env.method === "stream") {
          const srid = env.requestId;
          const t = env.params?.turnId;
          child.stdout.write(
            JSON.stringify({ v: 1, type: "response", requestId: srid, result: { accepted: true, turnId: t } }) +
              "\n" +
              JSON.stringify({ v: 1, type: "event", requestId: srid, turnId: t, seq: 1, event: "chunk", payload: { delta: "x" } }) +
              "\n" +
              JSON.stringify({ v: 1, type: "event", requestId: srid, turnId: t, seq: 2, event: "done", payload: {} }) +
              "\n",
          );
        }
      }
    });
    p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.done);
    expect(c.chunks.join("")).toBe("x");
    expect(c.errors).toHaveLength(0);
    await p.dispose();
  });

  it("an invalid resolve ACK also fails the turn once", async () => {
    const child = new ScriptedChild();
    const p = scriptedProvider(child);
    const { cb, c } = cbCollect();
    let acc = "";
    child.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const env = JSON.parse(acc.slice(0, i));
        acc = acc.slice(i + 1);
        if (env.method === "handshake") child.send(HS(env.requestId));
        if (env.method === "stream") {
          child.send(
            { v: 1, type: "response", requestId: env.requestId, result: { accepted: true, turnId: env.params?.turnId } },
            { v: 1, type: "event", requestId: env.requestId, turnId: env.params?.turnId, seq: 1, event: "approval", payload: { approval: { title: "x", options: [{ id: "once" }, { id: "deny" }] } } },
          );
        }
        if (env.method === "resolve") {
          child.send({ v: 1, type: "response", requestId: env.requestId, result: { resolved: false } });
        }
      }
    });
    const handle = p.start(ctx("hi", tmpWorkspace()), cb);
    await waitFor(() => c.approvals.length === 1);
    handle.resume(true);
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toMatch(/ACK|resolve/i);
    expect(c.done).toBe(false);
    child.finishWire(0);
    await p.dispose();
  });
});
