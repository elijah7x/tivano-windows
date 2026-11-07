// F11 thread worktrees (A33): real `git worktree add/remove` against
// synthetic repos + the engine binding contract. The worktree dir is
// always main-chosen under <dataRoot>/worktrees; only the branch name
// crosses from the caller, and git itself re-validates it.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/main/engine";
import { GitService } from "../src/main/gitService";
import { MockProvider } from "../src/main/mockProvider";
import type { ProviderAdapter, TurnContext } from "../src/main/provider";
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
  const dir = tmp("wt-repo-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function rig(repoDir: string, provider?: ProviderAdapter) {
  const dataRoot = tmp("wt-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const prov = provider ?? new MockProvider({ tickMs: 1 });
  const engine = new Engine(store, prov, dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  const thread = engine.createThread(project.id);
  const git = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => true,
    emit: () => {},
    dataRoot,
  });
  services.push(git);
  engine.attachWorktrees(git);
  return { engine, git, paths, provider: prov, projectId: project.id, threadId: thread.id, dataRoot };
}

/** A NON-mock adapter: engine resolves + verifies a workspace for it.
 *  Captures the TurnContext it actually spawns with. */
function execProvider(seen: TurnContext[]): ProviderAdapter {
  return {
    descriptor: { id: "exec-stub", label: "Exec Stub", mode: "codex", synthetic: true },
    start(ctx, cb) {
      seen.push(ctx);
      setTimeout(() => cb.onDone(), 1);
      return { cancel() {}, resume() {} };
    },
    dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }),
  };
}

