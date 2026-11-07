// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Isolated persistence: a single JSON document under a configurable data
// root, written atomically, guarded by an exclusive lock file. Write
// ownership is explicit: a Store that failed open() — or never opened —
// never writes and never releases another instance's lock. Corrupt input is
// preserved aside only when the backup itself succeeds; a store written by
// a newer schema fails closed instead of being silently wiped.

import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  lstatSync,
  writeFileSync,
  existsSync,
  realpathSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { resolve, join, dirname, basename, relative, isAbsolute, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, type Settings, type StoreFile } from "../shared/types";
import {
  CorruptStoreError,
  NewerStoreError,
  checkThreadIntegrity,
  validateStoreFile,
  validateStoreHead,
  validateTurnSegment,
} from "./storeDoc";

export const STORE_FILENAME = "store.json";
export const LOCK_FILENAME = "store.lock";
export const TURNS_DIRNAME = "turns";

export interface StoreLoadResult {
  data: StoreFile;
  /** Present when a corrupt/incompatible file was preserved aside. */
  recoveredFrom?: string;
  /** F30: honest segment hydration report — a missing/corrupt turn file
   *  never silently rewrites itself. */
  segments?: { missing: string[]; skipped: string[]; migrated: boolean };
}

export function emptyStore(): StoreFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: [],
    threads: [],
    settings: defaultSettings(),
    ui: { selectedThreadId: null },
  };
}

export function defaultSettings(): Settings {
  return { theme: "breeze", language: "en", alwaysAllow: [] };
}

/** Canonicalize the data root and refuse anything that is not a real directory. */
export function resolveDataRoot(input: string): string {
  const abs = resolve(input);
  mkdirSync(abs, { recursive: true });
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink())
    throw new Error(`data root must not be a symlink: ${abs}`);
  if (!stat.isDirectory())
    throw new Error(`data root is not a directory: ${abs}`);
  return realpathSync(abs);
}

/**
 * Platform-correct containment check. `p` selects the path semantics
 * (posix or win32) so the rule can be exercised for both without a Windows
 * machine — this validates the *semantics*, not real Windows behaviour.
 * Inside means: resolved target equals the root or is a descendant. Only
 * a whole `..` path component escapes — names like `..notes` stay legal;
 * same-prefix siblings ("/root-evil", "C:\iso2"), different drive letters
 * and UNC paths are all rejected.
 */
