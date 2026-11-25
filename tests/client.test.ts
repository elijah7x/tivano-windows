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

  it("keeps the in-flight draft when its own send rolls back mid-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const invoke = vi.fn(async (c: string) => {
      if (c === "turns:send") await gate;
      return {};
    });
    const store = new ClientStore(invoke);
    const gen = store.beginHydration();
    store.hydrate(snap(1), gen);
    store.setDraft("t1", "hello");
    const send = store.sendDraft("t1");
    // The engine's turn-unsent lands BEFORE the turns:send reply — the
    // composer still holds exactly the rolled-back draft.
    store.apply({ type: "turn-unsent", threadId: "t1", text: "hello" });
    release();
    await send;
    expect(store.draft("t1")).toBe("hello");
    expect(invoke.mock.calls.some(([c]) => c === "followUps:enqueue")).toBe(false);
  });

  it("queues the rolled-back text when the composer moved on mid-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const invoke = vi.fn(async (c: string) => {
      if (c === "turns:send") await gate;
      return {};
    });
    const store = new ClientStore(invoke);
    const gen = store.beginHydration();
    store.hydrate(snap(1), gen);
    store.setDraft("t1", "first");
    const send = store.sendDraft("t1");
    store.setDraft("t1", "typed while in flight");
    store.apply({ type: "turn-unsent", threadId: "t1", text: "first" });
    release();
    await send;
    expect(store.draft("t1")).toBe("typed while in flight");
    expect(invoke).toHaveBeenCalledWith("followUps:enqueue", {
      threadId: "t1",
      text: "first",
      front: true,
    });
  });

  it("restores a late rollback (no send in flight) to an empty composer", async () => {
    const invoke = vi.fn(async (_c: string) => ({}));
    const store = new ClientStore(invoke);
    const gen = store.beginHydration();
    store.hydrate(snap(1), gen);
    store.apply({ type: "turn-unsent", threadId: "t1", text: "back" });
    expect(store.draft("t1")).toBe("back");
    expect(invoke.mock.calls.some(([c]) => c === "followUps:enqueue")).toBe(false);
  });
});

