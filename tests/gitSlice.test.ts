// Read-only Git slice tests. Real /usr/bin/git fixtures inside isolated
// temp repos; the service under test always reads through the controlled
// ephemeral metadata view — the original .git must stay byte-identical and
// configured helpers/filters/fsmonitor hooks must never execute.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { GitService, MAX_CONCURRENT_OPS } from "../src/main/gitService";
import type { GitRunResult, GitRunner } from "../src/main/gitExec";
import {
  parseIndexExtensions,
  parseNumstatZ,
  parsePorcelainV2,
  probeRepo,
} from "../src/main/gitView";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import type { AppEvent } from "../src/shared/ipc";
import type { GitSnapshot } from "../src/shared/types";

const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
const haveGit = (() => {
  try {
    execFileSync(GIT, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// win32 GitService deliberately refuses direct Git without an injected
// contained runner ("git-containment"): the real-git-op suites below are
// POSIX coverage. The simulated win32/contained sections still run here.
const haveDirectGit = haveGit && process.platform !== "win32";
// The service's gitExe gate is existsSync — injected runners still need a
// REAL absolute path on Windows, so resolve the binary once.
const GIT_ABS = (() => {
  if (process.platform !== "win32") return GIT;
  try {
    return execFileSync("where.exe", ["git.exe"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? GIT;
  } catch {
    return GIT;
  }
})();

const dirs: string[] = [];
const stores: Store[] = [];
const services: GitService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const st of stores.splice(0)) st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = "tivano-p2f-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Fixture-side git — a fresh env so user-global config never interferes. */
function git(dir: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd: dir,
    env: {
      PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_LITERAL_PATHSPECS: "1",
    },
    encoding: "utf8",
  });
}

function mkRepo(dir?: string): string {
  const d = dir ?? tmp("repo-");
  mkdirSync(d, { recursive: true });
  git(d, ["init", "-b", "main"]);
  git(d, ["config", "user.email", "test@example.com"]);
  git(d, ["config", "user.name", "Test"]);
  return d;
}

function commitAll(dir: string, msg = "c"): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", msg]);
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

interface Rig {
  service: GitService;
  engine: Engine;
  paths: ProjectRuntimePaths;
  projectId: string;
  threadId: string;
  mutable: { v: boolean };
  events: AppEvent[];
  dataRoot: string;
}

function rig(opts: {
  repoDir: string;
  gitExe?: string;
  runner?: GitRunner;
  mutable?: boolean;
  platform?: NodeJS.Platform;
  unavailableReason?: string;
}): Rig {
  const dataRoot = tmp("data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const project = engine.createProject("p");
  paths.registerUser(project.id, opts.repoDir);
  const thread = engine.createThread(project.id);
  const mutable = { v: opts.mutable ?? true };
  const events: AppEvent[] = [];
  const service = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => mutable.v,
    emit: (e) => events.push(e),
    dataRoot,
    ...(opts.gitExe ? { gitExe: opts.gitExe } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.unavailableReason ? { unavailableReason: opts.unavailableReason } : {}),
  });
  services.push(service);
  return { service, engine, paths, projectId: project.id, threadId: thread.id, mutable, events, dataRoot };
}

const canned = (r: Partial<GitRunResult>): GitRunner => ({
  run: () => ({
    done: Promise.resolve({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      overflowed: false,
      cancelled: false,
      ...r,
    }),
    cancel: () => {},
    pid: 1,
  }),
  active: () => new Set(),
});

describe.skipIf(!haveDirectGit)("gitView parsers", () => {
  it("parses porcelain v2 -z headers and all record kinds structurally", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 h1 h2 staged only.txt",
      "1 .M N... 100644 100644 100644 h1 h2 work tree file.txt",
      "2 R. N... 100644 100644 100644 h1 h2 R87 new name.txt\0old name.txt",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflicted.txt",
      "? untracked with ünïcode.txt",
      "! ignored.o",
      "",
    ].join("\0");
    const p = parsePorcelainV2(out);
    expect(p.header).toEqual({ oid: "abc123", head: "main", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(p.entries).toHaveLength(6);
    expect(p.entries[0]).toMatchObject({ raw: "1", xy: "M.", path: "staged only.txt" });
    expect(p.entries[1]).toMatchObject({ xy: ".M", path: "work tree file.txt" });
    expect(p.entries[2]).toMatchObject({ raw: "2", score: "R87", path: "new name.txt", origPath: "old name.txt" });
    expect(p.entries[3]).toMatchObject({ raw: "u", xy: "UU", path: "conflicted.txt", modeWorktree: "100644" });
    expect(p.entries[4]).toMatchObject({ raw: "?", path: "untracked with ünïcode.txt" });
    expect(p.entries[5]).toMatchObject({ raw: "!", path: "ignored.o" });
  });

  it("keeps filenames with embedded newlines and pathspec-looking names", () => {
    const out = "1 .M N... 100644 100644 100644 h1 h2 a\nb.txt\0? :(glob)\0? *.txt\0";
    const p = parsePorcelainV2(out);
    expect(p.entries.map((e) => e.path)).toEqual(["a\nb.txt", ":(glob)", "*.txt"]);
  });

  it("truncates entries at the cap", () => {
    const recs = Array.from({ length: 6000 }, (_, i) => `1 .M N... 100644 100644 100644 h h f${i}`).join("\0");
    const p = parsePorcelainV2(recs);
    expect(p.entries).toHaveLength(5000);
    expect(p.truncated).toBe(true);
  });

  it("parses numstat -z including binary and rename records", () => {
    // NB: "\0" followed by a digit is an OCTAL escape in JS literals.
    const out = "3\t1\tfile.txt\u0000-\t-\tbin.dat\u00005\t2\t\u0000old.txt\u0000new.txt\u0000";
    const p = parseNumstatZ(out);
    expect(p).toEqual([
      { paths: ["file.txt"], binary: false },
      { paths: ["bin.dat"], binary: true },
      { paths: ["old.txt", "new.txt"], binary: false },
    ]);
  });

  it("detects split/sparse index signatures and rejects malformed buffers", () => {
    const header = Buffer.concat([
      Buffer.from("DIRC"),
      (() => { const b = Buffer.alloc(8); b.writeUInt32BE(2, 0); b.writeUInt32BE(0, 4); return b; })(),
    ]);
    const ext = (sig: string, body: Buffer): Buffer =>
      Buffer.concat([Buffer.from(sig), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(body.length); return b; })(), body]);
    const tail = Buffer.alloc(20);
    expect(parseIndexExtensions(Buffer.concat([header, tail]), "sha1").extensions).toEqual([]);
    expect(
      parseIndexExtensions(Buffer.concat([header, ext("link", Buffer.alloc(40)), tail]), "sha1").extensions,
    ).toContain("link");
    expect(
      parseIndexExtensions(Buffer.concat([header, ext("sdir", Buffer.alloc(4)), tail]), "sha1").extensions,
    ).toContain("sdir");
    expect(() => parseIndexExtensions(Buffer.from("NOPE"), "sha1")).toThrow();
  });
});

