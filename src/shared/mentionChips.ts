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
      const tok = unclaimedToken(next, c.path, claimed);
      if (tok === null) continue;
      out.push({ path: c.path, start: tok.at, end: tok.end });
      continue;
    }
    if (tokenEndAt(next, start, c.path) === end) {
      claimed.add(start);
      out.push({ path: c.path, start, end });
      continue;
    }
    const tok = unclaimedToken(next, c.path, claimed);
    if (tok !== null)
      out.push({ path: c.path, start: tok.at, end: tok.end });
  }
  return out;
}

/** The span end of a `@path` token starting at `at` — `@path ` when the
 *  trailing space is present, `@path` at end-of-text; null when no
 *  token sits there (mid-word "@pathology" never matches: the next char
 *  must be whitespace or the end). */
function tokenEndAt(text: string, at: number, path: string): number | null {
  const bare = `@${path}`;
  if (!text.startsWith(bare, at)) return null;
  const end = at + bare.length;
  if (end < text.length && !/\s/.test(text[end]!)) return null;
  return text[end] === " " ? end + 1 : end;
}

/** The first unclaimed `@path`/`@path ` occurrence's span. */
function unclaimedToken(
  text: string,
  path: string,
  claimed: Set<number>,
): { at: number; end: number } | null {
  const bare = `@${path}`;
  let i = text.indexOf(bare);
  while (i !== -1) {
    const end = tokenEndAt(text, i, path);
    if (end !== null && !claimed.has(i)) {
      claimed.add(i);
      return { at: i, end };
    }
    i = text.indexOf(bare, i + 1);
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

/** Frozen FileMentions maxSpacesInPath (6): every `@token` in `text`
 *  also yields its space-joined continuations so pasted/reloaded
 *  "see @docs/My File.ts" resolves the full spaced path, not just the
 *  first word. Whitespace- or start-bounded `@` only — emails/handles
 *  never become candidates. Longest form is last per token. */
export function mentionCandidates(text: string, maxSpaces = 6): string[] {
  const out = new Set<string>();
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > 0 && !/\s/.test(text[m.index - 1]!)) continue;
    let span = m[1]!;
    let rest = m.index + m[0].length;
    out.add(span);
    for (let s = 0; s < maxSpaces; s++) {
      const nm = /^ ([^\s@]+)/.exec(text.slice(rest));
      if (!nm) break;
      span += nm[0];
      rest += nm[0].length;
      out.add(span);
    }
  }
  return [...out];
}

/** Mint chips for the index-resolved paths — the spaced-aware twin of
 *  chipsFromText. Longest paths claim their token start first, so a
 *  spaced path beats its own first-word prefix ("@a b.ts" wins over
 *  "@a" at the same offset); later starts of a shorter path still
 *  mint normally. */
export function chipsFromResolved(
  text: string,
  paths: readonly string[],
): MentionChip[] {
  const claimed = new Set<number>();
  const out: MentionChip[] = [];
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const bare = `@${path}`;
    let i = text.indexOf(bare);
    while (i !== -1) {
      const bounded = i === 0 || /\s/.test(text[i - 1]!);
      const end = bounded ? tokenEndAt(text, i, path) : null;
      if (end !== null && !claimed.has(i)) {
        claimed.add(i);
        out.push({ path, start: i, end });
      }
      i = text.indexOf(bare, i + 1);
    }
  }
  return out.sort((a, b) => a.start - b.start);
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
    // A stale span (programmatic draft replacement, undo) must never
    // draw a chip — or backspace-delete — over unrelated text.
    if (tokenEndAt(text, c.start, c.path) !== c.end) continue;
    out.push(c);
    at = c.end;
  }
  return out;
}

/** The chip's display label — the basename, widened to `dir/name` when
 *  another live chip shares the basename (frozen disambiguates
 *  duplicate file names; within a draft the same courtesy applies). */
export function chipLabel(
  path: string,
  all: readonly MentionChip[],
): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dupe = all.some(
    (c) =>
      c.path !== path &&
      c.path.slice(c.path.lastIndexOf("/") + 1) === name,
  );
  if (!dupe) return name;
  const parent = path.slice(0, Math.max(0, path.length - name.length - 1));
  const dir = parent.slice(parent.lastIndexOf("/") + 1);
  return dir ? `${dir}/${name}` : name;
}

/** Every chip token span as "@path " — used to clip a copy selection to
 *  whole chips is unnecessary in the port (the token IS the text), but
 *  tests and send use it to assert the wire form stays verbatim. */
export function chipText(chip: MentionChip): string {
  return `@${chip.path} `;
}
