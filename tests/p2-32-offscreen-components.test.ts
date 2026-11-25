// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-32 shallow-component and measurement coverage: shown/hidden wiring in
// the real ChatView/HelperPanel/HydraPanel component functions, coordinator
// cache reuse across thread switches, memory-pressure healing, long-link
// stable-node reuse, and reproducible offscreen/panel publish counts.

import { describe, expect, it, vi, afterEach } from "vitest";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { ClientStore } from "../src/renderer/client";
import { renderMarkdownStreaming } from "../src/renderer/markdown";
import type { Snapshot } from "../src/shared/types";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const harnessBundle = buildSync({
  entryPoints: [join(root, "tests/helpers/p2-32-component-harness.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["react", "react/jsx-runtime"],
  write: false,
}).outputFiles[0]!.text;

type Cleanup = () => void;

function shallowHarness() {
  const effects: Array<() => unknown> = [];
  const fragment = Symbol("Fragment");
  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...(props ?? {}), children },
    }),
    Fragment: fragment,
    createContext: (value: unknown) => ({
      _value: value,
      Provider: (p: { children?: unknown }) => p.children,
      Consumer: (p: { children?: unknown }) => p.children,
    }),
    useContext: (ctx: { _value?: unknown }) => ctx?._value,
    useState: (value: unknown) => [
      typeof value === "function" ? (value as () => unknown)() : value,
      () => {},
    ],
    useRef: (value: unknown) => ({ current: value }),
    useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => unknown) => effects.push(fn),
    useLayoutEffect: (fn: () => unknown) => effects.push(fn),
    useReducer: (_reducer: unknown, initial: unknown) => [initial, () => {}],
    useCallback: (fn: unknown) => fn,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    useImperativeHandle: () => {},
    useDebugValue: () => {},
    useId: () => "shallow-id",
    useTransition: () => [false, (fn: () => void) => fn()],
    useDeferredValue: (value: unknown) => value,
    forwardRef: (fn: unknown) => fn,
    memo: (fn: unknown) => fn,
  };
  const jsxRuntime = {
    jsx: (type: unknown, props: unknown, key: unknown) => ({ type, props, key }),
    jsxs: (type: unknown, props: unknown, key: unknown) => ({ type, props, key }),
    Fragment: fragment,
  };
  const windowMock = {
    tivano: {
      invoke: async () => [],
      onEvent: () => () => {},
      platform: "win32",
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    getSelection: () => null,
  };
  const documentMock = {
    visibilityState: "visible",
    hasFocus: () => true,
    documentElement: { dataset: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  class ObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    console,
    URL,
    URLSearchParams,
    performance,
    window: windowMock,
    document: documentMock,
    navigator: { clipboard: { writeText: async () => {} } },
    ResizeObserver: ObserverMock,
    IntersectionObserver: ObserverMock,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: windowMock.requestAnimationFrame,
    cancelAnimationFrame: windowMock.cancelAnimationFrame,
    require: (name: string) => {
      if (name === "react") return fakeReact;
      if (name === "react/jsx-runtime") return jsxRuntime;
      throw new Error(`unexpected require ${name}`);
    },
  };
  runInNewContext(harnessBundle, sandbox, { timeout: 3000 });
  return {
    effects,
    exports: (sandbox.module as { exports: Record<string, any> }).exports,
  };
}

function runEffects(effects: Array<() => unknown>): Cleanup[] {
  const cleanups: Cleanup[] = [];
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup as Cleanup);
  }
  return cleanups;
}

function snap(rev: number, threads: Snapshot["threads"] = [], selectedThreadId: string | null = null): Snapshot {
  return {
    projects: [],
    threads,
    settings: { theme: "breeze", language: "en", alwaysAllow: [] },
    selectedThreadId,
    info: {
      appVersion: "t",
      baselineTag: "v3.0.0",
      baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
      dataRoot: "/tmp",
      providerId: "mock",
      providerLabel: "Mock",
      mock: true,
      mode: "mock",
      realCli: { status: "not-configured" },
      home: "/tmp",
      worktreesDir: "/tmp/worktrees",
    },
    rev,
    tokenActivity: {},
  };
}

function streamingThread(id: string, turnId: string, msgId: string) {
  return {
    id,
    projectId: null,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionGrants: [],
    messages: [{
      id: msgId,
      role: "assistant" as const,
      content: "old",
      status: "streaming" as const,
      ts: 1,
      turnId,
    }],
    turn: {
      id: turnId,
      threadId: id,
      status: "running" as const,
      seq: 2,
      startedAt: 1,
      assistantMessageId: msgId,
    },
  };
}

