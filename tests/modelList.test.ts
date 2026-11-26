// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17 model-list slices: the frozen AppSettings layout ops ported to
// shared/modelList.ts, plus persistence through the whitelisted
// setSettings + storeDoc validators.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  MODEL_LIST_LIMIT,
  PICKER_MODELS_CACHE_LIMIT,
  PickerModelsCache,
  addPin,
  addSection,
  applyDraftRename,
  cachedPickerModels,
  defaultPickerCategory,
  dropPinOnGroupEnd,
  dropPinOnPin,
  modelListItems,
  moveModelListItem,
  moveModelSection,
  movePinToSection,
  moveSectionToTarget,
  modelLineageKey,
  modelNameVersion,
  parseVariantName,
  partitionModelBlocks,
  partitionPickerModels,
  pickerCategoryKey,
  pickerPairMatches,
  pickerPairTitle,
  pinId,
  planModelDropOnPin,
  planModelDropOnRail,
  planModelDropOnWallGroup,
  prefKey,
  protectedModelIds,
  removePin,
  removeSection,
  renameSection,
  resolvePickerCategory,
  resolveRecentPickerModel,
  resolveRecentPickerPair,
  sectionEditTargetAlive,
  sectionIdOfPin,
  setModelListItems,
  simplifiedModels,
  toggleSectionCollapsed,
  type ModelPin,
  type ModelSection,
} from "../src/shared/modelList";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-ml-"));
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

const P = (id: string): ModelPin => ({ provider: "codex", modelID: id });
const S = (id: string, name: string, position: number): ModelSection => ({ id, name, position });

describe("modelListItems (frozen interleave)", () => {
  it("sits a heading before the pin at its position; position == count lands at end", () => {
    const items = modelListItems([P("a"), P("b"), P("c")], [S("s1", "G", 1)]);
    expect(items.map((i) => (i.kind === "pin" ? i.pin.modelID : `sec:${i.section.name}`))).toEqual([
      "a",
      "sec:G",
      "b",
      "c",
    ]);
    const tail = modelListItems([P("a")], [S("s2", "End", 1)]);
    expect(tail.map((i) => i.kind)).toEqual(["pin", "section"]);
  });

  it("orders two headings at the same position by stable declaration order", () => {
    const items = modelListItems([P("a")], [S("s1", "One", 0), S("s2", "Two", 0)]);
    const names = items.filter((i) => i.kind === "section").map((i) => i.section.name);
    expect(names).toEqual(["One", "Two"]);
  });
});

describe("setModelListItems round-trip", () => {
  it("recomputes each heading's position from its slot in the list", () => {
    const pins = [P("a"), P("b")];
    const sections = [S("s1", "G", 1)];
    const split = setModelListItems(modelListItems(pins, sections));
    expect(split.modelList).toEqual(pins);
    expect(split.modelSections[0]).toMatchObject({ id: "s1", position: 1 });
  });
});

describe("pin ops", () => {
  it("addPin dedupes by id and refuses past the frozen cap", () => {
    let list: ModelPin[] = [];
    list = addPin(list, P("m1"));
    list = addPin(list, P("m1"));
    expect(list).toHaveLength(1);
    for (let i = 0; i < MODEL_LIST_LIMIT + 5; i++) list = addPin(list, P(`m${i}`));
    expect(list).toHaveLength(MODEL_LIST_LIMIT);
  });

  it("removePin drops the row and re-pins heading positions", () => {
    const pins = [P("a"), P("b"), P("c")];
    const sections = [S("s1", "G", 1)];
    const r = removePin(pins, sections, P("b"));
    expect(r.modelList.map(pinId)).toEqual(["codex/a", "codex/c"]);
    expect(r.modelSections[0]!.position).toBe(1);
  });
});

describe("moveModelListItem / movePinToSection", () => {
  it("moves a pin before and after a target in the unified list", () => {
    const pins = [P("a"), P("b"), P("c")];
    const r1 = moveModelListItem(pins, [], { kind: "pin", pin: P("a") }, { kind: "pin", pin: P("c") }, true);
    expect(r1!.modelList.map((p) => p.modelID)).toEqual(["b", "c", "a"]);
    const r2 = moveModelListItem(pins, [], { kind: "pin", pin: P("c") }, { kind: "pin", pin: P("a") }, false);
    expect(r2!.modelList.map((p) => p.modelID)).toEqual(["c", "a", "b"]);
  });

  it("returns null when dropping a row onto itself", () => {
    const pins = [P("a")];
    expect(
      moveModelListItem(pins, [], { kind: "pin", pin: P("a") }, { kind: "pin", pin: P("a") }, false),
    ).toBeNull();
  });

  it("moves a pin into a group at its end, before a member when asked", () => {
    const pins = [P("u"), P("g1"), P("g2")];
    const sections = [S("s1", "G", 1)];
    const r = movePinToSection(pins, sections, P("u"), "s1");
    expect(r!.modelList.map((p) => p.modelID)).toEqual(["g1", "g2", "u"]);
    // u lands inside the group: the next heading boundary stays ahead.
    expect(r!.modelSections[0]!.position).toBe(0);
    const r2 = movePinToSection(r!.modelList, r!.modelSections, P("u"), "s1", P("g1"));
    expect(r2!.modelList.map((p) => p.modelID)).toEqual(["u", "g1", "g2"]);
  });

  it("moves a pin out of a group into the ungrouped top", () => {
    const pins = [P("g1"), P("u")];
    const sections = [S("s1", "G", 0)];
    const r = movePinToSection(pins, sections, P("g1"), null);
    expect(r!.modelList.map((p) => p.modelID)).toEqual(["g1", "u"]);
    expect(r!.modelSections[0]!.position).toBe(1);
  });
});

