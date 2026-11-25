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
import { requestValidators } from "../src/shared/ipc";

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
  it("opens a v2.x store carrying retired settings without corruption", () => {
    const root = freshRoot();
    const { store } = makeEngine(root);
    store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    doc.settings.performanceMode = true;
    doc.settings.notifyOnDone = false;
    doc.settings.commitInstructions = "use conventional commits";
    doc.settings.antiSlopEnabled = false;
    writeFileSync(path, JSON.stringify(doc));

    const { store: store2, engine: engine2 } = makeEngine(root);
    expect(store2.recoveredFrom).toBeUndefined();
    const settings = engine2.snapshot().settings;
    expect("performanceMode" in settings).toBe(false);
    expect("notifyOnDone" in settings).toBe(false);
    expect("commitInstructions" in settings).toBe(false);
    expect("antiSlopEnabled" in settings).toBe(false);
    store2.close();
  });

  it("re-persists migrated stores without retired keys", () => {
    const root = freshRoot();
    const { store } = makeEngine(root);
    store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    doc.settings.performanceMode = true;
    doc.settings.notifyOnDone = true;
    doc.settings.commitInstructions = "concise";
    doc.settings.antiSlopEnabled = true;
    writeFileSync(path, JSON.stringify(doc));

    const { store: store2, engine: engine2 } = makeEngine(root);
    engine2.setSettings({ chimeWhenFinished: false });
    store2.close();

    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    expect("performanceMode" in persisted.settings).toBe(false);
    expect("notifyOnDone" in persisted.settings).toBe(false);
    expect("commitInstructions" in persisted.settings).toBe(false);
    expect("antiSlopEnabled" in persisted.settings).toBe(false);
    expect(persisted.settings.chimeWhenFinished).toBe(false);
  });

  it("drops malformed retired keys on load during document validation", () => {
    const raw = JSON.parse(JSON.stringify(emptyStore())) as {
      settings: Record<string, unknown>;
    };
    raw.settings.performanceMode = "loud";
    raw.settings.notifyOnDone = 123;
    raw.settings.commitInstructions = 42;
    raw.settings.antiSlopEnabled = "invalid";

    const migrated = validateStoreFile(raw);
    expect("performanceMode" in migrated.settings).toBe(false);
    expect("notifyOnDone" in migrated.settings).toBe(false);
    expect("commitInstructions" in migrated.settings).toBe(false);
    expect("antiSlopEnabled" in migrated.settings).toBe(false);
  });

  it("still rejects genuinely unknown settings keys with CorruptStoreError", () => {
    const raw = JSON.parse(JSON.stringify(emptyStore())) as {
      settings: Record<string, unknown>;
    };
    raw.settings.bogusUnknownKey = true;
    expect(() => validateStoreFile(raw)).toThrow(CorruptStoreError);
  });

  it("rejects retired keys in settings:set IPC validation and ignores them in Engine.setSettings", () => {
    const { store, engine } = makeEngine(freshRoot());
    for (const key of [
      "performanceMode",
      "notifyOnDone",
      "commitInstructions",
      "antiSlopEnabled",
    ]) {
      const patch: Record<string, unknown> = { [key]: true };
      expect(() => requestValidators["settings:set"](patch)).toThrow();
      engine.setSettings(patch as Parameters<Engine["setSettings"]>[0]);
      expect(key in engine.snapshot().settings).toBe(false);
    }
    store.close();
  });

  it("migrates legacy v2.x theme variants onto the 12 accent families + appearanceMode (P2-51)", () => {
    for (const [legacy, expectedTheme, expectedMode] of [
      ["tokyoNight", "nightOwl", "dark"],
      ["githubLight", "github", "light"],
      ["breezeDark", "breeze", "dark"],
      ["breezeLight", "breeze", "light"],
      ["dark", "system", "dark"],
      ["light", "system", "light"],
      ["catppuccinLatte", "catppuccin", "light"],
    ] as const) {
      const raw = JSON.parse(JSON.stringify(emptyStore())) as {
        settings: Record<string, unknown>;
      };
      raw.settings.theme = legacy;
      const migrated = validateStoreFile(raw);
      expect(migrated.settings.theme, legacy).toBe(expectedTheme);
      expect(migrated.settings.appearanceMode, legacy).toBe(expectedMode);
    }
  });
});
