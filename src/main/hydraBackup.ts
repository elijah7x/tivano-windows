// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-05 (frozen AppModel+HydraBackup.swift): owned-path safety, the
// deepest-common owned directory, the pre-brief copy of a non-Git
// head's files, and the diff report the lead gets with the head's
// report. Windows bound: `git diff --no-index` through the bounded
// runner stands in for `/usr/bin/diff -ruN` — same exit contract
// (0 same, 1 differs, >1 error); its `a/`+`b/` prefixes are the
// cosmetic difference, and a real empty file stands in for /dev/null.

import { promises as fsp, lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";

/** Frozen caps: 10 MB per file, 50 MB per backup, 80 KB per file's
 *  diff, 20,000 characters on the report's diff text. */
const PER_FILE_CAP = 10 * 1024 * 1024;
const TOTAL_CAP = 50 * 1024 * 1024;
const DIFF_CAP = 80_000;
const REPORT_CAP = 20_000;
const LISTING_LIMIT = 50;

/** One separator/case form for every compare — a `/`-separated
 *  canonical must not slip a `\`-joined root (and NTFS reads
 *  case-insensitively, so the safety check must too). */
const sepN = (s: string): string => s.replace(/\//g, "\\").toLowerCase();

/** `standardizingPath` on the entry: lexical normalize, trailing
 *  separators off. */
const standardize = (p: string): string =>
  normalize(p).replace(/[\\/]+$/, "") || normalize(p);

/** HydraPaths.canonical, bounded: normalized absolute with the EXISTING
 *  prefix realpath'd — the same walk routeHydraHead performs, so a
 *  junction into a protected folder resolves before the compare. NT
 *  namespace prefixes are stripped on both sides of the walk. */
export function hydraCanonical(path: string): string {
  let raw = resolve(path);
  if (/^\\\\\?\\UNC\\/i.test(raw)) raw = "\\\\" + raw.slice(8);
  else if (/^\\\\[?.]\\/i.test(raw)) raw = raw.slice(4);
  const tail: string[] = [];
  let cur = raw;
  let out = raw;
  for (;;) {
    try {
      out = tail.length
        ? join(realpathSync(cur), ...tail)
        : realpathSync(cur);
      break;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) break;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
  return out
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\[?.]\\/i, "")
    .replace(/[\\/]+$/, "");
}

/** Frozen `hydraOwnedPathIsSafe`: an owned path is a relative path that
 *  stays inside its base after both ends realpath — an absolute entry,
 *  `..` traversal or a link that resolves outside never reaches a head.
 *  The `.` entry resolves to the base itself and is safe. */
export function hydraOwnedPathIsSafe(path: string, base: string): boolean {
  if (isAbsolute(path)) return false;
  const relative = standardize(path);
  if (relative === ".." || relative.startsWith("..\\") || isAbsolute(relative))
    return false;
  const root = sepN(hydraCanonical(base));
  const resolved = sepN(hydraCanonical(join(base, relative)));
  return resolved === root || resolved.startsWith(root + "\\");
}

/** Frozen `hydraOwnedDirectory`: the deepest common EXISTING directory
 *  holding every owned file — each file's own chain climbs until it
 *  names a live folder, then the chains fold to their common prefix. */
export function hydraOwnedDirectory(
  files: string[],
  base: string,
): string | undefined {
  let common: string | undefined;
  for (const file of files) {
    let directory = hydraCanonical(join(base, file));
    for (;;) {
      try {
        if (lstatSync(directory).isDirectory()) break;
      } catch {
        /* missing — climb */
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (common === undefined) {
      common = directory;
      continue;
    }
    while (
      sepN(directory) !== sepN(common) &&
      !sepN(directory).startsWith(sepN(common) + "\\")
    ) {
      const parent = dirname(common);
      if (parent === common) break;
      common = parent;
    }
  }
  return common;
}

/** Frozen `v2OwnershipPath`, bounded: the dispatch-time ownership
 *  check — a standardized (LEXICAL, never realpath'd) resolution of
 *  `file` against `checkout` that must land on or under the checkout.
 *  `file` arrives already tilde-expanded and trimmed; empty → invalid.
 *  Distinct from `hydraOwnedPathIsSafe`, which realpaths: an owned link
 *  may claim a checkout path lexically while the backup-safe check
 *  still refuses what it resolves to. */
export function hydraOwnershipPath(
  file: string,
  checkout: string,
): string | undefined {
  if (file === "") return undefined;
  const root = normalize(checkout).replace(/[\\/]+$/, "");
  const path = normalize(resolve(root, file)).replace(/[\\/]+$/, "");
  const r = sepN(root);
  const p = sepN(path);
  return p === r || p.startsWith(r + "\\") ? path : undefined;
}

/** Frozen `hydraFileListing`: the first 50 paths of a report list,
 *  plus how many were left out. */
export function hydraFileListing(files: string[], limit = LISTING_LIMIT): string {
  let text = files.slice(0, limit).join(", ");
  const rest = files.length - Math.min(files.length, limit);
  if (rest > 0) text += `\nand ${rest} more`;
  return text;
}

export interface HydraOwnedCopyResult {
  copied: string[];
  /** Owned paths absent at backup time — recorded so a later-created
   *  file still diffs as added (frozen `new`). */
  added: string[];
  /** Unsafe, linked, oversized or unreadable paths — reported, never
   *  copied (frozen `skipped`). */
  skipped: string[];
}

/** Frozen `copyHydraOwnedFiles`: every owned path copied under
 *  `folder` preserving its relative shape — directories recurse,
 *  links and anything under/over the caps are skipped, missing files
 *  are recorded as new. The backup storage can never be copied into
 *  itself. */
export async function copyHydraOwnedFiles(
  files: string[],
  base: string,
  folder: string,
): Promise<HydraOwnedCopyResult> {
  const copied: string[] = [];
  const added: string[] = [];
  const skipped: string[] = [];
  const visited = new Set<string>();
  let total = 0;
  // The head's folder sits inside the backup root — compare against
  // the root so a nested owned folder can't swallow a sibling head's.
  const storage = sepN(hydraCanonical(dirname(folder)));

  const copy = async (path: string): Promise<void> => {
    const relative = standardize(path);
    const key = sepN(relative);
    if (visited.has(key)) return;
    visited.add(key);
    if (!hydraOwnedPathIsSafe(relative, base)) {
      skipped.push(relative);
      return;
    }
    const source = join(base, relative);
    const sourcePath = sepN(hydraCanonical(source));
    if (
      sourcePath === storage ||
      sourcePath.startsWith(storage + "\\") ||
      storage.startsWith(sourcePath + "\\")
    ) {
      skipped.push(relative);
      return;
    }
    const destination = join(folder, relative);
    let st;
    try {
      st = await fsp.lstat(source);
    } catch {
      // Absent = recorded new; unreadable-for-another-reason = skipped.
      try {
        await fsp.access(source);
        skipped.push(relative);
      } catch {
        added.push(relative);
      }
      return;
    }
    // Never follow links while recursively capturing an owned folder.
    if (st.isSymbolicLink()) {
      skipped.push(relative);
      return;
    }
    if (st.isDirectory()) {
      try {
        await fsp.mkdir(destination, { recursive: true });
        const children = (await fsp.readdir(source)).sort();
        for (const child of children) await copy(join(relative, child));
      } catch {
        skipped.push(relative);
      }
      return;
    }
    if (st.isFile()) {
      if (st.size > PER_FILE_CAP || total + st.size > TOTAL_CAP) {
        skipped.push(relative);
        return;
      }
      try {
        await fsp.mkdir(dirname(destination), { recursive: true });
        await fsp.copyFile(source, destination);
        total += st.size;
        copied.push(relative);
      } catch {
        skipped.push(relative);
      }
      return;
    }
    skipped.push(relative);
  };

  await fsp.mkdir(folder, { recursive: true }).catch(() => {});
  for (const file of files) await copy(file);
  return { copied, added, skipped };
}

/** The `git diff --no-index` run for one file pair — injected by the
 *  engine so the bounded Git runner stays its only spawn. `output`
 *  undefined + `failed` = the diff could not run (frozen `Shell.run`
 *  status > 1 / timeout → a "Could not diff" line, not a lost file). */
export type HydraDiffRunner = (
  before: string,
  after: string,
) => Promise<{
  output?: string | undefined;
  failed?: string | undefined;
  /** The run hit its output cap — the report marks the diff truncated
   *  (frozen `result.stdout.count >= outputLimit`). */
  hitCap?: boolean | undefined;
}>;

/** The fields `hydraBackupReport` reads — a plain shape so a test can
 *  drive it without a whole head record. */
export interface HydraBackupReportInfo {
  backupPath?: string | undefined;
  targetCheckout?: string | undefined;
  filesBase?: string | undefined;
  backupOwnedPaths?: string[] | undefined;
  backedUpFiles?: string[] | undefined;
  newFiles?: string[] | undefined;
  notBackedUpFiles?: string[] | undefined;
  /** The head's name — the footer's "%@ worked in place in %@". */
  personaName: string;
}

/** Frozen `hydraBackupReport`: the per-file diff of the head's owned
 *  files against the copies taken before it started — added/removed
 *  counts, the skipped list outside the diff budget, and the
 *  persona/checkout/backup footer the lead restores from. `emptyFile`
 *  stands in for /dev/null where a side does not exist. */
export async function hydraBackupReport(
  info: HydraBackupReportInfo,
  runDiff: HydraDiffRunner,
  emptyFile: string,
): Promise<string | undefined> {
  const backup = info.backupPath;
  const checkout = info.targetCheckout;
  if (backup === undefined || checkout === undefined) return undefined;
  const base = info.filesBase ?? checkout;
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let length = 0;
  const append = (text: string): void => {
    if (!text) return;
    const available = Math.max(0, REPORT_CAP - length);
    if (text.length > available) truncated = true;
    const piece = text.slice(0, available);
    if (piece) {
      parts.push(piece);
      length += piece.length;
    }
  };
  const backed = (info.backedUpFiles ?? []).map(standardize);
  const backedSet = new Set(backed.map(sepN));
  const skipped = (info.notBackedUpFiles ?? []).map(standardize);
  const skippedLower = skipped.map(sepN);
  const current = new Set<string>();
  const storage = sepN(hydraCanonical(dirname(backup)));
  const collect = async (raw: string): Promise<void> => {
    const path = standardize(raw);
    const resolved = sepN(hydraCanonical(join(base, path)));
    if (
      resolved === storage ||
      resolved.startsWith(storage + "\\") ||
      storage.startsWith(resolved + "\\")
    )
      return;
    if (!hydraOwnedPathIsSafe(path, base)) return;
    const pl = sepN(path);
    if (skippedLower.some((s) => pl === s || pl.startsWith(s + "\\"))) return;
    const url = join(base, path);
    let st;
    try {
      st = await fsp.lstat(url);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      const children = await fsp.readdir(url).catch(() => [] as string[]);
      for (const child of children) await collect(join(path, child));
    } else if (st.isFile()) {
      current.add(path);
    }
  };
  for (const root of info.backupOwnedPaths ?? info.newFiles ?? []) {
    await collect(root);
  }
  const paths = [...new Set([...backed, ...current])].sort();
  for (const path of paths) {
    if (!hydraOwnedPathIsSafe(path, base)) {
      append(`Cannot diff ${path}: it now resolves outside ${base}.`);
      continue;
    }
    const before = join(backup, path);
    const after = join(base, path);
    const existed = backedSet.has(sepN(path));
    // fileExists semantics — a dangling link counts as missing.
    const exists = await fsp
      .stat(after)
      .then(() => true)
      .catch(() => false);
    if (!existed && !exists) continue;
    if (existed && !exists) removed += 1;
    if (!existed && exists) added += 1;
    const result = await runDiff(
      existed ? before : emptyFile,
      exists ? after : emptyFile,
    );
    if (result.failed !== undefined || result.output === undefined) {
      append(`Could not diff ${path}: ${result.failed ?? "the diff did not finish"}`);
    } else {
      append(result.output);
      if (result.hitCap === true || result.output.length >= DIFF_CAP)
        truncated = true;
    }
  }
  if (truncated) parts.push("[Diff truncated at 20,000 characters.]");
  if (!parts.length)
    parts.push("No changes to the backed-up or newly listed files.");
  // Outside the diff budget, so a long diff never hides what has no backup.
  if (skipped.length) {
    parts.push(
      `Not backed up (size, unsupported path or copy failure): ${hydraFileListing(skipped)}`,
    );
  }
  parts.push(`Added: ${added}; removed: ${removed}.`);
  parts.push(
    `${info.personaName} worked in place in ${checkout}. The diff of its listed files against the copies taken before it started is above; the originals are at ${backup}. Restore any file from there if the change is wrong.`,
  );
  return parts.join("\n\n");
}
