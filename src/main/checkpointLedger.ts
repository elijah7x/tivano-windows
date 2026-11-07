// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Durable per-turn checkpoint ledger. One JSON document under the
// checkpoint root records every turn's capture outcome — capturing,
// complete (before+end proven), unavailable (an honest failure) or
// invalidated (authorization ended mid-flight). The record is the ONLY
// thing a preview request may name: checkpoint ids and touched paths are
// never accepted from a caller.
//
// Durability contract (P2L-REPAIR-01 R2):
//   · TRUSTED ANCHOR: the caller declares a canonical ancestor (the app
//     data root). Every path component between that anchor and the ledger
//     root must be a real directory — a symlink/junction ancestor
//     refuses. Platform aliases ABOVE the anchor are absorbed by
//     canonicalizing the anchor once (realpath) and pinning its dev/ino;
//     an anchor that redirects or is replaced refuses.
//   · LEAF IDENTITY: the ledger file is pinned by dev/ino — or by a
//     proven ABSENT state. A leaf that appears after absent was pinned,
//     or whose identity changed since the last verified boundary, is a
//     FOREIGN document: preserved and never overwritten. After our own
//     atomic rename the pin is updated to the newly published identity.
//   · Missing ledger ⇒ valid empty document. Unreadable / corrupt /
//     oversize / malformed-record / duplicate-identity / unknown-version
//     ⇒ preserved byte-for-byte, empty view, mutations refuse.
//   · Mutations build an immutable candidate from OWNED field copies,
//     validate the whole document against the same schema the loader
//     enforces, then persist (exclusive wx 0o600 tmp + complete-write
//     loop + fsync + atomic rename) and only then publish the cache.
//     A failed persist never mints phantom success; the ledger marks
//     itself unavailable rather than retrying a failing write loop.
//   · "capturing" records surviving a restart recover ONCE to
//     "unavailable: interrupted-by-restart" — never left in flight.
//   · Accessors hand out copies AND reserve owns its inputs — caller
//     arrays can never alias-mutate persisted state.
//
// Residual limits (honest): between the lstat/fstat identity check and
// the atomic rename a hostile CONCURRENT writer could still swap the
// leaf — POSIX rename then replaces whatever entry sits at the path.
// Node cannot close that race from userspace; the pin checks bound the
// window and any observed drift fails closed. Directory fsync is
// attempted after the rename commit point; filesystems that report it
// unsupported are tolerated, genuine failures are recorded as
// durability warnings — the commit is never pretended to be rolled back.

import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { validateRepoPath } from "./checkpointStore";

export const LEDGER_VERSION = 1;
export const LEDGER_MAX_RECORDS = 128;
export const LEDGER_MAX_TOUCHED = 1024;
const LEDGER_MAX_PATH_CHARS = 4096;
const LEDGER_MAX_REASON_CHARS = 512;
/** Whole-document bound, checked before reading and before writing. */
const LEDGER_FILE_MAX_BYTES = 8 * 1024 * 1024;

export class LedgerUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "LedgerUnavailableError";
    this.reason = reason;
  }
}

export type TurnCheckpointStatus =
  | "capturing" // before-capture in flight or captured, end pending
  | "complete" // before AND end manifests proven — previewable
  | "unavailable" // an honest capture failure — never previewable
  | "invalidated"; // authorization ended before the pair completed

export interface TurnCheckpoint {
  /** Ledger identity — the ONLY key a preview request may carry. */
  recordId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  /** Directory the grant resolved to at reservation time. */
  grantDir: string;
  createdAt: number;
  updatedAt: number;
  status: TurnCheckpointStatus;
  reason?: string;
  baseCheckpointId?: string;
  endCheckpointId?: string;
  /** Trusted structured edit attribution (bounded, validated). */
  touchedPaths: string[];
}

interface LedgerDoc {
  version: number;
  records: TurnCheckpoint[];
}

const STATUSES: readonly TurnCheckpointStatus[] = [
  "capturing",
  "complete",
  "unavailable",
  "invalidated",
];

