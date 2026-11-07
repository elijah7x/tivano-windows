// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Read-only Git service: per-project snapshots captured inside a controlled
// ephemeral git-dir (see gitView.ts). The renderer addresses snapshots and
// entries by opaque ids only — a path, revision, executable or argument can
// never cross the bridge.
//
// Lifecycle: work is tracked as WHOLE operations (probe→view→status, or
// check-attr→numstat→patch), each bound to a project + verified grant
// identity with its own deadline, view and child set. A gate runs BEFORE
// EVERY spawn and AFTER EVERY await: service disposed, engine read-only,
// project deleted, grant revoked/rebound, op cancelled or the overall
// deadline all stop the chain immediately — a cancelled op can never
// start another Git command or publish a snapshot. The semaphore hands a
// slot to a queued op without a release/reacquire window, the pending
// queue is capped, and dispose cancels everything then waits — bounded —
// for observed child exits rather than inferring them.

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { AppEvent } from "../shared/ipc";
import type {
  BranchListResult,
  BranchNameCheck,
  BranchOpResult,
  GitBranchRow,
  GitCommitResult,
  GitDiffResult,
  GitDiffSide,
  GitPushResult,
  GitSnapshot,
  GitStatusEntry,
  GitWorkingChanges,
  Project,
  WorktreeResult,
} from "../shared/types";
import { EngineError } from "./engine";
import type { GitRunHandle, GitRunResult } from "./gitExec";
import { gitChildEnv, makeGitRunner, type GitRunner, type RunGit } from "./gitExec";
import {
  buildView,
  ENTRY_CAP,
  GIT_TIMEOUT_MS,
  PATCH_CAP_LINES,
  parseNumstatZ,
  parsePorcelainV2,
  probeRepo,
  STATUS_CAP_BYTES,
  type RepoProbe,
} from "./gitView";
import type { ProjectRuntimePaths } from "./projectRuntimePaths";
import type { WorkspaceGrant } from "./provider";

export const MAX_CONCURRENT_OPS = 4;
export const QUEUE_CAP = 32;
const CAPTURE_RETRIES = 2;
/** Whole-operation deadline — all commands of one refresh/diff together,
 *  never GIT_TIMEOUT_MS multiplied by arbitrary work. */
const OP_DEADLINE_MS = 30_000;
const DISPOSE_WAIT_MS = 6_000;
/** F13: frozen 40_000-byte prefix for the commit sheet's working patch. */
const CHANGES_PATCH_CAP = 40_000;
/** F13: frozen Git.push timeout — push is the one long-running op. */
const PUSH_TIMEOUT_MS = 300_000;
/** IPC bound for one commit message (chars). Generous but finite. */
const COMMIT_MESSAGE_MAX = 262_144;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** F22 landing result — where an isolated head's diff went. */
export type HydraLandResult =
  | {
      kind: "landed";
      files: { path: string; additions: number; deletions: number }[];
      conflicts: string[];
    }
  | {
      kind: "patch";
      files: { path: string; additions: number; deletions: number }[];
      patchPath?: string;
      error: string;
    }
  | { kind: "unavailable"; reason: string };

/** `git diff --numstat -z` with the counts kept (the report's
 *  "file (+N −M)" lines); renames carry their NEW path. */
function parseLandingNumstat(
  text: string,
): { path: string; additions: number; deletions: number }[] {
  const out: { path: string; additions: number; deletions: number }[] = [];
  const toks = text.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok === "") continue;
    const m = tok.match(/^([-\d]+)\t([-\d]+)\t(.*)$/s);
    if (!m || m[3] === undefined) continue;
    const additions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    if (m[3] === "") {
      i += 1; // rename: orig token, then new
      const nu = toks[++i] ?? "";
      if (nu) out.push({ path: nu, additions, deletions });
    } else {
      out.push({ path: m[3], additions, deletions });
    }
  }
  return out;
}

interface SnapshotEntry {
  path: string;
  origPath?: string;
  canDiffStaged: boolean;
  canDiffWorktree: boolean;
}

interface LiveSnapshot {
  snap: GitSnapshot;
  viewDir: string;
  objectsDir: string;
  worktree: string;
  helpersPresent: boolean;
  entries: Map<string, SnapshotEntry>;
  /** In-flight diff operations pinned to this view. */
  refs: number;
  retired: boolean;
}

/** A whole logical operation — refresh or diff — owning its children,
 *  grant identity, deadline and (for refresh) the view it is building. */
interface Op {
  projectId: string;
  /** Grant directory bound at the first successful gate; a later rebind
   *  to a different directory cancels the op. */
  grantDir: string;
  cancelled: boolean;
  deadline: number;
  children: Set<GitRunHandle>;
  /** View dir being built by this op (not yet adopted by a snapshot). */
  buildingView: string | null;
  settled: Promise<void>;
  settle: () => void;
}

interface QueueEntry {
  op: Op;
  resolve: () => void;
  reject: (e: Error) => void;
}

export interface GitServiceDeps {
  paths: ProjectRuntimePaths | null;
  projects: () => readonly Project[];
  /** False while closing/read-only — refresh/diff spawn nothing then. */
  mutable: () => boolean;
  emit: (e: AppEvent) => void;
  /** App data root: views live under `<dataRoot>/git-views`, child HOMEs
   *  under `<dataRoot>/git-home`. */
  dataRoot: string;
  gitExe?: string;
  platform?: NodeJS.Platform;
  /** Stable machine reason when the Git EXECUTOR LAYER cannot carry runs
   *  at all (Windows: no resolved git.exe, invalid explicit config, or
   *  no attested job-helper --run). Checked before every spawn — the
   *  service reports unavailable honestly instead of trying a spawn
   *  that can never be proven clean. */
  unavailableReason?: string;
  runner?: GitRunner;
  /** Trusted main-process env for the win32 child env (SystemRoot & co).
   *  Injectable for tests; defaults to the live process env. */
  systemEnv?: Record<string, string | undefined>;
  /** Bound on the dispose wait — injectable for tests. */
  disposeTimeoutMs?: number;
}

export class GitService {
  private snapshots = new Map<string, LiveSnapshot>();
  private refreshing = new Map<string, Promise<GitSnapshot>>();
  private ops = new Set<Op>();
  private activeOps = 0;
  private queue: QueueEntry[] = [];
  private disposed = false;
  private readonly disposeTimeoutMs: number;
  private readonly gitExe: string;
  private readonly platform: NodeJS.Platform;
  private readonly unavailableReason: string | null;
  private readonly systemEnv: Record<string, string | undefined> | undefined;
  private readonly runner: GitRunner;
  private readonly gitHome: string;
  private readonly viewRoot: string;
  private readonly worktreeRoot: string;
  /** F22: patches kept when a head's work could not be applied. */
  private readonly patchRoot: string;
  /** F13: service-owned scratch dir for commit message files — the Git
   *  runner never pipes stdin, so `commit -F` reads a file the service
   *  itself created (never a caller-supplied path). */
  private readonly tmpRoot: string;

