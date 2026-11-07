// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Durable, app-private checkpoint store. Checkpoints are INTERNAL data:
// raw worktree bytes live as content-addressed blobs under
// <dataRoot>/checkpoints/blobs/, and each checkpoint is a versioned
// manifest under manifests/ published by tmp-file + rename. NOTHING is
// ever written into the user's repository — no refs, objects, index or
// worktree mutation happens here or anywhere in the checkpoint path.
//
// Layout:
//   checkpoints/
//     blobs/<sha2>/<sha62>          — immutable, addressed by sha-256
//     manifests/<checkpointId>.json — atomic publication
//     tmp/cap-<uuid>/               — per-operation scratch we own
//
// Safety rules (task-mandated): manifests are strictly validated on load
// (version, types, path legality, hash shapes); a manifest can never
// redirect reads outside this root — blob names are derived from
// validated hex hashes only. A crashed/partial publish leaves only a
// *.tmp-* file which is never a valid checkpoint. Blob integrity is
// verified (size + sha-256) on every read. Unknown directories are
// never cleaned up; only our own cap-* scratch paths are removed.
//
// Confinement is PHYSICAL, not just lexical: the store root and its
// blobs/manifests/tmp directories are pinned by device+inode at open and
// revalidated before every operation — a symlinked or replaced directory
// or leaf refuses the operation instead of writing outside the root.
// Scratch paths handed to putBlob must come from this store's own
// newScratch(); an arbitrary caller string is rejected.
//
// Crash/restart guarantee (honest): blob and manifest payloads are
// fsync'd before their atomic rename and the containing directory is
// fsync'd best-effort, so a crash leaves either the previous state or a
// complete new entry; it can never leave a half-written manifest that
// validates. We do NOT claim stronger ordering across independent
// operations and there is no garbage collector — shared blobs are kept.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { readBounded } from "./gitView";

export class CheckpointStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CheckpointStoreError";
  }
}

export type CapturePhase = "before" | "after";

export interface ManifestIndexEntry {
  /** e.g. "100644" / "100755" / "120000" — recorded verbatim. */
  mode: string;
  /** Git object id (hex, repo's own object format). */
  oid: string;
  stage: number;
}

export type ManifestWorktree =
  | { kind: "file"; sha256: string; size: number; exec: boolean }
  | { kind: "symlink"; target: string }
  | { kind: "absent" };

export interface ManifestEntry {
  /** Canonical repo-relative path (validated, can never escape). */
  path: string;
  worktree: ManifestWorktree;
  /** Index stage records for this path — [] means untracked. Index and
   *  worktree absence/presence are recorded INDEPENDENTLY. */
  index: ManifestIndexEntry[];
}

export interface CheckpointManifest {
  version: 1;
  checkpointId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  phase: CapturePhase;
  createdAt: number;
  /** Exact grant identity bound at capture time. */
  grantDir: string;
  worktree: string;
  objectFormat: string;
  headOid: string | null;
  branch: string | null;
  pathCount: number;
  totalBytes: number;
  limitations: string[];
  entries: ManifestEntry[];
}

// ---- bounds (task-mandated) -------------------------------------------------
export const CKPT_MAX_PATHS = 5_000;
export const CKPT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const CKPT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MANIFEST_CAP_BYTES = 8 * 1024 * 1024; // 5000 entries fit far below this
const MANIFEST_LIST_CAP = 8_192;
const MAX_LINK_TARGET = 8_192;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MODE_RE = /^(100644|100755|120000|160000)$/;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Canonical repo-relative path validation. Rejects anything that could
 * escape the grant or touch Git control data: absolute paths, drive
 * letters, UNC, `..`/`.` components, NUL, backslash-absolute, empty or
 * `.git` components. Filenames may legally contain spaces, newlines,
 * unicode, colons (posix) and pathspec-looking prefixes — all kept.
 */
export function validateRepoPath(p: string): string | null {
  if (typeof p !== "string" || p === "" || p.length > 4096) return null;
  if (p.includes("\0") || p.includes("\r")) return null;
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  if (/^[A-Za-z]:/.test(p)) return null; // drive-relative or absolute
  if (p.endsWith("/")) return null;
  const parts = p.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
    if (part.toLowerCase() === ".git") return null;
  }
  return p;
}

/** Identity of the deepest ancestor that existed at resolve time. A
 *  deleted/replaced ancestor changes this and invalidates the capture. */
