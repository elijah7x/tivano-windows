// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 / P1-26 @-mention suggestions — frozen ComposerView.refreshSuggestions
// word scan + FileIndex.search scoring with byte-level ASCII search,
// pre-built index caching, and a true pre-walk byte-presence filter.

const UTF8_ENCODER = new TextEncoder();

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

export interface MentionEntry {
  readonly path: string;
  readonly lowercased: string;
  readonly name: string;
  readonly lengthPenalty: number;
  readonly isASCII: boolean;
  readonly bytes: Uint8Array | null;
  readonly nameOffset: number;
  readonly mask0: number;
  readonly mask1: number;
  readonly mask2: number;
  readonly mask3: number;
}

export interface MentionIndex {
  readonly paths: readonly string[];
  readonly entries: readonly MentionEntry[];
}

interface AsciiSignature {
  readonly isASCII: boolean;
  readonly mask0: number;
  readonly mask1: number;
  readonly mask2: number;
  readonly mask3: number;
}

function scanAsciiSignature(text: string): AsciiSignature {
  let mask0 = 0;
  let mask1 = 0;
  let mask2 = 0;
  let mask3 = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 128) {
      return { isASCII: false, mask0: 0, mask1: 0, mask2: 0, mask3: 0 };
    }
    const bucket = c >> 5;
    const bit = 1 << (c & 31);
    if (bucket === 0) mask0 |= bit;
    else if (bucket === 1) mask1 |= bit;
    else if (bucket === 2) mask2 |= bit;
    else mask3 |= bit;
  }
  return { isASCII: true, mask0, mask1, mask2, mask3 };
}

function encodeAsciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

function hasAllMaskBits(
  a0: number,
  a1: number,
  a2: number,
  a3: number,
  n0: number,
  n1: number,
  n2: number,
  n3: number,
): boolean {
  return (
    (a0 & n0) === n0 &&
    (a1 & n1) === n1 &&
    (a2 & n2) === n2 &&
    (a3 & n3) === n3
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function bytesStartsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (haystack[i] !== needle[i]) return false;
  }
  return true;
}

