// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17: per-thread Codex model/effort selection — wire params, catalog
// fetch (honest pending/unavailable), provider-reported echo, engine
// persistence and IPC-facing validation.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerProvider } from "../src/main/codexAppServerProvider";
import type { CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import type { ProviderCallbacks, TurnContext, WorkspaceGrant } from "../src/main/provider";
import type { ProviderThreadBinding } from "../src/shared/types";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function cfg(partial: Partial<CodexRuntimeConfig> = {}): CodexRuntimeConfig {
  const home = tmp("tivano-codexhome-");
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: NODE,
    codexHome: home,
    codexHomeId: "/test-codex-home",
    args: ["app-server"],
    env: { CODEX_HOME: home },
    treeCapability: { supported: false, platform: "darwin", reason: "test" },
    ...partial,
  };
}

function provider(config = cfg()) {
  const bindings = new Map<string, ProviderThreadBinding>();
  const p = new CodexAppServerProvider({
    config,
    lookupBinding: (t) => bindings.get(t),
    bindThread: async (t, b) => {
      bindings.set(t, b);
    },
  });
  return { p, bindings };
}

function grant(): WorkspaceGrant {
  return { projectId: "p1", directory: tmp("tivano-codex-ws-") };
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Collected {
  done: boolean;
  interrupted: boolean;
  errors: string[];
  message: string;
  reports: Array<{ model: string | null; effort: string | null }>;
  reasoning: Map<string, { text: string; done: boolean }>;
  plans: Map<string, { text: string; done: boolean }>;
  todos: Array<Array<{ text: string; status: string }>>;
  usages: Array<{
    usedTokens: number;
    windowTokens?: number;
    sessionTotalTokens?: number;
  }>;
  tools: Array<{
    itemId: string;
    kind: string;
    status: string;
    title: string;
    titleKey?: string;
    detail?: string;
  }>;
}
function cbCollect(): { cb: ProviderCallbacks; c: Collected } {
  const c: Collected = {
    done: false,
    interrupted: false,
    errors: [],
    message: "",
    reports: [],
    reasoning: new Map(),
    plans: new Map(),
    todos: [],
    usages: [],
    tools: [],
  };
  return {
    c,
    cb: {
      onChunk: () => {},
      onMessageText: (_s, text) => {
        c.message = text;
      },
      onApproval: () => {},
      onDone: () => (c.done = true),
      onError: (m) => c.errors.push(m),
      onInterrupted: () => (c.interrupted = true),
      onModelReport: (model, effort) => c.reports.push({ model, effort }),
      onReasoning: (a) => {
        const ri = c.reasoning.get(a.itemId) ?? { text: "", done: false };
        if (a.delta) ri.text += a.delta;
        if (a.done) {
          ri.done = true;
          if (a.finalText !== undefined) ri.text = a.finalText;
        }
        c.reasoning.set(a.itemId, ri);
      },
      onPlan: (a) => {
        const pi = c.plans.get(a.itemId) ?? { text: "", done: false };
        if (a.delta) pi.text += a.delta;
        if (a.done) {
          pi.done = true;
          if (a.finalText !== undefined) pi.text = a.finalText;
        }
        c.plans.set(a.itemId, pi);
      },
      onTodos: (steps) => c.todos.push(steps.map((st) => ({ ...st }))),
      onUsage: (u) => c.usages.push({ ...u }),
      onToolActivity: (a) =>
        c.tools.push({
          itemId: a.itemId,
          kind: a.kind,
          status: a.status,
          title: a.title ?? "",
          ...(a.titleKey !== undefined ? { titleKey: a.titleKey } : {}),
          ...(a.detail !== undefined ? { detail: a.detail } : {}),
        }),
    },
  };
}

describe("Codex model/effort overrides (F17)", () => {
  it("turn/start carries verbatim model+effort and the fixture echoes them", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    const ctx: TurnContext = {
      prompt: "hello",
      threadId: "local-1",
      turnId: "t-1",
      workspace: grant(),
      model: "fixture-max",
      effort: "xhigh",
    };
    p.start(ctx, cb);
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.message).toContain("[m=fixture-max e=xhigh]");
    await p.dispose();
  });

  it("turn/start carries serviceTierForTurn verbatim and the fixture echoes it", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      {
        prompt: "hello",
        threadId: "local-1",
        turnId: "t-1",
        workspace: grant(),
        model: "fixture-model",
        effort: "high",
        serviceTier: "fast",
      },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.message).toContain("[m=fixture-model e=high t=fast]");
    await p.dispose();
  });

  it("no serviceTier → no tier echo tag at all", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      {
        prompt: "hello",
        threadId: "local-1",
        turnId: "t-1",
        workspace: grant(),
        model: "fixture-max",
      },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.message).toContain("[m=fixture-max e=default]");
    expect(c.message).not.toContain("t=fast");
    await p.dispose();
  });

  it("thread/start binds with the selected model — the response echo reports it", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      {
        prompt: "hello",
        threadId: "local-1",
        turnId: "t-1",
        workspace: grant(),
        model: "fixture-max",
      },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    // The fixture reports the bound model via the thread object.
    expect(c.reports.length).toBeGreaterThan(0);
    expect(c.reports[0]!.model).toBe("fixture-max");
    await p.dispose();
  });

  it("no selection → default fixture model, no override params", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "hello", threadId: "local-1", turnId: "t-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.message).not.toContain("[m=");
    expect(c.reports[0]?.model).toBe("fixture-model");
    await p.dispose();
  });

  it("modelCatalog returns the provider-owned list — hidden rows filtered", async () => {
    const { p } = provider();
    // No session yet → null (engine maps to "pending"), never a fake list.
    await expect(p.modelCatalog()).resolves.toBeNull();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "hello", threadId: "local-1", turnId: "t-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    const models = await p.modelCatalog();
    expect(models).not.toBeNull();
    const ids = models!.map((m) => m.id);
    expect(ids).toContain("fixture-model");
    expect(ids).toContain("fixture-max");
    expect(ids).not.toContain("fixture-hidden");
    const fm = models!.find((m) => m.id === "fixture-model")!;
    expect(fm.isDefault).toBe(true);
    expect(fm.efforts).toEqual(["low", "medium", "high"]);
    expect(fm.defaultEffort).toBe("medium");
    expect(fm.fastTier).toBe("fast");
    const fx = models!.find((m) => m.id === "fixture-max")!;
    expect(fx.fastTier).toBeUndefined();
    await p.dispose();
  });
});