export interface AncestorPin {
  absPath: string;
  dev: number;
  ino: number;
}

export interface AncestorCheck {
  /** false = an existing ancestor is a symlink or non-directory —
   *  always refused. Missing ancestors are NOT unsafe (D). */
  ok: boolean;
  /** The deepest existing real-directory ancestor (at least the root
   *  when ok). Re-resolve and compare to detect a mid-capture swap. */
  deepest: AncestorPin | null;
}

/** Walk every parent component of `relPath` under `root`. A MISSING
 *  ancestor ends the chain and is safe (the leaf will report absent);
 *  an existing symlink or non-directory ancestor refuses. Never follows
 *  a symlink to decide anything — lstat only. The returned `deepest`
 *  pins the identity of the last existing real directory so a swapped
 *  or recreated parent is detected on re-resolution. */
export function resolveAncestors(
  root: string,
  relPath: string,
  lstat: (p: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    dev: number;
    ino: number;
  },
): AncestorCheck {
  let rst;
  try {
    rst = lstat(root);
  } catch {
    return { ok: false, deepest: null };
  }
  if (rst.isSymbolicLink() || !rst.isDirectory()) return { ok: false, deepest: null };
  let deepest: AncestorPin = { absPath: root, dev: rst.dev, ino: rst.ino };
  const parts = relPath.split("/");
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try {
      st = lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      return { ok: false, deepest }; // unexpected lstat failure — refuse
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, deepest };
    deepest = { absPath: cur, dev: st.dev, ino: st.ino };
  }
  return { ok: true, deepest };
}

// ---- strict manifest validation ---------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function vWorktree(x: unknown): ManifestWorktree | null {
  if (!isObj(x)) return null;
  if (x.kind === "file") {
    if (
      typeof x.sha256 !== "string" ||
      !SHA_RE.test(x.sha256) ||
      typeof x.size !== "number" ||
      !Number.isInteger(x.size) ||
      x.size < 0 ||
      x.size > CKPT_MAX_FILE_BYTES ||
      typeof x.exec !== "boolean"
    )
      return null;
    return { kind: "file", sha256: x.sha256, size: x.size, exec: x.exec };
  }
  if (x.kind === "symlink") {
    if (typeof x.target !== "string" || x.target.length > MAX_LINK_TARGET || x.target.includes("\0"))
      return null;
    return { kind: "symlink", target: x.target };
  }
  if (x.kind === "absent") return { kind: "absent" };
  return null;
}

function vIndexEntry(x: unknown): ManifestIndexEntry | null {
  if (!isObj(x)) return null;
  if (
    typeof x.mode !== "string" ||
    !MODE_RE.test(x.mode) ||
    typeof x.oid !== "string" ||
    !OID_RE.test(x.oid) ||
    typeof x.stage !== "number" ||
    !Number.isInteger(x.stage) ||
    x.stage < 0 ||
    x.stage > 3
  )
    return null;
  return { mode: x.mode, oid: x.oid, stage: x.stage };
}

/** Parse+validate a manifest document. Every field is typed and bounded;
 *  unknown versions, malformed ids, illegal paths or inconsistent sums
 *  reject the document — a manifest on disk is never trusted blindly. */