describe("section ops", () => {
  it("moveModelSection carries the group's models one block up/down", () => {
    const pins = [P("u"), P("g1"), P("h1")];
    const sections = [S("s1", "G", 1), S("s2", "H", 2)];
    const r = moveModelSection(pins, sections, "s2", -1);
    expect(r!.modelList.map((p) => p.modelID)).toEqual(["u", "h1", "g1"]);
    expect(r!.modelSections.map((s) => s.id)).toEqual(["s2", "s1"]);
    // Bounds refuse.
    expect(moveModelSection(pins, sections, "s1", -1)).toBeNull();
  });

  it("addSection lands at the end; remove keeps the group's models on top of the next boundary", () => {
    const sections = addSection([], "Group", 2);
    expect(sections[0]).toMatchObject({ name: "Group", position: 2 });
    const r = removeSection([S("s1", "G", 0)], ["s1"], "s1");
    expect(r.modelSections).toHaveLength(0);
    expect(r.collapsedModelSections).toHaveLength(0);
  });

  it("rename + collapse toggles", () => {
    expect(renameSection([S("s1", "G", 0)], "s1", "New")[0]!.name).toBe("New");
    expect(toggleSectionCollapsed([], "s1")).toEqual(["s1"]);
    expect(toggleSectionCollapsed(["s1"], "s1")).toEqual([]);
  });
});

describe("settings persistence (F17)", () => {
  it("round-trips the four slices through setSettings across reopen", () => {
    const root = freshRoot();
    const first = makeEngine(root);
    first.engine.setSettings({
      modelList: [P("a"), P("b")],
      modelSections: [S("s1", "G", 1)],
      collapsedModelSections: ["s1"],
      modelPreferences: { [prefKey("codex", "a")]: { effort: "high", fastMode: true } },
    });
    first.store.close();
    const { engine } = makeEngine(root);
    const s = engine.snapshot().settings;
    expect(s.modelList?.map((p) => p.modelID)).toEqual(["a", "b"]);
    expect(s.modelSections?.[0]).toMatchObject({ id: "s1", name: "G", position: 1 });
    expect(s.collapsedModelSections).toEqual(["s1"]);
    expect(s.modelPreferences?.["codex/a"]).toEqual({ effort: "high", fastMode: true });
  });

  it("empty arrays clear the persisted slices (frozen absent = empty)", () => {
    const { engine } = makeEngine(freshRoot());
    engine.setSettings({ modelList: [P("a")], modelSections: [S("s1", "G", 0)] });
    engine.setSettings({ modelList: [], modelSections: [] });
    const s = engine.snapshot().settings;
    expect(s.modelList).toBeUndefined();
    expect(s.modelSections).toBeUndefined();
  });

  it("a foreign provider pin quarantines the store on load (strict doc validator)", () => {
    const root = freshRoot();
    const first = makeEngine(root);
    first.engine.setSettings({ modelList: [P("a")] });
    first.store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.settings.modelList = [{ provider: "dsh", modelID: "x" }];
    writeFileSync(path, JSON.stringify(doc));
    const { engine } = makeEngine(root);
    expect(engine.snapshot().settings.modelList).toBeUndefined();
  });

  it("P1-25: hideOutdatedModels round-trips; absent on pre-P1-25 stores", () => {
    const root = freshRoot();
    const first = makeEngine(root);
    expect(first.engine.snapshot().settings.hideOutdatedModels).toBeUndefined();
    first.engine.setSettings({ hideOutdatedModels: false });
    first.store.close();
    const { engine } = makeEngine(root);
    expect(engine.snapshot().settings.hideOutdatedModels).toBe(false);
    engine.setSettings({ hideOutdatedModels: true });
    expect(engine.snapshot().settings.hideOutdatedModels).toBe(true);
  });
});

// ── P1-25: hide outdated models (frozen ModelFamilies + ModelVisibility) ──

