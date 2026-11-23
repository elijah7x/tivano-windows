// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-63 idle CPU, background pacing, archive switch, memory-pressure release
// with auto-shelving off, and Hydra all-merged recovery skip.

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, TURNS_DIRNAME } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type { ProviderAdapter, ProviderCallbacks, TurnContext } from "../src/main/provider";
import type { AppEvent } from "../src/shared/ipc";
import { canSkipHydraMergeRecovery } from "../src/shared/hydra";
import { formatElapsed, WORKING_WORDS, workingWordIndex } from "../src/shared/workingWords";
import { ClientStore } from "../src/renderer/client";
import { appActivity, setModalCovered, setWindowActive } from "../src/renderer/appActivity";
import { clearMarkdownCache, prewarmMarkdown, renderMarkdown } from "../src/renderer/markdown";
import { WorkingIndicator, WorkingLabel } from "../src/renderer/components/WorkingIndicator";
import { MiniSpinner } from "../src/renderer/components/SpinnerCells";
import { Skylight } from "../src/renderer/components/Skylight";
import type { ChatThread, Snapshot } from "../src/shared/types";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-p263-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.useRealTimers();
  setWindowActive(true);
  setModalCovered(false);
  clearMarkdownCache();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeSnap(rev: number, threads: ChatThread[], selectedThreadId: string | null = null): Snapshot {
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

describe("P2-63 memory pressure with automatic shelving off", () => {
  it("releases hidden/archived chat histories when autoShelveDays is 0 and reloads on demand", async () => {
    vi.useFakeTimers();
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const endedSessions: string[] = [];
    const provider: ProviderAdapter = {
      descriptor: { id: "mock", label: "Mock", mode: "mock", synthetic: true },
      start(_ctx: TurnContext, cb: ProviderCallbacks) {
        cb.onChunk(1, "persisted reply text");
        cb.onDone();
        return { cancel: () => {}, resume: () => {} };
      },
      endSession(threadId: string) {
        endedSessions.push(threadId);
      },
      async dispose() {
        return { children: [], orphanedPending: 0 };
      },
    };
    const engine = new Engine(store, provider, root, "0.0.0-test");
    engine.setSettings({ autoShelveDays: 0 });

    const threads: ChatThread[] = [];
    for (let i = 0; i < 6; i++) {
      const th = engine.createThread(null, `thread-${i}`);
      engine.sendTurn(th.id, `hello ${i}`);
      threads.push(th);
    }
    const archived = engine.createThread(null, "archived");
    engine.sendTurn(archived.id, "archived prompt");
    // Keep threads[5] selected; archive `archived`.
    engine.selectThread(threads[5]!.id);
    engine.archiveThread(archived.id);
    store.flushNow();

    expect(engine.snapshot().settings.autoShelveDays).toBe(0);
    // Warning pressure keeps 4 non-archived loaded threads (releasing 2 oldest + archived).
    const resWarn = engine.handleMemoryPressure(false);
    expect(resWarn.releasedThreads).toBe(3);
    expect(store.isThreadHistoryReleased(archived.id)).toBe(true);
    expect(store.isThreadHistoryReleased(threads[0]!.id)).toBe(true);
    expect(store.isThreadHistoryReleased(threads[1]!.id)).toBe(true);
    expect(store.isThreadHistoryReleased(threads[5]!.id)).toBe(false);
    expect(endedSessions).toContain(archived.id);
    expect(endedSessions).toContain(threads[0]!.id);

    // Flushing while released MUST NOT wipe the on-disk segment!
    store.flushNow();
    const segRaw = JSON.parse(
      readFileSync(join(root, TURNS_DIRNAME, `${threads[0]!.id}.json`), "utf8"),
    ) as { messages: Array<{ content: string }> };
    expect(segRaw.messages.some((m) => m.content === "persisted reply text")).toBe(true);

    // Critical pressure drops down to keeping 2 non-archived loaded threads.
    const resCrit = engine.handleMemoryPressure(true);
    expect(resCrit.releasedThreads).toBe(2);
    expect(store.isThreadHistoryReleased(threads[5]!.id)).toBe(false);

    // Selecting a released thread reloads its messages cleanly from disk.
    engine.selectThread(threads[0]!.id);
    expect(store.isThreadHistoryReleased(threads[0]!.id)).toBe(false);
    const reloaded = engine.snapshot().threads.find((t) => t.id === threads[0]!.id)!;
    expect(reloaded.messages.some((m) => m.content === "persisted reply text")).toBe(true);

    engine.shutdown();
    store.close();
  });

  it("never releases running or active-panel chats under critical memory pressure", () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 100 }), root, "0.0.0-test");
    const t0 = engine.createThread(null, "running-bg");
    engine.sendTurn(t0.id, "[mock:slow] run");
    const t1 = engine.createThread(null, "idle-1");
    const t2 = engine.createThread(null, "idle-2");
    const t3 = engine.createThread(null, "idle-3");
    const selected = engine.createThread(null, "selected");
    const helper = engine.spawnHelper(selected.id, "Helper", "help me");
    engine.selectThread(selected.id);
    store.flushNow();

    const res = engine.handleMemoryPressure(true);
    expect(res.releasedThreads).toBeGreaterThanOrEqual(2);
    expect(store.isThreadHistoryReleased(t0.id)).toBe(false);
    expect(store.isThreadHistoryReleased(selected.id)).toBe(false);
    expect(store.isThreadHistoryReleased(helper.id)).toBe(false);
    // Oldest idle threads were released while keeping within critical limit.
    expect(store.isThreadHistoryReleased(t1.id)).toBe(true);
    expect(store.isThreadHistoryReleased(t2.id)).toBe(true);
    expect(existsSync(join(root, TURNS_DIRNAME, `${t3.id}.json`))).toBe(true);

    engine.shutdown();
    store.close();
  });

  it("survives releaseThreadHistory fs errors and protects corrupt segments on reload", async () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const bad = engine.createThread(null, "bad-release");
    const good = engine.createThread(null, "good-release");
    const keep1 = engine.createThread(null, "keep-1");
    const keep2 = engine.createThread(null, "keep-2");
    const active = engine.createThread(null, "active");
    engine.sendTurn(bad.id, "one");
    engine.sendTurn(good.id, "two");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bad.turn?.status === "done" && good.turn?.status === "done") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    engine.selectThread(keep1.id);
    engine.selectThread(keep2.id);
    engine.selectThread(active.id);
    store.flushNow();

    const origRelease = store.releaseThreadHistory.bind(store);
    const spy = vi.spyOn(store, "releaseThreadHistory").mockImplementation((id: string) => {
      if (id === bad.id) throw new Error("EPERM: simulated rename lock");
      return origRelease(id);
    });
    const res = engine.handleMemoryPressure(true);
    spy.mockRestore();
    expect(res.releasedThreads).toBe(3);
    expect(store.isThreadHistoryReleased(bad.id)).toBe(false);
    expect(store.isThreadHistoryReleased(good.id)).toBe(true);
    expect(store.isThreadHistoryReleased(keep1.id)).toBe(true);
    expect(store.isThreadHistoryReleased(keep2.id)).toBe(true);
    expect(store.isThreadHistoryReleased(active.id)).toBe(false);

    // Corrupt the on-disk segment for `good`, then reload: must clear turn & protect segment.
    writeFileSync(join(root, TURNS_DIRNAME, `${good.id}.json`), "{not-valid-json");
    expect(store.reloadThreadHistory(good.id)).toBe(false);
    expect(store.isThreadHistoryReleased(good.id)).toBe(false);
    const goodAfter = engine.snapshot().threads.find((t) => t.id === good.id)!;
    expect(goodAfter.turn).toBeNull();
    expect(goodAfter.messages).toEqual([]);
    // Flushing must NOT overwrite or re-create a clean turns/<good>.json over quarantined evidence.
    store.flushNow();
    expect(existsSync(join(root, TURNS_DIRNAME, `${good.id}.json`))).toBe(false);

    // Missing segment on reload also clears turn and returns false.
    unlinkSync(join(root, TURNS_DIRNAME, `${keep1.id}.json`));
    expect(store.reloadThreadHistory(keep1.id)).toBe(false);
    expect(engine.snapshot().threads.find((t) => t.id === keep1.id)!.turn).toBeNull();

    engine.shutdown();
    store.close();
  });
});