/** Fields a patch may carry — identity fields are immutable forever. */
const PATCHABLE = new Set([
  "status",
  "reason",
  "baseCheckpointId",
  "endCheckpointId",
  "touchedPaths",
]);
const IDENTITY_FIELDS = new Set([
  "recordId",
  "projectId",
  "threadId",
  "turnId",
  "grantDir",
  "createdAt",
]);

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 120;
}

/** Strict structural validation — one bad record poisons the document. */
function validateRecord(raw: unknown): TurnCheckpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isId(r.recordId) || !isId(r.projectId) || !isId(r.threadId) || !isId(r.turnId))
    return null;
  if (typeof r.grantDir !== "string" || r.grantDir.length < 1 || r.grantDir.length > 4096)
    return null;
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt)) return null;
  if (!STATUSES.includes(r.status as TurnCheckpointStatus)) return null;
  if (r.reason !== undefined && (typeof r.reason !== "string" || r.reason.length > LEDGER_MAX_REASON_CHARS))
    return null;
  if (r.baseCheckpointId !== undefined && !isId(r.baseCheckpointId)) return null;
  if (r.endCheckpointId !== undefined && !isId(r.endCheckpointId)) return null;
  if (!Array.isArray(r.touchedPaths) || r.touchedPaths.length > LEDGER_MAX_TOUCHED)
    return null;
  const touchedPaths: string[] = [];
  for (const p of r.touchedPaths) {
    const v = typeof p === "string" ? validateRepoPath(p) : null;
    if (v === null) return null;
    touchedPaths.push(v);
  }
  // A complete record MUST carry both manifest ids; other states must
  // never claim a complete pair they do not have.
  const complete = r.baseCheckpointId !== undefined && r.endCheckpointId !== undefined;
  if ((r.status === "complete") !== complete) return null;
  return {
    recordId: r.recordId,
    projectId: r.projectId,
    threadId: r.threadId,
    turnId: r.turnId,
    grantDir: r.grantDir,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    status: r.status as TurnCheckpointStatus,
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    ...(r.baseCheckpointId ? { baseCheckpointId: r.baseCheckpointId } : {}),
    ...(r.endCheckpointId ? { endCheckpointId: r.endCheckpointId } : {}),
    touchedPaths,
  };
}

/** Whole-document invariants — identical rules on load and on write. */
function validateDoc(recs: TurnCheckpoint[]): void {
  if (recs.length > LEDGER_MAX_RECORDS)
    throw new LedgerUnavailableError("ledger-overbound", `${recs.length} records`);
  const ids = new Set<string>();
  const turns = new Set<string>();
  for (const r of recs) {
    if (!validateRecord(r))
      throw new LedgerUnavailableError("ledger-corrupt-record", String(r?.recordId));
    if (ids.has(r.recordId))
      throw new LedgerUnavailableError("ledger-duplicate-record-id", r.recordId);
    const turnKey = `${r.threadId}\0${r.turnId}`;
    if (turns.has(turnKey))
      throw new LedgerUnavailableError("ledger-duplicate-turn", turnKey);
    ids.add(r.recordId);
    turns.add(turnKey);
  }
}

const cloneRecord = (r: TurnCheckpoint): TurnCheckpoint => ({
  ...r,
  touchedPaths: [...r.touchedPaths],
});

/** Complete payload + fsync BEFORE the atomic rename; short writes are
 *  looped to completion — a torn tmp file can never validate. */
function writeFileDurable(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    const bytes = Buffer.from(data, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("ledger write made no progress");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).slice(0, 200);

/** Directory fsync outcome, honestly classified. */
type DirFsync = "ok" | "unsupported" | string;

function fsyncDir(path: string): DirFsync {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return "ok";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOTSUP" || code === "ENOTTY" || code === "EINVAL")
      return "unsupported";
    return `failed:${errText(e)}`;
  }
}

export class CheckpointLedger {
  private readonly dir: string;
  private readonly file: string;
  private readonly anchorLexical: string | null;
  private records: TurnCheckpoint[] | null = null;
  /** Set once the ledger refuses mutation — never cleared mid-session. */
  private unavailable: string | null = null;
  /** Physical identity of the checkpoint root, pinned on first proof. */
  private rootPin: { dev: number; ino: number } | null = null;
  /** Canonical anchor path + its pinned identity. */
  private anchorPin: { canon: string; dev: number; ino: number } | null = null;
  /** Leaf identity at the last verified boundary — or proven absence. */
  private filePin: { dev: number; ino: number } | "absent" | null = null;
  /** Post-commit durability warnings (bounded) — never hidden. */
  private durabilityWarnings: string[] = [];

