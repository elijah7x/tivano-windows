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
import type { GitService } from "../src/main/gitService";
import type { ProviderAdapter, TurnContext } from "../src/main/provider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";

const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
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

  it("a busy checkout that cannot host a worktree fails with the frozen note", async () => {
    const seen: TurnContext[] = [];
    const r = rig("unavailable", seen, { hold: true });
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "no room");
    await waitFor(() => turnStatus(r.engine, b.id) === "error");
    const t = thread(r.engine, b.id);
    expect(t.worktreeDir).toBeUndefined();
    expect(t.turn?.error).toBe(UNAVAILABLE_NOTE);
    // The provider never started the failed send.
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
