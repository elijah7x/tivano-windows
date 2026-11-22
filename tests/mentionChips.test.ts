// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-44 (frozen FileMentionText): chip token model — pick minting,
// edit re-anchoring, atomic backspace hit, pasted-text parsing.

import { describe, expect, it } from "vitest";
import {
  chipBeforeCaret,
  chipText,
  chipToken,
  chipsAfterEdit,
  chipsFromText,
  renderableChips,
} from "../src/shared/mentionChips";

describe("P2-44 mention chips", () => {
  it("pick mints the token text and span", () => {
    const { text, chip } = chipToken("src/a.ts", 4);
    expect(text).toBe("@src/a.ts ");
    expect(chip).toEqual({ path: "src/a.ts", start: 4, end: 4 + 10 });
    expect(chipText(chip)).toBe("@src/a.ts ");
  });

  it("edits before a token shift it; edits inside re-anchor or drop", () => {
    const c = { path: "a/b.ts", start: 4, end: 4 + 8 };
    // Type 3 chars ahead of the token.
    const n1 = chipsAfterEdit([c], "see @a/b.ts go", "see XYZ@a/b.ts go");
    expect(n1).toEqual([{ ...c, start: 7, end: 15 }]);
    // Delete 2 chars inside the token — the chip dies.
    const broken = "see @a/b.ts go".slice(0, 6) + " go";
    expect(chipsAfterEdit([c], "see @a/b.ts go", broken)).toEqual([]);
    // Undo restores the token text — the chip re-anchors to it.
    const restored = chipsAfterEdit([], broken, "see @a/b.ts go");
    expect(restored).toEqual([]);
    const back = chipsAfterEdit([c], broken, "see @a/b.ts go");
    expect(back).toEqual([{ path: "a/b.ts", start: 4, end: 12 }]);
  });

  it("duplicate tokens keep their own spans", () => {
    const text = "@a/x @a/x ";
    const chips = [
      { path: "a/x", start: 0, end: 5 },
      { path: "a/x", start: 5, end: 10 },
    ];
    // Insert a space between them — both survive, second shifts.
    const n = chipsAfterEdit(chips, text, "@a/x  @a/x ");
    expect(n).toEqual([
      { path: "a/x", start: 0, end: 5 },
      { path: "a/x", start: 6, end: 11 },
    ]);
  });

  it("backspace peels the whole chip only at its end", () => {
    const chips = [{ path: "a/x", start: 4, end: 9 }];
    expect(chipBeforeCaret(chips, 9)).toEqual(chips[0]);
    expect(chipBeforeCaret(chips, 8)).toEqual(chips[0]); // inside end-1 = last char
    expect(chipBeforeCaret(chips, 7)).toBeNull();
    expect(chipBeforeCaret(chips, 0)).toBeNull();
  });

  it("pasted text re-creates chips only for known project paths", () => {
    const ok = new Set(["src/a.ts", "b.md"]);
    const out = chipsFromText("use @src/a.ts and @nope.txt plus @b.md ", ok);
    expect(out).toEqual([
      { path: "src/a.ts", start: 4, end: 13 },
      { path: "b.md", start: 33, end: 38 },
    ]);
    // @ alone or an unknown path stays plain text.
    expect(chipsFromText("@ @unknown ", ok)).toEqual([]);
    // A token at end-of-text mints too — no trailing space required.
    expect(chipsFromText("tail @b.md", ok)).toEqual([
      { path: "b.md", start: 5, end: 10 },
    ]);
  });

  it("renderableChips returns mirror order and drops stale spans", () => {
    const text = "@a.md hi @b.md ";
    const unsorted = [
      { path: "b.md", start: 10, end: 15 },
      { path: "a.md", start: 0, end: 5 },
    ];
    // Overlay rects index this list — order must follow the mirror.
    expect(renderableChips(unsorted, text)).toEqual([
      { path: "a.md", start: 0, end: 5 },
      { path: "b.md", start: 10, end: 15 },
    ]);
    // A span past the text or overlapping the prior token drops out.
    expect(
      renderableChips(
        [
          { path: "a.md", start: 0, end: 5 },
          { path: "gone", start: 3, end: 9 },
          { path: "tail", start: 40, end: 45 },
        ],
        text,
      ),
    ).toEqual([{ path: "a.md", start: 0, end: 5 }]);
  });
});