export function parseManifest(raw: unknown): CheckpointManifest | null {
  if (!isObj(raw)) return null;
  if (
    raw.version !== 1 ||
    typeof raw.checkpointId !== "string" ||
    !ID_RE.test(raw.checkpointId) ||
    typeof raw.projectId !== "string" ||
    raw.projectId === "" ||
    typeof raw.threadId !== "string" ||
    raw.threadId === "" ||
    typeof raw.turnId !== "string" ||
    raw.turnId === "" ||
    (raw.phase !== "before" && raw.phase !== "after") ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.grantDir !== "string" ||
    raw.grantDir === "" ||
    raw.grantDir.includes("\0") ||
    typeof raw.worktree !== "string" ||
    typeof raw.objectFormat !== "string" ||
    (raw.objectFormat !== "sha1" && raw.objectFormat !== "sha256") ||
    (raw.headOid !== null && (typeof raw.headOid !== "string" || !OID_RE.test(raw.headOid))) ||
    (raw.branch !== null && typeof raw.branch !== "string") ||
    typeof raw.pathCount !== "number" ||
    !Number.isInteger(raw.pathCount) ||
    raw.pathCount < 0 ||
    raw.pathCount > CKPT_MAX_PATHS ||
    typeof raw.totalBytes !== "number" ||
    !Number.isInteger(raw.totalBytes) ||
    raw.totalBytes < 0 ||
    raw.totalBytes > CKPT_MAX_TOTAL_BYTES ||
    !Array.isArray(raw.limitations) ||
    raw.limitations.some((l) => typeof l !== "string" || l.length > 200) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length !== raw.pathCount
  )
    return null;

  const oidLength = raw.objectFormat === "sha1" ? 40 : 64;
  if (typeof raw.headOid === "string" && raw.headOid.length !== oidLength) return null;
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const e of raw.entries) {
    if (!isObj(e)) return null;
    const path = typeof e.path === "string" ? validateRepoPath(e.path) : null;
    if (path === null || seen.has(path)) return null;
    seen.add(path);
    const worktree = vWorktree(e.worktree);
    if (!worktree) return null;
    if (!Array.isArray(e.index) || e.index.length > 4) return null;
    const index: ManifestIndexEntry[] = [];
    const stages = new Set<number>();
    for (const ie of e.index) {
      const v = vIndexEntry(ie);
      if (!v || v.oid.length !== oidLength || stages.has(v.stage)) return null;
      stages.add(v.stage);
      index.push(v);
    }
    if (stages.has(0) && stages.size > 1) return null;
    if (worktree.kind === "file") sum += worktree.size;
    entries.push({ path, worktree, index });
  }
  if (sum !== raw.totalBytes) return null;

  return {
    version: 1,
    checkpointId: raw.checkpointId,
    projectId: raw.projectId,
    threadId: raw.threadId,
    turnId: raw.turnId,
    phase: raw.phase,
    createdAt: raw.createdAt,
    grantDir: raw.grantDir,
    worktree: raw.worktree,
    objectFormat: raw.objectFormat,
    headOid: raw.headOid,
    branch: raw.branch,
    pathCount: raw.pathCount,
    totalBytes: raw.totalBytes,
    limitations: raw.limitations as string[],
    entries,
  };
}

// ---- durable write helpers ----------------------------------------------------

/** Write a complete payload and fsync it BEFORE the atomic rename — a
 *  crash can leave the old entry or a whole new one, never a torn file
 *  that would validate. */
function writeFileDurable(path: string, data: Buffer | string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("checkpoint write made no progress");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Best-effort directory fsync — the atomicity comes from rename, this
 *  only narrows the durability window where the fs supports it. */
function fsyncDir(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not every fs supports directory fsync — rename stays atomic */
  }
}

// ---- store ------------------------------------------------------------------

interface Pinned {
  dev: number;
  ino: number;
}

export class CheckpointStore {
  readonly root: string;
  private readonly blobsDir: string;
  private readonly manifestsDir: string;
  private readonly tmpDir: string;
  private pinned = new Map<string, Pinned>();
  /** Scratch directories this store issued — putBlob refuses anything
   *  else, so a caller string can never redirect blob writes. */
  private scratches = new Map<string, Pinned>();

  constructor(root: string) {
    this.root = root;
    this.blobsDir = join(root, "blobs");
    this.manifestsDir = join(root, "manifests");
    this.tmpDir = join(root, "tmp");
  }