export function isInsideRoot(
  root: string,
  candidate: string,
  p: typeof posix | typeof win32 = process.platform === "win32" ? win32 : posix,
): boolean {
  const base = p.resolve(root);
  const target = p.resolve(base, candidate);
  const rel = p.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

interface LockContent {
  pid?: unknown;
  at?: unknown;
  token?: unknown;
}

const GUARD_ATTEMPTS = 5;
const GUARD_BASE_DELAY_MS = 8;

export class StoreLock {
  private held = false;
  /** Unique per-instance marker written inside our own lock file. */
  private readonly token = randomUUID();
  /**
   * Critical-section directory: `store.lock.guard`. Every mutation of the
   * lock file — create, stale reclaim, release unlink — happens only while
   * this process holds the guard, so two contenders can never interleave
   * mid-operation. mkdir is atomic; whoever created it owns it.
   */
  private readonly guardPath: string;

  constructor(private readonly path: string) {
    this.guardPath = `${path}.guard`;
  }

  isHeld(): boolean {
    return this.held;
  }

  private pause(ms: number): void {
    // Synchronous bounded wait for guard contention — the critical section
    // is microseconds long, so a few short retries cover hand-off.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /**
   * Run `fn` inside the mkdir guard. Returns "busy" when another
   * participant keeps the guard beyond bounded retries — we never delete
   * a guard we did not create (KNOWN LIMITATION: a process crashing while
   * holding the guard leaves `store.lock.guard/` behind; that is the
   * documented manual-recovery case — refuse rather than steal).
   * Real fs errors propagate; contention alone returns "busy".
   */
  private withGuard<T>(fn: () => T): T | "busy" {
    for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt++) {
      let acquired = false;
      try {
        mkdirSync(this.guardPath);
        acquired = true;
        writeFileSync(
          join(this.guardPath, "owner"),
          JSON.stringify({ pid: process.pid, token: this.token, at: Date.now() }),
        );
      } catch (e) {
        if (acquired) {
          // The owner-file write failed: remove only the guard dir we just
          // created, then surface the real error.
          try {
            rmSync(this.guardPath, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
          throw e;
        }
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw e; // real fs error, not contention
        this.pause(GUARD_BASE_DELAY_MS + Math.floor(Math.random() * GUARD_BASE_DELAY_MS));
        continue;
      }
      try {
        return fn();
      } finally {
        try {
          rmSync(this.guardPath, { recursive: true, force: true });
        } catch {
          /* stale guard stays for manual recovery — never force-delete */
        }
      }
    }
    return "busy";
  }

  /**
   * Exclusive-create lock. All work runs inside the mkdir guard: a lock
   * whose recorded owner provably died (ESRCH) is unlinked and recreated
   * atomically with respect to every other protocol participant. EPERM,
   * malformed or unreadable locks are treated as live: we fail rather than
   * steal.
   */
  acquire(): boolean {
    const result = this.withGuard(() => {
      if (this.tryCreateLocked()) return true;
      const info = this.readLock();
      if (!info || this.ownerState(info.pid) !== "dead") return false;
      try {
        unlinkSync(this.path);
      } catch {
        return false;
      }
      return this.tryCreateLocked();
    });
    return result === true;
  }

  private tryCreateLocked(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e; // EPERM and friends are real errors, not contention
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token: this.token }));
    } catch (e) {
      // Under the guard this file is provably ours — remove it so it can
      // never masquerade as a foreign lock, then surface the real error.
      try {
        unlinkSync(this.path);
      } catch {
        /* best effort */
      }
      throw e;
    } finally {
      closeSync(fd);
    }
    this.held = true;
    return true;
  }

  private readLock(): LockContent | null {
    try {
      const v: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      return v as LockContent;
    } catch {
      return null; // cannot inspect: assume alive rather than steal
    }
  }

  /**
   * Only ESRCH proves the owner is gone. kill() succeeding or EPERM means
   * something lives there; invalid pids and unreadable files are unknown —
   * all conservative failures.
   */
  private ownerState(pid: unknown): "alive" | "dead" | "unknown" {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 4194304)
      return "unknown";
    if (pid === process.pid) return "alive";
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
  }

  /**
   * Release only inside the guard and only while the file still carries
   * OUR token — a lock that changed hands is not ours to delete. When the
   * guard is contended or release fails, retain ownership and let the
   * caller retry; a failed close must not disable subsequent saves.
   */
  release(): void {
    if (!this.held) return;
    const result = this.withGuard(() => {
      const current = this.readLock();
      if (current && current.token === this.token) {
        try {
          unlinkSync(this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return true;
    });
    if (result === "busy") throw new Error("store lock guard is busy; retry closing the store");
    this.held = false;
  }
}

/**
 * Resolve every component of `p` that physically exists (following links
 * at any depth) and append the not-yet-existing tail lexically. A dangling
 * final link resolves only as far as its parent, so callers must still
 * lstat the lexical path to refuse it.
 */
function deepestExistingRealpath(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p; // reached a filesystem root — give up
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * `candidate` must stay inside `root` both lexically AND after resolving
 * the deepest physically-existing path (intermediate symlink/junction
 * escapes rejected). A dangling symlink at the tail — whose target does
 * not exist yet — resolves nowhere and is refused outright. Scope note:
 * this guards the fixed files this Store writes inside its authorized
 * root; it is not a general anti-TOCTOU primitive against a malicious
 * same-uid process swapping directories concurrently.
 */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const realRoot = realpathSync(root);
  const lexical = resolve(realRoot, candidate);
  if (!isInsideRoot(realRoot, lexical)) return false;
  if (!isInsideRoot(realRoot, deepestExistingRealpath(lexical))) return false;
  try {
    if (lstatSync(lexical).isSymbolicLink()) return false;
  } catch {
    /* does not exist — fine */
  }
  return true;
}

export class Store {
  readonly root: string;
  readonly file: string;
  private lock: StoreLock;
  private data: StoreFile = emptyStore();
  private writeTimer: NodeJS.Timeout | null = null;
  /** F30: last-serialized segment bytes per thread — unchanged segments
   *  skip their write; a corrupt segment never gets one so it can't be
   *  silently replaced. */
  private segmentCache = new Map<string, string>();
  /** Segments that failed to load — never written or swept by us. */
  private readonly protectedSegments = new Set<string>();
  /** True only after open() fully succeeded — the only state that may write. */
  private opened = false;
  private closed = false;
  recoveredFrom?: string;
  /** F30: the last open()'s segment hydration report — missing/corrupt
   *  turn files are surfaced honestly, never silently rewritten. */
  segmentReport: { missing: string[]; skipped: string[]; migrated: boolean } | undefined;
  /** Set when the last flush failed; the lock and the original file survive. */
  lastWriteError: string | undefined;

  constructor(root: string) {
    this.root = resolveDataRoot(root);
    this.file = join(this.root, STORE_FILENAME);
    this.lock = new StoreLock(join(this.root, LOCK_FILENAME));
  }

  /**
   * Acquire the single-writer lock, then load the document. Anything that
   * fails after the lock is acquired releases exactly the lock we took.
   */
  open(): StoreLoadResult {
    if (this.opened || this.closed) throw new Error("store.open() may only be called once");
    if (!this.lock.acquire())
      throw new Error(
        `another instance holds the lock for ${this.root}; refusing to share the data root`,
      );
    try {
      if (!isPathInsideRoot(this.root, STORE_FILENAME))
        throw new Error(`refusing to read store through a link: ${this.file}`);
      if (!existsSync(this.file)) {
        this.data = emptyStore();
        this.opened = true;
        return { data: this.data };
      }
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const head = validateStoreHead(parsed);
      const segments = { missing: [] as string[], skipped: [] as string[], migrated: false };
      if (head.turnStorage === "segments") {
        // F30: hydrate each thread's history from its own turn file. A
        // missing or corrupt segment empties that thread's history — it
        // never stalls the library and never silently rewrites itself
        // (skipped ids are protected until a real turn writes again).
        for (const t of head.threads) {
          const seg = this.loadTurnSegment(t.id);
          if (seg === "missing") {
            t.messages = [];
            t.turn = null;
            segments.missing.push(t.id);
          } else if (seg === "skipped") {
            t.messages = [];
            t.turn = null;
            segments.skipped.push(t.id);
            this.protectedSegments.add(t.id);
          } else {
            t.messages = seg.messages;
            t.turn = seg.turn;
          }
        }
      } else {
        // Legacy monolith — inline fields hydrate; the next flush writes
        // the segmented form (frozen fromPrevious migration).
        for (const t of head.threads) {
          t.messages ??= [];
          t.turn ??= null;
        }
        segments.migrated = head.threads.some(
          (t) => (t.messages?.length ?? 0) > 0 || t.turn != null,
        );
      }
      this.data = head as StoreFile;
      this.segmentReport = segments;
      this.opened = true;
      return {
        data: this.data,
        ...(segments.missing.length || segments.skipped.length || segments.migrated
          ? { segments }
          : {}),
      };
    } catch (err) {
      if (err instanceof NewerStoreError) {
        this.lock.release();
        this.closed = true;
        throw err;
      }
      // Corrupt or unreadable document: preserve the original bytes, then
      // start clean. If the preservation itself fails we fail CLOSED — the
      // original file stays byte-identical and nothing is ever overwritten.
      if (err instanceof CorruptStoreError || err instanceof SyntaxError) {
        const backup = join(
          this.root,
          `store.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        );
        try {
          renameSync(this.file, backup);
        } catch (backupErr) {
          this.lock.release();
          this.closed = true;
          throw new Error(
            `corrupt store could not be preserved aside (${(backupErr as Error).message}); ` +
              `refusing to start clean and lose the evidence`,
          );
        }
        this.recoveredFrom = backup;
        this.data = emptyStore();
        this.opened = true;
        return { data: this.data, recoveredFrom: backup };
      }
      // Lock checks, symlink refusal, I/O failures: release our lock, stay closed.
      this.lock.release();
      this.closed = true;
      throw err;
    }
  }

  get state(): StoreFile {
    return this.data;
  }

  /** Whether this instance currently owns the file (lock held + opened). */
  get ownsWrites(): boolean {
    return this.opened && !this.closed && this.lock.isHeld();
  }

  /** Mutate in memory and schedule an atomic flush — no-ops once closed. */
  update(mutate: (data: StoreFile) => void): void {
    if (!this.ownsWrites) return;
    mutate(this.data);
    this.scheduleFlush();
  }

  flushNow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.ownsWrites) return;
    try {
      this.atomicWrite();
      this.lastWriteError = undefined;
    } catch (err) {
      // The lock stays held and the original file is untouched by a failed
      // rename — the caller decides whether to retry or surface it.
      this.lastWriteError = (err as Error).message;
      throw err;
    }
  }

  private scheduleFlush(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      // A late timer firing during/after close must never write.
      if (!this.ownsWrites) return;
      try {
        this.atomicWrite();
        this.lastWriteError = undefined;
      } catch (err) {
        this.lastWriteError = (err as Error).message;
        console.error(`[store] flush failed, lock and original file retained: ${this.lastWriteError}`);
      }
    }, 80);
  }

  /**
   * F30: read one turns/<id>.json — validate shape AND the thread-local
   * integrity rules; a bad segment is quarantined (renamed aside, bytes
   * preserved) and reported skipped so the library still opens with that
   * thread's history honestly empty rather than fabricated or fatal.
   */
  private loadTurnSegment(id: string):
    | { messages: StoreFile["threads"][number]["messages"]; turn: StoreFile["threads"][number]["turn"] }
    | "missing"
    | "skipped" {
    // Turn file names derive from thread ids — refuse anything that
    // could leave the directory (we minted UUIDs; a tampered head could
    // name a traversal).
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return "skipped";
    const rel = join(TURNS_DIRNAME, `${id}.json`);
    if (!isPathInsideRoot(this.root, rel)) return "skipped";
    const p = join(this.root, rel);
    if (!existsSync(p)) return "missing";
    try {
      const raw = readFileSync(p, "utf8");
      const seg = validateTurnSegment(JSON.parse(raw));
      if (seg.threadId !== id)
        throw new CorruptStoreError(`segment for ${seg.threadId} filed under ${id}`);
      if (seg.schemaVersion > SCHEMA_VERSION)
        throw new CorruptStoreError(
          `turn segment schema ${seg.schemaVersion} is newer than ${SCHEMA_VERSION}`,
        );
      checkThreadIntegrity({ id, messages: seg.messages, turn: seg.turn });
      this.segmentCache.set(id, raw);
      return { messages: seg.messages, turn: seg.turn };
    } catch {
      // Quarantine: rename aside so the original bytes survive — never
      // delete corrupt evidence, never let it poison the merge.
      try {
        renameSync(
          p,
          join(this.root, TURNS_DIRNAME,
            `${id}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
        );
      } catch {
        /* quarantine failed — the file stays; it's still skipped */
      }
      return "skipped";
    }
  }

  /**
   * F30 segmented flush (frozen ThreadSave semantics, bounded):
   *   1. write each DIRTY segment atomically (tmp + rename, cache-dirty)
   *   2. sweep orphaned segment files for threads that no longer exist
   *   3. write the head LAST — segments on disk never lag the head that
   *      references them; a crash mid-flush leaves either an old
   *      monolith head (hydrates inline, segments ignored) or an older
   *      head + newer segment, never a head pointing at absent data.
   * A failed segment write aborts before the head is touched.
   */
  private atomicWrite(): void {
    const turnsDir = join(this.root, TURNS_DIRNAME);
    mkdirSync(turnsDir, { recursive: true, mode: 0o700 });
    const live = new Set(this.data.threads.map((t) => t.id));
    for (const t of this.data.threads) {
      if (this.protectedSegments.has(t.id)) continue;
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(t.id)) continue;
      const body = JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          threadId: t.id,
          messages: t.messages,
          turn: t.turn,
        },
        null,
        2,
      );
      if (this.segmentCache.get(t.id) === body) continue;
      const tmp = join(turnsDir, `.seg-${process.pid}-${randomUUID()}.tmp`);
      try {
        writeFileSync(tmp, body);
        renameSync(tmp, join(turnsDir, `${t.id}.json`));
        this.segmentCache.set(t.id, body);
      } catch (err) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* best-effort */
        }
        throw err;
      }
    }
    // Orphan sweep — a deleted thread's history goes with it, same as
    // the monolith did. Quarantined files and protected ids are never
    // swept by us.
    try {
      for (const f of readdirSync(turnsDir)) {
        if (!f.endsWith(".json") || f.includes(".corrupt-")) continue;
        const id = f.slice(0, -".json".length);
        if (!live.has(id) && !this.protectedSegments.has(id)) {
          try {
            unlinkSync(join(turnsDir, f));
          } catch {
            /* leave a stubborn orphan for a later flush */
          }
        }
      }
    } catch {
      /* unreadable turns dir — segments already wrote; head still proceeds */
    }
    const head = {
      ...this.data,
      turnStorage: "segments" as const,
      threads: this.data.threads.map((t) => {
        const { messages: _messages, turn: _turn, ...rest } = t;
        return rest;
      }),
    };
    const tmp = join(this.root, `.store-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(head, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }

  /**
   * Final flush then release. A failed flush keeps the lock, the pending
   * in-memory state and write ownership, and THROWS — the caller retries
   * close() after the fault clears. Only after a successful write does the
   * store mark itself closed and let the lock go; a second call is a no-op.
   */
  close(): void {
    if (this.closed) return;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.opened && this.lock.isHeld()) {
      try {
        this.atomicWrite();
        this.lastWriteError = undefined;
      } catch (err) {
        this.lastWriteError = (err as Error).message;
        throw err;
      }
    }
    this.lock.release();
    this.closed = true;
  }
}
