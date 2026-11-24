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
import { Store, emptyStore } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { validateStoreFile } from "../src/main/storeDoc";
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
      hydraEnabled: true,
    });
  });
  it("a pair with no lead model leaves the model to Last selection", () => {
    const any = newHydraPair("mock");
    const seed = newThreadDefaultSeed({ kind: "pair", pairId: any.id }, [any], true, "mock");
    expect(seed).toMatchObject({
      hydraPairId: any.id,
      subagentMode: "preset",
      hydraEnabled: true,
    });
    expect(seed).not.toHaveProperty("codexModel");
  });
  it("a model the loaded catalog lacks falls back; an unloaded catalog keeps it", () => {
    expect(
      newThreadDefaultSeed(
        { kind: "model", model: "gone" },
        [],
        true,
        "mock",
        ["m1", "m2"],
      ),
    ).toBeNull();
    expect(
      newThreadDefaultSeed(
        { kind: "model", model: "m1" },
        [],
        true,
        "mock",
        ["m1", "m2"],
      ),
    ).toEqual({ codexModel: "m1" });
    // No catalog loaded yet → the verbatim pick stands (F17 semantics).
    expect(
      newThreadDefaultSeed({ kind: "model", model: "gone" }, [], true, "mock"),
    ).toEqual({ codexModel: "gone" });
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
  it("preset default gates on the app-wide Hydra switch, not the chat default", () => {
    const { engine } = makeEngine();
    const pair = newHydraPair("mock");
    // Frozen: settings.hydraEnabled (app-wide) gates the preset default;
    // the per-chat hydraDefaultEnabled may be off — the seeded thread is
    // still hydraEnabled (frozen hydraEnabled = true on the new thread).
    engine.setSettings({
      hydraPairs: [pair],
      hydraEnabled: true,
      hydraDefaultEnabled: false,
      newThreadDefault: { kind: "pair", pairId: pair.id },
    });
    const t = engine.createThread(null);
    expect(t.hydraPairId).toBe(pair.id);
    expect(t.subagentMode).toBe("preset");
    expect(t.hydraEnabled).toBe(true);
  });
  it("app-wide Hydra off falls back to Last selection for a preset default", () => {
    const { engine } = makeEngine();
    const pair = newHydraPair("mock");
    engine.setSettings({
      hydraPairs: [pair],
      hydraEnabled: false,
      newThreadDefault: { kind: "pair", pairId: pair.id },
    });
    const t = engine.createThread(null);
    expect(t.hydraPairId).toBeUndefined();
    expect(t.subagentMode).not.toBe("preset");
  });
  it("P2-43: an explicit pick wins over the saved default", () => {
    const { engine } = makeEngine();
    const pair = newHydraPair("mock");
    engine.setSettings({
      hydraPairs: [pair],
      newThreadDefault: { kind: "model", model: "m-saved" },
    });
    // Quick chat's own preset pick overrides the saved model default.
    const t = engine.createThread(null, undefined, {
      newThreadDefault: { kind: "pair", pairId: pair.id },
    });
    expect(t.hydraPairId).toBe(pair.id);
    expect(t.codexModel).toBeUndefined();
    // And the chip's explicit model overrides whatever the default seeded.
    const t2 = engine.createThread(null);
    expect(t2.codexModel).toBe("m-saved");
    engine.setThreadModel(t2.id, "m-picked", null, null);
    expect(t2.codexModel).toBe("m-picked");
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
  it("an explicit .model pick creates a pair-less chat (frozen makeThread)", () => {
    const { engine } = makeEngine();
    const pair = newHydraPair("mock");
    // The saved last-pair + sub-agent default must not leak onto an
    // explicit model pick — frozen makeThread starts a model-selected
    // chat with no pair at all.
    engine.setSettings({
      hydraPairs: [pair],
      lastHydraPairId: pair.id,
      subagentModeDefault: "preset",
    });
    const t = engine.createThread(null, undefined, {
      newThreadDefault: { kind: "model", model: "m1" },
    });
    expect(t.hydraPairId).toBeUndefined();
    expect(t.subagentMode).toBeUndefined();
    expect(t.codexModel).toBe("m1");
    // A saved model default behaves identically.
    engine.setSettings({
      newThreadDefault: { kind: "model", model: "m9", effort: "high" },
    });
    const t2 = engine.createThread(null);
    expect(t2.hydraPairId).toBeUndefined();
    expect(t2.subagentMode).toBeUndefined();
    expect(t2.codexModel).toBe("m9");
    expect(t2.codexEffort).toBe("high");
  });
  it("an explicit Last-selection pick overrides a saved preset default", () => {
    const { engine } = makeEngine();
    const pair = newHydraPair("mock");
    engine.setSettings({
      hydraPairs: [pair],
      newThreadDefault: { kind: "pair", pairId: pair.id },
      lastHydraPairId: pair.id,
      subagentModeDefault: "same",
    });
    const t = engine.createThread(null, undefined, { newThreadDefault: null });
    // Last selection resumes the last-used pair/mode — not the preset.
    expect(t.hydraPairId).toBe(pair.id);
    expect(t.subagentMode).toBe("same");
  });
  it("a persisted half-pick narrows to Last selection on load", () => {
    const doc = emptyStore();
    for (const half of [
      { kind: "model" },
      { kind: "pair" },
      { kind: "model", effort: "high" },
    ]) {
      const d = {
        ...doc,
        settings: { ...doc.settings, newThreadDefault: half },
      };
      expect(validateStoreFile(d).settings.newThreadDefault).toBeUndefined();
    }
    const good = {
      ...doc,
      settings: {
        ...doc.settings,
        newThreadDefault: { kind: "model", model: "m", effort: "low" },
      },
    };
    expect(validateStoreFile(good).settings.newThreadDefault).toEqual({
      kind: "model",
      model: "m",
      effort: "low",
    });
    const goodPair = {
      ...doc,
      settings: {
        ...doc.settings,
        newThreadDefault: { kind: "pair", pairId: "p1" },
      },
    };
    expect(validateStoreFile(goodPair).settings.newThreadDefault).toEqual({
      kind: "pair",
      pairId: "p1",
    });
  });
});
