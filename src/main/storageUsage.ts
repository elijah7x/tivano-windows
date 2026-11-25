// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-54: Main-process Storage measurement, regenerable-file cleanup,
// safe worktree removal, and cleanup-review draft prefill.

import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, posix, resolve, win32 } from "node:path";
import type { Engine } from "./engine";
import {
  gitChildEnv,
  makeGitRunner,
  type GitRunResult,
  type GitRunner,
} from "./gitExec";
import {
  BUILD_FOLDER_NAMES,
  buildWorktreeReviewPromptText,
  type RuntimeStorageUsage,
  type StorageCleanOptions,
  type StorageCleanResult,
  type StorageUsageReport,
  type StorageWorktreeUsage,
} from "../shared/storage";
import type { ChatThread, Project } from "../shared/types";

function normalizePathForCompare(p: string): string {
  const isWin = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  const norm = (isWin ? win32 : posix).normalize(p).replace(/[\\/]+$/, "");
  return isWin ? norm.toLowerCase() : norm;
}

function pathInsideOrEqual(candidate: string, parent: string): boolean {
  const a = normalizePathForCompare(candidate);
  const b = normalizePathForCompare(parent);
  if (a === b) return true;
  const sep = a.includes("\\") || b.includes("\\") ? "\\" : "/";
  return a.startsWith(b + sep);
}

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StorageServiceDeps {
  dataRoot: string;
  engine: Engine;
  gitExe?: string;
  platform?: NodeJS.Platform;
  runner?: GitRunner;
  runGit?: (cwd: string, args: string[]) => Promise<GitRunResult>;
}

interface ScannedWorktree {
  id: string;
  name: string;
  absPath: string;
  isRegistered: boolean;
  changedFiles: number | null;
  branch: string | null;
  lastCommitAt: number | null;
  buildFolders: string[];
  sizeBytes: number;
  buildFilesSizeBytes: number;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(rootPath: string, skipDirs?: Set<string>): Promise<number> {
  let st;
  try {
    st = await lstat(rootPath);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;

  let total = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs?.has(normalizePathForCompare(full))) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const fst = await lstat(full);
          if (!fst.isSymbolicLink()) total += fst.size;
        } catch {
          /* ignore disappearing files */
        }
      }
    }
  }
  return total;
}

export class StorageService {
  private readonly dataRoot: string;
  private readonly worktreesDir: string;
  private readonly engine: Engine;
  private readonly runGitFn: (cwd: string, args: string[]) => Promise<GitRunResult>;

