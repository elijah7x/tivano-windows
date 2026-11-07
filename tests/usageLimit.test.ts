// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F20 usage-limit auto-continue: signal parsing (frozen UsageLimitSignal
// port) plus the engine wait/cancel/handoff lifecycle on the mock path.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import type { ChatThread } from "../src/shared/types";
import {
  matches,
  resetTime,
  waitTime,
  scheduleResume,
  formatReset,
} from "../src/main/usageLimit";
import { limitHandoffText } from "../src/main/limitHandoff";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-limit-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  engine.limitMarginMs = 0; // tests: no provider margin — floor stays 5s
  return { store, engine };
}
const threadOf = (engine: Engine, id: string): ChatThread =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const texts = (engine: Engine, id: string) =>
  threadOf(engine, id).messages.map((m) => m.content);
const userTexts = (engine: Engine, id: string) =>
  threadOf(engine, id).messages.filter((m) => m.role === "user").map((m) => m.content);
const turnStatus = (engine: Engine, id: string) => threadOf(engine, id).turn?.status;
const CONTINUE =
  "The usage limit has reset. Continue exactly where you left off and finish the task.";

describe("F20 UsageLimitSignal parsing", () => {
  it("matches the frozen limit wordings and nothing else", () => {
    for (const yes of [
      "usage limit reached",
      "You hit your limit",
      "out of credits",
      "insufficient_quota",
      "RESOURCE_EXHAUSTED",
      "account's rate limit exceeded",
      "quota will reset",
    ])
      expect(matches(yes), yes).toBe(true);
    for (const no of [
      "some other error",
      "limited offer",
      "time limit for the test suite",
      "",
    ])
      expect(matches(no), no).toBe(false);
  });

  it("bar timestamp parses epoch seconds and milliseconds", () => {
    const now = Date.now();
    const at = Math.floor(now / 1000) + 120;
    expect(resetTime(`usage limit reached|${at}`, now)).toBe(at * 1000);
    expect(resetTime(`usage limit reached|${at}000`, now)).toBe(at * 1000);
    // Past/foreign timestamps never schedule.
    expect(resetTime("usage limit reached|100000000", now)).toBeNull();
    expect(resetTime("usage limit reached|", now)).toBeNull();
  });

  it("clock times resolve to the NEXT such wall-clock time", () => {
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    const now = base.getTime();
    const pm = resetTime("resets at 3:30 pm", now)!;
    const expected = new Date(base).setHours(15, 30, 0, 0);
    expect(pm).toBe(expected);
    // A clock time already past rolls to tomorrow.
    const am = resetTime("resets 6am", now)!;
    const tomorrow6 = new Date(base);
    tomorrow6.setDate(base.getDate() + 1);
    tomorrow6.setHours(6, 0, 0, 0);
    expect(am).toBe(tomorrow6.getTime());
  });

  it("waitTime reads every phrasing and takes the LONGEST", () => {
    expect(waitTime("retry-after-ms=60000")).toBe(60);
    expect(waitTime("Try again in ~5 min")).toBe(300);
    expect(waitTime("resets in 2h30m")).toBe(9000);
    expect(waitTime("Please retry in 12s or resets in 3 days")).toBe(3 * 86_400);
    expect(waitTime("resets in 18h31m10s")).toBe(18 * 3600 + 31 * 60 + 10);
    expect(waitTime("provider requested 4500 ms wait")).toBe(4.5);
    for (const bad of [
      "try again in",
      "retry-after-ms=",
      "no wait named at all",
      "retry-after-ms=99999999999999",
    ])
      expect(waitTime(bad), bad).toBeNull();
  });

  it("schedule: reset + margin, 5s floor, maximum bound", () => {
    const now = Date.now();
    expect(scheduleResume(now + 10_000, now, 60_000)).toBe(now + 70_000);
    // Floor: even an imminent reset waits 5s.
    expect(scheduleResume(now + 500, now, 0)).toBe(now + 5_000);
    // Past or absurdly-far resets never schedule.
    expect(scheduleResume(now - 1000, now, 0)).toBeNull();
    expect(scheduleResume(now + 400 * 86_400_000, now, 0)).toBeNull();
  });

  it("formatReset names today/tomorrow/weekday/far", () => {
    const today = new Date();
    today.setMinutes(today.getMinutes() + 30);
    expect(formatReset(today.getTime())).toMatch(/\d{1,2}:\d{2}/);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    expect(formatReset(tomorrow.getTime())).toContain("tomorrow at");
    const later = new Date();
    later.setDate(later.getDate() + 30);
    expect(formatReset(later.getTime())).not.toContain("tomorrow");
    expect(formatReset(NaN)).toBe("Unknown reset time");
  });
});

