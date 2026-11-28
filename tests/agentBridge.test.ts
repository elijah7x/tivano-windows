// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-45 agent bridge: endpoint naming, model ids, error sanitizing, the
// auto-approval policy, the ephemeral runner's JSON-line event contract
// against a synthetic adapter, and the real CLI over a live endpoint.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentBridgeService,
  EphemeralAgentRunner,
  agentApprovalDecision,
  agentBridgeEndpoint,
  decodeAgentModel,
  encodeAgentModel,
  resolveAgentFilePath,
  sanitizeAgentError,
  type AgentEvent,
} from "../src/main/agentBridge";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type { ProviderAdapter, ProviderCallbacks, TurnContext } from "../src/main/provider";

const CLI = join(__dirname, "..", "cli", "tivano.mjs");
const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "tivano-agent-"));
  dirs.push(d);
  return d;
};
const services: AgentBridgeService[] = [];
afterEach(() => {
  for (const s of services) s.dispose();
  services.length = 0;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Script = (ctx: TurnContext, cb: ProviderCallbacks, h: Handle) => void;
interface Handle {
  cancelled: boolean;
  resumed: { approved: boolean; optionId?: string | undefined }[];
  declined: string[];
  answered: string[];
}
function fakeAdapter(script: Script, mode: "codex" | "mock" = "codex") {
  const calls: { ctx: TurnContext; h: Handle }[] = [];
  const ended: string[] = [];
  const adapter = {
    descriptor: { id: mode, label: mode === "codex" ? "Codex" : "Mock", mode, synthetic: true },
    start(ctx: TurnContext, cb: ProviderCallbacks) {
      const h: Handle = { cancelled: false, resumed: [], declined: [], answered: [] };
      calls.push({ ctx, h });
      setTimeout(() => script(ctx, cb, h), 0);
      return {
        cancel: () => void (h.cancelled = true),
        resume: (approved: boolean, optionId?: string) => void h.resumed.push({ approved, optionId }),
        decline: (id: string) => void h.declined.push(id),
        answer: (key: string) => void h.answered.push(key),
      };
    },
    endSession: (id: string) => void ended.push(id),
    dispose: async () => ({ children: [], orphanedPending: 0 }),
  } as unknown as ProviderAdapter;
  const engine = {
    providerDescriptor: adapter.descriptor,
    codexModels: async () => ({
      state: "ready" as const,
      models: [
        { id: "gpt-a", name: "Model A", isDefault: false },
        { id: "gpt-b", name: "Model B", isDefault: true },
      ],
    }),
  } as never;
  return { adapter, engine, calls, ended };
}
const collect = async (runner: EphemeralAgentRunner, req: Parameters<EphemeralAgentRunner["run"]>[0], signal?: AbortSignal) => {
  const events: AgentEvent[] = [];
  await runner.run(req, (e) => events.push(e), signal);
  return events;
};

describe("agent bridge helpers", () => {
  it("derives its own endpoint, distinct from Local control", () => {
    const pipe = agentBridgeEndpoint("C:\\Users\\Synthetic\\AppData\\Roaming\\Tivano Windows Dev", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\tivano-agent-[0-9a-f]{32}$/);
    expect(agentBridgeEndpoint("c:\\users\\synthetic\\appdata\\roaming\\tivano windows dev\\", "win32")).toBe(pipe);
    const other = process.platform === "win32" ? "linux" : "win32";
    expect(agentBridgeEndpoint("/data/root", other === "win32" ? "linux" : process.platform)).toBe(
      process.platform === "win32" ? agentBridgeEndpoint("/data/root") : posix.join("/data/root", "control", "agent.sock"),
    );
  });

  it("encodes and decodes opaque model ids", () => {
    expect(encodeAgentModel("codex", "gpt-b")).toBe("codex/gpt-b");
    expect(encodeAgentModel("mock")).toBe("mock");
    expect(decodeAgentModel("codex/gpt/b")).toEqual({ provider: "codex", model: "gpt/b" });
    expect(decodeAgentModel("codex/")).toEqual({ provider: "codex" });
    expect(decodeAgentModel("mock")).toEqual({ provider: "mock" });
  });

  it("sanitizes errors: ANSI, secrets, whitespace, length", () => {
    expect(sanitizeAgentError("\u001b[31mfailed\u001b[0m\n  with   Bearer abcdefghijkl")).toBe("failed with [redacted]");
    expect(sanitizeAgentError("api_key=SYNTHETICVALUE123 sk-synthetic12345")).toBe("[redacted] [redacted]");
    expect(sanitizeAgentError("   ")).toBe("Provider error.");
    const long = sanitizeAgentError("x".repeat(500));
    expect(long.length).toBe(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("approves file changes and declines commands, plans and permissions", () => {
    const decision = [
      { id: "deny", title: "Deny", role: "deny", scope: "none" },
      { id: "once", title: "Allow once", role: "approve", scope: "once" },
      { id: "session", title: "Allow for session", role: "approve", scope: "session" },
    ] as const;
    expect(agentApprovalDecision({ kind: "action", headline: "Codex requests approval", options: [...decision] })).toEqual({ approve: true, optionId: "once" });
    expect(agentApprovalDecision({ kind: "command", headline: "Codex requests approval", options: [...decision] })).toEqual({ approve: false, optionId: "deny" });
    expect(agentApprovalDecision({ kind: "plan", headline: "Plan", options: [] })).toEqual({ approve: false, optionId: "decline" });
    expect(
      agentApprovalDecision({
        kind: "action",
        headline: "Codex requests permissions",
        options: [
          { id: "decline", title: "Decline", role: "deny", scope: "none" },
          { id: "turn", title: "Allow once", role: "approve", scope: "turn" },
        ],
      }),
    ).toEqual({ approve: false, optionId: "decline" });
  });

  it("resolves edit paths against the cwd with explicit win32/posix rules", () => {
    expect(resolveAgentFilePath("notes/a.md", "C:\\Work\\Book", "win32")).toBe(win32.join("C:\\Work\\Book", "notes", "a.md"));
    expect(resolveAgentFilePath("D:\\Other\\b.md", "C:\\Work\\Book", "win32")).toBe("D:\\Other\\b.md");
    expect(resolveAgentFilePath("NUL", "C:\\Work", "win32")).toBeNull();
    expect(resolveAgentFilePath("./a/../b.md", "/work/book", "linux")).toBe(posix.join("/work/book", "b.md"));
    expect(resolveAgentFilePath("/abs/c.md", "/work/book", "linux")).toBe("/abs/c.md");
    expect(resolveAgentFilePath("/dev/null", "/work", "linux")).toBeNull();
  });
});

describe("EphemeralAgentRunner", () => {
  it("lists the bound provider's models with exactly one default", async () => {
    const f = fakeAdapter(() => {});
    const r = await new EphemeralAgentRunner(f.engine, () => f.adapter).models();
    expect(r).toEqual({
      version: 1,
      models: [
        { id: "codex/gpt-a", label: "Model A", providerName: "Codex", isDefault: false },
        { id: "codex/gpt-b", label: "Model B", providerName: "Codex", isDefault: true },
      ],
    });
    expect(await new EphemeralAgentRunner(f.engine, () => null).models()).toEqual({ version: 1, models: [] });
  });

  it("streams text, thinking, tools and changed files, then done", async () => {
    const cwd = fresh();
    const f = fakeAdapter((_ctx, cb) => {
      cb.onReasoning?.({ itemId: "r1", delta: "plan" });
      cb.onReasoning?.({ itemId: "r1", done: true, finalText: "plan" });
      cb.onReasoning?.({ itemId: "r2", done: true, finalText: "late" });
      cb.onChunk(1, "Hel");
      cb.onMessageText?.(2, "Hello");
      cb.onToolActivity?.({ itemId: "t1", kind: "read", title: "book.md", status: "started" });
      cb.onToolActivity?.({ itemId: "t1", kind: "read", title: "book.md", status: "completed" });
      cb.onToolActivity?.({ itemId: "t2", kind: "edit", title: "notes.md", status: "started" });
      cb.onFileChanges?.(["notes.md", "notes.md"]);
      cb.onDone();
      cb.onChunk(3, "after done");
    });
    const runner = new EphemeralAgentRunner(f.engine, () => f.adapter);
    const events = await collect(runner, { cwd, prompt: "Summarize", model: "codex/gpt-a" });
    const session = (events[0] as { session: string }).session;
    expect(events).toEqual([
      { type: "session", session },
      { type: "thinking", delta: "plan" },
      { type: "thinking", delta: "late" },
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "tool_start", id: "t1", name: "read", input: { path: "book.md" } },
      { type: "tool_end", id: "t1", ok: true },
      { type: "tool_start", id: "t2", name: "edit", input: { path: "notes.md" } },
      { type: "file", path: join(f.calls[0]!.ctx.workspace!.directory, "notes.md") },
      { type: "tool_end", id: "t2", ok: true },
      { type: "done" },
    ]);
    const ctx = f.calls[0]!.ctx;
    expect(ctx).toMatchObject({ threadId: session, model: "gpt-a", runtimeMode: "autoAcceptEdits", interactionMode: "build" });
  });

  it("auto-approves edits, declines commands and answers questions empty", async () => {
    const f = fakeAdapter((_ctx, cb) => {
      cb.onApproval({ kind: "action", headline: "Codex requests approval", title: "edit", symbol: "s", options: [{ id: "once", title: "Allow once", role: "approve", scope: "once" }] });
      cb.onApproval({ kind: "command", headline: "Codex requests approval", title: "rm", symbol: "s", options: [{ id: "deny", title: "Deny", role: "deny", scope: "none" }] });
      cb.onQuestion?.({ providerKey: "q1", questions: [] });
      setTimeout(() => cb.onDone(), 5);
    });
    await collect(new EphemeralAgentRunner(f.engine, () => f.adapter), { cwd: fresh(), prompt: "go" });
    const h = f.calls[0]!.h;
    expect(h.resumed).toEqual([{ approved: true, optionId: "once" }]);
    expect(h.declined).toEqual(["deny"]);
    expect(h.answered).toEqual(["q1"]);
  });

  it("reports honest bad_request / model_unavailable / provider errors", async () => {
    const f = fakeAdapter((_ctx, cb) => cb.onError("boom\n access_token=SYNTHETICSECRET1"));
    const runner = new EphemeralAgentRunner(f.engine, () => f.adapter);
    const cwd = fresh();
    const first = async (req: Parameters<EphemeralAgentRunner["run"]>[0]) => (await collect(runner, req)).at(-1);
    expect(await first({ cwd, prompt: "  " })).toEqual({ type: "error", code: "bad_request", message: "Prompt must not be empty." });
    expect(await first({ cwd: "relative/dir", prompt: "x" })).toMatchObject({ code: "bad_request", message: "Working directory must be an absolute path." });
    expect(await first({ cwd: join(cwd, "missing"), prompt: "x" })).toMatchObject({ code: "bad_request" });
    expect(await first({ cwd, prompt: "x".repeat(900_001) })).toMatchObject({ code: "bad_request", message: "Prompt exceeds maximum size." });
    expect(await first({ cwd, prompt: "x", model: "claude/opus" })).toMatchObject({ code: "model_unavailable" });
    expect(await first({ cwd, prompt: "x" })).toEqual({ type: "error", code: "internal", message: "boom [redacted]" });
    expect(f.calls.length).toBe(1);
    expect(await collect(new EphemeralAgentRunner(f.engine, () => null), { cwd, prompt: "x" })).toEqual([
      { type: "error", code: "app_unavailable", message: "Tivano is unavailable." },
    ]);
  });

  it("validates Windows working directories with win32 rules", async () => {
    const f = fakeAdapter(() => {});
    const runner = new EphemeralAgentRunner(f.engine, () => f.adapter, "win32");
    expect((await collect(runner, { cwd: "\\no-drive", prompt: "x" }))[0]).toMatchObject({ code: "bad_request", message: "Working directory must be an absolute path." });
    expect((await collect(runner, { cwd: "C:\\definitely\\missing\\dir", prompt: "x" }))[0]).toMatchObject({ code: "bad_request", message: "Working directory does not exist or is not a directory." });
  });

  it("cancels the provider turn when the client goes away", async () => {
    const f = fakeAdapter((_ctx, cb) => cb.onChunk(1, "partial"));
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    const run = new EphemeralAgentRunner(f.engine, () => f.adapter).run({ cwd: fresh(), prompt: "x" }, (e) => {
      events.push(e);
      if (e.type === "text") ac.abort();
    }, ac.signal);
    await run;
    expect(f.calls[0]!.h.cancelled).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["session", "text"]);
  });

  it("reuses a session for follow-ups, refuses busy ones and expires idle ones", async () => {
    let clock = 0;
    let release: (() => void) | undefined;
    const f = fakeAdapter((_ctx, cb) => (release = () => cb.onDone()));
    const runner = new EphemeralAgentRunner(f.engine, () => f.adapter, process.platform, () => clock);
    const cwd = fresh();
    const firstEvents: AgentEvent[] = [];
    const first = runner.run({ cwd, prompt: "a", model: "codex/gpt-b" }, (e) => firstEvents.push(e));
    await new Promise((r) => setTimeout(r, 5));
    const session = (firstEvents[0] as { session: string }).session;
    expect(await collect(runner, { cwd, prompt: "b", session })).toEqual([{ type: "error", code: "bad_request", message: "session_busy" }]);
    release!();
    await first;
    const follow = collect(runner, { cwd, prompt: "b", session });
    await new Promise((r) => setTimeout(r, 5));
    release!();
    expect((await follow)[0]).toEqual({ type: "session", session });
    expect(f.calls[1]!.ctx).toMatchObject({ threadId: session, model: "gpt-b" });
    clock += 30 * 60_000;
    runner.sweep();
    expect(f.ended).toEqual([session]);
    const after = collect(runner, { cwd, prompt: "c", session });
    await new Promise((r) => setTimeout(r, 5));
    release!();
    expect(((await after)[0] as { session: string }).session).not.toBe(session);
  });

  it("leaves no chat behind on a real engine", async () => {
    const root = fresh();
    const store = new Store(root);
    store.open();
    const mock = new MockProvider({ tickMs: 1 });
    const engine = new Engine(store, mock, root, "t");
    const before = engine.snapshot().threads.length;
    const events = await collect(new EphemeralAgentRunner(engine, () => mock), { cwd: fresh(), prompt: "hello" });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(engine.snapshot().threads.length).toBe(before);
  });
});

describe("tivano agent CLI over the agent endpoint", () => {
  const rig = async () => {
    const root = fresh();
    const f = fakeAdapter((_ctx, cb) => {
      cb.onChunk(1, "Synthetic reply");
      cb.onFileChanges?.(["out.md"]);
      cb.onDone();
    });
    const svc = new AgentBridgeService(new EphemeralAgentRunner(f.engine, () => f.adapter), root, "dev");
    services.push(svc);
    await svc.start();
    expect(svc.listening).toBe(true);
    return { svc, env: { ...process.env, TIVANO_AGENT_SOCKET: svc.endpoint } };
  };
  const runCli = (args: string[], env: NodeJS.ProcessEnv, stdin?: string) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end(stdin ?? "");
    });

  it("agent models prints the model envelope", async () => {
    const { env } = await rig();
    const r = await runCli(["agent", "models", "--json"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ version: 1, models: [{ id: "codex/gpt-a" }, { id: "codex/gpt-b", isDefault: true }] });
  });

  it("agent run streams JSON lines from stdin and exits 0 on done", async () => {
    const { env } = await rig();
    const cwd = fresh();
    const r = await runCli(["agent", "run", "--json", "--cwd", cwd], env, "Summarize chapter one");
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["session", "text", "file", "done"]);
    expect(lines[1]).toEqual({ type: "text", delta: "Synthetic reply" });
  });

  it("reports bad arguments and a stopped app as JSON errors with exit 1", async () => {
    const { env } = await rig();
    const missing = await runCli(["agent", "run"], env, "x");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ type: "error", code: "bad_request", message: "Missing required '--cwd' option." });
    const dup = await runCli(["agent", "models", "--json", "--json"], env);
    expect(JSON.parse(dup.stdout)).toMatchObject({ models: [], error: { code: "bad_request" } });
    const down = await runCli(["agent", "run", "--cwd", fresh()], { ...env, TIVANO_AGENT_SOCKET: join(fresh(), "none.sock") }, "x");
    expect(down.code).toBe(1);
    expect(JSON.parse(down.stdout)).toMatchObject({ type: "error", code: "app_unavailable" });
  });
});
