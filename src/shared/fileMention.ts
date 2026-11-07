// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 @-mention suggestions — frozen ComposerView.refreshSuggestions
// word scan + FileIndex.search scoring, ported as pure functions.

/** The whitespace-bounded word ending at `caret`, when it begins with
 *  "@". Frozen bounds the scan on space/LF/TAB and accepts "@" at any
 *  position (unlike "/", which must open the draft — see slashQueryAt). */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0 || caret > text.length) return null;
  let start = caret;
  while (start > 0) {
    const c = text.charCodeAt(start - 1);
    if (c === 0x20 || c === 0x0a || c === 0x09) break;
    start -= 1;
  }
  const word = text.slice(start, caret);
  if (!word.startsWith("@")) return null;
  return { start, query: word.slice(1) };
}

interface ScoredEntry {
  path: string;
  lowercased: string;
  name: string;
  lengthPenalty: number;
}

/** Frozen isSubsequence — every needle character, in order, inside the
 *  haystack (the ASCII byte fast path collapses to the same semantics). */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i >= needle.length) return true;
  }
  return i >= needle.length;
}

/** Frozen FileIndex.search: name-exact 1000 / name-prefix 800 /
 *  name-contains 600 / path-contains 400 / subsequence 100, minus the
 *  path's length penalty; the best `limit` results, highest score first.
 *  `paths` are relative POSIX-style paths ("/" separators, matching git
 *  ls-files output). */
export function scoreMentionPaths(
  paths: readonly string[],
  query: string,
  limit = 8,
): string[] {
  if (limit <= 0) return [];
  const needle = query.toLowerCase();
  if (needle === "") return paths.slice(0, limit);

  const entries: ScoredEntry[] = paths.map((path) => {
    const lowercased = path.toLowerCase();
    return {
      path,
      lowercased,
      name: lowercased.slice(lowercased.lastIndexOf("/") + 1),
      lengthPenalty: Math.min(path.length, 99),
    };
  });

  const best: { path: string; score: number }[] = [];
  for (const entry of entries) {
    let score: number;
    if (entry.name === needle) score = 1000;
    else if (entry.name.startsWith(needle)) score = 800;
    else if (entry.name.includes(needle)) score = 600;
    else if (entry.lowercased.includes(needle)) score = 400;
    else if (isSubsequence(needle, entry.lowercased)) score = 100;
    else continue;
    const scored = score - entry.lengthPenalty;
    if (best.length === limit && scored <= best[limit - 1]!.score) continue;
    const index = best.findIndex((b) => b.score < scored);
    best.splice(index === -1 ? best.length : index, 0, {
      path: entry.path,
      score: scored,
    });
    if (best.length > limit) best.pop();
  }
  return best.map((b) => b.path);
}
