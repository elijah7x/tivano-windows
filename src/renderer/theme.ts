// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26: the full frozen AppTheme catalog (AppTheme.swift palettes verbatim).
// A theme paints an optional fixed color scheme, an optional accent (null
// keeps the system look), the glass-tint surface, and the status hues.
// The renderer derives the surrounding token ladder from that one surface
// by hue-preserving RGB mixing — the frozen glass layering has no DOM
// equivalent, so -2/-3 surface steps, text, borders and hover alphas keep
// the app's existing values per resolved scheme.

import type { ThemeId } from "../shared/types";

export interface ThemePalette {
  scheme: "light" | "dark" | null; // null = follows the OS
  accent: string | null;
  surface: string;
  success: string | null;
  warning: string | null;
  danger: string | null;
}

export interface ThemeEntry {
  id: ThemeId;
  name: string;
  /** Frozen `detail` picker subtitle — intentionally not localized upstream. */
  detail: string;
  palette: ThemePalette;
}

/** Frozen `AppTheme.palette` verbatim (allCases order). */
export const THEMES: ThemeEntry[] = [
  { id: "breeze", name: "Breeze", detail: "Follows your Mac · Avocado",
    palette: { scheme: null, accent: "7BA58F", surface: "1E1E20", success: null, warning: null, danger: null } },
  { id: "breezeLight", name: "Breeze Light", detail: "Light · Avocado",
    palette: { scheme: "light", accent: "7BA58F", surface: "FFFFFF", success: null, warning: null, danger: null } },
  { id: "breezeDark", name: "Breeze Dark", detail: "Dark · Avocado",
    palette: { scheme: "dark", accent: "7BA58F", surface: "1E1E20", success: null, warning: null, danger: null } },
  { id: "system", name: "System", detail: "Follows your Mac",
    palette: { scheme: null, accent: null, surface: "1E1E20", success: null, warning: null, danger: null } },
  { id: "light", name: "Light", detail: "Light · System accent",
    palette: { scheme: "light", accent: null, surface: "FFFFFF", success: null, warning: null, danger: null } },
  { id: "dark", name: "Dark", detail: "Dark · System accent",
    palette: { scheme: "dark", accent: null, surface: "1E1E20", success: null, warning: null, danger: null } },
  { id: "catppuccinMocha", name: "Catppuccin Mocha", detail: "Dark · Mauve",
    palette: { scheme: "dark", accent: "CBA6F7", surface: "1E1E2E", success: "A6E3A1", warning: "F9E2AF", danger: "F38BA8" } },
  { id: "catppuccinLatte", name: "Catppuccin Latte", detail: "Light · Mauve",
    palette: { scheme: "light", accent: "8839EF", surface: "EFF1F5", success: "40A02B", warning: "DF8E1D", danger: "D20F39" } },
  { id: "dracula", name: "Dracula", detail: "Dark · Purple",
    palette: { scheme: "dark", accent: "BD93F9", surface: "282A36", success: "50FA7B", warning: "FFB86C", danger: "FF5555" } },
  { id: "tokyoNight", name: "Tokyo Night", detail: "Dark · Blue",
    palette: { scheme: "dark", accent: "7AA2F7", surface: "1A1B26", success: "9ECE6A", warning: "E0AF68", danger: "F7768E" } },
  { id: "nord", name: "Nord", detail: "Dark · Frost",
    palette: { scheme: "dark", accent: "88C0D0", surface: "2E3440", success: "A3BE8C", warning: "EBCB8B", danger: "BF616A" } },
  { id: "gruvbox", name: "Gruvbox", detail: "Dark · Orange",
    palette: { scheme: "dark", accent: "FE8019", surface: "282828", success: "B8BB26", warning: "FABD2E", danger: "FB4934" } },
  { id: "gruvboxLight", name: "Gruvbox Light", detail: "Light · Rust",
    palette: { scheme: "light", accent: "AF3A03", surface: "FBF1C7", success: "79740E", warning: "B57614", danger: "9D0006" } },
  { id: "oneDark", name: "One Dark", detail: "Dark · Blue",
    palette: { scheme: "dark", accent: "61AFEF", surface: "282C34", success: "98C379", warning: "E5C07B", danger: "E06C75" } },
  { id: "everforest", name: "Everforest", detail: "Dark · Green",
    palette: { scheme: "dark", accent: "A7C080", surface: "2D353B", success: "A7C080", warning: "DBBC7F", danger: "E67E80" } },
  { id: "kanagawa", name: "Kanagawa", detail: "Dark · Wave blue",
    palette: { scheme: "dark", accent: "7E9CD8", surface: "1F1F28", success: "98BB6C", warning: "D7A657", danger: "E82424" } },
  { id: "rosePine", name: "Rosé Pine", detail: "Dark · Rose",
    palette: { scheme: "dark", accent: "EB6F92", surface: "191724", success: "9CCFD8", warning: "F6C177", danger: "EB6F92" } },
  { id: "solarizedDark", name: "Solarized Dark", detail: "Dark · Blue",
    palette: { scheme: "dark", accent: "268BD2", surface: "002B36", success: "859900", warning: "B58900", danger: "DC322F" } },
  { id: "solarizedLight", name: "Solarized Light", detail: "Light · Blue",
    palette: { scheme: "light", accent: "268BD2", surface: "FDF6E3", success: "859900", warning: "B58900", danger: "DC322F" } },
  { id: "githubDark", name: "GitHub Dark", detail: "Dark · Blue",
    palette: { scheme: "dark", accent: "4493F8", surface: "0D1117", success: "3FB950", warning: "D29922", danger: "F85149" } },
  { id: "githubLight", name: "GitHub Light", detail: "Light · Blue",
    palette: { scheme: "light", accent: "0969DA", surface: "FFFFFF", success: "1A7F37", warning: "9A6700", danger: "CF222E" } },
  { id: "ayu", name: "Ayu", detail: "Dark · Amber",
    palette: { scheme: "dark", accent: "E6B450", surface: "0F1419", success: "AAD94C", warning: "FFB454", danger: "F58572" } },
  { id: "nightOwl", name: "Night Owl", detail: "Dark · Blue",
    palette: { scheme: "dark", accent: "82AAFF", surface: "011627", success: "C5E478", warning: "ECC48D", danger: "EF5350" } },
  { id: "monokai", name: "Monokai", detail: "Dark · Pink",
    palette: { scheme: "dark", accent: "F92672", surface: "272822", success: "A6E22E", warning: "FD971F", danger: "F92672" } },
  { id: "claude", name: "Claude", detail: "Dark · Terracotta",
    palette: { scheme: "dark", accent: "C15F3C", surface: "1A1816", success: "51A556", warning: "C9A227", danger: "D97757" } },
  { id: "claudeLight", name: "Claude Light", detail: "Light · Terracotta",
    palette: { scheme: "light", accent: "C15F3C", surface: "FAF9F5", success: "2E7D32", warning: "9A6700", danger: "B3261E" } },
  { id: "codex", name: "Codex", detail: "Dark · Magenta",
    palette: { scheme: "dark", accent: "D946EF", surface: "101014", success: "3FB950", warning: "D29922", danger: "F85149" } },
  { id: "cursor", name: "Cursor", detail: "Dark · Frost",
    palette: { scheme: "dark", accent: "88C0D0", surface: "181818", success: "3FA266", warning: "F1B467", danger: "E34671" } },
  { id: "matrix", name: "Matrix", detail: "Dark · Green",
    palette: { scheme: "dark", accent: "00E676", surface: "000000", success: "00E676", warning: "FFD600", danger: "FF5252" } },
];

export const themeById = (id: ThemeId): ThemeEntry =>
  THEMES.find((t) => t.id === id) ?? THEMES[0]!;

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
 * Resolve the palette into concrete CSS tokens. The ladder steps and text
 * colors are the app's existing per-scheme values; only the surface base,
 * accent and status hues come from the frozen palette.
 */
export function resolveTheme(id: ThemeId, osDark: boolean): ResolvedTokens {
  const p = themeById(id).palette;
  const scheme = p.scheme ?? (osDark ? "dark" : "light");
  // Follow-the-OS palettes carry the dark surface; flip to white on light.
  const surface = p.scheme == null && !osDark ? "FFFFFF" : p.surface;
  const dark = scheme === "dark";
  const accent = p.accent ?? (dark ? "0A84FF" : "0A6DFF");
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
    success: `#${p.success ?? "34C759"}`,
    warning: `#${p.warning ?? "FF9F0A"}`,
    danger: `#${p.danger ?? "FF453A"}`,
  };
}

/** Push the resolved tokens onto :root as inline custom properties. */
export function applyTheme(root: HTMLElement, id: ThemeId, osDark: boolean): ResolvedTokens {
  const t = resolveTheme(id, osDark);
  root.dataset.theme = id;
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
