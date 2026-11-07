// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// The controlled ephemeral Git metadata view. The original repository is
// NEVER mutated and its configuration is never trusted to run anything:
//
//  1. Probe: fixed-argv read-only builtins against the authorized dir
//     (cwd = grant, GIT_CEILING_DIRECTORIES = grant → repository discovery
//     can never escape above the authorized directory). rev-parse /
//     symbolic-ref / config-get only — these builtins never touch the
//     index, so no fsmonitor/filter hook can run here either.
//  2. Capture: copy index + HEAD + refs + packed-refs + bounded
//     non-executable info/{exclude,attributes} into a fresh view dir under
//     the app data root. Source bytes are hashed before AND after the
//     copy; any change mid-capture invalidates the refresh.
//  3. View config is written by us: allowlisted core.* normalization
//     values only. No filter/diff/merge/alias/credential/hook settings
//     exist inside the view — an attribute that names a filter therefore
//     finds no driver and can never execute.
//  4. Status/diff run with --git-dir=<view> --work-tree=<authorized root>
//     and the original object database as a READ-ONLY alternate via
//     GIT_ALTERNATE_OBJECT_DIRECTORIES. GIT_COMMON_DIR and a writable
//     GIT_OBJECT_DIRECTORY for the source objects are never used.
//
// Unsupported-by-design states (bare repo, non-files ref storage,
// split/sparse index, unknown object format) produce explicit results —
// never a misreported status. Paths containing ':' work: every argument
// travels as one argv element and alternates as env values.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,

  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { GitRunHandle } from "./gitExec";

// ---- bounds (task-mandated) -------------------------------------------------
export const COPY_CAP_BYTES = 32 * 1024 * 1024; // ONE total budget for every captured byte
export const STATUS_CAP_BYTES = 2 * 1024 * 1024; // per status/diff output
export const PATCH_CAP_LINES = 10_000; // DOM-row bound: newline-heavy patches
export const ENTRY_CAP = 5000;
export const GIT_TIMEOUT_MS = 10_000;
const REF_CAP_FILES = 512;
const REF_CAP_DEPTH = 8;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- porcelain v2 -z parsing ------------------------------------------------

export interface PorcelainHeader {
  oid: string | null;
  head: string | null; // "(detached)" while detached
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface PorcelainEntry {
  raw: string; // record kind: "1" | "2" | "u" | "?" | "!"
  xy: string;
  submodule: boolean;
  modeHead: string;
  modeIndex: string;
  modeWorktree: string;
  score: string | null; // e.g. "R100"
  path: string;
  origPath: string | null;
}

export interface PorcelainResult {
  header: PorcelainHeader;
  entries: PorcelainEntry[];
  truncated: boolean;
}

/** Structural parser for `git status --porcelain=v2 -z` output. Never
 *  splits filenames on whitespace — records are NUL-separated and only
 *  the fixed field prefix is space-delimited. */
export function parsePorcelainV2(text: string, cap = ENTRY_CAP): PorcelainResult {
  const header: PorcelainHeader = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  const entries: PorcelainEntry[] = [];
  let truncated = false;
  const fields = text.split("\0");
  const takeFields = (line: string, n: number): { head: string[]; rest: string } | null => {
    const parts = line.split(" ");
    if (parts.length < n) return null;
    return { head: parts.slice(0, n - 1), rest: parts.slice(n - 1).join(" ") };
  };
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]!;
    if (line === "") continue;
    if (line.startsWith("# ")) {
      const kv = line.slice(2);
      const sp = kv.indexOf(" ");
      const key = sp < 0 ? kv : kv.slice(0, sp);
      const val = sp < 0 ? "" : kv.slice(sp + 1);
      if (key === "branch.oid") header.oid = val;
      else if (key === "branch.head") header.head = val;
      else if (key === "branch.upstream") header.upstream = val;
      else if (key === "branch.ab") {
        for (const tok of val.split(" ")) {
          if (tok.startsWith("+")) header.ahead = Number.parseInt(tok.slice(1), 10) || 0;
          else if (tok.startsWith("-")) header.behind = Number.parseInt(tok.slice(1), 10) || 0;
        }
      }
      continue;
    }
    if (entries.length >= cap) {
      truncated = true;
      break;
    }
    const kind = line[0]!;
    if (kind === "1" || kind === "2") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>      → 7 fields + path
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> → 8 + path
      const need = kind === "1" ? 8 : 9;
      const t = takeFields(line.slice(2), need);
      if (!t) continue;
      const [xy, sub, mH, mI, mW] = t.head as [string, string, string, string, string];
      const score = kind === "2" ? (t.head[7] ?? null) : null; // <X><score> is the 8th field
      const path = t.rest;
      const entry: PorcelainEntry = {
        raw: kind,
        xy: xy!,
        submodule: sub!.startsWith("S"),
        modeHead: mH!,
        modeIndex: mI!,
        modeWorktree: mW!,
        score,
        path,
        origPath: null,
      };
      if (kind === "2") entry.origPath = fields[++i] ?? null; // NUL source field
      entries.push(entry);
    } else if (kind === "u") {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const t = takeFields(line.slice(2), 10);
      if (!t) continue;
      const [xy, sub] = t.head as [string, string, ...string[]];
      entries.push({
        raw: kind, xy: xy!, submodule: sub!.startsWith("S"),
        modeHead: "", modeIndex: "", modeWorktree: t.head[5] ?? "",
        score: null, path: t.rest, origPath: null,
      });
    } else if (kind === "?" || kind === "!") {
      entries.push({
        raw: kind, xy: kind === "?" ? "??" : "!!", submodule: false,
        modeHead: "", modeIndex: "", modeWorktree: "",
        score: null, path: line.slice(2), origPath: null,
      });
    }
    // Unknown record kinds are skipped — forward compatibility.
  }
  return { header, entries, truncated };
}

