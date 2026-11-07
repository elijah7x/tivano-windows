// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F21 Hydra configuration layer: frozen model semantics (pair/profile
// matching, cap clamp, roster naming, launch room, cookbook resolve) plus
// the persisted settings round-trip and per-thread default seeding.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import {
  HYDRA_RECIPES,
  HYDRA_UNCAPPED_CONCURRENCY,
  clampedHydraCap,
  headProfileAgentSlug,
  headProfileBriefLabel,
  headProfileMatches,
  hydraHasRoom,
  hydraIndexNamed,
  hydraPersonaAt,
  hydraPersonaNamed,
  hydraProfileNamed,
  isPairAdded,
  newHydraPair,
  pairCustomName,
  pairHeadsProvider,
  pairSendsHeadsElsewhere,
  pairEffortsPhrase,
  hydraProviderName,
  projectHydraPair,
  recipeEffort,
  recipeMissingProvider,
  recipeModel,
  recipeSideProvider,
  resolveRecipe,
  type HydraCatalog,
  type HydraLaunch,
} from "../src/shared/hydra";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-hydra-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}

const catalogOf = (
  providers: Record<string, { ready?: boolean; models?: { id: string; name: string; efforts: string[] }[]; defaultModel?: string }>,
): HydraCatalog => ({
  isReady: (p) => providers[p]?.ready === true,
  models: (p) => providers[p]?.models ?? [],
  defaultModel: (p) => providers[p]?.defaultModel,
  displayName: (p) => p,
});

describe("F21 Hydra model (frozen Hydra.swift)", () => {
  it("head profile matching is case/whitespace-blind and slug-aware", () => {
    const p = { id: "x", name: "Deep Work" };
    expect(headProfileAgentSlug(p)).toBe("deep-work");
    expect(headProfileMatches(p, "deep work")).toBe(true);
    expect(headProfileMatches(p, " DEEP WORK ")).toBe(true);
    expect(headProfileMatches(p, "deep-work")).toBe(true);
    expect(headProfileMatches(p, "shallow")).toBe(false);
    expect(headProfileBriefLabel({ id: "x", name: "quick" }, (id) => id)).toBe("quick");
    expect(
      headProfileBriefLabel(
        { id: "x", name: "deep", provider: "codex", model: "opus" },
        (id) => `Provider-${id}`,
      ),
    ).toBe("deep (opus on Provider-codex)");
  });

  it("pair helpers follow the frozen semantics", () => {
    const pair = newHydraPair("codex");
    expect(pairHeadsProvider(pair)).toBe("codex");
    expect(pairSendsHeadsElsewhere(pair)).toBe(false);
    pair.workerProvider = "claude";
    expect(pairHeadsProvider(pair)).toBe("claude");
    expect(pairSendsHeadsElsewhere(pair)).toBe(true);
    pair.workerProvider = "codex";
    expect(pairSendsHeadsElsewhere(pair)).toBe(false);
    expect(pairCustomName(pair)).toBeUndefined();
    pair.name = "  ";
    expect(pairCustomName(pair)).toBeUndefined();
    pair.name = "  my team ";
    expect(pairCustomName(pair)).toBe("my team");
    // project pair applies only when hydra is on and the pair is available
    expect(projectHydraPair(pair.id, true, [pair])?.id).toBe(pair.id);
    expect(projectHydraPair(pair.id, false, [pair])).toBeUndefined();
    expect(projectHydraPair(pair.id, true, [])).toBeUndefined();
    expect(projectHydraPair(undefined, true, [pair])).toBeUndefined();
  });

  it("clamps the head cap into the frozen 1..8 range", () => {
    expect(clampedHydraCap(undefined)).toBeUndefined();
    expect(clampedHydraCap(0)).toBe(1);
    expect(clampedHydraCap(1)).toBe(1);
    expect(clampedHydraCap(8)).toBe(8);
    expect(clampedHydraCap(99)).toBe(8);
    expect(clampedHydraCap(4.9)).toBe(4);
  });

  it("launch room uses the pair cap or the frozen uncapped 8", () => {
    const launch = {
      headsProvider: "codex",
      headProfiles: [
        { id: "p1", name: "Quick" },
        { id: "p2", name: "Deep Work" },
      ],
      isolatesHeads: true,
      autoMerges: false,
      reviewsHeads: false,
      projects: [],
    } as HydraLaunch;
    expect(hydraHasRoom(launch, HYDRA_UNCAPPED_CONCURRENCY - 1)).toBe(true);
    expect(hydraHasRoom(launch, HYDRA_UNCAPPED_CONCURRENCY)).toBe(false);
    launch.maxHeads = 2;
    expect(hydraHasRoom(launch, 1)).toBe(true);
    expect(hydraHasRoom(launch, 2)).toBe(false);
    expect(hydraProfileNamed(launch, "quick")?.id).toBe("p1");
    expect(hydraProfileNamed(launch, "deep-work")?.id).toBe("p2");
    expect(hydraProfileNamed(launch, "nobody")).toBeUndefined();
  });

  it("roster wraps with round suffixes and resolves announced names exactly", () => {
    expect(hydraPersonaAt(0).name).toBe("Hank");
    expect(hydraPersonaAt(24).name).toBe("Gus");
    expect(hydraPersonaAt(25).name).toBe("Hank 2");
    expect(hydraPersonaAt(49).name).toBe("Gus 2");
    expect(hydraPersonaAt(50).name).toBe("Hank 3");
    expect(hydraIndexNamed("otto")).toBe(3);
    expect(hydraIndexNamed("OTTO")).toBe(3);
    expect(hydraIndexNamed("Otto 2")).toBe(3);
    expect(hydraIndexNamed("Ives")).toBeUndefined();
    expect(hydraPersonaNamed("Nova 3")?.name).toBe("Nova 3");
    expect(hydraPersonaNamed("otto")?.name).toBe("Otto");
    expect(hydraPersonaNamed("Stranger")).toBeUndefined();
  });
});

