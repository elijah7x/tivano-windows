// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// P2-62: the Concise AI replies switch and turn-level anti-slop prompt
// injection are retired in v3.0.0; ordinary turns reach the provider
// without [Tivano anti-slop guidance] wrappers.

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

function lastReply(engine: Engine, threadId: string): string {
  const t = engine.snapshot().threads.find((x) => x.id === threadId)!;
  const asst = [...t.messages].reverse().find((m) => m.role === "assistant")!;
  return asst.content;
}

describe("retired anti-slop prompt injection (P2-62)", () => {
  it("does not inject anti-slop guidance into ordinary turns", () => {
    const { store, engine } = makeEngine(freshRoot());
    const t = engine.createThread(null);
    engine.sendTurn(t.id, "hello there");
    pump();
    const reply = lastReply(engine, t.id);
    expect(reply).not.toContain("[Tivano anti-slop guidance]");
    expect(reply).not.toContain("[Tivano anti-slop guidance: off]");
    expect(reply).toContain("hello there");
    store.close();
  });
});