  /** Create missing dirs (never through a symlink) and pin all four
   *  directory identities. A pre-existing symlink or non-directory is
   *  refused before any mkdir can follow it outside the root. */
  private pinDirectory(dir: string, create = false): void {
    let st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st && create) {
      mkdirSync(dir, { recursive: true });
      st = lstatSync(dir);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory())
      throw new CheckpointStoreError("store-confined", `unsafe checkpoint dir: ${dir}`);
    const old = this.pinned.get(dir);
    if (old && (old.dev !== st.dev || old.ino !== st.ino))
      throw new CheckpointStoreError("store-confined", `checkpoint dir replaced: ${dir}`);
    this.pinned.set(dir, { dev: st.dev, ino: st.ino });
  }

  private ensureDirs(): void {
    for (const dir of [this.root, this.blobsDir, this.manifestsDir, this.tmpDir])
      this.pinDirectory(dir, true);
    this.revalidate();
  }

  private revalidate(): void {
    // A freshly reopened store has no pins yet; reads must establish them.
    for (const dir of [this.root, this.blobsDir, this.manifestsDir, this.tmpDir])
      this.pinDirectory(dir);
    for (const dir of this.pinned.keys()) this.pinDirectory(dir);
  }

  private requireScratch(dir: string): void {
    const pin = this.scratches.get(dir);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!pin || !st || st.isSymbolicLink() || !st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino)
      throw new CheckpointStoreError("store-confined", "checkpoint scratch replaced");
  }

  /** Blob path derived ONLY from a validated hash — a manifest field can
   *  never redirect a read outside the blob root. */
  private blobPath(sha: string): string {
    if (!SHA_RE.test(sha))
      throw new CheckpointStoreError("bad-hash", `not a sha-256: ${sha.slice(0, 24)}`);
    return join(this.blobsDir, sha.slice(0, 2), sha.slice(2));
  }

  /** lstat a blob leaf: it must be a plain regular file. A symlinked or
   *  non-file leaf is refused, never followed, never repaired. */
  private blobLeaf(p: string): void {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isFile()))
      throw new CheckpointStoreError("store-confined", `unsafe blob leaf: ${p}`);
  }

  /**
   * Store bytes under their sha-256. Content addressing dedupes across
   * checkpoints and threads. `scratch` MUST be a directory this store
   * issued via newScratch() — anything else refuses. If a blob already
   * exists it is verified (size + hash); a corrupt regular file is
   * replaced through tmp+rename, a symlink/non-file leaf refuses.
   */
  putBlob(buf: Buffer, scratch: string): string {
    if (!this.scratches.has(scratch))
      throw new CheckpointStoreError("foreign-scratch", "scratch was not issued by this store");
    if (!Buffer.isBuffer(buf) || buf.length > CKPT_MAX_FILE_BYTES)
      throw new CheckpointStoreError("blob-oversize", "blob exceeds the per-file bound");
    this.ensureDirs();
    this.requireScratch(scratch);
    const sha = sha256(buf);
    const dst = this.blobPath(sha);
    const dir = join(this.blobsDir, sha.slice(0, 2));
    this.pinDirectory(dir, true);
    this.blobLeaf(dst);
    if (existsSync(dst)) {
      try {
        const rec = readBounded(dst, Math.min(CKPT_MAX_FILE_BYTES, buf.length + 1));
        if (rec.buf.length === buf.length && sha256(rec.buf) === sha) return sha; // intact — reuse
      } catch {
        /* unreadable/growing existing blob — fall through to atomic replace */
      }
    }
    const tmp = join(scratch, `blob-${randomUUID()}.part`);
    writeFileDurable(tmp, buf);
    renameSync(tmp, dst);
    fsyncDir(dir);
    return sha;
  }

  /** Bounded read + full integrity verification of a blob. */
  readBlob(sha: string, expectedSize: number): Buffer {
    this.revalidate();
    if (
      !Number.isInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > CKPT_MAX_FILE_BYTES
    )
      throw new CheckpointStoreError("blob-bad", `blob ${sha.slice(0, 12)} size out of bounds`);
    const p = this.blobPath(sha);
    this.pinDirectory(join(this.blobsDir, sha.slice(0, 2)));
    const st = lstatSync(p); // throws ENOENT — caller maps to unavailable
    if (st.isSymbolicLink() || !st.isFile())
      throw new CheckpointStoreError("store-confined", `unsafe blob leaf: ${p}`);
    let rec;
    try {
      rec = readBounded(p, expectedSize);
    } catch {
      throw new CheckpointStoreError("blob-bad", `blob ${sha.slice(0, 12)} unreadable or grew`);
    }
    if (rec.buf.length !== expectedSize)
      throw new CheckpointStoreError("blob-bad", `blob ${sha.slice(0, 12)} size mismatch`);
    if (sha256(rec.buf) !== sha)
      throw new CheckpointStoreError("blob-corrupt", `blob ${sha.slice(0, 12)} failed integrity`);
    return rec.buf;
  }

  /**
   * Atomically publish a manifest: the document is validated BEFORE
   * write, serialized under a size bound, fsync'd at a `*.tmp-*`
   * sibling, then renamed into place. A crash before rename leaves only
   * the tmp file — never a checkpoint. An existing destination is never
   * overwritten (same-uuid republish is refused, a foreign/symlink leaf
   * is confined).
   */
  publishManifest(m: CheckpointManifest): void {
    if (parseManifest(m) === null)
      throw new CheckpointStoreError("manifest-invalid", "refusing to publish invalid manifest");
    this.ensureDirs();
    const json = JSON.stringify(m);
    if (Buffer.byteLength(json, "utf8") > MANIFEST_CAP_BYTES)
      throw new CheckpointStoreError("manifest-oversize", "manifest exceeds the size bound");
    const dst = join(this.manifestsDir, `${m.checkpointId}.json`);
    const old = lstatSync(dst, { throwIfNoEntry: false });
    if (old) {
      if (old.isSymbolicLink() || !old.isFile())
        throw new CheckpointStoreError("store-confined", `unsafe manifest leaf: ${dst}`);
      throw new CheckpointStoreError("manifest-exists", `manifest ${m.checkpointId} already published`);
    }
    const tmp = join(this.manifestsDir, `${m.checkpointId}.json.tmp-${process.pid}-${randomUUID()}`);
    writeFileDurable(tmp, json);
    renameSync(tmp, dst);
    fsyncDir(this.manifestsDir);
  }

  /** Load + strictly validate one manifest. Missing/corrupt/foreign id
   *  or a symlinked leaf is an explicit error, never a partial document. */
  loadManifest(checkpointId: string): CheckpointManifest {
    this.revalidate();
    if (!ID_RE.test(checkpointId))
      throw new CheckpointStoreError("bad-id", "checkpoint id is not an opaque uuid");
    const p = join(this.manifestsDir, `${checkpointId}.json`);
    const st = lstatSync(p); // ENOENT propagates
    if (st.isSymbolicLink() || !st.isFile())
      throw new CheckpointStoreError("store-confined", `unsafe manifest leaf: ${p}`);
    let raw: string;
    try {
      raw = readBounded(p, MANIFEST_CAP_BYTES).buf.toString("utf8");
    } catch {
      throw new CheckpointStoreError("manifest-bad", "manifest unreadable or oversized");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CheckpointStoreError("manifest-invalid", "manifest is not valid JSON");
    }
    const doc = parseManifest(parsed);
    if (!doc)
      throw new CheckpointStoreError("manifest-invalid", "manifest failed validation");
    if (doc.checkpointId !== checkpointId)
      throw new CheckpointStoreError("manifest-mismatch", "manifest id mismatch");
    return doc;
  }

  /** Bounded listing of published checkpoint ids (tmp files never
   *  count). Iteration uses an open directory handle and stops at the
   *  cap — not a full readdir-then-slice, so a hostile directory cannot
   *  force an unbounded allocation. */
  listManifestIds(): string[] {
    if (this.pinned.size === 0 && !lstatSync(this.root, { throwIfNoEntry: false })) return [];
    this.revalidate();
    const out: string[] = [];
    let dir;
    try {
      dir = opendirSync(this.manifestsDir);
    } catch {
      return [];
    }
    try {
      let visited = 0;
      while (visited++ < MANIFEST_LIST_CAP) {
        const ent = dir.readSync();
        if (ent === null) break;
        const n = ent.name;
        if (!n.endsWith(".json")) continue;
        const id = n.slice(0, -5);
        if (ID_RE.test(id)) out.push(id);
      }
    } finally {
      dir.closeSync();
    }
    return out;
  }

  /** A fresh scratch dir owned by one operation. `cap-` prefix marks it
   *  as ours — cleanup only ever touches this prefix, never unknown
   *  directories. The returned path is registered: putBlob accepts it,
   *  a foreign string is refused. */
  newScratch(): string {
    this.ensureDirs();
    const d = join(this.tmpDir, `cap-${randomUUID()}`);
    mkdirSync(d);
    const st = lstatSync(d);
    this.scratches.set(d, { dev: st.dev, ino: st.ino });
    return d;
  }

  /** Discard a scratch dir this store issued. Only registered `cap-*`
   *  paths inside our own tmp dir are removed — an unknown path is a
   *  no-op, never a deletion primitive. */
  dropScratch(d: string | null): void {
    if (d === null || !this.scratches.has(d)) return;
    try {
      this.revalidate();
      this.requireScratch(d);
      rmSync(d, { recursive: true, force: true });
      this.scratches.delete(d);
    } catch {
      // A replacement at the old path is not ours to delete.
    }
  }
}
