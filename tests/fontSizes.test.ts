// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F26 font-size stepping (frozen TypeScale port): stocks/ranges/defaults,
// clamp-on-write like the frozen didSet, offset math and merge semantics.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  clampFontSize,
  fontSizeOffsets,
  fontSizesAreDefault,
  resolveFontSizes,
  TYPE_DEFAULT,
} from "../src/shared/typeScale";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function makeEngine(): { store: Store; engine: Engine } {
  const root = mkdtempSync(join(tmpdir(), "tivano-fs-"));
  dirs.push(root);
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}

describe("typeScale (frozen TypeScale port)", () => {
  it("absent settings resolve to the frozen defaults 14/15/13", () => {
    expect(resolveFontSizes(undefined)).toEqual({ ui: 14, content: 15, code: 13 });
    expect(resolveFontSizes({})).toEqual(TYPE_DEFAULT);
  });

  it("offsets are value − stock (13/13/12)", () => {
    expect(fontSizeOffsets(undefined)).toEqual({ ui: 1, content: 2, code: 1 });
    expect(fontSizeOffsets({ ui: 13, content: 13, code: 12 })).toEqual({
      ui: 0,
      content: 0,
      code: 0,
    });
    expect(fontSizeOffsets({ ui: 18, content: 12, code: 17 })).toEqual({
      ui: 5,
      content: -1,
      code: 5,
    });
  });

  it("clamps to the frozen ranges like the frozen didSet", () => {
    expect(clampFontSize(99, "ui")).toBe(18);
    expect(clampFontSize(1, "ui")).toBe(12);
    expect(clampFontSize(99, "content")).toBe(18);
    expect(clampFontSize(1, "content")).toBe(12);
    expect(clampFontSize(99, "code")).toBe(17);
    expect(clampFontSize(1, "code")).toBe(11);
  });

  it("isDefault only at the frozen defaults", () => {
    expect(fontSizesAreDefault(undefined)).toBe(true);
    expect(fontSizesAreDefault({ ui: 14, content: 15, code: 13 })).toBe(true);
    expect(fontSizesAreDefault({ ui: 15 })).toBe(false);
  });
});

describe("engine font-size settings (F26)", () => {
  it("setSettings merges per-category and clamps on write", () => {
    const { engine } = makeEngine();
    engine.setSettings({ fontSizes: { ui: 99 } });
    let s = engine.snapshot().settings.fontSizes;
    expect(s).toEqual({ ui: 18 });
    engine.setSettings({ fontSizes: { content: 12, code: 1 } });
    s = engine.snapshot().settings.fontSizes;
    expect(s).toEqual({ ui: 18, content: 12, code: 11 });
  });

  it("reset writes the frozen defaults explicitly; an empty patch is a no-op", () => {
    const { engine } = makeEngine();
    engine.setSettings({ fontSizes: { ui: 16 } });
    expect(engine.snapshot().settings.fontSizes).toEqual({ ui: 16 });
    engine.setSettings({ fontSizes: {} });
    expect(engine.snapshot().settings.fontSizes).toEqual({ ui: 16 });
    engine.setSettings({ fontSizes: { ui: 14, content: 15, code: 13 } });
    expect(engine.snapshot().settings.fontSizes).toEqual({ ui: 14, content: 15, code: 13 });
    expect(fontSizesAreDefault(engine.snapshot().settings.fontSizes)).toBe(true);
  });

  it("fontSizes persist through a store reopen", () => {
    const { store, engine } = makeEngine();
    engine.setSettings({ fontSizes: { ui: 16, content: 14, code: 15 } });
    store.close();
    const store2 = new Store(store.root);
    store2.open();
    expect(store2.state.settings.fontSizes).toEqual({ ui: 16, content: 14, code: 15 });
    store2.close();
  });
});
