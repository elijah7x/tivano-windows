// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 textGen: frozen TextGeneration.usable/singleLine port — generated
// replies only become titles when they read like one.

import { describe, expect, it } from "vitest";
import {
  buildPredictionContext,
  extractNextPrompt,
  extractTitle,
  singleLine,
  usableTitle,
} from "../src/shared/textGen";

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

describe("extractNextPrompt (P2-01 frozen nextPrompt)", () => {
  it("extracts a clean single-line JSON suggestion and strips fences/control chars", () => {
    expect(extractNextPrompt('```json\n{"suggestion":"  Run the tests \\u0007 "}\n```')).toBe(
      "Run the tests",
    );
    expect(extractNextPrompt('Sure:\n{"suggestion":"Check git diff"}\n')).toBe(
      "Check git diff",
    );
  });

  it("rejects null, missing, non-JSON, multiline, empty, and >240 char suggestions", () => {
    expect(extractNextPrompt('{"suggestion":null}')).toBeNull();
    expect(extractNextPrompt('{"other":"x"}')).toBeNull();
    expect(extractNextPrompt("plain text")).toBeNull();
    expect(extractNextPrompt('{"suggestion":"line 1\\nline 2"}')).toBeNull();
    expect(extractNextPrompt('{"suggestion":"   "}')).toBeNull();
    expect(extractNextPrompt(JSON.stringify({ suggestion: "a".repeat(241) }))).toBeNull();
    expect(extractNextPrompt(JSON.stringify({ suggestion: "a".repeat(240) }))).toBe(
      "a".repeat(240),
    );
  });
});

describe("buildPredictionContext (P2-01)", () => {
  it("includes first request, keeps up to 6 recent turns, and caps total at 8000 chars", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => [
      { role: "user" as const, content: `user-${i} ` + "u".repeat(900), turnId: `t${i}` },
      { role: "assistant" as const, content: `asst-${i} ` + "a".repeat(3200), turnId: `t${i}` },
    ]).flat();
    const ctx = buildPredictionContext(msgs);
    expect(ctx.startsWith("First request: user-0")).toBe(true);
    expect(ctx).toContain("User: user-7");
    expect(ctx.length).toBeLessThanOrEqual(8000);
  });
});
