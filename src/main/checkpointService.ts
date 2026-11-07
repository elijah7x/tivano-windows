// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Durable checkpoint capture + conservative undo PREVIEW (P2G).
//
// A checkpoint is an app-private content-addressed snapshot of every
// tracked + nonignored-untracked path's RAW worktree bytes plus its index
// identity. Nothing is written into the user's repository — no refs,
// objects, index entries or worktree bytes are ever created, changed or
// deleted by this service. Repository listing goes through the same
// controlled ephemeral metadata view as the Git panel (gitView.ts):
// repository config can never trigger filters, hooks, fsmonitor or any
// external command. Captured bytes are the raw file content — configured
// content filters are NEVER run to normalize them; where that makes
// exact index comparison impossible the limitation is recorded.
//
// Preview is NON-MUTATING: it compares the current worktree AND index
// state of each supplied touched path with the recorded end checkpoint,
// and only an exact match may be proposed for restoration to the base
// state. A preview is data for a later, separately-authorized apply —
// it is not an authorization and takes no lock on the files.
//
// OMISSION IS NOT ABSENCE (R1): a path missing from a manifest is
// UNKNOWN — it may never have been listed (ignored file, filtered out,
// listing race). Only a manifest entry that explicitly records
// worktree.kind "absent" while carrying index stage evidence proves the
// path did not exist at capture time. Destructive proposals (remove)
// require that explicit evidence; anything ambiguous is kept with a
// reason. This deliberately narrows preview coverage rather than
// risking a wrong deletion.
//
// Instantiated by main since P2L: index.ts wires the SAME resolved Git
// bootstrap as GitService — on Windows the attested Job --run runner or
// a pinned unavailableReason, never a direct git spawn. The per-turn
// lifecycle lives in checkpointTurns.ts (before/end capture + ledger).

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ChatThread, CheckpointDiffView, Project } from "../shared/types";
import { looksBinary, unifiedDiff } from "../shared/checkpointDiff";
import { EngineError } from "./engine";
import type { GitRunHandle, GitRunResult } from "./gitExec";
import { gitChildEnv, makeGitRunner, type GitRunner, type RunGit } from "./gitExec";
import {
  buildView,
  GIT_TIMEOUT_MS,
  probeRepo,
  readBounded,
  type RepoProbe,
} from "./gitView";
import {
  CheckpointStore,
  CKPT_MAX_FILE_BYTES,
  CKPT_MAX_PATHS,
  CKPT_MAX_TOTAL_BYTES,
  CheckpointStoreError,
  resolveAncestors,
  validateRepoPath,
  type AncestorPin,
  type CapturePhase,
  type CheckpointManifest,
  type ManifestEntry,
  type ManifestIndexEntry,
  type ManifestWorktree,
} from "./checkpointStore";
import type { ProjectRuntimePaths } from "./projectRuntimePaths";
import type { WorkspaceGrant } from "./provider";

// ---- bounds (task-mandated) ---------------------------------------------------
export const CKPT_MAX_PER_PROJECT = 1;
export const CKPT_MAX_GLOBAL = 2;
/** Diff payload bound — same 256KB convention as gitService diffs. */
const DIFF_MAX_BYTES = 256 * 1024;
export const CKPT_QUEUE_CAP = 16;
const OP_DEADLINE_MS = 30_000;
const DISPOSE_WAIT_MS = 6_000;
const CAPTURE_RETRIES = 2;
const INDEX_META_CAP = 32 * 1024 * 1024; // view/control budget
const TOUCHED_CAP = 1_024;
const YIELD_EVERY = 1; // bounded file-batch yield — the main thread must
// not be blocked for a whole 128MiB / 5000-path loop (R1-B)

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- results ------------------------------------------------------------------

export interface CheckpointResult {
  checkpointId?: string;
  kind: "captured" | "unavailable" | "unsupported";
  reason?: string;
  pathCount?: number;
  totalBytes?: number;
}

export interface PreviewFingerprint {
  worktree: string;
  index: string;
}

export type PreviewAction = "restore" | "remove" | "keep" | "noop";

export interface PreviewEntry {
  path: string;
  action: PreviewAction;
  /** Why a path is kept / refused — stable code for a future UI. */
  reason?: string;
  /** Fingerprints the current state was proven equal to at preview time.
   *  A future apply MUST re-prove these after the user sees the preview —
   *  this is a precondition record, not a lock. */
  matched?: PreviewFingerprint;
}

export interface PreviewResult {
  previewId?: string;
  kind: "ready" | "unavailable";
  baseCheckpointId: string;
  endCheckpointId: string;
  touchedPaths: string[];
  entries: PreviewEntry[];
  limitations: string[];
  reason?: string;
}

export interface RestoreEntryResult {
  path: string;
  /** What the apply actually did — never what it intended. */
  action: "restored" | "removed" | "kept" | "noop";
  reason?: string;
}

export interface RestoreResult {
  kind: "applied" | "unavailable";
  entries: RestoreEntryResult[];
  reason?: string;
}

// ---- op tracking --------------------------------------------------------------

interface Op {
  projectId: string;
  threadId: string;
  grantDir: string;
  cancelled: boolean;
  deadline: number;
  children: Set<GitRunHandle>;
  scratch: string | null;
  /** Ownership predicate re-checked at every gate — a deleted thread or
   *  evicted turn can never adopt a pending capture/preview (R1-B). */
  owned: () => boolean;
  settled: Promise<void>;
  settle: () => void;
}

interface QueueEntry {
  op: Op;
  resolve: () => void;
  reject: (e: Error) => void;
}

export interface CheckpointDeps {
  paths: ProjectRuntimePaths | null;
  projects: () => readonly Project[];
  /** Ownership lookup — capture/preview may only name a thread/turn that
   *  really belongs to the project. */
  threads: () => readonly ChatThread[];
  mutable: () => boolean;
  dataRoot: string;
  gitExe?: string;
  platform?: NodeJS.Platform;
  runner?: GitRunner;
  /** Pinned at bootstrap like GitService: any containment/resolution gap
   *  reports this honest reason instead of attempting a capture. */
  unavailableReason?: string;
  disposeTimeoutMs?: number;
}

