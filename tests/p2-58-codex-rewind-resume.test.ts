// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-58: Codex rewind (thread/revert + thread/fork fallback + restart resume)
// and dropping sub-agent instructions on resume / Hydra-off transitions.

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerProvider,
  ORDINARY_CODEX_THREAD_INSTRUCTIONS,
  type CodexProviderLimits,
} from "../src/main/codexAppServerProvider";
import type { CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import { Engine } from "../src/main/engine";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import type { ProviderThreadBinding } from "../src/shared/types";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/codex-app-server.mjs", import.meta.url),
);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-p258-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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
  pid = 791;
  killed: string[] = [];
  private buf = "";
  private inbox: Array<Record<string, unknown>> = [];
  private waiters: Array<(m: Record<string, unknown>) => void> = [];
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
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
      const timer = setTimeout(
        () => rej(new Error("scripted next() timeout")),
        ms,
      );
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

function fixtureCfg(home: string): CodexRuntimeConfig {
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: process.execPath,
    codexHome: home,
    codexHomeId: home,
    args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
    env: { CODEX_HOME: home },
    treeCapability: { supported: false, platform: "darwin", reason: "test" },
  };
}

function makeFixtureRig(root: string, wsRoot: string, home: string) {
  const workspace = join(wsRoot, "proj-ws");
  mkdirSync(workspace, { recursive: true });
  const store = new Store(root);
  store.open();
  const paths = new ProjectRuntimePaths([wsRoot], join(root, "grants.json"), root);
  paths.restore(new Set(store.state.projects.map((p) => p.id)));
  let engine!: Engine;
  const provider = new CodexAppServerProvider({
    config: fixtureCfg(home),
    lookupBinding: (t) => engine.lookupProviderThread(t),
    bindThread: (t, b) => engine.bindProviderThread(t, b),
    onThreadNotice: (t, text, level) => engine.onThreadNotice(t, text, level),
  });
  engine = new Engine(store, provider, root, "0.0.0-test", paths);
  return { store, engine, provider, paths, workspace };
}

function makeScriptedRig(
  children: ScriptedChild[],
  limits: Partial<CodexProviderLimits> = {},
) {
  const root = tmp();
  const wsRoot = tmp();
  const workspace = join(wsRoot, "proj-ws");
  mkdirSync(workspace);
  const store = new Store(root);
  store.open();
  const paths = new ProjectRuntimePaths([wsRoot], join(root, "grants.json"), root);
  paths.restore(new Set(store.state.projects.map((p) => p.id)));
  let engine!: Engine;
  const provider = new CodexAppServerProvider({
    config: fixtureCfg("/test-codex-home"),
    spawnImpl: () => children.shift() as unknown as ChildProcess,
    lookupBinding: (t) => engine.lookupProviderThread(t),
    bindThread: (t, b) => engine.bindProviderThread(t, b),
    onThreadNotice: (t, text, level) => engine.onThreadNotice(t, text, level),
    limits: { disposeInterruptMs: 50, ...limits },
  });
  engine = new Engine(store, provider, root, "0.0.0-test", paths);
  const project = engine.createProject("proj");
  paths.registerManaged(project.id, workspace);
  const thread = engine.createThread(project.id, "codex chat");
  return { root, store, engine, provider, threadId: thread.id, workspace };
}

async function driveInit(
  child: ScriptedChild,
  method: "thread/start" | "thread/resume",
  threadId = "cx-thread-1",
): Promise<Record<string, unknown>> {
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
  const req = await child.next();
  expect(req.method).toBe(method);
  child.write({ id: req.id as number, result: { thread: { id: threadId } } });
  return req;
}

async function completeTurn(
  child: ScriptedChild,
  threadId: string,
  providerTurnId: string,
  reply = "ok",
): Promise<Record<string, unknown>> {
  const ts = await child.next();
  expect(ts.method).toBe("turn/start");
  child.write({ id: ts.id as number, result: { turn: { id: providerTurnId } } });
  child.write({
    method: "turn/started",
    params: { threadId, turn: { id: providerTurnId } },
  });
  child.write({
    method: "item/completed",
    params: {
      threadId,
      turnId: providerTurnId,
      item: { type: "agentMessage", id: `msg-${providerTurnId}`, text: reply },
    },
  });
  child.write({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: providerTurnId, status: "completed", error: null },
    },
  });
  return ts;
}

