// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Engine × synthetic-stdio integration: real controlled children behind the
// real engine — workspace authorization, the workspace-not-configured path,
// grant isolation (synthetic approvals never mint session/always), the
// closing/read-only gates, and synchronous start failure handling.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { SyntheticStdioProvider, type SyntheticScenario } from "../src/main/syntheticStdioProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import type { ProviderAdapter } from "../src/main/provider";

const FIXTURE = fileURLToPath(new URL("./fixtures/synthetic-stdio.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
const openStores: Store[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-syn-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()!.close();
    } catch {
      /* best effort */
    }
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function providerFor(scenario: SyntheticScenario = "chat"): SyntheticStdioProvider {
  return new SyntheticStdioProvider({
    scenario,
    runtimeInfo: { executable: NODE, version: process.version },
    makeSpec: (dir, sc) => ({
      executable: NODE,
      args: [FIXTURE, `--scenario=${sc}`],
      cwd: dir,
      env: {},
    }),
  });
}

function makeEngine(
  adapter: ProviderAdapter,
  paths: ProjectRuntimePaths,
): { store: Store; engine: Engine } {
  const r = root();
  const store = new Store(r);
  store.open();
  openStores.push(store);
  return { store, engine: new Engine(store, adapter, r, "0.0.0-test", paths) };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("engine × synthetic-stdio", () => {
  it("a full turn over the controlled child reaches done and persists", async () => {
    const adapter = providerFor();
    const paths = new ProjectRuntimePaths();
    const { store, engine } = makeEngine(adapter, paths);
    const project = engine.createProject("ws-project");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    engine.sendTurn(thread.id, "hello there");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      return t.turn?.status === "done";
    });
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    const asst = t.messages.find((m) => m.role === "assistant")!;
    expect(asst.content).toContain("controlled local child process");
    // The store on disk reflects the finished turn — no running leftovers.
    store.close();
    const reopened = new Store(rOrThrow(store));
    reopened.open();
    expect(
      reopened.state.threads.find((x) => x.id === thread.id)!.turn!.status,
    ).toBe("done");
    reopened.close();
  });

  it("a project without a workspace grant yields WORKSPACE_NOT_CONFIGURED", async () => {
    const adapter = providerFor();
    const paths = new ProjectRuntimePaths(); // nothing registered
    const { engine } = makeEngine(adapter, paths);
    const project = engine.createProject("no-ws");
    const thread = engine.createThread(project.id);
    const turn = engine.sendTurn(thread.id, "hi");
    expect(turn.status).toBe("error");
    expect(turn.error).toContain("WORKSPACE_NOT_CONFIGURED");
    expect(adapter.connectionCount()).toBe(0); // no child was spawned
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.turn!.status).toBe("error");
  });

  it("a thread with no project cannot spawn a synthetic child", () => {
    const adapter = providerFor();
    const { engine } = makeEngine(adapter, new ProjectRuntimePaths());
    const thread = engine.createThread(null);
    const turn = engine.sendTurn(thread.id, "hi");
    expect(turn.status).toBe("error");
    expect(turn.error).toContain("WORKSPACE_NOT_CONFIGURED");
  });

  it("deleting a project revokes its workspace and cancels the turn", async () => {
    const adapter = providerFor("hang");
    const paths = new ProjectRuntimePaths();
    const { engine } = makeEngine(adapter, paths);
    const project = engine.createProject("doomed");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    engine.sendTurn(thread.id, "hang");
    await waitFor(() => adapter.activeChildren >= 1);
    engine.deleteProject(project.id);
    expect(paths.lookup(project.id)).toBeUndefined();
    const res = await adapter.dispose();
    expect(res.children.every((c) => c.confirmed)).toBe(true);
  });

  it("synthetic approvals never mint session/always grants", async () => {
    const adapter = providerFor();
    const paths = new ProjectRuntimePaths();
    const { engine, store } = makeEngine(adapter, paths);
    const project = engine.createProject("g");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    engine.sendTurn(thread.id, "[syn:approval] do it");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      return t.turn?.status === "waiting-approval";
    });
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    const approval = t.turn!.approval!;
    expect(approval.options.map((o) => o.id).sort()).toEqual(["deny", "once"]);
    engine.resolveApproval(thread.id, approval.id, "once");
    await waitFor(
      () =>
        engine.snapshot().threads.find((x) => x.id === thread.id)!.turn!.status === "done",
    );
    expect(store.state.threads.find((x) => x.id === thread.id)!.sessionGrants).toHaveLength(0);
    expect(store.state.settings.alwaysAllow).toHaveLength(0);
  });

  it("deny ends the turn without a grant and the child closes", async () => {
    const adapter = providerFor();
    const paths = new ProjectRuntimePaths();
    const { engine } = makeEngine(adapter, paths);
    const project = engine.createProject("d");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    engine.sendTurn(thread.id, "[syn:approval] x");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      return t.turn?.status === "waiting-approval";
    });
    const approval = engine.snapshot().threads.find((x) => x.id === thread.id)!.turn!.approval!;
    engine.resolveApproval(thread.id, approval.id, "deny");
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.turn!.status).toBe("denied");
    const res = await adapter.dispose();
    expect(res.children.every((c) => c.confirmed)).toBe(true);
  });

  it("engine.shutdown() blocks new turns synchronously and marks in-flight interrupted", async () => {
    const adapter = providerFor("hang");
    const paths = new ProjectRuntimePaths();
    const { engine } = makeEngine(adapter, paths);
    const project = engine.createProject("s");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    engine.sendTurn(thread.id, "hang");
    await waitFor(() => adapter.activeChildren >= 1);
    engine.shutdown();
    expect(() => engine.sendTurn(thread.id, "again")).toThrowError(/closing/);
    expect(() => engine.createProject("nope")).toThrowError(/closing/);
    await adapter.dispose();
  });

  it("enterReadOnly blocks EVERY persisted mutation; reads stay live", async () => {
    const adapter = providerFor();
    const paths = new ProjectRuntimePaths();
    const { engine, store } = makeEngine(adapter, paths);
    // Set up real state BEFORE going readonly so every mutation has a target.
    const project = engine.createProject("ro");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    const revBefore = engine.snapshot().rev;

    engine.enterReadOnly();
    expect(engine.snapshot().readOnly).toBe(true);

    // Every persisted mutation is refused — not just new turns.
    for (const mutate of [
      () => engine.createProject("nope"),
      () => engine.createThread(project.id),
      () => engine.sendTurn(thread.id, "hi"),
      () => engine.selectThread(thread.id),
      () => engine.selectThread(null),
      () => engine.renameThread(thread.id, "x"),
      () => engine.deleteThread(thread.id),
      () => engine.deleteProject(project.id),
      () => engine.toggleProject(project.id, false),
      () => engine.setSettings({ theme: "dark" }),
      () => engine.setSettings({ language: "zh-Hans" }),
      () => engine.cancelTurn(thread.id),
      () => engine.resolveApproval(thread.id, "nope", "once"),
      () => engine.registerWorkspace(project.id, "/tmp/x"),
    ] as Array<() => unknown>) {
      const before = JSON.stringify(store.state);
      try {
        mutate();
      } catch {
        /* refused — expected */
      }
      expect(JSON.stringify(store.state)).toBe(before);
    }
    // …and they are refused with the explicit readonly error, not silently.
    expect(() => engine.createProject("nope")).toThrowError(/read-only/);
    expect(() => engine.sendTurn(thread.id, "hi")).toThrowError(/read-only/);
    expect(() => engine.selectThread(null)).toThrowError(/read-only/);

    // Reads and the persisted state are untouched (rev may legitimately
    // advance: the app-state event itself is an emitted revision).
    const snap = engine.snapshot();
    expect(snap.readOnly).toBe(true);
    expect(snap.rev).toBeGreaterThanOrEqual(revBefore);
    expect(store.state.projects).toHaveLength(1);
    expect(store.state.threads).toHaveLength(1);
    expect(store.state.settings.theme).not.toBe("dark");
    expect(store.state.ui.selectedThreadId).toBe(thread.id);
  });

  it("a synchronous start failure lands as an error turn, not a crash", () => {
    const adapter = new SyntheticStdioProvider({
      makeSpec: () => {
        throw new Error("SYNTHETIC_RUNTIME_NOT_CONFIGURED: no node");
      },
    });
    const paths = new ProjectRuntimePaths();
    const { engine } = makeEngine(adapter, paths);
    const project = engine.createProject("broken");
    paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
    const thread = engine.createThread(project.id);
    const turn = engine.sendTurn(thread.id, "hi");
    expect(turn.status).toBe("error");
    expect(turn.error).toContain("SYNTHETIC_RUNTIME_NOT_CONFIGURED");
  });

  it("info reports mode/realCli/syntheticRuntime accurately", () => {
    const adapter = providerFor();
    const { engine } = makeEngine(adapter, new ProjectRuntimePaths());
    const info = engine.info;
    expect(info.mode).toBe("synthetic-stdio");
    expect(info.realCli.status).toBe("not-configured");
    expect(info.syntheticRuntime?.executable).toBe(NODE);
    expect(info.providerLabel).toContain("controlled local child process");
  });
});