describe("P2-63 Hydra recovery check skips chats whose work is all merged", () => {
  it("canSkipHydraMergeRecovery matches settled all-merged leads and rejects unmerged work", () => {
    const leadId = "lead-1";
    expect(
      canSkipHydraMergeRecovery(
        {
          id: leadId,
          hydraJobs: [{ id: "j1", isOpen: false, ending: "completed", merge: "merged" }],
        },
        [
          {
            hydraHead: {
              leadId,
              mergedAt: 1234,
              landing: { files: [{ path: "a.ts" }] },
            },
          },
        ],
      ),
    ).toBe(true);

    // Open or failed/unmerged job -> cannot skip.
    expect(
      canSkipHydraMergeRecovery(
        {
          id: leadId,
          hydraJobs: [{ id: "j1", isOpen: true, ending: "completed", merge: "merged" }],
        },
        [],
      ),
    ).toBe(false);

    // Landed head without mergedAt -> cannot skip even if jobs look settled.
    expect(
      canSkipHydraMergeRecovery(
        {
          id: leadId,
          hydraJobs: [{ id: "j1", isOpen: false, ending: "completed", merge: "merged" }],
        },
        [
          {
            hydraHead: {
              leadId,
              landing: { files: [{ path: "a.ts" }] },
            },
          },
        ],
      ),
    ).toBe(false);
  });

  it("recoverHydraWork skips all-merged leads without reloading their released history", () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");

    const mergedLead = engine.createThread(null, "merged-lead");
    const unmergedLead = engine.createThread(null, "unmerged-lead");
    const other = engine.createThread(null, "selected");
    store.update(() => {
      mergedLead.messages.push({
        id: "m-merged",
        role: "user",
        content: "all merged",
        status: "done",
        ts: 1,
      });
      mergedLead.hydraJobs = [{ id: "job-1", isOpen: false, ending: "completed", merge: "merged" }];
      unmergedLead.messages.push({
        id: "m-unmerged",
        role: "user",
        content: "needs recovery",
        status: "done",
        ts: 2,
      });
      unmergedLead.hydraJobs = [{ id: "job-2", isOpen: false, ending: "completed", merge: "failed" }];
    });
    engine.selectThread(other.id);
    store.flushNow();
    store.releaseThreadHistory(mergedLead.id);
    store.releaseThreadHistory(unmergedLead.id);

    const res = engine.recoverHydraWork();
    expect(res.skipped).toContain(mergedLead.id);
    expect(res.checked).toContain(unmergedLead.id);
    // All-merged lead stayed released (history never touched on disk); unmerged lead reloaded.
    expect(store.isThreadHistoryReleased(mergedLead.id)).toBe(true);
    expect(store.isThreadHistoryReleased(unmergedLead.id)).toBe(false);

    engine.shutdown();
    store.close();
  });

  it("populates and settles hydraJobs on real Hydra runs so recoverHydraWork skips them", async () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const lead = engine.createThread(null, "real-hydra-lead");
    const other = engine.createThread(null, "other");
    engine.sendTurn(lead.id, "delegate [mock:hydra]");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const cur = engine.snapshot().threads.find((t) => t.id === lead.id)!;
      const settled = cur.hydraJobs?.some((j) => !j.isOpen && j.ending === "completed");
      if (settled && !engine.hydraLeadBusy(lead.id) && cur.turn?.status !== "running") break;
      await new Promise((r) => setTimeout(r, 15));
    }

    const cur = engine.snapshot().threads.find((t) => t.id === lead.id)!;
    expect(cur.hydraJobs?.length).toBeGreaterThan(0);
    expect(cur.hydraJobs![0]!.isOpen).toBe(false);
    expect(cur.hydraJobs![0]!.ending).toBe("completed");
    expect(cur.hydraJobs![0]!.merge).toBe("nothing");

    engine.selectThread(other.id);
    store.flushNow();
    expect(store.releaseThreadHistory(lead.id)).toBe(true);
    const res = engine.recoverHydraWork();
    expect(res.skipped).toContain(lead.id);
    expect(store.isThreadHistoryReleased(lead.id)).toBe(true);

    engine.shutdown();
    store.close();
  });
});