  /**
   * `dir` is the checkpoint store root — the ledger lives beside
   * blobs/manifests. `trustedAnchor` is the caller-declared canonical
   * ancestor (the app data root): every component between it and `dir`
   * must be a real directory. Without an anchor the ledger refuses
   * every operation — ancestor confinement is never silently skipped.
   */
  constructor(dir: string, trustedAnchor: string) {
    this.dir = dir;
    this.file = join(dir, "ledger.v1.json");
    this.anchorLexical =
      typeof trustedAnchor === "string" && trustedAnchor.length > 0
        ? resolve(trustedAnchor)
        : null;
  }

  /** Canonicalize + pin the trusted anchor. Platform aliases inside the
   *  anchor's own path are absorbed here; an anchor that fails to
   *  resolve, is not a real directory, or is replaced mid-session is a
   *  hard refusal. */
  private proveAnchor(): string {
    if (this.anchorLexical === null)
      throw new LedgerUnavailableError("ledger-anchor-required");
    let canon: string;
    try {
      canon = realpathSync(this.anchorLexical);
    } catch (e) {
      throw new LedgerUnavailableError("ledger-anchor-unreadable", errText(e));
    }
    const st = lstatSync(canon, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory())
      throw new LedgerUnavailableError("ledger-anchor-unsafe", canon);
    const cur = { canon, dev: st.dev, ino: st.ino };
    if (
      this.anchorPin &&
      (this.anchorPin.canon !== cur.canon ||
        this.anchorPin.dev !== cur.dev ||
        this.anchorPin.ino !== cur.ino)
    )
      throw new LedgerUnavailableError("ledger-anchor-replaced", this.anchorLexical);
    this.anchorPin = cur;
    return canon;
  }

