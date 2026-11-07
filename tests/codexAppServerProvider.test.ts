// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// CodexAppServerProvider against BOTH the real offline fixture child and a
// scripted wire seam: handshake, thread start/resume + binding persistence,
// turn events, approvals (accept/decline/withdrawn/permissions), interrupt,
// unsupported server requests, process death, and teardown accounting.

import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerProvider,
  CodexProviderError,
  type CodexProviderOptions,
  type ProviderThreadBinding,
} from "../src/main/codexAppServerProvider";
import type { CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import type { ProviderCallbacks, TurnContext, WorkspaceGrant } from "../src/main/provider";
import type { ApprovalRequest, CodexQuestionRequest } from "../src/shared/types";
import type { ChildProcess } from "node:child_process";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
function tmpWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-codex-ws-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function cfg(partial: Partial<CodexRuntimeConfig> = {}): CodexRuntimeConfig {
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: NODE,
    codexHome: "/test-codex-home",
    codexHomeId: "/test-codex-home",
    args: ["app-server"],
    env: { CODEX_HOME: "/test-codex-home" },
    treeCapability: { supported: false, platform: "darwin", reason: "test" },
    ...partial,
  };
}

interface Collected {
  chunks: string[];
  approvals: Array<Omit<ApprovalRequest, "id" | "turnId" | "status">>;
  questions: Array<Omit<CodexQuestionRequest, "status">>;
  qAnswered: string[];
  qWithdrawn: string[];
  done: boolean;
  interrupted: boolean;
  errors: string[];
  notices: string[];
  noticeLevels?: string[];
  withdrawn: string[];
  tools: Array<{ itemId: string; status: string; title: string }>;
  /** Whole-composition emissions (onMessageText replace channel). */
  messages: string[];
  message: string;
}
function cbCollect(): { cb: ProviderCallbacks; c: Collected } {
  const c: Collected = {
    chunks: [], approvals: [], done: false, interrupted: false,
    questions: [], qAnswered: [], qWithdrawn: [],
    errors: [], notices: [], withdrawn: [], tools: [], messages: [], message: "",
  };
  return {
    c,
    cb: {
      onChunk: (_s, d) => c.chunks.push(d),
      onMessageText: (_s, text) => {
        c.messages.push(text);
        c.message = text;
      },
      onApproval: (r) => c.approvals.push(r),
      onDone: () => (c.done = true),
      onError: (m) => c.errors.push(m),
      onInterrupted: () => (c.interrupted = true),
      onNotice: (t, l) => { c.notices.push(t); (c.noticeLevels ??= []).push(l ?? "info"); },
      onApprovalWithdrawn: (k) => c.withdrawn.push(k),
      onQuestion: (r) => c.questions.push(r),
      onQuestionAnswered: (k) => c.qAnswered.push(k),
      onQuestionWithdrawn: (k) => c.qWithdrawn.push(k),
      onToolActivity: (a) => c.tools.push({ itemId: a.itemId, status: a.status, title: a.title ?? a.titleKey ?? "" }),
    },
  };
}