function quietThread(id: string) {
  return {
    id,
    projectId: null,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionGrants: [],
    messages: [],
  };
}

function notifyCount(store: { subscribe: (fn: () => void) => unknown }): () => number {
  let count = 0;
  store.subscribe(() => count++);
  return () => count;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("P2-32 shallow component wiring", () => {
  it("ChatView mount/unmount effects move the thread between panel pace and offscreen pace", () => {
    vi.useFakeTimers();
    const h = shallowHarness();
    const thread = streamingThread("t1", "u1", "m1");
    h.exports.clientStore.hydrate(snap(5, [thread as any]), h.exports.clientStore.beginHydration());
    const rendered = h.exports.ChatView({
      thread,
      threads: [thread],
      providerLabel: "Mock",
      mode: "mock",
    });
    expect(rendered.type).toBe("main");
    const cleanups = runEffects(h.effects);

    const count = notifyCount(h.exports.clientStore);
    h.exports.clientStore.apply({ type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "x", rev: 6 });
    vi.advanceTimersByTime(89);
    expect(count()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(count()).toBe(1); // mounted but unselected: shown panel cadence, not 1s offscreen

    for (const cleanup of cleanups) cleanup();
    h.exports.clientStore.apply({ type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 4, delta: "y", rev: 7 });
    vi.advanceTimersByTime(90);
    expect(count()).toBe(1); // unmounted: no 90ms panel publish
    vi.advanceTimersByTime(910);
    expect(count()).toBe(2); // the offscreen 1s flush still arrives
  });

  it("HelperPanel mount/unmount effects use the same shown-thread reporting", () => {
    vi.useFakeTimers();
    const h = shallowHarness();
    const thread = streamingThread("t-help", "u-help", "m-help");
    h.exports.clientStore.hydrate(snap(5, [thread as any]), h.exports.clientStore.beginHydration());
    h.exports.HelperPanel({
      thread,
      parentTitle: "lead",
      readOnly: false,
      onDock: () => {},
      onClose: () => {},
    });
    const cleanups = runEffects(h.effects);
    const count = notifyCount(h.exports.clientStore);
    h.exports.clientStore.apply({ type: "turn-chunk", threadId: "t-help", turnId: "u-help", seq: 3, delta: "x", rev: 6 });
    vi.advanceTimersByTime(90);
    expect(count()).toBe(1);
    for (const cleanup of cleanups) cleanup();
    h.exports.clientStore.apply({ type: "turn-chunk", threadId: "t-help", turnId: "u-help", seq: 4, delta: "y", rev: 7 });
    vi.advanceTimersByTime(90);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(910);
    expect(count()).toBe(2);
  });

  it("HydraPanel reports visible head timelines as shown", () => {
    vi.useFakeTimers();
    const h = shallowHarness();
    const lead = quietThread("lead");
    const head = {
      ...streamingThread("head-1", "u-head", "m-head"),
      hydraHead: {
        leadId: "lead",
        headIndex: 0,
        name: "Aster",
        task: "inspect",
        batchId: "batch",
        status: "running" as const,
      },
    };
    h.exports.clientStore.hydrate(snap(5, [lead as any, head as any]), h.exports.clientStore.beginHydration());
    h.exports.HydraPanel({ thread: lead, threads: [lead, head], readOnly: false });
    const cleanups = runEffects(h.effects);
    const count = notifyCount(h.exports.clientStore);
    h.exports.clientStore.apply({ type: "turn-chunk", threadId: "head-1", turnId: "u-head", seq: 3, delta: "x", rev: 6 });
    vi.advanceTimersByTime(90);
    expect(count()).toBe(1);
    for (const cleanup of cleanups) cleanup();
  });

  it("memory pressure empties coordinators without detaching the mounted thread map", () => {
    const h = shallowHarness();
    const thread = streamingThread("t-cache", "u-cache", "m-cache");
    h.exports.ChatView({ thread, threads: [thread], providerLabel: "Mock", mode: "mock" });
    runEffects(h.effects);
    const map = h.exports.mdCoordMapFor("t-cache");
    expect(map.size).toBe(1);
    const first = map.get("m-cache");
    expect(first).toBeDefined();

    h.exports.emitMemoryPressure(false);
    expect(first.isDisposed).toBe(true);
    expect(map.size).toBe(0);
    expect(h.exports.mdCoordMapFor("t-cache")).toBe(map); // still anchored, not detached

    const replacement = h.exports.mdCoordEntry(map, "m-cache", () => {});
    replacement.parse("replacement text", undefined, null);
    h.exports.emitMemoryPressure(false);
    expect(replacement.isDisposed).toBe(true); // a second flush sees the same mounted map
    expect(h.exports.mdCoordMapFor("t-cache")).toBe(map);
  });

  it("reuses per-thread coordinator maps across switches and evicts only the oldest thread", () => {
    const h = shallowHarness();
    const first = h.exports.mdCoordMapFor("t1");
    const firstCoord = h.exports.mdCoordEntry(first, "m1", () => {});
    h.exports.mdCoordMapFor("t2");
    expect(h.exports.mdCoordMapFor("t1")).toBe(first);
    expect(first.get("m1")).toBe(firstCoord);

    const evicting = shallowHarness();
    const victim = evicting.exports.mdCoordMapFor("v1");
    const victimCoord = evicting.exports.mdCoordEntry(victim, "m", () => {});
    for (const id of ["v2", "v3", "v4"]) evicting.exports.mdCoordMapFor(id);
    evicting.exports.mdCoordMapFor("v5");
    expect(victimCoord.isDisposed).toBe(true);
    expect(evicting.exports.mdCoordMapFor("v1")).not.toBe(victim);
    expect(evicting.exports.MD_COORD_CACHE_MAX).toBe(4);
  });
});

describe("P2-32 measurements and long-link stability", () => {
  it("records reproducible P2-32 synthetic measurements", () => {
    const longLinkParagraph =
      "[release notes](https://example.com/release) " +
      Array.from({ length: 36 }, (_, i) => `word${i} [link${i}](https://example.com/${i})`).join(" ");
    const base = `${longLinkParagraph}\n\n## next\n\ntail`;
    const initialStart = performance.now();
    let parsed = renderMarkdownStreaming(base, undefined, null, null);
    const initialMs = performance.now() - initialStart;
    expect(parsed.state.stableNodes.length).toBeGreaterThan(0);
    const stableLinkNode = parsed.nodes[0];

    let source = base;
    let reusedEveryAppend = true;
    const appendStart = performance.now();
    for (let i = 0; i < 24; i++) {
      source += ` more${i}`;
      const next = renderMarkdownStreaming(source, undefined, parsed.state, null);
      if (next.nodes[0] !== stableLinkNode) reusedEveryAppend = false;
      parsed = next;
    }
    const appendTotalMs = performance.now() - appendStart;
    expect(reusedEveryAppend).toBe(true); // the long link paragraph is never re-rendered or re-measured

    vi.useFakeTimers();
    const hidden = streamingThread("t-hidden", "u-hidden", "m-hidden");
    const panel = streamingThread("t-panel", "u-panel", "m-panel");
    const store = new ClientStore(async () => ({}));
    store.hydrate(snap(5, [hidden as any, panel as any]), store.beginHydration());
    let notifies = 0;
    store.subscribe(() => notifies++);

    for (let i = 0; i < 200; i++) {
      store.apply({ type: "turn-chunk", threadId: "t-hidden", turnId: "u-hidden", seq: 3 + i, delta: "x", rev: 10 + i });
    }
    const unseenImmediateNotifies = notifies;
    vi.advanceTimersByTime(1000);
    const unseenFlushedNotifies = notifies;

    store.noteTimelineShown("t-panel", true);
    const panelBefore = notifies;
    for (let i = 0; i < 20; i++) {
      store.apply({ type: "turn-chunk", threadId: "t-panel", turnId: "u-panel", seq: 3 + i, delta: "p", rev: 300 + i });
    }
    vi.advanceTimersByTime(90);
    const panelNotifies = notifies - panelBefore;

    store.apply({ type: "turn-chunk", threadId: "t-hidden", turnId: "u-hidden", seq: 203, delta: "catch", rev: 400 });
    const catchBefore = notifies;
    store.noteTimelineShown("t-hidden", true);
    const catchUpNotifies = notifies - catchBefore;

    expect(unseenImmediateNotifies).toBe(0);
    expect(unseenFlushedNotifies).toBe(1);
    expect(panelNotifies).toBe(1);
    expect(catchUpNotifies).toBe(1);

    console.info(
      `P2-32_METRICS=${JSON.stringify({
        longLinkInitialParseMs: Number(initialMs.toFixed(3)),
        longLinkAppend24ParseMs: Number(appendTotalMs.toFixed(3)),
        longLinkStableNodeReused: reusedEveryAppend,
        unseenChunks: 200,
        unseenImmediateNotifies,
        unseenFlushedNotifies,
        panelChunks: 20,
        panelWindowMs: 90,
        panelNotifies,
        catchUpNotifies,
      })}`,
    );
  });
});
