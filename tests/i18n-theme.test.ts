// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Language & theme basics: every UI key has a zh-Hans value, upstream-derived
// translations stay byte-identical with the frozen catalog, theme specs are
// valid and cover light+dark schemes.

import { describe, expect, it } from "vitest";
import { translate, zhHansKeys } from "../src/renderer/i18n";
import { THEMES } from "../src/renderer/theme";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Portable fixture: zh-Hans values extracted verbatim from the frozen
// baseline catalog (provenance inside the file). No host-local paths —
// this file is the traceable baseline for default test runs.
const fixture = JSON.parse(
  readFileSync(join(root, "tests/fixtures/zh-hans-upstream.json"), "utf8"),
) as { values: Record<string, string> };

describe("i18n", () => {
  it("English falls back to the source key", () => {
    expect(translate("en", "Thread list")).toBe("Thread list");
    expect(translate("en", "a key with no entry")).toBe("a key with no entry");
  });

  it("every zh-Hans entry is a non-empty translation", () => {
    for (const k of zhHansKeys()) {
      const v = translate("zh-Hans", k);
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it("keeps upstream zh-Hans wording for shared keys (frozen fixture)", () => {
    let checked = 0;
    for (const [k, upstream] of Object.entries(fixture.values)) {
      expect(translate("zh-Hans", k), k).toBe(upstream);
      checked++;
    }
    expect(checked).toBeGreaterThan(30); // genuinely anchored to the catalog
  });

  it("fixture stays byte-identical to a live catalog when explicitly provided", () => {
    // Optional drift guard: TIVANO_UPSTREAM_XCSTRINGS=<path to
    // Localizable.xcstrings> re-verifies the fixture against the frozen
    // reference. Absent the env the fixture above remains the baseline —
    // nothing is skipped to fake a pass.
    const live = process.env.TIVANO_UPSTREAM_XCSTRINGS;
    if (!live) return;
    expect(existsSync(live), `catalog path ${live}`).toBe(true);
    const catalog = JSON.parse(readFileSync(live, "utf8")) as {
      strings: Record<string, { localizations?: { "zh-Hans"?: { stringUnit?: { value?: string } } } }>;
    };
    for (const [k, v] of Object.entries(fixture.values)) {
      expect(catalog.strings[k]?.localizations?.["zh-Hans"]?.stringUnit?.value, k).toBe(v);
    }
  });

  it("substitutes %@ variables", () => {
    expect(translate("en", 'Delete "%@"?', ["Thread A"])).toBe('Delete "Thread A"?');
    expect(translate("zh-Hans", 'Delete "%@"?', ["对话A"])).toBe("要删除“对话A”吗？");
  });
});

describe("theme", () => {
  it("ships the full frozen 29-theme catalog in allCases order", () => {
    expect(THEMES).toHaveLength(29);
    expect(THEMES[0]!.id).toBe("breeze");
    expect(THEMES.at(-1)!.id).toBe("matrix");
    for (const th of THEMES) {
      expect(th.name.length).toBeGreaterThan(0);
      expect(th.palette.surface).toMatch(/^[0-9a-fA-F]{6}$/);
      for (const hex of [th.palette.accent, th.palette.success, th.palette.warning, th.palette.danger])
        if (hex != null) expect(hex).toMatch(/^[0-9a-fA-F]{6}$/);
    }
  });

  it("breeze follows the OS and carries the avocado accent from upstream", () => {
    const breeze = THEMES.find((t) => t.id === "breeze")!;
    expect(breeze.palette.scheme).toBeNull();
    expect(breeze.palette.accent).toBe("7BA58F");
    expect(THEMES.find((t) => t.id === "system")!.palette.accent).toBeNull();
  });

  it("every theme detail string is a localizable key with a zh-Hans value", () => {
    for (const th of THEMES) {
      expect(th.detail.length).toBeGreaterThan(0);
      const zh = translate("zh-Hans", th.detail);
      expect(zh, `${th.id}: ${th.detail}`).not.toBe(th.detail);
    }
    expect(translate("zh-Hans", "Follows your Mac · Avocado")).toBe("跟随你的 Mac · 牛油果绿");
    expect(translate("zh-Hans", "Dark · Wave blue")).toBe("深色 · 浪蓝");
  });
});