const M = (id: string, name: string, isDefault = false) => ({ id, name, isDefault });

describe("P1-25 name parsing and versions", () => {
  it("reads the variant words from the end like frozen parse()", () => {
    expect(parseVariantName("GPT-6 Sol High Fast")).toEqual({
      base: "GPT-6 Sol",
      effort: "high",
      isFast: true,
    });
    expect(parseVariantName("Claude Opus 5.5 XHigh Fast")).toEqual({
      base: "Claude Opus 5.5",
      effort: "xhigh",
      isFast: true,
    });
    expect(parseVariantName("GPT-6 Sol No Thinking")).toEqual({
      base: "GPT-6 Sol",
      effort: "none",
      isFast: false,
    });
    // "Thinking" alone names a model of its own, not an effort.
    expect(parseVariantName("Claude Opus 4.6 Thinking").effort).toBeUndefined();
    expect(parseVariantName("GPT-6 Sol Extra High").effort).toBe("xhigh");
    expect(parseVariantName("GPT-6 Sol").effort).toBeUndefined();
  });

  it("keys lineages like the frozen lineageKey", () => {
    expect(modelLineageKey("Claude Opus 4.8")).toBe("claude opus");
    expect(modelLineageKey("Claude Opus 4.6 Thinking 1M")).toBe("claude opus");
    expect(modelLineageKey("claude-opus-5-5")).toBe("claude opus");
    expect(modelLineageKey("Kimi K2.7")).toBe("kimi");
    expect(modelLineageKey("Kimi K3")).toBe("kimi");
    expect(modelLineageKey("GLM-5.3 Flash")).toBe("glm flash");
  });

  it("reads versions like the frozen version()", () => {
    expect(modelNameVersion("Claude Opus 5.5")).toEqual([5, 5]);
    expect(modelNameVersion("claude-opus-4-8")).toEqual([4, 8]);
    expect(modelNameVersion("GLM-5.3")).toEqual([5, 3]);
    expect(modelNameVersion("glm-5p3")).toEqual([5, 3]);
    expect(modelNameVersion("GPT-OSS 120B")).toEqual([]);
    expect(modelNameVersion("K3-256K")).toEqual([3]);
    expect(modelNameVersion("Kimi K2.7")).toEqual([2, 7]);
    expect(modelNameVersion("Fixture Model")).toEqual([]);
  });
});

describe("simplifiedModels (frozen simplified)", () => {
  const catalog = () => [
    M("gpt54", "GPT-5.4 Sol"),
    M("gpt56", "GPT-5.6 Sol"),
    M("gpt60", "GPT-6.0 Sol"),
    M("gpt61", "GPT-6.1 Sol"),
    M("gpt61h", "GPT-6.1 Sol High"),
    M("gem30", "Gemini 3.0 Flash"),
    M("sonnet46", "Sonnet 4.6"),
    M("plain", "Fixture Model"),
  ];

  it("keeps each vendor's three newest versions, folding effort rows", () => {
    const kept = simplifiedModels(catalog()).map((m) => m.id);
    // gpt keeps 6.1/6.0/5.6 — 5.4 is the fourth version; "… High"
    // folds behind its listed base; the versionless row stays.
    expect(kept).toEqual(["gpt56", "gpt60", "gpt61", "gem30", "sonnet46", "plain"]);
  });

  it("a variant row stays when its base is not itself a row", () => {
    const kept = simplifiedModels([
      M("b", "Vendor 2.0"),
      M("vh", "Other 1.0 High"),
    ]).map((m) => m.id);
    expect(kept).toContain("vh");
  });

  it("protected and default rows always show, even when outdated", () => {
    const kept = simplifiedModels(catalog(), {
      isProtected: (m) => m.id === "gpt54",
    }).map((m) => m.id);
    expect(kept).toContain("gpt54");
    const withDefault = simplifiedModels([
      ...catalog(),
      M("old", "GPT-4.1 Sol", true),
    ]).map((m) => m.id);
    expect(withDefault).toContain("old");
  });

  it("keeps a line's newest row while it shares the vendor's newest major", () => {
    const kept = simplifiedModels([
      M("a9", "Gemini 4.9 Argon"),
      M("a8", "Gemini 4.8 Argon"),
      M("a7", "Gemini 4.7 Argon"),
      M("f4", "Gemini 4.0 Flash"),
      M("f3", "Gemini 3.8 Flash"),
    ]).map((m) => m.id);
    // Vendor's newest three are all Argon; the Flash line survives on
    // its newest row only while that row is of the newest major (4.0),
    // so 3.8 hides.
    expect(kept).toEqual(["a9", "a8", "a7", "f4"]);
  });

  it("counts versions per vendor, not per line", () => {
    const kept = simplifiedModels([
      M("s6", "GPT-6.0 Sol"),
      M("s61", "GPT-6.1 Sol"),
      M("t56", "GPT-5.6 Terra"),
      M("m54", "GPT-5.4 Mini"),
    ]).map((m) => m.id);
    // GPT's three newest are 6.1/6.0/5.6 — "GPT-5.4 Mini" goes although
    // its own line has nothing newer (frozen example).
    expect(kept).toEqual(["s6", "s61", "t56"]);
  });

  it("honours knownVersions from other catalogues", () => {
    const known = new Map([["claude", new Set(["5.5", "5.0", "4.8"])]]);
    const kept = simplifiedModels([M("s", "Sonnet 4.6")], {
      knownVersions: known,
    }).map((m) => m.id);
    // Claude's three newest known versions supersede 4.6 entirely.
    expect(kept).toEqual([]);
    const keptHere = simplifiedModels(
      [M("s", "Sonnet 4.6"), M("o", "Other 1.0")],
      { knownVersions: known },
    ).map((m) => m.id);
    // A vendor this list does not carry adds nothing.
    expect(keptHere).toEqual(["o"]);
  });
});