function grant(): WorkspaceGrant {
  return { projectId: "p1", directory: tmpWorkspace() };
}
function ctx(prompt: string, ids: Partial<TurnContext> = {}): TurnContext {
  return {
    prompt,
    threadId: "local-1",
    turnId: "local-turn-1",
    workspace: grant(),
    ...ids,
  };
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function provider(partial: Partial<CodexProviderOptions> = {}, config = cfg()) {
  const bindings = new Map<string, ProviderThreadBinding>();
  const bound: ProviderThreadBinding[] = [];
  const p = new CodexAppServerProvider({
    config,
    lookupBinding: (t) => bindings.get(t),
    bindThread: async (t, b) => {
      bindings.set(t, b);
      bound.push(b);
    },
    ...partial,
  });
  return { p, bindings, bound };
}

// ---- scripted wire seam ----------------------------------------------------

class ScriptedChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 888;
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
  /** Next client→server message. */
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

function scripted(children: ScriptedChild[]) {
  let i = 0;
  return { spawnImpl: () => children[i++ % children.length] as unknown as ChildProcess };
}

/** Drive the scripted child through initialize + thread/start. */
async function scriptedHandshake(child: ScriptedChild, opts: { codexHome?: string; threadId?: string } = {}) {
  const init = await child.next();
  expect(init.method).toBe("initialize");
  child.write({
    id: init.id as number,
    result: {
      userAgent: "fixture",
      codexHome: opts.codexHome ?? "/test-codex-home",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  const notif = await child.next();
  expect(notif.method).toBe("initialized");
  const ts = await child.next();
  expect(ts.method).toBe("thread/start");
  child.write({
    id: ts.id as number,
    result: { thread: { id: opts.threadId ?? "cx-thread-1" } },
  });
  const turnStart = await child.next();
  expect(turnStart.method).toBe("turn/start");
  return turnStart;
}

const BIND_ID = "cx-thread-1";

// ---------------------------------------------------------------------------

describe("configuration gates", () => {
  it("unconfigured → CODEX_NOT_CONFIGURED", () => {
    const { p } = provider({}, cfg({ mode: "unconfigured" }));
    const { cb } = cbCollect();
    expect(() => p.start(ctx("hi"), cb)).toThrow(CodexProviderError);
    expect(() => p.start(ctx("hi"), cb)).toThrow(/CODEX_NOT_CONFIGURED/);
  });
  it("real + unsupported tree capability → CODEX_REAL_UNAVAILABLE (fail closed)", () => {
    const { p } = provider(
      {},
      cfg({
        mode: "real",
        executable: "D:\\codex\\codex.exe",
        treeCapability: { supported: false, platform: "darwin", reason: "PROCESS_TREE_UNSUPPORTED: no helper" },
      }),
    );
    const { cb } = cbCollect();
    expect(() => p.start(ctx("hi"), cb)).toThrow(/CODEX_REAL_UNAVAILABLE/);
  });
  it("missing workspace grant → CODEX_WORKSPACE_REQUIRED", () => {
    const { p } = provider();
    const { cb } = cbCollect();
    const noGrant = ctx("hi");
    delete noGrant.workspace;
    expect(() => p.start(noGrant, cb)).toThrow(/CODEX_WORKSPACE_REQUIRED/);
  });
  it("real mode with an unsupported verdict can NEVER fall back to a plain spawn", () => {
    // The spawn impl itself must be a loud refusal — not makeJobHelperSpawnImpl
    // on a null path, and never the payload executable directly.
    const { p } = provider(
      {},
      cfg({
        mode: "real",
        executable: "D:\\codex\\codex.exe",
        treeCapability: { supported: false, platform: "win32", reason: "PROCESS_TREE_UNSUPPORTED: missing" },
      }),
    );
    const impl = p.spawnImplForMode();
    expect(impl).toBeDefined();
    expect(() => impl!({ executable: "D:\\codex\\codex.exe", args: [], cwd: "D:\\", env: {} })).toThrow(
      /PROCESS_TREE_UNSUPPORTED|refusing direct payload spawn/,
    );
  });
  it("real mode + attested capability returns the helper-backed impl", () => {
    const { p } = provider(
      {},
      cfg({
        mode: "real",
        executable: "D:\\codex\\codex.exe",
        treeCapability: {
          supported: true,
          platform: "win32",
          mechanism: "windows-job-object",
          helperPath: "D:\\pkg\\resources\\job-helper\\tivano-job-helper.exe",
          helperVersion: "1.1.0",
        },
      }),
    );
    const impl = p.spawnImplForMode();
    expect(impl).toBeDefined();
    const cp = impl!({ executable: "D:\\codex\\codex.exe", args: ["app-server"], cwd: "D:\\w", env: {} });
    cp.on("error", () => {});
    cp.unref();
    // The spawned child is the HELPER, not the payload.
    expect(cp.spawnargs[0]).toBe("D:\\pkg\\resources\\job-helper\\tivano-job-helper.exe");
    expect(cp.spawnargs[1]).toBe("--serve");
  });
});

describe("fixture end-to-end (real child)", () => {
  it("streams deltas and completes; binding persisted before turn/start", async () => {
    const { p, bindings, bound } = provider();
    const { cb, c } = cbCollect();
    p.start(ctx("hello there"), cb);
    await waitFor(() => c.done);
    expect(c.errors).toEqual([]);
    expect(c.chunks.join("")).toContain("fixture response: hello there");
    expect(bindings.get("local-1")?.codexThreadId).toMatch(/^thread-\d+-\w+-\d+$/);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.providerId).toBe("codex");
    expect(bound[0]!.schemaPin).toBe("0.164.0+6aaac694");
    await p.dispose();
  }, 15000);

  it("second turn on the same thread reuses the session and resumes via binding", async () => {
    const { p } = provider();
    const c1 = cbCollect();
    const firstCtx = ctx("first");
    p.start(firstCtx, c1.cb);
    await waitFor(() => c1.c.done);
    const c2 = cbCollect();
    // Same thread → same session → the SAME workspace must be carried;
    // a different directory is a contract violation, not a new turn.
    p.start(ctx("second", { turnId: "local-turn-2", ...(firstCtx.workspace ? { workspace: firstCtx.workspace } : {}) }), c2.cb);
    await waitFor(() => c2.c.done);
    expect(c2.c.chunks.join("")).toContain("fixture response: second");
    expect(p.sessionCount()).toBe(1);
    await p.dispose();
  }, 20000);

  it("approval accept → decision:accept on the wire, then completion", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("please approval"), cb);
    await waitFor(() => c.approvals.length === 1);
    expect(c.approvals[0]!.kind).toBe("command");
    expect(c.approvals[0]!.title).toBe("echo fixture-command");
    // Frozen decisionOptions: the server's availableDecisions become the
    // card options — deny-class first in the array, ApprovalCard reverses.
    expect(c.approvals[0]!.options.map((o) => o.id)).toEqual([
      "cancel", "decline", "acceptForSession", "accept",
    ]);
    expect(c.approvals[0]!.options.map((o) => o.title)).toEqual([
      "Stop turn", "Decline", "Approve for session", "Approve",
    ]);
    handle.resume(true);
    await waitFor(() => c.done);
    expect(c.errors).toEqual([]);
    await p.dispose();
  }, 15000);

  it("deny → decision:cancel written then interrupt → engine sees no revival", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("approval"), cb);
    await waitFor(() => c.approvals.length === 1);
    handle.cancel(); // engine deny path: cancel, not resume(false)
    await waitFor(() => c.interrupted || c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    await p.dispose();
  }, 15000);

  it("permissions request → {permissions, scope:'turn'} answer", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("need perm"), cb);
    await waitFor(() => c.approvals.length === 1);
    expect(c.approvals[0]!.title).toContain("permissions");
    handle.resume(true);
    await waitFor(() => c.done);
    await p.dispose();
  }, 15000);

  it("server-side resolution expires the card (never a user answer)", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(ctx("approval elsewhere"), cb);
    await waitFor(() => c.approvals.length === 1);
    await waitFor(() => c.withdrawn.length === 1);
    await waitFor(() => c.done);
    await p.dispose();
  }, 15000);

  it("tool activity + output arrives as status, not assistant text", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(ctx("run tool"), cb);
    await waitFor(() => c.done);
    expect(c.tools.some((t) => t.status === "started" && t.title.includes("fixture-tool"))).toBe(true);
    expect(c.tools.some((t) => t.status === "completed")).toBe(true);
    await p.dispose();
  }, 15000);

  it("turn/completed failed → onError with the notification message", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(ctx("fail now"), cb);
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("fixture failure");
    await p.dispose();
  }, 15000);

  it("malformed question payload gets an explicit refusal + a notice", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(ctx("qbad please"), cb);
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.notices.some((n) => n.includes("question request") && n.includes("declined"))).toBe(true);
    // F03 NoticeRow: protocol-level refusals are warning-level notices.
    expect(c.noticeLevels?.[c.notices.findIndex((n) => n.includes("declined"))]).toBe("warning");
    expect(c.questions.length).toBe(0);
    await p.dispose();
  }, 15000);

  it("question → onQuestion card → answers echo back on the wire", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("question please"), cb);
    await waitFor(() => c.questions.length === 1);
    const req = c.questions[0]!;
    expect(req.questions.length).toBe(1);
    expect(req.questions[0]!.choices.length).toBe(2);
    expect(req.questions[0]!.allowsOther).toBe(true);
    handle.answer?.(req.providerKey, { "q-deploy": ["Yes, deploy (recommended)"] });
    await waitFor(() => c.done);
    expect(c.message).toContain("answered: q-deploy=Yes, deploy (recommended)");
    expect(c.qAnswered).toEqual([req.providerKey]);
    await p.dispose();
  }, 15000);

  it("question skip sends an empty answers map", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("question please"), cb);
    await waitFor(() => c.questions.length === 1);
    handle.answer?.(c.questions[0]!.providerKey, {});
    await waitFor(() => c.done);
    expect(c.message).toContain("question skipped");
    await p.dispose();
  }, 15000);

  it("sleep + cancel → turn/interrupt → interrupted terminal", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("sleep"), cb);
    await waitFor(() => c.chunks.length > 0 || p.sessionCount() === 1, 3000).catch(() => {});
    // Wait until the turn is actually bound server-side.
    await waitFor(() => handle !== null);
    await new Promise((r) => setTimeout(r, 300));
    handle.cancel();
    await waitFor(() => c.interrupted || c.errors.length > 0);
    expect(c.interrupted).toBe(true);
    await p.dispose();
  }, 15000);

  it("mid-turn process death → CODEX_CONNECTION_CLOSED with stderr tail", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(ctx("die"), cb);
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("CODEX_CONNECTION_CLOSED");
    await p.dispose();
  }, 15000);
});

