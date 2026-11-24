// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-45 (frozen previews .60/.32/.87): selection residue repaint gate +
// the pointer-cursor rule set — words get the text cursor, links the
// hand, chrome surfaces the arrow.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectionIntersects } from "../src/renderer/selectionRepaint";

const css = readFileSync(join(__dirname, "../src/renderer/styles.css"), "utf8").replace(/\r\n/g, "\n");

describe("P2-45 selection intersects", () => {
  const el = { contains: (n: Node | null) => n === INSIDE };
  const INSIDE = {} as Node;
  const OUTSIDE = {} as Node;
  const sel = (a: Node, f: Node, collapsed = false) =>
    ({ isCollapsed: collapsed, anchorNode: a, focusNode: f }) as const;

  it("an uncollapsed selection touching the element counts", () => {
    expect(selectionIntersects(sel(INSIDE, OUTSIDE), el)).toBe(true);
    expect(selectionIntersects(sel(OUTSIDE, INSIDE), el)).toBe(true);
    expect(selectionIntersects(sel(OUTSIDE, OUTSIDE), el)).toBe(false);
    expect(selectionIntersects(sel(INSIDE, INSIDE), el)).toBe(true);
  });
  it("a collapsed caret or no selection never counts", () => {
    expect(selectionIntersects(sel(INSIDE, INSIDE, true), el)).toBe(false);
    expect(selectionIntersects(null, el)).toBe(false);
  });
});

describe("P2-45 cursor rules", () => {
  const ruleFor = (prop: string): string[] =>
    [...css.matchAll(/([^{}]+)\{[^{}]*cursor:\s*auto;[^{}]*\}/g)]
      .filter((m) => prop === "auto" || prop === "all")
      .map((m) => m[1]!);

  it("resolves reply text per hit: I-beam over glyphs, arrow over space", () => {
    expect(css).toContain(".timeline { cursor: default; }");
    // Every selectable text container in a reply resolves per hit —
    // dropping one regresses to the arrow over words (A1 regression).
    const auto = ruleFor("auto").join("\n");
    for (const sel of [
      ".timeline .msg-body",
      ".timeline .notice-text",
      ".timeline .status-line",
      ".timeline .tool-detail",
      ".timeline .plan-body",
      ".timeline .work-thinking",
      ".timeline .hr-body",
    ]) {
      expect(auto, sel).toContain(sel);
    }
    expect(css).toContain(".timeline a[href] { cursor: pointer; }");
  });
  it("lets selectable diff text resolve per hit instead of pinning the arrow", () => {
    const auto = ruleFor("auto").join("\n");
    for (const sel of [".git-patch", ".git-diff", ".ckpt-diff-wrap"]) {
      expect(auto, sel).toContain(sel);
    }
    // Regression: these used to sit in the cursor:default list while
    // carrying user-select:text content.
    const defaults = css.match(/cursor:\s*default;\s*\}/g);
    expect(defaults).not.toBeNull();
    const defaultBlock = css
      .split("cursor: default;")
      .find((b) => b.includes(".timeline button"));
    expect(defaultBlock).not.toContain(".git-patch");
    expect(defaultBlock).not.toContain(".git-diff");
  });
  it("gives text controls the I-beam inside cursor:default containers", () => {
    expect(css).toContain('input[type="text"],');
    expect(css).toContain("textarea,\n[contenteditable=\"true\"] {\n  cursor: text;");
  });
  it("keeps the arrow on chrome surfaces named by the frozen fix", () => {
    const defaultBlock = css
      .split("cursor: default;")
      .find((b) => b.includes(".timeline button"));
    expect(defaultBlock).toBeDefined();
    for (const sel of [
      ".chat-head",
      ".sidebar",
      ".approval.question",
      ".suggest-menu",
      ".modal",
      ".link-pop",
      ".openin-menu",
      ".icon-pop",
      ".info-pop",
      ".hydra-brief-pop",
      ".hydra-report-pop",
      ".hydra-mark-pop",
      ".thread-changes-pop",
      ".palette",
      ".git-panel",
      ".term-head",
      ".turn-steps > summary",
    ]) {
      expect(defaultBlock, sel).toContain(sel);
    }
    // Dead selectors from the first pass must not come back — they
    // matched no DOM classes while leaving real surfaces uncovered.
    expect(defaultBlock).not.toMatch(/(^|[\s,])\.row-menu[\s,]/);
    expect(defaultBlock).not.toMatch(/(^|[\s,])\.hb-pop[\s,{]/);
  });
  it("restores per-hit text inside markdown popover bodies", () => {
    expect(css).toContain(".hydra-brief-pop .hb-pop-body,");
    expect(css).toContain(".hydra-report-pop .hr-body { cursor: auto; }");
  });
});