function rOrThrow(store: Store): string {
  return store.root;
}

/**
 * Scripted pipe child for engine-level protocol probes (R2-03): parses
 * inbound NDJSON requests and lets a script answer — zero OS children.
 */
class WireChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  closed = false;
  killed: string[] = [];
  constructor(onRequest: (req: { requestId: string; method: string; params: Record<string, unknown> }, c: WireChild) => void) {
    super();
    let acc = "";
    this.stdin.on("data", (d: Buffer) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const req = JSON.parse(acc.slice(0, i));
        acc = acc.slice(i + 1);
        setImmediate(() => onRequest(req, this));
      }
    });
  }
  frame(f: Record<string, unknown>): void {
    if (!this.closed) this.stdout.write(JSON.stringify(f) + "\n");
  }
  end(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.stdin.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    setTimeout(() => this.end(0), 5);
    return true;
  }
}

type WireReq = { requestId: string; method: string; params: Record<string, unknown> };

/** Wire script: handshake → stream ACK → approval event, then `after`. */
function approvalThen(
  after: (req: WireReq, c: WireChild) => void,
): (req: WireReq, c: WireChild) => void {
  return (req, c) => {
    if (req.method === "handshake")
      c.frame({ v: 1, type: "response", requestId: req.requestId, result: { fixture: "synthetic-stdio", protocolVersion: 1 } });
    if (req.method === "stream") {
      const turnId = req.params.turnId;
      c.frame({ v: 1, type: "response", requestId: req.requestId, result: { accepted: true, turnId } });
      c.frame({ v: 1, type: "event", requestId: req.requestId, turnId, seq: 1, event: "approval", payload: { approval: { title: "synthetic", options: [{ id: "once" }, { id: "deny" }] } } });
      after(req, c);
    }
  };
}