describe("protectedModelIds (frozen protectedModelIDs)", () => {
  it("protects pins, extras and pair lead/head/profile models on the provider", () => {
    const ids = protectedModelIds(
      {
        modelList: [P("pinned-m"), { provider: "codex", modelID: "pin2" }],
        hydraPairs: [
          {
            id: "pair1",
            provider: "codex",
            orchestratorModel: "lead-m",
            workerModel: "work-m",
            headProfiles: [{ id: "h1", name: "h", model: "prof-m" }],
          },
          {
            id: "pair2",
            provider: "other",
            orchestratorModel: "foreign-lead",
            workerProvider: "codex",
            workerModel: "home-worker",
            headProfiles: [{ id: "h2", name: "h", provider: "other", model: "foreign-prof" }],
          },
        ],
      },
      "codex",
      ["thread-m"],
    );
    expect(ids).toEqual(
      new Set(["thread-m", "pinned-m", "pin2", "lead-m", "work-m", "prof-m", "home-worker"]),
    );
  });
});

describe("applyDraftRename (P2-33 edit-then-remove fold)", () => {
  it("folds the in-flight rename into the written list", () => {
    const out = applyDraftRename([S("a", "A", 0), S("b", "B", 1)], "b", "Bee");
    expect(out.map((s) => s.name)).toEqual(["A", "Bee"]);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("leaves the list untouched with no edit or a blank draft", () => {
    const secs = [S("a", "A", 0)];
    expect(applyDraftRename(secs, null, "x")).toBe(secs);
    expect(applyDraftRename(secs, "a", "   ")).toBe(secs);
  });

  it("rename-then-remove lands both changes in one write", () => {
    const folded = applyDraftRename([S("a", "A", 0), S("b", "B", 1)], "a", "Aye");
    const removed = removeSection(folded, ["b"], "b");
    expect(removed.modelSections.map((s) => s.name)).toEqual(["Aye"]);
    expect(removed.collapsedModelSections).toEqual([]);
  });

  it("a rename aimed at a gone section is a no-op (no resurrection)", () => {
    const secs = [S("a", "A", 0)];
    const out = applyDraftRename(secs, "ghost", "G");
    expect(out.map((s) => s.name)).toEqual(["A"]);
  });
});

describe("sectionEditTargetAlive (P2-33 un-echoed write grace)", () => {
  it("keeps a just-added section alive before the store echoes it", () => {
    const before = [S("a", "A", 0)];
    const added = addSection(before, "New group", 3);
    const newId = added[added.length - 1]!.id;
    // The click sets editingId to the new id but the snapshot still
    // holds the old list — the target must survive that gap.
    expect(sectionEditTargetAlive(before, newId, newId)).toBe(true);
    // Once the echo lands the pending marker is released and the
    // echoed list alone keeps it alive.
    expect(sectionEditTargetAlive(added, newId, null)).toBe(true);
  });

  it("clears a vanished or stale target, and never a null one", () => {
    const secs = [S("a", "A", 0)];
    expect(sectionEditTargetAlive(secs, "a", null)).toBe(true);
    expect(sectionEditTargetAlive(secs, "gone", null)).toBe(false);
    expect(sectionEditTargetAlive(secs, "other", "pending")).toBe(false);
    expect(sectionEditTargetAlive(secs, null, "pending")).toBe(false);
  });
});

describe("P2-56 chip drag-reorder and rail drops", () => {
  it("partitionModelBlocks and sectionIdOfPin map pins to ungrouped and groups", () => {
    const pins = [P("u1"), P("a1"), P("a2"), P("b1")];
    const secs = [S("s1", "Alpha", 1), S("s2", "Beta", 3)];
    const blocks = partitionModelBlocks(pins, secs);
    expect(blocks.ungrouped.map((p) => p.modelID)).toEqual(["u1"]);
    expect(blocks.groups.map((g) => [g.section.name, g.pins.map((p) => p.modelID)])).toEqual([
      ["Alpha", ["a1", "a2"]],
      ["Beta", ["b1"]],
    ]);
    expect(sectionIdOfPin(pins, secs, P("u1"))).toBeNull();
    expect(sectionIdOfPin(pins, secs, P("a2"))).toBe("s1");
    expect(sectionIdOfPin(pins, secs, P("b1"))).toBe("s2");
  });

  it("dropPinOnPin reorders within the same group by index direction", () => {
    const pins = [P("a1"), P("a2"), P("a3")];
    const secs = [S("s1", "Alpha", 0)];
    // Dragging forward (0 -> 2) places after target.
    const fwd = dropPinOnPin(pins, secs, P("a1"), P("a3"));
    expect(fwd!.modelList.map((p) => p.modelID)).toEqual(["a2", "a3", "a1"]);
    // Dragging backward (2 -> 0) places before target.
    const back = dropPinOnPin(pins, secs, P("a3"), P("a1"));
    expect(back!.modelList.map((p) => p.modelID)).toEqual(["a3", "a1", "a2"]);
    // Dropping on self is a no-op.
    expect(dropPinOnPin(pins, secs, P("a1"), P("a1"))).toBeNull();
  });

  it("dropPinOnPin moves across groups before the target chip", () => {
    const pins = [P("u1"), P("a1"), P("a2"), P("b1")];
    const secs = [S("s1", "Alpha", 1), S("s2", "Beta", 3)];
    const moved = dropPinOnPin(pins, secs, P("b1"), P("a2"));
    expect(moved!.modelList.map((p) => p.modelID)).toEqual(["u1", "a1", "b1", "a2"]);
    expect(moved!.modelSections.map((s) => [s.id, s.position])).toEqual([
      ["s1", 1],
      ["s2", 4],
    ]);
  });

  it("dropPinOnGroupEnd moves to the end of a group or Ungrouped and skips no-ops", () => {
    const pins = [P("u1"), P("a1"), P("a2")];
    const secs = [S("s1", "Alpha", 1), S("s2", "Empty", 3)];
    // Move ungrouped pin into empty group s2.
    const toEmpty = dropPinOnGroupEnd(pins, secs, P("u1"), "s2");
    expect(toEmpty!.modelList.map((p) => p.modelID)).toEqual(["a1", "a2", "u1"]);
    expect(toEmpty!.modelSections.map((s) => [s.id, s.position])).toEqual([
      ["s1", 0],
      ["s2", 2],
    ]);
    // Same-group empty space moves non-last pin to end of group.
    const toEndSame = dropPinOnGroupEnd(pins, secs, P("a1"), "s1");
    expect(toEndSame!.modelList.map((p) => p.modelID)).toEqual(["u1", "a2", "a1"]);
    // Dropping last pin on its own group end is a no-op.
    expect(dropPinOnGroupEnd(pins, secs, P("a2"), "s1")).toBeNull();
    // Rail mode forbids dropping onto the pin's current group.
    expect(
      dropPinOnGroupEnd(pins, secs, P("a1"), "s1", { requireDifferentGroup: true }),
    ).toBeNull();
    // Moving back to Ungrouped puts it at end of ungrouped head.
    const toUngrouped = dropPinOnGroupEnd(pins, secs, P("a1"), null, {
      requireDifferentGroup: true,
    });
    expect(toUngrouped!.modelList.map((p) => p.modelID)).toEqual(["u1", "a1", "a2"]);
    expect(toUngrouped!.modelSections.map((s) => [s.id, s.position])).toEqual([
      ["s1", 2],
      ["s2", 3],
    ]);
  });

  it("moveSectionToTarget reorders groups across multiple slots", () => {
    const pins = [P("u"), P("a"), P("b"), P("c")];
    const secs = [S("s1", "One", 1), S("s2", "Two", 2), S("s3", "Three", 3)];
    const moved = moveSectionToTarget(pins, secs, "s3", "s1");
    expect(moved!.modelList.map((p) => p.modelID)).toEqual(["u", "c", "a", "b"]);
    expect(moved!.modelSections.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(moveSectionToTarget(pins, secs, "s1", "s1")).toBeNull();
  });

  it("partitionPickerModels and defaultPickerCategory follow groups", () => {
    const opts = new Map([
      ["u1", M("u1", "Ungrouped 1")],
      ["a1", M("a1", "Alpha 1")],
      ["b1", M("b1", "Beta 1")],
    ]);
    const part = partitionPickerModels(
      [P("u1"), P("a1"), P("b1")],
      [S("s1", "Alpha", 1), S("s2", "Beta", 2), S("s3", "Empty", 3)],
      [],
      opts,
    );
    expect(part.ungrouped.map((e) => e.modelId)).toEqual(["u1"]);
    expect(part.groups.map((g) => [g.section.name, g.items.map((i) => i.modelId)])).toEqual([
      ["Alpha", ["a1"]],
      ["Beta", ["b1"]],
      ["Empty", []],
    ]);
    expect(pickerCategoryKey(defaultPickerCategory(part, "b1"))).toBe("group/s2");
    expect(pickerCategoryKey(defaultPickerCategory(part, "u1"))).toBe("all");
    expect(pickerCategoryKey(defaultPickerCategory(part, ""))).toBe("all");
    expect(
      pickerCategoryKey(resolvePickerCategory({ kind: "group", sectionId: "missing" }, part)!),
    ).toBe("all");
    expect(
      pickerCategoryKey(resolvePickerCategory({ kind: "ungrouped" }, part)!),
    ).toBe("ungrouped");

    // Unpinned catalog still keeps user sections visible with empty counts.
    const unpinnedPart = partitionPickerModels(
      [],
      [S("s1", "Alpha", 0)],
      [M("u1", "Ungrouped 1")],
      opts,
    );
    expect(unpinnedPart.groups.map((g) => [g.section.name, g.items.length])).toEqual([
      ["Alpha", 0],
    ]);
    expect(unpinnedPart.ungrouped.map((e) => e.modelId)).toEqual(["u1"]);
  });

  it("P2-03 resolves combos category, pair titles/search, and recent pair/model", () => {
    const opts = new Map([
      ["m1", M("m1", "GPT-5.4")],
      ["m2", M("m2", "GPT-5.4 Mini")],
    ]);
    const part = partitionPickerModels([P("m1")], [S("s1", "Reasoning", 0)], [], opts);
    expect(
      pickerCategoryKey(
        defaultPickerCategory(part, "m1", { leadsWithPair: true, hasPairs: true }),
      ),
    ).toBe("combos");
    expect(
      pickerCategoryKey(
        resolvePickerCategory({ kind: "combos" }, part, { hasPairs: true })!,
      ),
    ).toBe("combos");
    expect(
      pickerCategoryKey(
        resolvePickerCategory({ kind: "combos" }, part, { hasPairs: false })!,
      ),
    ).toBe("all");

    const pairNamed = {
      id: "pair-1",
      provider: "codex",
      orchestratorModel: "m1",
      workerModel: "m2",
      name: "Fast Duo",
      headProfiles: [],
    };
    const pairAuto = {
      id: "pair-2",
      provider: "codex",
      orchestratorModel: "m1",
      headProfiles: [],
    };
    const modelName = (_p: string, id: string | undefined) => (id ? opts.get(id)?.name : undefined);
    expect(
      pickerPairTitle(
        pairNamed,
        modelName,
        () => "Codex",
        (p) => `Any ${p} model`,
        (l) => `${l} + itself`,
      ),
    ).toBe("Fast Duo");
    expect(
      pickerPairTitle(
        pairAuto,
        modelName,
        () => "Codex",
        (p) => `Any ${p} model`,
        (l) => `${l} + itself`,
      ),
    ).toBe("GPT-5.4 + itself");

    expect(pickerPairMatches(pairNamed, "duo", "Fast Duo", "Codex")).toBe(true);
    expect(pickerPairMatches(pairNamed, "mini", "Fast Duo", "GPT-5.4 + GPT-5.4 Mini")).toBe(true);
    expect(pickerPairMatches(pairNamed, "opus", "Fast Duo", "Codex")).toBe(false);

    expect(resolveRecentPickerPair([pairNamed, pairAuto], "pair-2")?.id).toBe("pair-2");
    expect(resolveRecentPickerPair([pairNamed, pairAuto], "missing")).toBeUndefined();
    expect(
      resolveRecentPickerModel(part.groups[0]!.items, { provider: "codex", modelID: "m1" })
        ?.modelId,
    ).toBe("m1");
    expect(
      resolveRecentPickerModel(part.groups[0]!.items, {
        provider: "codex",
        modelID: "missing",
      }),
    ).toBeUndefined();
  });

  it("P2-03 persists recents, applies/clears hydraPairId via setThreadModel, and enforces adaptive lock", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const t = engine.createThread(null, "picker-thread");
    engine.setSettings({
      lastNewChatModel: { provider: "codex", modelID: "gpt-5.4" },
    });
    engine.setThreadModel(t.id, "gpt-5.4", "high", null, "pair-1");
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.hydraPairId).toBe("pair-1");
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.subagentMode).toBe("preset");
    expect(engine.snapshot().settings.lastHydraPairId).toBe("pair-1");
    expect(engine.snapshot().settings.lastNewChatPairId).toBe("pair-1");
    expect(engine.snapshot().settings.lastNewChatModel).toEqual({
      provider: "codex",
      modelID: "gpt-5.4",
    });

    // Leaving pair via setThreadModel(..., null) clears hydraPairId, preset mode,
    // and lastHydraPairId (so new chats start on no pair), while keeping lastNewChatPairId
    // for the picker's Recent row.
    engine.setThreadModel(t.id, "gpt-5.4-mini", null, null, null);
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.hydraPairId).toBeUndefined();
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.subagentMode).toBeUndefined();
    expect(engine.snapshot().settings.lastHydraPairId).toBeUndefined();
    expect(engine.snapshot().settings.lastNewChatPairId).toBe("pair-1");
    const nextChat = engine.createThread(null, "after-leaving-pair");
    expect(nextChat.hydraPairId).toBeUndefined();

    // Re-enables hydraEnabled on the thread when applying a pair.
    engine.setThreadHydra(t.id, false);
    engine.setThreadModel(t.id, "gpt-5.4", "high", null, "pair-1");
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.hydraEnabled).toBe(true);

    // Adaptive lock: throws while a head is running under adaptive mode and leaves recents untouched.
    engine.setSubagentMode(t.id, "adaptive");
    store.update((d) => {
      d.threads.push({
        id: "head-busy-1",
        projectId: null,
        title: "Busy head",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        turn: null,
        sessionGrants: [],
        hydraHead: {
          leadId: t.id,
          headIndex: 0,
          name: "worker",
          task: "work",
          batchId: "b1",
          status: "running",
          spawnedAt: Date.now(),
        },
      });
    });
    expect(() => engine.setThreadModel(t.id, "gpt-5.4", "high", null, "pair-2")).toThrow(
      "switch modes when no sub-agents are at work",
    );
    expect(engine.snapshot().settings.lastHydraPairId).toBe("pair-1");
    expect(engine.snapshot().settings.lastNewChatPairId).toBe("pair-1");

    // Flush and reload from disk to prove storeDoc persistence.
    store.close();
    const store2 = new Store(root);
    store2.open();
    expect(store2.state.settings.lastNewChatModel).toEqual({
      provider: "codex",
      modelID: "gpt-5.4",
    });
    expect(store2.state.settings.lastNewChatPairId).toBe("pair-1");
    store2.close();
  });

  it("P1-24 partitionPickerModels keeps an unpinned chosen model visible in ungrouped", () => {
    const opts = new Map([
      ["p1", M("p1", "Pinned 1")],
      ["old", M("old", "Old Model")],
    ]);
    const part = partitionPickerModels(
      [P("p1")],
      [S("s1", "Alpha", 0)],
      [],
      opts,
      "old",
    );
    expect(part.groups[0]!.items.map((i) => i.modelId)).toEqual(["p1"]);
    expect(part.ungrouped.map((e) => e.modelId)).toEqual(["old"]);
    // When the chosen model is already pinned, it is not duplicated in ungrouped.
    const dup = partitionPickerModels([P("p1")], [S("s1", "Alpha", 0)], [], opts, "p1");
    expect(dup.ungrouped).toEqual([]);
  });
});