/** `git diff --numstat -z` per-path binary detection. A rename record is
 *  `a\td\t` then `\0<orig>\0<new>`; binary files report `-` for both
 *  counts. */
export function parseNumstatZ(text: string): { paths: string[]; binary: boolean }[] {
  const out: { paths: string[]; binary: boolean }[] = [];
  const toks = text.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok === "") continue;
    const m = tok.match(/^([-\d]+)\t([-\d]+)\t(.*)$/s);
    if (!m) continue;
    const binary = m[1] === "-" && m[2] === "-";
    const path = m[3]!;
    if (path === "") {
      // rename/copy pair: next two NUL fields are orig then new
      const orig = toks[++i] ?? "";
      const nu = toks[++i] ?? "";
      out.push({ paths: [orig, nu].filter(Boolean), binary });
    } else {
      out.push({ paths: [path], binary });
    }
  }
  return out;
}

// ---- index extension scan ---------------------------------------------------

export interface IndexInfo {
  version: number;
  /** Extension signatures found (e.g. "TREE","link","sdir","FSMN"). */
  extensions: string[];
}

const HASH_LEN: Record<string, number> = { sha1: 20, sha256: 32 };

/** Minimal index-format walk: validates DIRC + version and skips entries
 *  correctly for v2/v3/v4 to enumerate extension signatures. An index we
 *  cannot fully parse is reported, never trusted. */
