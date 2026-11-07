// Read-only unified diff between two checkpoint blobs (P2G/A32 — F10
// per-turn diff). Pure function over byte strings: no worktree, index,
// or filesystem is touched — inputs are immutable content-addressed
// snapshots the caller already loaded.
//
// Line model: a "line" includes its trailing "\n"; the last line may
// lack one (rendered with "\ No newline at end of file"). Splitting on
// "\n" and dropping a trailing empty element keeps that exact.

const CONTEXT = 3;
// Above this combined mid-window the LCS table would be quadratic for
// no UI benefit — emit one honest replace hunk instead. Both outputs
// are correct unified diffs; the fallback is merely coarser.
const LCS_LIMIT = 3000;

function splitLines(s: string): { lines: string[]; lastOpen: boolean } {
  if (s.length === 0) return { lines: [], lastOpen: false };
  const parts = s.split("\n");
  const lastOpen = parts[parts.length - 1] !== "";
  if (parts[parts.length - 1] === "") parts.pop();
  return { lines: parts, lastOpen };
}

type Op = " " | "-" | "+";

/** Ops turning a into b, minimizing on the LCS when the window is
 *  small enough, else one delete-all/insert-all block. */
function ops(a: string[], b: string[]): Op[] {
  // Trim the common prefix/suffix — the LCS only ever sees the
  // differing windows.
  let i = 0;
  const lim = Math.min(a.length, b.length);
  while (i < lim && a[i] === b[i]) i++;
  let ea = a.length;
  let eb = b.length;
  while (ea > i && eb > i && a[ea - 1]! === b[eb - 1]!) {
    ea--;
    eb--;
  }
  const head: Op[] = new Array(i).fill(" ");
  const tail: Op[] = new Array(a.length - ea).fill(" ");
  const midA = a.slice(i, ea);
  const midB = b.slice(i, eb);
  const out: Op[] = [...head];
  if (midA.length === 0) {
    out.push(...new Array<Op>(midB.length).fill("+"));
  } else if (midB.length === 0) {
    out.push(...new Array<Op>(midA.length).fill("-"));
  } else if (midA.length + midB.length <= LCS_LIMIT) {
    // Standard LCS dynamic program over the differing windows only.
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    const W = m + 1;
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        dp[x * W + y] =
          midA[x] === midB[y]
            ? dp[(x + 1) * W + y + 1]! + 1
            : Math.max(dp[(x + 1) * W + y]!, dp[x * W + y + 1]!);
      }
    }
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      if (midA[x] === midB[y]) {
        out.push(" ");
        x++;
        y++;
      } else if (dp[(x + 1) * W + y]! >= dp[x * W + y + 1]!) {
        out.push("-");
        x++;
      } else {
        out.push("+");
        y++;
      }
    }
    while (x < n) {
      out.push("-");
      x++;
    }
    while (y < m) {
      out.push("+");
      y++;
    }
  } else {
    out.push(...new Array<Op>(midA.length).fill("-"));
    out.push(...new Array<Op>(midB.length).fill("+"));
  }
  out.push(...tail);
  return out;
}

/** Unified diff of `aText`→`bText` under `path` (empty string = no
 *  difference). Headers use git-style `a/`, `b/` and /dev/null for
 *  creation and deletion. */
export function unifiedDiff(
  aText: string | null,
  bText: string | null,
  path: string,
): string {
  if (aText === bText) return "";
  const a = splitLines(aText ?? "");
  const b = splitLines(bText ?? "");

  // EOL-only difference: identical line content but one side lacks the
  // trailing newline. The op model cannot express it (lines compare
  // equal) — emit the same replace pair git produces.
  if (
    a.lines.length === b.lines.length &&
    a.lastOpen !== b.lastOpen &&
    a.lines.every((l, i) => l === b.lines[i])
  ) {
    const n = a.lines.length;
    const out: string[] = [
      `--- ${aText === null ? "/dev/null" : `a/${path}`}`,
      `+++ ${bText === null ? "/dev/null" : `b/${path}`}`,
      `@@ -1,${n} +1,${n} @@`,
    ];
    for (let i = 0; i < n - 1; i++) out.push(` ${a.lines[i]}`);
    out.push(`-${a.lines[n - 1]}`);
    if (!a.lastOpen) out.push("\\ No newline at end of file");
    out.push(`+${b.lines[n - 1]}`);
    if (!b.lastOpen) out.push("\\ No newline at end of file");
    return out.join("\n") + "\n";
  }

  const seq = ops(a.lines, b.lines);

  // Group changed runs into hunks with CONTEXT lines of surroundings.
  const changed: number[] = [];
  seq.forEach((o, idx) => {
    if (o !== " ") changed.push(idx);
  });
  if (changed.length === 0) return "";
  interface Hunk {
    start: number;
    end: number;
  }
  const hunks: Hunk[] = [];
  for (const c of changed) {
    const lo = Math.max(0, c - CONTEXT);
    const hi = Math.min(seq.length, c + CONTEXT + 1);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last.end) last.end = Math.max(last.end, hi);
    else hunks.push({ start: lo, end: hi });
  }

  const out: string[] = [];
  out.push(`--- ${aText === null ? "/dev/null" : `a/${path}`}`);
  out.push(`+++ ${bText === null ? "/dev/null" : `b/${path}`}`);
  let ai = 0; // index into a.lines
  let bi = 0; // index into b.lines
  // Walk once to map op positions onto source line numbers.
  const opA: number[] = new Array(seq.length);
  const opB: number[] = new Array(seq.length);
  for (let k = 0; k < seq.length; k++) {
    opA[k] = ai;
    opB[k] = bi;
    if (seq[k] !== "+") ai++;
    if (seq[k] !== "-") bi++;
  }
  for (const h of hunks) {
    const aStart = opA[h.start]!;
    const aEnd = h.end < seq.length ? opA[h.end]! : a.lines.length;
    const bStart = opB[h.start]!;
    const bEnd = h.end < seq.length ? opB[h.end]! : b.lines.length;
    out.push(`@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bEnd - bStart} @@`);
    for (let k = h.start; k < h.end; k++) {
      const o = seq[k]!;
      const text = o === "+" ? b.lines[opB[k]!]! : a.lines[opA[k]!]!;
      out.push(`${o}${text}`);
      const lastLine = o === "+" ? opB[k] === b.lines.length - 1 : opA[k] === a.lines.length - 1;
      const open = o === "+" ? b.lastOpen : a.lastOpen;
      if (lastLine && open) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

/** Cheap binary sniff — a NUL byte anywhere means no text diff. */
export function looksBinary(buf: Buffer): boolean {
  const lim = Math.min(buf.length, 8192);
  for (let i = 0; i < lim; i++) if (buf[i] === 0) return true;
  return false;
}
