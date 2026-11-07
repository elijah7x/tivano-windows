// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 theme catalog: frozen AppTheme palettes verbatim + the derived
// token ladder (hue-preserving mix, luminance-picked accent ink,
// follow-OS resolution for Breeze/System).

import { describe, expect, it } from "vitest";
import { THEMES, themeById, resolveTheme, mixHex, luminance } from "../src/renderer/theme";
import { THEME_IDS } from "../src/shared/types";

describe("frozen catalog", () => {
  it("holds all 29 frozen themes in allCases order with verbatim palettes", () => {
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
    expect(THEMES).toHaveLength(29);
    const spot = (id: string, surface: string, accent: string | null, scheme: string | null) => {
      const p = themeById(id as (typeof THEME_IDS)[number]).palette;
      expect(p.surface, id).toBe(surface);
      expect(p.accent, id).toBe(accent);
      expect(p.scheme, id).toBe(scheme);
    };
    spot("breeze", "1E1E20", "7BA58F", null);
    spot("system", "1E1E20", null, null);
    spot("tokyoNight", "1A1B26", "7AA2F7", "dark");
    spot("githubLight", "FFFFFF", "0969DA", "light");
    spot("matrix", "000000", "00E676", "dark");
    spot("rosePine", "191724", "EB6F92", "dark");
  });

  it("keeps frozen status hues where the palette defines them", () => {
    expect(themeById("dracula").palette).toMatchObject({
      success: "50FA7B", warning: "FFB86C", danger: "FF5555",
    });
    // Undefined hues fall back to the system set, not invented per-theme.
    expect(themeById("claude").palette.success).toBe("51A556");
    expect(themeById("breeze").palette.success).toBeNull();
  });
});

describe("resolveTheme", () => {
  it("dark theme resolves verbatim surface + accent", () => {
    const t = resolveTheme("tokyoNight", false);
    expect(t.scheme).toBe("dark");
    expect(t.surface).toBe("#1A1B26");
    expect(t.accent).toBe("#7AA2F7");
    expect(t.success).toBe("#9ECE6A");
  });

  it("light theme resolves and darkens the ladder toward black", () => {
    const t = resolveTheme("githubLight", true);
    expect(t.scheme).toBe("light");
    expect(t.surface).toBe("#FFFFFF");
    expect(luminance(t.surface2.slice(1))).toBeLessThan(luminance(t.surface.slice(1)));
    expect(t.accent).toBe("#0969DA");
    expect(t.text).toBe("#1d1d20");
  });

  it("null-scheme themes follow the OS flag", () => {
    expect(resolveTheme("breeze", true).scheme).toBe("dark");
    expect(resolveTheme("breeze", false).scheme).toBe("light");
    expect(resolveTheme("breeze", false).surface).toBe("#FFFFFF");
    expect(resolveTheme("breeze", true).surface).toBe("#1E1E20");
    expect(resolveTheme("system", false).surface).toBe("#FFFFFF");
  });

  it("null accent falls back to the system-blue default per scheme", () => {
    expect(resolveTheme("system", true).accent).toBe("#0A84FF");
    expect(resolveTheme("light", true).accent).toBe("#0A6DFF");
  });

  it("picks accent-contrast ink by luminance", () => {
    // matrix green on black → dark ink; tokyoNight blue → white ink.
    expect(resolveTheme("matrix", true).accentContrast).toBe("#10201a");
    expect(resolveTheme("tokyoNight", true).accentContrast).toBe("#ffffff");
  });

  it("derives hue-preserving surface steps", () => {
    const t = resolveTheme("tokyoNight", true);
    // Tokyo Night's tint must survive in the steps, not collapse to grey.
    expect(t.surface2).toBe(`#${mixHex("1A1B26", "FFFFFF", 0.05)}`);
    expect(t.surface3).toBe(`#${mixHex("1A1B26", "FFFFFF", 0.105)}`);
  });
});

describe("color math", () => {
  it("mixHex folds the second color in by amount", () => {
    expect(mixHex("000000", "FFFFFF", 0)).toBe("000000");
    expect(mixHex("000000", "FFFFFF", 1)).toBe("ffffff");
    expect(mixHex("1E1E20", "FFFFFF", 0.05)).toBe("29292b"); // close to the static breeze ladder
  });

  it("luminance ranks bright accents above dark ones", () => {
    expect(luminance("00E676")).toBeGreaterThan(luminance("268BD2"));
    expect(luminance("FFFFFF")).toBeCloseTo(1);
  });
});
