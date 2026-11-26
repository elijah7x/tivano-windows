// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-01 Codex one-shot prediction tests against the offline Codex app-server
// fixture and scripted wire: fast-model + low-effort selection, skip when
// absent (allowsDefaultModel: false), lightweight args, timeout resilience,
// JSON suggestion extraction, and unconfigured mode returning null.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerProvider,
  selectFastCodexTextModel,
} from "../src/main/codexAppServerProvider";
import {
  CODEX_ONE_SHOT_CONFIG_ARGS,
  type CodexRuntimeConfig,
} from "../src/main/codexRuntimeConfig";
import { Engine } from "../src/main/engine";
import { Store } from "../src/main/store";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-codex-pred-"));
  roots.push(d);
  return d;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureConfig(codexHome: string, fastModel = false): CodexRuntimeConfig {
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: NODE,
    codexHome,
    codexHomeId: codexHome,
    args: ["app-server"],
    env: {
      CODEX_HOME: codexHome,
      ...(fastModel ? { TIVANO_CODEX_FIXTURE_FAST_MODEL: "1" } : {}),
    },
    treeCapability: { supported: false, platform: "darwin", reason: "test" },
  };
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

describe("selectFastCodexTextModel", () => {
  it("selects terra model with low effort or defaultEffort fallback and returns null when absent", () => {
    expect(
      selectFastCodexTextModel([
        { id: "gpt-5.6", name: "GPT-5.6", efforts: ["low", "high"], isDefault: true },
        {
          id: "gpt-5.6-terra",
          name: "GPT-5.6 Terra",
          efforts: ["low", "medium"],
          defaultEffort: "medium",
          isDefault: false,
        },
      ]),
    ).toEqual({ model: "gpt-5.6-terra", effort: "low" });

    expect(
      selectFastCodexTextModel([
        {
          id: "fast-1",
          name: "Codex Terra",
          efforts: ["medium", "high"],
          defaultEffort: "medium",
          isDefault: false,
        },
      ]),
    ).toEqual({ model: "fast-1", effort: "medium" });

    expect(
      selectFastCodexTextModel([
        { id: "gpt-5.6", name: "GPT-5.6", efforts: ["low", "high"], isDefault: true },
      ]),
    ).toBeNull();
  });
});