export class CheckpointService {
  private readonly store: CheckpointStore;
  private readonly gitExe: string;
  private readonly runner: GitRunner;
  private readonly gitHome: string;
  private readonly viewRoot: string;
  private readonly disposeTimeoutMs: number;
  private ops = new Set<Op>();
  private activeOps = 0;
  private perProject = new Map<string, number>();
  private queue: QueueEntry[] = [];
  private disposed = false;

  constructor(private deps: CheckpointDeps) {
    this.gitExe = deps.gitExe ?? "/usr/bin/git";
    this.runner = deps.runner ?? makeGitRunner(this.gitExe);
    this.gitHome = join(deps.dataRoot, "git-home");
    this.viewRoot = join(deps.dataRoot, "ckpt-views");
    this.disposeTimeoutMs = deps.disposeTimeoutMs ?? DISPOSE_WAIT_MS;
    this.store = new CheckpointStore(join(deps.dataRoot, "checkpoints"));
  }

  private get mutable(): boolean {
    return this.deps.mutable();
  }

  private project(projectId: string): Project {
    const p = this.deps.projects().find((x) => x.id === projectId);
    if (!p) throw new EngineError(`unknown project ${projectId}`);
    return p;
  }

  private grantFor(projectId: string): WorkspaceGrant {
    const g = this.deps.paths?.lookup(projectId);
    if (!g) throw new EngineError("no-grant");
    return this.deps.paths!.verify(g);
  }

  private threadOwned(projectId: string, threadId: string): ChatThread | null {
    const t = this.deps.threads().find((x) => x.id === threadId);
    if (!t || t.projectId !== projectId) return null;
    return t;
  }

  private turnOwned(thread: ChatThread, turnId: string): boolean {
    return thread.turn?.id === turnId || thread.messages.some((m) => m.turnId === turnId);
  }

  /** Position of a turn inside the thread's OWN chronological order —
   *  message order plus the in-flight turn last. Wall-clock createdAt is
   *  a hint, never the ordering authority (R1-A). -1 = not owned. */
  private turnOrder(t: ChatThread, turnId: string): number {
    for (let i = 0; i < t.messages.length; i++)
      if (t.messages[i]!.turnId === turnId) return i;
    if (t.turn?.id === turnId) return t.messages.length;
    return -1;
  }

  private envFor(extra?: Record<string, string>): Record<string, string> {
    return gitChildEnv(this.gitHome, extra);
  }

  // ---- operation machinery ----------------------------------------------------

  private newOp(projectId: string, threadId: string, owned: () => boolean): Op {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const op: Op = {
      projectId,
      threadId,
      grantDir: "",
      cancelled: false,
      deadline: Date.now() + OP_DEADLINE_MS,
      children: new Set(),
      scratch: null,
      owned,
      settled,
      settle,
    };
    this.ops.add(op);
    void settled.then(() => this.ops.delete(op));
    return op;
  }

  /** Gate before every spawn and after every await. */
  private gate(op: Op): WorkspaceGrant {
    if (this.disposed) throw new EngineError("the application is closing");
    if (op.cancelled) throw new EngineError("operation cancelled");
    if (!this.mutable)
      throw new EngineError("read-only: close failed or teardown is running");
    if (Date.now() > op.deadline) throw new EngineError("deadline exceeded");
    if (!this.deps.projects().some((p) => p.id === op.projectId))
      throw new EngineError("operation cancelled");
    if (!op.owned()) throw new EngineError("operation cancelled");
    const verified = this.grantFor(op.projectId);
    if (!op.grantDir) op.grantDir = verified.directory;
    else if (verified.directory !== op.grantDir)
      throw new EngineError("operation cancelled"); // rebound grant
    return verified;
  }