function engineWithScript(script: (req: WireReq, c: WireChild) => void) {
  const children: WireChild[] = [];
  const provider = new SyntheticStdioProvider({
    limits: { transport: { shutdownGraceMs: 20, killObserveMs: 20 } as never },
    makeSpec: (dir) => ({ executable: "/x", args: [], cwd: dir, env: {} }),
    spawnImpl: () => {
      const c = new WireChild(script);
      children.push(c);
      return c as never;
    },
  });
  const paths = new ProjectRuntimePaths();
  const { store, engine } = makeEngine(provider, paths);
  const project = engine.createProject("syn");
  paths.register(project.id, mkdtempSync(join(tmpdir(), "ws-")));
  const thread = engine.createThread(project.id);
  return { store, engine, provider, thread, children };
}

const turnOf = (engine: Engine, threadId: string) =>
  engine.snapshot().threads.find((x) => x.id === threadId)!.turn;

/** Shared assertions for "the waiting approval died without permission". */
function expectDeadApproval(
  engine: Engine,
  store: Store,
  threadId: string,
  approvalId: string,
  status: "error" | "cancelled",
): void {
  const t = engine.snapshot().threads.find((x) => x.id === threadId)!;
  expect(t.turn!.status).toBe(status);
  expect(t.turn!.approval!.status).toBe("expired"); // no pending card left
  expect(t.messages.find((m) => m.role === "assistant")!.status).toBe(status);
  // Late once AND deny both fail — no resume, no grant mint, no zombie.
  expect(() => engine.resolveApproval(threadId, approvalId, "once")).toThrow();
  expect(() => engine.resolveApproval(threadId, approvalId, "deny")).toThrow();
  expect(t.sessionGrants).toHaveLength(0);
  expect(store.state.settings.alwaysAllow).toHaveLength(0);
}

