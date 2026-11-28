// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shared popover anchoring and viewport clamping helper. Keeps transient
// popovers adjacent to their owning row/trigger while clamping within
// the viewport across scroll, resize, async layout settling and edge rows.

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
export type PopoverAlign = "start" | "end" | "center";

export interface AnchorPopoverOptions {
  anchor: AnchorRect;
  popover: PopoverSize;
  viewport: ViewportBounds;
  /** Preferred side relative to the anchor rect (default: "trailing"). */
  preferredSide?: PopoverSide | undefined;
  /** Cross-axis alignment for "top"/"bottom" placement (default: "start"). */
  align?: PopoverAlign | undefined;
  /** Cap maxHeight to available space on the chosen top/bottom side so tall
   *  popovers scroll instead of covering the trigger in constrained windows. */
  constrainSideHeight?: boolean | undefined;
  /** Keep the open popover on its current side unless constrained. */
  stickySide?: PopoverSide | undefined;
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

export interface StablePopoverState {
  anchor: AnchorRect;
  popover: PopoverSize;
  viewport: ViewportBounds;
  position: AnchoredPopoverPosition;
}

export interface StepPopoverInput {
  anchor: AnchorRect;
  popover: PopoverSize;
  viewport: ViewportBounds;
  preferredSide?: PopoverSide | undefined;
  align?: PopoverAlign | undefined;
  constrainSideHeight?: boolean | undefined;
  gap?: number | undefined;
  margin?: number | undefined;
}

const EPSILON_PX = 0.5;
const MIN_CONSTRAINED_SIDE_PX = 120;

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

export function pointToAnchor(x: number, y: number): AnchorRect {
  return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
}

export function sameAnchorRect(a: AnchorRect, b: AnchorRect): boolean {
  return (
    Math.abs(a.left - b.left) < EPSILON_PX &&
    Math.abs(a.right - b.right) < EPSILON_PX &&
    Math.abs(a.top - b.top) < EPSILON_PX &&
    Math.abs(a.bottom - b.bottom) < EPSILON_PX
  );
}

export function samePopoverSize(a: PopoverSize, b: PopoverSize): boolean {
  return (
    Math.abs(a.width - b.width) < EPSILON_PX &&
    Math.abs(a.height - b.height) < EPSILON_PX
  );
}

export function sameViewportBounds(a: ViewportBounds, b: ViewportBounds): boolean {
  return (
    Math.abs(a.width - b.width) < EPSILON_PX &&
    Math.abs(a.height - b.height) < EPSILON_PX
  );
}

export function samePopoverPosition(
  a: AnchoredPopoverPosition,
  b: AnchoredPopoverPosition,
): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.side === b.side
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

  const bottomSpace = Math.max(0, opts.viewport.height - margin - (opts.anchor.bottom + gap));
  const topSpace = Math.max(0, opts.anchor.top - gap - margin);
  const bottomFits = effectiveH <= bottomSpace;
  const topFits = effectiveH <= topSpace;

  let side: PopoverSide = preferredSide;
  if (opts.stickySide === "top" || opts.stickySide === "bottom") {
    if (opts.stickySide === "bottom") {
      const shouldFlip =
        !bottomFits &&
        (topFits ||
          (opts.constrainSideHeight === true &&
            bottomSpace < MIN_CONSTRAINED_SIDE_PX &&
            topSpace > bottomSpace));
      side = shouldFlip ? "top" : "bottom";
    } else {
      const shouldFlip =
        !topFits &&
        (bottomFits ||
          (opts.constrainSideHeight === true &&
            topSpace < MIN_CONSTRAINED_SIDE_PX &&
            bottomSpace > topSpace));
      side = shouldFlip ? "bottom" : "top";
    }
  } else if (preferredSide === "bottom" && !bottomFits && topFits) {
    side = "top";
  } else if (preferredSide === "top" && !topFits && bottomFits) {
    side = "bottom";
  } else if (opts.constrainSideHeight && !bottomFits && !topFits) {
    if (preferredSide === "top" && topSpace < MIN_CONSTRAINED_SIDE_PX && bottomSpace > topSpace) {
      side = "bottom";
    } else if (
      preferredSide === "bottom" &&
      bottomSpace < MIN_CONSTRAINED_SIDE_PX &&
      topSpace > bottomSpace
    ) {
      side = "top";
    }
  }

  let sideMaxHeight = maxHeight;
  if (opts.constrainSideHeight) {
    const availableOnSide = Math.floor(side === "top" ? topSpace : bottomSpace);
    if (availableOnSide >= Math.min(MIN_CONSTRAINED_SIDE_PX, maxHeight)) {
      sideMaxHeight = Math.min(maxHeight, availableOnSide);
    }
  }
  const sideEffectiveH = Math.min(Math.max(0, Math.ceil(opts.popover.height)), sideMaxHeight);
  const sideMaxTop = Math.max(margin, Math.floor(opts.viewport.height - sideEffectiveH - margin));
  const rawTop =
    side === "bottom"
      ? opts.anchor.bottom + gap
      : opts.anchor.top - gap - sideEffectiveH;

  const align = opts.align ?? "start";
  const rawLeft =
    align === "end"
      ? opts.anchor.right - effectiveW
      : align === "center"
        ? opts.anchor.left + opts.anchor.width / 2 - effectiveW / 2
        : opts.anchor.left;

  return {
    left: Math.round(clamp(rawLeft, margin, maxLeft)),
    top: Math.round(clamp(rawTop, margin, sideMaxTop)),
    maxWidth,
    maxHeight: sideMaxHeight,
    side,
  };
}

/** Captures initial popover placement and only updates coordinates for real
 *  anchor movement, viewport resize, or size/constraint changes >= 0.5px. */
export function stepAnchoredPopover(
  prev: StablePopoverState | null,
  input: StepPopoverInput,
): StablePopoverState {
  if (prev === null) {
    const position = anchorPopover({
      anchor: input.anchor,
      popover: input.popover,
      viewport: input.viewport,
      preferredSide: input.preferredSide,
      align: input.align,
      constrainSideHeight: input.constrainSideHeight,
      gap: input.gap,
      margin: input.margin,
    });
    return {
      anchor: input.anchor,
      popover: input.popover,
      viewport: input.viewport,
      position,
    };
  }

  const anchorMoved = !sameAnchorRect(prev.anchor, input.anchor);
  const viewportChanged = !sameViewportBounds(prev.viewport, input.viewport);
  const sizeChanged = !samePopoverSize(prev.popover, input.popover);
  if (!anchorMoved && !viewportChanged && !sizeChanged) return prev;

  const nextAnchor = anchorMoved ? input.anchor : prev.anchor;
  const nextViewport = viewportChanged ? input.viewport : prev.viewport;
  const nextPopover = sizeChanged ? input.popover : prev.popover;

  const nextPosition = anchorPopover({
    anchor: nextAnchor,
    popover: nextPopover,
    viewport: nextViewport,
    preferredSide: input.preferredSide,
    align: input.align,
    constrainSideHeight: input.constrainSideHeight,
    stickySide: !anchorMoved && !viewportChanged ? prev.position.side : undefined,
    gap: input.gap,
    margin: input.margin,
  });

  return {
    anchor: nextAnchor,
    popover: nextPopover,
    viewport: nextViewport,
    position: samePopoverPosition(prev.position, nextPosition)
      ? prev.position
      : nextPosition,
  };
}
