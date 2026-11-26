// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-57: lightweight-start flag on CodexAppServerProvider for background tasks
// (disables plugins, apps, and telemetry via CODEX_ONE_SHOT_CONFIG_ARGS) while
// leaving regular Codex chat launches unchanged.

import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerProvider,
  type ProviderThreadBinding,
} from "../src/main/codexAppServerProvider";
import {
  CODEX_ONE_SHOT_CONFIG_ARGS,
  type CodexRuntimeConfig,
} from "../src/main/codexRuntimeConfig";
import { Engine } from "../src/main/engine";
import { Store } from "../src/main/store";
import type { ProviderCallbacks, WorkspaceGrant } from "../src/main/provider";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
function tmp(prefix = "tivano-p257-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureCfg(partial: Partial<CodexRuntimeConfig> = {}): CodexRuntimeConfig {
  const home = tmp("tivano-p257-home-");
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: NODE,
    codexHome: home,
    codexHomeId: home,
    args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
    env: { CODEX_HOME: home },
    treeCapability: { supported: false, platform: "win32", reason: "test" },
    ...partial,
  };
}

function realCfg(partial: Partial<CodexRuntimeConfig> = {}): CodexRuntimeConfig {
  return {
    mode: "real",
    executable: "D:\\codex\\codex.exe",
    codexHome: "D:\\codex-home",
    codexHomeId: "D:\\codex-home",
    args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
    env: { CODEX_HOME: "D:\\codex-home" },
    treeCapability: {
      supported: true,
      platform: "win32",
      mechanism: "windows-job-object",
      helperPath: "D:\\pkg\\resources\\job-helper\\tivano-job-helper.exe",
      helperVersion: "1.1.0",
    },
    ...partial,
  };
}

function makeProvider(
  config: CodexRuntimeConfig,
  extra: Partial<ConstructorParameters<typeof CodexAppServerProvider>[0]> = {},
) {
  const bindings = new Map<string, ProviderThreadBinding>();
  return new CodexAppServerProvider({
    config,
    lookupBinding: (t) => bindings.get(t),
    bindThread: async (t, b) => {
      bindings.set(t, b);
    },
    ...extra,
  });
}

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
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const waiter = this.waiters.shift();
          if (waiter) waiter(parsed);
          else this.inbox.push(parsed);
        } catch {
          /* ignore malformed line */
        }
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

