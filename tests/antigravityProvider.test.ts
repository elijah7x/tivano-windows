// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ANTIGRAVITY_DEFAULT_START_TIMEOUT_MS,
  ANTIGRAVITY_SEED,
  AntigravityProvider,
  addingSeedRows,
  antigravityTurnOutcome,
  authHint,
  isAntigravityTransientFailure,
  normalizeModelAndEffort,
  oneShotReplyFromStream,
  parseAntigravityRetryLine,
  parseModelRow,
  parseModelsOutput,
} from "../src/main/antigravityProvider";
import { resolveAntigravityRuntime } from "../src/main/antigravityRuntimeConfig";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";

const fixtureScript = resolve("tests/fixtures/antigravity-stream.mjs");
const cleanupDirs: string[] = [];
const activeProviders: AntigravityProvider[] = [];
const activeEngines: Engine[] = [];

function freshTemp(prefix = "ag-prov-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

function makeFixtureProvider(
  dataRoot: string,
  opts?: {
    startTimeoutMs?: number;
    reviewTimeoutMs?: number;
    logPollMs?: number;
    extraEnv?: Record<string, string>;
    bindThread?: (threadId: string, binding: import("../src/shared/types").ProviderThreadBinding) => Promise<void>;
    lookupBinding?: (threadId: string) => import("../src/shared/types").ProviderThreadBinding | undefined;
  },
): AntigravityProvider {
  const config = resolveAntigravityRuntime(
    {
      TIVANO_ANTIGRAVITY_FIXTURE: fixtureScript,
      TIVANO_ANTIGRAVITY_NODE: process.execPath,
    },
    dataRoot,
    { discover: false },
  );
  if (opts?.extraEnv) Object.assign(config.env, opts.extraEnv);
  const p = new AntigravityProvider({
    config,
    ...(opts?.startTimeoutMs !== undefined ? { startTimeoutMs: opts.startTimeoutMs } : {}),
    ...(opts?.reviewTimeoutMs !== undefined ? { reviewTimeoutMs: opts.reviewTimeoutMs } : {}),
    ...(opts?.logPollMs !== undefined ? { logPollMs: opts.logPollMs } : {}),
    ...(opts?.bindThread ? { bindThread: opts.bindThread } : {}),
    ...(opts?.lookupBinding ? { lookupBinding: opts.lookupBinding } : {}),
  });
  activeProviders.push(p);
  return p;
}

async function runProviderTurn(
  provider: AntigravityProvider,
  ctx: {
    prompt: string;
    threadId: string;
    turnId: string;
    cwd: string;
    model?: string;
    effort?: string;
    runtimeMode?: "supervised" | "autoAcceptEdits" | "auto" | "fullAccess";
    interactionMode?: "build" | "plan";
  },
): Promise<{
  status: "done" | "error" | "interrupted";
  text: string;
  error?: string;
  notices: string[];
  fileChanges: string[];
}> {
  return await new Promise((resolveTurn) => {
    let text = "";
    const notices: string[] = [];
    const fileChanges: string[] = [];
    provider.start(
      {
        prompt: ctx.prompt,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        workspace: { projectId: "proj-1", directory: ctx.cwd },
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.effort ? { effort: ctx.effort } : {}),
        ...(ctx.runtimeMode ? { runtimeMode: ctx.runtimeMode } : {}),
        ...(ctx.interactionMode ? { interactionMode: ctx.interactionMode } : {}),
      },
      {
        onChunk: (_seq, delta) => {
          text += delta;
        },
        onApproval: () => {},
        onNotice: (n) => notices.push(n),
        onFileChanges: (paths) => fileChanges.push(...paths),
        onDone: () => resolveTurn({ status: "done", text, notices, fileChanges }),
        onError: (message) =>
          resolveTurn({ status: "error", text, error: message, notices, fileChanges }),
        onInterrupted: () => resolveTurn({ status: "interrupted", text, notices, fileChanges }),
      },
    );
  });
}

