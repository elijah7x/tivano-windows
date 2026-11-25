// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-51 accent catalog: 12 named v3.0.0 accent families + AppearanceMode
// resolution + legacy v2.x theme migration.

import { describe, expect, it } from "vitest";
import {
  THEMES,
  appearanceModeTitle,
  mixHex,
  luminance,
  nextAppearanceMode,
  resolveTheme,
  themeById,
} from "../src/renderer/theme";
import {
  APPEARANCE_MODES,
  THEME_IDS,
  legacyAppearanceOfTheme,
  migrateLegacyTheme,
} from "../src/shared/types";

describe("P2-51 12-accent catalog", () => {
  it("holds all 12 v3.0.0 named accents in AppTheme.allCases order", () => {
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
    expect(THEMES).toHaveLength(12);
    expect(THEMES.map((t) => t.name)).toEqual([
      "System Accent",
      "Avocado",
      "Matcha Green",
      "Emerald Green",
      "Glacier Blue",
      "Sea Blue",
      "Sky Blue",
      "Lavender Purple",
      "Rose Pink",
      "Raspberry Red",
      "Coral Red",
      "Honey Yellow",
    ]);
    expect(themeById("system").accentHexes).toBeNull();
    expect(themeById("breeze").accentHexes).toEqual({ dark: "7BA58F", light: "7BA58F" });
    expect(themeById("github").accentHexes).toEqual({ dark: "4493F8", light: "0969DA" });
    expect(themeById("claude").accentHexes).toEqual({ dark: "CE7E64", light: "B5654A" });
  });

  it("cycles appearance mode system -> light -> dark -> system", () => {
    expect(APPEARANCE_MODES).toEqual(["system", "light", "dark"]);
    expect(nextAppearanceMode("system")).toBe("light");
    expect(nextAppearanceMode("light")).toBe("dark");
    expect(nextAppearanceMode("dark")).toBe("system");
    expect(appearanceModeTitle("system")).toBe("Match System");
    expect(appearanceModeTitle("light")).toBe("Light");
    expect(appearanceModeTitle("dark")).toBe("Dark");
  });

  it("maps retired v2.x theme ids onto the 12 accent families + legacy appearance", () => {
    expect(migrateLegacyTheme("breezeDark")).toBe("breeze");
    expect(legacyAppearanceOfTheme("breezeDark")).toBe("dark");
    expect(migrateLegacyTheme("breezeLight")).toBe("breeze");
    expect(legacyAppearanceOfTheme("breezeLight")).toBe("light");
    expect(migrateLegacyTheme("dark")).toBe("system");
    expect(legacyAppearanceOfTheme("dark")).toBe("dark");
    expect(migrateLegacyTheme("light")).toBe("system");
    expect(legacyAppearanceOfTheme("light")).toBe("light");
    expect(migrateLegacyTheme("tokyoNight")).toBe("nightOwl");
    expect(legacyAppearanceOfTheme("tokyoNight")).toBe("dark");
    expect(migrateLegacyTheme("githubLight")).toBe("github");
    expect(legacyAppearanceOfTheme("githubLight")).toBe("light");
    expect(migrateLegacyTheme("catppuccinMocha")).toBe("catppuccin");
    expect(migrateLegacyTheme("dracula")).toBe("catppuccin");
    expect(migrateLegacyTheme("cursor")).toBe("nord");
    expect(migrateLegacyTheme("neon-party")).toBeNull();
  });
});

describe("resolveTheme", () => {
  it("resolves dark and light hexes per appearanceMode", () => {
    const dark = resolveTheme("github", false, "dark");
    expect(dark.scheme).toBe("dark");
    expect(dark.surface).toBe("#1E1E20");
    expect(dark.accent).toBe("#4493F8");

    const light = resolveTheme("github", true, "light");
    expect(light.scheme).toBe("light");
    expect(light.surface).toBe("#FFFFFF");
    expect(light.accent).toBe("#0969DA");
    expect(luminance(light.surface2.slice(1))).toBeLessThan(luminance(light.surface.slice(1)));
  });

  it("system appearanceMode follows osDark", () => {
    expect(resolveTheme("breeze", true, "system").scheme).toBe("dark");
    expect(resolveTheme("breeze", false, "system").scheme).toBe("light");
    expect(resolveTheme("breeze", false, "system").surface).toBe("#FFFFFF");
    expect(resolveTheme("breeze", true, "system").surface).toBe("#1E1E20");
    expect(resolveTheme("nightOwl", true, "system").accent).toBe("#82AAFF");
    expect(resolveTheme("nightOwl", false, "system").accent).toBe("#4876D6");
  });

  it("system accent falls back to the system-blue default per scheme", () => {
    expect(resolveTheme("system", true, "dark").accent).toBe("#0A84FF");
    expect(resolveTheme("system", true, "light").accent).toBe("#0A6DFF");
  });

  it("picks accent-contrast ink by luminance", () => {
    expect(resolveTheme("matrix", true, "dark").accentContrast).toBe("#10201a");
    expect(resolveTheme("nightOwl", true, "dark").accentContrast).toBe("#ffffff");
  });

  it("derives hue-preserving surface steps", () => {
    const t = resolveTheme("nord", true, "dark");
    expect(t.surface2).toBe(`#${mixHex("1E1E20", "FFFFFF", 0.05)}`);
    expect(t.surface3).toBe(`#${mixHex("1E1E20", "FFFFFF", 0.105)}`);
  });
});

describe("color math", () => {
  it("mixHex folds the second color in by amount", () => {
    expect(mixHex("000000", "FFFFFF", 0)).toBe("000000");
    expect(mixHex("000000", "FFFFFF", 1)).toBe("ffffff");
    expect(mixHex("1E1E20", "FFFFFF", 0.05)).toBe("29292b");
  });

  it("luminance ranks bright accents above dark ones", () => {
    expect(luminance("00E676")).toBeGreaterThan(luminance("0969DA"));
    expect(luminance("FFFFFF")).toBeCloseTo(1);
  });
});