export function parseIndexExtensions(buf: Buffer, objectFormat: string): IndexInfo {
  const hashLen = HASH_LEN[objectFormat];
  if (!hashLen) throw new Error(`unsupported object format ${objectFormat}`);
  if (buf.length < 12 + hashLen) throw new Error("index too small");
  if (buf.toString("ascii", 0, 4) !== "DIRC") throw new Error("bad index signature");
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) throw new Error(`unsupported index version ${version}`);
  const count = buf.readUInt32BE(8);
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off + 62 + (hashLen - 20) > buf.length) throw new Error("index truncated at entries");
    const flags = buf.readUInt16BE(off + 40 + hashLen);
    const extended = (flags & 0x4000) !== 0;
    const fixedLen = 40 + hashLen + 2 + (extended ? 2 : 0);
    if (off + fixedLen > buf.length) throw new Error("index truncated at entries");
    if (version === 4) {
      // prefix-compressed name: varint strip-count + NUL-terminated suffix
      let p = off + fixedLen;
      while (p < buf.length) {
        const b = buf[p++]!;
        if ((b & 0x80) === 0) break;
      }
      while (p < buf.length && buf[p] !== 0) p++;
      if (p >= buf.length) throw new Error("index v4 entry name unterminated");
      off = p + 1;
    } else {
      let nameLen = flags & 0x0fff;
      if (nameLen === 0x0fff) {
        let p = off + fixedLen;
        while (p < buf.length && buf[p] !== 0) p++;
        if (p >= buf.length) throw new Error("index entry name unterminated");
        nameLen = p - (off + fixedLen);
      }
      // entries are NUL-padded to a multiple of 8 (1–8 pad bytes)
      off += Math.floor((fixedLen + nameLen + 8) / 8) * 8;
    }
    if (off > buf.length - hashLen) throw new Error("index entries overran file");
  }
  const extensions: string[] = [];
  const end = buf.length - hashLen;
  while (off + 8 <= end) {
    const sig = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (off + 8 + len > end) {
      // Trailing EOIE/IEOT can sit at the very end — a malformed tail is
      // not trusted, but a zero-byte remainder is harmless.
      if (len === 0 && sig.trim().length === 0) break;
      throw new Error(`index extension ${JSON.stringify(sig)} overruns file`);
    }
    extensions.push(sig);
    off += 8 + len;
  }
  return { version, extensions };
}

// ---- probe + capture --------------------------------------------------------

export interface RepoProbe {
  gitDir: string;
  commonDir: string;
  worktree: string;
  indexPath: string;
  objectsDir: string;
  headPath: string;
  objectFormat: string;
  headRef: string | null; // refs/heads/… or null (detached)
  headOid: string | null; // resolved oid or null (unborn)
  /** Normalization values copied into the view config. */
  config: Record<string, string>;
  /** filter.* / diff.*.<drv>.{command,textconv,cachetextconv} in repo config:
   *  worktree comparisons must be refused rather than raw-compared. */
  helpersPresent: boolean;
}

const CONFIG_ALLOW =
  "^(core\\.(filemode|ignorecase|symlinks|autocrlf|eol|safecrlf)|extensions\\.(objectformat|refstorage|worktreeconfig)|index\\.(sparse|splitindex|version|skiphash)|filter\\.|diff\\.|merge\\.|alias\\.|credential\\.|core\\.(fsmonitor|hooksPath|sshCommand|askpass|pager|editor|gitProxy|attributesFile|excludesFile)|interactive\\.|include|http\\.|ssh\\.)";

const HELPER_RE = /^(filter\.|diff\.[^.]+\.(command|textconv|cachetextconv))/i;
const CONFIG_VALUE_KEYS = new Set([
  "core.filemode",
  "core.ignorecase",
  "core.symlinks",
  "core.autocrlf",
  "core.eol",
  "core.safecrlf",
]);

type RunOnce = (
  args: readonly string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number; maxBytes: number },
) => GitRunHandle;

export interface ProbeOutcome {
  kind: "ok" | "not-repository" | "unsupported" | "unavailable";
  probe?: RepoProbe;
  reason?: string;
}

/** Stage-1 probe: nothing here can execute a repo-configured helper —
 *  discovery is ceiling-bounded and only index-free builtins run. */