afterEach(async () => {
  vi.useRealTimers();
  for (const e of activeEngines.splice(0)) {
    try {
      e.shutdown();
    } catch {
      /* ignore */
    }
  }
  for (const p of activeProviders.splice(0)) {
    await p.dispose().catch(() => {});
  }
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

describe("Antigravity P2-35 / P2-59 pure hardening rules", () => {
  it("drops retired Gemini models, ignores status chatter, and preserves xhigh/max inside model catalogs", () => {
    expect(parseModelRow("Fetching available models...")).toBeNull();
    expect(parseModelRow("gemini-2.5-pro\tGemini 2.5 Pro")).toBeNull();
    expect(parseModelRow("gemini-3.5-pro\tGemini 3.5 Pro")).toBeNull();
    expect(parseModelRow("gemini-3-flash\tGemini 3 Flash")).toBeNull();
    expect(parseModelRow("gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)")).toEqual({
      id: "gemini-4-hydrogen-xhigh",
      name: "Gemini 4 Hydrogen (XHigh)",
    });

    const parsed = parseModelsOutput(
      [
        "Fetching available models...",
        "id\tname",
        "gemini-2.5-pro\tGemini 2.5 Pro",
        "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
        "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
        "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
        "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );

    const ids = parsed.models.map((m) => m.id);
    expect(ids).not.toContain("gemini-2.5-pro");
    expect(ids).not.toContain("Fetching");
    expect(ids).toContain("gemini-4-hydrogen");
    expect(ids).toContain("gemini-4-argon");
    expect(parsed.models.find((m) => m.isDefault)?.id).toBe("gemini-3.8-flash");
    const hydrogen = parsed.models.find((m) => m.id === "gemini-4-hydrogen")!;
    expect(hydrogen.name).toBe("Gemini 4 Hydrogen");
    expect(hydrogen.efforts).toEqual(["low", "high", "xhigh"]);
    const opus = parsed.models.find((m) => m.id === "claude-opus-4-6-thinking")!;
    expect(opus.efforts).toEqual([]);

    const seeded = addingSeedRows([]);
    expect(seeded.some((m) => m.id === "gemini-4-hydrogen" && m.efforts.includes("xhigh"))).toBe(true);
    expect(seeded.find((m) => m.isDefault)?.id).toBe("gemini-3.8-flash");
    expect(seeded.some((m) => m.id === "gemini-4-neon")).toBe(false);
    expect(seeded.some((m) => m.id === "gemini-4-argon")).toBe(true);
  });

  it("passes full agy ids for suffixed models, omits --effort for Claude, and clamps effort to listed levels", () => {
    expect(normalizeModelAndEffort("gemini-4-hydrogen", "xhigh", ANTIGRAVITY_SEED)).toEqual({
      model: "gemini-4-hydrogen-xhigh",
    });
    expect(normalizeModelAndEffort("gemini-4-hydrogen-high", undefined, ANTIGRAVITY_SEED)).toEqual({
      model: "gemini-4-hydrogen-high",
    });
    // Unsupported `max` for gemini-4-hydrogen clamps to model default (`high`)
    expect(normalizeModelAndEffort("gemini-4-hydrogen", "max", ANTIGRAVITY_SEED)).toEqual({
      model: "gemini-4-hydrogen-high",
    });
    // Claude models hosted on Antigravity never take --effort
    expect(
      normalizeModelAndEffort("claude-opus-4-6-thinking", "max", ANTIGRAVITY_SEED),
    ).toEqual({
      model: "claude-opus-4-6-thinking",
    });
    expect(
      normalizeModelAndEffort("claude-sonnet-4-6", "high", ANTIGRAVITY_SEED),
    ).toEqual({
      model: "claude-sonnet-4-6",
    });
    // Non-suffixed model advertising `max` retains `--effort max`
    const customCatalog = [
      {
        id: "custom-max-model",
        name: "Custom",
        efforts: ["low", "max"],
        defaultEffort: "low",
        isDefault: false,
      },
    ];
    expect(normalizeModelAndEffort("custom-max-model", "max", customCatalog)).toEqual({
      model: "custom-max-model",
      effort: "max",
    });
  });

  it("judges errors per turn so stale earlier errors or recovered mid-turn errors do not fail worked turns", () => {
    const stale = new Set(["stale earlier failure"]);
    expect(
      antigravityTurnOutcome({
        interruptRequested: false,
        status: "ERROR",
        finishedReason: "error",
        hasDeniedActions: false,
        hasReply: true,
        completedResponseIndex: 2,
        latestCascadeErrorIndex: null,
        cascadeErrorMessages: new Set(),
        knownConversationErrors: stale,
        resultError: "stale earlier failure",
      }),
    ).toEqual({ status: "done", recovered: true });

    expect(
      antigravityTurnOutcome({
        interruptRequested: false,
        status: "ERROR",
        finishedReason: "error",
        hasDeniedActions: false,
        hasReply: true,
        completedResponseIndex: 5,
        latestCascadeErrorIndex: 3,
        cascadeErrorMessages: new Set(["transient glitch"]),
        knownConversationErrors: new Set(),
        resultError: "transient glitch",
      }),
    ).toEqual({ status: "done", recovered: true });

    // An error on a turn with no recovery still fails with mapped auth guidance.
    expect(
      antigravityTurnOutcome({
        interruptRequested: false,
        status: "ERROR",
        finishedReason: "error",
        hasDeniedActions: false,
        hasReply: false,
        completedResponseIndex: null,
        latestCascadeErrorIndex: null,
        cascadeErrorMessages: new Set(),
        knownConversationErrors: new Set(),
        resultError: "401 Unauthenticated",
      }),
    ).toEqual({
      status: "error",
      message: "Antigravity is not signed in. Run `agy` once in Terminal to sign in.",
      recovered: false,
    });
    expect(authHint("No active account found")).toContain("Run `agy` once in Terminal");
  });

  it("recovers one-shot review replies when a cascade error precedes a completed agent_response", () => {
    const stream = [
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 1, step_type: "error", state: "ERROR", error: { message: "transient" } },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 2, step_type: "agent_response", state: "DONE", text_delta: "Finding 1: ok." },
      }),
      JSON.stringify({
        event: "result",
        result: { status: "ERROR", finished_reason: "error", error: "transient" },
      }),
    ].join("\n");
    expect(oneShotReplyFromStream(stream).reply).toBe("Finding 1: ok.");
  });

  it("never classifies 503/capacity/quota/auth as transient so app does not retry on top of agy's own", () => {
    expect(isAntigravityTransientFailure("HTTP 503 Service Unavailable")).toBe(false);
    expect(isAntigravityTransientFailure("MODEL_CAPACITY_EXHAUSTED: no capacity")).toBe(false);
    expect(isAntigravityTransientFailure("429 Too Many Requests")).toBe(false);
    expect(isAntigravityTransientFailure("quota exceeded")).toBe(false);
    expect(isAntigravityTransientFailure("Antigravity is not signed in.")).toBe(false);

    expect(isAntigravityTransientFailure("stream closed: connection dropped")).toBe(true);
    expect(isAntigravityTransientFailure("Antigravity did not finish starting in time.")).toBe(
      true,
    );
    expect(ANTIGRAVITY_DEFAULT_START_TIMEOUT_MS).toBe(90_000);
  });

  it("parses run.go and backoff agy retry log lines into user-facing retry notices", () => {
    const parsedGo = parseAntigravityRetryLine(
      "W1124 09:00:01.123456 100 run.go:184] Run: attempt 1 failed (request failed: HTTP 503 capacity exhausted), retrying in 2s",
    );
    expect(parsedGo).toEqual({
      attempt: 2,
      reason: "request failed: HTTP 503 capacity exhausted",
      labelKey: "server busy",
      notice: "Antigravity: the model request failed (server busy); agy is retrying, attempt 2.",
    });
    const parsedIdle = parseAntigravityRetryLine(
      "W1124 09:00:01.123456 100 run.go:184] Run: attempt 2 failed (request failed: stream idle timeout), retrying in 5s",
    );
    expect(parsedIdle?.notice).toBe(
      "Antigravity: the model request failed (no response for 5 minutes); agy is retrying, attempt 3.",
    );
    expect(parseAntigravityRetryLine("normal info line")).toBeNull();
  });
});

