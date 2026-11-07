// Checkpoint service tests (P2G): durable CAS capture + conservative
// undo preview over REAL repositories. Fixtures are synthetic repos in
// mkdtemp; the only git executed is the fixed-argv runner inside the
// controlled view — fixtures' own setup uses execFileSync directly.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  CheckpointService,
  CKPT_MAX_GLOBAL,
  CKPT_QUEUE_CAP,
} from "../src/main/checkpointService";
import {
  CheckpointStore,
  CKPT_MAX_FILE_BYTES,
  parseManifest,
} from "../src/main/checkpointStore";
import { makeGitRunner, type GitRunResult, type GitRunner } from "../src/main/gitExec";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import type { ChatThread } from "../src/shared/types";

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
const services: CheckpointService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const st of stores.splice(0)) st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = "tivano-p2g-"): string {
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

function commitAll(dir: string, msg = "c"): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", msg]);
}

const headBytes = (dir: string): Buffer =>
  readFileSync(join(dir, ".git", "HEAD"));
const indexBytes = (dir: string): Buffer | null =>
  existsSync(join(dir, ".git", "index")) ? readFileSync(join(dir, ".git", "index")) : null;

interface Rig {
  service: CheckpointService;
  store: CheckpointStore;
  engine: Engine;
  paths: ProjectRuntimePaths;
  projectId: string;
  threadId: string;
  turnId: string;
  threads: ChatThread[];
  dataRoot: string;
}

function rig(opts: {
  repoDir: string;
  runner?: GitRunner;
  mutable?: () => boolean;
  disposeTimeoutMs?: number;
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
  const threadId = "th-" + project.id.slice(0, 8);
  const turnId = "tu-1";
  const threads: ChatThread[] = [
    {
      id: threadId,
      projectId: project.id,
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: "m1", role: "assistant", content: "", status: "done", ts: 1, turnId },
      ],
      turn: null,
      sessionGrants: [],
    },
  ];
  const service = new CheckpointService({
    paths,
    projects: () => engine.snapshot().projects,
    threads: () => threads,
    mutable: opts.mutable ?? (() => true),
    dataRoot,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.disposeTimeoutMs !== undefined ? { disposeTimeoutMs: opts.disposeTimeoutMs } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.unavailableReason ? { unavailableReason: opts.unavailableReason } : {}),
  });
  services.push(service);
  return {
    service,
    store: new CheckpointStore(join(dataRoot, "checkpoints")),
    engine,
    paths,
    projectId: project.id,
    threadId,
    turnId,
    threads,
    dataRoot,
  };
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

/** Runner whose Nth call is parked until released (or cancelled). */
function parkAtCall(parkIndex: number, gitExe = GIT) {
  const inner = makeGitRunner(gitExe);
  let calls = 0;
  let parked = false;
  let resolveParked!: (r: GitRunResult) => void;
  const runner: GitRunner = {
    active: () => inner.active(),
    run: (args, o) => {
      calls++;
      if (calls === parkIndex) {
        parked = true;
        const done = new Promise<GitRunResult>((res) => (resolveParked = res));
        return {
          done,
          pid: 1,
          cancel: () =>
            resolveParked(settled({ code: null, signal: "SIGTERM", cancelled: true })),
        };
      }
      return inner.run(args, o);
    },
  };
  const waitParked = async (): Promise<void> => {
    for (let i = 0; i < 300 && !parked; i++) await new Promise((r) => setTimeout(r, 10));
    if (!parked) throw new Error(`call ${parkIndex} was never reached`);
  };
  return { runner, calls: () => calls, waitParked, release: (r: GitRunResult) => resolveParked(r) };
}

