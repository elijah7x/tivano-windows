// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Engine↔Codex seam: provider-thread bindings persist on the LOCAL thread
// (never replacing its identity), survive a store reopen for resume, are
// idempotent, and refuse conflicting rebinds.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type { ProviderThreadBinding } from "../src/shared/types";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-engcodex-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEngine(root: string): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}

function binding(thread = "cx-thread-9"): ProviderThreadBinding {
  return {
    providerId: "codex",
    codexThreadId: thread,
    cwd: "/w",
    codexHomeId: "/data/codex-home",
    schemaPin: "0.164.0+6aaac694",
    cliVersion: "0.164.0",
    savedAt: Date.now(),
  };
}

describe("provider thread binding (Codex resume seam)", () => {
  it("persists on the local thread and survives a store reopen", async () => {
    const root = freshRoot();
    const t1 = makeEngine(root);
    const thread = t1.engine.createThread(null, "chat");
    await t1.engine.bindProviderThread(thread.id, binding());
    expect(t1.engine.lookupProviderThread(thread.id)?.codexThreadId).toBe("cx-thread-9");
    t1.store.close();

    const t2 = makeEngine(root);
    const persisted = t2.engine.lookupProviderThread(thread.id);
    expect(persisted?.codexThreadId).toBe("cx-thread-9");
    expect(persisted?.schemaPin).toBe("0.164.0+6aaac694");
    t2.store.close();
  });

  it("same binding re-confirmed is idempotent; conflicting rebind refuses", async () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    const thread = engine.createThread(null, "chat");
    await engine.bindProviderThread(thread.id, binding("cx-a"));
    await expect(engine.bindProviderThread(thread.id, binding("cx-a"))).resolves.toBeUndefined();
    await expect(engine.bindProviderThread(thread.id, binding("cx-b"))).rejects.toThrow(
      /refusing rebind/,
    );
    expect(engine.lookupProviderThread(thread.id)?.codexThreadId).toBe("cx-a");
    store.close();
  });

  it("binding a missing thread rejects (no orphan persistence)", async () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    await expect(engine.bindProviderThread("no-such-thread", binding())).rejects.toThrow();
    store.close();
  });

  it("local thread identity is never replaced by the provider binding", async () => {
    const root = freshRoot();
    const { engine, store } = makeEngine(root);
    const thread = engine.createThread(null, "mine");
    await engine.bindProviderThread(thread.id, binding("cx-foreign"));
    const after = engine.snapshot().threads.find((t) => t.id === thread.id)!;
    expect(after.id).toBe(thread.id); // local id wins — codexThreadId is metadata
    expect(after.providerThread?.codexThreadId).toBe("cx-foreign");
    store.close();
  });
});