describe("engine model selection (F17)", () => {
  function makeEngine(root: string) {
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    return { store, engine };
  }

  it("persists model+effort+tier on the thread and clears them", () => {
    const root = tmp("tivano-engmodel-");
    const { engine, store } = makeEngine(root);
    const thread = engine.createThread(null, "chat");
    engine.setThreadModel(thread.id, "fixture-model", "high", "fast");
    let t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.codexModel).toBe("fixture-model");
    expect(t.codexEffort).toBe("high");
    expect(t.codexServiceTier).toBe("fast");
    store.close();

    // Survives a reopen.
    const r2 = makeEngine(root);
    t = r2.engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.codexModel).toBe("fixture-model");
    expect(t.codexEffort).toBe("high");
    expect(t.codexServiceTier).toBe("fast");
    // Clearing only the tier leaves model/effort untouched.
    r2.engine.setThreadModel(thread.id, "fixture-model", "high", null);
    t = r2.engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.codexModel).toBe("fixture-model");
    expect(t.codexServiceTier).toBeUndefined();
    r2.engine.setThreadModel(thread.id, null, null, null);
    t = r2.engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.codexModel).toBeUndefined();
    expect(t.codexEffort).toBeUndefined();
    r2.store.close();
  });

  it("rejects over-long/empty ids and unknown threads", () => {
    const root = tmp("tivano-engmodel-");
    const { engine, store } = makeEngine(root);
    const thread = engine.createThread(null, "chat");
    expect(() => engine.setThreadModel(thread.id, "x".repeat(201), null)).toThrow();
    expect(() => engine.setThreadModel(thread.id, "", null)).toThrow();
    expect(() => engine.setThreadModel(thread.id, null, "e".repeat(101))).toThrow();
    expect(() => engine.setThreadModel(thread.id, null, null, "t".repeat(101))).toThrow();
    expect(() => engine.setThreadModel(thread.id, null, null, "")).toThrow();
    expect(() => engine.setThreadModel("nope", "m", null)).toThrow();
    store.close();
  });

  it("codexModels reports unsupported on non-Codex providers", async () => {
    const root = tmp("tivano-engmodel-");
    const { engine, store } = makeEngine(root);
    const cat = await engine.codexModels();
    expect(cat.state).toBe("unsupported");
    store.close();
  });

  it("codexModels reports pending before a session binds, ready after", async () => {
    const root = tmp("tivano-engmodel-");
    const store = new Store(root);
    store.open();
    const bindings = new Map<string, ProviderThreadBinding>();
    const codex = new CodexAppServerProvider({
      config: cfg(),
      lookupBinding: (t) => bindings.get(t),
      bindThread: async (t, b) => {
        bindings.set(t, b);
        // Keep the binding on the thread like engine.bindProviderThread.
        const th = store.state.threads.find((x) => x.id === t);
        if (th) {
          th.providerThread = b;
          store.update(() => {});
        }
      },
    });
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    const engine = new Engine(store, codex, root, "0.0.0-test", paths);
    expect((await engine.codexModels()).state).toBe("pending");

    const ws = tmp("tivano-codex-ws-");
    const proj = engine.createProject("p1");
    engine.registerWorkspace(proj.id, ws);
    const thread = engine.createThread(proj.id, "chat");
    engine.setThreadModel(thread.id, "fixture-max", "high");
    engine.sendTurn(thread.id, "hello");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      const st = t.turn?.status;
      return st === "done" || st === "error";
    });
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    if (t.turn?.status !== "done" && t.turn !== null)
      throw new Error(`turn ended as ${t.turn?.status}: ${t.turn?.error}`);
    const msg = t.messages.find((m) => m.role === "assistant")!;
    expect(msg.content).toContain("[m=fixture-max e=high]");
    expect(t.codexModelReported).toBe("fixture-max");

    const cat = await engine.codexModels();
    expect(cat.state).toBe("ready");
    if (cat.state === "ready") expect(cat.models.map((m) => m.id)).toContain("fixture-max");
    engine.shutdown();
    await codex.dispose();
    store.close();
  });
});

