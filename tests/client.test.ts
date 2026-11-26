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
      settings: { theme: "nord", language: "en", alwaysAllow: [] } });
    store.onBridgeEvent({ type: "settings-changed", rev: 6,
      settings: { theme: "github", language: "en", alwaysAllow: [] } });
    expect(store.snapshot!.settings.theme).toBe("nord");
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

describe("P2-51 system-accent-changed event", () => {
  it("updates snapshot.info.systemAccentColor and notifies subscribers after hydration", () => {
    const store = new ClientStore(async () => ({}));
    const s = snap(5);
    s.info.systemAccentColor = "0078D4";
    store.hydrate(s, store.beginHydration());

    let notified = 0;
    const unsub = store.subscribe(() => {
      notified += 1;
    });
    store.onBridgeEvent({ type: "system-accent-changed", accentColor: "D13438" });
    unsub();

    expect(notified).toBe(1);
    expect(store.snapshot!.info.systemAccentColor).toBe("D13438");
  });

  it("retains pre-hydration system-accent-changed updates when the snapshot lands", () => {
    const store = new ClientStore(async () => ({}));
    const gen = store.beginHydration();
    store.onBridgeEvent({ type: "system-accent-changed", accentColor: "E81123" });

    const s = snap(5);
    s.info.systemAccentColor = "0078D4";
    store.hydrate(s, gen);

    expect(store.snapshot!.info.systemAccentColor).toBe("E81123");
  });
});

describe("P2-01 ClientStore composer predictions", () => {
  it("requests a prediction on turn completion, accepts it into draft, and dismisses on typing", async () => {
    const invoke = vi.fn(async (ch: string) => {
      if (ch === "threads:predict-next") return { prediction: "Run the unit tests" };
      return {};
    });
    const store = new ClientStore(invoke);
    store.hydrate(snap(1, [streamingThread("t1", "u1", "m1")]), store.beginHydration());

    store.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith("threads:predict-next", { threadId: "t1", turnId: "u1" });
    expect(store.prediction("t1")).toBe("Run the unit tests");

    expect(store.acceptPrediction("t1")).toBe(true);
    expect(store.prediction("t1")).toBeUndefined();
    expect(store.draft("t1")).toBe("Run the unit tests");

    // Next completed turn: typing dismisses prediction and sends only what was typed.
    store.setDraft("t1", "");
    store.apply({ type: "thread-updated", thread: streamingThread("t1", "u2", "m2") });
    store.apply({ type: "turn-status", threadId: "t1", turnId: "u2", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.prediction("t1")).toBe("Run the unit tests");

    store.setDraft("t1", "my own prompt");
    expect(store.prediction("t1")).toBeUndefined();
    await store.sendDraft("t1");
    expect(invoke).toHaveBeenCalledWith("turns:send", { threadId: "t1", text: "my own prompt" });
  });

  it("skips prediction when textGeneration is off or draft is non-empty, and clears on settings change", async () => {
    const invoke = vi.fn(async (ch: string) => {
      if (ch === "threads:predict-next") return { prediction: "Suggested" };
      return {};
    });
    const store = new ClientStore(invoke);
    const s = snap(1, [streamingThread("t1", "u1", "m1"), streamingThread("t2", "u2", "m2")]);
    s.settings.textGeneration = "off";
    store.hydrate(s, store.beginHydration());

    store.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    expect(store.prediction("t1")).toBeUndefined();

    // Re-enable textGeneration, verify non-empty draft skips request.
    store.apply({
      type: "settings-changed",
      settings: { ...s.settings, textGeneration: "automatic" },
    });
    store.setDraft("t2", "already typing");
    store.apply({ type: "turn-status", threadId: "t2", turnId: "u2", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();

    // Empty draft requests prediction, then switching to off clears it.
    store.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.prediction("t1")).toBe("Suggested");
    store.apply({
      type: "settings-changed",
      settings: { ...s.settings, textGeneration: "off" },
    });
    expect(store.prediction("t1")).toBeUndefined();
  });

  it("swallows prediction failures without surfacing an error or blocking the next send", async () => {
    const invoke = vi.fn(async (ch: string) => {
      if (ch === "threads:predict-next") throw new Error("prediction failed");
      return {};
    });
    const store = new ClientStore(invoke);
    store.hydrate(snap(1, [streamingThread("t1", "u1", "m1")]), store.beginHydration());

    store.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.prediction("t1")).toBeUndefined();
    expect(store.lastError).toBeNull();

    store.setDraft("t1", "next message");
    await store.sendDraft("t1");
    expect(invoke).toHaveBeenCalledWith("turns:send", { threadId: "t1", text: "next message" });
    expect(store.lastError).toBeNull();
  });

  it("suppresses prediction when readOnly, survives synchronous invoke throws, and supports dismissPrediction", async () => {
    const syncThrowInvoke = vi.fn(() => {
      throw new Error("bridge missing");
    });
    const store1 = new ClientStore(syncThrowInvoke);
    store1.hydrate(snap(1, [streamingThread("t1", "u1", "m1")]), store1.beginHydration());
    store1.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store1.prediction("t1")).toBeUndefined();
    expect(store1.lastError).toBeNull();

    const roInvoke = vi.fn(async () => ({ prediction: "Should not run" }));
    const store2 = new ClientStore(roInvoke);
    const roSnap = snap(1, [streamingThread("t1", "u1", "m1")]);
    roSnap.readOnly = true;
    store2.hydrate(roSnap, store2.beginHydration());
    store2.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(roInvoke).not.toHaveBeenCalled();

    const okStore = new ClientStore(async () => ({ prediction: "Dismiss me" }));
    okStore.hydrate(snap(1, [streamingThread("t1", "u1", "m1")]), okStore.beginHydration());
    okStore.apply({ type: "turn-status", threadId: "t1", turnId: "u1", status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(okStore.prediction("t1")).toBe("Dismiss me");
    okStore.dismissPrediction("t1");
    expect(okStore.prediction("t1")).toBeUndefined();
  });
});
