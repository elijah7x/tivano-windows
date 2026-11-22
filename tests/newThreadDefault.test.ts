// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-42 (frozen NewThreadDefault / makeThread modelSelection): the
// Settings › Conversation default and Quick chat's preset chip seed new
// chats — a fixed model verbatim, a preset's lead model + pair, and the
// Last-selection fallbacks for deleted/unavailable picks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  newHydraPair,
  newThreadDefaultAfterPairChange,
  newThreadDefaultSeed,
} from "../src/shared/hydra";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function makeEngine(): { store: Store; engine: Engine } {
  const root = mkdtempSync(join(tmpdir(), "tivano-ntd-"));
  dirs.push(root);
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}

describe("P2-42 newThreadDefaultSeed", () => {
  const pair = { ...newHydraPair("mock"), orchestratorModel: "m-lead", orchestratorEffort: "high" };
  it("model choice seeds the model verbatim (F17 semantics)", () => {
    expect(
      newThreadDefaultSeed({ kind: "model", model: "m1", effort: "low" }, [], true, "mock"),
    ).toEqual({ codexModel: "m1", codexEffort: "low" });
  });
  it("pair choice seeds the pair, preset mode, and its lead model/effort", () => {
    expect(
      newThreadDefaultSeed({ kind: "pair", pairId: pair.id }, [pair], true, "mock"),
    ).toEqual({
      codexModel: "m-lead",
      codexEffort: "high",
      hydraPairId: pair.id,
      subagentMode: "preset",
    });
  });
  it("a pair with no lead model leaves the model to Last selection", () => {
    const any = newHydraPair("mock");
    const seed = newThreadDefaultSeed({ kind: "pair", pairId: any.id }, [any], true, "mock");
    expect(seed).toMatchObject({ hydraPairId: any.id, subagentMode: "preset" });
    expect(seed).not.toHaveProperty("codexModel");
  });
  it("deleted preset or Hydra off falls back to Last selection", () => {
    expect(newThreadDefaultSeed({ kind: "pair", pairId: "gone" }, [pair], true, "mock")).toBeNull();
    expect(newThreadDefaultSeed({ kind: "pair", pairId: pair.id }, [pair], false, "mock")).toBeNull();
    // A pair stored against another provider applies to nothing here.
    expect(newThreadDefaultSeed({ kind: "pair", pairId: pair.id }, [pair], true, "codex")).toBeNull();
    expect(newThreadDefaultSeed(undefined, [pair], true, "mock")).toBeNull();
  });
  it("removing the default's pair resets it; other defaults keep", () => {
    const choice = { kind: "pair" as const, pairId: pair.id };
    expect(newThreadDefaultAfterPairChange(choice, [])).toBeUndefined();
    expect(newThreadDefaultAfterPairChange(choice, [pair])).toBe(choice);
    const m = { kind: "model" as const, model: "m" };
    expect(newThreadDefaultAfterPairChange(m, [])).toBe(m);
  });
});

describe("P2-42 createThread seeding", () => {
  it("seeds the thread from the saved preset default", () => {
    const { store, engine } = makeEngine();
    const pair = { ...newHydraPair("mock"), orchestratorModel: "m-lead" };
    engine.setSettings({
      hydraPairs: [pair],
      newThreadDefault: { kind: "pair", pairId: pair.id },
    });
    const t = engine.createThread(null);
    expect(t.hydraPairId).toBe(pair.id);
    expect(t.subagentMode).toBe("preset");
    expect(t.codexModel).toBe("m-lead");
    expect(store.state.settings.newThreadDefault).toEqual({ kind: "pair", pairId: pair.id });
  });
  it("a deleted preset falls back to Last selection and clears the default", () => {
    const { store, engine } = makeEngine();
    const pair = newHydraPair("mock");
    engine.setSettings({
      hydraPairs: [pair],
      newThreadDefault: { kind: "pair", pairId: pair.id },
      subagentModeDefault: "same",
    });
    // Removing the pair resets the saved default (frozen AppSettings).
    engine.setSettings({ hydraPairs: [] });
    expect(store.state.settings.newThreadDefault).toBeUndefined();
    const t = engine.createThread(null);
    expect(t.hydraPairId).toBeUndefined();
    expect(t.subagentMode).toBe("same");
  });
  it("an explicit preset on create applies without persisting (Quick chat)", () => {
    const { engine } = makeEngine();
    const pair = newHydraPair("mock");
    engine.setSettings({ hydraPairs: [pair] });
    const t = engine.createThread(null, undefined, {
      newThreadDefault: { kind: "pair", pairId: pair.id },
    });
    expect(t.hydraPairId).toBe(pair.id);
    expect(t.subagentMode).toBe("preset");
    const t2 = engine.createThread(null);
    expect(t2.hydraPairId).toBeUndefined();
  });
  it("model default sets codexModel; null resets to Last selection", () => {
    const { store, engine } = makeEngine();
    engine.setSettings({ newThreadDefault: { kind: "model", model: "m9", effort: "high" } });
    const t = engine.createThread(null);
    expect(t.codexModel).toBe("m9");
    expect(t.codexEffort).toBe("high");
    engine.setSettings({ newThreadDefault: null });
    expect(store.state.settings.newThreadDefault).toBeUndefined();
    expect(engine.createThread(null).codexModel).toBeUndefined();
  });
});
