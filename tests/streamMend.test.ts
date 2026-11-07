// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// F04 StreamMend port verification — the frozen algorithm's documented
// contract, case by case (frozen StreamMend.swift has no test target
// upstream; these cases pin OUR port to its stated behavior).

import { describe, expect, it } from "vitest";
import { streamMend } from "../src/renderer/markdown";

describe("streamMend (F04)", () => {
  it("closes an open bold run", () => {
    expect(streamMend("hello **wor")).toBe("hello **wor**");
  });
  it("completes a half-written closer", () => {
    expect(streamMend("**a*")).toBe("**a**");
  });
  it("mends before trailing whitespace, not after it", () => {
    expect(streamMend("x **y   ")).toBe("x **y**   ");
  });
  it("opens bold-italic and closes innermost first", () => {
    expect(streamMend("**a *b")).toBe("**a *b***");
  });
  it("closes a single-star emphasis", () => {
    expect(streamMend("an *ital")).toBe("an *ital*");
  });
  it("closes an open strikethrough", () => {
    expect(streamMend("~~stru")).toBe("~~stru~~");
  });
  it("closes an open inline-code span", () => {
    expect(streamMend("run `cmd")).toBe("run `cmd`");
  });
  it("completes a partial fence-length backtick close", () => {
    expect(streamMend("``x`")).toBe("``x``");
  });
  it("leaves arithmetic alone", () => {
    expect(streamMend("2*3")).toBe("2*3");
  });
  it("leaves snake_case alone", () => {
    expect(streamMend("snake_case")).toBe("snake_case");
  });
  it("leaves balanced markup alone", () => {
    expect(streamMend("a **b** and `c`")).toBe("a **b** and `c`");
  });
  it("leaves an opener with only whitespace after it", () => {
    expect(streamMend("open **   ")).toBe("open **   ");
  });
  it("leaves a lone backtick alone", () => {
    expect(streamMend("`")).toBe("`");
  });
  it("honors escaped markers", () => {
    expect(streamMend("ok \\*lit")).toBe("ok \\*lit");
  });
  it("never mends inside an open code span", () => {
    // `*x` inside an unclosed code run is code, not emphasis — the code
    // closer is the only synthetic marker allowed out.
    expect(streamMend("`a *b")).toBe("`a *b`");
  });
});