describe.skipIf(!haveDirectGit)("CheckpointService", () => {
  it("captures before/after checkpoints durably and leaves the repository byte-identical", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0xff, 4]));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "uni \u4e2d\u6587.txt"), "unicode-name\n");
    commitAll(dir);
    writeFileSync(join(dir, "untracked.txt"), "u\n");

    const r = rig({ repoDir: dir });
    const head0 = headBytes(dir);
    const idx0 = indexBytes(dir);

    const c1 = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c1.kind).toBe("captured");
    expect(c1.pathCount).toBe(4);

    writeFileSync(join(dir, "a.txt"), "bravo\n");
    rmSync(join(dir, "untracked.txt"));
    const c2 = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    expect(c2.kind).toBe("captured");

    // Store: manifests exist and validate; blob bytes retrievable.
    const m1 = r.store.loadManifest(c1.checkpointId!);
    expect(m1.phase).toBe("before");
    expect(m1.projectId).toBe(r.projectId);
    expect(m1.grantDir).toBe(realpathSync(dir));
    const a1 = m1.entries.find((e) => e.path === "a.txt")!;
    expect(a1.worktree).toMatchObject({ kind: "file", size: 6, exec: false });
    const m2 = r.store.loadManifest(c2.checkpointId!);
    const a2 = m2.entries.find((e) => e.path === "a.txt")!;
    expect((a2.worktree as { sha256: string }).sha256).not.toBe(
      (a1.worktree as { sha256: string }).sha256,
    );
    // A deleted UNTRACKED path is omitted from the manifest entirely —
    // an omission is UNKNOWN, never treated as explicit absence evidence.
    expect(m2.entries.some((e) => e.path === "untracked.txt")).toBe(false);
    const a2i = m2.entries.find((e) => e.path === "a.txt")!.index;
    expect(a2i.length).toBe(1);
    expect(a2i[0]!.mode).toBe("100644");

    // Source repository untouched.
    expect(headBytes(dir).equals(head0)).toBe(true);
    expect(indexBytes(dir)!.equals(idx0!)).toBe(true);
    expect(existsSync(join(dir, ".git", "refs", "tivano"))).toBe(false);
    // No checkpoint refs/objects appeared inside the user repo.
    const refs = git(dir, ["for-each-ref"]).trim();
    expect(refs).not.toContain("tivano");
  }, 20_000);

  it("keeps index deletions and worktree deletions distinct", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "gone-index.txt"), "x\n");
    writeFileSync(join(dir, "gone-work.txt"), "y\n");
    commitAll(dir);
    git(dir, ["rm", "--cached", "gone-index.txt"]); // index deletion only
    rmSync(join(dir, "gone-work.txt")); // worktree deletion only

    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");
    const m = r.store.loadManifest(c.checkpointId!);
    const gi = m.entries.find((e) => e.path === "gone-index.txt")!;
    expect(gi.index).toEqual([]);
    expect(gi.worktree.kind).toBe("file"); // still in worktree
    const gw = m.entries.find((e) => e.path === "gone-work.txt")!;
    expect(gw.worktree.kind).toBe("absent");
    expect(gw.index.length).toBe(1); // still staged
  }, 20_000);

  it("captures symlinks as link text and preserves exec bit, newline and pathspec-looking names", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "tool.sh"), 0o755);
    symlinkSync("tool.sh", join(dir, "tool-link"));
    writeFileSync(join(dir, "odd\nname.txt"), "nl\n");
    writeFileSync(join(dir, ":(glob).txt"), "ps\n");
    commitAll(dir);

    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");
    const m = r.store.loadManifest(c.checkpointId!);
    const tool = m.entries.find((e) => e.path === "tool.sh")!;
    expect(tool.worktree).toMatchObject({ kind: "file", exec: true });
    const link = m.entries.find((e) => e.path === "tool-link")!;
    expect(link.worktree).toEqual({ kind: "symlink", target: "tool.sh" });
    expect(m.entries.some((e) => e.path === "odd\nname.txt")).toBe(true);
    expect(m.entries.some((e) => e.path === ":(glob).txt")).toBe(true);
  }, 20_000);

  it("survives restart: a fresh store instance loads published manifests and blobs", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");

    const reopened = new CheckpointStore(join(r.dataRoot, "checkpoints"));
    const ids = reopened.listManifestIds();
    expect(ids).toContain(c.checkpointId);
    const m = reopened.loadManifest(c.checkpointId!);
    const file = m.entries.find((e) => e.path === "a.txt")!;
    const blob = reopened.readBlob(
      (file.worktree as { sha256: string }).sha256,
      (file.worktree as { size: number }).size,
    );
    expect(blob.toString()).toBe("alpha\n");
  }, 20_000);

  it("a crashed publish (tmp file only) is never a valid checkpoint", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");
    // Simulate an interrupted publish: tmp manifest, never renamed.
    const manifestsDir = join(r.dataRoot, "checkpoints", "manifests");
    writeFileSync(
      join(manifestsDir, "11111111-1111-4111-8111-111111111111.json.tmp-1"),
      "{}",
    );
    const reopened = new CheckpointStore(join(r.dataRoot, "checkpoints"));
    expect(reopened.listManifestIds()).not.toContain(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(() => reopened.loadManifest("11111111-1111-4111-8111-111111111111")).toThrow();
  }, 20_000);

  it("corrupt manifest and corrupt blob both fail honestly", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    const m = r.store.loadManifest(c.checkpointId!);
    const file = m.entries.find((e) => e.path === "a.txt")!;
    const sha = (file.worktree as { sha256: string }).sha256;
    // Corrupt the blob content.
    const blobPath = join(r.dataRoot, "checkpoints", "blobs", sha.slice(0, 2), sha.slice(2));
    writeFileSync(blobPath, "tampered");
    expect(() => r.store.readBlob(sha, 6)).toThrow();
    // Corrupt the manifest.
    const mPath = join(r.dataRoot, "checkpoints", "manifests", `${c.checkpointId}.json`);
    writeFileSync(mPath, "{ not json");
    expect(() => r.store.loadManifest(c.checkpointId!)).toThrow();
    // A manifest carrying an escaping path is rejected by validation.
    expect(
      parseManifest({ ...m, entries: [{ path: "../escape", worktree: { kind: "absent" }, index: [] }], pathCount: 1 }),
    ).toBeNull();
  }, 20_000);

  it("refuses an oversized file explicitly", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(CKPT_MAX_FILE_BYTES + 1, 7));
    writeFileSync(join(dir, "ok.txt"), "ok\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("unavailable");
    expect(c.reason).toContain("too large");
  }, 20_000);

  it("captures a linked worktree", async () => {
    const main = mkRepo();
    writeFileSync(join(main, "a.txt"), "base\n");
    commitAll(main);
    const linked = join(tmp(), "wt");
    git(main, ["worktree", "add", "-b", "linked", linked]);
    writeFileSync(join(linked, "wt.txt"), "in-linked\n");
    const r = rig({ repoDir: realpathSync(linked) });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");
    const m = r.store.loadManifest(c.checkpointId!);
    expect(m.entries.some((e) => e.path === "a.txt")).toBe(true);
    expect(m.entries.some((e) => e.path === "wt.txt")).toBe(true);
  }, 20_000);

  it("never executes a configured filter/fsmonitor helper during capture", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=marker\n");
    commitAll(dir);
    const marker = join(dir, "HELPER-RAN");
    const helper = join(dir, "helper.sh");
    writeFileSync(
      helper,
      `#!/bin/sh\ntouch "${marker}"\ncat\n`,
    );
    chmodSync(helper, 0o755);
    // Configure hostile helpers AFTER the fixture commit — setup itself
    // must not run them.
    git(dir, ["config", "filter.marker.clean", helper]);
    git(dir, ["config", "filter.marker.smudge", helper]);
    git(dir, ["config", "core.fsmonitor", helper]);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");
    expect(r.store.loadManifest(c.checkpointId!).limitations).toContain("filters");
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("rejects unknown turn/thread and foreign project", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    expect(
      (await r.service.capture(r.projectId, r.threadId, "no-such-turn", "before")).reason,
    ).toBe("turn-not-found");
    expect(
      (await r.service.capture(r.projectId, "no-such-thread", r.turnId, "before")).reason,
    ).toBe("turn-not-found");
  }, 20_000);

  it("reports a pinned unavailable capability honestly (Windows containment)", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    // Windows Git only ever runs through the attested Job --run runner;
    // without it the pinned bootstrap reason refuses honestly (P2L).
    const r = rig({ repoDir: dir, platform: "win32", unavailableReason: "git-containment" });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c).toMatchObject({ kind: "unavailable", reason: "git-containment" });
    const p = await r.service.preview(r.projectId, r.threadId, "b", "e", []);
    expect(p).toMatchObject({ kind: "unavailable", reason: "git-containment" });
  }, 20_000);

  it("a mid-capture worktree mutation is detected and retried — the published snapshot is self-consistent", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "v1\n");
    commitAll(dir);
    // Call order inside capture: probe=rev-parse(1), symbolic-ref(2),
    // rev-parse HEAD(3), config(4), ls-files staged(5), ls-files others(6).
    const p = parkAtCall(5);
    const r = rig({ repoDir: dir, runner: p.runner });
    const capture = r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    await p.waitParked();
    writeFileSync(join(dir, "a.txt"), "v2-mutated\n");
    writeFileSync(join(dir, "late.txt"), "appeared\n");
    p.release(
      settled({
        code: 0,
        stdout: "100644 0123456789abcdef0123456789abcdef01234567 0\ta.txt\0",
      }),
    );
    const c = await capture;
    expect(c.kind).toBe("captured");
    const m = r.store.loadManifest(c.checkpointId!);
    const a = m.entries.find((e) => e.path === "a.txt")!;
    const blob = r.store.readBlob(
      (a.worktree as { sha256: string }).sha256,
      (a.worktree as { size: number }).size,
    );
    // The retried attempt must show the mutated content — a consistent
    // snapshot, never the torn pair (v1 bytes + v2 metadata).
    expect(blob.toString()).toBe("v2-mutated\n");
    expect(m.entries.some((e) => e.path === "late.txt")).toBe(true);
  }, 20_000);

  it("revoking the grant mid-capture cancels the operation — nothing published", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const p = parkAtCall(5);
    const r = rig({ repoDir: dir, runner: p.runner });
    const capture = r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    await p.waitParked();
    r.paths.revoke(r.projectId);
    p.release(settled({ code: 0, stdout: "100644 deadbeef 0\ta.txt\0" }));
    const c = await capture;
    expect(c.kind).toBe("unavailable");
    expect(r.store.listManifestIds()).toHaveLength(0);
  }, 20_000);

  it("project deletion cancels a running capture before publication", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const p = parkAtCall(5);
    const r = rig({ repoDir: dir, runner: p.runner });
    const capture = r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    await p.waitParked();
    r.service.onProjectDeleted(r.projectId);
    p.release(settled({ code: 1, stderr: "fatal" }));
    const c = await capture;
    expect(c.kind).toBe("unavailable");
    expect(r.store.listManifestIds()).toHaveLength(0);
  }, 20_000);

  it("dispose during the probe prevents every later git command", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const p = parkAtCall(2); // symbolic-ref is the second probe call
    const r = rig({ repoDir: dir, runner: p.runner });
    const capture = r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    await p.waitParked();
    const d = r.service.dispose();
    p.release(settled({ code: 1, stderr: "boom" }));
    const c = await capture;
    expect(c.kind).toBe("unavailable");
    const res = await d;
    expect(res.problems).toEqual([]);
    expect(p.calls()).toBe(2); // no call #3+ ever started
  }, 20_000);

  it("enforces one active capture per project and two globally, queue capped", async () => {
    const repos = [mkRepo(), mkRepo(), mkRepo()];
    for (const d of repos) {
      writeFileSync(join(d, "a.txt"), "a\n");
      commitAll(d);
    }
    // ONE service, three projects — the semaphore is shared.
    const inner = makeGitRunner(GIT);
    const parkedHandles: { res: (r: GitRunResult) => void; args: readonly string[] }[] = [];
    const runner: GitRunner = {
      active: () => inner.active(),
      run: (args) => {
        const done = new Promise<GitRunResult>((res) => {
          parkedHandles.push({ res, args });
        });
        return {
          done,
          pid: 1,
          cancel: () =>
            parkedHandles
              .find((h) => h.args === args)
              ?.res(settled({ code: null, signal: "SIGTERM", cancelled: true })),
        };
      },
    };
    const r = rig({ repoDir: repos[0]!, runner });
    // Attach two more projects+threads to the same engine/service.
    const p2 = r.engine.createProject("p2");
    const p3 = r.engine.createProject("p3");
    r.paths.registerUser(p2.id, repos[1]!);
    r.paths.registerUser(p3.id, repos[2]!);
    for (const [pid, tid, tn] of [
      [p2.id, "th-p2", "tu-p2"],
      [p3.id, "th-p3", "tu-p3"],
    ] as const) {
      r.threads.push({
        id: tid,
        projectId: pid,
        title: "t",
        createdAt: 1,
        updatedAt: 1,
        messages: [{ id: `m-${tid}`, role: "assistant", content: "", status: "done", ts: 1, turnId: tn }],
        turn: null,
        sessionGrants: [],
      });
    }
    const caps = [
      r.service.capture(r.projectId, r.threadId, r.turnId, "before"),
      r.service.capture(r.projectId, r.threadId, r.turnId, "after"), // same project → queued
      r.service.capture(p2.id, "th-p2", "tu-p2", "before"),
      r.service.capture(p3.id, "th-p3", "tu-p3", "before"), // global cap → queued
    ];
    await new Promise((r_) => setTimeout(r_, 80));
    // Global cap 2 → exactly two git calls in flight, never more.
    expect(parkedHandles.length).toBe(CKPT_MAX_GLOBAL);
    // Drain every parked call as a failure until all four ops settle.
    while (parkedHandles.length) {
      for (const h of parkedHandles.splice(0)) h.res(settled({ code: 1, stderr: "x" }));
      await new Promise((r_) => setTimeout(r_, 10));
    }
    const results = await Promise.all(caps);
    expect(results.every((x) => x.kind === "unavailable")).toBe(true);
    expect(CKPT_QUEUE_CAP).toBe(16);
  }, 20_000);
});