  constructor(private deps: GitServiceDeps) {
    this.gitExe = deps.gitExe ?? "/usr/bin/git";
    this.platform = deps.platform ?? process.platform;
    this.unavailableReason = deps.unavailableReason ??
      (this.platform === "win32" && !deps.runner ? "git-containment" : null);
    this.systemEnv = deps.systemEnv;
    this.runner = deps.runner ?? makeGitRunner(this.gitExe);
    this.gitHome = join(deps.dataRoot, "git-home");
    this.viewRoot = join(deps.dataRoot, "git-views");
    this.worktreeRoot = join(deps.dataRoot, "worktrees");
    this.patchRoot = join(deps.dataRoot, "hydra-patches");
    this.tmpRoot = join(deps.dataRoot, "tmp");
    this.disposeTimeoutMs = deps.disposeTimeoutMs ?? DISPOSE_WAIT_MS;
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

  /** Cached snapshot — never spawns; allowed in read-only state. */
  overview(projectId: string): GitSnapshot {
    this.project(projectId);
    const live = this.snapshots.get(projectId);
    if (live) return { ...live.snap, entries: live.snap.entries.map((e) => ({ ...e })) };
    return {
      snapshotId: "",
      projectId,
      capturedAt: 0,
      kind: "unavailable",
      entries: [],
      limitations: [],
      reason: "no-snapshot",
    };
  }

  private envFor(extra?: Record<string, string>, allowProtocols?: string): Record<string, string> {
    return gitChildEnv(this.gitHome, extra, {
      platform: this.platform,
      executable: this.gitExe,
      ...(this.systemEnv ? { systemEnv: this.systemEnv } : {}),
      ...(allowProtocols !== undefined ? { allowProtocols } : {}),
    });
  }

  // ---- operation tracking ---------------------------------------------------

  private newOp(projectId: string, deadlineMs = OP_DEADLINE_MS): Op {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const op: Op = {
      projectId,
      grantDir: "",
      cancelled: false,
      deadline: Date.now() + deadlineMs,
      children: new Set(),
      buildingView: null,
      settled,
      settle,
    };
    this.ops.add(op);
    void settled.then(() => this.ops.delete(op));
    return op;
  }

  /** The gate every spawn and every await passes through. Throws the
   *  moment the op must not continue: disposed service, read-only engine,
   *  vanished/rebound grant, cancelled op, expired deadline. */
  private gate(op: Op): WorkspaceGrant {
    if (this.disposed) throw new EngineError("the application is closing");
    if (op.cancelled) throw new EngineError("operation cancelled");
    if (!this.mutable)
      throw new EngineError("read-only: close failed or teardown is running");
    if (Date.now() > op.deadline) throw new EngineError("deadline exceeded");
    if (!this.deps.projects().some((p) => p.id === op.projectId))
      throw new EngineError("operation cancelled"); // project gone
    const verified = this.grantFor(op.projectId);
    if (!op.grantDir) op.grantDir = verified.directory;
    else if (verified.directory !== op.grantDir)
      throw new EngineError("operation cancelled"); // grant rebound elsewhere
    return verified;
  }

  private runOp(
    op: Op,
    args: readonly string[],
    opts: { cwd?: string; timeoutMs?: number; maxBytes?: number; env?: Record<string, string> },
  ): GitRunHandle {
    this.gate(op); // BEFORE every spawn
    const remaining = op.deadline - Date.now();
    const h = this.runner.run(args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env ?? this.envFor(),
      timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? GIT_TIMEOUT_MS, remaining)),
      maxBytes: opts.maxBytes ?? STATUS_CAP_BYTES,
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
    this.gate(op); // AFTER every await — cancel/delete/dispose lands here
    return r;
  }