describe("scripted wire — protocol precision", () => {
  it("sends exactly the pinned request sequence on a fresh thread", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    p.start(ctx("hi"), cb);
    const turnStart = await scriptedHandshake(child);
    const params = turnStart.params as { threadId: string; input: Array<{ text: string }> };
    expect(params.threadId).toBe(BIND_ID);
    expect(params.input[0]!.text).toBe("hi");
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-9" } } });
    child.write({ method: "turn/started", params: { threadId: BIND_ID, turn: { id: "cx-turn-9" } } });
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-9", status: "completed", error: null } } });
    await waitFor(() => c.done);
    await p.dispose();
  });

  it("approval ticket answers {decision} only after resume, in write order", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-1",
        startedAtMs: 1, command: "ls", cwd: ws,
      },
    });
    await waitFor(() => c.approvals.length === 1);
    handle.resume(true);
    const answer = await child.next();
    expect(answer).toEqual({ id: 42, result: { decision: "accept" } });
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await waitFor(() => c.done);
    await p.dispose();
  });

  it("queued approvals present one at a time; withdrawal mid-queue shows next", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 80 },
    });
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    for (const id of [10, 11]) {
      child.write({
        id,
        method: "item/commandExecution/requestApproval",
        params: { kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: `i-${id}`, startedAtMs: 1, command: `c${id}`, cwd: ws },
      });
    }
    await waitFor(() => c.approvals.length === 1); // only the FIRST is presented
    // Server resolves the presented one → second presents itself.
    child.write({ method: "serverRequest/resolved", params: { threadId: BIND_ID, requestId: 10 } });
    await waitFor(() => c.withdrawn.length === 1 && c.approvals.length === 2);
    expect(c.approvals[1]!.title).toBe("c11");
    await p.dispose();
  });

  it("availableDecisions drive the card; acceptForSession writes its payload verbatim", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 50,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-1",
        startedAtMs: 1, command: "ls", cwd: ws,
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
    await waitFor(() => c.approvals.length === 1);
    expect(c.approvals[0]!.options.map((o) => o.id)).toEqual([
      "cancel", "decline", "acceptForSession", "accept",
    ]);
    handle.resume(true, "acceptForSession");
    const answer = await child.next();
    expect(answer).toEqual({ id: 50, result: { decision: "acceptForSession" } });
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await waitFor(() => c.done);
    await p.dispose();
  });

  it("command amendment option → the execpolicy object is written back verbatim", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    const amend = { acceptWithExecpolicyAmendment: { proposedExecPolicy: { network: false } } };
    child.write({
      id: 51,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-1",
        startedAtMs: 1, command: "ls", cwd: ws,
        availableDecisions: ["accept", amend, "decline", "cancel"],
      },
    });
    await waitFor(() => c.approvals.length === 1);
    const opt = c.approvals[0]!.options.find((o) => o.id === "amend");
    expect(opt?.title).toBe("Always allow");
    expect(opt?.scope).toBe("always");
    handle.resume(true, "amend");
    const answer = await child.next();
    expect(answer).toEqual({ id: 51, result: { decision: amend } });
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await waitFor(() => c.done);
    await p.dispose();
  });

  it("deny via decline() writes the picked deny payload — 'cancel' ⇒ cancel", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 80 },
    });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 52,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-1",
        startedAtMs: 1, command: "ls", cwd: ws,
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
    await waitFor(() => c.approvals.length === 1);
    handle.decline!("cancel");
    const answer = await child.next();
    expect(answer).toEqual({ id: 52, result: { decision: "cancel" } });
    await p.dispose();
  });

  it("permissions: session option writes scope:'session' with the requested grant", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    const requested = {
      network: { enabled: true },
      fileSystem: { read: [ws + "/r"], write: [ws + "/w"] },
    };
    child.write({
      id: 53,
      method: "item/permissions/requestApproval",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-p", environmentId: null,
        startedAtMs: 1, cwd: ws, reason: null, permissions: requested,
      },
    });
    await waitFor(() => c.approvals.length === 1);
    expect(c.approvals[0]!.options.map((o) => o.id)).toEqual(["decline", "session", "turn"]);
    handle.resume(true, "session");
    const answer = await child.next();
    expect(answer).toEqual({ id: 53, result: { permissions: requested, scope: "session" } });
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await waitFor(() => c.done);
    await p.dispose();
  });

  it("permissions: decline writes the EMPTY grant, turn-scoped", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 80 },
    });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 54,
      method: "item/permissions/requestApproval",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-p", environmentId: null,
        startedAtMs: 1, cwd: ws, reason: null,
        permissions: { network: { enabled: true } },
      },
    });
    await waitFor(() => c.approvals.length === 1);
    handle.decline!("decline");
    const answer = await child.next();
    expect(answer).toEqual({ id: 54, result: { permissions: {}, scope: "turn" } });
    await p.dispose();
  });

  it("malformed/oversized availableDecisions fall back to the frozen default set", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 80 },
    });
    const { cb, c } = cbCollect();
    p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 55,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-1",
        startedAtMs: 1, command: "ls", cwd: ws,
        availableDecisions: { not: "an array" },
      },
    });
    await waitFor(() => c.approvals.length === 1);
    expect(c.approvals[0]!.options.map((o) => o.id)).toEqual([
      "cancel", "decline", "acceptForSession", "accept",
    ]);
    await p.dispose();
  });

  it("string server ids answer correctly (typed id correlation)", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 80 },
    });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go"), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: "srv-alpha",
      method: "item/fileChange/requestApproval",
      params: { threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-f", startedAtMs: 1 },
    });
    await waitFor(() => c.approvals.length === 1);
    handle.resume(true);
    const answer = await child.next();
    expect(answer).toEqual({ id: "srv-alpha", result: { decision: "accept" } });
    await p.dispose();
  });

  it("existing binding → thread/resume with verification; mismatch fails", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const existing: ProviderThreadBinding = {
      providerId: "codex",
      codexThreadId: "cx-old",
      cwd: realpathSync(ws),
      codexHomeId: "/test-codex-home",
      schemaPin: "0.164.0+6aaac694",
      cliVersion: "unknown",
      savedAt: 1,
    };
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      lookupBinding: () => existing,
    });
    const { cb, c } = cbCollect();
    p.start(ctx("resume me", { workspace: { projectId: "p1", directory: ws } }), cb);
    const init = await child.next();
    child.write({ id: init.id as number, result: { userAgent: "f", codexHome: "/test-codex-home", platformFamily: "u", platformOs: "o" } });
    await child.next(); // initialized
    const resume = await child.next();
    expect(resume.method).toBe("thread/resume");
    expect((resume.params as { threadId: string }).threadId).toBe("cx-old");
    // Server returns a DIFFERENT thread — must fail, never silently adopt.
    child.write({ id: resume.id as number, result: { thread: { id: "cx-different" } } });
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("CODEX_RESUME_FAILED");
    await p.dispose();
  });

  it("binding for a different CODEX_HOME refuses to resume", async () => {
    const child = new ScriptedChild();
    const foreign: ProviderThreadBinding = {
      providerId: "codex", codexThreadId: "cx-old", cwd: "/w",
      codexHomeId: "/OTHER/home", schemaPin: "0.164.0+6aaac694", cliVersion: "u", savedAt: 1,
    };
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl, lookupBinding: () => foreign });
    const { cb, c } = cbCollect();
    p.start(ctx("x"), cb);
    // The binding check runs after initialize — drive the handshake first.
    const init = await child.next();
    expect(init.method).toBe("initialize");
    child.write({
      id: init.id as number,
      result: { userAgent: "f", codexHome: "/test-codex-home", platformFamily: "u", platformOs: "o" },
    });
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("CODEX_RESUME_FAILED");
    await p.dispose();
  });

  it("unsupported server request → -32601 + notice, not silence", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 80 },
    });
    const { cb, c } = cbCollect();
    p.start(ctx("go"), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({ id: 55, method: "item/tool/requestUserInput", params: { threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q", questions: [] } });
    const refusal = await child.next();
    // An empty questions array is malformed per the pinned shape —
    // declined as invalid params (-32602), never presented to the user.
    expect((refusal.error as { code: number }).code).toBe(-32602);
    expect((refusal.error as { message: string }).message).toContain("question");
    await waitFor(() => c.notices.length >= 1);
    await p.dispose();
  });

  it("question request → validated card → {answers:{qid:{answers:[...]}}} on the wire", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 77,
      method: "item/tool/requestUserInput",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q",
        questions: [
          {
            id: "q1", header: "Deploy", question: "Proceed?",
            options: [
              { label: "Yes (recommended)", description: "Ship it" },
              { label: "No" },
            ],
            isOther: true, isSecret: false,
          },
        ],
      },
    });
    await waitFor(() => c.questions.length === 1);
    const req = c.questions[0]!;
    expect(req.providerKey).toBe("i:77");
    const q = req.questions[0]!;
    expect(q).toMatchObject({ id: "q1", header: "Deploy", prompt: "Proceed?", allowsOther: true, isSecret: false });
    expect(q.choices).toEqual([
      { label: "Yes (recommended)", detail: "Ship it" },
      { label: "No" },
    ]);
    handle.answer?.(req.providerKey, { q1: ["Yes (recommended)", "free text"] });
    const answer = await child.next();
    // Frozen wire shape — nested per-question {answers:[...]} objects.
    expect(answer).toEqual({
      id: 77,
      result: { answers: { q1: { answers: ["Yes (recommended)", "free text"] } } },
    });
    await waitFor(() => c.qAnswered.length === 1);
    expect(c.qAnswered[0]).toBe(req.providerKey);
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await waitFor(() => c.done);
    await p.dispose();
  });

  it("question skip (empty map) writes {answers:{}}", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl, limits: { disposeInterruptMs: 80 } });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go"), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 78, method: "item/tool/requestUserInput",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q",
        questions: [{ id: "q1", question: "Anything?" }],
      },
    });
    await waitFor(() => c.questions.length === 1);
    handle.answer?.(c.questions[0]!.providerKey, {});
    const answer = await child.next();
    expect(answer).toEqual({ id: 78, result: { answers: {} } });
    await waitFor(() => c.qAnswered.length === 1);
    await p.dispose();
  });

  it("answer naming a stale/foreign key or unknown question id never reaches the wire", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl, limits: { disposeInterruptMs: 50 } });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go"), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 79, method: "item/tool/requestUserInput",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q",
        questions: [{ id: "q1", question: "Pick", options: [{ label: "a" }] }],
      },
    });
    await waitFor(() => c.questions.length === 1);
    // Foreign providerKey — silently ignored.
    handle.answer?.("i:999", { q1: ["a"] });
    // Unknown question id — rejected, nothing written.
    handle.answer?.(c.questions[0]!.providerKey, { "q-unknown": ["x"] });
    // Oversized answer — rejected too.
    handle.answer?.(c.questions[0]!.providerKey, { q1: ["y".repeat(5000)] });
    // Correct answer still works afterwards.
    handle.answer?.(c.questions[0]!.providerKey, { q1: ["a"] });
    const answer = await child.next();
    expect(answer).toEqual({ id: 79, result: { answers: { q1: { answers: ["a"] } } } });
    await p.dispose();
  });

  it("server-side resolution of a question expires the card", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl, limits: { disposeInterruptMs: 50 } });
    const { cb, c } = cbCollect();
    p.start(ctx("go"), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 80, method: "item/tool/requestUserInput",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q",
        questions: [{ id: "q1", question: "Pick", options: [{ label: "a" }] }],
      },
    });
    await waitFor(() => c.questions.length === 1);
    child.write({ method: "serverRequest/resolved", params: { threadId: BIND_ID, requestId: 80 } });
    await waitFor(() => c.qWithdrawn.length === 1);
    expect(c.qWithdrawn[0]).toBe("i:80");
    await p.dispose();
  });

  it("oversized/unknown-field question declines the whole request", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl, limits: { disposeInterruptMs: 50 } });
    const { cb, c } = cbCollect();
    p.start(ctx("go"), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 81, method: "item/tool/requestUserInput",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q",
        questions: [
          { id: "q1", question: "ok", options: [{ label: "a" }] },
          { id: "q2", question: "bad", unknownField: true },
        ],
      },
    });
    const refusal = await child.next();
    expect((refusal.error as { code: number }).code).toBe(-32602);
    expect((refusal.error as { message: string }).message).toContain("unknownField");
    expect(c.questions.length).toBe(0);
    await p.dispose();
  });

  it("cancelTurn politely releases a pending question with {answers:{}}", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl, limits: { disposeInterruptMs: 80, interruptTimeoutMs: 200 } });
    const { cb, c } = cbCollect();
    const handle = p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 82, method: "item/tool/requestUserInput",
      params: {
        threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i-q",
        questions: [{ id: "q1", question: "Pick", options: [{ label: "a" }] }],
      },
    });
    await waitFor(() => c.questions.length === 1);
    handle.cancel();
    const release = await child.next();
    expect(release).toEqual({ id: 82, result: { answers: {} } });
    await p.dispose();
  });

  it("dead session + binding → next turn respawns and resumes", async () => {
    const c1 = new ScriptedChild();
    const c2 = new ScriptedChild();
    const children = [c1, c2];
    const ws = tmpWorkspace();
    const existing: ProviderThreadBinding = {
      providerId: "codex", codexThreadId: "cx-old", cwd: realpathSync(ws),
      codexHomeId: "/test-codex-home", schemaPin: "0.164.0+6aaac694", cliVersion: "u", savedAt: 1,
    };
    let spawnCount = 0;
    const { p } = provider({
      spawnImpl: () => (spawnCount++, children[spawnCount - 1] as unknown as ChildProcess),
      lookupBinding: () => existing,
    });
    const a = cbCollect();
    p.start(ctx("first", { workspace: { projectId: "p1", directory: ws } }), a.cb);
    const init = await c1.next();
    c1.write({ id: init.id as number, result: { codexHome: "/test-codex-home", userAgent: "f", platformFamily: "u", platformOs: "o" } });
    await c1.next();
    const resume = await c1.next();
    c1.write({ id: resume.id as number, result: { thread: { id: "cx-old" } } });
    const ts = await c1.next();
    c1.write({ id: ts.id as number, result: { turn: { id: "t-1" } } });
    c1.close(1); // process dies mid-turn
    await waitFor(() => a.c.errors.length === 1);
    // Second turn: session is dead → respawn + resume. Same thread keeps
    // the same workspace — a session never trades directories.
    const b = cbCollect();
    p.start(ctx("second", { turnId: "lt-2", workspace: { projectId: "p1", directory: ws } }), b.cb);
    const init2 = await c2.next();
    c2.write({ id: init2.id as number, result: { codexHome: "/test-codex-home", userAgent: "f", platformFamily: "u", platformOs: "o" } });
    await c2.next();
    const resume2 = await c2.next();
    expect(resume2.method).toBe("thread/resume");
    c2.write({ id: resume2.id as number, result: { thread: { id: "cx-old" } } });
    const ts2 = await c2.next();
    c2.write({ id: ts2.id as number, result: { turn: { id: "t-2" } } });
    c2.write({ method: "turn/completed", params: { threadId: "cx-old", turn: { id: "t-2", status: "completed", error: null } } });
    await waitFor(() => b.c.done);
    expect(spawnCount).toBe(2);
    await p.dispose();
  });

  it("mutating-RPC timeout poisons the connection (no silent retry)", async () => {
    const child = new ScriptedChild(); // never answers initialize
    const { p } = provider(
      { spawnImpl: scripted([child]).spawnImpl, limits: { initializeTimeoutMs: 150 } },
      cfg({}),
    );
    const { cb, c } = cbCollect();
    p.start(ctx("hi"), cb);
    await waitFor(() => c.errors.length === 1);
    expect(c.errors[0]).toContain("CODEX");
    await p.dispose();
  }, 10000);

  it("dispose reports the live child and orphaned server requests", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 66, method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i", startedAtMs: 1, command: "x", cwd: ws },
    });
    await waitFor(() => c.approvals.length === 1);
    const res = await p.dispose();
    expect(res.children.length).toBe(1);
    expect(res.orphanedPending).toBeGreaterThanOrEqual(1);
  }, 10000);
});

