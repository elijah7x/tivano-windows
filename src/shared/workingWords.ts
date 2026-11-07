// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// F03 — port of frozen WorkingIndicator.WorkingWords (WorkingIndicators.swift):
// a deterministic word that rotates every 7 seconds OF THE TURN, seeded by
// FNV-1a over the thread id so two threads rarely share a word sequence.

export const WORKING_WORDS = [
  "Thinking",
  "Pondering",
  "Scheming",
  "Brewing",
  "Weaving",
  "Tinkering",
  "Musing",
  "Composing",
  "Sifting",
  "Untangling",
  "Distilling",
  "Sketching",
  "Plotting",
  "Riffing",
  "Combobulating",
  "Percolating",
  "Marinating",
  "Noodling",
  "Puzzling",
  "Conjuring",
  "Creating",
  "Dancing",
] as const;

export const WORKING_WORD_ROTATE_SECONDS = 7;

/** Frozen `seed(_:)` — FNV-1a 64-bit over UTF-8 (folded to 32 bits for JS).
 *  `lo * 0x1b3` fits a double exactly, so its high word carries into `hi`. */
export function workingWordSeed(threadId: string): number {
  let lo = 0x84222325; // low 32 of 0xcbf29ce484222325
  let hi = 0xcbf29ce4; // high 32
  for (const b of new TextEncoder().encode(threadId)) {
    // `^=` yields a signed int; normalise before the double-precision terms.
    const loU = (lo ^ b) >>> 0;
    const carry = Math.floor((loU * 0x1b3) / 0x100000000);
    const nLo = Math.imul(loU, 0x000001b3);
    const nHi =
      (Math.imul(loU, 0x00000100) + Math.imul(hi, 0x000001b3) + carry) >>> 0;
    lo = nLo >>> 0;
    hi = nHi >>> 0;
  }
  return (hi ^ lo) >>> 0;
}

/** Frozen `word(seed:elapsedSeconds:)` — step = elapsed/7, index = seed+step. */
export function workingWordIndex(threadId: string, elapsedSeconds: number): number {
  const step = Math.floor(Math.max(0, elapsedSeconds) / WORKING_WORD_ROTATE_SECONDS);
  return (workingWordSeed(threadId) + step) % WORKING_WORDS.length;
}

/**
 * Frozen RelativeTime.duration — narrow units, max 2, fractional part
 * truncated: 42s → "42s"; 5m30s → "5m 30s"; 1h5m → "1h 5m".
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}
