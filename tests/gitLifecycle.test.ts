// Git service lifecycle tests: whole-operation tracking, gating between
// every spawn, queue handoff/cap, deletion & dispose semantics. Scripted
// runners park at chosen call indexes so every multi-command phase can be
// interrupted deterministically.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { GitService, MAX_CONCURRENT_OPS, QUEUE_CAP } from "../src/main/gitService";
import { makeGitRunner, type GitRunResult, type GitRunner } from "../src/main/gitExec";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import type { AppEvent } from "../src/shared/ipc";

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

function tmp(prefix = "tivano-p2f-life-"): string {
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

function mkRepo(dir?: string): string {
  const d = dir ?? tmp("repo-");
  mkdirSync(d, { recursive: true });
  git(d, ["init", "-b", "main"]);
  git(d, ["config", "user.email", "test@example.com"]);
  git(d, ["config", "user.name", "Test"]);
  return d;
}

interface Rig {
  service: GitService;
  engine: Engine;
  paths: ProjectRuntimePaths;
  projectId: string;
  events: AppEvent[];
  dataRoot: string;
}

function rig(opts: { repoDir: string; runner?: GitRunner; disposeTimeoutMs?: number }): Rig {
  const dataRoot = tmp("data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const project = engine.createProject("p");
  paths.registerUser(project.id, opts.repoDir);
  const events: AppEvent[] = [];
  const service = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => true,
    emit: (e) => events.push(e),
    dataRoot,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.disposeTimeoutMs !== undefined ? { disposeTimeoutMs: opts.disposeTimeoutMs } : {}),
  });
  services.push(service);
  return { service, engine, paths, projectId: project.id, events, dataRoot };
}

const settled = (r: Partial<GitRunResult>): GitRunResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  overflowed: false,
  cancelled: false,
  ...r,
});

/** Real-git runner with one parked call index whose release is controlled. */
function parkAtCall(parkIndex: number, gitExe = GIT) {
  const inner = makeGitRunner(gitExe);
  let calls = 0;
  let release!: (r: GitRunResult) => void;
  let parked = false;
  const atPark = new Promise<void>((r) => {
    const mark = () => r();
    release = (x) => {
      mark();
      void x;
    };
    void mark;
  });
  let onPark: () => void = () => {};
  const runner: GitRunner = {
    active: () => inner.active(),
    run: (args, o) => {
      calls++;
      if (calls === parkIndex) {
        parked = true;
        onPark();
        const done = new Promise<GitRunResult>((res) => {
          release = (x) => {
            res(x);
          };
        });
        return {
          done,
          pid: 1,
          cancel: () =>
            release(
              settled({
                code: null,
                signal: "SIGTERM",
                cancelled: true,
              }),
            ),
        };
      }
      return inner.run(args, o);
    },
  };
  const waitParked = async (): Promise<void> => {
    for (let i = 0; i < 200 && !parked; i++) await new Promise((r) => setTimeout(r, 10));
    if (!parked) throw new Error(`call ${parkIndex} was never reached`);
  };
  return {
    runner,
    calls: () => calls,
    waitParked,
    onPark: (fn: () => void) => (onPark = fn),
  };
}