describe("lead takeover regressions", () => {
  function leadProvider(child: ScriptedChild) {
    return provider({ ...scripted([child]), limits: { disposeInterruptMs: 10 }, transportLimits: { shutdownGraceMs: 5, killObserveMs: 5 } }).p;
  }
  async function admitted(child: ScriptedChild) {
    const req = await scriptedHandshake(child);
    child.write({ id: req.id, result: { turn: { id: "turn-good", status: "inProgress" } } });
    await new Promise((r) => setTimeout(r, 10));
  }
  it("rejects a same-thread approval for a stale turn", async () => {
    const child = new ScriptedChild(); const p = leadProvider(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("hi"), cb); await admitted(child);
      child.write({ id: "old-approval", method: "item/commandExecution/requestApproval", params: { threadId: BIND_ID, turnId: "old-turn", itemId: "old-item", startedAtMs: 1, environmentId: null, kind: "command", command: "echo stale" } });
      await new Promise((r) => setTimeout(r, 20));
      expect(c.approvals).toHaveLength(0);
    } finally { await p.dispose(); }
  });
  it("a rejected turn/start cannot be overtaken by same-chunk completion", async () => {
    const child = new ScriptedChild(); const p = leadProvider(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("hi"), cb); const req = await scriptedHandshake(child);
      child.stdout.write([
        { id: req.id, error: { code: -32000, message: "turn refused" } },
        { method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "never-admitted", status: "completed" } } },
      ].map((x) => JSON.stringify(x) + "\n").join(""));
      await new Promise((r) => setTimeout(r, 20));
      expect(c.done).toBe(false);
      expect(c.errors).toHaveLength(1);
    } finally { await p.dispose(); }
  });
  it("does not offer approval for unknown or out-of-workspace permissions", async () => {
    const child = new ScriptedChild(); const p = leadProvider(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("hi"), cb); await admitted(child);
      child.write({ id: "unsafe-perm", method: "item/permissions/requestApproval", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "perm-item", startedAtMs: 1, environmentId: null, cwd: "/outside", reason: null, permissions: { fileSystem: { read: null, write: ["/outside/private"], entries: [] }, unknownGrant: { all: true } } } });
      await new Promise((r) => setTimeout(r, 20));
      expect(c.approvals).toHaveLength(0);
    } finally { await p.dispose(); }
  });
  it("duplicate completed agent items do not duplicate visible text", async () => {
    const child = new ScriptedChild(); const p = leadProvider(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("hi"), cb); await admitted(child);
      const item = { method: "item/completed", params: { threadId: BIND_ID, turnId: "turn-good", item: { type: "agentMessage", id: "message-1", text: "one answer" } } };
      child.write(item); child.write(item);
      child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "turn-good", status: "completed" } } });
      await waitFor(() => c.done);
      expect(c.chunks.join("")).toBe("one answer");
    } finally { await p.dispose(); }
  });
  it("fatal protocol failure retains an unconfirmed child for cleanup retry", async () => {
    const child = new ScriptedChild();
    child.kill = () => true;
    const p = leadProvider(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("hi"), cb); await admitted(child);
      child.stdout.write("{invalid-json}\n");
      await waitFor(() => c.errors.length > 0);
      await new Promise((r) => setTimeout(r, 30));
      const first = await p.dispose();
      expect(first.children.some((x) => !x.confirmed)).toBe(true);
      const second = await p.dispose();
      expect(second.children.some((x) => !x.confirmed)).toBe(true);
    } finally { child.close(); await p.dispose(); }
  });
  it("an arbitrary existing file cannot unlock unverified Windows execution", async () => {
    const { writeFileSync } = await import("node:fs");
    const { probeProcessTreeSupport } = await import("../src/main/providerProcessLifecycle");
    const fake = join(tmpWorkspace(), "fake-helper.exe"); writeFileSync(fake, "not a verified helper");
    expect(probeProcessTreeSupport({ platform: "win32", helperPath: fake }).supported).toBe(false);
  });
  it("CODEX_HOME refuses a symlink outside the application data root", async () => {
    const { symlinkSync } = await import("node:fs");
    const { resolveCodexHome } = await import("../src/main/codexRuntimeConfig");
    const root = tmpWorkspace(), outside = tmpWorkspace();
    symlinkSync(outside, join(root, "codex-home"), "dir");
    expect(() => resolveCodexHome(root)).toThrow();
  });
});

