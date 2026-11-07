// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 font-size stepping — bounded port of the frozen TypeScale
// (Tivano/UI/Theme/TypeScale.swift). A setting is an absolute point size
// in the category; the OFFSET from the stock size applies additively to
// every size in that category (frozen size(_:) = stock + (value − stock)).
// CSS consumes the offsets as `--fs-<cat>-off` pixel variables.

import type { FontSizeSettings } from "./types";

export type FontSizeCategory = "ui" | "content" | "code";

export type { FontSizeSettings };

export interface ResolvedFontSizes {
  ui: number;
  content: number;
  code: number;
}

/** Frozen stock/default/range — verbatim. */
export const TYPE_STOCK: ResolvedFontSizes = { ui: 13, content: 13, code: 12 };
export const TYPE_DEFAULT: ResolvedFontSizes = { ui: 14, content: 15, code: 13 };
export const TYPE_RANGE: Record<FontSizeCategory, { min: number; max: number }> = {
  ui: { min: 12, max: 18 },
  content: { min: 12, max: 18 },
  code: { min: 11, max: 17 },
};

export function clampFontSize(value: number, category: FontSizeCategory): number {
  const r = TYPE_RANGE[category];
  return Math.min(Math.max(Math.round(value), r.min), r.max);
}

/** Resolve persisted settings to absolute sizes (absent = frozen default). */
export function resolveFontSizes(s: FontSizeSettings | undefined): ResolvedFontSizes {
  return {
    ui: s?.ui !== undefined ? clampFontSize(s.ui, "ui") : TYPE_DEFAULT.ui,
    content:
      s?.content !== undefined ? clampFontSize(s.content, "content") : TYPE_DEFAULT.content,
    code: s?.code !== undefined ? clampFontSize(s.code, "code") : TYPE_DEFAULT.code,
  };
}

/** Pixel offsets relative to stock — what the CSS variables carry. */
export function fontSizeOffsets(s: FontSizeSettings | undefined): ResolvedFontSizes {
  const r = resolveFontSizes(s);
  return { ui: r.ui - TYPE_STOCK.ui, content: r.content - TYPE_STOCK.content, code: r.code - TYPE_STOCK.code };
}

/** Frozen settings.isDefault — every category at its default. */
export function fontSizesAreDefault(s: FontSizeSettings | undefined): boolean {
  const r = resolveFontSizes(s);
  return r.ui === TYPE_DEFAULT.ui && r.content === TYPE_DEFAULT.content && r.code === TYPE_DEFAULT.code;
}