describe.skipIf(!haveDirectGit)("CheckpointService preview", () => {
  it("before→edit→after→later-edit: only provably-untouched paths are proposed", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    writeFileSync(join(dir, "b.txt"), "B1\n");
    writeFileSync(join(dir, "c.txt"), "C1\n");
    commitAll(dir);

    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(base.kind).toBe("captured");

    // The captured turn edits a and creates new.txt.
    writeFileSync(join(dir, "a.txt"), "A2-turn\n");
    writeFileSync(join(dir, "new.txt"), "N\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    expect(end.kind).toBe("captured");

    // Later work: b modified in worktree; c staged then reverted in the
    // worktree so ONLY the index differs from the end state.
    writeFileSync(join(dir, "b.txt"), "B2-later\n");
    writeFileSync(join(dir, "c.txt"), "C2-staged\n");
    git(dir, ["add", "c.txt"]);
    writeFileSync(join(dir, "c.txt"), "C1\n");

    const touched = ["a.txt", "b.txt", "c.txt", "new.txt", "unrelated.txt"];
    const p = await r.service.preview(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      touched,
    );
    expect(p.kind).toBe("ready");
    const by = new Map(p.entries.map((e) => [e.path, e]));
    // a: current == end (A2-turn) → restore to base (A1).
    expect(by.get("a.txt")!.action).toBe("restore");
    // new.txt: UNTRACKED at end, omitted from base — omission is UNKNOWN
    // (R1-A: the turn may not have created it) → keep, never remove.
    expect(by.get("new.txt")!.action).toBe("keep");
    expect(by.get("new.txt")!.reason).toBe("base-unknown");
    // b: worktree changed after end → keep.
    expect(by.get("b.txt")!.action).toBe("keep");
    expect(by.get("b.txt")!.reason).toBe("worktree-changed");
    // c: staged edit after end → keep (index changed).
    expect(by.get("c.txt")!.action).toBe("keep");
    expect(by.get("c.txt")!.reason).toBe("index-changed");
    // unrelated.txt: in NEITHER manifest → end state unknown → keep.
    expect(by.get("unrelated.txt")!.action).toBe("keep");
    expect(by.get("unrelated.txt")!.reason).toBe("end-unknown");
    // Preview wrote nothing.
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("B2-later\n");
    expect(git(dir, ["status", "--porcelain"])).toContain("MM c.txt");
  }, 20_000);

  it("rejects cross-project/thread checkpoints and reversed ordering", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const before = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    const after = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");

    // A checkpoint owned by a DIFFERENT thread in the same store.
    const foreignThread: ChatThread = {
      id: "th-foreign",
      projectId: r.projectId,
      title: "t2",
      createdAt: 2,
      updatedAt: 2,
      messages: [{ id: "m9", role: "assistant", content: "", status: "done", ts: 2, turnId: "tu-9" }],
      turn: null,
      sessionGrants: [],
    };
    r.threads.push(foreignThread);
    const foreign = await r.service.capture(r.projectId, "th-foreign", "tu-9", "before");
    expect(foreign.kind).toBe("captured");

    // Cross-project base.
    const p1 = await r.service.preview(
      r.projectId, r.threadId, foreign.checkpointId!, after.checkpointId!, ["a.txt"],
    );
    expect(p1.kind).toBe("unavailable");
    // Reversed order (after as base).
    const p2 = await r.service.preview(
      r.projectId, r.threadId, after.checkpointId!, before.checkpointId!, ["a.txt"],
    );
    expect(p2.kind).toBe("unavailable");
    // Missing end checkpoint.
    const p3 = await r.service.preview(
      r.projectId, r.threadId, before.checkpointId!, "11111111-1111-4111-8111-111111111111", ["a.txt"],
    );
    expect(p3.kind).toBe("unavailable");
    // Escaping touched path refused.
    const p4 = await r.service.preview(
      r.projectId, r.threadId, before.checkpointId!, after.checkpointId!, ["../evil"],
    );
    expect(p4.kind).toBe("unavailable");
    expect(p4.reason).toContain("unsafe-path");
  }, 20_000);

  it("symlink changes classify correctly and a corrupted base blob is kept", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "real.txt"), "R1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    symlinkSync("real.txt", join(dir, "ln.txt"));
    writeFileSync(join(dir, "real.txt"), "R2\n");
    git(dir, ["add", "ln.txt"]); // stage ONLY the link — real.txt's index
    // fingerprint must stay identical so the blob check is what refuses.
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    expect(end.kind).toBe("captured");

    // Corrupt real.txt's base blob with SAME-SIZE bytes → the integrity
    // check (not the size check) must refuse the restore proposal.
    const m = r.store.loadManifest(base.checkpointId!);
    const real = m.entries.find((e) => e.path === "real.txt")!;
    const sha = (real.worktree as { sha256: string }).sha256;
    writeFileSync(join(r.dataRoot, "checkpoints", "blobs", sha.slice(0, 2), sha.slice(2)), "XYZ");

    const p = await r.service.preview(
      r.projectId, r.threadId, base.checkpointId!, end.checkpointId!, ["real.txt", "ln.txt"],
    );
    const by = new Map(p.entries.map((e) => [e.path, e]));
    expect(by.get("real.txt")!.action).toBe("keep"); // blob-corrupt
    expect(by.get("real.txt")!.reason).toBe("blob-corrupt");
    // ln.txt: tracked at end but omitted from base → unknown provenance,
    // never a remove proposal (R1-A).
    expect(by.get("ln.txt")!.action).toBe("keep");
    expect(by.get("ln.txt")!.reason).toBe("base-unknown");
  }, 20_000);
});

