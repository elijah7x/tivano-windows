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

/** The window size after a scroll-back page — `page` more; `timelineSlice`
 *  clamps a count past the total to the head. */
export function timelinePagedBack(visible: number): number {
  return visible + TIMELINE_WINDOW.page;
}

/** The window size that mounts item `idx`: the tail reaching back to it,
 *  so a minimap jump can find its row (minimap ticks list every block,
 *  mounted or not). */
export function timelineJumpWindow(total: number, idx: number): number {
  return Math.max(0, total - idx);
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

// P2-30 (frozen ThreadTimeline scroll tracking): only the reader's own
// scrolling decides whether the timeline follows new text. `delta` is the
// reader's own motion (anchor growth excluded by the caller), positive is
// downward.

/** Frozen release: while the reader is interacting, any upward motion
 *  away from the end unpins the follow. A held finger is not a release;
 *  a starting turn is not either — growth under a top anchor never reads
 *  as the reader leaving the end because `delta` excludes it.
 *  `unexplainedUp` covers the input the port's event gate cannot see:
 *  a native-scrollbar drag (or keyboard paging) fires no wheel/touch/
 *  pointer event, yet the port's own writes only ever raise scrollTop —
 *  so a scrollTop drop with an UNCHANGED scrollHeight is still the
 *  reader moving up (a layout clamp shrinks scrollHeight too and is
 *  excluded by the caller). */
export function scrollFollowRelease(
  distanceFromBottom: number,
  delta: number,
  userScrolling: boolean,
  unexplainedUp = false,
): boolean {
  return (userScrolling || unexplainedUp) && distanceFromBottom > 0.5 && delta < -0.1;
}

/** Frozen re-pin: the reader scrolling back down re-follows once the end
 *  is within 8px — a coast that lands exactly is a follow again. */
export function scrollFollowRepin(
  distanceFromBottom: number,
  previousDistance: number,
): boolean {
  return distanceFromBottom < previousDistance && distanceFromBottom <= 8;
}

/** Frozen load-ahead: page earlier history in when the hidden travel left
 *  under the reader is less than a screenful (`new.travel < containerHeight`),
 *  but only while the reader is actually moving up — a growth-driven event
 *  near the top never chains the whole history in. `lastAt`/`now` keep the
 *  port's one-page-per-gesture bound (frozen `historyLoadPending`). */
export function shouldPageHistory(args: {
  scrollTop: number;
  viewportHeight: number;
  hidden: number;
  movedUp: boolean;
  lastPageAt: number;
  now: number;
}): boolean {
  return (
    args.movedUp &&
    args.scrollTop < args.viewportHeight &&
    args.hidden > 0 &&
    args.now - args.lastPageAt >= 250
  );
}
