// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 slash suggestions — frozen SlashCommand.suggestions ordering and
// the start==0 activation rule, plus engine recordCommand recency.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  builtinSlashCommands,
  slashQueryAt,
  slashSuggestions,
  type SlashCommand,
} from "../src/shared/slashCommands";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-slash-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const cmd = (name: string, isBuiltIn = false): SlashCommand => ({
  name,
  detail: `${name} detail`,
  isBuiltIn,
});
const names = (items: SlashCommand[]): string[] => items.map((c) => c.name);

describe("frozen slashSuggestions ordering", () => {
  const all = [cmd("plan", true), cmd("compact", true), cmd("review"), cmd("status")];

  it("lists everything on an empty query, alphabetical without recency", () => {
    expect(names(slashSuggestions(all, "", []))).toEqual([
      "compact",
      "plan",
      "review",
      "status",
    ]);
  });

  it("contains-filters case-insensitively; prefix beats contains", () => {
    expect(names(slashSuggestions(all, "PL", []))).toEqual(["plan"]);
    // "plan" is a prefix match, "compact" only contains the needle.
    expect(names(slashSuggestions(all, "p", []))).toEqual(["plan", "compact"]);
  });

  it("prefix matches lead contains matches, alphabetical inside a tier", () => {
    const cmds = [cmd("xport"), cmd("port"), cmd("export")];
    expect(names(slashSuggestions(cmds, "po", []))).toEqual(["port", "export", "xport"]);
  });

  it("recency orders inside a rank, never beats a prefix advantage", () => {
    expect(names(slashSuggestions(all, "", ["status", "compact"]))).toEqual([
      "status",
      "compact",
      "plan",
      "review",
    ]);
    // "status" is filtered out by the needle entirely.
    expect(names(slashSuggestions(all, "p", ["status"]))).toEqual(["plan", "compact"]);
    // Inside the non-prefix tier the recent entry leads.
    const cmds = [cmd("xto"), cmd("ato"), cmd("top")];
    expect(names(slashSuggestions(cmds, "t", []))).toEqual(["top", "ato", "xto"]);
    expect(names(slashSuggestions(cmds, "t", ["xto"]))).toEqual(["top", "xto", "ato"]);
  });

  it("dedupes repeated names", () => {
    expect(names(slashSuggestions([cmd("plan"), cmd("plan")], "", []))).toEqual(["plan"]);
  });

  it("builtins: plan always, compact only when supported", () => {
    expect(names(builtinSlashCommands(false))).toEqual(["plan"]);
    expect(names(builtinSlashCommands(true))).toEqual(["plan", "compact"]);
  });
});

describe("frozen slashQueryAt activation (start == 0, word under caret)", () => {
  it("activates inside a leading slash word", () => {
    expect(slashQueryAt("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(slashQueryAt("/pl", 1)).toEqual({ query: "pl", start: 0, end: 3 });
    expect(slashQueryAt("/plan", 5)).toEqual({ query: "plan", start: 0, end: 5 });
  });

  it("stays active with text after the word while the caret is inside", () => {
    expect(slashQueryAt("/plan more", 2)).toEqual({ query: "plan", start: 0, end: 5 });
  });

  it("is inactive when the caret leaves the word or the word is not first", () => {
    expect(slashQueryAt("/plan more", 7)).toBeNull();
    expect(slashQueryAt("hi /plan", 6)).toBeNull();
    expect(slashQueryAt("plan", 2)).toBeNull();
    expect(slashQueryAt("", 0)).toBeNull();
  });
});

describe("engine recordCommand — frozen recency", () => {
  function make(root = tmp()) {
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    return { store, engine };
  }

  it("prepends, dedupes and persists under the provider mode key", async () => {
    const root = tmp();
    const { engine, store } = make(root);
    engine.recordCommand("plan");
    engine.recordCommand("compact");
    engine.recordCommand("plan");
    expect(engine.snapshot().recentCommands).toEqual({ mock: ["plan", "compact"] });
    store.flushNow();
    store.close();

    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    expect(engine2.snapshot().recentCommands).toEqual({ mock: ["plan", "compact"] });
    store2.close();
  });

  it("rejects non-command names and survives a 100-entry cap", () => {
    const { engine, store } = make();
    expect(() => engine.recordCommand("Plan Mode")).toThrow();
    expect(() => engine.recordCommand("../x")).toThrow();
    for (let i = 0; i < 130; i++) engine.recordCommand(`cmd-${String(i).padStart(3, "0")}`);
    expect(engine.snapshot().recentCommands?.mock).toHaveLength(100);
    store.close();
  });
});