// ---- R1 regressions: lead probes A–E ------------------------------------------

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe.skipIf(!haveDirectGit)("CheckpointService R1 regressions", () => {
  it("P1: a previously-ignored PRE-EXISTING file is never proposed for deletion", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, ".gitignore"), "private.txt\n");
    commitAll(dir);
    writeFileSync(join(dir, "private.txt"), "pre-existing user data\n");
    const r = rig({ repoDir: dir });
    const before = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(before.kind).toBe("captured");
    writeFileSync(join(dir, ".gitignore"), "");
    const after = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    expect(after.kind).toBe("captured");
    const p = await r.service.preview(
      r.projectId, r.threadId, before.checkpointId!, after.checkpointId!, ["private.txt"],
    );
    const row = p.entries.find((e) => e.path === "private.txt");
    // Ignored at base → omitted → provenance UNKNOWN → keep, not remove.
    expect(row?.action).toBe("keep");
    expect(row?.reason).toBe("base-unknown");
  }, 20_000);

  it("P2: a same-size edit with a restored mtime cannot publish stale bytes", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "AAAA\n");
    commitAll(dir);
    const f = join(dir, "a.txt");
    utimesSync(f, 1700000000, 1700000000);
    const r = rig({ repoDir: dir });
    const store = (r.service as unknown as { store: CheckpointStore }).store;
    const orig = store.putBlob.bind(store);
    let changed = false;
    store.putBlob = (buf: Buffer, scratch: string): string => {
      const id = orig(buf, scratch);
      if (!changed) {
        changed = true;
        writeFileSync(f, "BBBB\n"); // same size
        utimesSync(f, 1700000000, 1700000000); // same mtime, same inode
      }
      return id;
    };
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("captured");
    const m = r.store.loadManifest(c.checkpointId!);
    const e = m.entries.find((x) => x.path === "a.txt")!;
    // The content hash re-verify caught the stat-stable mutation; the
    // retried attempt recorded the CURRENT bytes.
    expect((e.worktree as { sha256: string }).sha256).toBe(sha256(readFileSync(f)));
  }, 20_000);

  it("P3: store confinement is physical — symlinked dirs and leaves refuse", async () => {
    const mkStore = (root: string): CheckpointStore => new CheckpointStore(root);
    // Symlinked blobs directory.
    {
      const root = join(tmp("store-"), "checkpoints");
      const outside = join(tmp("outside-"), "o");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, "blobs"));
      const s = mkStore(root);
      expect(() => s.newScratch()).toThrowError(/confined|unsafe/);
      // The outside directory must not have received our writes.
      expect(existsSync(join(outside, "cap-"))).toBe(false);
    }
    // Symlinked manifests directory.
    {
      const root = join(tmp("store-"), "checkpoints");
      const outside = join(tmp("outside-"), "o");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, "manifests"));
      const s = mkStore(root);
      expect(() => s.newScratch()).toThrowError(/confined|unsafe/);
    }
    // A foreign scratch string can never redirect blob writes.
    {
      const root = join(tmp("store-"), "checkpoints");
      const s = mkStore(root);
      expect(() => s.putBlob(Buffer.from("x"), tmp("foreign-"))).toThrowError(/not issued/);
    }
    // Symlinked blob LEAF: readBlob refuses rather than follows.
    {
      const root = join(tmp("store-"), "checkpoints");
      const s = mkStore(root);
      const scratch = s.newScratch();
      const sha = s.putBlob(Buffer.from("payload"), scratch);
      const blobPath = join(root, "blobs", sha.slice(0, 2), sha.slice(2));
      rmSync(blobPath);
      symlinkSync(join(tmp("outside-"), "victim"), blobPath);
      expect(() => s.readBlob(sha, 7)).toThrowError(/confined|unsafe/);
    }
    // Symlinked manifest LEAF refuses.
    {
      const root = join(tmp("store-"), "checkpoints");
      const s = mkStore(root);
      s.newScratch(); // creates manifests dir
      const id = "22222222-2222-4222-8222-222222222222";
      symlinkSync(join(tmp("outside-"), "victim-m"), join(root, "manifests", `${id}.json`));
      expect(() => s.loadManifest(id)).toThrowError(/confined|unsafe/);
    }
  }, 20_000);

  it("P4: tracked files under a deleted directory record explicit absent", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "file.txt"), "before\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    expect((await r.service.capture(r.projectId, r.threadId, r.turnId, "before")).kind).toBe("captured");
    rmSync(join(dir, "sub"), { recursive: true });
    const after = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    expect(after.kind).toBe("captured");
    const m = r.store.loadManifest(after.checkpointId!);
    const e = m.entries.find((x) => x.path === "sub/file.txt")!;
    expect(e.worktree.kind).toBe("absent");
    expect(e.index.length).toBe(1); // still staged → EXPLICIT absence evidence
  }, 20_000);

  it("explicit-absent base + recreated-at-end proposes remove; absent at both is noop", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "f.txt"), "ORIG\n");
    commitAll(dir);
    rmSync(join(dir, "f.txt")); // worktree-deleted, index stage kept
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(base.kind).toBe("captured");
    const bm = r.store.loadManifest(base.checkpointId!);
    expect(bm.entries.find((e) => e.path === "f.txt")!.worktree.kind).toBe("absent");

    // The turn recreates the file with the same bytes → index unchanged.
    writeFileSync(join(dir, "f.txt"), "ORIG\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    expect(end.kind).toBe("captured");
    const p1 = await r.service.preview(
      r.projectId, r.threadId, base.checkpointId!, end.checkpointId!, ["f.txt"],
    );
    const row1 = p1.entries.find((e) => e.path === "f.txt")!;
    expect(row1.action).toBe("remove"); // explicit absence + same index
    expect(row1.matched).toBeDefined();

    // absent-explicit at BOTH ends → noop (nothing to change).
    rmSync(join(dir, "f.txt"));
    const end2 = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    const p2 = await r.service.preview(
      r.projectId, r.threadId, base.checkpointId!, end2.checkpointId!, ["f.txt"],
    );
    expect(p2.entries.find((e) => e.path === "f.txt")!.action).toBe("noop");
  }, 20_000);

  it("preview uses the thread's own turn order, not wall-clock capture time", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    // Thread with two turns: tu-early BEFORE tu-late in message order.
    r.threads[0]!.messages.push(
      { id: "m2", role: "assistant", content: "", status: "done", ts: 2, turnId: "tu-early" },
      { id: "m3", role: "assistant", content: "", status: "done", ts: 3, turnId: "tu-late" },
    );
    const before = await r.service.capture(r.projectId, r.threadId, "tu-early", "before");
    const after = await r.service.capture(r.projectId, r.threadId, "tu-late", "after");
    expect(before.kind).toBe("captured");
    expect(after.kind).toBe("captured");
    // Swapped: an EARLIER turn presented as the end → rejected even
    // though phases and wall-clock order look right.
    const p = await r.service.preview(
      r.projectId, r.threadId, after.checkpointId!, before.checkpointId!, ["a.txt"],
    );
    expect(p.kind).toBe("unavailable");
    // A checkpoint whose turn is no longer in the thread → turn-not-found.
    const ghost = await r.service.capture(r.projectId, r.threadId, "tu-late", "before");
    expect(ghost.kind).toBe("captured");
    const gm = (await import("../src/main/checkpointStore")).parseManifest(
      JSON.parse(
        readFileSync(
          join(r.dataRoot, "checkpoints", "manifests", `${ghost.checkpointId}.json`),
          "utf8",
        ),
      ),
    )!;
    gm.turnId = "tu-ghost";
    writeFileSync(
      join(r.dataRoot, "checkpoints", "manifests", `${ghost.checkpointId}.json`),
      JSON.stringify(gm),
    );
    const p2 = await r.service.preview(
      r.projectId, r.threadId, ghost.checkpointId!, after.checkpointId!, ["a.txt"],
    );
    expect(p2.kind).toBe("unavailable");
    expect(p2.reason).toBe("turn-not-found");
  }, 20_000);

  it("mode change, index change and new-path listing changes all invalidate a capture attempt", async () => {
    for (const mutate of ["chmod", "index", "create"] as const) {
      const dir = mkRepo();
      writeFileSync(join(dir, "a.txt"), "a\n");
      writeFileSync(join(dir, "b.txt"), "B1\n"); // index-flip needs a real change
      commitAll(dir);
      const r = rig({ repoDir: dir });
      const store = (r.service as unknown as { store: CheckpointStore }).store;
      const orig = store.putBlob.bind(store);
      let flip = false;
      // Toggle once per attempt — only a.txt's blob write triggers, so
      // the flip isn't cancelled by a second file's write in the same
      // attempt. EVERY attempt's re-verify must see a different state.
      store.putBlob = (b: Buffer, s: string): string => {
        const id = orig(b, s);
        if (b.toString() !== "a\n") return id; // only a.txt's blob
        flip = !flip;
        if (mutate === "chmod") {
          chmodSync(join(dir, "a.txt"), flip ? 0o755 : 0o644);
        } else if (mutate === "index") {
          writeFileSync(join(dir, "b.txt"), flip ? "B2\n" : "B1\n");
          git(dir, ["add", "b.txt"]); // index bytes genuinely flip
        } else {
          if (flip) writeFileSync(join(dir, "new-file.txt"), "n\n");
          else rmSync(join(dir, "new-file.txt"));
        }
        return id;
      };
      const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
      expect(c.kind).toBe("unavailable");
      expect(r.store.listManifestIds()).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
      dirs.splice(dirs.indexOf(dir), 1);
    }
  }, 30_000);

  it("a swapped parent directory mid-capture invalidates the attempt", async () => {
    const dir = mkRepo();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "f.txt"), "v1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const store = (r.service as unknown as { store: CheckpointStore }).store;
    const orig = store.putBlob.bind(store);
    store.putBlob = (b: Buffer, s: string): string => {
      const id = orig(b, s);
      // Replace the parent dir wholesale with a look-alike every time.
      rmSync(join(dir, "sub"), { recursive: true, force: true });
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "f.txt"), "v1\n");
      return id;
    };
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("unavailable");
    expect(c.reason).toContain("changed");
  }, 30_000);

  it("grown or shrunk store files fail honestly", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    const m = r.store.loadManifest(c.checkpointId!);
    const e = m.entries.find((x) => x.path === "a.txt")!;
    const sha = (e.worktree as { sha256: string }).sha256;
    const blobPath = join(r.dataRoot, "checkpoints", "blobs", sha.slice(0, 2), sha.slice(2));
    appendFileSync(blobPath, "GROWN");
    expect(() => r.store.readBlob(sha, (e.worktree as { size: number }).size)).toThrow();
    const mPath = join(r.dataRoot, "checkpoints", "manifests", `${c.checkpointId}.json`);
    appendFileSync(mPath, "}");
    expect(() => r.store.loadManifest(c.checkpointId!)).toThrow();
  }, 20_000);

  it("a republished manifest id is refused — no silent overwrite", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    const m = r.store.loadManifest(c.checkpointId!);
    expect(() => r.store.publishManifest(m)).toThrowError(/already published/);
  }, 20_000);

  it("project deletion inside the read loop cancels before publication", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const store = (r.service as unknown as { store: CheckpointStore }).store;
    const orig = store.putBlob.bind(store);
    let fired = false;
    store.putBlob = (b: Buffer, s: string): string => {
      const id = orig(b, s);
      if (!fired) {
        fired = true;
        r.service.onProjectDeleted(r.projectId); // mid-read cancellation
      }
      return id;
    };
    const c = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    expect(c.kind).toBe("unavailable");
    expect(r.store.listManifestIds()).toHaveLength(0);
  }, 20_000);

  it("the queue actually overflows at cap+active — the 18th op for one project is rejected busy", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir);
    const inner = makeGitRunner(GIT);
    const parked: { res: (r: GitRunResult) => void }[] = [];
    const runner: GitRunner = {
      active: () => inner.active(),
      run: () => {
        const done = new Promise<GitRunResult>((res) => parked.push({ res }));
        return {
          done,
          pid: 1,
          cancel: () => parked.shift()?.res(settled({ code: null, signal: "SIGTERM", cancelled: true })),
        };
      },
    };
    const r = rig({ repoDir: dir, runner });
    // One active + 16 queued = 17 accepted; the 18th hits the cap.
    const ops = Array.from({ length: CKPT_QUEUE_CAP + 2 }, () =>
      r.service.capture(r.projectId, r.threadId, r.turnId, "before"),
    );
    await new Promise((r_) => setTimeout(r_, 50));
    while (parked.length) {
      for (const h of parked.splice(0)) h.res(settled({ code: 1, stderr: "x" }));
      await new Promise((r_) => setTimeout(r_, 5));
    }
    const results = await Promise.all(ops);
    expect(results.some((x) => x.reason?.includes("busy"))).toBe(true);
    expect(results.filter((x) => x.reason?.includes("busy")).length).toBe(1);
  }, 30_000);
});


