// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-39 Workspace "auto" (frozen prepareWorkspaceForFirstTurn): the
// default mode edits the project folder while idle; a first send into a
// checkout another chat already claims binds a fresh app-owned worktree
// before the provider starts. Non-Git folders stay local; a checkout
// that cannot host a worktree fails with the frozen wait note.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { GitService } from "../src/main/gitService";
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
// contained runner ("git-containment"): the real-git probe suite is
// POSIX coverage; the stubbed engine cases still run everywhere.
const haveDirectGit = haveGit && process.platform !== "win32";

const stores: Store[] = [];
const services: GitService[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const st of stores.splice(0)) st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return realpathSync(d);
}

const UNAVAILABLE_NOTE =
  "Another chat is active in this repository, and a separate Git worktree isn't available right now. Wait for it to finish, then send again.";

/** A NON-mock adapter: records the TurnContext each turn starts with and
 *  finishes instantly, so tests can assert WHERE the turn ran. */
function execProvider(seen: TurnContext[], opts?: { hold?: boolean }): ProviderAdapter {
  return {
    descriptor: { id: "exec-stub", label: "Exec Stub", mode: "codex", synthetic: true },
    start(ctx, cb) {
      seen.push(ctx);
      if (!opts?.hold) setTimeout(() => cb.onDone(), 1);
      return { cancel() {}, resume() {} };
    },
    dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }),
  };
}

/** A stub GitService slice: eligibility answer + a worktreeAdd that
 *  makes a real dir under <dataRoot>/worktrees/<projectId>/ so the
 *  binding survives dirLive/verifyExec. */
function fakeWorktrees(
  dataRoot: string,
  eligibility: "eligible" | "nonGit" | "unavailable",
): Pick<
  GitService,
  | "worktreeCheck"
  | "worktreeAdd"
  | "worktreeRemove"
  | "branches"
  | "switchBranch"
  | "createBranch"
  | "renameBranch"
  | "hydraCapture"
  | "hydraCopyAdd"
  | "hydraEndTree"
  | "hydraLand"
  | "hydraCopyRemove"
  | "hydraReviewDiff"
  | "autoWorktreeEligibility"
> {
  const fail = { kind: "unavailable" as const, reason: "stub" };
  return {
    autoWorktreeEligibility: async () => eligibility,
    worktreeCheck: async (_p, name) => ({ kind: "ok" as const, name }),
    worktreeAdd: async (projectId) => {
      const parent = join(dataRoot, "worktrees", projectId);
      mkdirSync(parent, { recursive: true });
      const dir = mkdtempSync(join(parent, "wt-auto-"));
      writeFileSync(join(dir, "a.txt"), "one\n");
      return { kind: "created" as const, directory: realpathSync(dir), branch: "auto" };
    },
    worktreeRemove: async () => fail,
    branches: async () => fail,
    switchBranch: async () => fail,
    createBranch: async () => fail,
    renameBranch: async () => fail,
    hydraCapture: async () => fail,
    hydraCopyAdd: async () => fail,
    hydraEndTree: async () => fail,
    hydraLand: async () => fail,
    hydraCopyRemove: async () => fail,
    hydraReviewDiff: async () => fail,
  };
}

