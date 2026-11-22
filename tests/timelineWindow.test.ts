// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-26 timeline paging: frozen TimelineWindow sizes (3/12/10/96), tail
// slicing, the open grow, scroll-back paging and the follow collapse.

import { describe, expect, it } from "vitest";
import {
  TIMELINE_WINDOW,
  timelineFollowReset,
  timelineGrownOpen,
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

  it("collapses a window past eagerLimit only while following the end", () => {
    // 12 pages back from a 100-item thread: 12 + 10*9 = 102 > 96.
    expect(timelineFollowReset(102, true)).toBe(TIMELINE_WINDOW.initial);
    expect(timelineFollowReset(102, false)).toBe(102);
    // At the limit exactly, the window holds.
    expect(timelineFollowReset(96, true)).toBe(96);
    expect(timelineFollowReset(12, true)).toBe(12);
  });
});