describe.skipIf(!haveDirectGit)("Lead checkpoint index regression", () => {
 it("preview detects real index changes after the private view was built", async () => {
  const dir=mkRepo();writeFileSync(join(dir,"a.txt"),"before\n");commitAll(dir);
  const r=rig({repoDir:dir});const before=await r.service.capture(r.projectId,r.threadId,r.turnId,"before");
  writeFileSync(join(dir,"a.txt"),"end\n");const end=await r.service.capture(r.projectId,r.threadId,r.turnId,"after");
  const inner=makeGitRunner(GIT);let changed=false;
  (r.service as unknown as {runner:GitRunner}).runner={active:inner.active,run:(args,opts)=>{const h=inner.run(args,opts);if(!changed&&args.includes("ls-files")){changed=true;return {...h,done:h.done.then(result=>{writeFileSync(join(dir,"a.txt"),"later staged work\n");git(dir,["add","a.txt"]);writeFileSync(join(dir,"a.txt"),"end\n");return result;})};}return h;}};
  const p=await r.service.preview(r.projectId,r.threadId,before.checkpointId!,end.checkpointId!,["a.txt"]);
  expect(changed).toBe(true);expect(p.entries.some(e=>e.action==="restore"||e.action==="remove")).toBe(false);
 },20_000);
});


