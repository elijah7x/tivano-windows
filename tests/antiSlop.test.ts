// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// F31 anti-slop guidance (frozen AntiSlopPolicy port): one delivery per
// provider session on the first ordinary message, slash commands keep it
// pending, "off" still sends the disregard notice once, a failed start
// leaves delivery pending, a new engine run re-delivers once.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-slop-"));
  dirs.push(d);
  return d;
}
function makeEngine(root: string, tickMs = 1): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs }), root, "t") };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const pump = (ms = 5000) => vi.advanceTimersByTime(ms);
const ENABLED = "[Tivano anti-slop guidance]";
const DISABLED = "[Tivano anti-slop guidance: off]";

function lastReply(engine: Engine, threadId: string): string {
  const t = engine.snapshot().threads.find((x) => x.id === threadId)!;
  const asst = [...t.messages].reverse().find((m) => m.role === "assistant")!;
  return asst.content;
}

describe("anti-slop guidance (F31)", () => {
  it("injects the enabled block once per session on the first ordinary message", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "hello there");
    pump();
    expect(lastReply(engine, t.id)).toContain(ENABLED);
    engine.sendTurn(t.id, "second message");
    pump();
    expect(lastReply(engine, t.id)).not.toContain(ENABLED);
  });

  it("delivers the disregard block once when the setting is off", () => {
    const { engine } = makeEngine(freshRoot());
    engine.setSettings({ antiSlopEnabled: false });
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "hello");
    pump();
    const reply = lastReply(engine, t.id);
    expect(reply).toContain(DISABLED);
    expect(reply).not.toContain(ENABLED + "\n");
    engine.sendTurn(t.id, "again");
    pump();
    expect(lastReply(engine, t.id)).not.toContain(DISABLED);
  });

  it("defaults to enabled on an old store (absent setting)", () => {
    const { store, engine } = makeEngine(freshRoot());
    expect(store.state.settings.antiSlopEnabled).toBeUndefined();
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "hi");
    pump();
    expect(lastReply(engine, t.id)).toContain(ENABLED);
  });

  it("a leading slash command skips delivery AND keeps it pending", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "/plan refactor this");
    pump();
    expect(lastReply(engine, t.id)).not.toContain(ENABLED);
    engine.sendTurn(t.id, "an ordinary follow-up");
    pump();
    expect(lastReply(engine, t.id)).toContain(ENABLED);
  });

  it("an unknown slash word is ordinary text and still receives guidance", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "/nosuch do the thing");
    pump();
    expect(lastReply(engine, t.id)).toContain(ENABLED);
  });

  it("a recorded command name is skipped like a builtin", () => {
    const { engine } = makeEngine(freshRoot());
    engine.recordCommand("handoff");
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "/handoff summarize so far");
    pump();
    expect(lastReply(engine, t.id)).not.toContain(ENABLED);
    engine.sendTurn(t.id, "plain text next");
    pump();
    expect(lastReply(engine, t.id)).toContain(ENABLED);
  });

  it("toggling after delivery never re-injects within the same session", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "first");
    pump();
    expect(lastReply(engine, t.id)).toContain(ENABLED);
    engine.setSettings({ antiSlopEnabled: false });
    engine.sendTurn(t.id, "second after toggle");
    pump();
    const reply = lastReply(engine, t.id);
    expect(reply).not.toContain(DISABLED);
    expect(reply).not.toContain(ENABLED);
  });

  it("a fresh engine run re-delivers once (in-memory flag like frozen)", () => {
    const root = freshRoot();
    const a = makeEngine(root);
    const t = a.engine.createThread(null);
    a.engine.sendTurn(t.id, "first run");
    pump();
    expect(lastReply(a.engine, t.id)).toContain(ENABLED);
    a.store.close(); // simulate app shutdown
    const b = makeEngine(root);
    b.engine.sendTurn(t.id, "after restart");
    pump();
    expect(lastReply(b.engine, t.id)).toContain(ENABLED);
    b.store.close();
  });

  it("guidance wraps the whole prompt including the attachment suffix", () => {
    const { engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "hello");
    pump();
    const reply = lastReply(engine, t.id);
    // Mock echoes the wire prompt verbatim — guidance precedes user text.
    expect(reply.indexOf(ENABLED)).toBeLessThan(reply.indexOf("hello"));
  });
});