describe.skipIf(!haveDirectGit)("GitService — real git fixtures", () => {
  it("reports a clean repository with branch identity", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.branch).toMatchObject({ name: "main", detached: false, unborn: false });
    expect(s.entries).toEqual([]);
    expect(r.service.overview(r.projectId).snapshotId).toBe(s.snapshotId);
  });

  it("reports an unborn branch on a commit-free repository", async () => {
    const dir = mkRepo();
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.branch?.unborn).toBe(true);
    expect(s.branch?.name).toBe("main");
  });

  it("reports detached HEAD with its oid", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    git(dir, ["checkout", "--detach", "HEAD"]);
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.branch?.detached).toBe(true);
    expect(s.branch?.name).toBeNull();
    expect(s.branch?.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("separates staged, unstaged, untracked and produces both diff sides", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "mod.txt"), "one\n");
    writeFileSync(join(dir, "staged-new.txt"), "s0\n");
    commitAll(dir);
    writeFileSync(join(dir, "mod.txt"), "one\ntwo\n");
    git(dir, ["add", "mod.txt"]); // staged change
    writeFileSync(join(dir, "mod.txt"), "one\ntwo\nthree\n"); // + unstaged
    writeFileSync(join(dir, "brand-new.txt"), "n\n"); // staged add
    git(dir, ["add", "brand-new.txt"]);
    writeFileSync(join(dir, "untracked.txt"), "u\n");

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    const byPath = new Map(s.entries.map((e) => [e.path, e]));
    expect(byPath.get("mod.txt")).toMatchObject({ staged: "M", unstaged: "M", kind: "modified" });
    expect(byPath.get("brand-new.txt")).toMatchObject({ staged: "A", kind: "added" });
    expect(byPath.get("untracked.txt")).toMatchObject({ kind: "untracked", untracked: true });

    const mod = byPath.get("mod.txt")!;
    const stagedDiff = await r.service.diff(r.projectId, s.snapshotId, mod.id, "staged");
    expect(stagedDiff.kind).toBe("text");
    expect(stagedDiff.patch).toContain("+two");
    expect(stagedDiff.patch).not.toContain("+three");
    const wtDiff = await r.service.diff(r.projectId, s.snapshotId, mod.id, "worktree");
    expect(wtDiff.kind).toBe("text");
    expect(wtDiff.patch).toContain("+three");

    const untracked = byPath.get("untracked.txt")!;
    const ud = await r.service.diff(r.projectId, s.snapshotId, untracked.id, "worktree");
    expect(ud.kind).toBe("unavailable");
  });

  it("preserves rename identity and diffs both rename paths", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "before.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
    commitAll(dir);
    git(dir, ["mv", "before.txt", "after.txt"]);
    writeFileSync(join(dir, "after.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n");
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    const e = s.entries.find((x) => x.path === "after.txt");
    expect(e).toMatchObject({ kind: "renamed", origPath: "before.txt" });
    const d = await r.service.diff(r.projectId, s.snapshotId, e!.id, "staged");
    expect(d.kind).toBe("text");
    expect(d.patch).toContain("rename from before.txt");
    expect(d.patch).toContain("rename to after.txt");
  });

  it("marks binary diffs and never emits their bytes", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 4]));
    commitAll(dir);
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 9, 0, 4, 5]));
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    const e = s.entries.find((x) => x.path === "bin.dat")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d.kind).toBe("binary");
    expect(d.patch).toBeUndefined();
  });

  it("bounds an oversized diff instead of streaming it", async () => {
    const dir = mkRepo();
    const line = "x".repeat(48);
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 50000 }, (_, i) => `${i}${line}`).join("\n"));
    commitAll(dir);
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 50000 }, (_, i) => `${i}${line}Y`).join("\n"));
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    const e = s.entries.find((x) => x.path === "big.txt")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d.kind).toBe("oversized");
  }, 30_000);

  it("reports conflicted entries and refuses their diffs", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "base\n");
    commitAll(dir, "base");
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "f.txt"), "side\n");
    commitAll(dir, "side");
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "f.txt"), "main\n");
    commitAll(dir, "main");
    try {
      git(dir, ["merge", "side"]);
    } catch {
      /* merge conflicts exit non-zero — that IS the fixture */
    }
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    const e = s.entries.find((x) => x.path === "f.txt");
    expect(e).toMatchObject({ kind: "unmerged", unmerged: true });
    expect(e!.canDiffStaged).toBe(false);
    expect(e!.canDiffWorktree).toBe(false);
    const d = await r.service.diff(r.projectId, s.snapshotId, e!.id, "worktree");
    expect(d).toMatchObject({ kind: "unavailable", reason: "not-diffable" });
  });

  it("reads a linked worktree through its own index and HEAD", async () => {
    const main = mkRepo();
    writeFileSync(join(main, "f.txt"), "a\n");
    commitAll(main);
    const wt = join(tmp("linked-parent"), "wt");
    git(main, ["worktree", "add", "-b", "linked", wt]);
    writeFileSync(join(wt, "f.txt"), "a\nb\n");
    const r = rig({ repoDir: wt });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.branch?.name).toBe("linked");
    expect(s.entries.find((e) => e.path === "f.txt")).toMatchObject({ unstaged: "M" });
    const e = s.entries.find((x) => x.path === "f.txt")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d.kind).toBe("text");
  });

  it("reports a non-repository directory honestly", async () => {
    const dir = tmp("plain-");
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("not-repository");
  });

  it("never searches above the grant for a repository", async () => {
    const parent = mkRepo(); // repository in the PARENT of the grant
    const child = join(parent, "sub");
    mkdirSync(child);
    const r = rig({ repoDir: child });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("not-repository"); // ceiling-bound — never the parent repo
  });

  it("keeps pathspec-looking and newline filenames literal", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, ":(glob)"), "one\n");
    writeFileSync(join(dir, "a\nb.txt"), "one\n");
    commitAll(dir);
    writeFileSync(join(dir, ":(glob)"), "two\n");
    writeFileSync(join(dir, "a\nb.txt"), "two\n");
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    const paths = s.entries.map((e) => e.path);
    expect(paths).toContain(":(glob)");
    expect(paths).toContain("a\nb.txt");
    for (const e of s.entries) {
      const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
      expect(d.kind).toBe("text");
    }
  });

  it("never executes configured filters/fsmonitor helpers and marks worktree diffs unavailable", async () => {
    const dir = mkRepo();
    const marker = join(dir, "HELPER-RAN");
    const script = join(dir, "evil.sh");
    writeFileSync(join(dir, "f.txt"), "one\n");
    commitAll(dir);
    // Configure helpers AFTER commits so fixture setup itself never runs them.
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    execFileSync("/bin/chmod", ["+x", script]);
    git(dir, ["config", "filter.up.clean", `sh "${script}"`]);
    git(dir, ["config", "filter.up.required", "true"]);
    git(dir, ["config", "core.fsmonitor", `sh "${script}"`]);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=up\n");
    writeFileSync(join(dir, "f.txt"), "two\n");

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.limitations).toContain("filters");
    const e = s.entries.find((x) => x.path === "f.txt")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d).toMatchObject({ kind: "unavailable", reason: "filters" });
    expect(existsSync(marker)).toBe(false); // helper + fsmonitor never ran
  });

  it("never executes clean/process/fsmonitor/external-diff/textconv helpers", async () => {
    const dir = mkRepo();
    const marker = join(dir, "HELPER-RAN");
    const script = join(dir, "evil.sh");
    writeFileSync(join(dir, "f.txt"), "one\n");
    commitAll(dir);
    // Stage a change BEFORE any filter configuration so the fixture's own
    // `git add` never executes the helper.
    writeFileSync(join(dir, "f.txt"), "two\n");
    git(dir, ["add", "f.txt"]);
    writeFileSync(join(dir, "f.txt"), "three\n"); // plus an unstaged change
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    execFileSync("/bin/chmod", ["+x", script]);
    // Every repo-configured executable surface the probe could reach.
    git(dir, ["config", "filter.up.clean", `sh "${script}"`]);
    git(dir, ["config", "filter.up.smudge", `sh "${script}"`]);
    git(dir, ["config", "filter.up.process", `sh "${script}"`]);
    git(dir, ["config", "filter.up.required", "true"]);
    git(dir, ["config", "diff.up.textconv", `sh "${script}"`]);
    git(dir, ["config", "diff.up.command", `sh "${script}"`]);
    git(dir, ["config", "core.fsmonitor", `sh "${script}"`]);
    git(dir, ["config", "core.pager", `sh "${script}"`]);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=up diff=up\n");

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.limitations).toContain("filters");
    const e = s.entries.find((x) => x.path === "f.txt")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d).toMatchObject({ kind: "unavailable", reason: "filters" });
    const staged = await r.service.diff(r.projectId, s.snapshotId, e.id, "staged");
    // Staged object comparisons survive a filter refusal.
    expect(staged.kind).toBe("text");
    expect(staged.kind === "text" && staged.patch!.includes("+two")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a worktree diff when the filter attribute appears AFTER refresh", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "one\n");
    commitAll(dir);
    const marker = join(dir, "HELPER-RAN");
    const script = join(dir, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    execFileSync("/bin/chmod", ["+x", script]);
    git(dir, ["config", "filter.up.clean", `sh "${script}"`]);
    writeFileSync(join(dir, "f.txt"), "two\n");

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    const e = s.entries.find((x) => x.path === "f.txt")!;
    // Attributes change after the refresh: check-attr must consult the
    // CURRENT worktree, not the cached helpersPresent boolean.
    writeFileSync(join(dir, ".gitattributes"), "f.txt filter=up\n");
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d).toMatchObject({ kind: "unavailable", reason: "filters" });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports an oversized index as unavailable, never as an empty repo", async () => {
    // The lead probe: a 34 MiB index was silently dropped, producing a
    // bogus "ready" snapshot showing the file as deleted + untracked.
    const dir = mkRepo();
    writeFileSync(join(dir, "file.txt"), "base\n");
    commitAll(dir);
    const fd = openSync(join(dir, ".git", "index"), "r+");
    ftruncateSync(fd, 34 * 1024 * 1024);
    closeSync(fd);

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).not.toBe("ready");
    expect(s.kind).toBe("unavailable");
    expect(s.entries).toHaveLength(0);
    expect(s.reason).toMatch(/capture|large/);
  });

  it("distinguishes unreadable/non-regular index files from absent ones", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    const idx = join(dir, ".git", "index");
    const r1 = rig({ repoDir: dir });
    chmodSync(idx, 0o000);
    const s1 = await r1.service.refresh(r1.projectId);
    chmodSync(idx, 0o644);
    expect(s1.kind).toBe("unavailable");
    expect(s1.reason).toMatch(/capture/);

    const dir2 = mkRepo();
    writeFileSync(join(dir2, "f.txt"), "a\n");
    commitAll(dir2);
    rmSync(join(dir2, ".git", "index"));
    mkdirSync(join(dir2, ".git", "index")); // a directory where a file is required
    const r2 = rig({ repoDir: dir2 });
    const s2 = await r2.service.refresh(r2.projectId);
    expect(s2.kind).toBe("unavailable");
    expect(s2.reason).toMatch(/capture/);
  });

  it("bounds ref traversal against a symlink cycle", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    // refs/heads/loop -> ../../.. would recurse forever via stat().
    symlinkSync(join("..", ".."), join(dir, ".git", "refs", "heads", "loop"));
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    expect(s.branch?.name).toBe("main");
  });

  it("handles a sha256 repository honestly — ready or explicit unsupported", async () => {
    const dir = tmp("repo-sha256-");
    try {
      git(dir, ["init", "-b", "main", "--object-format=sha256"]);
    } catch {
      return; // host git lacks sha256 — nothing to assert against
    }
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    // Correct data or an explicit refusal — never silently misread.
    if (s.kind === "ready") {
      expect(s.branch?.name).toBe("main");
      expect(s.entries.map((e) => e.path)).toContain("f.txt");
    } else {
      expect(s.kind).toBe("unsupported");
    }
  });

  it("reads a repository whose path contains a colon", async () => {
    const parent = tmp("colon-parent-");
    const dir = join(parent, "with:colon");
    mkRepo(dir);
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    const e = s.entries.find((x) => x.path === "f.txt")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d.kind).toBe("text");
  });

  it("caps a newline-heavy patch by line count, not just bytes", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "seed\n");
    commitAll(dir);
    // ~12k appended one-char lines: < 2 MiB but > 10,000 patch lines.
    const lines = Array.from({ length: 11_000 }, (_, i) => `l${i}`).join("\n");
    writeFileSync(join(dir, "f.txt"), `seed\n${lines}\n`);
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    const e = s.entries.find((x) => x.path === "f.txt")!;
    const d = await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    expect(d.kind).toBe("oversized");
  });

  it("leaves the original index, HEAD, config and refs byte-identical", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "one\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "two\n"); // dirty state for status work
    const watched = ["index", "HEAD", "config", join("refs", "heads", "main")].map((p) => join(dir, ".git", p));
    const before = watched.map((p) => sha256(readFileSync(p)));
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    const e = s.entries.find((x) => x.path === "f.txt")!;
    await r.service.diff(r.projectId, s.snapshotId, e.id, "worktree");
    await r.service.refresh(r.projectId); // second capture cycle
    expect(watched.map((p) => sha256(readFileSync(p)))).toEqual(before);
    // The view must also never have written into the source .git.
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
  });

  it("keeps racy-index detection: a same-second same-size edit is not missed", async () => {
    // Git decides "racy" by comparing the index FILE's own mtime against
    // each entry's stored stat mtime; a racily-clean entry is content-
    // rechecked. If the view's index copy kept its fresh write-time, no
    // entry would ever be racy and a same-second edit with identical
    // size would vanish. The fixture makes the stat data match exactly,
    // so only the preserved index mtime can expose the change.
    const dir = mkRepo();
    const file = join(dir, "z.txt");
    writeFileSync(file, "AAA\n");
    const m1 = statSync(file).mtime;
    commitAll(dir);
    writeFileSync(file, "BBB\n"); // same size — stat alone cannot tell
    utimesSync(file, m1, m1); // worktree stat now equals the stored entry
    utimesSync(join(dir, ".git", "index"), m1, m1); // force a racy entry
    // Sanity: real git still detects it through the content fallback.
    expect(git(dir, ["status", "--porcelain"])).toContain("z.txt");

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    const e = s.entries.find((x) => x.path === "z.txt");
    expect(e?.unstaged).toBe("M");
    const d = await r.service.diff(r.projectId, s.snapshotId, e!.id, "worktree");
    expect(d).toMatchObject({ kind: "text" });
    expect(d.kind === "text" && d.patch!.includes("BBB")).toBe(true);
  });

  it("returns honest states for missing git, revoked grant and stale ids", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);

    const rMissing = rig({ repoDir: dir, gitExe: join(dir, "no-such-git") });
    const sMissing = await rMissing.service.refresh(rMissing.projectId);
    expect(sMissing).toMatchObject({ kind: "unavailable", reason: "no-git" });

    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");

    const stale = await r.service.diff(r.projectId, "00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001", "staged");
    expect(stale).toMatchObject({ kind: "unavailable", reason: "stale" });
    const staleEntry = await r.service.diff(r.projectId, s.snapshotId, "00000000-0000-4000-8000-000000000001", "staged");
    expect(staleEntry).toMatchObject({ kind: "unavailable", reason: "stale" });

    r.paths.revoke(r.projectId);
    const s2 = await r.service.refresh(r.projectId);
    expect(s2).toMatchObject({ kind: "unavailable" });
  });

  it("spawns nothing while read-only; cached snapshot still answers overview", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("ready");
    r.mutable.v = false;
    const s2 = await r.service.refresh(r.projectId);
    expect(s2.kind).toBe("unavailable");
    expect(s2.reason).toMatch(/read-only|closing/);
    await expect(r.service.diff(r.projectId, s.snapshotId, "00000000-0000-4000-8000-000000000001", "staged")).rejects.toThrow(/read-only|closing/);
    expect(r.service.overview(r.projectId).snapshotId).toBe(s2.snapshotId);
  });

  it("coalesces concurrent refreshes per project and caps global concurrency", async () => {
    // Counting runner: deferred results so parallelism is observable.
    let live = 0;
    let maxLive = 0;
    let calls = 0;
    const gates: Array<() => void> = [];
    const runner: GitRunner = {
      run: () => {
        calls++;
        live++;
        maxLive = Math.max(maxLive, live);
        let resolve!: (r: GitRunResult) => void;
        const done = new Promise<GitRunResult>((res) => {
          resolve = res;
          gates.push(() => {
            live--;
            res({ code: 1, signal: null, stdout: "", stderr: "fatal: not a git repository", timedOut: false, overflowed: false, cancelled: false });
          });
        });
        return { done, cancel: () => { live--; resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: true }); }, pid: 1 };
      },
      active: () => new Set(),
    };

    // One service, many projects — the cap is a single global semaphore.
    const dir0 = mkRepo();
    const r = rig({ repoDir: dir0, runner });
    const projectIds = [r.projectId];
    for (let i = 0; i < MAX_CONCURRENT_OPS + 1; i++) {
      const d = mkRepo();
      const p = r.engine.createProject(`p${i}`);
      r.paths.registerUser(p.id, d);
      projectIds.push(p.id);
    }
    const same = projectIds.map((id) => [r.service.refresh(id), r.service.refresh(id)]);
    await Promise.resolve();
    await new Promise((res) => setImmediate(res));
    expect(calls).toBeLessThanOrEqual(MAX_CONCURRENT_OPS);
    while (gates.length) {
      const g = gates.shift()!;
      g();
      await Promise.resolve();
      await new Promise((res) => setImmediate(res));
    }
    const settled = await Promise.all(same.map(([a, b]) => Promise.all([a!, b!])));
    for (const [a, b] of settled) {
      expect(a.snapshotId).toBe(b.snapshotId); // same coalesced result
      expect(a.kind).toBe("not-repository");
    }
    expect(maxLive).toBeLessThanOrEqual(MAX_CONCURRENT_OPS);
  });

  it("cancels and observes a child on dispose; refused work while closing", async () => {
    let cancelSeen = false;
    let resolveRun!: (r: GitRunResult) => void;
    const runner: GitRunner = {
      run: () => {
        const done = new Promise<GitRunResult>((res) => {
          resolveRun = res;
        });
        return {
          done,
          cancel: () => {
            cancelSeen = true;
            resolveRun({ code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: true });
          },
          pid: 1,
        };
      },
      active: () => new Set(),
    };
    const dir = mkRepo();
    const r = rig({ repoDir: dir, runner });
    const p = r.service.refresh(r.projectId);
    await Promise.resolve();
    const d = r.service.dispose();
    expect(cancelSeen).toBe(true);
    await d;
    const s = await p;
    expect(s.kind).toBe("unavailable"); // probe ran was cancelled
  });

  it("drops an in-flight refresh view when the project is deleted", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const p = r.service.refresh(r.projectId);
    r.engine.deleteProject(r.projectId); // mid-flight delete
    r.service.onProjectDeleted(r.projectId);
    const s = await p;
    // The result may answer the caller but is never stored for a dead
    // project; the just-built view is dropped.
    void s;
    expect(() => r.service.overview(r.projectId)).toThrow(/unknown project/);
    const viewRoot = join(r.dataRoot, "git-views");
    const leftover = existsSync(viewRoot) ? readdirSync(viewRoot).length : 0;
    expect(leftover).toBe(0);
  });
});

