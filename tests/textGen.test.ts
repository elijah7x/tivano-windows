// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 textGen: frozen TextGeneration.usable/singleLine port — generated
// replies only become titles when they read like one.

import { describe, expect, it } from "vitest";
import { extractTitle, singleLine, usableTitle } from "../src/shared/textGen";

describe("singleLine (frozen TextCleanup)", () => {
  it("takes the first non-empty line and trims", () => {
    expect(singleLine("\n\n  Fix the thing  \nsecond line")).toBe("Fix the thing");
  });
  it("caps with an ellipsis at limit", () => {
    expect(singleLine("x".repeat(200), 60)).toBe(`${"x".repeat(59)}…`);
  });
});

describe("usableTitle (frozen TextGeneration.usable)", () => {
  it("accepts a plain short title", () => {
    expect(usableTitle("Fix the login flow")).toBe("Fix the login flow");
  });
  it("rejects empty, long and wordy candidates", () => {
    expect(usableTitle("   ")).toBeNull();
    expect(usableTitle("x".repeat(65))).toBeNull();
    expect(usableTitle("one two three four five six seven eight nine ten")).toBeNull();
  });
  it("rejects questions and frozen trailing punctuation", () => {
    expect(usableTitle("Fix the login flow?")).toBeNull();
    expect(usableTitle("Fix the login flow!")).toBeNull();
    expect(usableTitle("Fix the login flow:")).toBeNull();
    expect(usableTitle("Fix the login flow…")).toBeNull();
    // "." is NOT in the frozen reject set — it is stripped upstream by
    // trimmingCharacters before usable() ever runs.
    expect(usableTitle("Fix the login flow.")).toBe("Fix the login flow.");
  });
  it("rejects chatty openers and refusal phrases", () => {
    expect(usableTitle("Sure, here is a title")).toBeNull();
    expect(usableTitle("I need more context to create a meaningful title")).toBeNull();
    expect(usableTitle("Sorry I cannot help")).toBeNull();
    expect(usableTitle("Could you clarify the request")).toBeNull();
  });
});

describe("extractTitle (frozen threadTitle extraction)", () => {
  it("cleans the wrapped reply", () => {
    expect(extractTitle('"Fix the login flow"\n')).toBe("Fix the login flow");
  });
  it("falls back to the untruncated first line (61–64 chars)", () => {
    // 61 chars / 9 words — singleLine's 60-char cap adds a trailing "…" that
    // fails usable(); the frozen first-line fallback recovers it.
    const long = "Carefully handle every late event inside the streaming engine";
    expect(long.length).toBe(61);
    expect(extractTitle(`${long}\ntrailing chatter`)).toBe(long);
  });
  it("returns null for unrecoverable chatter", () => {
    expect(extractTitle("I need more context. What spec should I follow?")).toBeNull();
  });
});
