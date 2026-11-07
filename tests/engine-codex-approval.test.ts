// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Cross-layer Codex approval tests: REAL Engine + real CodexAppServerProvider
// over a scripted child. The answer is committed only after the transport's
// write ack — queued-but-unwritten answers keep the approval pending and the
// turn waiting; failed/withdrawn/raced writes expire visibly and can never
// resurrect settled state.

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { Store } from "../src/main/store";
import { Engine, EngineError } from "../src/main/engine";
import type { AppEvent } from "../src/shared/ipc";
import { CodexAppServerProvider, type CodexProviderLimits } from "../src/main/codexAppServerProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import type { CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import type { ApprovalRequest } from "../src/shared/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-engcodexappr-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 25));
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

class ScriptedChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 777;
  killed: string[] = [];
  private buf = "";
  private inbox: Array<Record<string, unknown>> = [];
  private waiters: Array<(m: Record<string, unknown>) => void> = [];
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const w = this.waiters.shift();
        if (w) w(m);
        else this.inbox.push(m);
      }
    });
  }
  next(ms = 5000): Promise<Record<string, unknown>> {
    const have = this.inbox.shift();
    if (have) return Promise.resolve(have);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("scripted next() timeout")), ms);
      this.waiters.push((m) => {
        clearTimeout(timer);
        res(m);
      });
    });
  }
  write(line: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(line) + "\n");
  }
  close(code = 0): void {
    this.emit("exit", code, null);
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    setTimeout(() => this.close(143), 3);
    return true;
  }
}

function cfg(): CodexRuntimeConfig {
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: process.execPath,
    codexHome: "/test-codex-home",
    codexHomeId: "/test-codex-home",
    args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
    env: { CODEX_HOME: "/test-codex-home" },
    treeCapability: { supported: false, platform: "darwin", reason: "test" },
  };
}

const BIND_ID = "cx-thread-1";

interface Rig {
  engine: Engine;
  store: Store;
  child: ScriptedChild;
  provider: CodexAppServerProvider;
  threadId: string;
  events: AppEvent[];
  workspace: string;
}

function rig(children: ScriptedChild[], limits: Partial<CodexProviderLimits> = {}): Rig {
  const root = tmp();
  const wsRoot = tmp();
  const workspace = join(wsRoot, "proj-ws");
  mkdirSync(workspace);
  const store = new Store(root);
  store.open();
  const paths = new ProjectRuntimePaths([wsRoot], join(root, "grants.json"), root);
  const events: AppEvent[] = [];
  let engine!: Engine;
  const provider = new CodexAppServerProvider({
    config: cfg(),
    spawnImpl: () => children.shift() as unknown as ChildProcess,
    lookupBinding: (t) => engine.lookupProviderThread(t),
    bindThread: (t, b) => engine.bindProviderThread(t, b),
    onThreadNotice: (t, text, level) => engine.onThreadNotice(t, text, level),
    limits,
  });
  engine = new Engine(store, provider, root, "0.0.0-test", paths);
  engine.onEvent((e) => events.push(e));
  const project = engine.createProject("proj");
  paths.registerManaged(project.id, workspace);
  const thread = engine.createThread(project.id, "t");
  const child = children[0]!;
  return { engine, store, child, provider, threadId: thread.id, events, workspace };
}