  /** Cancel an op: queued entries reject, live children get the observed-
   *  exit escalation, and the gate stops the chain before the next spawn. */
  private cancelOp(op: Op): void {
    op.cancelled = true;
    for (const h of op.children) h.cancel();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.op === op) {
        this.queue.splice(i, 1)[0]!.reject(new EngineError("operation cancelled"));
      }
    }
  }

  // ---- semaphore: atomic handoff, bounded pending queue ---------------------

  private acquire(op: Op): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed || op.cancelled) {
        reject(new EngineError("the application is closing"));
        return;
      }
      if (this.activeOps < MAX_CONCURRENT_OPS) {
        this.activeOps++;
        resolve();
        return;
      }
      if (this.queue.length >= QUEUE_CAP) {
        reject(new EngineError("busy: too many queued git operations"));
        return;
      }
      this.queue.push({ op, resolve, reject });
    });
  }

  private release(): void {
    // Hand the slot straight to a queued op — no release/reacquire window
    // where a new caller could slip past the cap.
    while (this.queue.length) {
      const next = this.queue.shift()!;
      if (next.op.cancelled) {
        next.reject(new EngineError("operation cancelled"));
        continue;
      }
      next.resolve();
      return;
    }
    this.activeOps--;
  }

  // ---- refresh --------------------------------------------------------------

  refresh(projectId: string): Promise<GitSnapshot> {
    this.project(projectId);
    const running = this.refreshing.get(projectId);
    if (running) return running; // one active refresh per project
    const p = this.doRefresh(projectId).finally(() => {
      if (this.refreshing.get(projectId) === p) this.refreshing.delete(projectId);
    });
    this.refreshing.set(projectId, p);
    return p;
  }

  private async doRefresh(projectId: string): Promise<GitSnapshot> {
    const op = this.newOp(projectId);
    try {
      await this.acquire(op);
      try {
        if (this.unavailableReason)
          return this.finish(
            projectId,
            snap(projectId, "unavailable", { reason: this.unavailableReason }),
            op,
          );
        if (!existsSync(this.gitExe))
          return this.finish(projectId, snap(projectId, "unavailable", { reason: "no-git" }), op);

        let grant: WorkspaceGrant;
        try {
          grant = this.gate(op);
        } catch (e) {
          return this.finish(projectId, snap(projectId, "unavailable", { reason: reason(e) }), op);
        }

        const runOnce: RunGit = (args, o) => this.runOp(op, args, o);
        const probeOut = await probeRepo(grant.directory, this.gitHome, runOnce, (x) =>
          this.envFor(x),
        { platform: this.platform });
        this.gate(op); // probe ran several awaits internally
        if (probeOut.kind === "not-repository")
          return this.finish(projectId, snap(projectId, "not-repository"), op);
        if (probeOut.kind !== "ok" || !probeOut.probe)
          return this.finish(
            projectId,
            snap(projectId, probeOut.kind === "unsupported" ? "unsupported" : "unavailable", {
              reason: probeOut.reason ?? "probe-failed",
            }),
            op,
          );
        const probe = probeOut.probe;

        for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
          grant = this.gate(op); // re-verify right before the spawn
          const viewDir = join(this.viewRoot, `${projectId}-${randomUUID()}`);
          op.buildingView = viewDir;
          const built = await buildView(probe, viewDir, grant.directory);
          this.gate(op);
          if (built.kind !== "ok") {
            rmSync(viewDir, { recursive: true, force: true });
            if (built.reason?.startsWith("changed") && attempt + 1 < CAPTURE_RETRIES) continue;
            return this.finish(
              projectId,
              snap(projectId, built.kind === "unsupported" ? "unsupported" : "unavailable", {
                reason: built.reason ?? "capture-failed",
              }),
              op,
            );
          }

          const status = await this.awaitOp(
            op,
            this.runOp(
              op,
              [
                "--no-optional-locks",
                "--no-lazy-fetch",
                `--git-dir=${viewDir}`,
                `--work-tree=${grant.directory}`,
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=all",
              ],
              {
                env: this.envFor({ GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(probe.objectsDir) }),
                timeoutMs: GIT_TIMEOUT_MS,
                maxBytes: STATUS_CAP_BYTES,
              },
            ),
          );
          if (status.timedOut || status.cancelled || status.executorFailed) {
            rmSync(viewDir, { recursive: true, force: true });
            op.buildingView = null;
            return this.finish(
              projectId,
              snap(projectId, "unavailable", {
                reason: status.executorFailed
                  ? `executor-${status.executorFailed}`
                  : "timeout",
              }),
              op,
            );
          }
          if (status.overflowed || status.code !== 0) {
            rmSync(viewDir, { recursive: true, force: true });
            op.buildingView = null;
            const why = /split|sparse/i.test(status.stderr)
              ? "unsupported-index"
              : "status-failed";
            return this.finish(
              projectId,
              snap(projectId, why === "unsupported-index" ? "unsupported" : "unavailable", {
                reason: why,
              }),
              op,
            );
          }
          op.buildingView = null; // adopted by the snapshot below
          // F13: one extra read per successful capture — the commit sheet's
          // Push / Open-repository state needs origin's URL truth, and a
          // missing remote must report absent rather than be guessed.
          grant = this.gate(op);
          const remote = await this.awaitOp(
            op,
            this.runOp(op, ["remote", "get-url", "origin"], { cwd: grant.directory }),
          );
          const remoteUrl =
            remote.code === 0 && !remote.overflowed && !remote.timedOut && !remote.cancelled
              ? remote.stdout.trim() || undefined
              : undefined;
          const parsed = parsePorcelainV2(status.stdout, ENTRY_CAP);
          const out = this.materialize(projectId, viewDir, probe, parsed, remoteUrl);
          return this.finish(projectId, out, op);
        }
        return this.finish(projectId, snap(projectId, "unavailable", { reason: "capture-failed" }), op);
      } catch (e) {
        return this.finish(projectId, snap(projectId, "unavailable", { reason: reason(e) }), op);
      } finally {
        this.release();
      }
    } catch (e) {
      // Admission itself failed (closed/disposed/queue-full): still an
      // honest snapshot answer, never an unhandled rejection.
      return this.finish(projectId, snap(projectId, "unavailable", { reason: reason(e) }), op);
    } finally {
      // A view the op built but never handed to a snapshot dies with it.
      if (op.buildingView) {
        try {
          rmSync(op.buildingView, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        op.buildingView = null;
      }
      op.settle();
    }
  }

  /** Turn parsed porcelain into the delivered snapshot + live entry map. */
  private materialize(
    projectId: string,
    viewDir: string,
    probe: RepoProbe,
    parsed: ReturnType<typeof parsePorcelainV2>,
    remoteUrl?: string,
  ): { snap: GitSnapshot; viewDir: string; objectsDir: string; worktree: string; helpersPresent: boolean; entries: Map<string, SnapshotEntry> } {
    const h = parsed.header;
    const entries: GitStatusEntry[] = [];
    const byId = new Map<string, SnapshotEntry>();
    const limitations: string[] = [];
    if (probe.helpersPresent) limitations.push("filters");
    if (parsed.truncated) limitations.push("entries-truncated");

    for (const e of parsed.entries) {
      const id = randomUUID();
      const unmerged = e.raw === "u";
      const untracked = e.raw === "?" || e.raw === "!";
      const x = e.xy[0] ?? ".";
      const y = e.xy[1] ?? ".";
      const staged = !unmerged && !untracked && x !== ".";
      const unstaged = !unmerged && !untracked && y !== ".";
      const kindMap: Record<string, GitStatusEntry["kind"]> = {
        M: "modified",
        A: "added",
        D: "deleted",
        R: "renamed",
        C: "copied",
        T: "typechange",
        U: "unmerged",
      };
      const kind: GitStatusEntry["kind"] = unmerged
        ? "unmerged"
        : untracked
          ? "untracked"
          : (kindMap[x] ?? kindMap[y] ?? "modified");
      const submodule =
        e.submodule || e.modeIndex === "160000" || e.modeWorktree === "160000";
      const canDiffStaged = staged && !submodule;
      const canDiffWorktree = unstaged && !submodule;
      const entry: GitStatusEntry = {
        id,
        path: e.path,
        ...(e.origPath ? { origPath: e.origPath } : {}),
        kind,
        staged: x,
        unstaged: y,
        unmerged,
        untracked,
        canDiffStaged,
        canDiffWorktree,
      };
      entries.push(entry);
      byId.set(id, {
        path: e.path,
        ...(e.origPath ? { origPath: e.origPath } : {}),
        canDiffStaged,
        canDiffWorktree,
      });
    }

    const unborn = h.oid === "(initial)" || h.oid === null;
    const detached = h.head === "(detached)";
    const snap: GitSnapshot = {
      snapshotId: randomUUID(),
      projectId,
      capturedAt: Date.now(),
      kind: "ready",
      branch: {
        name: detached || !h.head ? null : h.head,
        detached,
        unborn,
        ...(h.oid && !unborn ? { oid: h.oid } : {}),
        ...(h.upstream ? { upstream: h.upstream } : {}),
        ...(h.ahead != null ? { ahead: h.ahead } : {}),
        ...(h.behind != null ? { behind: h.behind } : {}),
      },
      entries,
      ...(remoteUrl ? { remoteUrl } : {}),
      limitations,
    };
    return {
      snap,
      viewDir,
      objectsDir: probe.objectsDir,
      worktree: probe.worktree,
      helpersPresent: probe.helpersPresent,
      entries: byId,
    };
  }

  private finish(
    projectId: string,
    s: GitSnapshot | ReturnType<GitService["materialize"]>,
    op?: Op,
  ): GitSnapshot {
    const snap = "snap" in s ? s.snap : s;
    // A late/cancelled/disposed finish answers its caller but never
    // stores or emits — a stale result can never replace live state.
    const alive =
      !this.disposed &&
      !(op?.cancelled) &&
      this.deps.projects().some((p) => p.id === projectId);
    if ("snap" in s && s.viewDir) {
      if (alive) {
        const prev = this.snapshots.get(projectId);
        const live: LiveSnapshot = {
          snap,
          viewDir: s.viewDir,
          objectsDir: s.objectsDir,
          worktree: s.worktree,
          helpersPresent: s.helpersPresent,
          entries: s.entries,
          refs: 0,
          retired: false,
        };
        this.snapshots.set(projectId, live);
        if (prev && prev.viewDir !== live.viewDir) this.retire(projectId, prev);
      } else {
        try {
          rmSync(s.viewDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    } else if (alive) {
      const prev = this.snapshots.get(projectId);
      const live: LiveSnapshot = {
        snap,
        viewDir: "",
        objectsDir: "",
        worktree: "",
        helpersPresent: false,
        entries: new Map<string, SnapshotEntry>(),
        refs: 0,
        retired: false,
      };
      this.snapshots.set(projectId, live);
      if (prev && prev.viewDir !== live.viewDir) this.retire(projectId, prev);
    }
    if (alive && !this.disposed) this.deps.emit({ type: "git-snapshot", snapshot: snap });
    return snap;
  }

  /** Drop a view once its snapshot is replaced AND its diffs have drained. */
  private retire(projectId: string, live: LiveSnapshot): void {
    if (this.snapshots.get(projectId) === live) return; // still current
    live.retired = true;
    if (live.refs <= 0 && live.viewDir) {
      try {
        rmSync(live.viewDir, { recursive: true, force: true });
      } catch {
        /* best effort; next launch cleans the view root */
      }
    }
  }

  // ---- diff ------------------------------------------------------------------

  async diff(
    projectId: string,
    snapshotId: string,
    entryId: string,
    side: GitDiffSide,
  ): Promise<GitDiffResult> {
    this.project(projectId);
    // Spawnability is a rejection, not a fake result — read-only/closing
    // callers must see the refusal, and it precedes the stale checks.
    if (this.disposed) throw new EngineError("the application is closing");
    if (!this.mutable)
      throw new EngineError("read-only: close failed or teardown is running");
    const fail = (kind: GitDiffResult["kind"], r?: string): GitDiffResult => ({
      snapshotId,
      entryId,
      side,
      kind,
      ...(r ? { reason: r } : {}),
    });
    const live = this.snapshots.get(projectId);
    if (!live || live.snap.snapshotId !== snapshotId) return fail("unavailable", "stale");
    const entry = live.entries.get(entryId);
    if (!entry) return fail("unavailable", "stale");
    if (side === "staged" && !entry.canDiffStaged) return fail("unavailable", "not-diffable");
    if (side === "worktree" && !entry.canDiffWorktree)
      return fail("unavailable", "not-diffable");

    const op = this.newOp(projectId);
    // Pin the view BEFORE queueing: a refresh landing while this diff
    // waits must not delete the directory out from under it.
    live.refs++;
    let acquired = false;
    try {
      try {
        await this.acquire(op);
        acquired = true;
      } catch (e) {
        // Admission failed — spawnability is reported as a rejection so
        // callers see read-only/closing instead of a fake result.
        throw e;
      }
      // Re-validate AFTER the capacity wait: the snapshot may have been
      // replaced or the grant revoked while this op was queued.
      try {
        this.gate(op);
        if (this.snapshots.get(projectId) !== live) return fail("unavailable", "stale");
        const grant = this.gate(op);
        if (grant.directory !== live.worktree) return fail("unavailable", "stale");
      } catch (e) {
        return fail("unavailable", reason(e));
      }

      try {
        const paths = [entry.path];
        if (entry.origPath) paths.push(entry.origPath);
        const args = (extra: string[]): string[] => [
          "--no-optional-locks",
          "--no-lazy-fetch",
          `--git-dir=${live.viewDir}`,
          `--work-tree=${live.worktree}`,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...extra,
          "-z",
          "--",
          ...paths,
        ];
        const env = this.envFor({
          GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(live.objectsDir),
        });
        if (side === "worktree") {
          // Per-file attribute check, EVERY diff — attributes can change
          // after refresh or name a driver only the (untrusted) repo config
          // knew. `check-attr -z` is a structural data lookup that can
          // never execute a driver; BOTH rename paths are checked.
          const ca = await this.awaitOp(
            op,
            this.runOp(
              op,
              [
                "--no-optional-locks",
                "--no-lazy-fetch",
                `--git-dir=${live.viewDir}`,
                `--work-tree=${live.worktree}`,
                "check-attr",
                "-z",
                "filter",
                "--",
                ...paths,
              ],
              { env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024 },
            ),
          );
          if (ca.timedOut || ca.cancelled || ca.executorFailed)
            return fail(
              "unavailable",
              ca.executorFailed ? `executor-${ca.executorFailed}` : "timeout",
            );
          if (ca.overflowed || ca.code !== 0) return fail("unavailable", "diff-failed");
          // -z output: <path>\0filter\0<value>\0 per path — never split on
          // ':', a colon is legal inside a filename. Only an ASSIGNED
          // driver value refuses the comparison (unspecified/unset do not).
          const toks = ca.stdout.split("\0").filter((t) => t !== "");
          if (toks.length === 0 || toks.length % 3 !== 0)
            return fail("unavailable", "diff-shape");
          for (let i = 0; i < toks.length; i += 3) {
            const val = toks[i + 2];
            if (val !== "unspecified" && val !== "unset")
              return fail("unavailable", "filters");
          }
        }
        const num = await this.awaitOp(
          op,
          this.runOp(op, args(["--numstat", ...(side === "staged" ? ["--cached"] : [])]), {
            env,
            timeoutMs: GIT_TIMEOUT_MS,
            maxBytes: 256 * 1024,
          }),
        );
        if (num.timedOut || num.cancelled || num.executorFailed)
          return fail(
            "unavailable",
            num.executorFailed ? `executor-${num.executorFailed}` : "timeout",
          );
        if (num.overflowed || num.code !== 0) return fail("unavailable", "diff-failed");
        const stat = parseNumstatZ(num.stdout).find((s) =>
          s.paths.includes(entry.path) || (entry.origPath && s.paths.includes(entry.origPath)),
        );
        // A numstat record covering the entry MUST exist — missing means
        // the output is malformed and binary detection cannot be trusted.
        if (!stat) return fail("unavailable", "diff-shape");
        if (stat.binary) return { snapshotId, entryId, side, kind: "binary" };

        const patch = await this.awaitOp(
          op,
          this.runOp(op, args(["--patch", "-M", ...(side === "staged" ? ["--cached"] : [])]), {
            env,
            timeoutMs: GIT_TIMEOUT_MS,
            maxBytes: STATUS_CAP_BYTES,
          }),
        );
        if (patch.timedOut || patch.cancelled || patch.executorFailed)
          return fail(
            "unavailable",
            patch.executorFailed ? `executor-${patch.executorFailed}` : "timeout",
          );
        if (patch.overflowed) return { snapshotId, entryId, side, kind: "oversized" };
        if (patch.code !== 0) {
          if (/Unmerged path/.test(patch.stdout + patch.stderr))
            return fail("unavailable", "unmerged");
          return fail("unavailable", "diff-failed");
        }
        if (/Unmerged path/.test(patch.stdout)) return fail("unavailable", "unmerged");
        if (!patch.stdout.trim()) return { snapshotId, entryId, side, kind: "empty" };
        if (patch.stdout.split("\n").length > PATCH_CAP_LINES)
          return { snapshotId, entryId, side, kind: "oversized" };
        return { snapshotId, entryId, side, kind: "text", patch: patch.stdout };
      } catch (e) {
        // Mid-chain failures (gate/cancel/deadline/transport) resolve as
        // an honest unavailable result — only ADMISSION above rejects.
        return fail("unavailable", reason(e));
      }
    } finally {
      if (acquired) this.release();
      live.refs--;
      if (live.retired && live.refs <= 0) this.retire(projectId, live);
      op.settle();
    }
  }

  // ---- commit flow (F13) ------------------------------------------------------
  // Frozen Git.workingChanges / commitAll / push. Commit and push WRITE to
  // the user checkout (index + HEAD + upstream) — same grant/gate/deadline
  // containment as every other op, but the only mutations a caller can
  // reach are `add -A`, `commit -F <file>` and `push -u origin HEAD`. The
  // message travels via a service-owned file under <dataRoot>/tmp — the
  // runner never pipes stdin and no caller path reaches the child.

  /** Frozen workingChanges(): `status --short` + a bounded `diff HEAD`.
   *  Read-only against the live checkout (no view needed — the sheet must
   *  show what commit would actually pick up). */
  async workingChanges(projectId: string): Promise<GitWorkingChanges> {
    const fail = (r: string): GitWorkingChanges => ({ kind: "unavailable", reason: r });
    this.project(projectId);
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const status = await this.awaitOp(
        op,
        this.runOp(op, ["status", "--short"], { cwd: grant.directory }),
      );
      if (status.timedOut || status.cancelled || status.executorFailed)
        return fail(status.executorFailed ? `executor-${status.executorFailed}` : "timeout");
      if (status.overflowed) return fail("status-too-large");
      if (status.code !== 0)
        return fail(status.stderr.trim().slice(0, 300) || "status-failed");
      const diff = await this.awaitOp(
        op,
        this.runOp(op, ["diff", "HEAD", "--no-ext-diff"], {
          cwd: grant.directory,
          maxBytes: CHANGES_PATCH_CAP,
        }),
      );
      // Frozen tolerates a failed diff (unborn HEAD) — the patch is then
      // empty; overflow keeps the bounded prefix and reports truncation.
      const ok = !diff.timedOut && !diff.cancelled && !diff.executorFailed && diff.code === 0;
      return {
        kind: "ok",
        summary: status.stdout,
        patch: ok ? diff.stdout : "",
        truncated: ok && diff.overflowed,
      };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** Frozen commitAll(): `git add -A` + `git commit -F <file>` inside one
   *  op; the push request runs afterwards as its own long-deadline op so a
   *  slow remote never starves the commit's semaphore slot. */
  async commit(
    projectId: string,
    message: string,
    pushAfter: boolean,
  ): Promise<GitCommitResult> {
    const fail = (r: string): GitCommitResult => ({ kind: "unavailable", reason: r });
    this.project(projectId);
    if (this.unavailableReason) return fail(this.unavailableReason);
    if (!message.trim()) return fail("message-empty");
    if (message.length > COMMIT_MESSAGE_MAX) return fail("message-too-large");
    const op = this.newOp(projectId);
    const msgFile = join(this.tmpRoot, `commit-${randomUUID()}.msg`);
    let acquired = false;
    let committed: Extract<GitCommitResult, { kind: "committed" }> | null = null;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      mkdirSync(this.tmpRoot, { recursive: true });
      writeFileSync(msgFile, message, { encoding: "utf8", mode: 0o600 });
      const add = await this.awaitOp(
        op,
        this.runOp(op, ["add", "-A"], { cwd: grant.directory }),
      );
      if (add.timedOut || add.cancelled || add.executorFailed)
        return fail(add.executorFailed ? `executor-${add.executorFailed}` : "timeout");
      if (add.code !== 0) return fail(add.stderr.trim().slice(0, 300) || "add-failed");
      const c = await this.awaitOp(
        op,
        this.runOp(op, ["commit", "-F", msgFile], { cwd: grant.directory }),
      );
      if (c.timedOut || c.cancelled || c.executorFailed)
        return fail(c.executorFailed ? `executor-${c.executorFailed}` : "timeout");
      if (c.code !== 0) return fail(c.stderr.trim().slice(0, 300) || "commit-failed");
      const rev = await this.awaitOp(
        op,
        this.runOp(op, ["rev-parse", "HEAD"], { cwd: grant.directory }),
      );
      committed = {
        kind: "committed",
        oid: rev.code === 0 ? rev.stdout.trim() : "",
        pushed: false,
      };
    } catch (e) {
      return fail(reason(e));
    } finally {
      try {
        rmSync(msgFile, { force: true });
      } catch {
        /* best effort */
      }
      if (acquired) this.release();
      op.settle();
    }
    if (!committed || !pushAfter) return committed;
    const p = await this.push(projectId);
    return p.kind === "pushed"
      ? { ...committed, pushed: true }
      : { ...committed, pushed: false, pushError: p.reason };
  }

  /** Frozen push(): `git push -u origin HEAD`, 300-second timeout. Own op
   *  with its own deadline — it may outlive a commit that triggered it. */
  async push(projectId: string): Promise<GitPushResult> {
    const fail = (r: string): GitPushResult => ({ kind: "unavailable", reason: r });
    this.project(projectId);
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId, PUSH_TIMEOUT_MS + GIT_TIMEOUT_MS);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const p = await this.awaitOp(
        op,
        // The sterile env blocks ALL transports by default (no lazy fetch
        // may ever phone out). Push is the one intended remote op — widen
        // to the standard URL transports only: `ext`/`fd` command
        // transports stay impossible, ssh stays dead via GIT_SSH_COMMAND,
        // and credential-less attempts fail fast (no prompt, no askpass).
        this.runOp(op, ["push", "-u", "origin", "HEAD"], {
          cwd: grant.directory,
          env: this.envFor(undefined, "file:http:https:git:ssh"),
          timeoutMs: PUSH_TIMEOUT_MS,
        }),
      );
      if (p.timedOut || p.cancelled || p.executorFailed)
        return fail(p.executorFailed ? `executor-${p.executorFailed}` : "timeout");
      if (p.code !== 0) return fail(p.stderr.trim().slice(0, 300) || "push-failed");
      return { kind: "pushed" };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  // ---- worktrees (F11) ---------------------------------------------------------
  // Mutating by design, but ONLY inside <dataRoot>/worktrees — the user's
  // checkout, index and HEAD are never written by these ops. A worktree
  // that cannot be proven inside the app-owned root is refused outright.

  /** Validate a candidate branch name against real git rules + the
   *  repo's existing refs. Unusable/taken names report honestly. */
  async worktreeCheck(
    projectId: string,
    name: string,
  ): Promise<{ kind: "ok"; name: string } | { kind: "unavailable"; reason: string }> {
    const fail = (r: string) => ({ kind: "unavailable" as const, reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const trimmed = name.trim();
    if (!trimmed) return fail("branch-name-empty");
    if (trimmed.length > 240) return fail("branch-name-too-long");
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const fmt = await this.awaitOp(
        op,
        this.runOp(op, ["check-ref-format", "--branch", trimmed], { cwd: grant.directory }),
      );
      if (fmt.code !== 0 || fmt.overflowed) return fail("branch-name-invalid");
      const ref = `refs/heads/${trimmed}`;
      const existing = await this.awaitOp(
        op,
        this.runOp(op, ["show-ref", "--verify", "--quiet", ref], { cwd: grant.directory }),
      );
      if (existing.code === 0) return fail("branch-exists");
      if (existing.code !== 1) return fail("ref-check-failed");
      return { kind: "ok", name: trimmed };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** `git worktree add <dir> -b <branch>` into an app-owned dir under
   *  <dataRoot>/worktrees/<projectId>/. The caller never names the
   *  directory — only the project + branch can arrive from outside. */
  async worktreeAdd(
    projectId: string,
    slug: string,
    branch: string,
  ): Promise<WorktreeResult> {
    const fail = (r: string): WorktreeResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const safe = /^[a-z0-9-]{1,40}$/.test(slug) ? slug : null;
    if (!safe) return fail("invalid-slug");
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const parent = join(this.worktreeRoot, projectId);
      mkdirSync(parent, { recursive: true });
      const dir = join(parent, `wt-${safe}-${randomUUID().slice(0, 8)}`);
      const r = await this.awaitOp(
        op,
        this.runOp(
          op,
          ["worktree", "add", "--no-guess-remote", dir, "-b", branch],
          { cwd: grant.directory },
        ),
      );
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "worktree-add-failed");
      const physical = realpathSync(dir);
      if (!physical.startsWith(realpathSync(this.worktreeRoot) + sep))
        return fail("worktree-escaped-root");
      return { kind: "created", directory: physical, branch };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** `git worktree remove <dir>` — plain, never --force: a dirty or
   *  locked worktree reports git's own refusal instead of discarding
   *  user changes. Refuses any dir outside the app-owned root. */
  async worktreeRemove(projectId: string, directory: string): Promise<WorktreeResult> {
    const fail = (r: string): WorktreeResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    let physical: string;
    try {
      physical = realpathSync(directory);
    } catch {
      return fail("worktree-missing");
    }
    if (!physical.startsWith(realpathSync(this.worktreeRoot) + sep))
      return fail("worktree-outside-root");
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const r = await this.awaitOp(
        op,
        this.runOp(op, ["worktree", "remove", physical], { cwd: grant.directory }),
      );
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "worktree-remove-failed");
      return { kind: "removed" };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  // ---- hydra copies (F22 isolation) ------------------------------------------
  // Frozen AppModel+Hydra copies: a head's "own copy" is a detached worktree
  // at a capture commit — the checkout's WHOLE working state (uncommitted and
  // untracked included) committed on top of HEAD where no branch sees it. On
  // report the head's diff against that base is applied three-way into the
  // landing checkout; unlandable work is kept as a patch file. Every spawn
  // still rides the same Op gate: grant must be live and `cwd` must be the
  // grant directory itself or an app-owned worktree under
  // <dataRoot>/worktrees/<projectId>/ — the copies can never address a path
  // outside the project's own grant or the app-owned root.

  /** cwd a hydra op may touch: the grant checkout, or a copy inside this
   *  project's app-owned worktree root (never a bare renderer path). */
  private hydraCwdDir(op: Op, grant: WorkspaceGrant, cwd: string): string {
    const physical = realpathSync(cwd);
    if (physical === grant.directory) return physical;
    const root = join(this.worktreeRoot, op.projectId);
    if (!physical.startsWith(realpathSync(root) + sep))
      throw new EngineError("hydra-copy-outside-root");
    return physical;
  }

  /** `git -C <dir> rev-parse --git-dir` + `--verify HEAD` — the frozen
   *  isRepository/hasCommits pair; a checkout without either never gets a
   *  copy and the head honestly runs in the shared checkout. */
  private async hydraRepoReady(op: Op, cwd: string): Promise<boolean> {
    const dir = await this.awaitOp(
      op,
      this.runOp(op, ["rev-parse", "--git-dir"], { cwd }),
    );
    if (dir.code !== 0) return false;
    const head = await this.awaitOp(
      op,
      this.runOp(op, ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd }),
    );
    return head.code === 0;
  }

  /** One temp-index write-tree of `cwd`'s working state seeded from
   *  `seed` (HEAD for a capture, the base tree for an end state). */
  private async hydraWriteTree(
    op: Op,
    cwd: string,
    seed: string,
  ): Promise<{ kind: "ok"; tree: string } | { kind: "fail"; reason: string }> {
    const indexPath = join(this.tmpRoot, `hydra-index-${randomUUID()}`);
    mkdirSync(this.tmpRoot, { recursive: true });
    try {
      const env = this.envFor({ GIT_INDEX_FILE: indexPath });
      const read = await this.awaitOp(
        op,
        this.runOp(op, ["read-tree", seed], { cwd, env }),
      );
      if (read.code !== 0) return { kind: "fail", reason: "read-tree-failed" };
      const add = await this.awaitOp(
        op,
        this.runOp(op, ["add", "-A"], { cwd, env }),
      );
      if (add.code !== 0) return { kind: "fail", reason: "add-failed" };
      const tree = await this.awaitOp(
        op,
        this.runOp(op, ["write-tree"], { cwd, env }),
      );
      const id = tree.stdout.trim();
      if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(id))
        return { kind: "fail", reason: "write-tree-failed" };
      return { kind: "ok", tree: id };
    } finally {
      rmSync(indexPath, { force: true });
    }
  }

  /** Frozen makeHydraCopy's capture: the checkout's working state as a
   *  tree, committed on top of HEAD where no branch will ever see it. */
  async hydraCapture(
    projectId: string,
    cwd: string,
  ): Promise<
    { kind: "captured"; tree: string; commit: string } | { kind: "unavailable"; reason: string }
  > {
    const fail = (r: string) => ({ kind: "unavailable" as const, reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const dir = this.hydraCwdDir(op, grant, cwd);
      if (!(await this.hydraRepoReady(op, dir))) return fail("not-a-repository");
      const t = await this.hydraWriteTree(op, dir, "HEAD");
      if (t.kind !== "ok") return fail(t.reason);
      const commit = await this.awaitOp(
        op,
        this.runOp(
          op,
          [
            "-c", "user.name=Tivano Hydra",
            "-c", "user.email=hydra@tivano.local",
            "commit-tree", t.tree, "-p", "HEAD",
            "-m", "Tivano Hydra working state",
          ],
          { cwd: dir },
        ),
      );
      const id = commit.stdout.trim();
      if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(id))
        return fail("commit-tree-failed");
      return { kind: "captured", tree: t.tree, commit: id };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** `git worktree add --detach <dir> <commit>` under the app-owned
   *  worktree root — the head's own copy (frozen addDetachedWorktree). */
  async hydraCopyAdd(
    projectId: string,
    slug: string,
    commit: string,
  ): Promise<WorktreeResult> {
    const fail = (r: string): WorktreeResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const safe = /^[a-z0-9-]{1,40}$/.test(slug) ? slug : null;
    if (!safe) return fail("invalid-slug");
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return fail("invalid-commit");
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const parent = join(this.worktreeRoot, projectId);
      mkdirSync(parent, { recursive: true });
      const dir = join(parent, `head-${safe}-${randomUUID().slice(0, 8)}`);
      const r = await this.awaitOp(
        op,
        this.runOp(op, ["worktree", "add", "--detach", dir, commit], {
          cwd: grant.directory,
        }),
      );
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "worktree-add-failed");
      const physical = realpathSync(dir);
      if (!physical.startsWith(realpathSync(this.worktreeRoot) + sep))
        return fail("worktree-escaped-root");
      return { kind: "created", directory: physical, branch: "" };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** The head copy's current working state as a tree seeded from its
   *  base — the diff `baseTree..end` is what landing applies. */
  async hydraEndTree(
    projectId: string,
    cwd: string,
    baseTree: string,
  ): Promise<{ kind: "ok"; tree: string } | { kind: "unavailable"; reason: string }> {
    const fail = (r: string) => ({ kind: "unavailable" as const, reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    if (!/^[0-9a-f]{40,64}$/.test(baseTree)) return fail("invalid-base");
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const dir = this.hydraCwdDir(op, grant, cwd);
      const t = await this.hydraWriteTree(op, dir, baseTree);
      return t.kind === "ok" ? t : fail(t.reason);
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** Frozen applyHydraHead, bounded: diff `baseTree..endTree`, apply it
   *  three-way into `checkout`. An in-progress merge/rebase or a patch
   *  nothing could apply keeps its file under <dataRoot>/hydra-patches. */
  async hydraLand(
    projectId: string,
    checkout: string,
    slug: string,
    headTag: string,
    baseTree: string,
    endTree: string,
  ): Promise<HydraLandResult> {
    const fail = (r: string): HydraLandResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId, OP_DEADLINE_MS * 2);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const dir = this.hydraCwdDir(op, grant, checkout);
      if (await this.operationInProgress(op, dir)) {
        const patchPath = await this.keepPatch(op, dir, slug, headTag, baseTree, endTree);
        return {
          kind: "patch",
          files: [],
          ...(patchPath !== null ? { patchPath } : {}),
          error:
            "a rebase or merge is underway in the checkout, or its git state cannot be read",
        };
      }
      const numstat = await this.awaitOp(
        op,
        this.runOp(
          op,
          ["diff", "--numstat", "-z", baseTree, endTree],
          { cwd: dir, maxBytes: STATUS_CAP_BYTES },
        ),
      );
      if (numstat.code !== 0 || numstat.overflowed)
        return fail("diff-failed");
      const files = parseLandingNumstat(numstat.stdout);
      if (!files.length) return { kind: "landed", files: [], conflicts: [] };
      const patchFile = join(
        this.tmpRoot,
        `hydra-patch-${randomUUID()}.patch`,
      );
      mkdirSync(this.tmpRoot, { recursive: true });
      const diff = await this.awaitOp(
        op,
        this.runOp(
          op,
          ["diff", "--binary", "--output", patchFile, baseTree, endTree],
          { cwd: dir },
        ),
      );
      if (diff.code !== 0 || !existsSync(patchFile))
        return fail("diff-failed");
      // Frozen Git.apply(), two passes. Pass 1 is a plain worktree
      // apply — a patch whose context still matches the dirty checkout
      // never needs the index (--3way demands worktree == index for the
      // touched files and refuses outright on a moved-on checkout).
      const plain = await this.awaitOp(
        op,
        this.runOp(op, ["apply", "--binary", "--whitespace=nowarn", patchFile], {
          cwd: dir,
        }),
      );
      if (plain.code === 0) {
        rmSync(patchFile, { force: true });
        return { kind: "landed", files, conflicts: [] };
      }
      // Pass 2 (frozen): the three-way merge works through an index
      // that MATCHES THE WORKING TREE — a throwaway scratch index gets
      // that state (copy of the real index, else read-tree HEAD, then
      // `add -A`); the checkout's real index never changes.
      const scratchIdx = join(this.tmpRoot, `hydra-apply-${randomUUID()}`);
      const env = this.envFor({ GIT_INDEX_FILE: scratchIdx });
      let seeded = false;
      const idxPath = await this.awaitOp(
        op,
        this.runOp(op, ["rev-parse", "--git-path", "index"], { cwd: dir }),
      );
      const ip = idxPath.stdout.trim();
      if (idxPath.code === 0 && ip !== "") {
        const full = isAbsolute(ip) ? ip : join(dir, ip);
        try {
          if (existsSync(full) && statSync(full).size <= 64 * 1024 * 1024) {
            copyFileSync(full, scratchIdx);
            seeded = true;
          }
        } catch { /* falls through to read-tree seeding */ }
      }
      if (!seeded) {
        const rt = await this.awaitOp(
          op,
          this.runOp(op, ["read-tree", "HEAD"], { cwd: dir, env }),
        );
        if (rt.code !== 0) {
          rmSync(patchFile, { force: true });
          return fail("scratch-index-failed");
        }
      }
      const add = await this.awaitOp(
        op,
        this.runOp(op, ["add", "-A", "--", "."], { cwd: dir, env }),
      );
      if (add.code !== 0) {
        rmSync(patchFile, { force: true });
        rmSync(scratchIdx, { force: true });
        return fail("scratch-add-failed");
      }
      const merged = await this.awaitOp(
        op,
        this.runOp(
          op,
          ["apply", "--3way", "--binary", "--whitespace=nowarn", patchFile],
          { cwd: dir, env },
        ),
      );
      if (merged.code === 0) {
        rmSync(patchFile, { force: true });
        rmSync(scratchIdx, { force: true });
        return { kind: "landed", files, conflicts: [] };
      }
      // Merged-with-markers: the scratch index's unmerged entries name
      // the conflict files (frozen `diff --diff-filter=U`); the apply
      // stderr's "U <path>" lines are the fallback source. Conflicted
      // files WERE merged into the checkout — the lead settles markers.
      let conflicts: string[] = [];
      const unmerged = await this.awaitOp(
        op,
        this.runOp(
          op,
          ["diff", "--name-only", "--diff-filter=U", "-z"],
          { cwd: dir, env, maxBytes: STATUS_CAP_BYTES },
        ),
      );
      if (unmerged.code === 0 && !unmerged.overflowed)
        conflicts = unmerged.stdout.split("\0").filter((s) => s !== "");
      if (!conflicts.length)
        for (const line of merged.stderr.split("\n"))
          if (line.startsWith("U ")) conflicts.push(line.slice(2).trim());
      rmSync(scratchIdx, { force: true });
      if (conflicts.length) {
        rmSync(patchFile, { force: true });
        return { kind: "landed", files, conflicts };
      }
      const kept = join(this.patchRoot, `${slug}-${headTag}.patch`);
      mkdirSync(this.patchRoot, { recursive: true });
      try {
        writeFileSync(kept, readFileSync(patchFile));
      } catch {
        return fail("patch-keep-failed");
      } finally {
        rmSync(patchFile, { force: true });
      }
      return {
        kind: "patch",
        files,
        patchPath: kept,
        error: merged.stderr.trim().slice(0, 300) || "apply-failed",
      };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** The unlanded-work patch kept beside the others (frozen
   *  keepHydraPatch); null when even the write failed. */
  private async keepPatch(
    op: Op,
    dir: string,
    slug: string,
    headTag: string,
    baseTree: string,
    endTree: string,
  ): Promise<string | null> {
    const patchFile = join(this.tmpRoot, `hydra-patch-${randomUUID()}.patch`);
    const diff = await this.awaitOp(
      op,
      this.runOp(op, ["diff", "--binary", "--output", patchFile, baseTree, endTree], {
        cwd: dir,
      }),
    );
    if (diff.code !== 0 || !existsSync(patchFile)) return null;
    const kept = join(this.patchRoot, `${slug}-${headTag}-unlanded.patch`);
    mkdirSync(this.patchRoot, { recursive: true });
    try {
      writeFileSync(kept, readFileSync(patchFile));
      return kept;
    } catch {
      return null;
    } finally {
      rmSync(patchFile, { force: true });
    }
  }

  /** Release a head's copy once its work is preserved (landed, empty or
   *  kept as a patch) — force-removes the dirty worktree; refuses any
   *  dir outside the app-owned root like worktreeRemove. */
  async hydraCopyRemove(projectId: string, directory: string): Promise<WorktreeResult> {
    const fail = (r: string): WorktreeResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    let physical: string;
    try {
      physical = realpathSync(directory);
    } catch {
      return fail("worktree-missing");
    }
    if (!physical.startsWith(realpathSync(this.worktreeRoot) + sep))
      return fail("worktree-outside-root");
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      const grant = this.gate(op);
      const r = await this.awaitOp(
        op,
        this.runOp(op, ["worktree", "remove", "--force", physical], {
          cwd: grant.directory,
        }),
      );
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "worktree-remove-failed");
      return { kind: "removed" };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  // ---- lifecycle --------------------------------------------------------------

  onProjectDeleted(projectId: string): void {
    const live = this.snapshots.get(projectId);
    if (live) {
      this.snapshots.delete(projectId);
      this.retire(projectId, live);
    }
    // Queued and running ops for this project die now: queued waiters
    // reject, live children get the observed-exit escalation, and the
    // gate stops every chain before its next spawn.
    for (const op of this.ops) {
      if (op.projectId === projectId) this.cancelOp(op);
    }
  }

  // ---- branch menu (F11) ---------------------------------------------------
  // The frozen BranchMenu ops act on the thread's execution directory —
  // the project checkout or an app-owned worktree; the caller passes `cwd`
  // already resolved and verified. Names are checked against the frozen
  // rules before reaching argv: spaces normalized to dashes, letters of
  // any script + digits + `-_./`, ≤60 chars, no case-insensitive
  // collision, real `check-ref-format`.

  private static normalizeBranch(raw: string): string {
    return raw.trim().replace(/\s+/g, "-");
  }

  /** The frozen for-each-ref row set: name/current/upstream, newest-first. */
  private async readBranches(op: Op, cwd: string): Promise<GitBranchRow[] | null> {
    const format = "%(HEAD)%09%(refname:short)%09%(upstream:short)";
    const r = await this.awaitOp(
      op,
      this.runOp(op, ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"], { cwd }),
    );
    if (r.code !== 0 || r.overflowed) return null;
    return r.stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const parts = l.split("\t");
        return {
          name: parts[1] ?? "",
          isCurrent: parts[0] === "*",
          ...(parts[2] ? { upstream: parts[2] } : {}),
        };
      })
      .filter((b) => b.name !== "");
  }

  /** Frozen `hasOperationInProgress`: git-dir markers for a half-done
   *  merge/rebase/cherry-pick/revert/bisect — renames refuse mid-op. */
  private async operationInProgress(op: Op, cwd: string): Promise<boolean> {
    const r = await this.awaitOp(
      op,
      this.runOp(op, ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd }),
    );
    const gitDir = r.stdout.trim();
    if (r.code !== 0 || gitDir === "") return true;
    for (const m of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"])
      if (existsSync(join(gitDir, m))) return true;
    return false;
  }

  /** Frozen `checkBranchName` — `old` set turns the call into a rename
   *  check (op-in-progress refusal, then the pushed-upstream gate). */
  private async checkBranchName(op: Op, cwd: string, raw: string, old?: string): Promise<BranchNameCheck> {
    const name = GitService.normalizeBranch(raw);
    // Frozen: an empty or unchanged name is no error — the alert just closes.
    if (name === "" || name === old) return { kind: "rejected", reason: "" };
    if ([...name].length > 60) return { kind: "rejected", reason: "branch-name-too-long" };
    if (![...name].every((c) => /[\p{L}\p{N}\-_./]/u.test(c)))
      return { kind: "rejected", reason: "branch-name-chars" };
    const fmt = await this.awaitOp(
      op,
      this.runOp(op, ["check-ref-format", "--branch", name], { cwd }),
    );
    if (fmt.code !== 0 || fmt.overflowed) return { kind: "rejected", reason: "branch-name-invalid" };
    const rows = (await this.readBranches(op, cwd)) ?? [];
    if (rows.some((b) => b.name !== old && b.name.toLowerCase() === name.toLowerCase()))
      return { kind: "rejected", reason: "branch-name-exists" };
    if (old === undefined) return { kind: "ok", name };
    if (await this.operationInProgress(op, cwd))
      return { kind: "rejected", reason: "branch-name-op-in-progress" };
    const upstream = rows.find((b) => b.name === old)?.upstream;
    if (upstream !== undefined) return { kind: "pushed", name, upstream };
    return { kind: "ok", name };
  }

  /** Frozen `branches()` — read-only list + detached-HEAD detection for
   *  the menu's "Switch branch" section and the button's current mark. */
  async branches(projectId: string, cwd: string): Promise<BranchListResult> {
    const fail = (r: string): BranchListResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      this.gate(op);
      const list = await this.readBranches(op, cwd);
      if (list === null) return fail("branches-failed");
      const head = await this.awaitOp(
        op,
        this.runOp(op, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd }),
      );
      return { kind: "ready", branches: list, detached: head.code !== 0 || head.stdout.trim() === "" };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** Frozen `switchBranch` — `git switch <name>`; the name must be a
   *  listed non-current branch (re-read inside the op — a forged or
   *  stale picker value can never reach argv). */
  async switchBranch(projectId: string, cwd: string, name: string): Promise<BranchOpResult> {
    const fail = (r: string): BranchOpResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      this.gate(op);
      const list = await this.readBranches(op, cwd);
      if (list === null) return fail("branches-failed");
      const target = list.find((b) => b.name === name);
      if (!target) return fail("branch-unknown");
      if (target.isCurrent) return fail("branch-current");
      const r = await this.awaitOp(op, this.runOp(op, ["switch", name], { cwd }));
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "switch-failed");
      return { kind: "ok", branch: name };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** Frozen `createBranch` — `git switch -c <name>` after the frozen
   *  name check (no `renaming` side of the gate). */
  async createBranch(projectId: string, cwd: string, rawName: string): Promise<BranchOpResult> {
    const fail = (r: string): BranchOpResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      this.gate(op);
      const check = await this.checkBranchName(op, cwd, rawName);
      if (check.kind !== "ok")
        return check.kind === "rejected" ? { kind: "rejected", reason: check.reason } : fail("branch-name-conflict");
      const r = await this.awaitOp(op, this.runOp(op, ["switch", "-c", check.name], { cwd }));
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "create-failed");
      return { kind: "ok", branch: check.name };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  /** Frozen `renameBranch` — `git branch -m <old> <new>`. With an
   *  upstream the frozen check reports `pushed` instead of renaming;
   *  `confirmedPushed` is the renderer's second call after the user saw
   *  the frozen warning. `old` is the branch actually checked out in
   *  `cwd` — derived live, never trusted from the renderer. */
  async renameBranch(
    projectId: string,
    cwd: string,
    rawNew: string,
    confirmedPushed: boolean,
  ): Promise<BranchOpResult> {
    const fail = (r: string): BranchOpResult => ({ kind: "unavailable", reason: r });
    if (this.unavailableReason) return fail(this.unavailableReason);
    const op = this.newOp(projectId);
    let acquired = false;
    try {
      await this.acquire(op);
      acquired = true;
      this.gate(op);
      const head = await this.awaitOp(
        op,
        this.runOp(op, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd }),
      );
      const old = head.stdout.trim();
      if (head.code !== 0 || old === "") return fail("detached-head");
      const check = await this.checkBranchName(op, cwd, rawNew, old);
      if (check.kind === "rejected") return { kind: "rejected", reason: check.reason };
      if (check.kind === "pushed" && !confirmedPushed) return check;
      const name = check.kind === "pushed" ? check.name : check.kind === "ok" ? check.name : null;
      if (name === null) return fail("branch-name-conflict");
      const r = await this.awaitOp(op, this.runOp(op, ["branch", "-m", old, name], { cwd }));
      if (r.code !== 0) return fail(r.stderr.trim().slice(0, 300) || "rename-failed");
      return { kind: "ok", branch: name, oldBranch: old };
    } catch (e) {
      return fail(reason(e));
    } finally {
      if (acquired) this.release();
      op.settle();
    }
  }

  async dispose(): Promise<{ problems: string[] }> {
    this.disposed = true;
    // Stop admission synchronously and fail the pending queue at once.
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
      if (outcome === "timeout") {
        problems.push(
          `git: ${this.ops.size} operation(s) did not settle within ${this.disposeTimeoutMs}ms — records and views retained for a later dispose retry`,
        );
      }
    }
    // Any child still live after the wait is an unconfirmed exit — a
    // problem, never a silent assumption.
    const stillLive = this.runner.active().size;
    if (stillLive > 0) problems.push(`git: ${stillLive} child process(es) not observed exited`);
    // Unproven executor cleanups (Windows job-helper): sticky — they are
    // reported on EVERY dispose, never claimed away.
    for (const u of this.runner.unprovenCleanups?.() ?? [])
      problems.push(`git: ${u} — retained for a later dispose retry`);
    if (problems.length === 0) {
      try {
        rmSync(this.viewRoot, { recursive: true, force: true });
      } catch (e) {
        problems.push(`git view cleanup failed: ${reason(e)}`);
      }
    }
    return { problems };
  }
}

function snap(projectId: string, kind: GitSnapshot["kind"], extra?: { reason?: string }): GitSnapshot {
  return {
    snapshotId: randomUUID(),
    projectId,
    capturedAt: Date.now(),
    kind,
    entries: [],
    limitations: [],
    ...(extra?.reason ? { reason: extra.reason } : {}),
  };
}