// ---- F06 runtime-mode policy mapping (frozen CodexSession table) ----------

describe("runtime-mode policy (F06)", () => {
  const drive = async (mode: string | undefined) => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      {
        prompt: "policy check",
        threadId: "t1",
        turnId: "turn-1",
        workspace: grant(),
        ...(mode ? { runtimeMode: mode as never } : {}),
      },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    await p.dispose();
    return c;
  };

  it("absent mode → supervised policy reaches turn/start verbatim", async () => {
    const c = await drive(undefined);
    expect(c.errors).toEqual([]);
    expect(c.message).toContain("[ap=untrusted rev=user sb=readOnly]");
  });

  it("autoAcceptEdits → on-request + workspaceWrite + user reviewer", async () => {
    const c = await drive("autoAcceptEdits");
    expect(c.message).toContain("[ap=on-request rev=user sb=workspaceWrite]");
  });

  it("auto → same sandbox but the PROVIDER reviewer (frozen difference)", async () => {
    const c = await drive("auto");
    expect(c.message).toContain("[ap=on-request rev=auto_review sb=workspaceWrite]");
  });

  it("fullAccess → never + dangerFullAccess", async () => {
    const c = await drive("fullAccess");
    expect(c.message).toContain("[ap=never rev=user sb=dangerFullAccess]");
  });
});

// ---- F06 Build/Plan interaction mode → collaborationMode -------------------