function rig(
  eligibility: "eligible" | "nonGit" | "unavailable",
  seen: TurnContext[],
  providerOpts?: { hold?: boolean },
) {
  const repoDir = tmp("wtauto-repo-");
  // A plain folder suffices — the eligibility answer is stubbed; git is
  // only invoked by a real GitService, which this suite never attaches.
  writeFileSync(join(repoDir, "a.txt"), "one\n");
  const dataRoot = tmp("wtauto-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const provider = execProvider(seen, providerOpts);
  const engine = new Engine(store, provider, dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  engine.attachWorktrees(fakeWorktrees(dataRoot, eligibility));
  return { engine, projectId: project.id, repoDir, dataRoot };
}

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const turnStatus = (engine: Engine, id: string) => thread(engine, id).turn?.status;

describe("P1-39 workspace auto mode", () => {
  it("backfills hasStartedTurn for threads written before the flag existed", async () => {
    const dataRoot = tmp("wtauto-data-");
    const ts = 1_000_000;
    // A legacy monolith doc (no turnStorage): history inline, the flag
    // absent — the exact shape an upgraded pre-P1-39 store presents.
    writeFileSync(
      join(dataRoot, "store.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { id: "p1", name: "p1", createdAt: ts, expanded: true },
        ],
        threads: [
          {
            id: "t-old",
            projectId: "p1",
            title: "old chat",
            createdAt: ts,
            updatedAt: ts,
            sessionGrants: [],
            messages: [
              { id: "m1", role: "user", content: "hi", status: "done", ts },
            ],
            turn: null,
          },
          {
            id: "t-blank",
            projectId: "p1",
            title: "blank",
            createdAt: ts,
            updatedAt: ts,
            sessionGrants: [],
            messages: [],
            turn: null,
          },
          {
            // This build's gate-failed first send: explicit false, a
            // persisted errored turn — must NOT be backfilled or the
            // resend writes into the still-busy checkout.
            id: "t-failed",
            projectId: "p1",
            title: "failed first send",
            createdAt: ts,
            updatedAt: ts,
            sessionGrants: [],
            hasStartedTurn: false,
            messages: [
              { id: "m2", role: "user", content: "try", status: "done", ts },
              {
                id: "m3",
                role: "assistant",
                content: "",
                status: "error",
                ts,
                turnId: "u1",
              },
            ],
            turn: {
              id: "u1",
              threadId: "t-failed",
              status: "error",
              seq: 1,
              startedAt: ts,
              endedAt: ts,
              error: "wait for it",
              assistantMessageId: "m3",
            },
          },
        ],
        settings: { theme: "dark", language: "en", alwaysAllow: [] },
        ui: { selectedThreadId: "t-old" },
      }),
    );
    const store = new Store(dataRoot);
    stores.push(store);
    store.open();
    const t = store.state.threads.find((x) => x.id === "t-old")!;
    expect(t.hasStartedTurn).toBe(true);
    // A thread with NO history is not backfilled — it is still on its
    // first turn and the auto gate must stay armed for it.
    expect(store.state.threads.find((x) => x.id === "t-blank")!.hasStartedTurn).not.toBe(true);
    // The explicit-false gate-failed thread keeps its flag across the
    // reload — the backfill only touches ABSENT fields.
    expect(store.state.threads.find((x) => x.id === "t-failed")!.hasStartedTurn).toBe(false);
  });

  it("first send into a busy checkout binds a fresh worktree before the turn starts", async () => {
    const seen: TurnContext[] = [];
    const r = rig("eligible", seen, { hold: true });
    // Thread A holds the checkout: its turn stays running.
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "work in the checkout");
    expect(turnStatus(r.engine, a.id)).toBe("running");

    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "second chat, same repo");
    // The bind is async — the turn runs the moment it lands.
    await waitFor(() => thread(r.engine, b.id).worktreeDir !== undefined);
    await waitFor(() => seen.length === 2);
    const bound = thread(r.engine, b.id).worktreeDir!;
    expect(bound.startsWith(join(r.dataRoot, "worktrees"))).toBe(true);
    // The second turn executes in the worktree, never the shared checkout.
    expect(seen[1]!.workspace?.directory).toBe(bound);
    expect(seen[0]!.workspace?.directory).toBe(r.repoDir);
  });

  it("an idle checkout stays local even in auto mode", async () => {
    const seen: TurnContext[] = [];
    const r = rig("eligible", seen);
    const th = r.engine.createThread(r.projectId);
    r.engine.sendTurn(th.id, "all alone");
    await waitFor(() => turnStatus(r.engine, th.id) === "done");
    expect(thread(r.engine, th.id).worktreeDir).toBeUndefined();
    expect(seen[0]!.workspace?.directory).toBe(r.repoDir);
  });

  it("a non-Git folder stays local even when the checkout is busy", async () => {
    const seen: TurnContext[] = [];
    const r = rig("nonGit", seen, { hold: true });
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "still local");
    await waitFor(() => seen.length === 2);
    expect(thread(r.engine, b.id).worktreeDir).toBeUndefined();
    expect(seen[1]!.workspace?.directory).toBe(r.repoDir);
  });

  it("a busy checkout that cannot host a worktree retains the send with the frozen note", async () => {
    const seen: TurnContext[] = [];
    const r = rig("unavailable", seen, { hold: true });
    const unsent: string[] = [];
    r.engine.onEvent((e) => {
      if (e.type === "turn-unsent" && e.threadId) unsent.push(e.text);
    });
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "no room");
    // Frozen retainUnsentMessage: no failed-turn scar — the bubble pair
    // and turn record roll back, the note lands as a notice row, and
    // the text returns to the composer.
    await waitFor(() => unsent.length === 1);
    const t = thread(r.engine, b.id);
    expect(unsent[0]).toBe("no room");
    expect(t.worktreeDir).toBeUndefined();
    expect(t.turn).toBeNull();
    const notice = t.messages.at(-1)!;
    expect(notice.kind).toBe("notice");
    expect(notice.content).toBe(UNAVAILABLE_NOTE);
    // The provider never started the retained send.
    expect(seen.length).toBe(1);
  });

  it("a gate-retained first send re-arms the busy check on resend", async () => {
    const seen: TurnContext[] = [];
    const r = rig("unavailable", seen, { hold: true });
    const unsent: string[] = [];
    r.engine.onEvent((e) => {
      if (e.type === "turn-unsent") unsent.push(e.text);
    });
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "no room");
    await waitFor(() => unsent.length === 1);
    const t = thread(r.engine, b.id);
    expect(t.turn).toBeNull();
    expect(t.hasStartedTurn).not.toBe(true);
    // Resend while the checkout is still busy: the gate fires AGAIN —
    // never a silent local write into the claimed folder.
    r.engine.sendTurn(b.id, "try again");
    await waitFor(() => unsent.length === 2);
    expect(unsent[1]).toBe("try again");
    expect(thread(r.engine, b.id).turn).toBeNull();
    expect(seen.length).toBe(1);
  });

  it("explicit local and worktree modes are unaffected by a busy checkout", async () => {
    const seen: TurnContext[] = [];
    const r = rig("eligible", seen, { hold: true });
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    r.engine.setSettings({ defaultWorkspaceMode: "local" });
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "local mode stays local");
    await waitFor(() => seen.length === 2);
    expect(thread(r.engine, b.id).worktreeDir).toBeUndefined();
    expect(seen[1]!.workspace?.directory).toBe(r.repoDir);
  });
});

