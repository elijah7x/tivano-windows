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
  addPin,
  addSection,
  modelListItems,
  moveModelListItem,
  moveModelSection,
  movePinToSection,
  pinId,
  prefKey,
  removePin,
  removeSection,
  renameSection,
  setModelListItems,
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
});