describe("interaction mode (F06 build/plan)", () => {
  const drive = async (interactionMode: string | undefined, model?: string) => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      {
        prompt: "imode check",
        threadId: "t1",
        turnId: "turn-1",
        workspace: grant(),
        ...(interactionMode ? { interactionMode: interactionMode as never } : {}),
        ...(model ? { model } : {}),
      },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    await p.dispose();
    return c;
  };

  it("plan → collaborationMode.mode=plan reaches the fixture", async () => {
    const c = await drive("plan", "fixture-max");
    expect(c.errors).toEqual([]);
    expect(c.message).toContain("[cm=plan]");
  });

  it("build → collaborationMode.mode=default (frozen)", async () => {
    const c = await drive("build");
    expect(c.message).toContain("[cm=default]");
  });

  it("absent mode → default (build is the frozen default)", async () => {
    const c = await drive(undefined);
    expect(c.message).toContain("[cm=default]");
  });
});

describe("engine interactionMode (F06)", () => {
  const mkEngine = (root: string) => {
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    return { store, engine };
  };

  it("persists per thread, validates, survives restart, clears on none", async () => {
    const dir = tmp("tivano-imode-");
    const r = mkEngine(dir);
    const ws = tmp("tivano-imode-ws-");
    const proj = r.engine.createProject("p1");
    r.engine.registerWorkspace(proj.id, ws);
    const thread = r.engine.createThread(proj.id, "chat");

    expect(thread.interactionMode ?? "build").toBe("build");
    r.engine.setInteractionMode(thread.id, "plan");
    expect(
      r.engine.snapshot().threads.find((t) => t.id === thread.id)!.interactionMode,
    ).toBe("plan");
    expect(() => r.engine.setInteractionMode(thread.id, "x" as never)).toThrow();
    expect(() => r.engine.setInteractionMode("nope", "plan")).toThrow();
    r.engine.shutdown();
    r.store.close();

    const r2 = mkEngine(dir);
    expect(
      r2.engine.snapshot().threads.find((t) => t.id === thread.id)!.interactionMode,
    ).toBe("plan");
    r2.engine.shutdown();
    r2.store.close();
  });

  it("interactionMode reaches TurnContext only for the codex adapter", async () => {
    const dir = tmp("tivano-imode-ctx-");
    const r = mkEngine(dir);
    const ws = tmp("tivano-imode-ctx-ws-");
    const proj = r.engine.createProject("p1");
    r.engine.registerWorkspace(proj.id, ws);
    const thread = r.engine.createThread(proj.id, "chat");
    r.engine.setInteractionMode(thread.id, "plan");
    // Mock provider ignores the field — send must still succeed and echo the
    // raw mock reply, proving Codex-only fields stay adapter-internal.
    r.engine.sendTurn(thread.id, "hello");
    await waitFor(() => {
      const t = r.engine.snapshot().threads.find((x) => x.id === thread.id)!;
      return t.turn?.status === "done" || t.turn?.status === "error";
    });
    const t = r.engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.turn?.status).toBe("done");
    const msg = t.messages.find((m) => m.role === "assistant")!;
    expect(msg.content).not.toContain("[cm=");
    r.engine.shutdown();
    r.store.close();
  });
});


// ---- F03 reasoning items (frozen reasoning event sequence) -----------

describe("reasoning items (F03)", () => {
  it("reasoning deltas stream and the completed summary is authoritative", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      {
        prompt: "reason please",
        threadId: "t1",
        turnId: "turn-1",
        workspace: grant(),
      },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.reasoning.size).toBe(1);
    const ri = [...c.reasoning.values()][0]!;
    // Frozen: completed summary replaces the streamed accumulation.
    expect(ri.done).toBe(true);
    expect(ri.text).toBe("Considering the request — weighing options (done)");
    await p.dispose();
  });

  it("no reasoning keyword → no reasoning events", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "plain turn", threadId: "t1", turnId: "turn-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.reasoning.size).toBe(0);
    await p.dispose();
  });
});