describe("P1-24 PickerModelsCache and cachedPickerModels", () => {
  const sampleCatalog = () => [
    M("v1", "Fixture 1.0"),
    M("v2", "Fixture 2.0"),
    M("v3", "Fixture 3.0"),
    M("v4", "Fixture 4.0"),
    M("v5", "Fixture 5.0"),
    M("plain", "Fixture Model", true),
  ];

  it("computes the trimmed list once per catalog/settings change and reuses across renders", () => {
    const cache = new PickerModelsCache();
    let computes = 0;
    const onCompute = () => {
      computes++;
    };

    const first = cachedPickerModels(sampleCatalog(), {
      provider: "codex",
      hideOutdatedModels: true,
      protectedIds: new Set(),
      cache,
      onCompute,
    });
    expect(first.map((m) => m.id)).toEqual(["v3", "v4", "v5", "plain"]);
    expect(computes).toBe(1);

    // New array + Set references with identical values must hit the cache.
    for (let i = 0; i < 5; i++) {
      const again = cachedPickerModels(sampleCatalog(), {
        provider: "codex",
        hideOutdatedModels: true,
        protectedIds: new Set(),
        cache,
        onCompute,
      });
      expect(again).toBe(first);
    }
    expect(computes).toBe(1);

    // Toggling hideOutdatedModels off returns full catalog without recomputing;
    // toggling back on hits the cached entry.
    const off = cachedPickerModels(sampleCatalog(), {
      provider: "codex",
      hideOutdatedModels: false,
      protectedIds: new Set(),
      cache,
      onCompute,
    });
    expect(off.map((m) => m.id)).toEqual(["v1", "v2", "v3", "v4", "v5", "plain"]);
    expect(computes).toBe(1);

    const backOn = cachedPickerModels(sampleCatalog(), {
      provider: "codex",
      hideOutdatedModels: true,
      protectedIds: new Set(),
      cache,
      onCompute,
    });
    expect(backOn).toBe(first);
    expect(computes).toBe(1);

    // Changing the chosen protected model recomputes once and protects it.
    const withChosen = cachedPickerModels(sampleCatalog(), {
      provider: "codex",
      hideOutdatedModels: true,
      protectedIds: new Set(["v1"]),
      cache,
      onCompute,
    });
    expect(withChosen.map((m) => m.id)).toEqual(["v1", "v3", "v4", "v5", "plain"]);
    expect(computes).toBe(2);

    // Changing the catalog models recomputes once.
    const extended = [...sampleCatalog(), M("v6", "Fixture 6.0")];
    const nextCat = cachedPickerModels(extended, {
      provider: "codex",
      hideOutdatedModels: true,
      protectedIds: new Set(["v1"]),
      cache,
      onCompute,
    });
    expect(nextCat.map((m) => m.id)).toEqual(["v1", "v4", "v5", "plain", "v6"]);
    expect(computes).toBe(3);
  });

  it("evicts oldest entries past the bounded limit", () => {
    const cache = new PickerModelsCache();
    let computes = 0;
    for (let i = 0; i < PICKER_MODELS_CACHE_LIMIT + 1; i++) {
      cachedPickerModels([M(`m-${i}`, `Vendor ${i}.0`)], {
        provider: "codex",
        hideOutdatedModels: true,
        protectedIds: new Set(),
        cache,
        onCompute: () => {
          computes++;
        },
      });
    }
    expect(cache.size).toBe(PICKER_MODELS_CACHE_LIMIT);
    expect(computes).toBe(PICKER_MODELS_CACHE_LIMIT + 1);

    // Oldest key (m-0) was evicted, so asking for it recomputes; newest (m-48) hits.
    cachedPickerModels([M(`m-${PICKER_MODELS_CACHE_LIMIT}`, `Vendor ${PICKER_MODELS_CACHE_LIMIT}.0`)], {
      provider: "codex",
      hideOutdatedModels: true,
      protectedIds: new Set(),
      cache,
      onCompute: () => {
        computes++;
      },
    });
    expect(computes).toBe(PICKER_MODELS_CACHE_LIMIT + 1);

    cachedPickerModels([M("m-0", "Vendor 0.0")], {
      provider: "codex",
      hideOutdatedModels: true,
      protectedIds: new Set(),
      cache,
      onCompute: () => {
        computes++;
      },
    });
    expect(computes).toBe(PICKER_MODELS_CACHE_LIMIT + 2);
  });
});