describe.skipIf(!haveDirectGit)("GitService lifecycle", () => {
  it("releases admission capacity when a diff loses its grant before starting", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "c"]);
    writeFileSync(join(dir, "f.txt"), "b\n");
    const r = rig({ repoDir: dir });
    const snapshot = await r.service.refresh(r.projectId);
    const entry = snapshot.entries.find((e) => e.path === "f.txt")!;
    for (let i = 0; i < MAX_CONCURRENT_OPS; i++) {
      const pending = r.service.diff(r.projectId, snapshot.snapshotId, entry.id, "worktree");
      r.paths.revoke(r.projectId);
      expect((await pending).kind).toBe("unavailable");
      r.paths.registerUser(r.projectId, dir);
    }
    expect((await r.service.diff(r.projectId, snapshot.snapshotId, entry.id, "worktree")).kind).toBe("text");
  }, 10_000);

  it("keeps source objects read-only, including colon and quoted paths", async () => {
    const dir = mkRepo(join(tmp(), 'repo:with"quote'));
    writeFileSync(join(dir, "f.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "c"]);
    writeFileSync(join(dir, "f.txt"), "b\n");
    const inner = makeGitRunner(GIT);
    let viewCalls = 0;
    const runner: GitRunner = {
      active: inner.active,
      run: (args, opts) => {
        if (args.some((a) => a.startsWith("--git-dir="))) {
          viewCalls++;
          expect(opts.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
          expect(JSON.parse(opts.env.GIT_ALTERNATE_OBJECT_DIRECTORIES!)).toBe(join(realpathSync(dir), ".git", "objects"));
        }
        return inner.run(args, opts);
      },
    };
    const r = rig({ repoDir: dir, runner });
    const snapshot = await r.service.refresh(r.projectId);
    expect(snapshot.kind).toBe("ready");
    const entry = snapshot.entries.find((e) => e.path === "f.txt")!;
    expect((await r.service.diff(r.projectId, snapshot.snapshotId, entry.id, "worktree")).kind).toBe("text");
    expect(viewCalls).toBeGreaterThanOrEqual(4);
  });

  it("dispose during the HEAD probe starts no later Git commands", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "c"]);
    const { runner, calls, waitParked } = parkAtCall(2);
    let after = 0;
    let disposing = false;
    const counted: GitRunner = {
      active: runner.active,
      run: (a, o) => {
        if (disposing) after++;
        return runner.run(a, o);
      },
    };
    const r = rig({ repoDir: dir, runner: counted });
    const p = r.service.refresh(r.projectId);
    await waitParked(); // parked inside the HEAD identity probe
    disposing = true;
    const d = r.service.dispose();
    const s = await p;
    await d;
    expect(s.kind).toBe("unavailable");
    expect(after).toBe(0);
    expect(calls()).toBe(2);
  });

  it.each([1, 4, 5])(
    "dispose during command %i of a refresh cancels the whole chain",
    async (parkIndex) => {
      const dir = mkRepo();
      writeFileSync(join(dir, "f.txt"), "a\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-m", "c"]);
      const { runner, calls, waitParked } = parkAtCall(parkIndex);
      let after = 0;
      let disposing = false;
      const counted: GitRunner = {
        active: runner.active,
        run: (a, o) => {
          if (disposing) after++;
          return runner.run(a, o);
        },
      };
      const r = rig({ repoDir: dir, runner: counted });
      const p = r.service.refresh(r.projectId);
      await waitParked();
      disposing = true;
      await r.service.dispose();
      const s = await p;
      expect(s.kind).toBe("unavailable");
      expect(after).toBe(0);
      expect(calls()).toBe(parkIndex);
    },
  );

  it("project deletion cancels queued and running ops; no stale publish, view dropped", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "c"]);
    const { runner, waitParked } = parkAtCall(5); // parked at `status`
    const r = rig({ repoDir: dir, runner });
    const p = r.service.refresh(r.projectId);
    await waitParked();
    r.engine.deleteProject(r.projectId);
    r.service.onProjectDeleted(r.projectId);
    const s = await p;
    expect(s.kind).toBe("unavailable");
    // No snapshot for a dead project is ever emitted or stored.
    expect(
      r.events.some((e) => e.type === "git-snapshot" && e.snapshot.projectId === r.projectId),
    ).toBe(false);
    const viewRoot = join(r.dataRoot, "git-views");
    expect(existsSync(viewRoot) ? readdirSync(viewRoot).length : 0).toBe(0);
  });

  it("a queued diff keeps its view pinned across refresh and revoke", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "c"]);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    git(dir, ["add", "f.txt"]);

    const inner = makeGitRunner(GIT);
    let parkedMode = false;
    const gates: Array<() => void> = [];
    const runner: GitRunner = {
      active: inner.active,
      run: (args, o) => {
        if (!parkedMode) return inner.run(args, o);
        let resolveParked!: (r: GitRunResult) => void;
        const done = new Promise<GitRunResult>((res) => {
          resolveParked = res;
          gates.push(() => res(settled({ code: 1, stderr: "fatal: not a git repository" })));
        });
        return {
          done,
          pid: 1,
          cancel: () =>
            resolveParked(settled({ code: null, signal: "SIGTERM", cancelled: true })),
        };
      },
    };
    const r = rig({ repoDir: dir, runner });
    const s1 = await r.service.refresh(r.projectId);
    expect(s1.kind).toBe("ready");
    const entry = s1.entries.find((e) => e.path === "f.txt")!;
    const view1 = join(r.dataRoot, "git-views");
    const v1 = readdirSync(view1)[0]!;

    // Fill every semaphore slot with parked filler ops.
    parkedMode = true;
    const fillers: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_CONCURRENT_OPS; i++) {
      const d = mkRepo();
      const p = r.engine.createProject(`f${i}`);
      r.paths.registerUser(p.id, d);
      fillers.push(r.service.refresh(p.id).catch((e) => e));
    }
    await new Promise((res) => setImmediate(res));
    // The diff queues behind them, pinning s1's view.
    const diffP = r.service.diff(r.projectId, s1.snapshotId, entry.id, "staged");
    // And a refresh queues behind the diff — replacement must not delete
    // the pinned view out from under it.
    const refreshP = r.service.refresh(r.projectId);
    await new Promise((res) => setImmediate(res));
    parkedMode = false;
    while (gates.length) {
      gates.shift()!();
      await new Promise((res) => setImmediate(res));
    }
    const [d, s2] = await Promise.all([diffP, refreshP, ...fillers]);
    expect(d.kind).toBe("text"); // diff still ran against the pinned s1 view
    void s2;
    // After everything settles, the retired view is gone.
    expect(readdirSync(view1)).not.toContain(v1);
  });

  // This test performs real fs work across MAX+QUEUE_CAP+2 repos; under
  // full-suite load it can exceed the default 5s budget.
  it("semaphore handoff never oversubscribes and queue overflow rejects", { timeout: 30000 }, async () => {
    let live = 0;
    let maxLive = 0;
    const gates: Array<() => void> = [];
    const runner: GitRunner = {
      run: () => {
        live++;
        maxLive = Math.max(maxLive, live);
        let resolveParked!: (r: GitRunResult) => void;
        const done = new Promise<GitRunResult>((res) => {
          resolveParked = res;
          gates.push(() => {
            live--;
            res(settled({ code: 1, stderr: "fatal: not a git repository" }));
          });
        });
        return {
          done,
          pid: 1,
          cancel: () =>
            gates.push(() => {
              live--;
              resolveParked(settled({ code: null, signal: "SIGTERM", cancelled: true }));
            }),
        };
      },
      active: () => new Set(),
    };
    const dir = mkRepo();
    const r = rig({ repoDir: dir, runner });
    const projs = [r.projectId];
    for (let i = 0; i < MAX_CONCURRENT_OPS + QUEUE_CAP + 2; i++) {
      const d = mkRepo();
      const p = r.engine.createProject(`q${i}`);
      r.paths.registerUser(p.id, d);
      projs.push(p.id);
    }
    const all = projs.map((id) => r.service.refresh(id).catch((e) => ({ rejected: String(e) })));
    await new Promise((res) => setImmediate(res));
    expect(live).toBeLessThanOrEqual(MAX_CONCURRENT_OPS);
    while (gates.length) {
      gates.shift()!();
      await new Promise((res) => setImmediate(res));
    }
    const out = await Promise.all(all);
    expect(maxLive).toBeLessThanOrEqual(MAX_CONCURRENT_OPS);
    const rejected = out.filter((o) => "rejected" in o || o.kind === "unavailable");
    const ready = out.filter((o) => "kind" in o && o.kind === "not-repository");
    // Capacity: at most MAX+QUEUE_CAP ops got real work; overflow refused.
    expect(ready.length).toBeLessThanOrEqual(MAX_CONCURRENT_OPS + QUEUE_CAP);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("dispose with an unresolved child reports a problem and stays retryable", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "c"]);
    // Runner whose child never exits and whose cancel does nothing —
    // the classic unconfirmed-exit case.
    const runner: GitRunner = {
      run: () => ({
        done: new Promise<GitRunResult>(() => {}),
        pid: 1,
        cancel: () => {},
      }),
      active: () => new Set(),
    };
    const r = rig({ repoDir: dir, runner, disposeTimeoutMs: 200 });
    void r.service.refresh(r.projectId);
    await new Promise((res) => setImmediate(res));
    const d1 = await r.service.dispose();
    expect(d1.problems.length).toBeGreaterThan(0);
    expect(d1.problems.join(" ")).toMatch(/did not settle|not observed/);
    // A second dispose reports honestly again — a forgotten op can never
    // masquerade as already-clean.
    const d2 = await r.service.dispose();
    expect(d2.problems.length).toBeGreaterThan(0);
    // No command or event may be emitted post-dispose.
    expect(r.events.filter((e) => e.type === "git-snapshot")).toHaveLength(0);
  });

  it("no post-dispose command is ever attempted", async () => {
    let calls = 0;
    const runner: GitRunner = {
      run: () => {
        calls++;
        return { done: Promise.resolve(settled({ code: 1 })), pid: 1, cancel: () => {} };
      },
      active: () => new Set(),
    };
    const dir = mkRepo();
    const r = rig({ repoDir: dir, runner });
    await r.service.dispose();
    await r.service.refresh(r.projectId);
    const g = await r.service.diff(r.projectId, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "staged").catch((e) => e);
    expect(calls).toBe(0);
    void g;
  });
});