  /** Prove the ledger root lives DIRECTLY inside the trusted anchor
   *  chain: every intermediate lexical component must be a real
   *  directory (never a symlink), and the canonical root must equal
   *  anchor + the same components — any redirected destination refuses. */
  private proveRoot(anchorCanon: string, create: boolean): void {
    const rel = relative(this.anchorLexical!, resolve(this.dir));
    if (rel === ".." || isAbsolute(rel) || rel.split(sep).includes(".."))
      throw new LedgerUnavailableError("ledger-outside-anchor", this.dir);
    const comps = rel === "" ? [] : rel.split(sep);
    let cur = this.anchorLexical!;
    for (let i = 0; i + 1 < comps.length; i++) {
      cur = join(cur, comps[i]!);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st) continue; // missing intermediates are ours to create
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new LedgerUnavailableError("ledger-ancestor-unsafe", cur);
    }
    let st = lstatSync(this.dir, { throwIfNoEntry: false });
    if (!st && create) {
      mkdirSync(this.dir, { recursive: true });
      st = lstatSync(this.dir, { throwIfNoEntry: false });
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory())
      throw new LedgerUnavailableError("ledger-root-unsafe", this.dir);
    // The physical destination must equal the lexical expectation —
    // a redirected root is never authorized just because it resolves.
    const canon = realpathSync(this.dir);
    const expected = comps.length === 0 ? anchorCanon : join(anchorCanon, ...comps);
    if (canon !== expected)
      throw new LedgerUnavailableError(
        "ledger-root-redirected",
        `${canon} != ${expected}`,
      );
    if (this.rootPin && (this.rootPin.dev !== st.dev || this.rootPin.ino !== st.ino))
      throw new LedgerUnavailableError("ledger-root-replaced", this.dir);
    this.rootPin = { dev: st.dev, ino: st.ino };
  }

  /** lstat the leaf: absent → null; a symlink/non-file refuses. */
  private proveLeafType(): { dev: number; ino: number } | null {
    const st = lstatSync(this.file, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isFile())
      throw new LedgerUnavailableError("ledger-leaf-unsafe", this.file);
    return { dev: st.dev, ino: st.ino };
  }

  /** The leaf's identity must equal the pin — present where absent was
   *  proven, absent where present was pinned, or a different object than
   *  the one we wrote/read last all mean a FOREIGN document: preserve. */
  private proveLeafIdentity(): void {
    const leaf = this.proveLeafType();
    if (this.filePin === "absent" && leaf !== null)
      throw new LedgerUnavailableError("ledger-leaf-foreign", this.file);
    if (this.filePin !== "absent" && this.filePin !== null) {
      if (!leaf || leaf.dev !== this.filePin.dev || leaf.ino !== this.filePin.ino)
        throw new LedgerUnavailableError("ledger-leaf-replaced", this.file);
    }
  }

  private load(): TurnCheckpoint[] {
    if (this.records !== null) return this.records;
    const fresh: TurnCheckpoint[] = [];
    try {
      this.proveRoot(this.proveAnchor(), true);
      const leaf = this.proveLeafType();
      if (leaf === null) {
        this.filePin = "absent";
        this.records = fresh;
        return this.records; // missing file — a valid empty ledger
      }
      const fd = openSync(this.file, "r");
      let text: string;
      let opened: { dev: number; ino: number };
      try {
        const fst = fstatSync(fd);
        // Object identity: the opened file must BE the lstat'd leaf —
        // a swap between the two is detected, not followed.
        if (!fst.isFile() || fst.dev !== leaf.dev || fst.ino !== leaf.ino)
          throw new LedgerUnavailableError("ledger-leaf-swapped", this.file);
        if (fst.size > LEDGER_FILE_MAX_BYTES)
          throw new LedgerUnavailableError("ledger-oversize", `${fst.size} bytes`);
        text = readFileSync(fd, "utf8");
        opened = { dev: fst.dev, ino: fst.ino };
      } finally {
        closeSync(fd);
      }
      const doc = JSON.parse(text) as Partial<LedgerDoc>;
      if (doc?.version !== LEDGER_VERSION || !Array.isArray(doc.records))
        throw new LedgerUnavailableError(
          "ledger-unsupported",
          `version ${String(doc?.version)}`,
        );
      const parsed: TurnCheckpoint[] = [];
      for (const raw of doc.records) {
        const v = validateRecord(raw);
        if (!v) throw new LedgerUnavailableError("ledger-corrupt-record");
        parsed.push(v);
      }
      validateDoc(parsed);
      this.filePin = opened; // pin the object we actually read
      // Reopen recovery: a "capturing" record whose process died can never
      // complete — recover it to an honest unavailable ONCE. If that
      // single persist fails, the recovered view still serves reads but
      // every mutation refuses (no failing write loop).
      let dirty = false;
      for (const r of parsed) {
        if (r.status !== "capturing") continue;
        r.status = "unavailable";
        r.reason = "interrupted-by-restart";
        r.updatedAt = Date.now();
        dirty = true;
      }
      if (dirty) {
        try {
          this.persist(parsed);
        } catch (e) {
          this.unavailable = `ledger-recovery-unpersisted:${errText(e)}`;
        }
      }
      this.records = parsed;
    } catch (e) {
      // Unreadable/corrupt/foreign/unsafe — preserve bytes, EMPTY view
      // (never a partial adoption), refuse mutation. The original
      // document is never overwritten.
      this.records = [];
      this.unavailable =
        e instanceof LedgerUnavailableError ? e.message : `ledger-unreadable:${errText(e)}`;
    }
    return this.records;
  }

  /** Atomic durable publish of a candidate document: leaf identity is
   *  re-proven BEFORE the write and re-pinned AFTER the rename — a
   *  foreign replacement or unexpected creation is preserved, not
   *  overwritten. Throws on any failure; the caller decides what the
   *  failure means for the cache. */
  private persist(recs: TurnCheckpoint[]): void {
    const payload = JSON.stringify({ version: LEDGER_VERSION, records: recs } satisfies LedgerDoc);
    if (Buffer.byteLength(payload, "utf8") > LEDGER_FILE_MAX_BYTES)
      throw new LedgerUnavailableError("ledger-oversize", "document exceeds bound");
    this.proveRoot(this.proveAnchor(), true);
    if (this.filePin === null)
      throw new LedgerUnavailableError("ledger-internal", "leaf identity never established");
    this.proveLeafIdentity();
    const tmp = join(this.dir, `ledger.v1.json.tmp-${process.pid}-${randomUUID()}`);
    try {
      writeFileDurable(tmp, payload);
      renameSync(tmp, this.file); // commit point
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort — the tmp name is ours alone */
      }
      throw e;
    }
    // The rename committed — re-pin the identity we just published, then
    // report directory durability honestly (never a pretend rollback).
    const published = this.proveLeafType();
    if (published === null)
      throw new LedgerUnavailableError("ledger-leaf-vanished", this.file);
    this.filePin = published;
    const fsync = fsyncDir(this.dir);
    if (fsync !== "ok" && fsync !== "unsupported" && this.durabilityWarnings.length < 8)
      this.durabilityWarnings.push(fsync);
  }

  /** Build an immutable candidate, validate it against the load schema,
   *  persist it, publish it. A thrown candidate fn propagates untouched;
   *  a persist failure marks the ledger unavailable (cached records stay
   *  exactly as they were — no phantom success, no eviction). */
  private mutate(fn: (recs: TurnCheckpoint[]) => TurnCheckpoint[] | null): TurnCheckpoint[] | null {
    if (this.unavailable)
      throw new LedgerUnavailableError("ledger-unavailable", this.unavailable);
    this.load();
    if (this.unavailable)
      throw new LedgerUnavailableError("ledger-unavailable", this.unavailable);
    const candidate = this.records!.map(cloneRecord);
    const next = fn(candidate);
    if (next === null) return null;
    validateDoc(next); // a document our own reload would refuse is never written
    try {
      this.persist(next);
    } catch (e) {
      this.unavailable = `ledger-persist-failed:${errText(e)}`;
      throw e instanceof LedgerUnavailableError
        ? e
        : new LedgerUnavailableError("ledger-persist-failed", errText(e));
    }
    this.records = next;
    return next;
  }

  /** Honest availability + durability notes for diagnostics. */
  availability(): { ok: boolean; reason?: string; warnings: string[] } {
    this.load();
    return {
      ok: this.unavailable === null,
      ...(this.unavailable !== null ? { reason: this.unavailable } : {}),
      warnings: [...this.durabilityWarnings],
    };
  }

  all(): readonly TurnCheckpoint[] {
    return this.load().map(cloneRecord);
  }

  list(threadId: string): TurnCheckpoint[] {
    return this.load().filter((r) => r.threadId === threadId).map(cloneRecord);
  }

  get(recordId: string): TurnCheckpoint | null {
    const r = this.load().find((r) => r.recordId === recordId);
    return r ? cloneRecord(r) : null;
  }

  byTurn(threadId: string, turnId: string): TurnCheckpoint | null {
    const r = this.load().find((r) => r.threadId === threadId && r.turnId === turnId);
    return r ? cloneRecord(r) : null;
  }

  /** Reserve a per-turn record BEFORE any await. Inputs are OWNED
   *  (fields copied, paths bounded) — a caller mutating its argument can
   *  never alias-mutate persisted state. Duplicate turn identity or a
   *  full all-capturing ledger refuses — never ambiguous. */
  reserve(
    rec: Pick<TurnCheckpoint, "projectId" | "threadId" | "turnId" | "grantDir"> & {
      touchedPaths?: readonly string[];
    },
  ): TurnCheckpoint {
    const now = Date.now();
    const full: TurnCheckpoint = {
      projectId: rec.projectId,
      threadId: rec.threadId,
      turnId: rec.turnId,
      grantDir: rec.grantDir,
      touchedPaths: boundedTouched(rec.touchedPaths ?? []),
      recordId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "capturing",
    };
    if (validateRecord(full) === null)
      throw new LedgerUnavailableError("ledger-candidate-invalid", rec.turnId);
    this.mutate((recs) => {
      if (recs.some((r) => r.threadId === full.threadId && r.turnId === full.turnId))
        throw new LedgerUnavailableError("ledger-duplicate-turn", full.turnId);
      const next = [...recs, full];
      // Hard admission bound — evict non-capturing oldest first; an
      // all-in-flight ledger refuses rather than growing unbounded.
      while (next.length > LEDGER_MAX_RECORDS) {
        const idx = next.findIndex((r) => r.status !== "capturing");
        if (idx < 0)
          throw new LedgerUnavailableError("ledger-capacity", "all records in flight");
        next.splice(idx, 1);
      }
      return next;
    });
    return cloneRecord(full);
  }

  /** Persist a mutation to an existing record. Missing → null (no mint).
   *  Only whitelisted mutable fields may change; identity fields refuse.
   *  The cache keeps the pre-mutation record if persistence fails. */
  update(recordId: string, patch: Partial<TurnCheckpoint>): TurnCheckpoint | null {
    const keys = Object.keys(patch);
    for (const k of keys)
      if (IDENTITY_FIELDS.has(k))
        throw new LedgerUnavailableError("ledger-immutable-identity", k);
    for (const k of keys)
      if (!PATCHABLE.has(k) && !IDENTITY_FIELDS.has(k))
        throw new LedgerUnavailableError("ledger-unknown-field", k);
    const next = this.mutate((recs) => {
      const rec = recs.find((r) => r.recordId === recordId);
      if (!rec) return null;
      const p = patch as Record<string, unknown>;
      if (p.status !== undefined) rec.status = p.status as TurnCheckpointStatus;
      if ("reason" in p) {
        if (typeof p.reason === "string")
          rec.reason = p.reason.slice(0, LEDGER_MAX_REASON_CHARS);
        else delete rec.reason;
      }
      if ("baseCheckpointId" in p) {
        if (typeof p.baseCheckpointId === "string") rec.baseCheckpointId = p.baseCheckpointId;
        else delete rec.baseCheckpointId;
      }
      if ("endCheckpointId" in p) {
        if (typeof p.endCheckpointId === "string") rec.endCheckpointId = p.endCheckpointId;
        else delete rec.endCheckpointId;
      }
      if (p.touchedPaths !== undefined)
        rec.touchedPaths = boundedTouched(p.touchedPaths as string[]);
      // A record can never regain completeness fields it never earned.
      if (rec.status !== "complete") delete rec.endCheckpointId;
      rec.updatedAt = Date.now();
      return recs;
    });
    const rec = next?.find((r) => r.recordId === recordId);
    return rec ? cloneRecord(rec) : null;
  }

  /** Invalidate every non-terminal record matching `pred`. */
  invalidateWhere(pred: (r: TurnCheckpoint) => boolean, reason: string): void {
    this.mutate((recs) => {
      let dirty = false;
      for (const r of recs) {
        if (!pred(r)) continue;
        if (r.status === "complete" || r.status === "invalidated") continue;
        r.status = "invalidated";
        r.reason = reason.slice(0, LEDGER_MAX_REASON_CHARS);
        r.updatedAt = Date.now();
        dirty = true;
      }
      return dirty ? recs : null; // no-op writes stay unwritten
    });
  }

  /** Test/diagnostic only — drop the backing file's parsed cache and
   *  every pinned identity (next operation re-proves from scratch). */
  reloadForTest(): void {
    this.records = null;
    this.unavailable = null;
    this.rootPin = null;
    this.anchorPin = null;
    this.filePin = null;
    this.durabilityWarnings = [];
  }

  /** Owned-file removal used ONLY by tests that created the ledger root. */
  removeFileForTest(): void {
    try {
      const st = lstatSync(this.file, { throwIfNoEntry: false });
      if (st && !st.isSymbolicLink() && st.isFile()) rmSync(this.file);
    } catch {
      /* best effort */
    }
    this.reloadForTest();
  }
}

export function boundedTouched(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const v = validateRepoPath(p);
    if (v === null || v.length > LEDGER_MAX_PATH_CHARS || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= LEDGER_MAX_TOUCHED) break;
  }
  return out;
}

/** Re-exports used by callers that share the same file primitives. */
export const ledgerInternals = { writeFileSync, rmSync };
