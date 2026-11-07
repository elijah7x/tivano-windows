// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F25: frozen MergeRequestLink — forge recognition, label/title and the
// helper brief (verbatim frozen prompt bodies).

import { describe, expect, it } from "vitest";
import { parseMergeRequestLink } from "../src/shared/mergeRequestLink";

describe("F25 parseMergeRequestLink (frozen MergeRequestLink)", () => {
  it("github pull → github forge, #n label, gh brief", () => {
    const r = parseMergeRequestLink("https://github.com/owner/repo/pull/95");
    expect(r?.forge).toBe("github");
    expect(r?.number).toBe(95);
    expect(r?.label).toBe("#95");
    expect(r?.title).toBe("Merge #95");
    expect(r?.prompt).toContain("Merge #95 now: https://github.com/owner/repo/pull/95");
    expect(r?.prompt).toContain("`gh pr merge 95 --merge`");
    expect(r?.prompt).toContain("`git pull --ff-only`");
    expect(r?.prompt).toContain("Reply in a few lines");
  });

  it("gitlab merge_requests on ANY host → !n label, glab brief", () => {
    const r = parseMergeRequestLink(
      "https://gitlab.internal.example/group/sub/proj/-/merge_requests/42",
    );
    expect(r?.forge).toBe("gitlab");
    expect(r?.number).toBe(42);
    expect(r?.label).toBe("!42");
    expect(r?.title).toBe("Merge !42");
    expect(r?.prompt).toContain("`glab mr merge 42 --yes`");
    expect(r?.prompt).toContain("405");
  });

  it("gitea pulls path → tea brief", () => {
    const r = parseMergeRequestLink("https://codeberg.org/a/b/pulls/7");
    expect(r?.forge).toBe("gitea");
    expect(r?.number).toBe(7);
    expect(r?.prompt).toContain("`tea pulls merge 7`");
  });

  it("cursor codebase pull → origin brief with -R owner/repo", () => {
    const r = parseMergeRequestLink("https://cursor.com/codebase/acme/shop/pull/3");
    expect(r?.forge).toBe("cursorOrigin");
    expect(r?.number).toBe(3);
    expect(r?.prompt).toContain("`origin pr merge 3 -R acme/shop`");
    expect(r?.prompt).toContain("`origin pr view 3 -R acme/shop --json status,mergedAt`");
  });

  it("a suffix page after the number still parses (frozen: diffs included)", () => {
    expect(parseMergeRequestLink("https://github.com/o/r/pull/9/files")?.number).toBe(9);
    expect(
      parseMergeRequestLink("https://g.local/p/-/merge_requests/9/diffs")?.forge,
    ).toBe("gitlab");
  });

  it("rejects non-links and non-request paths", () => {
    expect(parseMergeRequestLink("not a url")).toBeUndefined();
    expect(parseMergeRequestLink("https://github.com/o/r/issues/9")).toBeUndefined();
    expect(parseMergeRequestLink("https://github.com/o/r/pull/abc")).toBeUndefined();
    expect(parseMergeRequestLink("https://github.com/o/r/pull/0")).toBeUndefined();
    expect(parseMergeRequestLink("https://github.com/o/r/pull/05x")).toBeUndefined();
    // merge_requests at the very first segment never counts (index >= 1).
    expect(parseMergeRequestLink("https://x/merge_requests/5")).toBeUndefined();
    // A non-pull cursor.com link is never a merge request.
    expect(parseMergeRequestLink("https://cursor.com/features")).toBeUndefined();
    // Deep cursor path missing the pull segment.
    expect(parseMergeRequestLink("https://cursor.com/codebase/a/b/tree/3")).toBeUndefined();
  });
});