describe("P2-33 pure drop planning guards", () => {
  it("a section dropped after its removal produces no write plan", () => {
    const pins = [P("u"), P("a"), P("b")];
    const secs = [S("s1", "One", 1), S("s2", "Two", 2)];
    expect(planModelDropOnRail(pins, secs, "section/s2", "s1", false)).not.toBeNull();
    const withoutDragged = secs.filter((s) => s.id !== "s2");
    expect(planModelDropOnRail(pins, withoutDragged, "section/s2", "s1", false)).toBeNull();
  });

  it("a pin dropped after its removal produces no write plan on pin, wall, or rail", () => {
    const pins = [P("u"), P("a"), P("b")];
    const secs = [S("s1", "One", 1), S("s2", "Two", 2)];
    const stalePins = pins.filter((p) => p.modelID !== "b");
    expect(planModelDropOnPin(stalePins, secs, "codex/b", P("a"), false)).toBeNull();
    expect(planModelDropOnWallGroup(stalePins, secs, "codex/b", "s1", false)).toBeNull();
    expect(planModelDropOnRail(stalePins, secs, "codex/b", null, false)).toBeNull();
  });

  it("live pin and section drags produce the same reorder plans the component writes", () => {
    const pins = [P("u"), P("a"), P("b")];
    const secs = [S("s1", "One", 1), S("s2", "Two", 2)];
    const pinPlan = planModelDropOnRail(pins, secs, "codex/b", null, false);
    expect(pinPlan!.modelList.map((p) => p.modelID)).toEqual(["u", "b", "a"]);
    const sectionPlan = planModelDropOnRail(pins, secs, "section/s2", "s1", false);
    expect(sectionPlan!.modelSections.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("searching drops and mismatched drag kinds are inert", () => {
    const pins = [P("u"), P("a")];
    const secs = [S("s1", "One", 1)];
    expect(planModelDropOnPin(pins, secs, "codex/a", P("u"), true)).toBeNull();
    expect(planModelDropOnWallGroup(pins, secs, "section/s1", null, false)).toBeNull();
    expect(planModelDropOnRail(pins, secs, "section/s1", null, false)).toBeNull();
    expect(planModelDropOnRail(pins, secs, null, "s1", false)).toBeNull();
  });
});
