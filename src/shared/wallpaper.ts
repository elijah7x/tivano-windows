// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 remainder, bounded slice: the user's own picture behind the
// content + the transparency slider. The frozen build paints it at
// backdropOpacity through a transparent window; this window is opaque,
// so the honest mapping is: the picture renders at that opacity over
// the solid base and softness maps to a CSS blur. Real window
// transparency, clearer glass, and the desktop scrim are out of slice —
// never faked.

/** Persisted wallpaper state — `file` is a basename inside the
 *  library's wallpaper directory, never a path the renderer named. */
export interface WallpaperSetting {
  file: string;
  /** 0 crisp → 1 fully blurred (frozen slider semantics). */
  softness: number;
}

/** The frozen transparency slider value. */
export const DEFAULT_BACKDROP_OPACITY = 0.5;

export const WALLPAPER_ACCEPTED = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
export const WALLPAPER_MAX_BYTES = 25 * 1024 * 1024;
export const WALLPAPER_DIR = "wallpaper";
export const WALLPAPER_FILE_RE = /^wallpaper-[0-9a-f-]{36}\.(png|jpe?g|webp|gif|bmp)$/;

export const isWallpaperName = (name: string): boolean =>
  WALLPAPER_ACCEPTED.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());

export const clampUnit = (v: number): number => Math.min(1, Math.max(0, v));

/** Frozen formula — how much of the picture is painted (rest is the
 *  solid base standing in for a desktop we cannot show through). */
export const wallpaperOpacity = (setting: number | undefined): number =>
  clampUnit(setting ?? DEFAULT_BACKDROP_OPACITY);

/** Softness → blur radius in px. Enough to keep text readable at 1
 *  while leaving the picture recognisable at ~0.3. */
export const wallpaperBlurPx = (softness: number): number =>
  Math.round(clampUnit(softness) * 28);