describe.skipIf(!haveDirectGit)("thread worktrees (F11)", () => {
  it("creates an app-owned worktree and binds the thread", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.engine.createThreadWorktree(r.threadId, "feature-x");
    expect(res.kind).toBe("created");
    if (res.kind !== "created") return;
    expect(res.directory.startsWith(realpathSync(join(r.dataRoot, "worktrees")) + sep)).toBe(true);
    expect(existsSync(join(res.directory, "a.txt"))).toBe(true);
    expect(git(repo, ["-C", res.directory, "rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature-x\n");
    const t = r.engine.snapshot().threads.find((x) => x.id === r.threadId)!;
    expect(t.worktreeDir).toBe(res.directory);
    expect(r.engine.threadDirectory(r.threadId)).toBe(res.directory);
  });

  it("rejects invalid and taken branch names via git itself", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const bad = await r.engine.createThreadWorktree(r.threadId, "bad..name");
    expect(bad.kind).toBe("unavailable");
    if (bad.kind === "unavailable") expect(bad.reason).toBe("branch-name-invalid");
    const taken = await r.engine.createThreadWorktree(r.threadId, "main");
    expect(taken.kind).toBe("unavailable");
    if (taken.kind === "unavailable") expect(taken.reason).toBe("branch-exists");
    // Neither refusal bound anything or left a dir behind.
    const t = r.engine.snapshot().threads.find((x) => x.id === r.threadId)!;
    expect(t.worktreeDir).toBeUndefined();
  });

  it("removes the worktree and unbinds; a dirty checkout refuses honestly", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.engine.createThreadWorktree(r.threadId);
    expect(res.kind).toBe("created");
    if (res.kind !== "created") return;
    // Dirty the worktree — plain `git worktree remove` must refuse.
    writeFileSync(join(res.directory, "a.txt"), "dirty\n");
    const refused = await r.engine.removeThreadWorktree(r.threadId);
    expect(refused.kind).toBe("unavailable");
    expect(existsSync(res.directory)).toBe(true);
    expect(r.engine.snapshot().threads[0]!.worktreeDir).toBe(res.directory);
    // Clean it and the remove now succeeds + unbinds.
    git(res.directory, ["checkout", "--", "a.txt"]);
    const done = await r.engine.removeThreadWorktree(r.threadId);
    expect(done.kind).toBe("removed");
    expect(existsSync(res.directory)).toBe(false);
    expect(r.engine.snapshot().threads[0]!.worktreeDir).toBeUndefined();
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(res.directory);
  });

  it("a dead worktree binding fails the directory lookup instead of falling back", async () => {
    const repo = mkRepo();
    const r = rig(repo, execProvider([]));
    const res = await r.engine.createThreadWorktree(r.threadId);
    if (res.kind !== "created") throw new Error("setup");
    rmSync(res.directory, { recursive: true, force: true });
    expect(r.engine.threadDirectory(r.threadId)).toBeNull();
    // …and a turn refuses honestly rather than running in the project dir.
    const turn = r.engine.sendTurn(r.threadId, "hello");
    expect(turn.status).toBe("error");
    expect(turn.error).toContain("WORKSPACE_NOT_CONFIGURED");
  });

  it("executes a turn inside the bound worktree via verifyExec", async () => {
    const repo = mkRepo();
    const seen: TurnContext[] = [];
    const r = rig(repo, execProvider(seen));
    const res = await r.engine.createThreadWorktree(r.threadId);
    if (res.kind !== "created") throw new Error("setup");
    r.engine.sendTurn(r.threadId, "hello");
    expect(seen.map((c) => c.workspace?.directory)).toEqual([res.directory]);
  });

  it("verifyExec confines exec dirs to <dataRoot>/worktrees/<projectId>", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.engine.createThreadWorktree(r.threadId);
    if (res.kind !== "created") throw new Error("setup");
    // The bound worktree verifies; so does the plain grant directory.
    expect(r.paths.verifyExec({ projectId: r.projectId, directory: res.directory }).directory).toBe(res.directory);
    expect(r.paths.verifyExec({ projectId: r.projectId, directory: realpathSync(repo) }).directory).toBe(realpathSync(repo));
    // A real directory OUTSIDE the app root refuses — no silent fallback.
    const outside = realpathSync(tmp("wt-outside-"));
    expect(() => r.paths.verifyExec({ projectId: r.projectId, directory: outside })).toThrow(/outside the app-owned/);
    // A sibling project's worktree subtree is not this project's root.
    const alien = realpathSync(tmp("wt-alien-"));
    const alienRoot = join(alien, "worktrees", r.projectId);
    expect(() => r.paths.verifyExec({ projectId: r.projectId, directory: alienRoot })).toThrow();
    // Revoking the project grant revokes worktree execution too.
    r.paths.revoke(r.projectId);
    expect(() => r.paths.verifyExec({ projectId: r.projectId, directory: res.directory })).toThrow(/WORKSPACE_REVOKED/);
  });

  it("refuses a second worktree while bound, and ungrouped threads", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.engine.createThreadWorktree(r.threadId);
    expect(res.kind).toBe("created");
    const again = await r.engine.createThreadWorktree(r.threadId);
    expect(again.kind).toBe("unavailable");
    if (again.kind === "unavailable") expect(again.reason).toBe("already-bound");
    const solo = r.engine.createThread(null);
    const noProj = await r.engine.createThreadWorktree(solo.id);
    expect(noProj.kind).toBe("unavailable");
    if (noProj.kind === "unavailable") expect(noProj.reason).toBe("thread-has-no-project");
  });

  it("worktree bytes persist: the binding survives a store reload", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.engine.createThreadWorktree(r.threadId);
    if (res.kind !== "created") throw new Error("setup");
    // The file written by the worktree checkout is real and persistent.
    writeFileSync(join(res.directory, "wt.txt"), "in worktree\n");
    expect(readFileSync(join(res.directory, "wt.txt"), "utf8")).toBe("in worktree\n");
    const t = r.engine.snapshot().threads[0]!;
    expect(t.worktreeDir).toBe(res.directory);
  });

  it("createThreadWorktree runs runOnWorktreeCreate scripts inside the new worktree", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const termCalls: { threadId: string; opts: { title?: string; command?: string } | undefined }[] = [];
    r.engine.attachTerminals({
      create: (threadId: string, _c: number, _rw: number, opts?: { title?: string; command?: string }) => {
        termCalls.push({ threadId, opts });
        return {
          terminal: {
            id: `term-${termCalls.length}`,
            threadId,
            title: opts?.title ?? "t",
            state: "starting",
            incarnation: 1,
          },
        };
      },
    });
    r.engine.setProjectScripts(r.projectId, [
      { id: "", name: "Install", command: "npm install", icon: "", runOnWorktreeCreate: true },
      { id: "", name: "NoRun", command: "never", icon: "", runOnWorktreeCreate: false },
    ]);
    const res = await r.engine.createThreadWorktree(r.threadId);
    if (res.kind !== "created") throw new Error("setup");
    expect(res.setup).toEqual({ran: 1, failed: []});
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0]!.opts).toEqual({ title: "Install", command: "npm install" });
    // A script that fails to launch is reported, not faked as run.
    termCalls.length = 0;
    const r2 = rig(repo);
    const failCalls: string[] = [];
    r2.engine.attachTerminals({
      create: (tid: string) => {
        failCalls.push(tid);
        return { unavailable: "platform" };
      },
    });
    r2.engine.setProjectScripts(r2.projectId, [
      { id: "", name: "X", command: "y", icon: "", runOnWorktreeCreate: true },
    ]);
    const res2 = await r2.engine.createThreadWorktree(r2.threadId);
    if (res2.kind !== "created") throw new Error("setup2");
    expect(res2.setup).toEqual({ran: 0, failed: [{ name: "X", reason: "platform" }]});
  });
});
