// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// F11 branch menu (A52): the frozen BranchMenu ops — for-each-ref rows,
// `git switch`, `git switch -c`, `git branch -m` with the frozen name
// checks (normalization, ≤60, charset, check-ref-format, case-insensitive
// collision, op-in-progress refusal, pushed-upstream gate). Real git,
// synthetic repositories; never faked.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { GitService } from "../src/main/gitService";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";

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

const dirs: string[] = [];
const stores: Store[] = [];
const services: GitService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const st of stores.splice(0)) st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(dir: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd: dir,
    env: {
      PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
    encoding: "utf8",
  });
}

function mkRepo(): string {
  const dir = tmp("branch-repo-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function rig(repoDir: string) {
  const dataRoot = tmp("branch-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  const svc = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => true,
    emit: () => {},
    dataRoot,
  });
  services.push(svc);
  return { engine, svc, projectId: project.id, repo: repoDir };
}

describe.skipIf(!haveDirectGit)("branch menu (F11)", () => {
  it("lists branches newest-first with current + upstream, and detects detached HEAD", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    git(repo, ["branch", "feature/x"]);
    const res = await r.svc.branches(r.projectId, repo);
    expect(res.kind).toBe("ready");
    if (res.kind !== "ready") return;
    expect(res.detached).toBe(false);
    const names = res.branches.map((b) => b.name);
    expect(names[0]).toBe("feature/x"); // newest-first by committerdate… same commit ties by sort order — just require both present
    expect(names).toContain("main");
    expect(names).toContain("feature/x");
    expect(res.branches.find((b) => b.name === "main")?.isCurrent).toBe(true);
    git(repo, ["checkout", "--detach", "HEAD"]);
    const res2 = await r.svc.branches(r.projectId, repo);
    expect(res2.kind === "ready" && res2.detached).toBe(true);
  });

  it("switches to a listed non-current branch and refuses current/unknown names", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    git(repo, ["branch", "dev"]);
    const sw = await r.svc.switchBranch(r.projectId, repo, "dev");
    expect(sw.kind).toBe("ok");
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("dev");
    const same = await r.svc.switchBranch(r.projectId, repo, "dev");
    expect(same.kind).toBe("unavailable");
    if (same.kind === "unavailable") expect(same.reason).toBe("branch-current");
    const bogus = await r.svc.switchBranch(r.projectId, repo, "-x forged");
    expect(bogus.kind).toBe("unavailable");
    if (bogus.kind === "unavailable") expect(bogus.reason).toBe("branch-unknown");
  });

  it("create normalizes spaces to dashes and switches; rejects existing and invalid names", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.svc.createBranch(r.projectId, repo, "  my new  branch  ");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.branch).toBe("my-new-branch");
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("my-new-branch");
    const dup = await r.svc.createBranch(r.projectId, repo, "MAIN");
    expect(dup.kind).toBe("rejected");
    if (dup.kind === "rejected") expect(dup.reason).toBe("branch-name-exists");
    const bad = await r.svc.createBranch(r.projectId, repo, "has$money");
    expect(bad.kind).toBe("rejected");
    if (bad.kind === "rejected") expect(bad.reason).toBe("branch-name-chars");
    const tooLong = await r.svc.createBranch(r.projectId, repo, "x".repeat(61));
    expect(tooLong.kind).toBe("rejected");
    if (tooLong.kind === "rejected") expect(tooLong.reason).toBe("branch-name-too-long");
    const empty = await r.svc.createBranch(r.projectId, repo, "   ");
    expect(empty.kind).toBe("rejected");
    if (empty.kind === "rejected") expect(empty.reason).toBe("");
  });

  it("rename reports pushed when the branch has an upstream, then renames on confirm", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    // Real upstream: a local bare remote + push -u so %(upstream:short) resolves.
    const remote = tmp("branch-remote-");
    git(remote, ["init", "--bare", "-b", "main"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const pushed = await r.svc.renameBranch(r.projectId, repo, "trunk", false);
    expect(pushed.kind).toBe("pushed");
    if (pushed.kind === "pushed") expect(pushed.upstream).toBe("origin/main");
    const ok = await r.svc.renameBranch(r.projectId, repo, "trunk", true);
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") {
      expect(ok.branch).toBe("trunk");
      expect(ok.oldBranch).toBe("main");
    }
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("trunk");
  });

  it("rename refuses while a merge is in progress", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    // Frozen marker check: MERGE_HEAD in the git dir refuses the rename.
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), git(repo, ["rev-parse", "HEAD"]));
    const res = await r.svc.renameBranch(r.projectId, repo, "trunk", false);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.reason).toBe("branch-name-op-in-progress");
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
  });

  it("rename without an upstream just renames the live HEAD branch", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.svc.renameBranch(r.projectId, repo, "main 2", false);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.branch).toBe("main-2");
      expect(res.oldBranch).toBe("main");
    }
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main-2");
  });
});