describe("F20 engine auto-continue", () => {
  it("setting OFF: a limit-worded failure is just a failed turn", async () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "chat");
    engine.selectThread(th.id);
    engine.sendTurn(th.id, "[mock:limit:2] work");
    await waitFor(() => turnStatus(engine, th.id) === "error");
    await sleep(120);
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    expect(texts(engine, th.id).join("\n")).not.toContain("Continuing automatically");
    expect(userTexts(engine, th.id)).toEqual(["[mock:limit:2] work"]);
    store.close();
  });

  it("setting ON: limit failure waits, notices, then sends the continue message", { timeout: 15_000 }, async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.selectThread(th.id);
    engine.sendTurn(th.id, "[mock:limit:1] work");
    await waitFor(() => turnStatus(engine, th.id) === "error");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    const notice = texts(engine, th.id).find((m) => m.includes("Continuing automatically"));
    expect(notice).toBeTruthy();
    // 5s floor + margin 0 + reset 1s → resume in 5s; the continuation
    // appears as a NEW user message and the turn completes.
    await waitFor(
      () => userTexts(engine, th.id).includes(CONTINUE) && turnStatus(engine, th.id) === "done",
      9_000,
    );
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    store.close();
  });

  it("a limit with no reset time posts the honest warning and never waits", async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit-notime] work");
    await waitFor(() => turnStatus(engine, th.id) === "error");
    await waitFor(() =>
      texts(engine, th.id).some((m) => m.includes("did not say when it resets")),
    );
    await sleep(150);
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    expect(userTexts(engine, th.id)).toEqual(["[mock:limit-notime] work"]);
    store.close();
  });

  it("a waiting limit failure leaves NO unread mark (still working)", async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const watcher = engine.createThread(null, "watcher");
    const worker = engine.createThread(null, "worker");
    engine.selectThread(watcher.id);
    engine.sendTurn(worker.id, "[mock:limit:1] work");
    await waitFor(() => turnStatus(engine, worker.id) === "error");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[worker.id] !== undefined);
    expect(threadOf(engine, worker.id).hasUnread ?? false).toBe(false);
    store.close();
  });

  it("a plain failure while another thread waits still marks unread", async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const watcher = engine.createThread(null, "watcher");
    const worker = engine.createThread(null, "worker");
    engine.selectThread(watcher.id);
    engine.sendTurn(worker.id, "[mock:fail] work");
    await waitFor(() => turnStatus(engine, worker.id) === "error");
    expect(threadOf(engine, worker.id).hasUnread).toBe(true);
    store.close();
  });

  it("cancel ends the wait and nothing sends", async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit:30] work");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    engine.cancelLimitWait(th.id);
    await waitFor(() =>
      texts(engine, th.id).some((m) => m.includes("will not continue on its own")),
    );
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    expect(() => engine.cancelLimitWait(th.id)).toThrow();
    store.close();
  });

  it("handoff creates a same-project chat and returns the frozen draft text", async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const proj = engine.createProject("P");
    const th = engine.createThread(proj.id, "chat");
    engine.sendTurn(th.id, "summarize the spec [mock:limit:30]");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    const made = engine.handoffLimit(th.id);
    expect(made.text).toContain('Continue the work from the chat "chat"');
    expect(made.text).toContain("summarize the spec [mock:limit:30]");
    expect(made.text).toContain("Take it over from here");
    const made2 = engine.snapshot().threads.find((t) => t.id === made.threadId)!;
    expect(made2.projectId).toBe(proj.id);
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    expect(() => engine.handoffLimit(th.id)).toThrow();
    store.close();
  });

  it("a user send during the wait leaves nothing to continue", { timeout: 15_000 }, async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit:1] work");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    // User picks the chat up before the resume fires.
    engine.sendTurn(th.id, "never mind, do it now");
    await waitFor(() => turnStatus(engine, th.id) === "done");
    await sleep(5_300);
    expect(userTexts(engine, th.id)).not.toContain(CONTINUE);
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    store.close();
  });

  it("turning the setting off during the wait stops the resume", { timeout: 15_000 }, async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit:1] work");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    engine.setSettings({ autoContinueAfterLimit: false });
    await sleep(5_300);
    expect(userTexts(engine, th.id)).not.toContain(CONTINUE);
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    store.close();
  });

  it("a model change ends the wait now and nothing resumes (2.2.12)", { timeout: 15_000 }, async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit:1] work");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    engine.setThreadModel(th.id, "some-other-model", null);
    // The wait state is gone the moment the model moved — not at fire time.
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    await sleep(5_300);
    expect(userTexts(engine, th.id)).not.toContain(CONTINUE);
    store.close();
  });

  it("an effort-only change leaves the wait armed and it still resumes", { timeout: 15_000 }, async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit:1] work");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    engine.setThreadModel(th.id, null, "high");
    expect((engine.snapshot().limitResumesAt ?? {})[th.id]).not.toBeUndefined();
    await waitFor(() => userTexts(engine, th.id).includes(CONTINUE), 9_000);
    store.close();
  });

  it("archiving a waiting thread dismisses the continue (frozen archive)", { timeout: 15_000 }, async () => {
    const { engine, store } = make();
    engine.setSettings({ autoContinueAfterLimit: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:limit:1] work");
    await waitFor(() => (engine.snapshot().limitResumesAt ?? {})[th.id] !== undefined);
    engine.archiveThread(th.id);
    expect(engine.snapshot().limitResumesAt ?? {}).toEqual({});
    await sleep(5_300);
    expect(userTexts(engine, th.id)).not.toContain(CONTINUE);
    store.close();
  });
});

describe("F20 limitHandoffText", () => {
  it("flattens the request and bounds quoted lines", () => {
    const { engine, store } = make();
    const th = engine.createThread(null, "handoff source");
    engine.sendTurn(th.id, "fix   the\nbuild   now");
    const text = limitHandoffText(
      threadOf(engine, th.id),
      ["src/a.ts", "src/b.ts"],
    );
    expect(text).toContain('Continue the work from the chat "handoff source"');
    expect(text).toContain("fix the build now");
    expect(text).toContain("- src/a.ts");
    expect(text).toContain("- src/b.ts");
    store.close();
  });
});