describe("F21 Hydra cookbook (frozen HydraCookbook+Resolve)", () => {
  const recipe = HYDRA_RECIPES.find((r) => r.id === "astra-terra")!;

  it("offers nothing while a side has no ready provider", () => {
    const cat = catalogOf({});
    expect(recipeSideProvider(recipe.lead, cat)).toBeUndefined();
    expect(resolveRecipe(recipe, cat)).toBeUndefined();
    // lead side's first choice is reported as the one to set up
    expect(recipeMissingProvider(recipe, cat)).toBe("codex");
  });

  it("resolves a pair on the first ready provider whose catalog lists the model", () => {
    const cat = catalogOf({
      codex: {
        ready: true,
        models: [
          { id: "astra-5", name: "Astra 5.9", efforts: ["low", "medium", "high"] },
          { id: "astra-6", name: "Astra 6", efforts: ["medium", "high"] },
          { id: "terra-56", name: "Terra 5.6", efforts: ["medium"] },
        ],
        defaultModel: "astra-6",
      },
      commandcode: { ready: false },
    });
    expect(recipeMissingProvider(recipe, cat)).toBeUndefined();
    // newest matching catalog member wins
    expect(recipeModel(["Astra"], "codex", cat)?.id).toBe("astra-6");
    const pair = resolveRecipe(recipe, cat)!;
    expect(pair.provider).toBe("codex");
    expect(pair.orchestratorModel).toBe("astra-6");
    // recipe effort kept only when the resolved model offers it
    expect(pair.orchestratorEffort).toBe("high");
    expect(pair.workerProvider).toBeUndefined(); // same provider → not elsewhere
    expect(pair.workerModel).toBe("terra-56");
    expect(pair.workerEffort).toBe("medium");
    // an already-added pair is detected on providers+models, not id
    expect(isPairAdded(pair, [pair])).toBe(true);
    expect(isPairAdded(pair, [newHydraPair("codex")])).toBe(false);
  });

  it("cross-provider recipes keep workerProvider and drop unoffered efforts", () => {
    const gemini = HYDRA_RECIPES.find((r) => r.id === "claude-opus-gemini-flash")!;
    const cat = catalogOf({
      claude: {
        ready: true,
        models: [{ id: "opus-55", name: "Opus 5.5", efforts: ["high", "max"] }],
      },
      antigravity: {
        ready: true,
        models: [{ id: "g38f", name: "Gemini 3.8 Flash", efforts: ["low"] }],
      },
      commandcode: { ready: true, models: [] },
    });
    const pair = resolveRecipe(gemini, cat)!;
    expect(pair.provider).toBe("claude");
    expect(pair.workerProvider).toBe("antigravity");
    expect(pair.workerModel).toBe("g38f");
    // "medium" not advertised by the resolved model → kept default (nil)
    expect(pair.workerEffort).toBeUndefined();
    expect(pair.maxHeads).toBe(6);
    // effort() itself: offered → kept, missing → nil
    expect(recipeEffort("high", { efforts: ["high"] })).toBe("high");
    expect(recipeEffort("high", { efforts: [] })).toBeUndefined();
    expect(recipeEffort(undefined, { efforts: ["high"] })).toBeUndefined();
  });

  it("falls back to a later provider when the first is not ready", () => {
    const cat = catalogOf({
      codex: { ready: false },
      commandcode: {
        ready: true,
        models: [
          { id: "astra-6x", name: "Astra 6", efforts: ["high"] },
          { id: "terra-56x", name: "Terra 5.6", efforts: ["medium"] },
        ],
      },
    });
    const pair = resolveRecipe(recipe, cat)!;
    expect(pair.provider).toBe("commandcode");
    expect(pair.orchestratorModel).toBe("astra-6x");
  });
});

