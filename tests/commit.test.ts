// F13 commit flow (A36): real `add -A` / `commit -F` / `push -u origin HEAD`
// against synthetic repositories. The message travels via a service-owned
// temp file, failures carry git's own stderr, and a push after commit is
// verified against a local bare remote — never faked.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { GitService } from "../src/main/gitService";
import { MockProvider } from "../src/main/mockProvider";
import type { ProviderAdapter } from "../src/main/provider";
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
  const dir = tmp("commit-repo-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function rig(repoDir: string, opts: { mutable?: boolean; provider?: ProviderAdapter } = {}) {
  const dataRoot = tmp("commit-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, opts.provider ?? new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  const git = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => opts.mutable ?? true,
    emit: () => {},
    dataRoot,
  });
  services.push(git);
  return { engine, git, projectId: project.id, dataRoot };
}

describe.skipIf(!haveDirectGit)("git commit flow (F13)", () => {
  it("reports working changes with a bounded patch", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    writeFileSync(join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    const res = await r.git.workingChanges(r.projectId);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.summary).toContain("a.txt");
    expect(res.summary).toContain("new.txt");
    expect(res.patch).toContain("+changed");
    expect(res.truncated).toBe(false);
  });

  it("reports unavailable for a non-repository directory", async () => {
    const plain = tmp("commit-plain-");
    const r = rig(plain);
    const res = await r.git.workingChanges(r.projectId);
    expect(res.kind).toBe("unavailable");
  });

  it("refuses an empty commit message without touching the repo", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const before = git(repo, ["rev-parse", "HEAD"]).trim();
    const res = await r.git.commit(r.projectId, "   \n ", false);
    expect(res.kind).toBe("unavailable");
    if (res.kind !== "unavailable") return;
    expect(res.reason).toBe("message-empty");
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
  });

  it("commits staged+unstaged+untracked with the exact message (multi-line via -F)", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    writeFileSync(join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    const message = "Update files\n\n- touch a.txt\n- add new.txt";
    const res = await r.git.commit(r.projectId, message, false);
    expect(res.kind).toBe("committed");
    if (res.kind !== "committed") return;
    expect(res.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(res.oid);
    expect(git(repo, ["log", "-1", "--format=%B"]).trim()).toBe(message);
    expect(git(repo, ["status", "--short"]).trim()).toBe("");
    expect(res.pushed).toBe(false);
  });

  it("reports a commit failure honestly (rejected hook) and leaves HEAD", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\necho hook said no >&2\nexit 1\n");
    chmodSync(join(repo, ".git/hooks/pre-commit"), 0o755);
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const before = git(repo, ["rev-parse", "HEAD"]).trim();
    const res = await r.git.commit(r.projectId, "blocked", false);
    expect(res.kind).toBe("unavailable");
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
  });

  it("refuses in read-only state", async () => {
    const repo = mkRepo();
    const r = rig(repo, { mutable: false });
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const res = await r.git.commit(r.projectId, "x", false);
    expect(res.kind).toBe("unavailable");
    if (res.kind !== "unavailable") return;
    expect(res.reason).toContain("read-only");
  });

  it("pushes to a local bare remote and reports the commit's oid", async () => {
    const repo = mkRepo();
    const remote = tmp("commit-remote-");
    git(remote, ["init", "--bare", "-b", "main"]);
    git(repo, ["remote", "add", "origin", remote]);
    const r = rig(repo);
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const res = await r.git.commit(r.projectId, "ship it", true);
    expect(res.kind).toBe("committed");
    if (res.kind !== "committed") return;
    expect(res.pushed).toBe(true);
    expect(res.pushError).toBeUndefined();
    expect(git(remote, ["rev-parse", "main"]).trim()).toBe(res.oid);
    const up = await r.git.push(r.projectId);
    expect(up.kind).toBe("pushed");
  });

  it("commits fine but reports the push failure when no remote exists", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const res = await r.git.commit(r.projectId, "no remote", true);
    expect(res.kind).toBe("committed");
    if (res.kind !== "committed") return;
    expect(res.pushed).toBe(false);
    expect(res.pushError).toBeTruthy();
    const standalone = await r.git.push(r.projectId);
    expect(standalone.kind).toBe("unavailable");
  });
});

describe("commit message generation (F13/F31)", () => {
  it("drafts a synthetic message through the mock adapter", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const res = await r.engine.commitMessageFor("M a.txt\n?? new.txt", "patch");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.message).toBe("Update a.txt");
  });

  it("refuses when text generation is off — the provider is never asked", async () => {
    const repo = mkRepo();
    let asked = 0;
    const counting: ProviderAdapter = {
      descriptor: { id: "count", label: "Count", mode: "mock", synthetic: true },
      start() {
        throw new Error("unreachable");
      },
      generateCommitMessage: async () => {
        asked++;
        return "x";
      },
      dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }),
    };
    const r = rig(repo, { provider: counting });
    r.engine.setSettings({ textGeneration: "off" });
    const res = await r.engine.commitMessageFor("M a.txt", "patch");
    expect(res.kind).toBe("unavailable");
    expect(res.kind === "unavailable" && res.reason).toBe("text-generation-off");
    expect(asked).toBe(0);
  });

  it("reports no-engine when the adapter lacks the capability", async () => {
    const repo = mkRepo();
    const bare: ProviderAdapter = {
      descriptor: { id: "bare", label: "Bare", mode: "mock", synthetic: true },
      start() {
        throw new Error("unreachable");
      },
      dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }),
    };
    const r = rig(repo, { provider: bare });
    const res = await r.engine.commitMessageFor("M a.txt", "patch");
    expect(res.kind).toBe("unavailable");
    expect(res.kind === "unavailable" && res.reason).toBe("no-engine");
  });

  it("rejects empty/fence-only provider output instead of committing it", async () => {
    const repo = mkRepo();
    const empty: ProviderAdapter = {
      descriptor: { id: "empty", label: "Empty", mode: "mock", synthetic: true },
      start() {
        throw new Error("unreachable");
      },
      generateCommitMessage: async () => "```\n```",
      dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }),
    };
    const r = rig(repo, { provider: empty });
    const res = await r.engine.commitMessageFor("M a.txt", "patch");
    expect(res.kind).toBe("unavailable");
    expect(res.kind === "unavailable" && res.reason).toBe("generation-empty");
  });
});
