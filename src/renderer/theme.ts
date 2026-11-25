// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-51: the 12 named v3.0.0 accent families (AppTheme.swift), paired
// with AppearanceMode (system / light / dark). Each custom accent pairs
// a dark-appearance hex with a light-appearance hex (null keeps the
// system accent). The renderer derives the surrounding token ladder from
// the dark/light surface base by hue-preserving RGB mixing.

import type { AppearanceMode, ThemeId } from "../shared/types";

export interface AccentHexes {
  dark: string;
  light: string;
}

export interface ThemeEntry {
  id: ThemeId;
  name: string;
  accentHexes: AccentHexes | null;
}

/** v3.0.0 `AppTheme` catalog verbatim (12 named accent colors, allCases order). */
export const THEMES: ThemeEntry[] = [
  { id: "system", name: "System Accent", accentHexes: null },
  { id: "breeze", name: "Avocado", accentHexes: { dark: "7BA58F", light: "7BA58F" } },
  { id: "everforest", name: "Matcha Green", accentHexes: { dark: "A7C080", light: "8DA101" } },
  { id: "matrix", name: "Emerald Green", accentHexes: { dark: "00E676", light: "00A152" } },
  { id: "nord", name: "Glacier Blue", accentHexes: { dark: "88C0D0", light: "5E81AC" } },
  { id: "github", name: "Sea Blue", accentHexes: { dark: "4493F8", light: "0969DA" } },
  { id: "nightOwl", name: "Sky Blue", accentHexes: { dark: "82AAFF", light: "4876D6" } },
  { id: "catppuccin", name: "Lavender Purple", accentHexes: { dark: "CBA6F7", light: "8839EF" } },
  { id: "rosePine", name: "Rose Pink", accentHexes: { dark: "EB6F92", light: "B4637A" } },
  { id: "monokai", name: "Raspberry Red", accentHexes: { dark: "F92672", light: "D3175F" } },
  { id: "claude", name: "Coral Red", accentHexes: { dark: "CE7E64", light: "B5654A" } },
  { id: "ayu", name: "Honey Yellow", accentHexes: { dark: "E6B450", light: "C98A12" } },
];

export const themeById = (id: ThemeId): ThemeEntry =>
  THEMES.find((t) => t.id === id) ?? THEMES[1]!;

export function nextAppearanceMode(mode: AppearanceMode): AppearanceMode {
  switch (mode) {
    case "system":
      return "light";
    case "light":
      return "dark";
    case "dark":
      return "system";
  }
}

export function appearanceModeTitle(mode: AppearanceMode): string {
  switch (mode) {
    case "system":
      return "Match System";
    case "light":
      return "Light";
    case "dark":
      return "Dark";
  }
}

/* ---- token derivation ---------------------------------------------- */

const hexToRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
};
const toHex = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

/** Hue-preserving RGB mix: `amount` of `mixHex` folded into `baseHex`. */
export function mixHex(baseHex: string, mixHex_: string, amount: number): string {
  const [br, bg, bb] = hexToRgb(baseHex);
  const [mr, mg, mb] = hexToRgb(mixHex_);
  return (
    toHex(br + (mr - br) * amount) +
    toHex(bg + (mg - bg) * amount) +
    toHex(bb + (mb - bb) * amount)
  );
}

/** sRGB relative luminance — picks a readable ink on the accent. */
export function luminance(hex: string): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export interface ResolvedTokens {
  scheme: "light" | "dark";
  accent: string;
  accentContrast: string;
  surface: string;
  surface2: string;
  surface3: string;
  text: string;
  text2: string;
  border: string;
  hover: string;
  success: string;
  warning: string;
  danger: string;
}

/**
 * Resolve the accent family and appearance mode into concrete CSS tokens.
 */
export function resolveTheme(
  id: ThemeId,
  osDark: boolean,
  appearanceMode: AppearanceMode = "system",
): ResolvedTokens {
  const entry = themeById(id);
  const scheme: "light" | "dark" =
    appearanceMode === "light" ? "light" : appearanceMode === "dark" ? "dark" : osDark ? "dark" : "light";
  const dark = scheme === "dark";
  const surface = dark ? "1E1E20" : "FFFFFF";
  const accent = entry.accentHexes
    ? dark
      ? entry.accentHexes.dark
      : entry.accentHexes.light
    : dark
      ? "0A84FF"
      : "0A6DFF";
  return {
    scheme,
    accent: `#${accent}`,
    accentContrast: luminance(accent) > 0.45 ? "#10201a" : "#ffffff",
    surface: `#${surface}`,
    surface2: `#${dark ? mixHex(surface, "FFFFFF", 0.05) : mixHex(surface, "000000", 0.045)}`,
    surface3: `#${dark ? mixHex(surface, "FFFFFF", 0.105) : mixHex(surface, "000000", 0.09)}`,
    text: dark ? "#f2f2f5" : "#1d1d20",
    text2: dark ? "rgba(242, 242, 245, 0.62)" : "rgba(29, 29, 32, 0.6)",
    border: dark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.09)",
    hover: dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.045)",
    success: "#34C759",
    warning: "#FF9F0A",
    danger: "#FF453A",
  };
}

/** Push the resolved tokens onto :root as inline custom properties. */
export function applyTheme(
  root: HTMLElement,
  id: ThemeId,
  osDark: boolean,
  appearanceMode: AppearanceMode = "system",
): ResolvedTokens {
  const t = resolveTheme(id, osDark, appearanceMode);
  root.dataset.theme = id;
  root.dataset.appearance = t.scheme;
  root.style.colorScheme = t.scheme;
  root.style.setProperty("--surface", t.surface);
  root.style.setProperty("--surface-2", t.surface2);
  root.style.setProperty("--surface-3", t.surface3);
  root.style.setProperty("--text", t.text);
  root.style.setProperty("--text-2", t.text2);
  root.style.setProperty("--border", t.border);
  root.style.setProperty("--hover", t.hover);
  root.style.setProperty("--accent", t.accent);
  root.style.setProperty("--accent-contrast", t.accentContrast);
  root.style.setProperty("--success", t.success);
  root.style.setProperty("--warning", t.warning);
  root.style.setProperty("--danger", t.danger);
  return t;
}
