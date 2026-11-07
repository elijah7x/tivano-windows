// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// F03 WorkingWords port — the seeded rotation and the narrow duration
// format, pinned to the frozen semantics.

import { describe, expect, it } from "vitest";
import {
  WORKING_WORDS,
  workingWordIndex,
  formatElapsed,
} from "../src/shared/workingWords";

describe("workingWords (F03)", () => {
  it("holds the frozen 22-word list", () => {
    expect(WORKING_WORDS.length).toBe(22);
    expect(WORKING_WORDS[0]).toBe("Thinking");
    expect(WORKING_WORDS[WORKING_WORDS.length - 1]).toBe("Dancing");
  });
  it("is deterministic for a thread at a given turn age", () => {
    expect(workingWordIndex("thread-a", 10)).toBe(workingWordIndex("thread-a", 10));
  });
  it("advances exactly one word per 7 seconds of turn life", () => {
    const a = workingWordIndex("thread-a", 0);
    const b = workingWordIndex("thread-a", 7);
    const c = workingWordIndex("thread-a", 14);
    expect(b).toBe((a + 1) % WORKING_WORDS.length);
    expect(c).toBe((a + 2) % WORKING_WORDS.length);
  });
  it("keeps the word inside the first window", () => {
    expect(workingWordIndex("thread-a", 6.9)).toBe(workingWordIndex("thread-a", 0));
  });
  it("different threads start on different steps often enough", () => {
    const seeds = new Set(
      ["a", "b", "c", "d", "e", "f"].map((id) => workingWordIndex(id, 0)),
    );
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe("formatElapsed (frozen RelativeTime.duration)", () => {
  it("formats seconds", () => {
    expect(formatElapsed(42_000)).toBe("42s");
  });
  it("formats minutes and seconds", () => {
    expect(formatElapsed(330_000)).toBe("5m 30s");
  });
  it("formats hours and minutes, dropping seconds", () => {
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });
  it("never goes negative", () => {
    expect(formatElapsed(-500)).toBe("0s");
  });
});
