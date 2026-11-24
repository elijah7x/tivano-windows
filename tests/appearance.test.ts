// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-62 settings migration: v2.x stores carrying retired v3.0.0 fields
// (performanceMode, notifyOnDone, commitInstructions, antiSlopEnabled)
// load cleanly without corruption, drop the retired keys from settings,
// and persist cleanly across reopen.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, emptyStore } from "../src/main/store";
import { CorruptStoreError, validateStoreFile } from "../src/main/storeDoc";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-pm-"));
  dirs.push(d);
  return d;
}
function makeEngine(root: string): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("P2-62 retired settings migration", () => {
  it("opens a store carrying retired v2.x settings without corruption and strips them", () => {
    const root = freshRoot();
    const { store } = makeEngine(root);
    store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.settings.performanceMode = true;
    doc.settings.notifyOnDone = false;
    doc.settings.commitInstructions = "use conventional commits";
    doc.settings.antiSlopEnabled = false;
    writeFileSync(path, JSON.stringify(doc));

    const { store: store2, engine: engine2 } = makeEngine(root);
    expect(store2.recoveredFrom).toBeUndefined();
    const settings = engine2.snapshot().settings as unknown as Record<string, unknown>;
    expect(settings.performanceMode).toBeUndefined();
    expect(settings.notifyOnDone).toBeUndefined();
    expect(settings.commitInstructions).toBeUndefined();
    expect(settings.antiSlopEnabled).toBeUndefined();
    store2.close();

    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    expect("performanceMode" in persisted.settings).toBe(false);
    expect("notifyOnDone" in persisted.settings).toBe(false);
    expect("commitInstructions" in persisted.settings).toBe(false);
    expect("antiSlopEnabled" in persisted.settings).toBe(false);
  });

  it("drops malformed retired keys on load while still rejecting unknown keys", () => {
    const base = emptyStore() as unknown as Record<string, unknown>;
    const withRetired = {
      ...base,
      settings: {
        ...(base.settings as Record<string, unknown>),
        performanceMode: "loud",
        notifyOnDone: 123,
      },
    };
    const migrated = validateStoreFile(withRetired);
    expect("performanceMode" in (migrated.settings as unknown as Record<string, unknown>)).toBe(
      false,
    );
    expect("notifyOnDone" in (migrated.settings as unknown as Record<string, unknown>)).toBe(false);

    const withBogus = {
      ...base,
      settings: {
        ...(base.settings as Record<string, unknown>),
        bogusUnknownKey: true,
      },
    };
    expect(() => validateStoreFile(withBogus)).toThrow(CorruptStoreError);
  });
});