function collectTurn(): { cb: ProviderCallbacks; state: { done: boolean; errors: string[]; message: string } } {
  const state = { done: false, errors: [] as string[], message: "" };
  return {
    state,
    cb: {
      onChunk: () => {},
      onMessageText: (_s, text) => {
        state.message = text;
      },
      onApproval: () => {},
      onDone: () => {
        state.done = true;
      },
      onError: (err) => {
        state.errors.push(err);
      },
      onInterrupted: () => {},
    },
  };
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("CodexAppServerProvider P2-57 lightweight-start", () => {
  it("buildSpec disables plugins/apps/telemetry only when lightweight is true", () => {
    const real = makeProvider(realCfg());
    expect(real.buildSpec("D:\\ws").args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
    ]);
    expect(real.buildSpec("D:\\ws", { lightweight: false }).args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
    ]);
    expect(real.buildSpec("D:\\ws", { lightweight: true }).args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
      ...CODEX_ONE_SHOT_CONFIG_ARGS,
    ]);

    const fix = makeProvider(fixtureCfg());
    expect(fix.buildSpec("D:\\ws").args).toEqual([FIXTURE]);
    expect(fix.buildSpec("D:\\ws", { lightweight: true }).args).toEqual([
      FIXTURE,
      ...CODEX_ONE_SHOT_CONFIG_ARGS,
    ]);
  });

  it("fixture runOneShot passes one-shot config args while regular chat keeps them off", async () => {
    const spawnedArgs: string[][] = [];
    const p = makeProvider(fixtureCfg(), {
      spawnImpl: (spec) => {
        spawnedArgs.push([...spec.args]);
        return spawn(spec.executable, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      },
    });
    const ws = tmp("tivano-p257-ws-");

    // 1. Lightweight one-shot run against the synthetic protocol fixture.
    const init = await p.runOneShot(ws, async (_rpc, initResult) => initResult);
    expect(init.launchArgs).toEqual([...CODEX_ONE_SHOT_CONFIG_ARGS]);
    expect(p.sessionCount()).toBe(0);

    // 2. Background model catalog check via modelCatalog() -> lightweight one-shot
    // when no chat session is bound (also coalesced across concurrent callers).
    const [models, modelsConcurrent] = await Promise.all([
      p.modelCatalog(),
      p.modelCatalog(),
    ]);
    expect(models).not.toBeNull();
    expect(models!.map((m) => m.id)).toContain("fixture-model");
    expect(models!.map((m) => m.id)).not.toContain("fixture-hidden");
    expect(modelsConcurrent).toEqual(models);
    expect(p.sessionCount()).toBe(0);

    // 3. Regular chat turn stays unchanged (no lightweight config overrides).
    const grant: WorkspaceGrant = { projectId: "p1", directory: ws };
    const { cb, state } = collectTurn();
    p.start({ prompt: "hello", threadId: "local-1", turnId: "t-1", workspace: grant }, cb);
    await waitFor(() => state.done || state.errors.length > 0);
    expect(state.errors).toEqual([]);
    expect(state.message).toContain("hello");

    expect(spawnedArgs).toHaveLength(3);
    expect(spawnedArgs[0]).toEqual([FIXTURE, ...CODEX_ONE_SHOT_CONFIG_ARGS]);
    expect(spawnedArgs[1]).toEqual([FIXTURE, ...CODEX_ONE_SHOT_CONFIG_ARGS]);
    expect(spawnedArgs[2]).toEqual([FIXTURE]);

    const disposed = await p.dispose();
    expect(disposed.orphanedPending).toBe(0);
    expect(disposed.children.every((c) => c.confirmed)).toBe(true);
  });

  it("Engine.codexModels invokes lightweight one-shot when no session is bound", async () => {
    const root = tmp("tivano-p257-engine-");
    const store = new Store(root);
    store.open();
    const spawnedArgs: string[][] = [];
    const codex = makeProvider(fixtureCfg(), {
      spawnImpl: (spec) => {
        spawnedArgs.push([...spec.args]);
        return spawn(spec.executable, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      },
    });
    const engine = new Engine(store, codex, root, "0.0.0-test");
    try {
      const cat = await engine.codexModels();
      expect(cat.state).toBe("ready");
      if (cat.state === "ready") {
        expect(cat.models.map((m) => m.id)).toContain("fixture-model");
        expect(cat.models.map((m) => m.id)).not.toContain("fixture-hidden");
      }
      expect(codex.sessionCount()).toBe(0);
      expect(spawnedArgs).toEqual([[FIXTURE, ...CODEX_ONE_SHOT_CONFIG_ARGS]]);
    } finally {
      engine.shutdown();
      await codex.dispose();
      store.close();
    }
  });

  it("scripted wire runOneShot skips thread/start, cleans up child, and honors dispose", async () => {
    const ws = tmp("tivano-p257-ws-");
    const c1 = new ScriptedChild();
    const c2 = new ScriptedChild();
    const seenArgs: string[][] = [];
    const queue = [c1, c2];
    const p = makeProvider(fixtureCfg(), {
      spawnImpl: (spec) => {
        seenArgs.push([...spec.args]);
        return queue.shift() as unknown as ChildProcess;
      },
    });

    const seenMethods: string[] = [];
    const resultPromise = p.runOneShot(ws, async (rpc) => {
      const res = await rpc.request("account/rateLimits/read", {});
      return res;
    });

    const init1 = await c1.next();
    seenMethods.push(String(init1.method));
    c1.write({
      id: init1.id as number,
      result: { codexHome: p.config.codexHome, userAgent: "fixture" },
    });
    const inited1 = await c1.next();
    seenMethods.push(String(inited1.method));
    const rateReq = await c1.next();
    seenMethods.push(String(rateReq.method));
    c1.write({ id: rateReq.id as number, result: { rateLimits: { planType: "pro" } } });

    await expect(resultPromise).resolves.toEqual({ rateLimits: { planType: "pro" } });
    expect(seenMethods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(seenArgs[0]).toEqual([FIXTURE, ...CODEX_ONE_SHOT_CONFIG_ARGS]);
    expect(c1.killed.length).toBeGreaterThan(0);

    // Second one-shot interrupted by provider.dispose() rejects cleanly without flagging orphanedPending.
    const inFlight = p.runOneShot(ws, async (rpc) => rpc.request("model/list", {}));
    const init2 = await c2.next();
    c2.write({
      id: init2.id as number,
      result: { codexHome: p.config.codexHome, userAgent: "fixture" },
    });
    await c2.next(); // initialized
    await c2.next(); // model/list left unanswered

    const [disposeRes] = await Promise.all([
      p.dispose(),
      expect(inFlight).rejects.toThrow(/CODEX_CONNECTION_CLOSED/),
    ]);
    expect(disposeRes.orphanedPending).toBe(0);
    expect(disposeRes.children.length).toBe(1);
    expect(disposeRes.children[0]!.confirmed).toBe(true);
  });

  it("runOneShot enforces config, tree-capability, workspace, and codexHome guards", async () => {
    const ws = tmp("tivano-p257-ws-");
    const home = tmp("tivano-p257-unconf-");
    const unconfigured = makeProvider({
      mode: "unconfigured",
      codexHome: home,
      codexHomeId: home,
      args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
      env: { CODEX_HOME: home },
      treeCapability: { supported: false, platform: "win32", reason: "test" },
    });
    await expect(unconfigured.runOneShot(ws, async () => null)).rejects.toMatchObject({
      code: "CODEX_NOT_CONFIGURED",
    });

    const unsupportedReal = makeProvider(
      realCfg({ treeCapability: { supported: false, platform: "win32", reason: "no helper" } }),
    );
    await expect(unsupportedReal.runOneShot(ws, async () => null)).rejects.toMatchObject({
      code: "CODEX_REAL_UNAVAILABLE",
    });

    const badWs = makeProvider(fixtureCfg());
    await expect(badWs.runOneShot("", async () => null)).rejects.toMatchObject({
      code: "CODEX_WORKSPACE_REQUIRED",
    });
    await expect(badWs.runOneShot("\\\\server\\share", async () => null)).rejects.toMatchObject({
      code: "CODEX_WORKSPACE_REQUIRED",
    });
    await expect(badWs.runOneShot("//server/share", async () => null)).rejects.toMatchObject({
      code: "CODEX_WORKSPACE_REQUIRED",
    });
    await expect(badWs.runOneShot("file://server/share", async () => null)).rejects.toMatchObject({
      code: "CODEX_WORKSPACE_REQUIRED",
    });
    await expect(
      badWs.runOneShot(join(ws, "does-not-exist"), async () => null),
    ).rejects.toMatchObject({ code: "CODEX_WORKSPACE_REQUIRED" });
    const filePath = join(ws, "not-a-dir.txt");
    writeFileSync(filePath, "x");
    await expect(badWs.runOneShot(filePath, async () => null)).rejects.toMatchObject({
      code: "CODEX_WORKSPACE_REQUIRED",
    });

    // maxSessions bounds concurrent one-shots.
    const cappedChild = new ScriptedChild();
    const capped = makeProvider(fixtureCfg(), {
      limits: { maxSessions: 1 },
      spawnImpl: () => cappedChild as unknown as ChildProcess,
    });
    const first = capped.runOneShot(ws, async (rpc) => rpc.request("model/list", {}));
    const cInit = await cappedChild.next();
    await expect(capped.runOneShot(ws, async () => null)).rejects.toMatchObject({
      code: "CODEX_SESSION_LIMIT",
    });
    cappedChild.write({
      id: cInit.id as number,
      result: { codexHome: capped.config.codexHome, userAgent: "fixture" },
    });
    await cappedChild.next(); // initialized
    const cList = await cappedChild.next();
    cappedChild.write({ id: cList.id as number, result: { data: [], nextCursor: null } });
    await expect(first).resolves.toEqual({ data: [], nextCursor: null });
    await capped.dispose();

    // Unconfirmed child close retires transport and blocks new one-shots with CODEX_BUSY.
    const stuckChild = new ScriptedChild();
    stuckChild.kill = () => true; // never emits close
    const stuck = makeProvider(fixtureCfg(), {
      transportLimits: { shutdownGraceMs: 10, killObserveMs: 10 },
      spawnImpl: () => stuckChild as unknown as ChildProcess,
    });
    const stuckRun = stuck.runOneShot(ws, async () => {
      throw new Error("boom");
    });
    const sInit = await stuckChild.next();
    stuckChild.write({
      id: sInit.id as number,
      result: { codexHome: stuck.config.codexHome, userAgent: "fixture" },
    });
    await expect(stuckRun).rejects.toThrow("boom");
    await expect(stuck.runOneShot(ws, async () => null)).rejects.toMatchObject({
      code: "CODEX_BUSY",
    });
    stuckChild.close(0);
    await stuck.dispose();

    // Mismatched codexHome on initialize aborts before fn runs and disposes child.
    const child = new ScriptedChild();
    const mismatch = makeProvider(fixtureCfg(), {
      spawnImpl: () => child as unknown as ChildProcess,
    });
    let fnCalled = false;
    const p = mismatch.runOneShot(ws, async () => {
      fnCalled = true;
      return "ok";
    });
    const init = await child.next();
    child.write({
      id: init.id as number,
      result: { codexHome: realpathSync(ws), userAgent: "fixture" },
    });
    await expect(p).rejects.toThrow(/CODEX_HOME mismatch/);
    expect(fnCalled).toBe(false);
    await mismatch.dispose();
  });
});