describe.skipIf(!haveDirectGit)("Lead checkpoint payload regression", () => {
 it("a missing end payload prevents a restore proposal", async () => {
  const dir=mkRepo();writeFileSync(join(dir,"a.txt"),"before\n");commitAll(dir);
  const r=rig({repoDir:dir});const before=await r.service.capture(r.projectId,r.threadId,r.turnId,"before");
  writeFileSync(join(dir,"a.txt"),"end\n");const end=await r.service.capture(r.projectId,r.threadId,r.turnId,"after");
  const e=r.store.loadManifest(end.checkpointId!).entries.find(e=>e.path==="a.txt")!;
  if(e.worktree.kind!=="file")throw Error("fixture must be a file");
  rmSync(join(r.dataRoot,"checkpoints","blobs",e.worktree.sha256.slice(0,2),e.worktree.sha256.slice(2)));
  const p=await r.service.preview(r.projectId,r.threadId,before.checkpointId!,end.checkpointId!,["a.txt"]);
  expect(p.entries.find(e=>e.path==="a.txt")?.action).toBe("keep");
 },20_000);
});

describe.skipIf(!haveDirectGit)("CheckpointService restore — DISABLED at the service entry", () => {
  // A17 security deviation: check-then-write cannot exclude the race
  // between the fingerprint re-proof and rmSync/writeWorktreeFile/
  // renameSync, so every in-place restore/delete is refused at
  // CheckpointService.restore — the only write dispatch point. These
  // cases prove the refusal path writes nothing, deletes nothing and
  // preserves the original bytes/evidence verbatim.
  it("refuses to write base bytes even on a provable clean path", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    writeFileSync(join(dir, "b.txt"), "B1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const idx0 = indexBytes(dir)!;
    const head0 = headBytes(dir);

    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    writeFileSync(join(dir, "a.txt"), "A2-turn\n");
    writeFileSync(join(dir, "b.txt"), "B2-turn\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    writeFileSync(join(dir, "b.txt"), "B3-later\n");

    const res = await r.service.restore(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["a.txt", "b.txt"],
    );
    expect(res.kind).toBe("unavailable");
    expect(res.reason).toBe("in-place-restore-disabled");
    expect(res.entries).toEqual([]);
    // NOTHING was written — the current worktree bytes survive verbatim.
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("A2-turn\n");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("B3-later\n");
    expect(indexBytes(dir)!.equals(idx0)).toBe(true);
    expect(headBytes(dir).equals(head0)).toBe(true);
  }, 20_000);

  it("refuses to delete a turn-recreated file — the file survives", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "t.txt"), "T1\n");
    commitAll(dir);
    rmSync(join(dir, "t.txt")); // worktree-absent, still tracked
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    writeFileSync(join(dir, "t.txt"), "T2-recreated\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    const res = await r.service.restore(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["t.txt"],
    );
    expect(res.kind).toBe("unavailable");
    expect(res.reason).toBe("in-place-restore-disabled");
    expect(readFileSync(join(dir, "t.txt"), "utf8")).toBe("T2-recreated\n");
  }, 20_000);

  it("refuses unconditionally — bad ids get the same refusal, not a different path", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const res = await r.service.restore(r.projectId, r.threadId, "nope", "nada", ["a.txt"]);
    expect(res.kind).toBe("unavailable");
    expect(res.reason).toBe("in-place-restore-disabled");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("A1\n");
  });

  it("refuses even with a staged drift — no path reaches the write branch", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    writeFileSync(join(dir, "a.txt"), "A2-turn\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    writeFileSync(join(dir, "a.txt"), "A3-staged\n");
    git(dir, ["add", "a.txt"]);
    writeFileSync(join(dir, "a.txt"), "A2-turn\n");
    const res = await r.service.restore(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["a.txt"],
    );
    expect(res.kind).toBe("unavailable");
    expect(res.reason).toBe("in-place-restore-disabled");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("A2-turn\n");
  }, 20_000);
});