function bytesIncludes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const nLen = needle.length;
  if (nLen === 0) return true;
  if (haystack.length < nLen) return false;
  const first = needle[0]!;
  const limit = haystack.length - nLen;
  let pos = haystack.indexOf(first, 0);
  while (pos !== -1 && pos <= limit) {
    let matched = true;
    for (let j = 1; j < nLen; j += 1) {
      if (haystack[pos + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
    pos = haystack.indexOf(first, pos + 1);
  }
  return false;
}

function asciiStrIncludes(haystack: string, needle: string): boolean {
  const nLen = needle.length;
  if (nLen === 0) return true;
  if (haystack.length < nLen) return false;
  const first = needle.charCodeAt(0);
  const limit = haystack.length - nLen;
  for (let i = 0; i <= limit; i += 1) {
    if (haystack.charCodeAt(i) !== first) continue;
    let matched = true;
    for (let j = 1; j < nLen; j += 1) {
      if (haystack.charCodeAt(i + j) !== needle.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Frozen String.containsBytes: contiguous byte search over UTF-8
 *  storage (fast ASCII charCode scan when both sides are pure ASCII). */
export function containsBytes(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  if (scanAsciiSignature(haystack).isASCII && scanAsciiSignature(needle).isASCII) {
    return asciiStrIncludes(haystack, needle);
  }
  return bytesIncludes(UTF8_ENCODER.encode(haystack), UTF8_ENCODER.encode(needle));
}

/** Frozen FileIndex.isSubsequence (ascii: true) — scans raw bytes with
 *  no UTF-16 grapheme/code-point iterator or per-character allocations. */
function isSubsequenceBytes(needle: Uint8Array, haystack: Uint8Array): boolean {
  const nLen = needle.length;
  if (nLen === 0) return true;
  if (haystack.length < nLen) return false;
  let ni = 0;
  let target = needle[0]!;
  for (let hi = 0; hi < haystack.length; hi += 1) {
    if (haystack[hi] === target) {
      ni += 1;
      if (ni >= nLen) return true;
      target = needle[ni]!;
    }
  }
  return false;
}

function isSubsequenceAsciiCodeUnits(needle: string, haystack: string): boolean {
  const nLen = needle.length;
  if (nLen === 0) return true;
  if (haystack.length < nLen) return false;
  let ni = 0;
  let target = needle.charCodeAt(0);
  for (let hi = 0; hi < haystack.length; hi += 1) {
    if (haystack.charCodeAt(hi) === target) {
      ni += 1;
      if (ni >= nLen) return true;
      target = needle.charCodeAt(ni);
    }
  }
  return false;
}

/** Frozen FileIndex.isSubsequence (ascii: false) — Unicode code-point
 *  fallback when either needle or haystack contains non-ASCII text. */
function isSubsequenceUnicode(needleChars: readonly string[], haystack: string): boolean {
  if (needleChars.length === 0) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needleChars[i]) {
      i += 1;
      if (i >= needleChars.length) return true;
    }
  }
  return i >= needleChars.length;
}

function insertBest(
  best: { path: string; score: number }[],
  path: string,
  scored: number,
  limit: number,
): void {
  if (best.length === limit && scored <= best[limit - 1]!.score) return;
  const index = best.findIndex((b) => b.score < scored);
  best.splice(index === -1 ? best.length : index, 0, { path, score: scored });
  if (best.length > limit) best.pop();
}

/** Pre-build lowercased strings, basenames, ASCII byte views, and
 *  128-bit byte-presence masks once per cached directory listing
 *  (matching frozen FileIndex.build). */
export function compileMentionIndex(paths: readonly string[]): MentionIndex {
  const entries: MentionEntry[] = paths.map((path) => {
    const lowercased = path.toLowerCase();
    const nameOffset = lowercased.lastIndexOf("/") + 1;
    const name = lowercased.slice(nameOffset);
    const sig = scanAsciiSignature(lowercased);
    return {
      path,
      lowercased,
      name,
      lengthPenalty: Math.min(path.length, 99),
      isASCII: sig.isASCII,
      bytes: sig.isASCII ? encodeAsciiBytes(lowercased) : null,
      nameOffset,
      mask0: sig.mask0,
      mask1: sig.mask1,
      mask2: sig.mask2,
      mask3: sig.mask3,
    };
  });
  return { paths, entries };
}

/** Score a pre-compiled MentionIndex. Candidates missing any ASCII byte
 *  of `needle` are rejected in O(1) via the pre-walk byte-presence
 *  bitmask before any substring or subsequence scan runs. */
export function scoreMentionIndex(
  index: MentionIndex,
  query: string,
  limit = 8,
): string[] {
  if (limit <= 0) return [];
  const needle = query.toLowerCase();
  if (needle === "") return index.paths.slice(0, limit);

  const needleSig = scanAsciiSignature(needle);
  const needleBytes = needleSig.isASCII ? encodeAsciiBytes(needle) : null;
  const needleChars = needleSig.isASCII ? null : Array.from(needle);
  const needleFirstChar = needleChars?.[0] ?? "";

  const best: { path: string; score: number }[] = [];
  for (const entry of index.entries) {
    if (entry.lowercased.length < needle.length) continue;

    let score: number;
    if (needleBytes !== null && entry.bytes !== null) {
      if (
        !hasAllMaskBits(
          entry.mask0,
          entry.mask1,
          entry.mask2,
          entry.mask3,
          needleSig.mask0,
          needleSig.mask1,
          needleSig.mask2,
          needleSig.mask3,
        )
      ) {
        continue;
      }
      const nameBytes = entry.bytes.subarray(entry.nameOffset);
      if (nameBytes.length === needleBytes.length && bytesEqual(nameBytes, needleBytes)) {
        score = 1000;
      } else if (bytesStartsWith(nameBytes, needleBytes)) {
        score = 800;
      } else if (bytesIncludes(nameBytes, needleBytes)) {
        score = 600;
      } else if (bytesIncludes(entry.bytes, needleBytes)) {
        score = 400;
      } else if (isSubsequenceBytes(needleBytes, entry.bytes)) {
        score = 100;
      } else {
        continue;
      }
    } else {
      if (needleFirstChar && !entry.lowercased.includes(needleFirstChar)) continue;
      if (entry.name === needle) score = 1000;
      else if (entry.name.startsWith(needle)) score = 800;
      else if (entry.name.includes(needle)) score = 600;
      else if (entry.lowercased.includes(needle)) score = 400;
      else if (isSubsequenceUnicode(needleChars ?? Array.from(needle), entry.lowercased)) {
        score = 100;
      } else {
        continue;
      }
    }

    insertBest(best, entry.path, score - entry.lengthPenalty, limit);
  }
  return best.map((b) => b.path);
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

  const needleSig = scanAsciiSignature(needle);
  const needleChars = needleSig.isASCII ? null : Array.from(needle);
  const needleFirstChar = needleChars?.[0] ?? "";

  const best: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lowercased = path.toLowerCase();
    if (lowercased.length < needle.length) continue;

    let score: number;
    const entrySig = needleSig.isASCII ? scanAsciiSignature(lowercased) : null;
    if (needleSig.isASCII && entrySig?.isASCII) {
      if (
        !hasAllMaskBits(
          entrySig.mask0,
          entrySig.mask1,
          entrySig.mask2,
          entrySig.mask3,
          needleSig.mask0,
          needleSig.mask1,
          needleSig.mask2,
          needleSig.mask3,
        )
      ) {
        continue;
      }
      const name = lowercased.slice(lowercased.lastIndexOf("/") + 1);
      if (name === needle) score = 1000;
      else if (name.startsWith(needle)) score = 800;
      else if (name.includes(needle)) score = 600;
      else if (lowercased.includes(needle)) score = 400;
      else if (isSubsequenceAsciiCodeUnits(needle, lowercased)) score = 100;
      else continue;
    } else {
      if (needleFirstChar && !lowercased.includes(needleFirstChar)) continue;
      const name = lowercased.slice(lowercased.lastIndexOf("/") + 1);
      if (name === needle) score = 1000;
      else if (name.startsWith(needle)) score = 800;
      else if (name.includes(needle)) score = 600;
      else if (lowercased.includes(needle)) score = 400;
      else if (isSubsequenceUnicode(needleChars ?? Array.from(needle), lowercased)) {
        score = 100;
      } else {
        continue;
      }
    }

    insertBest(best, path, score - Math.min(path.length, 99), limit);
  }
  return best.map((b) => b.path);
}