const getThread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;

describe("P2-58 Codex rewind (scripted wire)", () => {
  it("pages thread/turns/list, calls thread/revert, keeps binding, and closes session", async () => {
    const c1 = new ScriptedChild();
    const c2 = new ScriptedChild();
    const r = makeScriptedRig([c1, c2]);
    try {
      r.engine.setThreadHydra(r.threadId, false);
      const t1 = r.engine.sendTurn(r.threadId, "turn one");
      await driveInit(c1, "thread/start", "cx-1");
      await completeTurn(c1, "cx-1", "pt-1", "reply one");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      const t2 = r.engine.sendTurn(r.threadId, "turn two");
      await completeTurn(c1, "cx-1", "pt-2", "reply two");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      expect(t1.providerTurnId).toBe("pt-1");
      expect(t2.providerTurnId).toBe("pt-2");

      const revertPromise = r.engine.revertTurn(r.threadId, t2.id) as Promise<void>;
      // Page 1 returns pt-2 with nextCursor; Page 2 returns pt-1.
      const list1 = await c1.next();
      expect(list1.method).toBe("thread/turns/list");
      expect(list1.params).toMatchObject({
        threadId: "cx-1",
        cursor: null,
        limit: 100,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      c1.write({
        id: list1.id as number,
        result: { data: [{ id: "pt-2" }], nextCursor: "p2" },
      });
      const list2 = await c1.next();
      expect(list2.method).toBe("thread/turns/list");
      expect(list2.params).toMatchObject({ threadId: "cx-1", cursor: "p2" });
      c1.write({
        id: list2.id as number,
        result: { data: [{ id: "pt-1" }], nextCursor: null },
      });

      const rev = await c1.next();
      expect(rev.method).toBe("thread/revert");
      expect(rev.params).toEqual({ threadId: "cx-1", beforeTurnId: "pt-2" });
      c1.write({ id: rev.id as number, result: { thread: { id: "cx-1" } } });

      await revertPromise;
      expect(r.provider.sessionCount()).toBe(0);
      const cur = getThread(r.engine, r.threadId);
      expect(cur.providerThread?.codexThreadId).toBe("cx-1");
      expect(cur.turn).toBeNull();
      expect(cur.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
        "turn one",
      ]);
      expect(
        cur.messages.some(
          (m) => m.role === "system" && m.content.includes("File changes were kept"),
        ),
      ).toBe(true);

      // Next turn resumes the reverted Codex thread cleanly.
      r.engine.sendTurn(r.threadId, "turn two replacement");
      await driveInit(c2, "thread/resume", "cx-1");
      await completeTurn(c2, "cx-1", "pt-3", "reply three");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);

  it("falls back to thread/fork + verify + thread/archive when thread/revert returns an RPC error", async () => {
    const c1 = new ScriptedChild();
    const r = makeScriptedRig([c1]);
    try {
      r.engine.setThreadHydra(r.threadId, false);
      r.engine.sendTurn(r.threadId, "first");
      await driveInit(c1, "thread/start", "cx-orig");
      await completeTurn(c1, "cx-orig", "pt-1", "one");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      const t2 = r.engine.sendTurn(r.threadId, "second");
      await completeTurn(c1, "cx-orig", "pt-2", "two");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      const revertPromise = r.engine.revertTurn(r.threadId, t2.id) as Promise<void>;
      const list1 = await c1.next();
      c1.write({
        id: list1.id as number,
        result: { data: [{ id: "pt-2" }, { id: "pt-1" }], nextCursor: null },
      });
      const rev = await c1.next();
      expect(rev.method).toBe("thread/revert");
      c1.write({
        id: rev.id as number,
        error: { code: -32601, message: "thread/revert unavailable" },
      });

      const fork = await c1.next();
      expect(fork.method).toBe("thread/fork");
      expect(fork.params).toMatchObject({
        threadId: "cx-orig",
        lastTurnId: "pt-1",
        excludeTurns: true,
        developerInstructions: ORDINARY_CODEX_THREAD_INSTRUCTIONS,
      });
      c1.write({
        id: fork.id as number,
        result: { thread: { id: "cx-forked" } },
      });

      const verifyList = await c1.next();
      expect(verifyList.method).toBe("thread/turns/list");
      expect(verifyList.params).toMatchObject({
        threadId: "cx-forked",
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      c1.write({
        id: verifyList.id as number,
        result: { data: [{ id: "pt-1" }], nextCursor: null },
      });

      const archive = await c1.next();
      expect(archive.method).toBe("thread/archive");
      expect(archive.params).toEqual({ threadId: "cx-orig" });
      c1.write({ id: archive.id as number, result: {} });

      await revertPromise;
      const cur = getThread(r.engine, r.threadId);
      expect(cur.providerThread?.codexThreadId).toBe("cx-forked");
      expect(cur.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
        "first",
      ]);
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);

  it("rewinding the first turn via fork fallback archives the thread and clears providerThread", async () => {
    const c1 = new ScriptedChild();
    const c2 = new ScriptedChild();
    const r = makeScriptedRig([c1, c2]);
    try {
      r.engine.setThreadHydra(r.threadId, false);
      const t1 = r.engine.sendTurn(r.threadId, "first");
      await driveInit(c1, "thread/start", "cx-orig");
      await completeTurn(c1, "cx-orig", "pt-1", "one");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      const revertPromise = r.engine.revertTurn(r.threadId, t1.id) as Promise<void>;
      const list = await c1.next();
      c1.write({
        id: list.id as number,
        result: { data: [{ id: "pt-1" }], nextCursor: null },
      });
      const rev = await c1.next();
      c1.write({
        id: rev.id as number,
        error: { code: -32000, message: "cannot revert first turn" },
      });
      const archive = await c1.next();
      expect(archive.method).toBe("thread/archive");
      expect(archive.params).toEqual({ threadId: "cx-orig" });
      c1.write({ id: archive.id as number, result: {} });

      await revertPromise;
      expect(getThread(r.engine, r.threadId).providerThread).toBeUndefined();

      // Subsequent send starts a brand-new thread rather than resuming.
      r.engine.sendTurn(r.threadId, "fresh start");
      await driveInit(c2, "thread/start", "cx-fresh");
      await completeTurn(c2, "cx-fresh", "pt-new", "fresh");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");
      expect(getThread(r.engine, r.threadId).providerThread?.codexThreadId).toBe(
        "cx-fresh",
      );
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);

  it("keeps conversation untouched on missing turn ID, missing turn in Codex, or watchdog timeout (no fork fallback)", async () => {
    const c1 = new ScriptedChild();
    const r = makeScriptedRig([c1], { rollbackTimeoutMs: 80 });
    try {
      r.engine.setThreadHydra(r.threadId, false);
      const t1 = r.engine.sendTurn(r.threadId, "keep me");
      await driveInit(c1, "thread/start", "cx-1");
      await completeTurn(c1, "cx-1", "pt-1", "ok");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      // Watchdog timeout during thread/revert must NOT trigger thread/fork.
      const p1 = r.engine.revertTurn(r.threadId, t1.id) as Promise<void>;
      const list = await c1.next();
      c1.write({
        id: list.id as number,
        result: { data: [{ id: "pt-1" }], nextCursor: null },
      });
      const rev = await c1.next();
      expect(rev.method).toBe("thread/revert");
      // Intentionally do not answer rev — let rollbackTimeoutMs fire.
      await expect(p1).rejects.toThrow(/CODEX_CONNECTION_CLOSED|timed out/i);
      await expect(c1.next(100)).rejects.toThrow(/timeout/);
      expect(getThread(r.engine, r.threadId).providerThread?.codexThreadId).toBe("cx-1");
      expect(getThread(r.engine, r.threadId).messages.some((m) => m.content === "keep me")).toBe(
        true,
      );

      // Missing providerTurnId on a bound thread refuses cleanly.
      const th = r.store.state.threads.find((t) => t.id === r.threadId)!;
      th.messages.push({
        id: "u-legacy",
        role: "user",
        content: "legacy turn",
        status: "done",
        ts: Date.now(),
        turnId: "turn-legacy",
      });
      await expect(
        r.engine.revertTurn(r.threadId, "turn-legacy") as Promise<void>,
      ).rejects.toThrow(/no Codex turn ID/);
      expect(
        getThread(r.engine, r.threadId).messages.some((m) => m.id === "u-legacy"),
      ).toBe(true);
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);
});

describe("P2-58 Drop sub-agent instructions on resume (scripted wire)", () => {
  it("sends Hydra developerInstructions + multi_agent=false on start, then drops them on resume when Hydra turns off", async () => {
    const c1 = new ScriptedChild();
    const c2 = new ScriptedChild();
    const r = makeScriptedRig([c1, c2]);
    try {
      // Turn 1: Hydra ON (default on new threads).
      r.engine.sendTurn(r.threadId, "first with hydra");
      const ts1 = await driveInit(c1, "thread/start", "cx-h");
      const p1 = ts1.params as {
        developerInstructions?: string;
        config?: { features?: Record<string, unknown> };
      };
      expect(p1.developerInstructions).toContain("[Hydra is on]");
      expect(p1.config?.features).toEqual({
        multi_agent: false,
        multi_agent_v2: false,
      });
      const turn1Start = await completeTurn(c1, "cx-h", "pt-1", "lead ok");
      const turn1Prompt = (
        turn1Start.params as { input: Array<{ text: string }> }
      ).input[0]!.text;
      // Policy stays in developerInstructions, not duplicated into turn input.
      expect(turn1Prompt).not.toContain("[Hydra is on]");
      expect(turn1Prompt).toContain("[Hydra setting: enabled");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");

      // Turn sub-agents OFF mid-session, then send Turn 2.
      r.engine.setThreadHydra(r.threadId, false);
      r.engine.sendTurn(r.threadId, "second without hydra");
      const rs2 = await driveInit(c2, "thread/resume", "cx-h");
      const p2 = rs2.params as {
        threadId?: string;
        developerInstructions?: string;
        config?: unknown;
      };
      expect(p2.threadId).toBe("cx-h");
      expect(p2.developerInstructions).toBe(ORDINARY_CODEX_THREAD_INSTRUCTIONS);
      expect(p2.config).toBeUndefined();
      const turn2Start = await completeTurn(c2, "cx-h", "pt-2", "direct ok");
      const turn2Prompt = (
        turn2Start.params as { input: Array<{ text: string }> }
      ).input[0]!.text;
      expect(turn2Prompt).not.toContain("[Hydra");
      expect(turn2Prompt).toContain("second without hydra");
      await waitFor(() => getThread(r.engine, r.threadId).turn?.status === "done");
    } finally {
      await r.provider.dispose();
      r.store.close();
    }
  }, 15000);
});

describe("P2-58 End-to-end offline Codex fixture (restart + resume + rewind)", () => {
  it("resumes after restart with sub-agents off and drops earlier sub-agent developerInstructions", async () => {
    const root = tmp();
    const wsRoot = tmp();
    const home = realpathSync(tmp());

    // Session 1: Hydra ON -> thread/start persists Hydra developerInstructions.
    const r1 = makeFixtureRig(root, wsRoot, home);
    const proj = r1.engine.createProject("p");
    r1.paths.registerManaged(proj.id, r1.workspace);
    const thread = r1.engine.createThread(proj.id, "resume test");
    r1.engine.sendTurn(thread.id, "dicheck turn one");
    await waitFor(() => getThread(r1.engine, thread.id).turn?.status === "done");
    const msg1 = getThread(r1.engine, thread.id).messages.find(
      (m) => m.role === "assistant",
    )!;
    expect(msg1.content).toContain("[Hydra is on]");
    const codexThreadId = getThread(r1.engine, thread.id).providerThread!.codexThreadId;
    r1.engine.shutdown();
    await r1.provider.dispose();
    r1.store.close();

    // Session 2 (restart): turn sub-agents OFF, then resume the Codex thread.
    const r2 = makeFixtureRig(root, wsRoot, home);
    try {
      r2.engine.setThreadHydra(thread.id, false);
      r2.engine.sendTurn(thread.id, "dicheck turn two");
      await waitFor(() => getThread(r2.engine, thread.id).turn?.status === "done");
      const assistants = getThread(r2.engine, thread.id).messages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistants).toHaveLength(2);
      expect(assistants[1]!.content).toContain(
        `[di=${ORDINARY_CODEX_THREAD_INSTRUCTIONS}]`,
      );
      expect(assistants[1]!.content).not.toContain("[Hydra is on]");

      const persistedFixture = JSON.parse(
        readFileSync(join(home, "fixture-state", `${codexThreadId}.json`), "utf8"),
      ) as { developerInstructions?: string; config?: unknown };
      expect(persistedFixture.developerInstructions).toBe(
        ORDINARY_CODEX_THREAD_INSTRUCTIONS,
      );
      expect(persistedFixture.config).toBeNull();
    } finally {
      r2.engine.shutdown();
      await r2.provider.dispose();
      r2.store.close();
    }
  }, 25000);

  it("rewinds and resends across restart against the real offline fixture (thread/revert and thread/fork)", async () => {
    const root = tmp();
    const wsRoot = tmp();
    const home = realpathSync(tmp());

    // Run 2 turns in Session 1.
    const r1 = makeFixtureRig(root, wsRoot, home);
    const proj = r1.engine.createProject("p");
    r1.paths.registerManaged(proj.id, r1.workspace);
    const thread = r1.engine.createThread(proj.id, "rewind fixture");
    r1.engine.setThreadHydra(thread.id, false);
    const t1 = r1.engine.sendTurn(thread.id, "keep this turn");
    await waitFor(() => getThread(r1.engine, thread.id).turn?.status === "done");
    const t2 = r1.engine.sendTurn(thread.id, "drop this turn");
    await waitFor(() => getThread(r1.engine, thread.id).turn?.status === "done");
    const origCodexId = getThread(r1.engine, thread.id).providerThread!.codexThreadId;
    r1.engine.shutdown();
    await r1.provider.dispose();
    r1.store.close();

    // Session 2 (restart): rewind t2 via thread/revert, then resend t1 with forkrevert.
    const r2 = makeFixtureRig(root, wsRoot, home);
    try {
      await (r2.engine.revertTurn(thread.id, t2.id) as Promise<void>);
      const afterRevert = getThread(r2.engine, thread.id);
      expect(afterRevert.providerThread?.codexThreadId).toBe(origCodexId);
      expect(
        afterRevert.messages.filter((m) => m.role === "user").map((m) => m.content),
      ).toEqual(["keep this turn"]);

      const stateAfterRevert = JSON.parse(
        readFileSync(join(home, "fixture-state", `${origCodexId}.json`), "utf8"),
      ) as { turns: Array<{ id: string }> };
      expect(stateAfterRevert.turns).toHaveLength(1);
      expect(stateAfterRevert.turns[0]!.id).toBe(t1.providerTurnId);

      // Now add a turn with "forkrevert" so the fixture refuses thread/revert,
      // then rewind it to exercise thread/fork + thread/archive end-to-end.
      const t3 = r2.engine.sendTurn(thread.id, "forkrevert trigger");
      await waitFor(() => getThread(r2.engine, thread.id).turn?.status === "done");
      await (r2.engine.revertTurn(thread.id, t3.id) as Promise<void>);

      const afterFork = getThread(r2.engine, thread.id);
      const forkedId = afterFork.providerThread?.codexThreadId;
      expect(forkedId).toBeTruthy();
      expect(forkedId).not.toBe(origCodexId);

      const oldState = JSON.parse(
        readFileSync(join(home, "fixture-state", `${origCodexId}.json`), "utf8"),
      ) as { archived: boolean };
      expect(oldState.archived).toBe(true);

      const forkedState = JSON.parse(
        readFileSync(join(home, "fixture-state", `${forkedId}.json`), "utf8"),
      ) as { turns: Array<{ id: string }>; archived: boolean };
      expect(forkedState.archived).toBe(false);
      expect(forkedState.turns).toHaveLength(1);
      expect(forkedState.turns[0]!.id).toBe(t1.providerTurnId);

      // Resend works on the forked thread too.
      const sent = await (r2.engine.resendTurn(
        thread.id,
        t1.id,
        "edited first turn",
      ) as Promise<ReturnType<Engine["sendTurn"]>>);
      await waitFor(() => getThread(r2.engine, thread.id).turn?.status === "done");
      const finalThread = getThread(r2.engine, thread.id);
      expect(
        finalThread.messages.filter((m) => m.role === "user").map((m) => m.content),
      ).toEqual(["edited first turn"]);
      expect(finalThread.turn?.id).toBe(sent.id);
    } finally {
      r2.engine.shutdown();
      await r2.provider.dispose();
      r2.store.close();
    }
  }, 30000);
});