describe("AntigravityProvider fixture process integration", () => {
  it("lists catalog, pins Supervised to Default (--settings), passes --print-timeout 0 and --add-dir, and omits MCP", async () => {
    const dataRoot = freshTemp();
    const cwd = freshTemp("ag-cwd-");
    const bindings: string[] = [];
    const provider = makeFixtureProvider(dataRoot, {
      bindThread: async (_tid, b) => {
        bindings.push(`${b.providerId}:${b.codexThreadId}`);
      },
    });

    const catalog = await provider.modelCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog!.some((m) => m.id === "gemini-2.5-pro")).toBe(false);
    expect(catalog!.some((m) => m.id === "gemini-3.8-flash")).toBe(true);
    expect(catalog!.some((m) => m.id === "gemini-4-hydrogen")).toBe(true);

    const sup = await runProviderTurn(provider, {
      prompt: "[echo-args]",
      threadId: "t-sup",
      turnId: "turn-sup",
      cwd,
      model: "gemini-4-hydrogen",
      effort: "xhigh",
      runtimeMode: "supervised",
      interactionMode: "build",
    });
    expect(sup.status).toBe("done");
    const supArgs = (JSON.parse(sup.text) as { args: string[] }).args;
    expect(supArgs).toContain("--print-timeout");
    expect(supArgs[supArgs.indexOf("--print-timeout") + 1]).toBe("0");
    expect(supArgs).toContain("--add-dir");
    expect(supArgs[supArgs.indexOf("--add-dir") + 1]).toBe(cwd);
    expect(supArgs).toContain("--settings");
    expect(supArgs[supArgs.indexOf("--settings") + 1]).toBe('{"agentMode":""}');
    expect(supArgs).not.toContain("--dangerously-skip-permissions");
    expect(supArgs).not.toContain("--mcp-config");
    expect(supArgs[supArgs.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-xhigh");
    expect(supArgs).not.toContain("--effort");
    expect(bindings).toEqual(["antigravity:ag-conv-1"]);

    // Full access includes --mode accept-edits --dangerously-skip-permissions, and Claude omits --effort
    const full = await runProviderTurn(provider, {
      prompt: "[echo-args]",
      threadId: "t-full",
      turnId: "turn-full",
      cwd,
      model: "claude-opus-4-6-thinking",
      effort: "max",
      runtimeMode: "fullAccess",
    });
    expect(full.status).toBe("done");
    const fullArgs = (JSON.parse(full.text) as { args: string[] }).args;
    expect(fullArgs).toContain("accept-edits");
    expect(fullArgs).toContain("--dangerously-skip-permissions");
    expect(fullArgs[fullArgs.indexOf("--model") + 1]).toBe("claude-opus-4-6-thinking");
    expect(fullArgs).not.toContain("--effort");
  });

  it("drops --settings in Supervised mode when --help omits --settings", async () => {
    const dataRoot = freshTemp();
    const cwd = freshTemp("ag-cwd-");
    const provider = makeFixtureProvider(dataRoot, {
      extraEnv: { TIVANO_ANTIGRAVITY_FIXTURE_NO_SETTINGS: "1" },
    });
    const res = await runProviderTurn(provider, {
      prompt: "[echo-args]",
      threadId: "t-noset",
      turnId: "turn-1",
      cwd,
      runtimeMode: "supervised",
    });
    expect(res.status).toBe("done");
    const args = (JSON.parse(res.text) as { args: string[] }).args;
    expect(args).not.toContain("--settings");
  });

  it("surfaces agy retry log lines in chat and isolates stale errors across turns", async () => {
    const dataRoot = freshTemp();
    const cwd = freshTemp("ag-cwd-");
    const provider = makeFixtureProvider(dataRoot, { logPollMs: 25 });

    const r1 = await runProviderTurn(provider, {
      prompt: "[sticky-turn-1]",
      threadId: "t-sticky",
      turnId: "turn-1",
      cwd,
    });
    expect(r1.status).toBe("error");
    expect(r1.error).toContain("stale upstream glitch");

    const r2 = await runProviderTurn(provider, {
      prompt: "[sticky-turn-2]",
      threadId: "t-sticky",
      turnId: "turn-2",
      cwd,
    });
    expect(r2.status).toBe("done");
    expect(r2.text).toContain("Turn 2 worked fine.");

    const retryRes = await runProviderTurn(provider, {
      prompt: "[retry-log]",
      threadId: "t-retrylog",
      turnId: "turn-1",
      cwd,
    });
    expect(retryRes.status).toBe("done");
    expect(retryRes.notices).toContain(
      "Antigravity: the model request failed (server busy); agy is retrying, attempt 2.",
    );

    const recovered = await runProviderTurn(provider, {
      prompt: "[recovered-error]",
      threadId: "t-rec",
      turnId: "turn-1",
      cwd,
    });
    expect(recovered.status).toBe("done");
    expect(recovered.text).toContain("Recovered cleanly.");
  });

  it("enforces slow sign-in timeout, permission held-back error, edited file attribution, and Hydra review", async () => {
    const dataRoot = freshTemp();
    const cwd = freshTemp("ag-cwd-");
    const hangProvider = makeFixtureProvider(dataRoot, { startTimeoutMs: 120 });

    const hung = await runProviderTurn(hangProvider, {
      prompt: "[hang-init]",
      threadId: "t-hang",
      turnId: "turn-1",
      cwd,
    });
    expect(hung.status).toBe("error");
    expect(hung.error).toContain("Run `agy` once in Terminal");

    const provider = makeFixtureProvider(dataRoot);
    const denied = await runProviderTurn(provider, {
      prompt: "[tool-deny]",
      threadId: "t-deny",
      turnId: "turn-1",
      cwd,
      runtimeMode: "supervised",
    });
    expect(denied.status).toBe("error");
    expect(denied.error).toContain("Antigravity held back");

    const edited = await runProviderTurn(provider, {
      prompt: "[edit-file:note.txt]",
      threadId: "t-edit",
      turnId: "turn-1",
      cwd,
    });
    expect(edited.status).toBe("done");
    expect(edited.fileChanges).toContain("note.txt");
    expect(existsSync(join(cwd, "note.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "note.txt"), "utf8")).toContain("edited");

    const review = await provider.generateHydraReview("[review] inspect diff", {
      cwd,
      readableDirs: [cwd],
      model: "gemini-3.8-flash",
      effort: "high",
    });
    expect(review).toContain("Finding 1:");
  });

  it("ignores late close/error hooks from a cancelled transport so an immediate replacement turn finishes cleanly", async () => {
    const dataRoot = freshTemp();
    const cwd = freshTemp("ag-cwd-");
    const provider = makeFixtureProvider(dataRoot);

    let turn1Error: string | undefined;
    const h1 = provider.start(
      {
        prompt: "[hang-init]",
        threadId: "t-race",
        turnId: "turn-1",
        workspace: { projectId: "proj-1", directory: cwd },
      },
      {
        onChunk: () => {},
        onApproval: () => {},
        onDone: () => {},
        onError: (msg) => {
          turn1Error = msg;
        },
      },
    );

    // Wait briefly so transport 1 has spawned, then cancel and immediately start turn 2.
    await new Promise((r) => setTimeout(r, 40));
    h1.cancel();

    const turn2 = await runProviderTurn(provider, {
      prompt: "hello replacement",
      threadId: "t-race",
      turnId: "turn-2",
      cwd,
    });
    expect(turn1Error).toBeUndefined();
    expect(turn2.status).toBe("done");
    expect(turn2.error).toBeUndefined();
  });
});

describe("Engine Antigravity connection-drop auto-continue and Hydra abandoned watchdog", () => {
  it("auto-continues dropped Antigravity turn up to 2x and keeps 503 failed without extra retries", async () => {
    const root = freshTemp("ag-eng-");
    const projDir = freshTemp("ag-proj-");
    const prevDelays = process.env.TIVANO_TRANSIENT_RETRY_DELAYS_MS;
    process.env.TIVANO_TRANSIENT_RETRY_DELAYS_MS = "30,30";
    try {
      const store = new Store(root);
      store.open();
      const paths = new ProjectRuntimePaths([projDir], join(root, "grants.json"), root);
      const config = resolveAntigravityRuntime(
        {
          TIVANO_ANTIGRAVITY_FIXTURE: fixtureScript,
          TIVANO_ANTIGRAVITY_NODE: process.execPath,
        },
        root,
        { discover: false },
      );
      let engine!: Engine;
      const provider = new AntigravityProvider({
        config,
        lookupBinding: (tid) => engine.lookupProviderThread(tid),
        bindThread: (tid, b) => engine.bindProviderThread(tid, b),
        onThreadNotice: (tid, text, level) => engine.onThreadNotice(tid, text, level),
      });
      activeProviders.push(provider);
      engine = new Engine(store, provider, root, "0.1.0-test", paths);
      activeEngines.push(engine);

      const proj = engine.createProject("ag-proj");
      engine.registerWorkspace(proj.id, projDir);
      const thread = engine.createThread(proj.id, "Retry Test");

      // Establish session id first so `--conversation` is known on subsequent drop
      engine.sendTurn(thread.id, "hello session");
      await vi.waitFor(
        () => {
          const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
          expect(t.turn?.status).toBe("done");
          expect(t.providerThread?.codexThreadId).toBe("ag-conv-1");
        },
        { timeout: 5000 },
      );

      // Simulate permanent 503 failure -> NO retry notice
      engine.sendTurn(thread.id, "[503-fail]");
      await vi.waitFor(
        () => {
          const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
          expect(t.turn?.status).toBe("error");
          expect(t.turn?.error).toContain("503");
        },
        { timeout: 5000 },
      );
      const after503Notices = engine
        .snapshot()
        .threads.find((x) => x.id === thread.id)!
        .messages.filter((m) => m.kind === "notice" && m.content.includes("Connection to Antigravity dropped"));
      expect(after503Notices.length).toBe(0);

      // Simulate persistent drop -> retries max 2 times then stops with error
      engine.sendTurn(thread.id, "[drop-always]");
      await vi.waitFor(
        () => {
          const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
          const retryNotices = t.messages.filter((m) =>
            m.content.includes("Connection to Antigravity dropped"),
          );
          expect(retryNotices.length).toBe(2);
          expect(t.turn?.status).toBe("error");
        },
        { timeout: 6000 },
      );

      // Simulate single drop on a fresh thread -> recovers cleanly on 1st retry
      const thread2 = engine.createThread(proj.id, "Drop Once Recovery");
      engine.sendTurn(thread2.id, "seed session");
      await vi.waitFor(
        () => {
          const t = engine.snapshot().threads.find((x) => x.id === thread2.id)!;
          expect(t.turn?.status).toBe("done");
          expect(t.providerThread?.codexThreadId).toBe("ag-conv-1");
        },
        { timeout: 5000 },
      );
      engine.sendTurn(thread2.id, "[drop-once]");
      await vi.waitFor(
        () => {
          const t = engine.snapshot().threads.find((x) => x.id === thread2.id)!;
          expect(t.turn?.status).toBe("done");
          const notices = t.messages.filter((m) =>
            m.content.includes("Connection to Antigravity dropped"),
          );
          expect(notices.length).toBe(1);
        },
        { timeout: 5000 },
      );
    } finally {
      if (prevDelays === undefined) delete process.env.TIVANO_TRANSIENT_RETRY_DELAYS_MS;
      else process.env.TIVANO_TRANSIENT_RETRY_DELAYS_MS = prevDelays;
    }
  });

  it("stops an Antigravity Hydra head as Abandoned after 30m inactivity with last output/message details", async () => {
    const root = freshTemp("ag-abandoned-");
    const projDir = freshTemp("ag-abandoned-proj-");
    const prevTick = process.env.TIVANO_QUIET_TICK_MS;
    const prevStop = process.env.TIVANO_QUIET_STOP_MS;
    const prevAbandon = process.env.TIVANO_QUIET_ABANDONED_MS;
    process.env.TIVANO_QUIET_TICK_MS = "30";
    process.env.TIVANO_QUIET_STOP_MS = "100000";
    process.env.TIVANO_QUIET_ABANDONED_MS = "120";
    try {
      const store = new Store(root);
      store.open();
      const paths = new ProjectRuntimePaths([projDir], join(root, "grants.json"), root);
      const config = resolveAntigravityRuntime(
        {
          TIVANO_ANTIGRAVITY_FIXTURE: fixtureScript,
          TIVANO_ANTIGRAVITY_NODE: process.execPath,
        },
        root,
        { discover: false },
      );
      let engine!: Engine;
      const provider = new AntigravityProvider({
        config,
        lookupBinding: (tid) => engine.lookupProviderThread(tid),
        bindThread: (tid, b) => engine.bindProviderThread(tid, b),
        onThreadNotice: (tid, text, level) => engine.onThreadNotice(tid, text, level),
      });
      activeProviders.push(provider);
      engine = new Engine(store, provider, root, "0.1.0-test", paths);
      activeEngines.push(engine);

      const proj = engine.createProject("ag-hydra");
      engine.registerWorkspace(proj.id, projDir);
      const lead = engine.createThread(proj.id, "Lead");
      const now = Date.now();
      const headId = "11111111-1111-4111-8111-111111111111";
      store.update((d) => {
        d.threads.push({
          id: headId,
          projectId: proj.id,
          title: "Head 1",
          createdAt: now - 2000,
          updatedAt: now - 2000,
          messages: [
            {
              id: "m-1",
              role: "assistant",
              content: "Working on last check",
              status: "done",
              ts: now - 500,
              turnId: "turn-head-1",
            },
          ],
          turn: {
            id: "turn-head-1",
            threadId: headId,
            status: "running",
            seq: 1,
            startedAt: now - 2000,
            assistantMessageId: "m-1",
          },
          sessionGrants: [],
          hasStartedTurn: true,
          hydraHead: {
            leadId: lead.id,
            name: "Orion",
            headIndex: 0,
            task: "Inspect",
            status: "running",
            spawnedAt: now - 2000,
            batchId: "batch-1",
          },
        });
      });
      (engine as unknown as { armQuietWatchdog: () => void }).armQuietWatchdog();

      await vi.waitFor(
        () => {
          const head = engine.snapshot().threads.find((x) => x.id === headId)!;
          expect(head.hydraHead?.status).toBe("stopped");
          expect(head.hydraHead?.stalledNote).toContain(
            "Abandoned: no activity for 30 minutes; stopped by Tivano.",
          );
          expect(head.hydraHead?.stalledNote).toContain("Last output from the provider:");
          expect(head.hydraHead?.stalledNote).toContain("Last message from the provider:");
        },
        { timeout: 5000 },
      );
    } finally {
      if (prevTick === undefined) delete process.env.TIVANO_QUIET_TICK_MS;
      else process.env.TIVANO_QUIET_TICK_MS = prevTick;
      if (prevStop === undefined) delete process.env.TIVANO_QUIET_STOP_MS;
      else process.env.TIVANO_QUIET_STOP_MS = prevStop;
      if (prevAbandon === undefined) delete process.env.TIVANO_QUIET_ABANDONED_MS;
      else process.env.TIVANO_QUIET_ABANDONED_MS = prevAbandon;
    }
  });

  it("resumes a 10m stalled Antigravity head once with the frozen prompt, then stops with provider last-output note on second stall", async () => {
    const root = freshTemp("ag-stall-");
    const projDir = freshTemp("ag-stall-proj-");
    const prevTick = process.env.TIVANO_QUIET_TICK_MS;
    const prevStop = process.env.TIVANO_QUIET_STOP_MS;
    const prevAbandon = process.env.TIVANO_QUIET_ABANDONED_MS;
    process.env.TIVANO_QUIET_TICK_MS = "30";
    process.env.TIVANO_QUIET_STOP_MS = "1200";
    process.env.TIVANO_QUIET_ABANDONED_MS = "60000";
    try {
      const store = new Store(root);
      store.open();
      const paths = new ProjectRuntimePaths([projDir], join(root, "grants.json"), root);
      const config = resolveAntigravityRuntime(
        {
          TIVANO_ANTIGRAVITY_FIXTURE: fixtureScript,
          TIVANO_ANTIGRAVITY_NODE: process.execPath,
        },
        root,
        { discover: false },
      );
      let engine!: Engine;
      const provider = new AntigravityProvider({
        config,
        lookupBinding: (tid) => engine.lookupProviderThread(tid),
        bindThread: (tid, b) => engine.bindProviderThread(tid, b),
        onThreadNotice: (tid, text, level) => engine.onThreadNotice(tid, text, level),
      });
      activeProviders.push(provider);
      engine = new Engine(store, provider, root, "0.1.0-test", paths);
      activeEngines.push(engine);

      const proj = engine.createProject("ag-stall");
      engine.registerWorkspace(proj.id, projDir);
      const lead = engine.createThread(proj.id, "Lead");
      const now = Date.now();
      const headId = "22222222-2222-4222-8222-222222222222";
      store.update((d) => {
        d.threads.push({
          id: headId,
          projectId: proj.id,
          title: "Head Stall",
          createdAt: now - 3000,
          updatedAt: now - 3000,
          messages: [
            {
              id: "m-warn",
              role: "system",
              kind: "notice",
              noticeLevel: "warning",
              content: "Antigravity: stream idle timeout",
              status: "done",
              ts: now - 2500,
              turnId: "turn-stall-1",
            },
          ],
          turn: {
            id: "turn-stall-1",
            threadId: headId,
            status: "running",
            seq: 1,
            startedAt: now - 3000,
            assistantMessageId: "m-stall-1",
          },
          sessionGrants: [],
          hasStartedTurn: true,
          hydraHead: {
            leadId: lead.id,
            name: "Lyra",
            headIndex: 0,
            task: "Inspect",
            status: "running",
            spawnedAt: now - 3000,
            batchId: "batch-stall",
          },
        });
      });
      (engine as unknown as { armQuietWatchdog: () => void }).armQuietWatchdog();

      await vi.waitFor(
        () => {
          const head = engine.snapshot().threads.find((x) => x.id === headId)!;
          const userMsgs = head.messages.filter((m) => m.role === "user");
          expect(userMsgs.some((m) =>
            m.content.includes("Your last request got no answer from the model and was stopped after 10 minutes."),
          )).toBe(true);
          expect(head.turn?.status).toBe("done");
        },
        { timeout: 6000 },
      );

      // Now simulate a second quiet stall on the same head -> stops permanently with provider note
      store.update((d) => {
        const h = d.threads.find((x) => x.id === headId)!;
        h.hydraHead!.status = "running";
        delete h.hydraHead!.finishedAt;
        h.turn = {
          id: "turn-stall-2",
          threadId: headId,
          status: "running",
          seq: 1,
          startedAt: Date.now() - 3000,
          assistantMessageId: "m-stall-2",
        };
      });
      (engine as unknown as { armQuietWatchdog: () => void }).armQuietWatchdog();

      await vi.waitFor(
        () => {
          const head = engine.snapshot().threads.find((x) => x.id === headId)!;
          expect(head.hydraHead?.status).toBe("stopped");
          expect(head.hydraHead?.stopReason).toBe("stalled");
          expect(head.hydraHead?.stalledNote).toContain(
            "Stalled: no edits or tool calls for 10 minutes; stopped by Tivano.",
          );
          expect(head.hydraHead?.stalledNote).toContain("Last output from the provider:");
          expect(head.hydraHead?.stalledNote).toContain("Last message from the provider:");
        },
        { timeout: 5000 },
      );
    } finally {
      if (prevTick === undefined) delete process.env.TIVANO_QUIET_TICK_MS;
      else process.env.TIVANO_QUIET_TICK_MS = prevTick;
      if (prevStop === undefined) delete process.env.TIVANO_QUIET_STOP_MS;
      else process.env.TIVANO_QUIET_STOP_MS = prevStop;
      if (prevAbandon === undefined) delete process.env.TIVANO_QUIET_ABANDONED_MS;
      else process.env.TIVANO_QUIET_ABANDONED_MS = prevAbandon;
    }
  }, 15_000);
});