describe("GitService — executor-layer honesty (simulated)", () => {
  const dir = (p: string) => {
    const d = tmp("repo-");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, p), "x\n");
    return d;
  };

  it("unavailableReason dep → refresh reports it, runner never spawns", async () => {
    const repoDir = dir("f.txt");
    const runner: GitRunner = {
      run: () => { throw new Error("runner must never be reached"); },
      active: () => new Set(),
    };
    const r = rig({ repoDir, runner, unavailableReason: "git-containment", gitExe: GIT_ABS });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("unavailable");
    expect(s.reason).toBe("git-containment");
  });

  it("Windows without an injected contained runner cannot use direct Git", async () => {
    const r = rig({ repoDir: dir("f.txt"), gitExe: GIT_ABS, platform: "win32" });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("unavailable");
    expect(s.reason).toBe("git-containment");
  });

  it("executorFailed run result → unavailable with executor-* reason", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "f.txt"), "x\n");
    commitAll(repoDir);
    const runner: GitRunner = {
      run: () => ({
        done: Promise.resolve({
          code: null, signal: null, stdout: "", stderr: "",
          timedOut: false, overflowed: false, cancelled: false,
          executorFailed: "cleanup-unproven",
        } satisfies GitRunResult),
        cancel: () => {},
        pid: 1,
      }),
      active: () => new Set(),
    };
    const r = rig({ repoDir, runner, gitExe: GIT_ABS });
    const s = await r.service.refresh(r.projectId);
    expect(s.kind).toBe("unavailable");
    expect(s.reason).toBe("executor-cleanup-unproven");
  });

  it("unproven cleanups surface in dispose().problems — never forgotten", async () => {
    const repoDir = mkRepo();
    const runner: GitRunner = {
      run: () => ({
        done: new Promise<GitRunResult>(() => {}), // never settles
        cancel: () => {},
        pid: 1,
      }),
      active: () => new Set(),
      unprovenCleanups: () => ["job-helper exited 4 — tree cleanup unproven"],
    };
    const r = rig({ repoDir, runner, gitExe: GIT_ABS, mutable: true });
    const res = await r.service.dispose();
    expect(res.problems.some((p) => p.includes("cleanup unproven"))).toBe(true);
  });
});