describe("R1 correlation, durability and recovery regressions", () => {
  const wsOf = () => {
    const ws = tmpWorkspace();
    return { ws, grant: { projectId: "p1", directory: ws } as WorkspaceGrant };
  };
  const go = (p: CodexAppServerProvider, ws: WorkspaceGrant, cb: ProviderCallbacks, turnId = "local-turn-1") =>
    p.start({ prompt: "hi", threadId: "local-1", turnId, workspace: ws }, cb);
  async function admit(child: ScriptedChild) {
    const req = await scriptedHandshake(child);
    child.write({ id: req.id, result: { turn: { id: "turn-good", status: "inProgress" } } });
    await new Promise((r) => setTimeout(r, 10));
  }
  const provider2 = (child: ScriptedChild, extra: Partial<CodexProviderOptions> = {}) =>
    provider({
      ...scripted([child]),
      limits: { disposeInterruptMs: 10 },
      transportLimits: { shutdownGraceMs: 5, killObserveMs: 5 },
      ...extra,
    });

  it("turn/start response + server request in ONE chunk → card still presented", async () => {
    const child = new ScriptedChild();
    const { ws, grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      const req = await scriptedHandshake(child);
      // Response and the approval request arrive in the SAME decoded batch.
      child.stdout.write(
        JSON.stringify({ id: req.id, result: { turn: { id: "turn-1" } } }) + "\n" +
          JSON.stringify({
            id: 77,
            method: "item/commandExecution/requestApproval",
            params: { kind: "command", threadId: BIND_ID, turnId: "turn-1", itemId: "i", command: "x", cwd: ws },
          }) + "\n",
      );
      await waitFor(() => c.approvals.length === 1);
      expect(c.errors).toEqual([]);
    } finally {
      await p.dispose();
    }
  });

  it("server requests without turnId or itemId are refused, never carded", async () => {
    const child = new ScriptedChild();
    const { grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      await admit(child);
      for (const params of [
        { threadId: BIND_ID, itemId: "i", command: "x" }, // missing turnId
        { threadId: BIND_ID, turnId: "turn-good", command: "x" }, // missing itemId
        { threadId: "foreign", turnId: "turn-good", itemId: "i", command: "x" }, // foreign thread
      ]) {
        child.write({ id: Math.random() * 1e5 | 0, method: "item/commandExecution/requestApproval", params });
      }
      await new Promise((r) => setTimeout(r, 30));
      expect(c.approvals).toHaveLength(0);
    } finally {
      await p.dispose();
    }
  });

  it("duplicate typed request id declines the second request — no second ticket", async () => {
    const child = new ScriptedChild();
    const { ws, grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      await admit(child);
      const mk = (cmd: string) => ({
        id: 55,
        method: "item/commandExecution/requestApproval",
        params: { kind: "command", threadId: BIND_ID, turnId: "turn-good", itemId: "i", command: cmd, cwd: ws },
      });
      child.write(mk("first"));
      await waitFor(() => c.approvals.length === 1);
      child.write(mk("second"));
      const refusal = await child.next();
      expect((refusal.error as { code: number }).code).toBe(-32602);
      await new Promise((r) => setTimeout(r, 20));
      expect(c.approvals).toHaveLength(1);
    } finally {
      await p.dispose();
    }
  });

  it("a failed approval answer surfaces failure — never a silent 'accepted'", async () => {
    const child = new ScriptedChild();
    const { ws, grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      const handle = go(p, grant, cb);
      await admit(child);
      child.write({
        id: 90, method: "item/commandExecution/requestApproval",
        params: { kind: "command", threadId: BIND_ID, turnId: "turn-good", itemId: "i", command: "x", cwd: ws },
      });
      await waitFor(() => c.approvals.length === 1);
      child.stdin.destroy(); // the write can never reach the server
      handle.resume(true);
      // Failure must surface — either as a fatal write error or a visible
      // notice — and the pending card must expire, never linger accepted.
      await waitFor(() => c.errors.length > 0 || c.notices.length > 0 || c.withdrawn.length > 0);
      await new Promise((r) => setTimeout(r, 30));
      expect(c.done).toBe(false);
    } finally {
      await p.dispose();
    }
  });

  it("final text that differs from deltas REPLACES the item (never appends)", async () => {
    const child = new ScriptedChild();
    const { grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      await admit(child);
      child.write({ method: "item/agentMessage/delta", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "m1", delta: "partial" } });
      child.write({ method: "item/completed", params: { threadId: BIND_ID, turnId: "turn-good", item: { type: "agentMessage", id: "m1", text: "completely rewritten" } } });
      await waitFor(() => c.message === "completely rewritten");
      expect(c.message).not.toContain("partial");
    } finally {
      await p.dispose();
    }
  });

  it("final text that extends deltas appends only the suffix difference", async () => {
    const child = new ScriptedChild();
    const { grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      await admit(child);
      child.write({ method: "item/agentMessage/delta", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "m1", delta: "hello" } });
      child.write({ method: "item/completed", params: { threadId: BIND_ID, turnId: "turn-good", item: { type: "agentMessage", id: "m1", text: "hello world" } } });
      await waitFor(() => c.message === "hello world");
      expect((c.message.match(/hello/g) ?? []).length).toBe(1);
    } finally {
      await p.dispose();
    }
  });

  it("interleaved items keep order; a late duplicate delta stays dropped", async () => {
    const child = new ScriptedChild();
    const { grant } = wsOf();
    const { p } = provider2(child);
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      await admit(child);
      child.write({ method: "item/agentMessage/delta", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "a", delta: "A1" } });
      child.write({ method: "item/agentMessage/delta", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "b", delta: "B1" } });
      child.write({ method: "item/completed", params: { threadId: BIND_ID, turnId: "turn-good", item: { type: "agentMessage", id: "b", text: "B1" } } });
      child.write({ method: "item/agentMessage/delta", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "a", delta: "A2" } });
      child.write({ method: "item/agentMessage/delta", params: { threadId: BIND_ID, turnId: "turn-good", itemId: "b", delta: "LATE" } }); // completed item → dropped
      child.write({ method: "item/completed", params: { threadId: BIND_ID, turnId: "turn-good", item: { type: "agentMessage", id: "a", text: "A1A2" } } });
      await waitFor(() => c.message === "A1A2\n\nB1");
      expect(c.message).not.toContain("LATE");
    } finally {
      await p.dispose();
    }
  });

  it("a late close from the OLD transport cannot kill the replacement connection", async () => {
    const c1 = new ScriptedChild();
    const c2 = new ScriptedChild();
    const kids = [c1, c2];
    let i = 0;
    const { p } = provider({
      spawnImpl: () => kids[i++] as unknown as ChildProcess,
      lookupBinding: () => undefined,
      limits: { disposeInterruptMs: 10 },
      transportLimits: { shutdownGraceMs: 5, killObserveMs: 5 },
    });
    const { grant } = wsOf();
    const a = cbCollect();
    try {
      go(p, grant, a.cb);
      const init = await c1.next();
      c1.write({ id: init.id as number, result: { userAgent: "f", codexHome: "/test-codex-home" } });
      await c1.next();
      const ts = await c1.next();
      c1.write({ id: ts.id as number, result: { thread: { id: "cx-t" } } });
      const req = await c1.next(); // turn/start
      c1.write({ id: req.id as number, result: { turn: { id: "t-1" } } });
      // Turn 2 on a second thread: endSession-style respawn is not needed —
      // kill the first transport, then the SAME session respawns lazily.
      c1.close(1);
      await waitFor(() => a.c.errors.length === 1);
      const b = cbCollect();
      go(p, grant, b.cb, "local-turn-2");
      const init2 = await c2.next();
      c2.write({ id: init2.id as number, result: { userAgent: "f", codexHome: "/test-codex-home" } });
      await c2.next();
      const ts2 = await c2.next();
      c2.write({ id: ts2.id as number, result: { thread: { id: "cx-t2" } } });
      const req2 = await c2.next();
      c2.write({ id: req2.id as number, result: { turn: { id: "t-2" } } });
      // A LATE frame on the dead transport must not terminate the new turn.
      c1.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "cx-t", turn: { id: "t-9", status: "completed" } } }) + "\n");
      await new Promise((r) => setTimeout(r, 30));
      expect(b.c.done).toBe(false);
      c2.write({ method: "turn/completed", params: { threadId: "cx-t2", turn: { id: "t-2", status: "completed" } } });
      await waitFor(() => b.c.done);
    } finally {
      await p.dispose();
    }
  });

  it("thread/resume refusal never mints a replacement thread binding", async () => {
    const child = new ScriptedChild();
    const { ws, grant } = wsOf();
    const existing: ProviderThreadBinding = {
      providerId: "codex", codexThreadId: "cx-gone", cwd: realpathSync(ws),
      codexHomeId: "/test-codex-home", schemaPin: "0.164.0+6aaac694", cliVersion: "u", savedAt: 1,
    };
    const { p, bindings } = provider2(child, { lookupBinding: () => existing });
    const { cb, c } = cbCollect();
    try {
      go(p, grant, cb);
      const init = await child.next();
      child.write({ id: init.id as number, result: { userAgent: "f", codexHome: "/test-codex-home" } });
      await child.next();
      const resume = await child.next();
      expect(resume.method).toBe("thread/resume");
      child.write({ id: resume.id as number, error: { code: -32000, message: "thread not found" } });
      await waitFor(() => c.errors.length === 1);
      expect(c.errors[0]).toContain("CODEX_RESUME_FAILED");
      expect(bindings.size).toBe(0); // no substitute thread was created
      expect(c.done).toBe(false);
    } finally {
      await p.dispose();
    }
  });
});


