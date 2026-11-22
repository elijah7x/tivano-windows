// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-45 (frozen previews .60/.32/.87): selection residue repaint gate +
// the pointer-cursor rule set — words get the text cursor, links the
// hand, chrome surfaces the arrow.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectionIntersects } from "../src/renderer/selectionRepaint";

const css = readFileSync(join(__dirname, "../src/renderer/styles.css"), "utf8");

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
  it("scopes the text cursor to words inside message bodies", () => {
    expect(css).toContain(".timeline { cursor: default; }");
    expect(css).toContain("cursor: text;");
    expect(css).toContain(".timeline a[href] { cursor: pointer; }");
  });
  it("keeps the arrow on chrome surfaces named by the frozen fix", () => {
    // buttons, cards, menus, popovers, diff, panels, top bar
    for (const cls of [
      ".chat-head",
      ".approval.question",
      ".git-patch",
      ".suggest-menu",
      ".modal",
      ".turn-steps > summary",
    ]) {
      expect(css, cls).toContain(cls);
    }
    expect(css).toContain("cursor: default;");
  });
});
