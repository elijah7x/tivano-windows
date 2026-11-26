// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

export type HelperPopCorner = "tl" | "tr" | "bl" | "br";

export type HelperPopPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  corner: HelperPopCorner;
  cascadeIndex: number;
  mode: "wide" | "narrow";
};

export type HelperPopLayoutInput = {
  paneWidth: number;
  paneHeight: number;
  /** Height of the chat chrome above the timeline. */
  chromeTop?: number | undefined;
  /** Height of the composer area below the timeline. */
  composerBottom?: number | undefined;
  /** Running heads in the team; the first keeps the team panel. */
  runningHeads: number;
  preferredSize?: { width: number; height: number } | undefined;
};

export const HELPER_PANEL_WIDTH = 400;
export const HELPER_PANEL_MIN_WIDTH = 300;
export const HELPER_PANEL_MIN_HEIGHT = 220;
export const HELPER_PANEL_GAP = 12;
export const HELPER_PANEL_SIDE_MARGIN = 20;
export const HELPER_PANEL_INSET = 8;
/** Vertical offset that keeps a covered panel's title strip and close
 *  button outside the next panel in a narrow cascade.
 *  Matches the measured 52px helper-head strip with slack. */
export const HELPER_POP_TITLE_STEP = 56;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), Math.max(lo, hi));

/** The one panel-sizing rule shared by the floating helper and the
 *  automatic-pop layout (frozen SubagentPanelLayout.panelSize). */
export function helperPanelSizeForPane(
  paneWidth: number,
  paneHeight: number,
  preferredSize?: { width: number; height: number } | undefined,
): { width: number; height: number } {
  const width = Math.min(
    Math.max(preferredSize?.width ?? HELPER_PANEL_WIDTH, HELPER_PANEL_MIN_WIDTH),
    Math.max(HELPER_PANEL_MIN_WIDTH, paneWidth - 2 * HELPER_PANEL_SIDE_MARGIN),
  );
  const idealH =
    preferredSize?.height ?? Math.min(520, Math.max(300, paneHeight * 0.5));
  const height = Math.min(
    Math.max(idealH, HELPER_PANEL_MIN_HEIGHT),
    Math.max(HELPER_PANEL_MIN_HEIGHT, paneHeight - 2 * HELPER_PANEL_INSET),
  );
  return { width, height };
}

/** Pure automatic-pop placement. Coordinates are relative to the whole
 *  chat pane, with the header and composer heights excluded up front.
 *  Wide panes use both side columns and divide vertical room instead of
 *  letting top and bottom panels collide; narrow panes use one cascade
 *  whose title-strip step keeps every panel's close button reachable.
 *  This bounded safe-area/cascade rule intentionally replaces the frozen
 *  kept-corner/natural-capacity fill order rather than reproducing it. */
export function helperPopLayout(input: HelperPopLayoutInput): {
  placements: HelperPopPlacement[];
  mode: "wide" | "narrow";
  safe: { x: number; y: number; width: number; height: number };
} {
  const chromeTop = Math.max(0, input.chromeTop ?? 0);
  const composerBottom = Math.max(0, input.composerBottom ?? 0);
  const paneWidth = Math.max(0, input.paneWidth);
  const paneHeight = Math.max(0, input.paneHeight);
  const safe = {
    x: 0,
    y: chromeTop,
    width: paneWidth,
    height: Math.max(0, paneHeight - chromeTop - composerBottom),
  };
  const popCount = Math.max(0, Math.floor(input.runningHeads) - 1);
  const base = helperPanelSizeForPane(safe.width, safe.height, input.preferredSize);
  const wide =
    safe.width >=
    base.width * 2 + 2 * HELPER_PANEL_SIDE_MARGIN + HELPER_PANEL_GAP;
  const placements: HelperPopPlacement[] = [];
  if (popCount === 0 || safe.width <= 0 || safe.height <= 0) {
    return { placements, mode: wide ? "wide" : "narrow", safe };
  }

  if (wide) {
    const rows = Math.max(1, Math.ceil(Math.min(popCount, 4) / 2));
    const sharedHeight =
      (safe.height - 2 * HELPER_PANEL_INSET - (rows - 1) * HELPER_PANEL_GAP) / rows;
    const height = Math.max(
      HELPER_PANEL_MIN_HEIGHT,
      Math.min(base.height, sharedHeight),
    );
    const corners: HelperPopCorner[] = ["tr", "tl", "br", "bl"];
    for (let i = 0; i < popCount; i += 1) {
      const corner = corners[i % corners.length]!;
      const round = Math.floor(i / corners.length);
      const left = corner === "tl" || corner === "bl";
      const top = corner === "tl" || corner === "tr";
      const x =
        (left
          ? HELPER_PANEL_SIDE_MARGIN
          : safe.width - HELPER_PANEL_SIDE_MARGIN - base.width) +
        (round === 0 ? 0 : left ? round * HELPER_POP_TITLE_STEP : -round * HELPER_POP_TITLE_STEP);
      const y =
        (top
          ? HELPER_PANEL_INSET
          : safe.height - HELPER_PANEL_INSET - height) +
        (round === 0 ? 0 : top ? round * HELPER_POP_TITLE_STEP : -round * HELPER_POP_TITLE_STEP);
      placements.push({
        x: safe.x + clamp(x, HELPER_PANEL_INSET, safe.width - base.width - HELPER_PANEL_INSET),
        y: safe.y + clamp(y, HELPER_PANEL_INSET, safe.height - height - HELPER_PANEL_INSET),
        width: base.width,
        height,
        corner,
        cascadeIndex: round,
        mode: "wide",
      });
    }
    return { placements, mode: "wide", safe };
  }

  const usableHeight = Math.max(0, safe.height - 2 * HELPER_PANEL_INSET);
  const cascadeFitHeight =
    usableHeight - (popCount - 1) * HELPER_POP_TITLE_STEP;
  const maxHeight = Math.max(HELPER_PANEL_MIN_HEIGHT, usableHeight);
  const height = clamp(
    Math.min(base.height, cascadeFitHeight),
    Math.min(HELPER_PANEL_MIN_HEIGHT, maxHeight),
    maxHeight,
  );
  const spareY = Math.max(0, usableHeight - height);
  const stepY = popCount > 1 ? Math.min(HELPER_POP_TITLE_STEP, spareY / (popCount - 1)) : 0;
  const xMax = safe.width - HELPER_PANEL_SIDE_MARGIN - base.width;
  const xMin = HELPER_PANEL_SIDE_MARGIN;
  const spareX = Math.max(0, xMax - xMin);
  const stepX = popCount > 1 ? Math.min(28, spareX / (popCount - 1)) : 0;
  for (let i = 0; i < popCount; i += 1) {
    placements.push({
      x: safe.x + clamp(xMax - stepX * i, xMin, xMax),
      y: safe.y + clamp(HELPER_PANEL_INSET + stepY * i, HELPER_PANEL_INSET, safe.height - height - HELPER_PANEL_INSET),
      width: base.width,
      height,
      corner: "tr",
      cascadeIndex: i,
      mode: "narrow",
    });
  }
  return { placements, mode: "narrow", safe };
}
