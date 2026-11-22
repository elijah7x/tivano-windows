// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-26 timeline paging: frozen TimelineWindow sizes (3/12/10/96), tail
// slicing, the open grow, scroll-back paging and the follow collapse.

import { describe, expect, it } from "vitest";
import {
  TIMELINE_WINDOW,
  scrollFollowRelease,
  scrollFollowRepin,
  shouldPageHistory,
  timelineFollowReset,
  timelineGrownOpen,
  timelineJumpWindow,
  timelinePagedBack,
  timelineSlice,
} from "../src/shared/timelineWindow";

describe("timelineWindow", () => {
  it("carries frozen's sizes: firstPaint 3, initial 12, page 10, eagerLimit 96", () => {
    expect(TIMELINE_WINDOW).toEqual({
      firstPaint: 3,
      initial: 12,
      page: 10,
      eagerLimit: 96,
    });
  });

  it("slices the tail and counts what stays unrendered", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(timelineSlice(items, 12)).toEqual({
      shown: items.slice(18),
      hidden: 18,
    });
    expect(timelineSlice(items, 3).shown).toEqual([27, 28, 29]);
    // A window past the total shows everything and hides nothing.
    expect(timelineSlice(items, 40)).toEqual({ shown: items, hidden: 0 });
    expect(timelineSlice([], 12)).toEqual({ shown: [], hidden: 0 });
  });

  it("grows firstPaint to initial a beat after open", () => {
    expect(timelineGrownOpen(TIMELINE_WINDOW.firstPaint)).toBe(
      TIMELINE_WINDOW.initial,
    );
    // A reader who already paged back keeps the larger window.
    expect(timelineGrownOpen(20)).toBe(20);
  });

  it("pages back one page at a time", () => {
    expect(timelinePagedBack(12)).toBe(22);
    expect(timelinePagedBack(22)).toBe(32);
  });

  it("grows the window to mount a jump target's row", () => {
    // Minimap ticks list every block; a jump to the oldest item of a
    // 40-item thread needs the whole tail mounted.
    expect(timelineJumpWindow(40, 0)).toBe(40);
    // The newest item is already inside any nonzero window.
    expect(timelineJumpWindow(40, 39)).toBe(1);
    // Middle of history mounts the tail reaching back to it.
    expect(timelineJumpWindow(40, 10)).toBe(30);
    expect(timelineJumpWindow(0, 0)).toBe(0);
  });

  it("collapses a window past eagerLimit only while following the end", () => {
    // 12 pages back from a 100-item thread: 12 + 10*9 = 102 > 96.
    expect(timelineFollowReset(102, true)).toBe(TIMELINE_WINDOW.initial);
    expect(timelineFollowReset(102, false)).toBe(102);
    // At the limit exactly, the window holds.
    expect(timelineFollowReset(96, true)).toBe(96);
    expect(timelineFollowReset(12, true)).toBe(12);
  });
});

describe("scroll follow (P2-30, frozen ThreadTimeline)", () => {
  it("releases the follow only on the reader's own upward motion", () => {
    // Interacting + moved up + actually off the end: release.
    expect(scrollFollowRelease(30, -5, true)).toBe(true);
    // No user input: growth or an anchor shift never releases.
    expect(scrollFollowRelease(30, -5, false)).toBe(false);
    // Still at the end (<=0.5px): a jitter is not a release.
    expect(scrollFollowRelease(0.5, -5, true)).toBe(false);
    expect(scrollFollowRelease(0.4, -5, true)).toBe(false);
    // Downward or still motion is not a release.
    expect(scrollFollowRelease(30, 5, true)).toBe(false);
    expect(scrollFollowRelease(30, 0, true)).toBe(false);
    // The -0.1 boundary: strictly less releases, equal does not.
    expect(scrollFollowRelease(30, -0.1, true)).toBe(false);
    expect(scrollFollowRelease(30, -0.2, true)).toBe(true);
  });

  it("re-pins only while scrolling back down into the 8px band", () => {
    // Approaching the end and inside it: re-pin.
    expect(scrollFollowRepin(8, 20)).toBe(true);
    expect(scrollFollowRepin(0, 20)).toBe(true);
    // Outside the band even while approaching: still unpinned.
    expect(scrollFollowRepin(9, 20)).toBe(false);
    // Moving away or holding inside the band: no re-pin.
    expect(scrollFollowRepin(5, 4)).toBe(false);
    expect(scrollFollowRepin(8, 8)).toBe(false);
  });

  it("pages history within a screenful of the top, only while moving up", () => {
    const base = {
      scrollTop: 400,
      viewportHeight: 800,
      hidden: 40,
      movedUp: true,
      lastPageAt: 0,
      now: 10_000,
    };
    // Inside the screenful, moving up, with hidden rows: page.
    expect(shouldPageHistory(base)).toBe(true);
    expect(shouldPageHistory({ ...base, scrollTop: 799 })).toBe(true);
    // At/past a screenful: too far from the top to load ahead.
    expect(shouldPageHistory({ ...base, scrollTop: 800 })).toBe(false);
    expect(shouldPageHistory({ ...base, scrollTop: 1200 })).toBe(false);
    // Not moving up (growth or anchor motion near the top): never chains.
    expect(shouldPageHistory({ ...base, movedUp: false })).toBe(false);
    // Nothing hidden: nothing to page.
    expect(shouldPageHistory({ ...base, hidden: 0 })).toBe(false);
    // Inside the 250ms gesture bound: one page per gesture.
    expect(shouldPageHistory({ ...base, lastPageAt: 9_800, now: 10_000 })).toBe(
      false,
    );
    expect(shouldPageHistory({ ...base, lastPageAt: 9_750, now: 10_000 })).toBe(
      true,
    );
  });
});