describe("F21 Hydra settings persistence", () => {
  it("stores pairs, clamps caps, and drops empty lists", () => {
    const { store, engine } = make();
    const pair = newHydraPair("codex");
    pair.orchestratorModel = "astra-6";
    pair.workerProvider = "claude";
    pair.maxHeads = 42;
    pair.headProfiles = [{ id: "h1", name: "quick", model: "terra" }];
    engine.setSettings({ hydraPairs: [pair], hydraEnabled: true, hydraMaxHeads: 99 });
    const s = store.state.settings;
    expect(s.hydraPairs?.length).toBe(1);
    expect(s.hydraPairs?.[0]?.maxHeads).toBe(8);
    expect(s.hydraMaxHeads).toBe(8);
    // null means "no cap" — the key is removed, not stored
    engine.setSettings({ hydraMaxHeads: null });
    expect(store.state.settings.hydraMaxHeads).toBeUndefined();
    engine.setSettings({ hydraPairs: [] });
    expect(store.state.settings.hydraPairs).toBeUndefined();
  });

  it("persists every hydra key verbatim and survives a reload", () => {
    const root = tmp();
    const { store, engine } = make(root);
    engine.setSettings({
      hydraEnabled: false,
      hydraDefaultEnabled: false,
      hydraQueueHeads: false,
      hydraAlwaysHeads: true,
      hydraIsolateHeads: false,
      hydraAutoMerge: true,
      hydraReviewHeads: true,
      hydraArchivesCodexHeads: true,
      hydraShowsHeadDetails: true,
      hydraAutoPopsHeads: true,
      hydraTempersHeadEffort: false,
      hasSeenHydraIntro: true,
      lastHydraPairId: "pair-1",
    });
    store.close(); // flushes and releases the data-root lock
    const store2 = new Store(root);
    store2.open();
    const s = store2.state.settings;
    expect(s.hydraEnabled).toBe(false);
    expect(s.hydraAlwaysHeads).toBe(true);
    expect(s.hydraIsolateHeads).toBe(false);
    expect(s.hydraAutoMerge).toBe(true);
    expect(s.hydraArchivesCodexHeads).toBe(true);
    expect(s.hydraAutoPopsHeads).toBe(true);
    expect(s.hydraTempersHeadEffort).toBe(false);
    expect(s.lastHydraPairId).toBe("pair-1");
  });

  it("seeds new threads from hydraDefaultEnabled and the last pair", () => {
    const { engine } = make();
    engine.setSettings({ lastHydraPairId: "pair-9" });
    const t1 = engine.createThread(null, "a");
    expect(t1.hydraEnabled).toBe(true); // absent default = frozen true
    expect(t1.hydraPairId).toBe("pair-9");
    engine.setSettings({ hydraDefaultEnabled: false, lastHydraPairId: null });
    const t2 = engine.createThread(null, "b");
    expect(t2.hydraEnabled).toBe(false);
    expect(t2.hydraPairId).toBeUndefined();
  });

  it("per-chat flip writes back to hydraDefaultEnabled (frozen setHydra)", () => {
    const { engine, store } = make();
    const t1 = engine.createThread(null, "a");
    expect(t1.hydraEnabled).toBe(true);
    // Frozen parity: a per-chat flip is also the default new chats seed from.
    engine.setThreadHydra(t1.id, false);
    expect(t1.hydraEnabled).toBe(false);
    expect(store.state.settings.hydraDefaultEnabled).toBe(false);
    const t2 = engine.createThread(null, "b");
    expect(t2.hydraEnabled).toBe(false);
    // …and flipping any chat back on reseeds the default.
    engine.setThreadHydra(t2.id, true);
    expect(t2.hydraEnabled).toBe(true);
    expect(store.state.settings.hydraDefaultEnabled).toBe(true);
    // Unknown thread identity stays rejected.
    expect(() => engine.setThreadHydra("missing", true)).toThrow(/unknown thread/);
  });

  it("pairEffortsPhrase follows the frozen summary cases", () => {
    const title = (e: string) => e.charAt(0).toUpperCase() + e.slice(1);
    const p = (o: Partial<import("../src/shared/hydra").HydraPair>) =>
      ({ id: "x", provider: "codex", headProfiles: [], ...o }) as import(
        "../src/shared/hydra"
      ).HydraPair;
    // Same effort on both sides → one phrase ("High effort").
    expect(pairEffortsPhrase(p({ orchestratorEffort: "high", workerEffort: "high" }), title))
      .toEqual({ kind: "same", lead: "High" });
    // Differing → split phrase.
    expect(pairEffortsPhrase(p({ orchestratorEffort: "high", workerEffort: "medium" }), title))
      .toEqual({ kind: "split", lead: "High", heads: "Medium" });
    // One side only.
    expect(pairEffortsPhrase(p({ orchestratorEffort: "max" }), title))
      .toEqual({ kind: "lead", lead: "Max" });
    expect(pairEffortsPhrase(p({ workerEffort: "low" }), title))
      .toEqual({ kind: "heads", heads: "Low" });
    // Neither → nothing to say.
    expect(pairEffortsPhrase(p({}), title)).toEqual({ kind: "none" });
  });

  it("hydraProviderName carries the frozen displayName table", () => {
    expect(hydraProviderName("claude")).toBe("Claude");
    expect(hydraProviderName("commandcode")).toBe("Command Code");
    expect(hydraProviderName("antigravity")).toBe("Antigravity");
    expect(hydraProviderName("zai")).toBe("Z.ai");
    expect(hydraProviderName("meta")).toBe("Meta");
    expect(hydraProviderName("cursor")).toBe("Cursor");
    expect(hydraProviderName("deepseek")).toBe("DeepSeek");
    expect(hydraProviderName("codex")).toBe("Codex");
    // Unknown ids pass through honestly, never a fabricated name.
    expect(hydraProviderName("futureprovider")).toBe("futureprovider");
  });
});