  constructor(deps: StorageServiceDeps) {
    this.dataRoot = deps.dataRoot;
    this.worktreesDir = join(deps.dataRoot, "worktrees");
    this.engine = deps.engine;
    if (deps.runGit) {
      this.runGitFn = deps.runGit;
    } else {
      const platform = deps.platform ?? process.platform;
      const gitExe = deps.gitExe || "git";
      const runner = deps.runner ?? makeGitRunner(gitExe);
      const env = gitChildEnv(join(deps.dataRoot, "git-home"), undefined, {
        platform,
        executable: gitExe,
      });
      this.runGitFn = (cwd, args) =>
        runner.run(args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES }).done;
    }
  }

  private async collectDiagnosticTargets(): Promise<{
    totalBytes: number;
    cleanablePaths: string[];
    cleanableBytes: number;
  }> {
    let totalBytes = 0;
    const cleanablePaths: string[] = [];
    let cleanableBytes = 0;
    const hangFiles: { path: string; mtimeMs: number; size: number }[] = [];

    for (const dirName of ["diagnostics", "logs"]) {
      const dir = join(this.dataRoot, dirName);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        totalBytes += st.size;
        if (/^hang-.*\.txt$/i.test(entry.name)) {
          hangFiles.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        } else if (/\.log\.\d+$/i.test(entry.name) || /\.old\.log$/i.test(entry.name)) {
          cleanablePaths.push(full);
          cleanableBytes += st.size;
        }
      }
    }

    // Keep the newest hang report; older hang reports are cleanable.
    hangFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    for (const old of hangFiles.slice(1)) {
      cleanablePaths.push(old.path);
      cleanableBytes += old.size;
    }

    return { totalBytes, cleanablePaths, cleanableBytes };
  }

  private async collectUpdateTargets(): Promise<{
    totalBytes: number;
    cleanablePaths: string[];
    cleanableBytes: number;
  }> {
    const dir = join(this.dataRoot, "updates");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { totalBytes: 0, cleanablePaths: [], cleanableBytes: 0 };
    }

    let totalBytes = 0;
    const cleanablePaths: string[] = [];
    let cleanableBytes = 0;

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const size = await directorySize(full);
      totalBytes += size;
      // Preserve pending and rollback directories/markers.
      if (/^(pending|rollback)/i.test(entry.name)) continue;
      cleanablePaths.push(full);
      cleanableBytes += size;
    }

    return { totalBytes, cleanablePaths, cleanableBytes };
  }

  private async discoverWorktreeDirs(knownProjectIds: Set<string>): Promise<
    { id: string; name: string; absPath: string }[]
  > {
    let entries;
    try {
      entries = await readdir(this.worktreesDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: { id: string; name: string; absPath: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const entryPath = join(this.worktreesDir, entry.name);
      if (await pathExists(join(entryPath, ".git"))) {
        out.push({ id: entry.name, name: entry.name, absPath: entryPath });
        continue;
      }
      if (UUID_RE.test(entry.name) || knownProjectIds.has(entry.name)) {
        let subEntries;
        try {
          subEntries = await readdir(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subEntries) {
          if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
          out.push({
            id: `${entry.name}/${sub.name}`,
            name: sub.name,
            absPath: join(entryPath, sub.name),
          });
        }
        continue;
      }
      out.push({ id: entry.name, name: entry.name, absPath: entryPath });
    }
    return out;
  }

  private async scanWorktree(item: {
    id: string;
    name: string;
    absPath: string;
  }): Promise<ScannedWorktree> {
    const isRegistered = await pathExists(join(item.absPath, ".git"));
    let changedFiles: number | null = null;
    let branch: string | null = null;
    let lastCommitAt: number | null = null;
    const buildFolders: string[] = [];

    if (isRegistered) {
      const statusRes = await this.runGitFn(item.absPath, [
        "status",
        "--porcelain=v1",
        "--ignored",
        "-z",
        "--untracked-files=normal",
      ]);
      if (statusRes.code === 0 && !statusRes.spawnError && !statusRes.executorFailed) {
        let changed = 0;
        const records = statusRes.stdout.split("\0").filter(Boolean);
        for (const rec of records) {
          if (rec.startsWith("!! ")) {
            if (!rec.endsWith("/")) continue;
            const rel = rec.slice(3, -1);
            const name = basename(rel);
            if (BUILD_FOLDER_NAMES.has(name)) {
              buildFolders.push(join(item.absPath, rel));
            }
          } else {
            changed++;
          }
        }
        changedFiles = changed;
      }

      const branchRes = await this.runGitFn(item.absPath, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      if (branchRes.code === 0 && !branchRes.spawnError) {
        const b = branchRes.stdout.trim();
        if (b && b !== "HEAD") branch = b;
      }

      const logRes = await this.runGitFn(item.absPath, [
        "log",
        "-1",
        "--format=%ct",
        "HEAD",
      ]);
      if (logRes.code === 0 && !logRes.spawnError) {
        const sec = Number(logRes.stdout.trim());
        if (Number.isFinite(sec) && sec > 0) lastCommitAt = sec * 1000;
      }
    }

    const skipSet = new Set<string>();
    let buildFilesSizeBytes = 0;
    for (const bf of buildFolders) {
      skipSet.add(normalizePathForCompare(bf));
      buildFilesSizeBytes += await directorySize(bf);
    }
    const remainingBytes = await directorySize(item.absPath, skipSet);

    return {
      id: item.id,
      name: item.name,
      absPath: item.absPath,
      isRegistered,
      changedFiles,
      branch,
      lastCommitAt,
      buildFolders,
      sizeBytes: remainingBytes + buildFilesSizeBytes,
      buildFilesSizeBytes,
    };
  }

  private classifyWorktree(
    wt: ScannedWorktree,
    threads: readonly ChatThread[],
    projects: readonly Project[],
  ): StorageWorktreeUsage {
    const users = threads.filter((t) => {
      const candidates = [t.worktreeDir, t.hydraHead?.targetCheckout].filter(
        (c): c is string => typeof c === "string" && c.length > 0,
      );
      return candidates.some((c) => pathInsideOrEqual(c, wt.absPath));
    });
    const usedByProject = projects.some(
      (p) => typeof p.directory === "string" && p.directory.length > 0 && pathInsideOrEqual(p.directory, wt.absPath),
    );
    const isIdle = users.every((t) => t.isArchived === true) && !usedByProject;
    const canRemove =
      users.length === 0 &&
      !usedByProject &&
      (wt.isRegistered ? wt.changedFiles === 0 : true);

    let removeReason: StorageWorktreeUsage["removeReason"] = null;
    if (!canRemove) {
      if (users.length > 0) removeReason = "active-or-archived-chat";
      else if ((wt.changedFiles ?? 0) > 0) removeReason = "uncommitted-changes";
      else removeReason = "project-in-use";
    }

    const preferred =
      users.find((t) => !t.parentThreadId) ?? users[0] ?? null;

    return {
      id: wt.id,
      name: wt.name,
      sizeBytes: wt.sizeBytes,
      buildFilesSizeBytes: wt.buildFilesSizeBytes,
      buildFolderCount: wt.buildFolders.length,
      isRegistered: wt.isRegistered,
      changedFiles: wt.changedFiles,
      branch: wt.branch,
      lastCommitAt: wt.lastCommitAt,
      isIdle,
      canRemove,
      removeReason,
      usedByThreadTitle: preferred?.title ?? null,
      usedByArchived: preferred?.isArchived === true,
    };
  }

  private async measureScanned(): Promise<{
    report: StorageUsageReport;
    scanned: ScannedWorktree[];
    diagCleanable: string[];
    updateCleanable: string[];
  }> {
    const snap = this.engine.snapshot();
    const projectIds = new Set(snap.projects.map((p) => p.id));

    const [
      storeSize,
      turnsSize,
      checkpointsSize,
      attachmentsBytes,
      patchesBytes,
      diag,
      upd,
      wtItems,
    ] = await Promise.all([
      directorySize(join(this.dataRoot, "store.json")),
      directorySize(join(this.dataRoot, "turns")),
      directorySize(join(this.dataRoot, "checkpoints")),
      directorySize(join(this.dataRoot, "attachments")),
      directorySize(join(this.dataRoot, "hydra-patches")),
      this.collectDiagnosticTargets(),
      this.collectUpdateTargets(),
      this.discoverWorktreeDirs(projectIds),
    ]);

    const scanned = await Promise.all(wtItems.map((item) => this.scanWorktree(item)));
    scanned.sort((a, b) => b.sizeBytes - a.sizeBytes);

    const worktrees = scanned.map((wt) =>
      this.classifyWorktree(wt, snap.threads, snap.projects),
    );

    const diagnostics: RuntimeStorageUsage = {
      totalBytes: diag.totalBytes,
      cleanableBytes: diag.cleanableBytes,
      supported: true,
    };
    const updates: RuntimeStorageUsage = {
      totalBytes: upd.totalBytes,
      cleanableBytes: upd.cleanableBytes,
      supported: false,
    };

    return {
      report: {
        chatsBytes: storeSize + turnsSize + checkpointsSize,
        attachmentsBytes,
        patchesBytes,
        diagnostics,
        updates,
        worktrees,
        worktreesDir: this.worktreesDir,
      },
      scanned,
      diagCleanable: diag.cleanablePaths,
      updateCleanable: upd.cleanablePaths,
    };
  }

  async measure(): Promise<StorageUsageReport> {
    return (await this.measureScanned()).report;
  }

  private async removeBuildFolders(wt: ScannedWorktree): Promise<void> {
    let realRoot: string;
    try {
      realRoot = await realpath(wt.absPath);
    } catch {
      return;
    }
    const rootPrefix = normalizePathForCompare(realRoot) + (realRoot.includes("\\") ? "\\" : "/");

    for (const folder of wt.buildFolders) {
      if (!BUILD_FOLDER_NAMES.has(basename(folder))) continue;
      let realFolder: string;
      try {
        const lst = await lstat(folder);
        if (!lst.isDirectory() || lst.isSymbolicLink()) continue;
        realFolder = await realpath(folder);
        const fst = await lstat(realFolder);
        if (!fst.isDirectory() || fst.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (!normalizePathForCompare(realFolder).startsWith(rootPrefix)) continue;

      const ignoreCheck = await this.runGitFn(wt.absPath, [
        "check-ignore",
        "-q",
        realFolder,
      ]);
      if (ignoreCheck.code === 1) continue;
      if (ignoreCheck.code !== 0) throw new Error(ignoreCheck.stderr.trim() || "git check-ignore failed");

      const tracked = await this.runGitFn(wt.absPath, [
        "--literal-pathspecs",
        "ls-files",
        "--cached",
        "-z",
        "--",
        realFolder,
      ]);
      if (tracked.code !== 0 || tracked.stdout.length > 0) continue;

      await rm(realFolder, { recursive: true, force: true });
    }
  }

  async clean(options: StorageCleanOptions): Promise<StorageCleanResult> {
    const { scanned, diagCleanable, updateCleanable } = await this.measureScanned();
    const snap = this.engine.snapshot();
    const errors: string[] = [];

    for (const wt of scanned) {
      if (wt.buildFolders.length === 0) continue;
      const classified = this.classifyWorktree(wt, snap.threads, snap.projects);
      const want = classified.isIdle ? options.idleWorktrees : options.activeWorktrees;
      if (!want) continue;
      try {
        await this.removeBuildFolders(wt);
      } catch (e) {
        errors.push(`${wt.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (options.diagnostics) {
      for (const target of diagCleanable) {
        try {
          await rm(target, { recursive: true, force: true });
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
    }

    if (options.updates) {
      for (const target of updateCleanable) {
        try {
          await rm(target, { recursive: true, force: true });
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
    }

    const usage = await this.measure();
    return {
      usage,
      ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
    };
  }

  async removeWorktree(
    id: string,
    buildFilesOnly = false,
  ): Promise<StorageCleanResult> {
    if (!id || id.includes("..") || id.startsWith("/") || id.startsWith("\\")) {
      throw new Error("invalid worktree id");
    }
    await mkdir(this.worktreesDir, { recursive: true });
    const rootReal = await realpath(this.worktreesDir);
    const candidate = resolve(rootReal, ...id.split("/"));
    const targetReal = await realpath(candidate);
    const rootNorm = normalizePathForCompare(rootReal);
    const targetNorm = normalizePathForCompare(targetReal);
    if (
      targetNorm === rootNorm ||
      !targetNorm.startsWith(rootNorm + (rootReal.includes("\\") ? "\\" : "/"))
    ) {
      throw new Error("worktree outside managed root");
    }

    const { scanned } = await this.measureScanned();
    const match = scanned.find((w) => w.id === id);
    if (!match) throw new Error("worktree not found");

    if (buildFilesOnly) {
      await this.removeBuildFolders(match);
      return { usage: await this.measure() };
    }

    const snap = this.engine.snapshot();
    const classified = this.classifyWorktree(match, snap.threads, snap.projects);
    if (!classified.canRemove) {
      throw new Error("worktree cannot be removed while in use or dirty");
    }

    if (match.isRegistered) {
      const common = await this.runGitFn(match.absPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (common.code !== 0 || !common.stdout.trim()) {
        throw new Error(common.stderr.trim() || "could not locate repository");
      }
      const rem = await this.runGitFn(common.stdout.trim(), [
        "worktree",
        "remove",
        match.absPath,
      ]);
      if (rem.code !== 0) {
        throw new Error(rem.stderr.trim() || "git worktree remove failed");
      }
    } else {
      await rm(match.absPath, { recursive: true, force: true });
    }

    return { usage: await this.measure() };
  }

  async reviewPrompt(): Promise<string> {
    const usage = await this.measure();
    const snap = this.engine.snapshot();
    return buildWorktreeReviewPromptText(usage, snap.threads, snap.projects);
  }

  async startWorktreeReview(): Promise<{ threadId: string; text: string }> {
    const text = await this.reviewPrompt();
    const thread = this.engine.createThread(null);
    this.engine.selectThread(thread.id);
    return { threadId: thread.id, text };
  }
}