  private runOp(
    op: Op,
    args: readonly string[],
    opts: { cwd?: string; timeoutMs?: number; maxBytes?: number; env?: Record<string, string> },
  ): GitRunHandle {
    this.gate(op);
    const remaining = op.deadline - Date.now();
    const h = this.runner.run(args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env ?? this.envFor(),
      timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? GIT_TIMEOUT_MS, remaining)),
      maxBytes: opts.maxBytes ?? INDEX_META_CAP,
    });
    op.children.add(h);
    void h.done.then(
      () => op.children.delete(h),
      () => op.children.delete(h),
    );
    return h;
  }

  private async awaitOp(op: Op, h: GitRunHandle): Promise<GitRunResult> {
    const r = await h.done;
    this.gate(op);
    return r;
  }

  private cancelOp(op: Op): void {
    op.cancelled = true;
    for (const h of op.children) h.cancel();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.op === op) {
        this.queue.splice(i, 1)[0]!.reject(new EngineError("operation cancelled"));
      }
    }
  }

  // ---- semaphore: 1 per project, 2 global, queue ≤16, atomic handoff ----------

  private acquire(op: Op): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed || op.cancelled) {
        reject(new EngineError("the application is closing"));
        return;
      }
      const per = this.perProject.get(op.projectId) ?? 0;
      if (this.activeOps < CKPT_MAX_GLOBAL && per < CKPT_MAX_PER_PROJECT) {
        this.activeOps++;
        this.perProject.set(op.projectId, per + 1);
        resolve();
        return;
      }
      if (this.queue.length >= CKPT_QUEUE_CAP) {
        reject(new EngineError("busy: too many queued checkpoint operations"));
        return;
      }
      this.queue.push({ op, resolve, reject });
    });
  }

  private release(op: Op): void {
    // The finishing op frees BOTH its slots, then the freed global slot
    // is handed atomically to the first queued op whose project slot is
    // free — a queued head blocked by its own project must not starve
    // later projects, and no release/reacquire window exists.
    this.activeOps--;
    const per = (this.perProject.get(op.projectId) ?? 1) - 1;
    if (per <= 0) this.perProject.delete(op.projectId);
    else this.perProject.set(op.projectId, per);
    for (let i = 0; i < this.queue.length; i++) {
      const next = this.queue[i]!;
      if (next.op.cancelled) {
        this.queue.splice(i, 1);
        i--;
        next.reject(new EngineError("operation cancelled"));
        continue;
      }
      const np = this.perProject.get(next.op.projectId) ?? 0;
      if (np < CKPT_MAX_PER_PROJECT) {
        this.queue.splice(i, 1);
        this.activeOps++;
        this.perProject.set(next.op.projectId, np + 1);
        next.resolve();
        return;
      }
    }
  }

  // ---- capture ---------------------------------------------------------------

  /**
   * Capture a durable checkpoint of the project's tracked +
   * nonignored-untracked worktree. Raw bytes only — filters never run.
   * Returns an honest result; a partial capture is never published.
   */
  async capture(
    projectId: string,
    threadId: string,
    turnId: string,
    phase: CapturePhase,
  ): Promise<CheckpointResult> {
    this.project(projectId);
    const thread = this.threadOwned(projectId, threadId);
    if (!thread || !this.turnOwned(thread, turnId))
      return { kind: "unavailable", reason: "turn-not-found" };
    if (this.deps.unavailableReason)
      return { kind: "unavailable", reason: this.deps.unavailableReason };

    const op = this.newOp(projectId, threadId, () => {
      const t = this.threadOwned(projectId, threadId);
      return !!t && this.turnOwned(t, turnId);
    });
    try {
      await this.acquire(op);
      try {
        return await this.captureBody(op, projectId, threadId, turnId, phase);
      } catch (e) {
        return { kind: "unavailable", reason: reason(e) };
      } finally {
        this.release(op);
      }
    } catch (e) {
      return { kind: "unavailable", reason: reason(e) };
    } finally {
      this.store.dropScratch(op.scratch);
      op.scratch = null;
      op.settle();
    }
  }

  private async captureBody(
    op: Op,
    projectId: string,
    threadId: string,
    turnId: string,
    phase: CapturePhase,
  ): Promise<CheckpointResult> {
    if (!existsSync(this.gitExe)) return { kind: "unavailable", reason: "no-git" };
    let grant = this.gate(op);

    const runOnce: RunGit = (args, o) => this.runOp(op, args, o);
    const probeOut = await probeRepo(grant.directory, this.gitHome, runOnce, (x) =>
      this.envFor(x),
    );
    this.gate(op);
    if (probeOut.kind === "not-repository")
      return { kind: "unavailable", reason: "not-repository" };
    if (probeOut.kind !== "ok" || !probeOut.probe)
      return {
        kind: probeOut.kind === "unsupported" ? "unsupported" : "unavailable",
        reason: probeOut.reason ?? "probe-failed",
      };
    const probe = probeOut.probe;

    const scratch = this.store.newScratch();
    op.scratch = scratch;
    const viewDir = join(scratch, "view");

    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
      grant = this.gate(op);
      if (attempt > 0) rmSync(viewDir, { recursive: true, force: true }); // prior attempt's partial view
      const built = await buildView(probe, viewDir, grant.directory);
      this.gate(op);
      if (built.kind !== "ok") {
        if (built.reason?.startsWith("changed") && attempt + 1 < CAPTURE_RETRIES) continue;
        return {
          kind: built.kind === "unsupported" ? "unsupported" : "unavailable",
          reason: built.reason ?? "capture-failed",
        };
      }

      const env = this.envFor({
        GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(probe.objectsDir),
      });
      const listing = await this.listFiles(op, viewDir, grant.directory, env);
      if (typeof listing === "string") return { kind: "unavailable", reason: listing };
      const { indexMap, untracked } = listing;

      const paths = [...new Set([...indexMap.keys(), ...untracked])];
      if (paths.length > CKPT_MAX_PATHS)
        return { kind: "unavailable", reason: "too-many-paths" };
      paths.sort();

      const entries: ManifestEntry[] = [];
      let totalBytes = 0;
      const pins: PinnedPath[] = [];

      let batch = 0;
      for (const rel of paths) {
        this.gate(op); // deadline/cancel checked inside the path loop too
        if (++batch % YIELD_EVERY === 0) {
          await delay(0); // bounded batch — let cancellation/delete run
          this.gate(op);
        }
        const stage = indexMap.get(rel) ?? [];
        if (stage.some((s) => s.mode === "160000"))
          return { kind: "unsupported", reason: `submodule:${rel}` };
        const abs = join(grant.directory, rel);
        // Missing ancestors are fine (leaf reports absent); an existing
        // symlink/non-directory ancestor refuses (R1-D).
        const anc = resolveAncestors(grant.directory, rel, (p) => lstatSync(p));
        if (!anc.ok || !anc.deepest)
          return { kind: "unavailable", reason: `parent-symlink:${rel}` };

        const st = lstatSync(abs, { throwIfNoEntry: false });
        if (!st) {
          entries.push({ path: rel, worktree: { kind: "absent" }, index: stage });
          pins.push({ rel, ancestor: anc.deepest, work: { t: "absent" } });
          continue;
        }
        if (st.isSymbolicLink()) {
          const target = readlinkSync(abs);
          if (target.length > 8192 || target.includes("\0"))
            return { kind: "unavailable", reason: `link-target:${rel}` };
          entries.push({ path: rel, worktree: { kind: "symlink", target }, index: stage });
          pins.push({ rel, ancestor: anc.deepest, work: { t: "symlink", target } });
          continue;
        }
        if (!st.isFile())
          return { kind: "unavailable", reason: `unsupported-type:${rel}` };

        const rec = readBounded(abs, CKPT_MAX_FILE_BYTES);
        totalBytes += rec.buf.length;
        if (totalBytes > CKPT_MAX_TOTAL_BYTES)
          return { kind: "unavailable", reason: "capture-over-budget" };
        const sha = this.store.putBlob(rec.buf, scratch);
        entries.push({
          path: rel,
          worktree: {
            kind: "file",
            sha256: sha,
            size: rec.buf.length,
            exec: (st.mode & 0o111) !== 0,
          },
          index: stage,
        });
        // Pin the inode actually READ (open+fstat inside readBounded),
        // not the earlier lstat — a replace between them is impossible
        // to confuse, and the hash re-read proves content (R1-B).
        pins.push({
          rel,
          ancestor: anc.deepest,
          work: {
            t: "file",
            sha256: sha,
            dev: rec.meta.dev,
            ino: rec.meta.ino,
            mtimeMs: rec.meta.mtimeMs,
            size: rec.buf.length,
            perm: st.mode & 0o777,
          },
        });
      }

      // Post-capture re-verify (R1-B): CONTENT hashes, link text, modes,
      // ancestor identities, index bytes vs the captured view and a
      // re-run bounded listing — never just stat fields. Any drift
      // invalidates the attempt instead of publishing a mixed snapshot.
      const verify = await this.verifyStable(op, grant.directory, pins, probe, viewDir, env, {
        indexMap,
        untracked,
      });
      if (verify !== null) {
        if (attempt + 1 < CAPTURE_RETRIES) continue;
        return { kind: "unavailable", reason: verify };
      }

      grant = this.gate(op); // final grant+ownership check before publication
      const manifest: CheckpointManifest = {
        version: 1,
        checkpointId: randomUUID(),
        projectId,
        threadId,
        turnId,
        phase,
        createdAt: Date.now(),
        grantDir: grant.directory,
        worktree: probe.worktree,
        objectFormat: probe.objectFormat,
        headOid: probe.headOid,
        branch: probe.headRef,
        pathCount: entries.length,
        totalBytes,
        limitations: probe.helpersPresent ? ["filters"] : [],
        entries,
      };
      this.store.publishManifest(manifest); // atomic: tmp + rename
      return {
        kind: "captured",
        checkpointId: manifest.checkpointId,
        pathCount: entries.length,
        totalBytes,
      };
    }
    return { kind: "unavailable", reason: "capture-failed" };
  }

  /** null = stable; string = the instability reason (retries or fails). */
  private async verifyStable(
    op: Op,
    root: string,
    pins: readonly PinnedPath[],
    probe: RepoProbe,
    viewDir: string,
    env: Record<string, string>,
    first: { indexMap: Map<string, ManifestIndexEntry[]>; untracked: Set<string> },
  ): Promise<string | null> {
    let checked = 0;
    for (const p of pins) {
      if (++checked % YIELD_EVERY === 0) {
        await delay(0);
        this.gate(op);
      }
      // Ancestor identity: a swapped or recreated parent directory must
      // invalidate even when the leaf's own stat looks unchanged.
      const anc = resolveAncestors(root, p.rel, (x) => lstatSync(x));
      if (
        !anc.ok ||
        !anc.deepest ||
        anc.deepest.absPath !== p.ancestor.absPath ||
        anc.deepest.dev !== p.ancestor.dev ||
        anc.deepest.ino !== p.ancestor.ino
      )
        return "changed-during-capture";
      const abs = join(root, p.rel);
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (p.work.t === "absent") {
        if (st) return "changed-during-capture";
        continue;
      }
      if (p.work.t === "symlink") {
        let t2: string | null = null;
        try {
          if (st && st.isSymbolicLink()) t2 = readlinkSync(abs);
        } catch {
          t2 = null;
        }
        if (t2 !== p.work.target) return "changed-during-capture";
        continue;
      }
      // file: identity AND content must match what was captured —
      // a same-size edit with a restored mtime is caught by the hash.
      if (
        !st ||
        st.isSymbolicLink() ||
        !st.isFile() ||
        st.ino !== p.work.ino ||
        st.dev !== p.work.dev ||
        st.mtimeMs !== p.work.mtimeMs ||
        st.size !== p.work.size ||
        (st.mode & 0o777) !== p.work.perm
      )
        return "changed-during-capture";
      try {
        const rec = readBounded(abs, CKPT_MAX_FILE_BYTES);
        if (sha256Buf(rec.buf) !== p.work.sha256) return "changed-during-capture";
      } catch {
        return "changed-during-capture";
      }
    }

    if (!this.sourceIndexMatches(probe.indexPath, viewDir)) return "index-changed-during-capture";

    // Bounded re-listing: new or deleted paths since the first listing
    // mean the snapshot is mixed — never publish it.
    const relist = await this.listFiles(op, viewDir, root, env);
    if (typeof relist === "string") return relist;
    if (!sameIndexMap(first.indexMap, relist.indexMap) || !sameSet(first.untracked, relist.untracked))
      return "changed-during-capture";
    if (!this.sourceIndexMatches(probe.indexPath, viewDir)) return "index-changed-during-capture";
    return null;
  }

  private sourceIndexMatches(indexPath: string, viewDir: string): boolean {
    try {
      const source = lstatSync(indexPath, { throwIfNoEntry: false });
      const viewIndex = join(viewDir, "index");
      const captured = lstatSync(viewIndex, { throwIfNoEntry: false });
      if (!source || !captured) return !source && !captured;
      return readBounded(indexPath, INDEX_META_CAP).buf.equals(readBounded(viewIndex, INDEX_META_CAP).buf);
    } catch {
      return false;
    }
  }

  /** `git ls-files` inside the controlled view — index stages +
   *  nonignored untracked, NUL-structural output only. */
  private async listFiles(
    op: Op,
    viewDir: string,
    worktree: string,
    env: Record<string, string>,
    paths?: readonly string[],
  ): Promise<{ indexMap: Map<string, ManifestIndexEntry[]>; untracked: Set<string> } | string> {
    const base = [
      "--no-optional-locks",
      "--no-lazy-fetch",
      `--git-dir=${viewDir}`,
      `--work-tree=${worktree}`,
      "ls-files",
      "-z",
    ];
    const tail = paths ? ["--", ...paths] : [];

    const staged = await this.awaitOp(
      op,
      this.runOp(op, [...base, "--cached", "--stage", ...tail], {
        env,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: INDEX_META_CAP,
      }),
    );
    if (staged.timedOut || staged.cancelled) return "timeout";
    if (staged.overflowed || staged.code !== 0) return "ls-files-failed";

    const indexMap = new Map<string, ManifestIndexEntry[]>();
    for (const rec of staged.stdout.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab < 0) return "ls-files-shape";
      const meta = rec.slice(0, tab).split(" ");
      if (meta.length !== 3) return "ls-files-shape";
      const [mode, oid, stageStr] = meta as [string, string, string];
      const stage = Number.parseInt(stageStr, 10);
      const path = rec.slice(tab + 1);
      if (validateRepoPath(path) === null) return `unsafe-path:${path.slice(0, 64)}`;
      if (!/^[0-7]{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/.test(oid) || !(stage >= 0 && stage <= 3))
        return "ls-files-shape";
      const arr = indexMap.get(path) ?? [];
      arr.push({ mode, oid, stage });
      indexMap.set(path, arr);
    }

    const untracked = new Set<string>();
    if (!paths) {
      // Whole-tree listing: nonignored untracked files. With an explicit
      // path list (preview) only index state is queried.
      const others = await this.awaitOp(
        op,
        this.runOp(op, [...base, "--others", "--exclude-standard"], {
          env,
          timeoutMs: GIT_TIMEOUT_MS,
          maxBytes: INDEX_META_CAP,
        }),
      );
      if (others.timedOut || others.cancelled) return "timeout";
      if (others.overflowed || others.code !== 0) return "ls-files-failed";
      for (const rec of others.stdout.split("\0")) {
        if (!rec) continue;
        if (validateRepoPath(rec) === null) return `unsafe-path:${rec.slice(0, 64)}`;
        untracked.add(rec);
      }
    }
    return { indexMap, untracked };
  }

  // ---- preview -----------------------------------------------------------------

  /**
   * Non-mutating undo preview. Proposes a per-path action only when the
   * CURRENT worktree AND index state exactly match the end checkpoint's
   * record AND the base state is provably different with explicit
   * evidence. Omission from a manifest is UNKNOWN, not absence (R1-A):
   * pre-existing ignored files and filtered-out paths can never be
   * proposed for deletion. Never writes.
   */
  /** Shared gate for preview AND restore: ownership, disposal, touched
   *  validation, manifest load/foreign/order checks and grant binding.
   *  Never starts an op — callers own that lifecycle. */
  private prepare(
    projectId: string,
    threadId: string,
    baseCheckpointId: string,
    endCheckpointId: string,
    touchedPaths: readonly string[],
  ):
    | { ok: true; base: CheckpointManifest; end: CheckpointManifest; grant: WorkspaceGrant; touched: string[] }
    | { ok: false; reason: string } {
    const thread = this.threadOwned(projectId, threadId);
    if (!thread) return { ok: false, reason: "thread-not-found" };
    if (this.disposed || !this.mutable) return { ok: false, reason: "closing" };
    if (this.deps.unavailableReason) return { ok: false, reason: this.deps.unavailableReason };

    // Dedupe + validate the supplied touched set — renderer paths never
    // arrive here unvalidated even though this slice is main-only.
    const touched: string[] = [];
    const seen = new Set<string>();
    for (const raw of touchedPaths) {
      const p = validateRepoPath(raw);
      if (p === null) return { ok: false, reason: `unsafe-path:${String(raw).slice(0, 64)}` };
      if (!seen.has(p)) {
        seen.add(p);
        touched.push(p);
      }
    }
    if (touched.length > TOUCHED_CAP) return { ok: false, reason: "too-many-paths" };

    let base: CheckpointManifest;
    let end: CheckpointManifest;
    try {
      base = this.store.loadManifest(baseCheckpointId);
      end = this.store.loadManifest(endCheckpointId);
    } catch (e) {
      return { ok: false, reason: reason(e) };
    }
    if (
      base.projectId !== projectId ||
      end.projectId !== projectId ||
      base.threadId !== threadId ||
      end.threadId !== threadId
    )
      return { ok: false, reason: "foreign-checkpoint" };
    if (base.grantDir !== end.grantDir) return { ok: false, reason: "grant-mismatch" };
    if (base.phase !== "before" || end.phase !== "after") return { ok: false, reason: "checkpoint-order" };
    // Turn ordering from the OWNERSHIP lookup — createdAt alone is never
    // enough: a turn that ran earlier but was captured later is refused.
    const posB = this.turnOrder(thread, base.turnId);
    const posE = this.turnOrder(thread, end.turnId);
    if (posB < 0 || posE < 0) return { ok: false, reason: "turn-not-found" };
    if (posB > posE || base.createdAt > end.createdAt) return { ok: false, reason: "checkpoint-order" };
    let grant: WorkspaceGrant;
    try {
      grant = this.grantFor(projectId);
    } catch (e) {
      return { ok: false, reason: reason(e) };
    }
    if (grant.directory !== base.grantDir) return { ok: false, reason: "grant-rebound" };
    return { ok: true, base, end, grant, touched };
  }

  async preview(
    projectId: string,
    threadId: string,
    baseCheckpointId: string,
    endCheckpointId: string,
    touchedPaths: readonly string[],
  ): Promise<PreviewResult> {
    this.project(projectId);
    const fail = (r: string): PreviewResult => ({
      kind: "unavailable",
      baseCheckpointId,
      endCheckpointId,
      touchedPaths: [],
      entries: [],
      limitations: [],
      reason: r,
    });
    const prep = this.prepare(projectId, threadId, baseCheckpointId, endCheckpointId, touchedPaths);
    if (!prep.ok) return fail(prep.reason);
    const { base, end, grant, touched } = prep;

    const op = this.newOp(projectId, threadId, () => {
      const t = this.threadOwned(projectId, threadId);
      return !!t && this.turnOrderOk(t, base.turnId, end.turnId);
    });
    try {
      await this.acquire(op);
      try {
        const a = await this.analyzeBody(op, grant, base, end, touched);
        if (a.kind !== "ready") {
          return {
            kind: "unavailable",
            baseCheckpointId: base.checkpointId,
            endCheckpointId: end.checkpointId,
            touchedPaths: [...touched],
            entries: [],
            limitations: [],
            reason: a.reason,
          };
        }
        return {
          previewId: randomUUID(),
          kind: "ready",
          baseCheckpointId: base.checkpointId,
          endCheckpointId: end.checkpointId,
          touchedPaths: [...touched],
          entries: a.entries,
          limitations: a.limitations,
        };
      } catch (e) {
        return fail(reason(e));
      } finally {
        this.release(op);
      }
    } catch (e) {
      return fail(reason(e));
    } finally {
      this.store.dropScratch(op.scratch);
      op.scratch = null;
      op.settle();
    }
  }

  private turnOrderOk(t: ChatThread, a: string, b: string): boolean {
    const pa = this.turnOrder(t, a);
    const pb = this.turnOrder(t, b);
    return pa >= 0 && pb >= 0 && pa <= pb;
  }

  /** The analysis both preview and restore share: repo probe, scratch
   *  index view, per-path proposals and a final consistency re-check.
   *  Ready hands the caller everything needed to act on the proposals —
   *  still inside the op lock. */
  private async analyzeBody(
    op: Op,
    grant: WorkspaceGrant,
    base: CheckpointManifest,
    end: CheckpointManifest,
    touched: readonly string[],
  ): Promise<
    | {
        kind: "ready";
        probe: RepoProbe;
        viewDir: string;
        env: Record<string, string>;
        indexMap: Map<string, ManifestIndexEntry[]>;
        entries: PreviewEntry[];
        limitations: string[];
      }
    | { kind: "unavailable"; reason: string }
  > {
    const unavailable = (r: string) => ({ kind: "unavailable" as const, reason: r });
    const runOnce: RunGit = (args, o) => this.runOp(op, args, o);
    const probeOut = await probeRepo(grant.directory, this.gitHome, runOnce, (x) =>
      this.envFor(x),
    );
    this.gate(op);
    if (probeOut.kind !== "ok" || !probeOut.probe)
      return unavailable(probeOut.reason ?? "probe-failed");
    const probe = probeOut.probe;

    const scratch = this.store.newScratch();
    op.scratch = scratch;
    const viewDir = join(scratch, "view");
    const built = await buildView(probe, viewDir, grant.directory);
    this.gate(op);
    if (built.kind !== "ok") return unavailable(built.reason ?? "view-failed");

    const env = this.envFor({
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(probe.objectsDir),
    });
    // Current index state for exactly the touched paths.
    const listing = await this.listFiles(op, viewDir, grant.directory, env, touched);
    if (typeof listing === "string") return unavailable(listing);
    const { indexMap } = listing;

    const baseByPath = new Map(base.entries.map((e) => [e.path, e]));
    const endByPath = new Map(end.entries.map((e) => [e.path, e]));
    const out: PreviewEntry[] = [];
    const limitations = new Set<string>(end.limitations);
    if (probe.helpersPresent) limitations.add("filters");
    limitations.add("omission-not-evidence"); // documented coverage limit

    /** First-pass worktree fingerprints — re-verified before the result
     *  is returned so a knowingly-changed source never yields "ready". */
    const firstFp = new Map<string, string | null>();
    let batch = 0;

    for (const rel of touched) {
      this.gate(op);
      if (++batch % YIELD_EVERY === 0) {
        await delay(0);
        this.gate(op);
      }
      const endEntry = endByPath.get(rel);
      const baseEntry = baseByPath.get(rel);
      const abs = join(grant.directory, rel);

      // Current worktree fingerprint.
      const curW = this.fingerprintWorktree(abs, grant.directory, rel);
      firstFp.set(rel, curW);
      if (curW === null) {
        out.push({ path: rel, action: "keep", reason: "unsafe-path" });
        continue;
      }
      const curIndex = indexMap.get(rel) ?? [];
      const curI = fingerprintIndex(curIndex);

      // A missing END entry is UNKNOWN, not "absent at end" (R1-A).
      if (!endEntry) {
        out.push({ path: rel, action: "keep", reason: "end-unknown" });
        continue;
      }
      const endW = fingerprintManifestWorktree(endEntry.worktree);
      const endI = fingerprintIndex(endEntry.index);

      if (curW !== endW || curI !== endI) {
        out.push({
          path: rel,
          action: "keep",
          reason:
            curW !== endW && curI !== endI
              ? "changed-since-end"
              : curW !== endW
                ? "worktree-changed"
                : "index-changed",
        });
        continue;
      }

      // Current state exactly equals the recorded end state.
      const matched: PreviewFingerprint = { worktree: endW, index: endI };
      // A missing BASE entry is UNKNOWN, not "created by the turn" (R1-A).
      if (!baseEntry) {
        out.push({ path: rel, action: "keep", reason: "base-unknown", matched });
        continue;
      }
      let payloadFailure: string | undefined;
      for (const entry of [baseEntry, endEntry]) {
        if (entry.worktree.kind !== "file") continue;
        try {
          this.store.readBlob(entry.worktree.sha256, entry.worktree.size);
        } catch (e) {
          payloadFailure = e instanceof CheckpointStoreError ? e.code : "blob-missing";
          break;
        }
      }
      if (payloadFailure) {
        out.push({ path: rel, action: "keep", reason: payloadFailure });
        continue;
      }
      const baseW = fingerprintManifestWorktree(baseEntry.worktree);
      const baseI = fingerprintIndex(baseEntry.index);
      if (baseW === endW && baseI === endI) {
        out.push({ path: rel, action: "noop", matched });
        continue;
      }
      // Any proposal must be able to reach the recorded base state by a
      // worktree-only action — a differing index cannot (R1-A).
      if (baseI !== endI) {
        out.push({ path: rel, action: "keep", reason: "index-differs", matched });
        continue;
      }
      if (baseEntry.worktree.kind === "absent" && baseEntry.index.length > 0) {
        // EXPLICIT absence evidence: the path was tracked and proven
        // missing at base time; the end manifest proves the captured
        // turn recreated it. Removing the worktree file restores the
        // recorded base state exactly.
        out.push({ path: rel, action: "remove", matched });
        continue;
      }
      if (baseEntry.worktree.kind === "absent") {
        // Explicitly absent but untracked at base — recorded as a
        // listing race, not proof of non-existence. Keep it.
        out.push({ path: rel, action: "keep", reason: "base-unknown", matched });
        continue;
      }
      out.push({ path: rel, action: "restore", matched });
    }

    // Final consistency re-check (R1-B): a preview is not an atomic lock,
    // but it must never report "ready" over a source index/listing that
    // changed under it, or over worktree state that drifted mid-pass.
    const relist = await this.listFiles(op, viewDir, grant.directory, env, touched);
    if (typeof relist === "string") return unavailable(relist);
    if (!sameIndexMap(indexMap, relist.indexMap)) return unavailable("index-changed-during-preview");
    batch = 0;
    for (const [rel, fp] of firstFp) {
      if (++batch % YIELD_EVERY === 0) {
        await delay(0);
        this.gate(op);
      }
      const again = this.fingerprintWorktree(join(grant.directory, rel), grant.directory, rel);
      if (again !== fp) return unavailable("changed-during-preview");
    }
    if (!this.sourceIndexMatches(probe.indexPath, viewDir))
      return unavailable("index-changed-during-preview");
    this.gate(op); // ownership + grant one last time before "ready"

    return {
      kind: "ready",
      probe,
      viewDir,
      env,
      indexMap,
      entries: out,
      limitations: [...limitations],
    };
  }

  // ---- restore (the preview's authorized apply half) ---------------------------

  /**
   * IN-PLACE RESTORE/DELETE DISABLED AT THE SERVICE ENTRY.
   *
   * Lead directive (A17 security deviation): the apply path below is
   * still check-then-write — between the per-path fingerprint re-proof
   * and rmSync / writeWorktreeFile / renameSync an external writer can
   * land bytes we would then silently overwrite or delete. No atomic
   * compare-and-swap exists for regular files, so NO amount of
   * re-hashing makes in-place restore safe; every call is refused here
   * unconditionally. This is the single choke point before any write —
   * no IPC handler, coordinator or future caller can bypass it.
   *
   * Still fully available: checkpoint capture, preview analysis
   * (read-only), the ledger and every existing user byte. The apply
   * machinery (applyBody) is retained but unreachable until a real
   * non-overwrite contract exists; "save elsewhere" stays unbuilt for
   * the same reason — preview alone is the honest surface.
   */
  async restore(
    _projectId: string,
    _threadId: string,
    _baseCheckpointId: string,
    _endCheckpointId: string,
    _touchedPaths: readonly string[],
  ): Promise<RestoreResult> {
    return {
      kind: "unavailable",
      entries: [],
      reason: "in-place-restore-disabled",
    };
  }

  /** Per-turn diff — READ-ONLY blob comparison (F10/A32). The stored
   *  base and end worktree bytes for one touched path are compared;
   *  the live worktree, index and HEAD are never consulted, so no
   *  read-modify race exists by construction. Omission-from-manifest
   *  stays UNKNOWN (R1-A) — only an explicit `absent` record proves
   *  creation/deletion. */
  async diff(
    projectId: string,
    threadId: string,
    baseCheckpointId: string,
    endCheckpointId: string,
    touchedPaths: readonly string[],
    path: string,
  ): Promise<CheckpointDiffView> {
    this.project(projectId);
    const p = validateRepoPath(path);
    if (p === null) return { kind: "unavailable", reason: "unsafe-path" };
    const prep = this.prepare(
      projectId,
      threadId,
      baseCheckpointId,
      endCheckpointId,
      touchedPaths,
    );
    if (!prep.ok) return { kind: "unavailable", path: p, reason: prep.reason };
    const { base, end, touched } = prep;
    if (!touched.includes(p)) return { kind: "unavailable", path: p, reason: "untouched-path" };
    const baseE = base.entries.find((e) => e.path === p);
    const endE = end.entries.find((e) => e.path === p);
    if (!baseE) return { kind: "unavailable", path: p, reason: "base-unknown" };
    if (!endE) return { kind: "unavailable", path: p, reason: "end-unknown" };
    const read = (
      w: ManifestWorktree,
    ): { text: string | null; binary?: true } | { err: string } => {
      if (w.kind === "absent") return { text: null };
      if (w.kind !== "file") return { err: `unsupported-kind:${w.kind}` };
      try {
        const buf = this.store.readBlob(w.sha256, w.size);
        if (looksBinary(buf)) return { text: "", binary: true };
        return { text: buf.toString("utf8") };
      } catch (e) {
        return { err: e instanceof CheckpointStoreError ? e.code : "blob-missing" };
      }
    };
    const a = read(baseE.worktree);
    if ("err" in a) return { kind: "unavailable", path: p, reason: a.err };
    if (a.binary) return { kind: "binary", path: p };
    const b = read(endE.worktree);
    if ("err" in b) return { kind: "unavailable", path: p, reason: b.err };
    if (b.binary) return { kind: "binary", path: p };
    if ((a.text?.length ?? 0) + (b.text?.length ?? 0) > DIFF_MAX_BYTES)
      return { kind: "oversized", path: p };
    const patch = unifiedDiff(a.text, b.text, p);
    if (patch === "") return { kind: "empty", path: p };
    if (patch.length > DIFF_MAX_BYTES) return { kind: "oversized", path: p };
    return { kind: "text", path: p, patch };
  }

  private async applyBody(
    op: Op,
    grant: WorkspaceGrant,
    base: CheckpointManifest,
    a: Extract<Awaited<ReturnType<CheckpointService["analyzeBody"]>>, { kind: "ready" }>,
    touched: readonly string[],
  ): Promise<RestoreResult> {
    const unavailable = (r: string): RestoreResult => ({
      kind: "unavailable",
      entries: [],
      reason: r,
    });
    // Fresh index truth right before ANY write: the analysis indexMap is
    // minutes-old in adversarial terms. Both the private view AND the
    // source index must still match what the proposals were proven on.
    const relist = await this.listFiles(op, a.viewDir, grant.directory, a.env, touched);
    if (typeof relist === "string") return unavailable(relist);
    if (!sameIndexMap(relist.indexMap, a.indexMap))
      return unavailable("index-changed-before-restore");
    if (!this.sourceIndexMatches(a.probe.indexPath, a.viewDir))
      return unavailable("index-changed-before-restore");
    this.gate(op);

    const baseByPath = new Map(base.entries.map((e) => [e.path, e]));
    const results: RestoreEntryResult[] = [];
    for (const e of a.entries) {
      this.gate(op);
      if (e.action !== "restore" && e.action !== "remove") {
        results.push({
          path: e.path,
          action: e.action === "noop" ? "noop" : "kept",
          ...(e.reason ? { reason: e.reason } : {}),
        });
        continue;
      }
      const abs = join(grant.directory, e.path);
      const curW = this.fingerprintWorktree(abs, grant.directory, e.path);
      const curI = fingerprintIndex(relist.indexMap.get(e.path) ?? []);
      if (curW === null || curW !== e.matched?.worktree || curI !== e.matched.index) {
        results.push({ path: e.path, action: "kept", reason: "changed-since-analysis" });
        continue;
      }
      if (e.action === "remove") {
        const st = lstatSync(abs, { throwIfNoEntry: false });
        if (!st) {
          results.push({ path: e.path, action: "noop" });
          continue;
        }
        if (!st.isFile() && !st.isSymbolicLink()) {
          results.push({ path: e.path, action: "kept", reason: "unsafe-type" });
          continue;
        }
        try {
          rmSync(abs);
          fsyncDirBestEffort(dirname(abs));
          results.push({ path: e.path, action: "removed" });
        } catch {
          results.push({ path: e.path, action: "kept", reason: "unlink-failed" });
        }
        continue;
      }
      // restore: write the recorded BASE worktree bytes back.
      const bw = baseByPath.get(e.path)?.worktree;
      if (bw?.kind !== "file") {
        results.push({ path: e.path, action: "kept", reason: "unsupported-base-kind" });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = this.store.readBlob(bw.sha256, bw.size);
      } catch (err) {
        results.push({
          path: e.path,
          action: "kept",
          reason: err instanceof CheckpointStoreError ? err.code : "blob-missing",
        });
        continue;
      }
      try {
        writeWorktreeFile(abs, bytes, bw.exec);
        fsyncDirBestEffort(dirname(abs));
        results.push({ path: e.path, action: "restored" });
      } catch {
        results.push({ path: e.path, action: "kept", reason: "write-failed" });
      }
    }
    return { kind: "applied", entries: results };
  }

  /** Fingerprint the CURRENT worktree state of one path: identical
   *  shaping to the manifest records so equality is exact. null = the
   *  path itself is unsafe (existing ancestor symlink / bad type). */
  private fingerprintWorktree(abs: string, root: string, rel: string): string | null {
    const anc = resolveAncestors(root, rel, (p) => lstatSync(p));
    if (!anc.ok) return null;
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return "absent";
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch {
        return null;
      }
      if (target.length > 8192 || target.includes("\0")) return null;
      return `symlink:${sha256Text(target)}`;
    }
    if (!st.isFile()) return null; // dir/fifo/socket — never guess
    if (st.size > CKPT_MAX_FILE_BYTES) return null;
    try {
      const rec = readBounded(abs, CKPT_MAX_FILE_BYTES);
      return `file:${sha256Buf(rec.buf)}:${rec.buf.length}:${(st.mode & 0o111) !== 0 ? 1 : 0}`;
    } catch {
      return null; // unreadable/changed — keep, don't guess
    }
  }

  // ---- lifecycle ---------------------------------------------------------------

  onProjectDeleted(projectId: string): void {
    for (const op of this.ops) if (op.projectId === projectId) this.cancelOp(op);
  }

  onThreadDeleted(threadId: string): void {
    for (const op of this.ops) if (op.threadId === threadId) this.cancelOp(op);
  }

  /** Stop admission, cancel queued+running ops, wait a bounded time for
   *  the whole ownership set, and report anything not confirmed exited. */
  async dispose(): Promise<{ problems: string[] }> {
    this.disposed = true;
    for (const w of this.queue.splice(0)) {
      w.reject(new EngineError("the application is closing"));
    }
    for (const op of this.ops) {
      op.cancelled = true;
      for (const h of op.children) h.cancel();
    }
    const problems: string[] = [];
    const pending = [...this.ops].map((o) => o.settled);
    if (pending.length) {
      const outcome = await Promise.race([
        Promise.allSettled(pending).then(() => "settled" as const),
        delay(this.disposeTimeoutMs).then(() => "timeout" as const),
      ]);
      if (outcome === "timeout")
        problems.push(
          `checkpoint: ${this.ops.size} operation(s) did not settle within ${this.disposeTimeoutMs}ms — records retained for a later dispose retry`,
        );
    }
    const stillLive = this.runner.active().size;
    if (stillLive > 0)
      problems.push(`checkpoint: ${stillLive} child process(es) not observed exited`);
    if (problems.length === 0) {
      // Only our own marked scratch remains cleanup-owned.
      for (const op of this.ops) {
        this.store.dropScratch(op.scratch);
        op.scratch = null;
      }
    }
    return { problems };
  }
}