describe("P2-01 CodexAppServerProvider.generateNextPrompt", () => {
  it("runs lightweight one-shot prediction via the fast Codex model and feeds Engine.predictNextPrompt", async () => {
    const root = freshRoot();
    const codexHome = freshRoot();
    const store = new Store(root);
    store.open();
    const spawnedArgs: string[][] = [];
    const provider = new CodexAppServerProvider({
      config: fixtureConfig(codexHome, true),
      lookupBinding: () => undefined,
      bindThread: async () => {},
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
    const engine = new Engine(store, provider, root, "0.0.0-test");
    try {
      const raw = await provider.generateNextPrompt(
        "First request: check\nUser: hello [mock:predict:Run vitest now]\nAssistant: done",
      );
      expect(raw).toBe('{"suggestion":"Run vitest now"}');
      expect(spawnedArgs[0]).toEqual([FIXTURE, ...CODEX_ONE_SHOT_CONFIG_ARGS]);

      expect(
        await provider.generateNextPrompt("User: [mock:predict-empty]\nAssistant: ok"),
      ).toBe('{"suggestion":null}');
      expect(
        await provider.generateNextPrompt("User: [mock:predict-invalid]\nAssistant: ok"),
      ).toBe("not valid json");
      expect(
        await provider.generateNextPrompt("User: [mock:predict-fail]\nAssistant: ok"),
      ).toBeNull();

      // Wire through Engine.predictNextPrompt on a completed thread.
      const t = engine.createThread(null, "CodexPred");
      const turnId = "11111111-1111-4111-8111-111111111111";
      const th = store.state.threads.find((x) => x.id === t.id)!;
      th.turn = {
        id: turnId,
        threadId: t.id,
        status: "done",
        seq: 1,
        startedAt: Date.now(),
        assistantMessageId: "m-asst",
      };
      th.messages.push(
        {
          id: "m-user",
          role: "user",
          content: "fix bug [mock:predict:Inspect the diff]",
          status: "done",
          turnId,
          ts: Date.now(),
        },
        {
          id: "m-asst",
          role: "assistant",
          content: "Fixed it.",
          status: "done",
          turnId,
          ts: Date.now(),
        },
      );
      expect(await engine.predictNextPrompt(t.id, turnId)).toEqual({
        prediction: "Inspect the diff",
      });
    } finally {
      await provider.dispose();
    }
  });

  it("skips prediction without running a turn when the catalog has no fast model", async () => {
    const codexHome = freshRoot();
    let spawnCount = 0;
    const provider = new CodexAppServerProvider({
      config: fixtureConfig(codexHome, false),
      lookupBinding: () => undefined,
      bindThread: async () => {},
      spawnImpl: (spec) => {
        spawnCount++;
        return spawn(spec.executable, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      },
    });
    try {
      expect(
        await provider.generateNextPrompt("User: hi [mock:predict:Should skip]\nAssistant: ok"),
      ).toBeNull();
      expect(spawnCount).toBe(1);
      // Subsequent calls reuse the cached catalog and do not spawn again.
      expect(
        await provider.generateNextPrompt("User: hi2 [mock:predict:Should skip]\nAssistant: ok"),
      ).toBeNull();
      expect(spawnCount).toBe(1);
    } finally {
      await provider.dispose();
    }
  });

  it("sends fast model + low effort + text_elements on the wire and handles prediction timeout", async () => {
    const codexHome = freshRoot();
    const children: ScriptedChild[] = [];
    const seenArgs: string[][] = [];
    const provider = new CodexAppServerProvider({
      config: fixtureConfig(codexHome, false),
      limits: { predictionTimeoutMs: 60 },
      lookupBinding: () => undefined,
      bindThread: async () => {},
      spawnImpl: (spec) => {
        seenArgs.push([...spec.args]);
        const c = new ScriptedChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
    });

    const predPromise = provider.generateNextPrompt("User: test\nAssistant: ok");
    await new Promise((r) => setTimeout(r, 10));
    const c1 = children[0]!;
    expect(seenArgs[0]).toEqual([FIXTURE, ...CODEX_ONE_SHOT_CONFIG_ARGS]);

    const init = await c1.next();
    expect(init.method).toBe("initialize");
    c1.write({ id: init.id as number, result: { codexHome, userAgent: "fixture" } });
    expect((await c1.next()).method).toBe("initialized");

    const listReq = await c1.next();
    expect(listReq.method).toBe("model/list");
    c1.write({
      id: listReq.id as number,
      result: {
        data: [
          {
            id: "gpt-5.6",
            displayName: "GPT-5.6",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    });

    const threadReq = await c1.next();
    expect(threadReq.method).toBe("thread/start");
    expect((threadReq.params as Record<string, unknown>).model).toBe("gpt-5.6-terra");
    c1.write({ id: threadReq.id as number, result: { thread: { id: "thr-1" } } });

    const turnReq = await c1.next();
    expect(turnReq.method).toBe("turn/start");
    const tp = turnReq.params as Record<string, unknown>;
    expect(tp.model).toBe("gpt-5.6-terra");
    expect(tp.effort).toBe("low");
    expect(tp.input).toEqual([
      expect.objectContaining({ type: "text", text_elements: [] }),
    ]);
    c1.write({ id: turnReq.id as number, result: { turn: { id: "trn-1" } } });

    // Never send turn/completed — predictionTimeoutMs (60ms) resolves cleanly to null.
    await expect(predPromise).resolves.toBeNull();
    expect(c1.killed.length).toBeGreaterThan(0);
    await provider.dispose();
  });

  it("returns null cleanly when Codex runtime is unconfigured", async () => {
    const provider = new CodexAppServerProvider({
      config: {
        mode: "unconfigured",
        codexHome: "/none",
        codexHomeId: "/none",
        args: ["app-server"],
        env: {},
        treeCapability: { supported: false, platform: "win32", reason: "test" },
      },
      lookupBinding: () => undefined,
      bindThread: async () => {},
    });
    expect(await provider.generateNextPrompt("User: hi\nAssistant: ok")).toBeNull();
  });
});