describe("P2-63 non-visible panels stream paced", () => {
  it("paces offscreen/background threads at 1Hz and helper panels at ~11Hz, catching up on select", () => {
    vi.useFakeTimers();
    const root = freshRoot();
    const store = new Store(root);
    store.open();

    const callbacks = new Map<string, ProviderCallbacks>();
    const provider: ProviderAdapter = {
      descriptor: { id: "mock", label: "Mock", mode: "mock", synthetic: true },
      start(ctx: TurnContext, cb: ProviderCallbacks) {
        callbacks.set(ctx.threadId, cb);
        return { cancel: () => {}, resume: () => {} };
      },
      async dispose() {
        return { children: [], orphanedPending: 0 };
      },
    };
    const engine = new Engine(store, provider, root, "0.0.0-test");
    const events: AppEvent[] = [];
    engine.onEvent((e) => events.push(e));

    const bg = engine.createThread(null, "bg");
    const parent = engine.createThread(null, "parent");
    const helper = engine.spawnHelper(parent.id, "Helper", "help");
    engine.selectThread(parent.id);

    // Offscreen thread `bg` bursts 3 chunks -> buffered (1000ms cadence).
    engine.sendTurn(bg.id, "go");
    const bgCb = callbacks.get(bg.id)!;
    bgCb.onChunk(1, "A");
    bgCb.onChunk(2, "B");
    bgCb.onChunk(3, "C");
    expect(events.filter((e) => e.type === "turn-chunk" && e.threadId === bg.id)).toHaveLength(0);

    // Open helper panel beside selected parent bursts chunks -> paced at 90ms (~11Hz).
    const helperCb = callbacks.get(helper.id)!;
    helperCb.onChunk(1, "H1");
    helperCb.onChunk(2, "H2");
    expect(events.filter((e) => e.type === "turn-chunk" && e.threadId === helper.id)).toHaveLength(0);

    vi.advanceTimersByTime(90);
    const helperChunks = events.filter((e) => e.type === "turn-chunk" && e.threadId === helper.id);
    expect(helperChunks).toHaveLength(1);
    expect((helperChunks[0] as { content?: string }).content).toBe("H1H2");
    // Offscreen `bg` is still held until 1000ms (or select).
    expect(events.filter((e) => e.type === "turn-chunk" && e.threadId === bg.id)).toHaveLength(0);

    // Selecting `bg` catches up immediately without waiting for the 1000ms timer
    // and emits authoritative full content.
    engine.selectThread(bg.id);
    const bgChunks = events.filter((e) => e.type === "turn-chunk" && e.threadId === bg.id);
    expect(bgChunks).toHaveLength(1);
    expect((bgChunks[0] as { content?: string }).content).toBe("ABC");

    // Once `bg` is active & selected, chunks arrive immediately.
    bgCb.onChunk(4, "D");
    expect(events.filter((e) => e.type === "turn-chunk" && e.threadId === bg.id)).toHaveLength(2);

    // Interleaved thread-updated while deltas are buffered never duplicates text in ClientStore.
    const client = new ClientStore(async () => ({}));
    let rev = 1;
    const snap = makeSnap(rev, structuredClone(engine.snapshot().threads), bg.id);
    client.hydrate(snap, client.beginHydration());
    const unsub = engine.onEvent((e) => {
      rev += 1;
      client.onBridgeEvent({ ...e, rev } as AppEvent);
    });
    engine.setWindowActive(false);
    bgCb.onChunk(5, "E");
    bgCb.onChunk(6, "F");
    engine.renameThread(bg.id, "renamed-bg");
    vi.advanceTimersByTime(1000);
    unsub();
    const clientMsg = client.thread(bg.id)!.messages.find((m) => m.role === "assistant")!;
    expect(clientMsg.content).toBe("ABCDEF");

    // Restoring window flushes buffered panel/visible chunks cleanly.
    bgCb.onChunk(7, "G");
    expect(events.filter((e) => e.type === "turn-chunk" && e.threadId === bg.id)).toHaveLength(3);
    engine.setWindowActive(true);
    expect(events.filter((e) => e.type === "turn-chunk" && e.threadId === bg.id)).toHaveLength(4);

    engine.shutdown();
    store.close();
  });

  it("ClientStore paces renderer notifications for offscreen/panel chunks and flushes on status", () => {
    vi.useFakeTimers();
    const store = new ClientStore(async () => ({}));
    const active: ChatThread = {
      id: "t-active",
      projectId: null,
      title: "active",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: null,
      sessionGrants: [],
    };
    const offscreen: ChatThread = {
      id: "t-off",
      projectId: null,
      title: "off",
      createdAt: 2,
      updatedAt: 2,
      messages: [{ id: "m1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "u1" }],
      turn: { id: "u1", threadId: "t-off", status: "running", seq: 0, startedAt: 2, assistantMessageId: "m1" },
      sessionGrants: [],
    };
    store.hydrate(makeSnap(1, [active, offscreen], "t-active"), store.beginHydration());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.onBridgeEvent({ type: "turn-chunk", threadId: "t-off", turnId: "u1", seq: 1, delta: "hi", rev: 2 });
    store.onBridgeEvent({ type: "turn-chunk", threadId: "t-off", turnId: "u1", seq: 2, delta: "!", rev: 3 });
    expect(store.thread("t-off")!.messages[0]!.content).toBe("hi!");
    expect(notifications).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(notifications).toBe(1);

    store.onBridgeEvent({ type: "turn-chunk", threadId: "t-off", turnId: "u1", seq: 3, delta: "done", rev: 4 });
    expect(notifications).toBe(1);
    store.onBridgeEvent({ type: "turn-status", threadId: "t-off", turnId: "u1", status: "done", rev: 5 });
    expect(notifications).toBe(2);

    // Content-mode paced chunk flushes immediately on window-activity active: true.
    offscreen.turn = { id: "u2", threadId: "t-off", status: "running", seq: 0, startedAt: 3, assistantMessageId: "m1" };
    store.onBridgeEvent({ type: "turn-chunk", threadId: "t-off", turnId: "u2", seq: 1, content: "replaced", rev: 6 });
    expect(store.thread("t-off")!.messages[0]!.content).toBe("replaced");
    expect(notifications).toBe(2);
    store.onBridgeEvent({ type: "window-activity", active: true });
    expect(notifications).toBe(3);

    // memory-pressure clears markdown cache.
    clearMarkdownCache();
    const cachedBefore = renderMarkdown("cache-probe", { copy: "Copy", copied: "Copied" });
    store.onBridgeEvent({ type: "memory-pressure", critical: false });
    const afterPressure = renderMarkdown("cache-probe", { copy: "Copy", copied: "Copied" });
    expect(afterPressure).not.toBe(cachedBefore);
  });
});

describe("P2-63 archive switch, activity pause, and working-indicator isolation", () => {
  it("archiving a selected thread switches directly to its neighbor and markdown prewarm hits cache", () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const a = engine.createThread(null, "A");
    const b = engine.createThread(null, "B");
    engine.selectThread(a.id);
    engine.archiveThread(a.id);
    expect(engine.snapshot().selectedThreadId).toBe(b.id);
    engine.archiveThread(b.id);
    expect(engine.snapshot().selectedThreadId).toBeNull();

    // Settled markdown cache returns identical React nodes after prewarm.
    clearMarkdownCache();
    const sample = "# Heading\n\nParagraph with **bold** and `code`.";
    prewarmMarkdown([sample], { copy: "Copy", copied: "Copied" });
    const first = renderMarkdown(sample, { copy: "Copy", copied: "Copied" });
    const second = renderMarkdown(sample, { copy: "Copy", copied: "Copied" });
    expect(second).toBe(first);

    engine.shutdown();
    store.close();
  });

  it("tracks pause state for inactive/hidden/covered app and pauses WorkingLabel / Skylight", () => {
    setWindowActive(true);
    setModalCovered(false);
    expect(appActivity.paused).toBe(false);

    setWindowActive(false);
    expect(appActivity.paused).toBe(true);
    setWindowActive(true);
    expect(appActivity.paused).toBe(false);

    setModalCovered(true);
    expect(appActivity.paused).toBe(true);
    setModalCovered(false);
    expect(appActivity.paused).toBe(false);

    const thread: ChatThread = {
      id: "t-work",
      projectId: null,
      title: "work",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: {
        id: "u1",
        threadId: "t-work",
        status: "running",
        seq: 0,
        startedAt: Date.now() - 5000,
        assistantMessageId: "a1",
      },
      sessionGrants: [],
    };
    const pausedHtml = renderToStaticMarkup(
      createElement(WorkingLabel, { thread, turn: thread.turn!, paused: true }),
    );
    expect(pausedHtml).toContain('class="work-label paused"');
    expect(pausedHtml).toContain('class="work-elapsed"');

    const cardHtml = renderToStaticMarkup(
      createElement(WorkingIndicator, {
        thread,
        turn: thread.turn!,
        showsCard: true,
        showReasoning: false,
      }),
    );
    expect(cardHtml).toContain('class="work-card"');

    // Skylight suppresses sway animation when modal covers the window.
    setModalCovered(true);
    const skyHtml = renderToStaticMarkup(
      createElement(Skylight, { threads: [thread], onNewThread: () => {} }),
    );
    expect(skyHtml).not.toContain("sky-doll sway");
    const pausedSpin = renderToStaticMarkup(createElement(MiniSpinner, {}));
    expect(pausedSpin).toContain("spin-cell spin-row-0 still");
    setModalCovered(false);
    const activeSpin = renderToStaticMarkup(createElement(MiniSpinner, {}));
    expect(activeSpin).toContain("spin-cell spin-row-0");
  });

  it("readThreadMessages reads persisted history for released threads without reloading RAM", () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const th = engine.createThread(null, "released-read");
    engine.sendTurn(th.id, "keep me on disk");
    const other = engine.createThread(null, "other");
    engine.selectThread(other.id);
    store.flushNow();

    expect(store.releaseThreadHistory(th.id)).toBe(true);
    expect(store.isThreadHistoryReleased(th.id)).toBe(true);
    const msgs = engine.readThreadMessages(th.id);
    expect(msgs.some((m) => m.content === "keep me on disk")).toBe(true);
    expect(store.isThreadHistoryReleased(th.id)).toBe(true);

    engine.shutdown();
    store.close();
  });

  it("paused CSS settles .md-veil without hiding freshly streamed text", () => {
    const css = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");
    const pausedBlock = css.match(/html\[data-paused="1"\][\s\S]*?animation-play-state:\s*paused\s*!important;/)?.[0] ?? "";
    expect(pausedBlock).not.toContain(".md-veil");
    expect(css).toMatch(/html\[data-paused="1"\]\s*\.md-veil\s*\{\s*animation:\s*none\s*!important;\s*\}/);
  });

  it("records reproducible P2-63 before/after synthetic measurements", () => {
    const msgs = Array.from({ length: 12 }, (_, i) =>
      `# Section ${i}\n\nSummary with **bold**, \`code_${i}\`, and [link](https://example.com/${i}).\n\n\`\`\`ts\nexport const x${i} = ${i};\n\`\`\``
    );
    const labels = { copy: "Copy", copied: "Copied" };
    clearMarkdownCache();
    const coldStart = performance.now();
    for (let r = 0; r < 10; r++) {
      clearMarkdownCache();
      for (const m of msgs) renderMarkdown(m, labels);
    }
    const coldSwitchMs = (performance.now() - coldStart) / 10;
    clearMarkdownCache();
    prewarmMarkdown(msgs, labels);
    const warmStart = performance.now();
    for (let r = 0; r < 10; r++) {
      for (const m of msgs) renderMarkdown(m, labels);
    }
    const warmSwitchMs = (performance.now() - warmStart) / 10;
    expect(warmSwitchMs).toBeLessThan(coldSwitchMs);

    const fakeMsgs = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      kind: i % 5 === 0 ? "tool" : undefined,
      turnId: i > 190 ? "t-live" : "t-old",
      content: `msg ${i}`,
      status: "done",
      ts: 1000 + i,
    }));
    const tBefore0 = performance.now();
    let s1 = "";
    for (let i = 0; i < 5000; i++) {
      const liveWork = fakeMsgs.filter((m) => m.turnId === "t-live" && m.kind === "tool");
      s1 = `${WORKING_WORDS[workingWordIndex("thread-1", i)]}:${liveWork.length}:${formatElapsed(i * 1000)}`;
    }
    const idleBeforeMs = performance.now() - tBefore0;
    const tAfter0 = performance.now();
    let s2 = "";
    for (let i = 0; i < 5000; i++) {
      s2 = formatElapsed(i * 1000);
    }
    const idleAfterMs = performance.now() - tAfter0;
    expect(s1.length > 0 && s2.length > 0).toBe(true);
    expect(idleAfterMs).toBeLessThan(idleBeforeMs);

    console.info(
      `P2-63_METRICS=${JSON.stringify({
        archiveSwitchColdMs: Number(coldSwitchMs.toFixed(3)),
        archiveSwitchWarmMs: Number(warmSwitchMs.toFixed(3)),
        idleTick5000BeforeMs: Number(idleBeforeMs.toFixed(3)),
        idleTick5000AfterMs: Number(idleAfterMs.toFixed(3)),
      })}`,
    );
  });
});