// ---- per-turn diff (F10/A32) -------------------------------------------------
// Read-only base↔end blob comparison — the live worktree is never
// consulted, so a post-turn external edit can neither poison the diff
// nor be overwritten by it.

import { unifiedDiff, looksBinary } from "../src/shared/checkpointDiff";

describe("unifiedDiff pure function", () => {
  it("emits a minimal hunk for a one-line change", () => {
    const p = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt");
    expect(p).toContain("--- a/f.txt\n+++ b/f.txt\n");
    expect(p).toContain("@@ -1,3 +1,3 @@\n");
    expect(p).toContain("\n-b\n+B\n");
    expect(p.endsWith("\n")).toBe(true);
  });
  it("creation shows /dev/null on the base side", () => {
    const p = unifiedDiff(null, "new\n", "n.txt");
    expect(p).toContain("--- /dev/null");
    expect(p).toContain("+new");
  });
  it("deletion shows /dev/null on the end side", () => {
    const p = unifiedDiff("gone\n", null, "g.txt");
    expect(p).toContain("+++ /dev/null");
    expect(p).toContain("-gone");
  });
  it("marks a missing trailing newline", () => {
    const p = unifiedDiff("x\n", "x", "f");
    expect(p).toContain("\\ No newline at end of file");
  });
  it("identical content yields no patch", () => {
    expect(unifiedDiff("same\n", "same\n", "f")).toBe("");
  });
  it("looksBinary sniffs a NUL byte", () => {
    expect(looksBinary(Buffer.from("a\0b"))).toBe(true);
    expect(looksBinary(Buffer.from("plain\n"))).toBe(false);
  });
});

