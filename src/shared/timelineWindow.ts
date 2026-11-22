// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-26 (frozen TimelineWindow): chat history pages — the window opens on
// a handful of blocks for the first paint, grows to its resting size a
// beat later, then pages back as the reader scrolls up, and collapses
// while the tail is followed past the eager limit.

export const TIMELINE_WINDOW = {
  /** The blocks built before the first frame lands. */
  firstPaint: 3,
  /** The resting window once the thread is open. */
  initial: 12,
  /** A page of history per scroll-back. */
  page: 10,
  /** Following the end past this many blocks drops the window to initial. */
  eagerLimit: 96,
} as const;

/** The tail `visible` items of `items` plus how many stay unrendered —
 *  the window always keeps the newest end, so scroll-back never moves
 *  the bottom anchor. */
export function timelineSlice<T>(
  items: readonly T[],
  visible: number,
): { shown: T[]; hidden: number } {
  const hidden = Math.max(0, items.length - Math.max(0, visible));
  return { shown: items.slice(hidden), hidden };
}

/** The window size after the open paint: firstPaint → initial, unless the
 *  reader already paged back further. */
export function timelineGrownOpen(visible: number): number {
  return Math.max(visible, TIMELINE_WINDOW.initial);
}

/** The window size after a scroll-back page — `page` more, never past the
 *  total. */
export function timelinePagedBack(visible: number): number {
  return visible + TIMELINE_WINDOW.page;
}

/** Frozen eagerLimit: while the reader follows the end (live tail), a
 *  window grown past the limit collapses back to initial; a reader who
 *  paged up keeps what they loaded. */
export function timelineFollowReset(
  visible: number,
  following: boolean,
): number {
  return following && visible > TIMELINE_WINDOW.eagerLimit
    ? TIMELINE_WINDOW.initial
    : visible;
}
