// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-44 (frozen FileMentionText): @-picked files are atomic chips in the
// composer. The port keeps the textarea (real text stays "@path " — copy
// and send need no re-serialization) and renders a chip overlay over each
// token; these pure helpers own the token model, the offset bookkeeping
// after an edit, the atomic-delete hit test, and pasted-text parsing.

/** A chip token: the `@path ` span at [start, end) in the draft text. */
export interface MentionChip {
  path: string;
  start: number;
  end: number;
}

/** Insert a chip token for `path` at `at` (the picked suggestion replaces
 *  the "@query" being typed: caller passes mention.start + caret). */
export function chipToken(path: string, at: number): { text: string; chip: MentionChip } {
  return { text: `@${path} `, chip: { path, start: at, end: at + path.length + 2 } };
}

/** Re-align chips after a text edit. `prev`/`next` are the draft before
 *  and after; chips whose token text no longer sits at their span are
 *  re-anchored to the next unclaimed `@path ` occurrence of their path,
 *  else dropped — covers typed inserts, browser undo/redo, and paste. */
export function chipsAfterEdit(
  chips: MentionChip[],
  prev: string,
  next: string,
): MentionChip[] {
  // Fast path: identical text keeps every chip.
  if (prev === next) return chips;
  // Locate the edit as [pStart, pEnd) → [nStart, nEnd).
  let pStart = 0;
  const minLen = Math.min(prev.length, next.length);
  while (pStart < minLen && prev[pStart] === next[pStart]) pStart += 1;
  let pEnd = prev.length;
  let nEnd = next.length;
  while (
    pEnd > pStart &&
    nEnd > pStart &&
    prev[pEnd - 1] === next[nEnd - 1]
  ) {
    pEnd -= 1;
    nEnd -= 1;
  }
  const delta = nEnd - pStart - (pEnd - pStart);
  const out: MentionChip[] = [];
  const claimed = new Set<number>();
  for (const c of chips) {
    let start = c.start;
    let end = c.end;
    if (end <= pStart) {
      // Fully before the edit — unchanged.
    } else if (start >= pEnd) {
      start += delta;
      end += delta;
    } else {
      // The edit touched the token — re-anchor to a surviving identical
      // occurrence of its path (undo of a chip delete restores it).
      const at = unclaimedToken(next, c.path, claimed);
      if (at === null) continue;
      out.push({ path: c.path, start: at, end: at + c.path.length + 2 });
      continue;
    }
    if (next.slice(start, end) === `@${c.path} `) {
      claimed.add(start);
      out.push({ path: c.path, start, end });
      continue;
    }
    const at = unclaimedToken(next, c.path, claimed);
    if (at !== null)
      out.push({ path: c.path, start: at, end: at + c.path.length + 2 });
  }
  return out;
}

/** The first `@path ` occurrence not already claimed by another chip. */
function unclaimedToken(
  text: string,
  path: string,
  claimed: Set<number>,
): number | null {
  const tok = `@${path} `;
  let i = text.indexOf(tok);
  while (i !== -1) {
    if (!claimed.has(i)) {
      claimed.add(i);
      return i;
    }
    i = text.indexOf(tok, i + 1);
  }
  return null;
}

/** The chip a collapsed caret at `pos` would delete whole (frozen chip
 *  backspace — the caret sits at a token's end, or just after its
 *  trailing space inside the same word). */
export function chipBeforeCaret(
  chips: MentionChip[],
  pos: number,
): MentionChip | null {
  return chips.find((c) => pos === c.end || pos === c.end - 1) ?? null;
}

/** "@<token>" occurrences in pasted/plain text that should become chips:
 *  whitespace- or start-bounded `@` spans whose inner part matches a known
 *  project path (`paths` is the exact-match set; @ alone, with spaces, or
 *  mid-word — emails, handles — is plain text). */
export function chipsFromText(
  text: string,
  paths: ReadonlySet<string>,
): MentionChip[] {
  const out: MentionChip[] = [];
  const re = /@([^\s@]+)(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > 0 && !/\s/.test(text[m.index - 1]!)) continue;
    const path = m[1]!;
    if (!paths.has(path)) continue;
    const end = m.index + m[0].length;
    out.push({ path, start: m.index, end: text[end] === " " ? end + 1 : end });
  }
  return out;
}

/** Chips in mirror order — sorted by start, overlapping/stale spans
 *  dropped. The overlay rects index this exact list, so a chip minted
 *  before an existing one (caret moved left, mid-text paste) can never
 *  draw at another token's box. */
export function renderableChips(
  chips: MentionChip[],
  text: string,
): MentionChip[] {
  const out: MentionChip[] = [];
  let at = 0;
  for (const c of [...chips].sort((a, b) => a.start - b.start)) {
    if (c.start < at || c.end > text.length) continue;
    out.push(c);
    at = c.end;
  }
  return out;
}

/** Every chip token span as "@path " — used to clip a copy selection to
 *  whole chips is unnecessary in the port (the token IS the text), but
 *  tests and send use it to assert the wire form stays verbatim. */
export function chipText(chip: MentionChip): string {
  return `@${chip.path} `;
}
