// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-33 regression: project-script row keys stay stable when a sibling
// is removed or reordered mid-edit (frozen row identity) — the old
// `new-${index}` scheme remounted the wrong draft onto a row.

import { describe, expect, it } from "vitest";
import {
  createScriptDraft,
  makeScriptDraftKeyGen,
  patchScriptDraft,
  removeScriptDraft,
  serializeScriptDrafts,
  toScriptDraft,
} from "../src/renderer/scriptDrafts";

const S = (id: string, name = id) => ({
  id,
  name,
  command: `echo ${id}`,
  icon: "play",
  runOnWorktreeCreate: true,
});

describe("script draft keys (P2-33 row identity)", () => {
  it("saved rows key on their script id; removing a sibling keeps keys", () => {
    const drafts = [S("a"), S("b"), S("c")].map(toScriptDraft);
    const keysBefore = drafts.map((d) => d.key);
    expect(keysBefore).toEqual(["a", "b", "c"]);
    // Remove the first row: the rest keep their keys, not their index.
    const after = drafts.slice(1);
    expect(after.map((d) => d.key)).toEqual(["b", "c"]);
  });

  it("new-row keys are unique and never reuse a removed row's number", () => {
    const keyGen = makeScriptDraftKeyGen();
    const k1 = keyGen();
    const k2 = keyGen();
    const k3 = keyGen();
    // Simulated: row k2 was deleted — a further insert still gets a
    // fresh key, not a recycled `new-2`.
    expect(new Set([k1, k2, k3]).size).toBe(3);
    expect(k3).not.toBe(k2);
    expect([k1, k2, k3]).toEqual(["new-1", "new-2", "new-3"]);
  });

  it("toScriptDraft carries the script fields verbatim", () => {
    const d = toScriptDraft(S("x", "Build"));
    expect(d).toMatchObject({
      key: "x",
      id: "x",
      name: "Build",
      command: "echo x",
      runOnWorktreeCreate: true,
    });
  });

  it("patchScriptDraft and removeScriptDraft keep edits bound by key and serialize drops key", () => {
    const keyGen = makeScriptDraftKeyGen();
    let drafts = [
      toScriptDraft(S("s1", "First")),
      createScriptDraft(keyGen, "New script"),
      createScriptDraft(keyGen, "New script"),
    ];
    drafts = patchScriptDraft(drafts, "new-2", { name: "Third", command: "echo 3" });
    drafts = removeScriptDraft(drafts, "new-1");
    expect(drafts.map((d) => [d.key, d.name, d.command])).toEqual([
      ["s1", "First", "echo s1"],
      ["new-2", "Third", "echo 3"],
    ]);
    expect(serializeScriptDrafts(drafts)).toEqual([
      { id: "s1", name: "First", command: "echo s1", icon: "play", runOnWorktreeCreate: true },
      { name: "Third", command: "echo 3", icon: "play", runOnWorktreeCreate: false },
    ]);
  });
});