describe("engine reasoning persistence (F03)", () => {
  it("reasoning item lands as a persisted kind=reasoning message, done + restart-stable", async () => {
    const root = tmp("tivano-engreason-");
    const store = new Store(root);
    store.open();
    const bindings = new Map<string, ProviderThreadBinding>();
    const codex = new CodexAppServerProvider({
      config: cfg(),
      lookupBinding: (t) => bindings.get(t),
      bindThread: async (t, b) => {
        bindings.set(t, b);
        const th = store.state.threads.find((x) => x.id === t);
        if (th) {
          th.providerThread = b;
          store.update(() => {});
        }
      },
    });
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    const engine = new Engine(store, codex, root, "0.0.0-test", paths);
    const ws = tmp("tivano-codex-ws-");
    const proj = engine.createProject("p1");
    engine.registerWorkspace(proj.id, ws);
    const thread = engine.createThread(proj.id, "chat");
    engine.sendTurn(thread.id, "reason please");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      const st = t.turn?.status;
      return st === "done" || st === "error";
    });
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    const rm = t.messages.find((m) => m.kind === "reasoning")!;
    expect(rm.role).toBe("system");
    expect(rm.status).toBe("done");
    expect(rm.content).toBe("Considering the request — weighing options (done)");
    engine.shutdown();
    await codex.dispose();
    store.close();

    // Restart: the reasoning block reloads unchanged.
    const store2 = new Store(root);
    store2.open();
    const t2 = store2.state.threads.find((x) => x.id === thread.id)!;
    const rm2 = t2.messages.find((m) => m.kind === "reasoning")!;
    expect(rm2.content).toBe("Considering the request — weighing options (done)");
    store2.close();
  });
});

describe("plan/todos/tool items (F03)", () => {
  it("plan item streams deltas and the completed text is authoritative", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "plan the change", threadId: "t1", turnId: "turn-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.plans.size).toBe(1);
    const pi = [...c.plans.values()][0]!;
    expect(pi.done).toBe(true);
    expect(pi.text).toBe("## Fixture plan\n1. Survey\n2. Draft\n3. Verify");
    // The plan text never leaks into the assistant message.
    expect(c.message).toContain("fixture response: plan the change");
    expect(c.message).not.toContain("Fixture plan");
    await p.dispose();
  });

  it("turn/plan/updated delivers the whole step list each time", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "plan the change", threadId: "t1", turnId: "turn-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.todos.length).toBe(2);
    expect(c.todos[0]).toEqual([
      { text: "Survey the workspace", status: "done" },
      { text: "Draft the change", status: "active" },
      { text: "Verify and report", status: "pending" },
    ]);
    expect(c.todos[1]![2]).toEqual({ text: "Verify and report", status: "active" });
    await p.dispose();
  });

  it("mcpToolCall/webSearch/dynamicToolCall map to frozen tool kinds", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "plan the change", threadId: "t1", turnId: "turn-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    const byId = new Map<string, typeof c.tools>();
    for (const a of c.tools) {
      const arr = byId.get(a.itemId) ?? [];
      arr.push(a);
      byId.set(a.itemId, arr);
    }
    const pick = (prefix: string) =>
      [...byId.entries()].find(([id]) => id.startsWith(prefix))?.[1];
    const mcp = pick("item-mcp-")!;
    expect(mcp[0]!.status).toBe("started");
    expect(mcp[0]!.kind).toBe("mcp");
    expect(mcp[0]!.title).toBe("fixture-mcp · lookup");
    expect(mcp[1]!.status).toBe("completed");
    expect(mcp[1]!.detail).toBe("mcp fixture result");
    const web = pick("item-web-")!;
    expect(web[0]!.kind).toBe("web");
    expect(web[0]!.title).toBe("fixture plan search");
    expect(web[1]!.status).toBe("completed");
    const dyn = pick("item-dyn-")!;
    expect(dyn[0]!.kind).toBe("other");
    expect(dyn[0]!.title).toBe("fixtureDynamicTool");
    expect(dyn[1]!.status).toBe("completed");
    await p.dispose();
  });
});