function realGit(dir: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd: dir,
    env: {
      PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  });
}

function mkRepo(): string {
  const dir = tmp("wtauto-real-");
  realGit(dir, ["init", "-b", "main"]);
  realGit(dir, ["config", "user.email", "test@example.com"]);
  realGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  realGit(dir, ["add", "."]);
  realGit(dir, ["commit", "-m", "init"]);
  return dir;
}

function realGitService(repoDir: string) {
  const dataRoot = tmp("wtauto-gdata-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, { descriptor: { id: "m", label: "M", mode: "mock", synthetic: true }, start() { throw new Error("never"); }, dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }) } as ProviderAdapter, dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  const git = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => true,
    emit: () => {},
    dataRoot,
  });
  services.push(git);
  return { git, projectId: project.id };
}

describe.skipIf(!haveDirectGit)("autoWorktreeEligibility — real git probe", () => {
  it("a plain folder answers nonGit so the send stays local", async () => {
    const dir = tmp("wtauto-plain-");
    const r = realGitService(dir);
    expect(await r.git.autoWorktreeEligibility(r.projectId)).toBe("nonGit");
  });

  it("a repo root with commits and no operation answers eligible", async () => {
    const r = realGitService(mkRepo());
    expect(await r.git.autoWorktreeEligibility(r.projectId)).toBe("eligible");
  });

  it("an empty repo without commits answers unavailable", async () => {
    const dir = tmp("wtauto-empty-");
    realGit(dir, ["init", "-b", "main"]);
    const r = realGitService(dir);
    expect(await r.git.autoWorktreeEligibility(r.projectId)).toBe("unavailable");
  });

  it("a project inside a repo's subdirectory answers unavailable (root mismatch)", async () => {
    const repo = mkRepo();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const r = realGitService(sub);
    expect(await r.git.autoWorktreeEligibility(r.projectId)).toBe("unavailable");
  });

  it("a repo mid-merge answers unavailable (frozen op-in-progress)", async () => {
    const repo = mkRepo();
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), realGit(repo, ["rev-parse", "HEAD"]));
    const r = realGitService(repo);
    expect(await r.git.autoWorktreeEligibility(r.projectId)).toBe("unavailable");
  });
});