export async function probeRepo(
  grantDir: string,
  gitHome: string,
  run: RunOnce,
  envFor: (extra?: Record<string, string>) => Record<string, string>,
  opts?: { platform?: NodeJS.Platform },
): Promise<ProbeOutcome> {
  const platform = opts?.platform ?? process.platform;
  // GIT_CEILING_DIRECTORIES is a LIST — ';' on Windows, ':' on POSIX.
  // A grant path that cannot be expressed as one unambiguous list entry
  // must refuse, never silently widen the ceiling (a ';' would inject a
  // second, arbitrary ceiling directory into every probe/run env).
  if (platform === "win32" && grantDir.includes(";"))
    return { kind: "unavailable", reason: "grant-path-semicolon" };
  const env = envFor({ GIT_CEILING_DIRECTORIES: grantDir });
  const r1 = await run(
    [
      "--no-optional-locks",
      "--no-lazy-fetch",
      "-C",
      grantDir,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
      "--show-object-format",
      "--is-bare-repository",
      "--git-path",
      "index",
      "--git-path",
      "objects",
      "--git-path",
      "HEAD",
    ],
    { cwd: grantDir, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024 },
  ).done;
  if (r1.timedOut || r1.overflowed || r1.cancelled || r1.executorFailed)
    return {
      kind: "unavailable",
      reason: r1.executorFailed ? `executor-${r1.executorFailed}` : "probe-failed",
    };
  if (r1.code !== 0) {
    if (/not a git repository/i.test(r1.stderr)) return { kind: "not-repository" };
    if (/dubious ownership|unsafe repository/i.test(r1.stderr))
      return { kind: "unavailable", reason: "unsafe-ownership" };
    return { kind: "unavailable", reason: `rev-parse:${r1.code}` };
  }
  // Git for Windows emits CRLF line ends — never trim filenames, but the
  // fixed probe answer rows tolerate the platform newline.
  const lines = r1.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length !== 8) return { kind: "unavailable", reason: "probe-shape" };
  const [gitDir, commonDir, worktree, objectFormat, bare, indexPath, objectsDir, headPath] =
    lines as [string, string, string, string, string, string, string, string];
  if (bare !== "false") return { kind: "unsupported", reason: "bare" };
  if (!(objectFormat in HASH_LEN)) return { kind: "unsupported", reason: `object-format:${objectFormat}` };
  for (const p of [gitDir, commonDir, worktree, indexPath, objectsDir, headPath]) {
    if (!p || p.includes("\0") || p.includes("\n")) return { kind: "unavailable", reason: "probe-shape" };
  }
  // The worktree top must be exactly the authorized directory — never an
  // ancestor outside the grant. Ceiling alone cannot stop discovery when
  // the grant itself sits inside a foreign repo, so this check is the
  // authoritative boundary: a foreign worktree is reported exactly like a
  // directory that is not a repository at all. On Windows the comparison
  // is case- and separator-insensitive (C:\X == c:/x), still exact.
  const normTop = (p: string): string => {
    const r = resolve(p);
    return platform === "win32"
      ? r.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      : r;
  };
  if (normTop(worktree) !== normTop(grantDir)) return { kind: "not-repository" };

  // A probe invocation that died (timeout/overflow/cancel/executor
  // failure/signal/error stderr) can NEVER masquerade as
  // detached/unborn/clean — only a clean negative (nonzero code, empty
  // stderr) is a legitimate "no answer".
  const dead = (r: { timedOut: boolean; overflowed: boolean; cancelled: boolean; executorFailed?: string; code: number | null; stderr: string }): boolean =>
    r.timedOut || r.overflowed || r.cancelled || r.executorFailed !== undefined || r.code === null ||
    (r.code !== 0 && r.stderr.trim() !== "");

  // HEAD identity: symbolic-ref (branch ref) + verify (commit oid).
  const r2 = await run(
    ["--no-optional-locks", "--no-lazy-fetch", "-C", grantDir, "symbolic-ref", "-q", "HEAD"],
    { cwd: grantDir, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 16 * 1024 },
  ).done;
  if (dead(r2)) return { kind: "unavailable", reason: "probe-head-ref" };
  const headRef = r2.code === 0 ? r2.stdout.trim() || null : null; // detached → clean negative → null
  if (headRef !== null && !/^refs\/(?!.*(?:\.\.|\/\/|\0|[\\:]))[ -~]+$/.test(headRef))
    return { kind: "unavailable", reason: "probe-head-ref" };
  const r3 = await run(
    ["--no-optional-locks", "--no-lazy-fetch", "-C", grantDir, "rev-parse", "--verify", "-q", "HEAD"],
    { cwd: grantDir, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 16 * 1024 },
  ).done;
  if (dead(r3)) return { kind: "unavailable", reason: "probe-head-oid" };
  const headOid = r3.code === 0 ? r3.stdout.trim() || null : null;

  // Allowlisted config reads only: normalization values, ref-storage
  // format, index flags, and detection of configured executables.
  const r4 = await run(
    ["--no-optional-locks", "--no-lazy-fetch", "-C", grantDir, "config", "--get-regexp", CONFIG_ALLOW],
    { cwd: grantDir, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 256 * 1024 },
  ).done;
  if (dead(r4)) return { kind: "unavailable", reason: "probe-config" };
  const config: Record<string, string> = {};
  let helpersPresent = false;
  let unsupportedWhy: string | null = null;
  for (const line of r4.stdout.split(/\r?\n/)) {
    const sp = line.indexOf(" ");
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const val = sp < 0 ? "" : line.slice(sp + 1);
    if (!key) continue;
    if (CONFIG_VALUE_KEYS.has(key)) config[key] = val;
    if (HELPER_RE.test(key)) helpersPresent = true;
    if (key === "extensions.refstorage" && val && val !== "files")
      unsupportedWhy = `ref-storage:${val}`;
    if (key === "extensions.objectformat" && val && !(val in HASH_LEN))
      unsupportedWhy = `object-format:${val}`;
  }
  if (unsupportedWhy) return { kind: "unsupported", reason: unsupportedWhy };

  return {
    kind: "ok",
    probe: {
      gitDir: gitDir!,
      commonDir: commonDir!,
      worktree: worktree!,
      indexPath: indexPath!,
      objectsDir: objectsDir!,
      headPath: headPath!,
      objectFormat: objectFormat!,
      headRef,
      headOid,
      config,
      helpersPresent,
    },
  };
}