describe("probeRepo — simulated win32 semantics", () => {
  const okHandle = (r: Partial<GitRunResult>) => ({
    done: Promise.resolve({
      code: 0, signal: null, stdout: "", stderr: "",
      timedOut: false, overflowed: false, cancelled: false, ...r,
    } as GitRunResult),
    cancel: () => {},
    pid: 1,
  });
  const envFor = (x?: Record<string, string>) => ({ ...x });

  it("CRLF probe output + case/separator-insensitive worktree compare → ok", async () => {
    // Git for Windows emits CRLF; the worktree may differ in case/slashes
    // from the grant — win32 treats them equal.
    const run = ((args: string[]) => {
      if (args.includes("--git-common-dir"))
        return okHandle({
          stdout:
            "C:\\repo\\.git\r\nC:\\repo\\.git\r\nc:/Repo\r\nsha1\r\nfalse\r\n" +
            "C:\\repo\\.git\\index\r\nC:\\repo\\.git\\objects\r\nC:\\repo\\.git\\HEAD\r\n",
        });
      if (args.includes("symbolic-ref")) return okHandle({ stdout: "refs/heads/main\r\n" });
      if (args.includes("--verify")) return okHandle({ stdout: "a".repeat(40) + "\r\n" });
      return okHandle({ stdout: "", code: 1 });
    }) as never;
    const out = await probeRepo("C:\\REPO", "C:\\home", run, envFor, { platform: "win32" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.probe?.headRef).toBe("refs/heads/main");
      expect(out.probe?.worktree).toBe("c:/Repo");
    }
  });

  it("a grant path containing ';' cannot carry a ceiling list → refused", async () => {
    const run = (() => okHandle({ stdout: "x\r\n" })) as never;
    const out = await probeRepo("C:\\semi;colon", "C:\\home", run, envFor, { platform: "win32" });
    expect(out).toEqual({ kind: "unavailable", reason: "grant-path-semicolon" });
  });

  it("a foreign worktree is still rejected on win32 (component-exact)", async () => {
    const run = ((args: string[]) => {
      if (args.includes("--git-common-dir"))
        return okHandle({
          stdout:
            "C:\\other\\.git\r\nC:\\other\\.git\r\nC:\\other\r\nsha1\r\nfalse\r\n" +
            "C:\\other\\.git\\index\r\nC:\\other\\.git\\objects\r\nC:\\other\\.git\\HEAD\r\n",
        });
      return okHandle({ stdout: "", code: 1 });
    }) as never;
    const out = await probeRepo("C:\\repo", "C:\\home", run, envFor, { platform: "win32" });
    expect(out.kind).toBe("not-repository");
  });
});
