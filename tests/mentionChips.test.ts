// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-44 (frozen FileMentionText): chip token model — pick minting,
// edit re-anchoring, atomic backspace hit, pasted-text parsing.

import { describe, expect, it } from "vitest";
import {
  chipBeforeCaret,
  chipLabel,
  chipText,
  chipToken,
  chipsAfterEdit,
  chipsFromResolved,
  chipsFromText,
  mentionCandidates,
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

  it("end-of-text tokens survive edits in front of them", () => {
    // Paste "see @b.md" (EOT token, no trailing space), then type a
    // prefix — the shifted span check must accept the no-space form.
    const eot = [{ path: "b.md", start: 4, end: 9 }];
    const next = chipsAfterEdit(eot, "see @b.md", "see! @b.md");
    expect(next).toEqual([{ path: "b.md", start: 5, end: 10 }]);
    // Removing a trailing space from "@path " shrinks the chip to the
    // EOT form rather than dropping it.
    const spaced = [{ path: "b.md", start: 4, end: 10 }];
    const shrunk = chipsAfterEdit(spaced, "see @b.md ", "see @b.md");
    expect(shrunk).toEqual([{ path: "b.md", start: 4, end: 9 }]);
    // "@pathology" never re-anchors a dropped token as a mid-word hit.
    expect(
      chipsAfterEdit(eot, "see @b.md", "see @b.mdology"),
    ).toEqual([]);
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
    // end includes the token's trailing space (the atomic-backspace hit
    // test expects the caret-right-after position to land on a chip).
    expect(out).toEqual([
      { path: "src/a.ts", start: 4, end: 14 },
      { path: "b.md", start: 33, end: 39 },
    ]);
    // @ alone or an unknown path stays plain text.
    expect(chipsFromText("@ @unknown ", ok)).toEqual([]);
    // A token at end-of-text mints too — no trailing space required.
    expect(chipsFromText("tail @b.md", ok)).toEqual([
      { path: "b.md", start: 5, end: 10 },
    ]);
    // Mid-word @ (emails, handles) never mints — the frozen rule needs
    // whitespace or start-of-text before it.
    expect(chipsFromText("mail me@b.md please", ok)).toEqual([]);
    expect(chipsFromText("(x@b.md)", ok)).toEqual([]);
  });

  it("mentionCandidates yields space-joined forms up to maxSpaces", () => {
    // Frozen maxSpacesInPath=6: "see @docs/My File.ts" offers
    // "docs/My", "docs/My File.ts"… — exact resolution picks the hit.
    const cands = mentionCandidates("see @docs/My File.ts now @b.md");
    expect(cands).toContain("docs/My");
    expect(cands).toContain("docs/My File.ts");
    expect(cands).toContain("b.md");
    // Seven spaces deep stops at 6 continuations.
    const deep = mentionCandidates("@a b c d e f g h i");
    expect(deep).toContain("a b c d e f g");
    expect(deep).not.toContain("a b c d e f g h");
    // Mid-word @ never becomes a candidate.
    expect(mentionCandidates("mail me@b.md please")).toEqual([]);
  });

  it("chipsFromResolved lets a spaced path claim its start first", () => {
    // "@a b.ts" resolved — the long form wins the shared start; "@a"
    // alone still mints at its own later token.
    const out = chipsFromResolved("use @a b.ts then @a ", ["a b.ts", "a"]);
    expect(out).toEqual([
      { path: "a b.ts", start: 4, end: 12 },
      { path: "a", start: 17, end: 20 },
    ]);
    // Whitespace- or start-bounded tokens only — mid-word stays text.
    expect(chipsFromResolved("me@a b.ts ", ["a b.ts"])).toEqual([]);
    // An unresolved spaced prefix never mints its first word instead —
    // only resolved paths produce chips.
    expect(chipsFromResolved("use @a b.ts ", ["b.ts"])).toEqual([]);
  });

  it("chipLabel widens a duplicated basename to dir/name", () => {
    const chips = [
      { path: "src/a/note.md", start: 0, end: 14 },
      { path: "docs/b/note.md", start: 15, end: 30 },
      { path: "src/solo.ts", start: 31, end: 42 },
    ];
    expect(chipLabel("src/a/note.md", chips)).toBe("a/note.md");
    expect(chipLabel("docs/b/note.md", chips)).toBe("b/note.md");
    expect(chipLabel("src/solo.ts", chips)).toBe("solo.ts");
    // The same path twice (duplicate tokens) does not self-disambiguate.
    const same = [
      { path: "a/x.md", start: 0, end: 7 },
      { path: "a/x.md", start: 8, end: 15 },
    ];
    expect(chipLabel("a/x.md", same)).toBe("x.md");
  });

  it("renderableChips returns mirror order and drops stale spans", () => {
    const text = "@a.md hi @b.md ";
    const unsorted = [
      { path: "b.md", start: 9, end: 15 },
      { path: "a.md", start: 0, end: 6 },
    ];
    // Overlay rects index this list — order must follow the mirror.
    expect(renderableChips(unsorted, text)).toEqual([
      { path: "a.md", start: 0, end: 6 },
      { path: "b.md", start: 9, end: 15 },
    ]);
    // A span past the text, overlapping the prior token, or sitting over
    // text that is not its token drops out.
    expect(
      renderableChips(
        [
          { path: "a.md", start: 0, end: 6 },
          { path: "gone", start: 3, end: 9 },
          { path: "tail", start: 40, end: 45 },
          { path: "hi", start: 6, end: 8 },
        ],
        text,
      ),
    ).toEqual([{ path: "a.md", start: 0, end: 6 }]);
  });
});