// ---- view construction ------------------------------------------------------

export interface ViewBuild {
  kind: "ok" | "unsupported" | "unavailable";
  viewDir?: string;
  reason?: string;
}

interface CopyItem {
  src: string;
  dst: string;
  required: boolean;
}

/** Identity pinned at capture time and re-verified after copying. */
export interface CapturedMeta {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

/** Bounded read of ONE regular file: lstat pins the path (symlinks and
 *  non-files rejected — never followed), open+fstat pins the inode, and
 *  at most min(size+1, cap+1) bytes are ever allocated — a tiny file
 *  never allocates the whole cap. Reading more than the pinned size is
 *  GROWTH, reported as instability rather than silently truncated, and
 *  anything over cap is oversized. An absent file throws ENOENT;
 *  anything else is a real failure, never a silent skip.
 *  Exported for the checkpoint service (P2G) — identical semantics. */
export function readBounded(path: string, cap: number): { buf: Buffer; meta: CapturedMeta } {
  const lst = lstatSync(path); // ENOENT → caller decides; anything else throws
  if (lst.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
  if (!lst.isFile()) throw new Error(`not a file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.ino !== lst.ino || fst.dev !== lst.dev)
      throw new Error(`replaced during open: ${path}`);
    if (fst.size > cap) throw new Error(`too large to capture: ${path}`);
    const buf = Buffer.alloc(Math.min(fst.size + 1, cap + 1));
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, null);
      if (n <= 0) break;
      off += n;
    }
    const out = buf.subarray(0, off);
    if (out.length > fst.size) throw new Error(`grew during read: ${path}`);
    const fst2 = fstatSync(fd);
    if (fst2.size !== fst.size || fst2.mtimeMs !== fst.mtimeMs || fst2.ino !== fst.ino)
      throw new Error(`changed during read: ${path}`);
    return {
      buf: out,
      meta: { dev: fst.dev, ino: fst.ino, mtimeMs: fst.mtimeMs, size: out.length },
    };
  } finally {
    closeSync(fd);
  }
}

const hash = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Per-worktree ref namespaces (all other refs live in commondir). */
const WORKTREE_REF_DIRS = ["bisect", "worktree", "rewritten"];

/** Best-effort ref copy, strictly bounded: lstat only (links never
 *  followed — a symlink cycle cannot recurse), depth-capped,
 *  file-count-capped, and every byte counts against the shared total
 *  capture budget. An existing destination is never overwritten — the
 *  fingerprinted HEAD-ref copy wins over a second traversal hit. */
function copyRefs(
  srcRefsDir: string,
  dstRefsDir: string,
  only: string[] | null,
  budget: { bytes: number; files: number },
  depth: number,
): void {
  if (depth > REF_CAP_DEPTH) return;
  let top: string[];
  try {
    top = readdirSync(srcRefsDir);
  } catch {
    return;
  }
  for (const name of top) {
    if (budget.files <= 0) return;
    if (only && !only.includes(name)) continue;
    const src = join(srcRefsDir, name);
    const dst = join(dstRefsDir, name);
    const st = lstatSync(src, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      copyRefs(src, dst, null, budget, depth + 1);
      continue;
    }
    if (!st.isFile() || st.size > 64 * 1024 || st.size > budget.bytes || existsSync(dst)) continue;
    const rec = readBounded(src, Math.min(64 * 1024, budget.bytes));
    budget.files--;
    budget.bytes -= rec.buf.length;
    mkdirSync(dstRefsDir, { recursive: true });
    writeFileSync(dst, rec.buf);
  }
}

/**
 * Build the controlled view for one refresh. `viewDir` must not already
 * exist. Returns the fingerprinted capture: the bytes hashed pre-copy are
 * re-read post-copy and any change invalidates the attempt.
 */
export async function buildView(
  probe: RepoProbe,
  viewDir: string,
  grantDir: string,
): Promise<ViewBuild> {
  // What we capture — index, HEAD, the HEAD ref's loose file (when it
  // exists), packed-refs and bounded info/{exclude,attributes}. ONE shared
  // byte budget covers every captured byte including refs/info copies.
  const items: CopyItem[] = [
    { src: probe.indexPath, dst: join(viewDir, "index"), required: false },
    { src: probe.headPath, dst: join(viewDir, "HEAD"), required: true },
  ];
  const looseRef =
    probe.headRef != null
      ? [join(probe.gitDir, probe.headRef), join(probe.commonDir, probe.headRef)].find((p) =>
          existsSync(p),
        )
      : undefined;
  if (probe.headRef && looseRef) {
    items.push({ src: looseRef, dst: join(viewDir, probe.headRef), required: false });
  }
  const packedRefs = join(probe.commonDir, "packed-refs");
  if (existsSync(packedRefs)) items.push({ src: packedRefs, dst: join(viewDir, "packed-refs"), required: false });

  let total = 0;
  const snapshot: { src: string; dst: string; bytes: Buffer; meta: CapturedMeta }[] = [];
  const absent: string[] = [];
  try {
    for (const it of items) {
      let rec: { buf: Buffer; meta: CapturedMeta };
      try {
        rec = readBounded(it.src, COPY_CAP_BYTES - total);
      } catch (e) {
        // Absent means ENOENT only — a readable-but-bad file (oversized,
        // symlink, replaced mid-open, permission) is an explicit failure,
        // never an implicit "empty" that would misreport status.
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && !it.required) {
          absent.push(it.src);
          continue;
        }
        return { kind: "unavailable", reason: `capture:${reason(e)}` };
      }
      total += rec.buf.length;
      if (total > COPY_CAP_BYTES) return { kind: "unsupported", reason: "capture-over-budget" };
      snapshot.push({ src: it.src, dst: it.dst, bytes: rec.buf, meta: rec.meta });
    }
  } catch (e) {
    return { kind: "unavailable", reason: `capture:${reason(e)}` };
  }

  const indexBytes = snapshot.find((s) => s.dst === join(viewDir, "index"))?.bytes;
  if (indexBytes) {
    try {
      const info = parseIndexExtensions(indexBytes, probe.objectFormat);
      if (info.extensions.includes("link"))
        return { kind: "unsupported", reason: "split-index" };
      if (info.extensions.includes("sdir"))
        return { kind: "unsupported", reason: "sparse-index" };
    } catch (e) {
      return { kind: "unavailable", reason: `index-parse:${reason(e)}` };
    }
  }
  // An absent index is a legitimate empty state (unborn/fresh repo).

  mkdirSync(join(viewDir, "hooks"), { recursive: true });
  // is_git_directory() requires HEAD + objects/ + refs/ — all three must
  // exist before Git accepts the view as a repository.
  mkdirSync(join(viewDir, "refs"), { recursive: true });
  mkdirSync(join(viewDir, "objects", "info"), { recursive: true });
  mkdirSync(join(viewDir, "objects", "pack"), { recursive: true });
  for (const s of snapshot) {
    const parent = join(s.dst, "..");
    mkdirSync(parent, { recursive: true });
    writeFileSync(s.dst, s.bytes);
    // Git's racy-index guard uses the index FILE's own mtime as the
    // baseline: entries are content-rechecked only when
    // indexMtime <= storedStatMtime. A fresh copy would carry a new mtime,
    // mark nothing racy and silently miss same-second edits, so the copied
    // index must keep the source's timestamp.
    if (s.dst === join(viewDir, "index")) {
      utimesSync(s.dst, new Date(s.meta.mtimeMs), new Date(s.meta.mtimeMs));
    }
  }

  // One shared budget: refs/info bytes count against the same 32 MiB the
  // index/HEAD copies already consumed.
  const sharedBudget = { bytes: COPY_CAP_BYTES - total, files: REF_CAP_FILES };
  for (const name of ["exclude", "attributes"]) {
    const src = join(probe.commonDir, "info", name);
    const st = lstatSync(src, { throwIfNoEntry: false });
    if (!st) continue;
    const rec = readBounded(src, sharedBudget.bytes);
    sharedBudget.bytes -= rec.buf.length;
    mkdirSync(join(viewDir, "info"), { recursive: true });
    writeFileSync(join(viewDir, "info", name), rec.buf);
  }

  copyRefs(join(probe.commonDir, "refs"), join(viewDir, "refs"), null, sharedBudget, 0);
  copyRefs(join(probe.gitDir, "refs"), join(viewDir, "refs"), WORKTREE_REF_DIRS, sharedBudget, 0);

  // Our controlled config — normalization values only, never a command.
  const cfgLines = [
    "[core]",
    // v1 is required whenever extensions.* (objectformat=sha256) exist.
    `\trepositoryformatversion = ${probe.objectFormat === "sha1" ? 0 : 1}`,
    "\tbare = false",
    "\tfsmonitor = false",
    "\tuntrackedcache = false",
    // hooksPath goes into a config file Git parses — forward slashes are
    // required on Windows ('\' is a config escape char), and a viewDir
    // containing '\\' could never exist on POSIX (app-generated name).
    `\thooksPath = ${viewDir.replace(/\\/g, "/")}/hooks`,
  ];
  for (const [k, v] of Object.entries(probe.config)) {
    const short = k.slice("core.".length);
    // Value hygiene: allowlist values are booleans / short enums only —
    // anything else is dropped rather than risk injecting a config body.
    if (/^[a-zA-Z0-9_-]+$/.test(v)) cfgLines.push(`\t${short} = ${v}`);
  }
  if (probe.objectFormat !== "sha1") {
    cfgLines.push("[extensions]", `\tobjectformat = ${probe.objectFormat}`);
  }
  cfgLines.push("[diff]", "\trenames = true", "[status]", "\trenames = true");
  writeFileSync(join(viewDir, "config"), cfgLines.join("\n") + "\n");

  // Post-capture integrity: a source that was created, deleted or
  // replaced inside the copy window invalidates the attempt — identity is
  // dev+ino+mtime+size plus a bounded re-read of the bytes, never just
  // a path existing.
  for (const s of snapshot) {
    const st = lstatSync(s.src, { throwIfNoEntry: false });
    if (
      !st ||
      st.isSymbolicLink() ||
      st.ino !== s.meta.ino ||
      st.dev !== s.meta.dev ||
      st.mtimeMs !== s.meta.mtimeMs ||
      st.size !== s.meta.size
    )
      return { kind: "unavailable", reason: "changed-during-capture" };
    let again: Buffer;
    try {
      again = readBounded(s.src, s.meta.size).buf;
    } catch (e) {
      return { kind: "unavailable", reason: `changed:${reason(e)}` };
    }
    if (again.length !== s.bytes.length || hash(again) !== hash(s.bytes))
      return { kind: "unavailable", reason: "changed-during-capture" };
  }
  for (const p of absent) {
    if (lstatSync(p, { throwIfNoEntry: false })) {
      return { kind: "unavailable", reason: "appeared-during-capture" };
    }
  }
  return { kind: "ok", viewDir };
}