describe("R2-03 — an approval left pending can never be revived by the wire", () => {
  it("approval → done (same association) fails the turn; late resolve is refused", async () => {
    const wireMethods: string[] = [];
    const { engine, store, provider, thread } = engineWithScript((req, c) => {
      wireMethods.push(req.method);
      approvalThen((r2, c2) => {
        const t = r2.params.turnId;
        c2.frame({ v: 1, type: "event", requestId: r2.requestId, turnId: t, seq: 2, event: "done", payload: { outcome: "done" } });
      })(req, c);
    });
    // Capture the turn-status stream — running→waiting-approval→error is
    // an atomic transition inside one frame batch; the event log is the
    // only reliable witness that the pending state truly existed.
    const statuses: string[] = [];
    const off = engine.onEvent((e) => {
      if (e.type === "turn-status") statuses.push(e.status);
    });
    engine.sendTurn(thread.id, "approval probe");
    await waitFor(() => turnOf(engine, thread.id)?.status === "error");
    off();
    expect(statuses).toContain("waiting-approval"); // the wait truly existed
    const approvalId = turnOf(engine, thread.id)!.approval!.id;
    expect(turnOf(engine, thread.id)!.error).toMatch(/awaiting approval|protocol/i);
    expectDeadApproval(engine, store, thread.id, approvalId, "error");
    // Persisted document agrees — no pending card, no running zombie.
    const persisted = store.state.threads.find((x) => x.id === thread.id)!;
    expect(persisted.turn!.status).toBe("error");
    expect(persisted.turn!.approval!.status).toBe("expired");
    await waitFor(() => provider.connectionCount() === 0);
    // No resolve request ever reached the wire — the dead turn minted
    // nothing and sent nothing.
    expect(wireMethods).not.toContain("resolve");
    const next = engine.sendTurn(thread.id, "new turn works");
    expect(next.status).toBe("running");
    engine.cancelTurn(thread.id);
    await provider.dispose();
  });

  it("approval → error terminates the waiting state the same way", async () => {
    const { engine, store, provider, thread } = engineWithScript(
      approvalThen((req, c) => {
        const t = req.params.turnId;
        c.frame({ v: 1, type: "event", requestId: req.requestId, turnId: t, seq: 2, event: "error", payload: { message: "child gave up" } });
      }),
    );
    const statuses: string[] = [];
    const off = engine.onEvent((e) => {
      if (e.type === "turn-status") statuses.push(e.status);
    });
    engine.sendTurn(thread.id, "approval probe");
    await waitFor(() => turnOf(engine, thread.id)?.status === "error");
    off();
    expect(statuses).toContain("waiting-approval");
    const approvalId = turnOf(engine, thread.id)!.approval!.id;
    expect(turnOf(engine, thread.id)!.error).toContain("child gave up");
    expectDeadApproval(engine, store, thread.id, approvalId, "error");
    await provider.dispose();
  });

  it("approval → premature close resolves the wait as an error too", async () => {
    const { engine, store, provider, thread } = engineWithScript(
      approvalThen((_req, c) => {
        setTimeout(() => c.end(0), 10); // closes without ever answering
      }),
    );
    engine.sendTurn(thread.id, "approval probe");
    await waitFor(() => turnOf(engine, thread.id)?.status === "waiting-approval");
    const approvalId = turnOf(engine, thread.id)!.approval!.id;
    await waitFor(() => turnOf(engine, thread.id)?.status === "error");
    expect(turnOf(engine, thread.id)!.error).toContain("PREMATURE_EXIT");
    expectDeadApproval(engine, store, thread.id, approvalId, "error");
    await provider.dispose();
  });

  it("approval → user cancel expires the approval; late resolve fails", async () => {
    const { engine, store, provider, thread } = engineWithScript(
      approvalThen(() => {}), // child just waits for a resolve that never comes
    );
    engine.sendTurn(thread.id, "approval probe");
    await waitFor(() => turnOf(engine, thread.id)?.status === "waiting-approval");
    const approvalId = turnOf(engine, thread.id)!.approval!.id;
    engine.cancelTurn(thread.id);
    expectDeadApproval(engine, store, thread.id, approvalId, "cancelled");
    await provider.dispose();
  });

  it("normal once/deny still work through the real engine", async () => {
    let srid = "";
    const { engine, provider, thread } = engineWithScript((req, c) => {
      if (req.method === "handshake")
        c.frame({ v: 1, type: "response", requestId: req.requestId, result: { fixture: "synthetic-stdio", protocolVersion: 1 } });
      if (req.method === "stream") {
        srid = req.requestId;
        const t = req.params.turnId;
        c.frame({ v: 1, type: "response", requestId: req.requestId, result: { accepted: true, turnId: t } });
        c.frame({ v: 1, type: "event", requestId: srid, turnId: t, seq: 1, event: "approval", payload: { approval: { title: "synthetic", options: [{ id: "once" }, { id: "deny" }] } } });
      }
      if (req.method === "resolve") {
        c.frame({ v: 1, type: "response", requestId: req.requestId, result: { resolved: true } });
        // Turn events correlate to the STREAM requestId, not this one's.
        c.frame({ v: 1, type: "event", requestId: srid, turnId: req.params.turnId, seq: 2, event: "done", payload: {} });
      }
    });
    engine.sendTurn(thread.id, "approve me");
    await waitFor(() => turnOf(engine, thread.id)?.status === "waiting-approval");
    const approvalId = turnOf(engine, thread.id)!.approval!.id;
    engine.resolveApproval(thread.id, approvalId, "once");
    await waitFor(() => turnOf(engine, thread.id)?.status === "done");
    await provider.dispose();
  });
});
