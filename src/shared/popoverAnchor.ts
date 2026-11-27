// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shared popover anchoring and viewport clamping helper. Keeps transient
// popovers adjacent to their owning row/trigger while clamping within
// the viewport across scroll, resize and edge rows.

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ViewportBounds {
  width: number;
  height: number;
}

export type PopoverSide = "trailing" | "leading" | "bottom" | "top";

export interface AnchorPopoverOptions {
  anchor: AnchorRect;
  popover: PopoverSize;
  viewport: ViewportBounds;
  /** Preferred side relative to the anchor rect (default: "trailing"). */
  preferredSide?: PopoverSide | undefined;
  /** Gap in px between anchor edge and popover edge (default: 8). */
  gap?: number | undefined;
  /** Minimum inset from viewport edges in px (default: 8). */
  margin?: number | undefined;
}

export interface AnchoredPopoverPosition {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  side: PopoverSide;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function rectToAnchor(
  rect: Pick<AnchorRect, "left" | "right" | "top" | "bottom" | "width" | "height">,
): AnchorRect {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function sameAnchorRect(a: AnchorRect, b: AnchorRect): boolean {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.right - b.right) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.bottom - b.bottom) < 0.5
  );
}

export function isAnchorVisibleInContainer(
  anchor: Pick<AnchorRect, "top" | "bottom" | "left" | "right">,
  container: Pick<AnchorRect, "top" | "bottom" | "left" | "right">,
): boolean {
  return (
    anchor.bottom > container.top &&
    anchor.top < container.bottom &&
    anchor.right > container.left &&
    anchor.left < container.right
  );
}

export function anchorPopover(opts: AnchorPopoverOptions): AnchoredPopoverPosition {
  const margin = Math.max(0, opts.margin ?? 8);
  const gap = Math.max(0, opts.gap ?? 8);
  const preferredSide = opts.preferredSide ?? "trailing";
  const maxWidth = Math.max(0, opts.viewport.width - 2 * margin);
  const maxHeight = Math.max(0, opts.viewport.height - 2 * margin);
  const effectiveW = Math.min(Math.max(0, Math.ceil(opts.popover.width)), maxWidth);
  const effectiveH = Math.min(Math.max(0, Math.ceil(opts.popover.height)), maxHeight);
  const maxLeft = Math.max(margin, Math.floor(opts.viewport.width - effectiveW - margin));
  const maxTop = Math.max(margin, Math.floor(opts.viewport.height - effectiveH - margin));

  if (preferredSide === "trailing" || preferredSide === "leading") {
    const trailingLeft = opts.anchor.right + gap;
    const leadingLeft = opts.anchor.left - gap - effectiveW;
    const trailingFits = trailingLeft + effectiveW <= opts.viewport.width - margin;
    const leadingFits = leadingLeft >= margin;

    let side: PopoverSide = preferredSide;
    let rawLeft = preferredSide === "trailing" ? trailingLeft : leadingLeft;
    if (preferredSide === "trailing" && !trailingFits && leadingFits) {
      side = "leading";
      rawLeft = leadingLeft;
    } else if (preferredSide === "leading" && !leadingFits && trailingFits) {
      side = "trailing";
      rawLeft = trailingLeft;
    }

    return {
      left: Math.round(clamp(rawLeft, margin, maxLeft)),
      top: Math.round(clamp(opts.anchor.top, margin, maxTop)),
      maxWidth,
      maxHeight,
      side,
    };
  }

  const bottomTop = opts.anchor.bottom + gap;
  const topTop = opts.anchor.top - gap - effectiveH;
  const bottomFits = bottomTop + effectiveH <= opts.viewport.height - margin;
  const topFits = topTop >= margin;

  let side: PopoverSide = preferredSide;
  let rawTop = preferredSide === "bottom" ? bottomTop : topTop;
  if (preferredSide === "bottom" && !bottomFits && topFits) {
    side = "top";
    rawTop = topTop;
  } else if (preferredSide === "top" && !topFits && bottomFits) {
    side = "bottom";
    rawTop = bottomTop;
  }

  return {
    left: Math.round(clamp(opts.anchor.left, margin, maxLeft)),
    top: Math.round(clamp(rawTop, margin, maxTop)),
    maxWidth,
    maxHeight,
    side,
  };
}