describe("lead R1 acceptance regressions", () => {
  function subject(child: ScriptedChild) {
    return provider({ ...scripted([child]), limits: { disposeInterruptMs: 10, turnStartTimeoutMs: 80 }, transportLimits: { shutdownGraceMs: 5, killObserveMs: 5 } }).p;
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));
  it.each(["error", "missing"])("early turn/started cannot admit a %s start response", async (mode) => {
    const child = new ScriptedChild(); const p = subject(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("go"), cb); const req = await scriptedHandshake(child);
      const frames: Record<string, unknown>[] = [
        { method: "turn/started", params: { threadId: BIND_ID, turn: { id: "early", status: "inProgress" } } },
      ];
      if (mode === "error") frames.push({ id: req.id, error: { code: -32000, message: "refused" } });
      frames.push({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "early", status: "completed" } } });
      child.stdout.write(frames.map((x) => JSON.stringify(x) + "\n").join(""));
      await tick();
      expect(c.done).toBe(false);
    } finally { await p.dispose(); }
  });
  it("does not accept message output missing threadId", async () => {
    const child = new ScriptedChild(); const p = subject(child); const { cb, c } = cbCollect();
    try {
      p.start(ctx("go"), cb); const req = await scriptedHandshake(child);
      child.write({ id: req.id, result: { turn: { id: "current" } } }); await tick();
      child.write({ method: "item/agentMessage/delta", params: { turnId: "current", itemId: "m", delta: "foreign text" } });
      await tick(); expect(c.chunks).toEqual([]);
    } finally { await p.dispose(); }
  });
  it("does not present the next approval until the first write callback succeeds", async () => {
    const child = new ScriptedChild(); const p = subject(child); const { cb, c } = cbCollect();
    let release: (() => void) | undefined;
    const originalWrite = child.stdin._write;
    try {
      const context = ctx("go"); const h = p.start(context, cb);
      const req = await scriptedHandshake(child);
      child.write({ id: req.id, result: { turn: { id: "current" } } }); await tick();
      for (const id of [100, 101]) child.write({ id, method: "item/commandExecution/requestApproval", params: { threadId: BIND_ID, turnId: "current", itemId: "i" + id, command: "echo ok", cwd: context.workspace!.directory } });
      await tick(); expect(c.approvals).toHaveLength(1);
      child.stdin._write = (_chunk, _encoding, callback) => { release = () => callback(); };
      h.resume(true); await tick();
      expect(c.approvals).toHaveLength(1);
      release?.(); await tick(); expect(c.approvals).toHaveLength(2);
    } finally { release?.(); child.stdin._write = originalWrite; await p.dispose(); }
  });
  it("shows every permission entry path or refuses the entire request", async () => {
    const child = new ScriptedChild(); const p = subject(child); const { cb, c } = cbCollect();
    try {
      const context = ctx("go"); p.start(context, cb); const req = await scriptedHandshake(child);
      child.write({ id: req.id, result: { turn: { id: "current" } } }); await tick();
      const paths = [join(context.workspace!.directory, "first-private-file"), join(context.workspace!.directory, "second-private-file")];
      child.write({ id: 88, method: "item/permissions/requestApproval", params: { threadId: BIND_ID, turnId: "current", itemId: "p", cwd: context.workspace!.directory, environmentId: null, startedAtMs: 1, reason: null, permissions: { fileSystem: { entries: paths.map((path) => ({ access: "write", path: { type: "path", path } })) } } } });
      await tick();
      for (const card of c.approvals) for (const path of paths) expect(card.detail).toContain(path);
    } finally { await p.dispose(); }
  });
  it("never restores persisted workspaces after the authorized root is removed", async () => {
    const { ProjectRuntimePaths } = await import("../src/main/projectRuntimePaths");
    const root = tmpWorkspace(), dir = tmpWorkspace(), file = join(root, "grants.json");
    new ProjectRuntimePaths([dir], file).register("p1", dir);
    const restored = new ProjectRuntimePaths([], file);
    restored.restore(new Set(["p1"]));
    expect(restored.lookup("p1")).toBeUndefined();
  });
  it("a failed grant persistence cannot leave an active grant", async () => {
    const { ProjectRuntimePaths } = await import("../src/main/projectRuntimePaths");
    const root = tmpWorkspace();
    const paths = new ProjectRuntimePaths([root], join(root, "missing-parent", "grants.json"));
    expect(() => paths.register("p1", root)).toThrow();
    expect(paths.lookup("p1")).toBeUndefined();
  });
  it("an existing TOML table cannot silently defeat the credential policy", async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const { resolveCodexRuntime } = await import("../src/main/codexRuntimeConfig");
    const root = tmpWorkspace(), home = join(root, "codex-home"); mkdirSync(home);
    const file = join(home, "config.toml"), content = '[profiles.test]\ncli_auth_credentials_store = "file"\n';
    writeFileSync(file, content);
    let runtime: CodexRuntimeConfig | undefined;
    try { runtime = resolveCodexRuntime({}, root); } catch { /* explicit refusal is safe */ }
    expect(readFileSync(file, "utf8")).toBe(content);
    if (runtime) expect(runtime.args.join(" ")).toMatch(/cli_auth_credentials_store.*file/);
  });
  it("turn-scoped approval survives persisted-document validation", async () => {
    const { emptyStore } = await import("../src/main/store");
    const { validateStoreFile } = await import("../src/main/storeDoc");
    const doc = emptyStore();
    doc.threads.push({ id: "thread", projectId: null, title: "thread", createdAt: 1, updatedAt: 1, sessionGrants: [],
      messages: [{ id: "message", role: "assistant", content: "", status: "streaming", ts: 1, turnId: "turn" }],
      turn: { id: "turn", threadId: "thread", status: "waiting-approval", seq: 0, startedAt: 1, assistantMessageId: "message",
        approval: { id: "approval", turnId: "turn", kind: "action", headline: "Permission", title: "Permission", symbol: "shield", status: "pending", options: [{ id: "turn", title: "Allow for this turn", role: "approve", scope: "turn" }] } },
    });
    expect(() => validateStoreFile(doc)).not.toThrow();
  });
});