/** Drive initialize → initialized → thread/start. Returns the turn/start request. */
async function handshake(child: ScriptedChild): Promise<Record<string, unknown>> {
  const init = await child.next();
  expect(init.method).toBe("initialize");
  child.write({
    id: init.id as number,
    result: {
      codexHome: "/test-codex-home",
      userAgent: "fixture",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  const initialized = await child.next();
  expect(initialized.method).toBe("initialized");
  const tstart = await child.next();
  expect(tstart.method).toBe("thread/start");
  child.write({ id: tstart.id as number, result: { thread: { id: BIND_ID } } });
  const turnStart = await child.next();
  expect(turnStart.method).toBe("turn/start");
  return turnStart;
}

function approvalEvent(events: AppEvent[]): ApprovalRequest[] {
  return events
    .filter((e) => e.type === "approval-requested")
    .map((e) => (e as { approval: ApprovalRequest }).approval);
}
function turnOf(r: Rig) {
  return r.store.state.threads.find((t) => t.id === r.threadId)!.turn!;
}
function sendApproval(
  child: ScriptedChild,
  id: number,
  turnId = "pt-1",
  itemId = `item-${id}`,
): void {
  child.write({
    id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: BIND_ID, turnId, itemId, command: `echo ${id}` },
  });
}

describe("engine × codex approval write-ack", () => {
  it("two queued approvals: write-ack commits the first before the second is presented", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendApproval(r.child, 100);
      sendApproval(r.child, 101);
      await waitFor(() => approvalEvent(r.events).length === 1);
      expect(turnOf(r).status).toBe("waiting-approval");
      const first = approvalEvent(r.events)[0]!;

      // Hold the answer write — engine must NOT resolve yet.
      const orig = r.child.stdin._write;
      let release: (() => void) | undefined;
      r.child.stdin._write = (_c: unknown, _e: unknown, cb: () => void) => {
        release = () => cb();
      };
      r.engine.resolveApproval(r.threadId, first.id, "accept");
      await tick();
      // Still pending + still waiting — the decision is in-flight, not committed.
      expect(turnOf(r).approval!.status).toBe("pending");
      expect(turnOf(r).status).toBe("waiting-approval");
      // Duplicate clicks: same option is a no-op, a different one throws.
      r.engine.resolveApproval(r.threadId, first.id, "accept");
      expect(() => r.engine.resolveApproval(r.threadId, first.id, "decline")).toThrow(EngineError);
      expect(approvalEvent(r.events).length).toBe(1);

      // Release the write — NOW it commits and the next card presents.
      release!();
      await waitFor(() => approvalEvent(r.events).length === 2);
      expect(turnOf(r).approval!.providerKey).not.toBe(first.providerKey);
      const resolved = r.events.filter(
        (e) => e.type === "approval-resolved",
      ) as Array<{ approval: ApprovalRequest }>;
      expect(resolved.at(-1)!.approval.id).toBe(first.id);
      expect(resolved.at(-1)!.approval.status).toBe("resolved");
      r.child.stdin._write = orig;
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);

  it("asynchronous write failure expires the card visibly; the next ticket still presents", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendApproval(r.child, 200);
      sendApproval(r.child, 201);
      await waitFor(() => approvalEvent(r.events).length === 1);
      const first = approvalEvent(r.events)[0]!;

      // Fail the write asynchronously: error the stdin stream mid-flight.
      const orig = r.child.stdin._write;
      r.child.stdin._write = (_c: unknown, _e: unknown, cb: (e?: Error) => void) => {
        setTimeout(() => cb(new Error("EPIPE")), 5);
      };
      r.engine.resolveApproval(r.threadId, first.id, "accept");
      await waitFor(() => approvalEvent(r.events).length === 2);
      // The first approval ended EXPIRED — never "resolved" — with a notice.
      const expired = r.events.filter(
        (e) =>
          e.type === "approval-resolved" &&
          (e as { approval: ApprovalRequest }).approval.id === first.id,
      ) as Array<{ approval: ApprovalRequest }>;
      expect(expired.at(-1)!.approval.status).toBe("expired");
      expect(
        r.events.some(
          (e) => e.type === "thread-updated",
        ),
      ).toBe(true);
      r.child.stdin._write = orig;
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("immediate send refusal expires the card without a wire answer", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendApproval(r.child, 300);
      await waitFor(() => approvalEvent(r.events).length === 1);
      const first = approvalEvent(r.events)[0]!;
      // stdin already ended → send() refuses outright (no write ever queued).
      r.child.stdin.end();
      await tick();
      r.engine.resolveApproval(r.threadId, first.id, "accept");
      await waitFor(
        () =>
          (r.events as Array<{ type: string; approval?: ApprovalRequest }>).some(
            (e) => e.type === "approval-resolved" && e.approval?.id === first.id,
          ),
      );
      const last = (
        r.events.filter(
          (e) =>
            e.type === "approval-resolved" &&
            (e as { approval: ApprovalRequest }).approval.id === first.id,
        ) as Array<{ approval: ApprovalRequest }>
      ).at(-1)!;
      expect(last.approval.status).toBe("expired");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("a server-side withdrawal while the answer is in flight expires once — the late ack cannot resurrect", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendApproval(r.child, 400);
      await waitFor(() => approvalEvent(r.events).length === 1);
      const first = approvalEvent(r.events)[0]!;
      const orig = r.child.stdin._write;
      let release: (() => void) | undefined;
      r.child.stdin._write = (_c: unknown, _e: unknown, cb: () => void) => {
        release = () => cb();
      };
      r.engine.resolveApproval(r.threadId, first.id, "accept");
      await tick();
      // Server resolves the request itself mid-write.
      r.child.write({
        method: "serverRequest/resolved",
        params: { threadId: BIND_ID, requestId: 400 },
      });
      await tick();
      // Expired exactly once; the in-flight decision is gone.
      const settled = r.events.filter(
        (e) =>
          e.type === "approval-resolved" &&
          (e as { approval: ApprovalRequest }).approval.id === first.id,
      );
      expect(settled.length).toBe(1);
      expect((settled[0] as { approval: ApprovalRequest }).approval.status).toBe("expired");
      // Late write completion must not resurrect anything.
      release?.();
      await tick();
      const settled2 = r.events.filter(
        (e) =>
          e.type === "approval-resolved" &&
          (e as { approval: ApprovalRequest }).approval.id === first.id,
      );
      expect(settled2.length).toBe(1);
      r.child.stdin._write = orig;
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);

  it("session decision: acceptForSession writes its payload verbatim, then commits on ack", async () => {
    const r = rig([new ScriptedChild()], { disposeInterruptMs: 80 });
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      // No availableDecisions → frozen default set includes the session grant.
      sendApproval(r.child, 600);
      await waitFor(() => approvalEvent(r.events).length === 1);
      const first = approvalEvent(r.events)[0]!;
      expect(first.options.map((o) => o.id)).toEqual([
        "cancel", "decline", "acceptForSession", "accept",
      ]);
      r.engine.resolveApproval(r.threadId, first.id, "acceptForSession");
      const answer = await r.child.next();
      expect(answer).toEqual({ id: 600, result: { decision: "acceptForSession" } });
      await waitFor(() => turnOf(r).approval!.status === "resolved");
      // The grant is server-side — the local thread never mints a mock-style
      // persisted session grant.
      expect(r.store.state.threads.find((t) => t.id === r.threadId)!.sessionGrants).toEqual([]);
      r.child.write({
        method: "turn/completed",
        params: { threadId: BIND_ID, turn: { id: "pt-1", status: "completed", error: null } },
      });
      await waitFor(() => turnOf(r).status === "done");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("deny via 'cancel' writes the cancel payload and ends the turn denied — never revived", async () => {
    const r = rig([new ScriptedChild()], { disposeInterruptMs: 80 });
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendApproval(r.child, 601);
      await waitFor(() => approvalEvent(r.events).length === 1);
      const first = approvalEvent(r.events)[0]!;
      r.engine.resolveApproval(r.threadId, first.id, "cancel");
      const answer = await r.child.next();
      expect(answer).toEqual({ id: 601, result: { decision: "cancel" } });
      await waitFor(() => turnOf(r).status === "denied");
      // Settled exactly once, resolved to the deny option.
      const settled = r.events.filter(
        (e) =>
          e.type === "approval-resolved" &&
          (e as { approval: ApprovalRequest }).approval.id === first.id,
      ) as Array<{ approval: ApprovalRequest }>;
      expect(settled.at(-1)!.approval.resolvedOptionId).toBe("cancel");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("a terminal turn/completed racing an in-flight write leaves the approval expired", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendApproval(r.child, 500);
      await waitFor(() => approvalEvent(r.events).length === 1);
      const first = approvalEvent(r.events)[0]!;
      let release: (() => void) | undefined;
      const orig = r.child.stdin._write;
      r.child.stdin._write = (_c: unknown, _e: unknown, cb: () => void) => {
        release = () => cb();
      };
      r.engine.resolveApproval(r.threadId, first.id, "accept");
      await tick();
      r.child.write({
        method: "turn/completed",
        params: { threadId: BIND_ID, turn: { id: "pt-1", status: "completed", error: null } },
      });
      await waitFor(() => turnOf(r).status === "done");
      expect(turnOf(r).approval!.status).toBe("expired");
      release?.();
      await tick();
      // nothing resurrected, still exactly one terminal resolution
      expect(turnOf(r).status).toBe("done");
      expect(turnOf(r).approval!.status).toBe("expired");
      r.child.stdin._write = orig;
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);
});

describe("engine × codex question requests", () => {
  function sendQuestion(
    child: ScriptedChild,
    id: number,
    turnId = "pt-1",
    questions: unknown = [
      { id: "q1", header: "H", question: "Pick", options: [{ label: "a" }] },
    ],
  ): void {
    child.write({
      id,
      method: "item/tool/requestUserInput",
      params: { threadId: BIND_ID, turnId, itemId: `item-${id}`, questions },
    });
  }

  it("question presents on the turn; answer commits only after the write ack", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendQuestion(r.child, 300);
      await waitFor(() => turnOf(r).question?.status === "pending");
      const q = turnOf(r).question!;
      expect(q.providerKey).toBe("i:300");
      expect(q.questions[0]!.prompt).toBe("Pick");
      // The turn keeps RUNNING — a question is not an approval gate.
      expect(turnOf(r).status).toBe("running");

      // Hold the write — status stays pending. The chunk is captured in
      // the override: its bytes prove the wire shape without re-reading
      // the stream (the override swallows it by design).
      const orig = r.child.stdin._write;
      let release: (() => void) | undefined;
      let held = "";
      r.child.stdin._write = (chunk: unknown, _e: unknown, cb: () => void) => {
        held += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        release = () => cb();
      };
      r.engine.answerQuestion(r.threadId, q.providerKey, { q1: ["a"] });
      await tick();
      expect(turnOf(r).question!.status).toBe("pending");
      expect(held).toContain('"id":300');
      expect(JSON.parse(held.trim())).toEqual({
        id: 300,
        result: { answers: { q1: { answers: ["a"] } } },
      });
      release!();
      await waitFor(() => turnOf(r).question!.status === "answered");
      r.child.stdin._write = orig;
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);

  it("server-side resolution expires the card — never a user answer", async () => {
    const r = rig([new ScriptedChild()], { disposeInterruptMs: 80 });
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendQuestion(r.child, 301);
      await waitFor(() => turnOf(r).question?.status === "pending");
      const key = turnOf(r).question!.providerKey;
      r.child.write({ method: "serverRequest/resolved", params: { threadId: BIND_ID, requestId: 301 } });
      await waitFor(() => turnOf(r).question!.status === "expired");
      // A late answer against the expired card is an EngineError — it can
      // never reach the wire.
      expect(() => r.engine.answerQuestion(r.threadId, key, { q1: ["a"] })).toThrow(EngineError);
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("stale providerKey / no pending question → EngineError, nothing written", async () => {
    const r = rig([new ScriptedChild()], { disposeInterruptMs: 80 });
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      expect(() => r.engine.answerQuestion(r.threadId, "i:1", { q1: ["a"] })).toThrow(
        /no such pending question/,
      );
      sendQuestion(r.child, 302);
      await waitFor(() => turnOf(r).question?.status === "pending");
      expect(() => r.engine.answerQuestion(r.threadId, "i:999", { q1: ["a"] })).toThrow(
        /does not match/,
      );
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("turn ending with a pending question expires it", async () => {
    const r = rig([new ScriptedChild()], { disposeInterruptMs: 80 });
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      sendQuestion(r.child, 303);
      await waitFor(() => turnOf(r).question?.status === "pending");
      r.child.write({
        method: "turn/completed",
        params: { threadId: BIND_ID, turn: { id: "pt-1", status: "completed", error: null } },
      });
      await waitFor(() => turnOf(r).status === "done");
      expect(turnOf(r).question!.status).toBe("expired");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });
});

describe("F09 engine × codex compact", () => {
  it("/compact sends thread/compact/start and the compacted notice lands standalone", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      r.child.write({
        method: "turn/completed",
        params: { threadId: BIND_ID, turn: { id: "pt-1", status: "completed", error: null } },
      });
      await waitFor(() => turnOf(r).status === "done");

      const pending = r.engine.compactThread(r.threadId);
      const req = await r.child.next();
      expect(req.method).toBe("thread/compact/start");
      r.child.write({ id: req.id as number, result: {} });
      r.child.write({ method: "thread/compacted", params: { threadId: BIND_ID } });
      await pending;
      const thread = r.store.state.threads.find((t) => t.id === r.threadId)!;
      await waitFor(() =>
        thread.messages.some(
          (m) => m.kind === "notice" && m.content === "Context compacted.",
        ),
      );

      const notices = thread.messages.filter((m) => m.kind === "notice");
      const texts = notices.map((m) => m.content);
      expect(texts).toContain("Compacting context.");
      expect(texts).toContain("Context compacted.");
      // Idle-time notices are standalone — never folded into the dead turn.
      for (const n of notices) expect(n.turnId).toBeUndefined();
      expect(notices.find((m) => m.content === "Context compacted.")?.noticeLevel).toBe("info");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("/compact with no bound session is the frozen 'Nothing to compact yet.'", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      await r.engine.compactThread(r.threadId);
      const thread = r.store.state.threads.find((t) => t.id === r.threadId)!;
      const texts = thread.messages
        .filter((m) => m.kind === "notice")
        .map((m) => m.content);
      expect(texts).toEqual(["Compacting context.", "Nothing to compact yet."]);
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });

  it("a busy turn silently ignores /compact (frozen idle guard)", async () => {
    const r = rig([new ScriptedChild()]);
    try {
      r.engine.sendTurn(r.threadId, "go");
      const ts = await handshake(r.child);
      r.child.write({ id: ts.id as number, result: { turn: { id: "pt-1" } } });
      await r.engine.compactThread(r.threadId);
      const thread = r.store.state.threads.find((t) => t.id === r.threadId)!;
      expect(thread.messages.filter((m) => m.kind === "notice")).toHaveLength(0);
      r.child.write({
        method: "turn/completed",
        params: { threadId: BIND_ID, turn: { id: "pt-1", status: "completed", error: null } },
      });
      await waitFor(() => turnOf(r).status === "done");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  });
});