describe("P2-32 off-screen stream coalescing (frozen offscreenFlush)", () => {
  function streamStore(): ClientStore {
    const store = new ClientStore(async () => ({}));
    const gen = store.beginHydration();
    store.hydrate(snap(5, [streamingThread("t1", "u1", "m1")]), gen);
    return store;
  }

  function notifies(store: ClientStore): () => number {
    let n = 0;
    store.subscribe(() => n++);
    return () => n;
  }

  it("coalesces unseen turn-chunks to one publish per off-screen window", () => {
    vi.useFakeTimers();
    try {
      const store = streamStore();
      const count = notifies(store);
      for (let seq = 3; seq <= 12; seq++) {
        store.apply({
          type: "turn-chunk", threadId: "t1", turnId: "u1", seq, delta: "x", rev: 100 + seq,
        });
      }
      expect(count()).toBe(0); // nothing repaints mid-window
      expect(store.thread("t1")!.messages[0]!.content).toBe("old" + "x".repeat(10));
      vi.advanceTimersByTime(999);
      expect(count()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(count()).toBe(1); // ~1 s cadence, a single publish for all ten
      // The next window coalesces independently.
      for (let seq = 13; seq <= 20; seq++) {
        store.apply({
          type: "turn-chunk", threadId: "t1", turnId: "u1", seq, delta: "y", rev: 100 + seq,
        });
      }
      vi.advanceTimersByTime(1000);
      expect(count()).toBe(2);
      expect(store.thread("t1")!.messages[0]!.content).toBe("old" + "x".repeat(10) + "y".repeat(8));
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes every chunk immediately while the timeline is shown", () => {
    const store = streamStore();
    store.apply({ type: "thread-selected", threadId: "t1", rev: 6 });
    store.noteTimelineShown("t1", true);
    const count = notifies(store);
    for (let seq = 3; seq <= 7; seq++) {
      store.apply({
        type: "turn-chunk", threadId: "t1", turnId: "u1", seq, delta: "x", rev: 100 + seq,
      });
    }
    expect(count()).toBe(5);
  });

  it("paces a shown-but-unselected timeline (open panel) to ~90ms", () => {
    vi.useFakeTimers();
    try {
      const store = streamStore();
      store.noteTimelineShown("t1", true); // mounted panel, not the selected chat
      const count = notifies(store);
      for (let seq = 3; seq <= 7; seq++) {
        store.apply({
          type: "turn-chunk", threadId: "t1", turnId: "u1", seq, delta: "x", rev: 100 + seq,
        });
      }
      expect(count()).toBe(0); // coalesced, not per-chunk
      vi.advanceTimersByTime(90);
      expect(count()).toBe(1); // a single publish for the window
      expect(store.thread("t1")!.messages[0]!.content).toBe("old" + "x".repeat(5));
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending unseen updates the moment the timeline is shown", () => {
    const store = streamStore();
    const count = notifies(store);
    store.apply({
      type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "NEW", rev: 6,
    });
    expect(count()).toBe(0);
    store.noteTimelineShown("t1", true); // frozen: becoming shown flushes now
    expect(count()).toBe(1);
    expect(store.thread("t1")!.messages[0]!.content).toBe("oldNEW");
  });

  it("an immediate event publishes the pending unseen chunk with it", () => {
    vi.useFakeTimers();
    try {
      const store = streamStore();
      const count = notifies(store);
      store.apply({
        type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "NEW", rev: 6,
      });
      store.apply({
        type: "turn-status", threadId: "t1", turnId: "u1", status: "done", rev: 7,
      });
      expect(count()).toBe(1); // the status publish carried the chunk
      expect(store.thread("t1")!.messages[0]!.content).toBe("oldNEW");
      vi.advanceTimersByTime(5000);
      expect(count()).toBe(1); // no duplicate deferred flush
    } finally {
      vi.useRealTimers();
    }
  });

  it("still drops late/duplicate seq without scheduling a flush", () => {
    vi.useFakeTimers();
    try {
      const store = streamStore();
      const count = notifies(store);
      store.apply({
        type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 2, delta: "OLD", rev: 6,
      });
      vi.advanceTimersByTime(5000);
      expect(count()).toBe(0);
      expect(store.thread("t1")!.messages[0]!.content).toBe("old");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles per thread: a hidden helper defers while the chat stays live", () => {
    vi.useFakeTimers();
    try {
      const store = new ClientStore(async () => ({}));
      const gen = store.beginHydration();
      store.hydrate(
        snap(5, [streamingThread("t1", "u1", "m1"), streamingThread("t2", "u2", "m2")]),
        gen,
      );
      store.apply({ type: "thread-selected", threadId: "t1", rev: 6 });
      store.noteTimelineShown("t1", true);
      const count = notifies(store);
      store.apply({
        type: "turn-chunk", threadId: "t2", turnId: "u2", seq: 3, delta: "b", rev: 7,
      });
      expect(count()).toBe(0);
      store.apply({
        type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "a", rev: 8,
      });
      expect(count()).toBe(1); // the shown chunk lands t2's pending text too
      expect(store.thread("t2")!.messages[0]!.content).toBe("oldb");
    } finally {
      vi.useRealTimers();
    }
  });

  it("window-activity flushes shown-panel and offscreen pacing in one publish", () => {
    vi.useFakeTimers();
    try {
      const store = new ClientStore(async () => ({}));
      store.hydrate(
        snap(5, [streamingThread("t1", "u1", "m1"), streamingThread("t2", "u2", "m2")]),
        store.beginHydration(),
      );
      store.noteTimelineShown("t1", true); // shown panel, still unselected
      const count = notifies(store);
      store.apply({ type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "a", rev: 6 });
      store.apply({ type: "turn-chunk", threadId: "t2", turnId: "u2", seq: 3, delta: "b", rev: 7 });
      expect(count()).toBe(0);
      store.onBridgeEvent({ type: "window-activity", active: true } as never);
      expect(count()).toBe(1); // both pacing paths shared this one publish
      expect(store.thread("t1")!.messages[0]!.content).toBe("olda");
      expect(store.thread("t2")!.messages[0]!.content).toBe("oldb");
      vi.advanceTimersByTime(2000);
      expect(count()).toBe(1); // neither timer fires a duplicate later
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrate clears a straddling offscreen timer", () => {
    vi.useFakeTimers();
    try {
      const store = streamStore();
      store.apply({ type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "NEW", rev: 6 });
      const count = notifies(store);
      store.hydrate(snap(7, [streamingThread("t1", "u1", "m1")]), store.beginHydration());
      expect(count()).toBe(1); // hydration's own publish
      vi.advanceTimersByTime(5000);
      expect(count()).toBe(1); // no stale offscreen timer publishes again
    } finally {
      vi.useRealTimers();
    }
  });

  it("reference-counts overlapping shown timelines before dropping to offscreen pace", () => {
    vi.useFakeTimers();
    try {
      const store = streamStore();
      store.noteTimelineShown("t1", true);
      store.noteTimelineShown("t1", true);
      store.noteTimelineShown("t1", false);
      const count = notifies(store);
      store.apply({ type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 3, delta: "x", rev: 6 });
      vi.advanceTimersByTime(90);
      expect(count()).toBe(1); // one shown mount remains: panel pace
      store.noteTimelineShown("t1", false);
      store.apply({ type: "turn-chunk", threadId: "t1", turnId: "u1", seq: 4, delta: "y", rev: 7 });
      vi.advanceTimersByTime(90);
      expect(count()).toBe(1);
      vi.advanceTimersByTime(910);
      expect(count()).toBe(2); // all mounts gone: offscreen pace
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("finish-signal notification visibility (P2-62)", () => {
  function withDomMocks(opts: {
    focused: boolean;
    permission?: "granted" | "default" | "denied";
    requestRejects?: boolean;
  }) {
    const prevNotification = (globalThis as { Notification?: unknown }).Notification;
    const prevDocument = (globalThis as { document?: unknown }).document;
    const sent: { title: string; body?: string; tag?: string; silent?: boolean }[] = [];
    class MockNotification {
      static permission = opts.permission ?? "granted";
      static requestPermission = vi.fn(() =>
        opts.requestRejects
          ? Promise.reject(new Error("permission error"))
          : Promise.resolve("denied"),
      );
      onclick: (() => void) | null = null;
      constructor(
        title: string,
        init?: { body?: string; tag?: string; silent?: boolean },
      ) {
        sent.push({ title, ...init });
      }
    }
    (globalThis as { Notification: unknown }).Notification = MockNotification;
    (globalThis as { document: unknown }).document = {
      hasFocus: () => opts.focused,
    };
    return {
      sent,
      MockNotification,
      restore: () => {
        if (prevNotification === undefined) {
          delete (globalThis as { Notification?: unknown }).Notification;
        } else {
          (globalThis as { Notification: unknown }).Notification = prevNotification;
        }
        if (prevDocument === undefined) {
          delete (globalThis as { document?: unknown }).document;
        } else {
          (globalThis as { document: unknown }).document = prevDocument;
        }
      },
    };
  }

  it("notifies for an unselected thread when focused and permission is granted", () => {
    const mocks = withDomMocks({ focused: true });
    try {
      const store = new ClientStore(async () => ({}));
      const s = snap(1, [
        streamingThread("t1", "u1", "m1"),
        streamingThread("t2", "u2", "m2"),
      ]);
      s.selectedThreadId = "t1";
      store.hydrate(s, store.beginHydration());
      store.apply({
        type: "finish-signal",
        threadId: "t2",
        status: "done",
        chime: false,
        notify: "done",
        silent: false,
      });
      expect(mocks.sent).toHaveLength(1);
      expect(mocks.sent[0]).toMatchObject({
        title: "t2",
        body: "Turn finished",
        silent: false,
      });
    } finally {
      mocks.restore();
    }
  });

  it("suppresses notifications for the selected thread or an open helper panel while focused", () => {
    const mocks = withDomMocks({ focused: true });
    try {
      const store = new ClientStore(async () => ({}));
      const parent = streamingThread("p1", "u1", "m1");
      const helper = {
        ...streamingThread("h1", "u2", "m2"),
        parentThreadId: "p1",
        isInPanel: true,
      };
      const closedHelper = {
        ...streamingThread("h2", "u3", "m3"),
        parentThreadId: "p1",
        isInPanel: false,
      };
      const s = snap(1, [parent, helper, closedHelper]);
      s.selectedThreadId = "p1";
      store.hydrate(s, store.beginHydration());

      store.apply({
        type: "finish-signal",
        threadId: "p1",
        status: "done",
        chime: false,
        notify: "done",
        silent: false,
      });
      store.apply({
        type: "finish-signal",
        threadId: "h1",
        status: "done",
        chime: false,
        notify: "done",
        silent: false,
      });
      expect(mocks.sent).toHaveLength(0);

      // A closed helper dropped to the sidebar is no longer on screen, so it notifies.
      store.apply({
        type: "finish-signal",
        threadId: "h2",
        status: "done",
        chime: false,
        notify: "done",
        silent: false,
      });
      expect(mocks.sent).toHaveLength(1);
      expect(mocks.sent[0]?.title).toBe("h2");
    } finally {
      mocks.restore();
    }
  });

  it("never notifies for a hydraHead thread and swallows requestPermission rejections", async () => {
    const mocks = withDomMocks({
      focused: false,
      permission: "default",
      requestRejects: true,
    });
    try {
      const store = new ClientStore(async () => ({}));
      const head = {
        ...streamingThread("head1", "u1", "m1"),
        hydraHead: {
          leadId: "lead1",
          headIndex: 0,
          name: "Hank",
          task: "work",
          batchId: "b1",
          status: "completed" as const,
          spawnedAt: 1,
        },
      };
      const plain = streamingThread("plain1", "u2", "m2");
      const s = snap(1, [head, plain]);
      s.selectedThreadId = "lead1";
      store.hydrate(s, store.beginHydration());

      store.apply({
        type: "finish-signal",
        threadId: "head1",
        status: "done",
        chime: false,
        notify: "done",
        silent: false,
      });
      expect(mocks.MockNotification.requestPermission).not.toHaveBeenCalled();

      store.apply({
        type: "finish-signal",
        threadId: "plain1",
        status: "done",
        chime: false,
        notify: "done",
        silent: false,
      });
      expect(mocks.MockNotification.requestPermission).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(mocks.sent).toHaveLength(0);
    } finally {
      mocks.restore();
    }
  });
});
