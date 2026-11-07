// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 performanceMode setting: frozen default false (absent), explicit
// on/off round-trips through the whitelisted setSettings, and a
// malformed stored value is dropped by the document validator.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
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

describe("performanceMode (F26)", () => {
  it("defaults to the frozen 'off' when the store predates the field", () => {
    const { engine } = makeEngine(freshRoot());
    expect(engine.snapshot().settings.performanceMode).toBeUndefined();
  });

  it("persists an explicit on/off through setSettings across reopen", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    engine.setSettings({ performanceMode: true });
    expect(engine.snapshot().settings.performanceMode).toBe(true);
    store.close();

    const { store: store2, engine: engine2 } = makeEngine(root);
    expect(engine2.snapshot().settings.performanceMode).toBe(true);
    engine2.setSettings({ performanceMode: false });
    expect(engine2.snapshot().settings.performanceMode).toBe(false);
    store2.close();
  });

  it("a malformed stored value is dropped by validation, not kept", () => {
    const root = freshRoot();
    const { store } = makeEngine(root);
    store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.settings.performanceMode = "loud";
    writeFileSync(path, JSON.stringify(doc));
    const { engine } = makeEngine(root);
    expect(engine.snapshot().settings.performanceMode).toBeUndefined();
  });
});