describe("R2 shutdown + fixture identity", () => {
  it("work resolved during close grace is not counted as orphaned", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 500 },
      transportLimits: { shutdownGraceMs: 500, killObserveMs: 20 },
    });
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 77, method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i", startedAtMs: 1, command: "x", cwd: ws },
    });
    await waitFor(() => c.approvals.length === 1);
    const dp = p.dispose();
    const interrupt = await child.next(); // turn/interrupt
    expect(interrupt.method).toBe("turn/interrupt");
    // The server resolves the ticket while the transport is closing —
    // the delivered frame retires it, so it is NOT an orphan.
    child.write({ id: interrupt.id as number, result: {} });
    child.write({ method: "serverRequest/resolved", params: { threadId: BIND_ID, requestId: 77 } });
    await new Promise((r) => setTimeout(r, 30));
    child.close(0);
    const res = await dp;
    expect(res.children.length).toBe(1);
    expect(res.orphanedPending).toBe(0);
  }, 10000);

  it("an unanswered approval DOES count as orphaned after cleanup", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      limits: { disposeInterruptMs: 60 },
      transportLimits: { shutdownGraceMs: 60, killObserveMs: 20 },
    });
    const { cb, c } = cbCollect();
    const ws = tmpWorkspace();
    p.start(ctx("go", { workspace: { projectId: "p1", directory: ws } }), cb);
    const turnStart = await scriptedHandshake(child);
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({
      id: 77, method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: BIND_ID, turnId: "cx-turn-1", itemId: "i", startedAtMs: 1, command: "x", cwd: ws },
    });
    await waitFor(() => c.approvals.length === 1);
    const dp = p.dispose();
    const interrupt = await child.next(); // consume turn/interrupt
    child.write({ id: interrupt.id as number, result: {} }); // interrupt resolves
    await new Promise((r) => setTimeout(r, 20)); // close lands inside dispose grace
    child.close(0);
    const res = await dp;
    expect(res.children.length).toBe(1);
    expect(res.orphanedPending).toBe(1); // the ticket, and only the ticket
  }, 10000);

  it("two concurrent fixture processes mint distinct threads; a restarted process resumes both", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tivano-codex-home-")));
    roots.push(home);
    const config = cfg({ codexHome: home, codexHomeId: home, env: { CODEX_HOME: home } });
    const mk = () => {
      const bindings = new Map<string, ProviderThreadBinding>();
      const { p } = provider({ lookupBinding: (t) => bindings.get(t), bindThread: async (t, b) => void bindings.set(t, b) }, config);
      return { p, bindings };
    };
    const a = mk();
    const b = mk();
    const ca = cbCollect();
    const cbn = cbCollect();
    const ws = tmpWorkspace();
    a.p.start(ctx("hello from a", { workspace: { projectId: "p1", directory: ws }, threadId: "la" }), ca.cb);
    b.p.start(ctx("hello from b", { workspace: { projectId: "p1", directory: ws }, threadId: "lb" }), cbn.cb);
    await waitFor(() => ca.c.done && cbn.c.done, 20_000);
    const idA = a.bindings.get("la")!.codexThreadId;
    const idB = b.bindings.get("lb")!.codexThreadId;
    expect(idA).not.toBe(idB); // distinct instances, distinct ids

    // Restarted app: brand-new fixture process, same CODEX_HOME — both
    // synthetic threads resume (per-thread state files survive).
    const c = mk();
    c.bindings.set("la", a.bindings.get("la")!);
    c.bindings.set("lb", b.bindings.get("lb")!);
    const cc = cbCollect();
    c.p.start(ctx("resume a", { workspace: { projectId: "p1", directory: ws }, threadId: "la" }), cc.cb);
    await waitFor(() => cc.c.done, 20_000);
    const cd = cbCollect();
    c.p.endSession("la");
    c.p.endSession("lb");
    c.p.start(ctx("resume b", { workspace: { projectId: "p1", directory: ws }, threadId: "lb" }), cd.cb);
    await waitFor(() => cd.c.done, 20_000);
    await a.p.dispose();
    await b.p.dispose();
    await c.p.dispose();
  }, 40000);
});