describe.skipIf(!haveDirectGit)("checkpoint diff service", () => {
  it("returns the base→end patch for a touched, modified file", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    writeFileSync(join(dir, "a.txt"), "A1\nA2-turn\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    const d = await r.service.diff(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["a.txt"],
      "a.txt",
    );
    expect(d.kind).toBe("text");
    if (d.kind !== "text") return;
    expect(d.patch).toContain("--- a/a.txt");
    expect(d.patch).toContain("+A2-turn");
    // The worktree may drift freely — the diff still compares BLOBS.
    writeFileSync(join(dir, "a.txt"), "A3-external\n");
    const d2 = await r.service.diff(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["a.txt"],
      "a.txt",
    );
    expect(d2.kind).toBe("text");
    if (d2.kind === "text") {
      expect(d2.patch).toContain("+A2-turn");
      expect(d2.patch).not.toContain("A3-external");
    }
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("A3-external\n");
  }, 20_000);

  it("explicit-absent end diff shows the turn's deletion", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "t.txt"), "T1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    rmSync(join(dir, "t.txt")); // worktree-absent, still index-tracked
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    const d = await r.service.diff(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["t.txt"],
      "t.txt",
    );
    expect(d.kind).toBe("text");
    if (d.kind === "text") {
      expect(d.patch).toContain("+++ /dev/null");
      expect(d.patch).toContain("-T1");
    }
  }, 20_000);

  it("a path absent from the base manifest is honestly base-unknown", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    writeFileSync(join(dir, "new.txt"), "created by the turn\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    const d = await r.service.diff(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["new.txt"],
      "new.txt",
    );
    // R1-A: manifest omission is UNKNOWN, not provable creation.
    expect(d.kind).toBe("unavailable");
    if (d.kind === "unavailable") expect(d.reason).toBe("base-unknown");
  }, 20_000);

  it("refuses paths outside the touched set and unsafe paths", async () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "a.txt"), "A1\n");
    commitAll(dir);
    const r = rig({ repoDir: dir });
    const base = await r.service.capture(r.projectId, r.threadId, r.turnId, "before");
    writeFileSync(join(dir, "a.txt"), "A2\n");
    const end = await r.service.capture(r.projectId, r.threadId, r.turnId, "after");
    const outside = await r.service.diff(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["a.txt"],
      "b.txt",
    );
    expect(outside.kind).toBe("unavailable");
    const unsafe = await r.service.diff(
      r.projectId,
      r.threadId,
      base.checkpointId!,
      end.checkpointId!,
      ["a.txt"],
      "../escape",
    );
    expect(unsafe.kind).toBe("unavailable");
    if (unsafe.kind === "unavailable") expect(unsafe.reason).toBe("unsafe-path");
  }, 20_000);
});