describe("engine plan/tool persistence (F03)", () => {
  it("plan turn persists plan block, todos row and structured tool rows", async () => {
    const root = tmp("tivano-engplan-");
    const store = new Store(root);
    store.open();
    const bindings = new Map<string, ProviderThreadBinding>();
    const codex = new CodexAppServerProvider({
      config: cfg(),
      lookupBinding: (t) => bindings.get(t),
      bindThread: async (t, b) => {
        bindings.set(t, b);
        const th = store.state.threads.find((x) => x.id === t);
        if (th) {
          th.providerThread = b;
          store.update(() => {});
        }
      },
    });
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    const engine = new Engine(store, codex, root, "0.0.0-test", paths);
    const ws = tmp("tivano-codex-ws-");
    const proj = engine.createProject("p1");
    engine.registerWorkspace(proj.id, ws);
    const thread = engine.createThread(proj.id, "chat");
    engine.sendTurn(thread.id, "plan the change");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      const st = t.turn?.status;
      return st === "done" || st === "error";
    });
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    const pm = t.messages.find((m) => m.kind === "plan")!;
    expect(pm.status).toBe("done");
    expect(pm.content).toBe("## Fixture plan\n1. Survey\n2. Draft\n3. Verify");
    const tm = t.messages.find((m) => m.kind === "todos")!;
    expect(tm.steps).toEqual([
      { text: "Survey the workspace", status: "done" },
      { text: "Draft the change", status: "done" },
      { text: "Verify and report", status: "active" },
    ]);
    const toolMsgs = t.messages.filter((m) => m.kind === "tool");
    expect(toolMsgs.length).toBe(3);
    const mcpMsg = toolMsgs.find((m) => m.tool?.kind === "mcp")!;
    expect(mcpMsg.tool!.state).toBe("completed");
    expect(mcpMsg.tool!.title).toBe("fixture-mcp · lookup");
    expect(mcpMsg.tool!.detail).toBe("mcp fixture result");
    const assistant = t.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).not.toContain("Fixture plan");
    engine.shutdown();
    await codex.dispose();
    store.close();

    // Restart: plan/todos/tool rows reload unchanged.
    const store2 = new Store(root);
    store2.open();
    const t2 = store2.state.threads.find((x) => x.id === thread.id)!;
    expect(t2.messages.find((m) => m.kind === "plan")!.content).toContain("Fixture plan");
    expect(t2.messages.find((m) => m.kind === "todos")!.steps!.length).toBe(3);
    expect(t2.messages.filter((m) => m.kind === "tool").length).toBe(3);
    store2.close();
  });
});

describe("context usage (F19)", () => {
  it("thread/tokenUsage/updated delivers used + window verbatim", async () => {
    const { p } = provider();
    const { cb, c } = cbCollect();
    p.start(
      { prompt: "hello", threadId: "t1", turnId: "turn-1", workspace: grant() },
      cb,
    );
    await waitFor(() => c.done || c.errors.length > 0);
    expect(c.errors).toEqual([]);
    expect(c.usages).toEqual([
      { usedTokens: 12800, windowTokens: 128000, sessionTotalTokens: 45210 },
    ]);
    await p.dispose();
  });
});

describe("engine context usage persistence (F19)", () => {
  it("usage lands on the thread and survives restart", async () => {
    const root = tmp("tivano-engusage-");
    const store = new Store(root);
    store.open();
    const bindings = new Map<string, ProviderThreadBinding>();
    const codex = new CodexAppServerProvider({
      config: cfg(),
      lookupBinding: (t) => bindings.get(t),
      bindThread: async (t, b) => {
        bindings.set(t, b);
        const th = store.state.threads.find((x) => x.id === t);
        if (th) {
          th.providerThread = b;
          store.update(() => {});
        }
      },
    });
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    const engine = new Engine(store, codex, root, "0.0.0-test", paths);
    const ws = tmp("tivano-codex-ws-");
    const proj = engine.createProject("p1");
    engine.registerWorkspace(proj.id, ws);
    const thread = engine.createThread(proj.id, "chat");
    engine.sendTurn(thread.id, "hello");
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
      const st = t.turn?.status;
      return st === "done" || st === "error";
    });
    const t = engine.snapshot().threads.find((x) => x.id === thread.id)!;
    expect(t.contextUsage).toEqual({ usedTokens: 12800, windowTokens: 128000 });
    engine.shutdown();
    await codex.dispose();
    store.close();

    const store2 = new Store(root);
    store2.open();
    const t2 = store2.state.threads.find((x) => x.id === thread.id)!;
    expect(t2.contextUsage).toEqual({ usedTokens: 12800, windowTokens: 128000 });
    store2.close();
  });
});