describe("lead R2 delayed callback isolation", () => {
  it("an old write callback cannot settle a reused request id", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ ...scripted([child]), limits: { disposeInterruptMs: 10 }, transportLimits: { shutdownGraceMs: 5, killObserveMs: 5 } });
    const { cb, c } = cbCollect(); const acks: string[] = [];
    cb.onApprovalAnswerWritten = (key) => acks.push(key);
    const releases: Array<() => void> = []; const original = child.stdin._write;
    try {
      const h = p.start(ctx("go"), cb); const req = await scriptedHandshake(child);
      child.write({ id: req.id, result: { turn: { id: "current" } } });
      await new Promise((r) => setTimeout(r, 20));
      const request = { id: 500, method: "item/commandExecution/requestApproval", params: { threadId: BIND_ID, turnId: "current", itemId: "i", command: "echo hi" } };
      child.write(request); await waitFor(() => c.approvals.length === 1);
      child.stdin._write = (_chunk, _enc, cb) => { releases.push(() => cb()); };
      h.resume(true); await waitFor(() => releases.length === 1);
      child.write({ method: "serverRequest/resolved", params: { threadId: BIND_ID, requestId: 500 } });
      child.write(request); await waitFor(() => c.approvals.length === 2);
      h.resume(true);
      releases[0]!(); await waitFor(() => releases.length === 2);
      expect(acks).toHaveLength(0);
      releases[1]!(); await waitFor(() => acks.length === 1);
    } finally { for (const release of releases) release(); child.stdin._write = original; await p.dispose(); }
  });
});

describe("packaged helper cleanup failure", () => {
  it("retains helper exit-4 failure across disposal retries", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ ...scripted([child]), limits: { disposeInterruptMs: 10 } }, cfg({
      mode: "real", executable: "D:\\codex.exe",
      treeCapability: { supported: true, platform: "win32", mechanism: "windows-job-object", helperPath: "D:\\helper.exe" },
    }));
    const { cb, c } = cbCollect();
    p.start(ctx("hello"), cb);
    await scriptedHandshake(child);
    child.close(4);
    await waitFor(() => c.errors.length > 0);
    expect(() => p.start(ctx("another"), cb)).toThrow(/cleanup is unproven/);
    for (let i = 0; i < 2; i++) {
      const result = await p.dispose();
      expect(result.children.some((x) => !x.confirmed && x.exitCode === 4)).toBe(true);
    }
  });
});

describe("F18 — config.mcp_servers thread injection (frozen CodexSession)", () => {
  const REGISTRY = [
    {
      id: "1",
      name: "localfs",
      command: "/usr/bin/fs-server",
      args: ["--root", "/tmp"],
      env: { TOKEN: "x" },
    },
    {
      id: "2",
      name: "httpx",
      transport: "http" as const,
      command: "",
      args: [],
      url: "http://127.0.0.1:9999/mcp",
    },
  ];

  it("thread/start carries config.mcp_servers in the frozen shape", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      mcpServers: () => REGISTRY,
    });
    const { cb } = cbCollect();
    p.start(ctx("hi"), cb);
    const init = await child.next();
    child.write({
      id: init.id as number,
      result: { userAgent: "fixture", codexHome: "/test-codex-home", platformFamily: "unix", platformOs: "macos" },
    });
    await child.next(); // initialized
    const ts = await child.next();
    expect(ts.method).toBe("thread/start");
    const config = (ts.params as { config?: { mcp_servers?: unknown } }).config;
    expect(config?.mcp_servers).toEqual({
      localfs: { command: "/usr/bin/fs-server", args: ["--root", "/tmp"], env: { TOKEN: "x" } },
      httpx: { url: "http://127.0.0.1:9999/mcp" },
    });
    child.write({ id: ts.id as number, result: { thread: { id: BIND_ID } } });
    await p.dispose();
  });

  it("no registry → no config key on the wire", async () => {
    const child = new ScriptedChild();
    const { p } = provider({ spawnImpl: scripted([child]).spawnImpl });
    const { cb } = cbCollect();
    p.start(ctx("hi"), cb);
    const init = await child.next();
    child.write({
      id: init.id as number,
      result: { userAgent: "fixture", codexHome: "/test-codex-home", platformFamily: "unix", platformOs: "macos" },
    });
    await child.next(); // initialized
    const ts = await child.next();
    expect(ts.method).toBe("thread/start");
    expect((ts.params as { config?: unknown }).config).toBeUndefined();
    child.write({ id: ts.id as number, result: { thread: { id: BIND_ID } } });
    await p.dispose();
  });

  it("a config-load failure retries ONCE without mcp_servers", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      mcpServers: () => REGISTRY,
    });
    const { cb, c } = cbCollect();
    p.start(ctx("hi"), cb);
    const init = await child.next();
    child.write({
      id: init.id as number,
      result: { userAgent: "fixture", codexHome: "/test-codex-home", platformFamily: "unix", platformOs: "macos" },
    });
    await child.next(); // initialized
    const ts1 = await child.next();
    expect(ts1.method).toBe("thread/start");
    expect((ts1.params as { config?: unknown }).config).toBeDefined();
    // The server refuses the mcp_servers config — verbatim frozen error.
    child.write({
      id: ts1.id as number,
      error: { code: -32000, message: "failed to load configuration: bad MCP entry" },
    });
    const ts2 = await child.next();
    expect(ts2.method).toBe("thread/start");
    // The retry strips the override entirely — the thread still binds.
    expect((ts2.params as { config?: unknown }).config).toBeUndefined();
    child.write({ id: ts2.id as number, result: { thread: { id: BIND_ID } } });
    const turnStart = await child.next();
    expect(turnStart.method).toBe("turn/start");
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({ method: "turn/completed", params: { threadId: BIND_ID, turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await waitFor(() => c.done);
    expect(c.errors).toEqual([]);
    await p.dispose();
  });

  it("a non-config refusal does NOT retry (no silent replay)", async () => {
    const child = new ScriptedChild();
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      mcpServers: () => REGISTRY,
    });
    const { cb, c } = cbCollect();
    p.start(ctx("hi"), cb);
    const init = await child.next();
    child.write({
      id: init.id as number,
      result: { userAgent: "fixture", codexHome: "/test-codex-home", platformFamily: "unix", platformOs: "macos" },
    });
    await child.next(); // initialized
    const ts1 = await child.next();
    child.write({ id: ts1.id as number, error: { code: -32000, message: "quota exhausted" } });
    await waitFor(() => c.errors.length > 0);
    // No second thread/start — the request failed outright; the only
    // further frame would be a retried start, and none comes.
    await expect(child.next(300)).rejects.toThrow("timeout");
    await p.dispose();
  });

  it("thread/resume carries mcp_servers too (frozen shared threadParameters)", async () => {
    const child = new ScriptedChild();
    const ws = tmpWorkspace();
    const bindings = new Map<string, import("../src/main/codexAppServerProvider").ProviderThreadBinding>([
      ["local-1", {
        providerId: "codex",
        codexThreadId: "cx-old",
        cwd: realpathSync(ws),
        codexHomeId: "/test-codex-home",
        schemaPin: "0.164.0+6aaac694",
        cliVersion: "fixture",
        savedAt: Date.now(),
      }],
    ]);
    const { p } = provider({
      spawnImpl: scripted([child]).spawnImpl,
      lookupBinding: (t) => bindings.get(t),
      mcpServers: () => REGISTRY,
    });
    const { cb } = cbCollect();
    p.start(ctx("resume me", { workspace: { projectId: "p1", directory: ws } }), cb);
    const init = await child.next();
    child.write({
      id: init.id as number,
      result: { userAgent: "fixture", codexHome: "/test-codex-home", platformFamily: "unix", platformOs: "macos" },
    });
    await child.next(); // initialized
    const rs = await child.next();
    expect(rs.method).toBe("thread/resume");
    const config = (rs.params as { config?: { mcp_servers?: unknown } }).config;
    expect(config?.mcp_servers).toBeDefined();
    child.write({ id: rs.id as number, result: { thread: { id: "cx-old" } } });
    const turnStart = await child.next();
    child.write({ id: turnStart.id as number, result: { turn: { id: "cx-turn-1" } } });
    child.write({ method: "turn/completed", params: { threadId: "cx-old", turn: { id: "cx-turn-1", status: "completed", error: null } } });
    await p.dispose();
  });
});