// ---- fingerprints --------------------------------------------------------------

interface PinnedPath {
  rel: string;
  ancestor: AncestorPin;
  work:
    | { t: "absent" }
    | { t: "symlink"; target: string }
    | {
        t: "file";
        sha256: string;
        dev: number;
        ino: number;
        mtimeMs: number;
        size: number;
        perm: number;
      };
}

const sha256Buf = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const sha256Text = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** Durable worktree write: tmp file in the SAME directory, fsync, then
 *  an atomic rename over the target. Never follows the target — a
 *  symlink at the path is replaced, not written through. */
function writeWorktreeFile(abs: string, bytes: Buffer, exec: boolean): void {
  const dir = dirname(abs);
  const tmp = join(dir, `.tivano-restore-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    chmodSync(tmp, exec ? 0o755 : 0o644);
  } catch {
    // Windows has no exec bit — the bytes still land.
  }
  renameSync(tmp, abs);
}

function fsyncDirBestEffort(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms — best effort.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fingerprintIndex(entries: readonly ManifestIndexEntry[]): string {
  if (entries.length === 0) return "none";
  return entries
    .map((e) => `${e.mode}:${e.oid}:${e.stage}`)
    .sort()
    .join(",");
}

function fingerprintManifestWorktree(w: ManifestEntry["worktree"]): string {
  if (w.kind === "file") return `file:${w.sha256}:${w.size}:${w.exec ? 1 : 0}`;
  if (w.kind === "symlink") return `symlink:${sha256Text(w.target)}`;
  return "absent";
}

function sameIndexMap(
  a: Map<string, ManifestIndexEntry[]>,
  b: Map<string, ManifestIndexEntry[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.length !== v.length) return false;
    for (let i = 0; i < v.length; i++) {
      const x = v[i]!;
      const y = w[i]!;
      if (x.mode !== y.mode || x.oid !== y.oid || x.stage !== y.stage) return false;
    }
  }
  return true;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));
