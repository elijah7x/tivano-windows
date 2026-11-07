// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Renderer client: subscribe-before-hydrate event buffering, revision
// boundaries, hydration generation invalidation, per-thread drafts with
// version-guarded clearing and consumed rejections.

import { describe, expect, it, vi } from "vitest";
import { ClientStore } from "../src/renderer/client";
import type { Snapshot } from "../src/shared/types";

function snap(rev: number, threads: Snapshot["threads"] = []): Snapshot {
  return {
    projects: [],
    threads,
    settings: { theme: "breeze", language: "en", alwaysAllow: [] },
    selectedThreadId: null,
    info: {
      appVersion: "t",
      baselineTag: "v2.0.0",
      baselineCommit: "x",
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

describe("hydration and revision boundaries", () => {
  it("buffers events until the snapshot lands, then applies only newer ones", () => {
    const store = new ClientStore(async () => ({}));
    const gen = store.beginHydration();
    // Events arriving while state:get is in flight are buffered, not lost.
    store.onBridgeEvent({
      type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "NEW", rev: 6,
    });
    store.onBridgeEvent({
      type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 9, delta: "STALE", rev: 4,
    });
    const s = snap(5, [streamingThread("t1", "u1", "m1")]);
    store.hydrate(s, gen);
    const msg = store.thread("t1")!.messages[0]!;
    // rev=6 > snapshot rev=5 applies; rev=4 was already inside the snapshot.
    expect(msg.content).toBe("oldNEW");
  });

  it("drops post-hydration events at or below the snapshot revision", () => {
    const store = new ClientStore(async () => ({}));
    const gen = store.beginHydration();
    store.hydrate(snap(5, [streamingThread("t1", "u1", "m1")]), gen);
    store.onBridgeEvent({
      type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 9, delta: "OLD", rev: 5,
    });
    store.onBridgeEvent({
      type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "NEW", rev: 6,
    });
    expect(store.thread("t1")!.messages[0]!.content).toBe("oldNEW");
  });

  it("does not roll settings back when an older event arrives after a newer one", () => {
    const store = new ClientStore(async () => ({}));
    store.hydrate(snap(5), store.beginHydration());
    store.onBridgeEvent({ type: "settings-changed", rev: 7,
      settings: { theme: "dark", language: "en", alwaysAllow: [] } });
    store.onBridgeEvent({ type: "settings-changed", rev: 6,
      settings: { theme: "light", language: "en", alwaysAllow: [] } });
    expect(store.snapshot!.settings.theme).toBe("dark");
    expect(store.snapshot!.rev).toBe(7);
  });

  it("ignores a superseded hydration cycle (StrictMode remount)", () => {
    const store = new ClientStore(async () => ({}));
    const gen1 = store.beginHydration();
    const gen2 = store.beginHydration();
    const stale = snap(1, [streamingThread("dead", "u0", "m0")]);
    store.hydrate(stale, gen1); // a gen1 resolve landing after gen2 began
    expect(store.snapshot).toBeNull();
    store.hydrate(snap(7), gen2);
    expect(store.snapshot).not.toBeNull();
    expect(store.thread("dead")).toBeUndefined();
  });
});

describe("per-thread drafts", () => {
  it("keeps drafts isolated per thread", () => {
    const store = new ClientStore(async () => ({}));
    store.setDraft("t1", "hello");
    store.setDraft("t2", "world");
    expect(store.draft("t1")).toBe("hello");
    expect(store.draft("t2")).toBe("world");
  });

  it("clears the submitted draft version on success", async () => {
    const invoke = vi.fn(async () => ({}));
    const store = new ClientStore(invoke);
    store.setDraft("t1", "hello");
    await store.sendDraft("t1");
    expect(invoke).toHaveBeenCalledWith("turns:send", { threadId: "t1", text: "hello" });
    expect(store.draft("t1")).toBe("");
    expect(store.lastError).toBeNull();
  });

  it("keeps text typed while a send was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const invoke = vi.fn(async () => {
      await gate;
      return {};
    });
    const store = new ClientStore(invoke);
    store.setDraft("t1", "first");
    const send = store.sendDraft("t1");
    store.setDraft("t1", "first + more typed mid-flight");
    release();
    await send;
    expect(store.draft("t1")).toBe("first + more typed mid-flight");
  });

  it("keeps the draft and surfaces the error when a send fails", async () => {
    const store = new ClientStore(async () => {
      throw new Error("engine down");
    });
    store.setDraft("t1", "keep me");
    await store.sendDraft("t1"); // must not reject
    expect(store.draft("t1")).toBe("keep me");
    expect(store.lastError).toBe("engine down");
  });

  it("refuses a second send for the same thread while one is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const invoke = vi.fn(async () => {
      await gate;
      return {};
    });
    const store = new ClientStore(invoke);
    store.setDraft("t1", "a");
    const p1 = store.sendDraft("t1");
    const p2 = store.sendDraft("t1");
    release();
    await Promise.all([p1, p2]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("drops draft and pending state when the thread is removed", () => {
    const store = new ClientStore(async () => ({}));
    const gen = store.beginHydration();
    store.hydrate(snap(1, [streamingThread("t1", "u1", "m1")]), gen);
    store.setDraft("t1", "orphaned");
    store.apply({ type: "thread-removed", threadId: "t1" });
    expect(store.draft("t1")).toBe("");
    expect(store.isPending("t1")).toBe(false);
  });
});
