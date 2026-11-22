// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-40 chat lifecycle races (frozen AppModel.swift guards):
//   * a send to an archived chat queues, never starts a turn;
//   * archive stops the running session like runtime.stopSession();
//   * delete/archive during an in-flight worktree create abandons the
//     half-made copy (frozen abandonCreatedWorktree) instead of
//     stranding a checkout;
//   * a library save that cannot write throws so the renderer keeps
//     the composer text;
//   * delete/archive while the auto-worktree probe is in flight can
//     never start a provider on a thread that no longer wants one.

import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import type { GitService } from "../src/main/gitService";
import type { ProviderAdapter, TurnContext } from "../src/main/provider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import type { WorktreeResult } from "../src/shared/types";

const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const st of stores.splice(0)) st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return realpathSync(d);
}

/** A NON-mock adapter that records starts and exposes cancel counts. */
function execProvider(seen: TurnContext[], cancelled: { n: number }): ProviderAdapter {
  return {
    descriptor: { id: "exec-stub", label: "Exec Stub", mode: "codex", synthetic: true },
    start(ctx) {
      seen.push(ctx);
      return { cancel() { cancelled.n += 1; }, resume() {} };
    },
    dispose: () => Promise.resolve({ children: [], orphanedPending: 0 }),
  };
}

type HeldGit = Pick<
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
  | "hydraBackupDiff"
  | "autoWorktreeEligibility"
>;

/** Worktree ops whose `worktreeAdd` (and optionally the eligibility
 *  probe) are held until the test releases them — the async window the
 *  races live in. */
function heldWorktrees(
  removed: string[],
  held: { add?: (r: WorktreeResult) => void; elig?: (v: "eligible") => void },
): HeldGit {
  const fail = { kind: "unavailable" as const, reason: "stub" };
  return {
    autoWorktreeEligibility: () =>
      new Promise((res) => {
        held.elig = () => res("eligible");
      }),
    worktreeCheck: async (_p, name) => ({ kind: "ok" as const, name }),
    worktreeAdd: () =>
      new Promise((res) => {
        held.add = res;
      }),
    worktreeRemove: async (_p, dir) => {
      removed.push(dir);
      return { kind: "removed" as const };
    },
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
    hydraBackupDiff: async () => fail,
  };
}

function rig(seen: TurnContext[], cancelled: { n: number }, worktrees?: HeldGit) {
  const repoDir = tmp("race-repo-");
  writeFileSync(join(repoDir, "a.txt"), "one\n");
  const dataRoot = tmp("race-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, execProvider(seen, cancelled), dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  if (worktrees) engine.attachWorktrees(worktrees);
  return { engine, projectId: project.id, store };
}

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id);

describe("P1-40 chat lifecycle races", () => {
  it("a send to an archived chat queues as a follow-up, never starts", async () => {
    const seen: TurnContext[] = [];
    const r = rig(seen, { n: 0 });
    const t = r.engine.createThread(r.projectId);
    r.engine.archiveThread(t.id);
    const turn = r.engine.sendTurn(t.id, "wake me later");
    // Frozen guard !isArchived → enqueueFollowUp: the queue grows, no
    // turn record, no provider start.
    expect(turn.status).toBe("cancelled");
    const cur = thread(r.engine, t.id)!;
    expect(cur.turn).toBeNull();
    expect(cur.followUps?.map((f) => f.text)).toEqual(["wake me later"]);
    // The queue holds while archived — no drain into a shelved row.
    await new Promise((res) => setTimeout(res, 50));
    expect(seen.length).toBe(0);
  });

  it("archiving a running turn stops the session like stopSession()", async () => {
    const seen: TurnContext[] = [];
    const cancelled = { n: 0 };
    const r = rig(seen, cancelled);
    const t = r.engine.createThread(r.projectId);
    r.engine.sendTurn(t.id, "long work");
    expect(thread(r.engine, t.id)!.turn?.status).toBe("running");
    r.engine.archiveThread(t.id);
    const cur = thread(r.engine, t.id)!;
    expect(cur.turn?.status).toBe("cancelled");
    expect(cancelled.n).toBe(1);
    expect(cur.isArchived).toBe(true);
  });

  it("deleting a thread mid-worktreeAdd abandons the created copy", async () => {
    const removed: string[] = [];
    const held: { add?: (r: WorktreeResult) => void } = {};
    const r = rig([], { n: 0 }, heldWorktrees(removed, held));
    const t = r.engine.createThread(r.projectId);
    const p = r.engine.createThreadWorktree(t.id);
    await waitFor(() => held.add !== undefined);
    r.engine.deleteThread(t.id);
    const dir = join(tmp("race-wt-"), "wt-x");
    mkdirSync(dir, { recursive: true });
    held.add!({ kind: "created", directory: dir, branch: "wt-x" });
    const res = await p;
    // Frozen abandonCreatedWorktree: the copy is removed, never bound.
    expect(res).toEqual({ kind: "unavailable", reason: "abandoned" });
    expect(removed).toEqual([dir]);
  });

  it("archiving a thread mid-worktreeAdd abandons the created copy", async () => {
    const removed: string[] = [];
    const held: { add?: (r: WorktreeResult) => void } = {};
    const r = rig([], { n: 0 }, heldWorktrees(removed, held));
    const t = r.engine.createThread(r.projectId);
    const p = r.engine.createThreadWorktree(t.id);
    await waitFor(() => held.add !== undefined);
    r.engine.archiveThread(t.id);
    const dir = join(tmp("race-wt-"), "wt-y");
    mkdirSync(dir, { recursive: true });
    held.add!({ kind: "created", directory: dir, branch: "wt-y" });
    const res = await p;
    expect(res).toEqual({ kind: "unavailable", reason: "abandoned" });
    expect(removed).toEqual([dir]);
    // The archived thread never gained the binding.
    expect(thread(r.engine, t.id)!.worktreeDir).toBeUndefined();
  });

  it("deleting mid auto-probe never starts the provider", async () => {
    const seen: TurnContext[] = [];
    const removed: string[] = [];
    const held: { elig?: (v: "eligible") => void } = {};
    const r = rig(seen, { n: 0 }, heldWorktrees(removed, held));
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    expect(thread(r.engine, a.id)!.turn?.status).toBe("running");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "second chat");
    await waitFor(() => held.elig !== undefined);
    r.engine.deleteThread(b.id);
    held.elig!("eligible");
    await new Promise((res) => setTimeout(res, 50));
    // Only the holder's turn ever started — the deleted chat's deferred
    // send died with it.
    expect(seen.length).toBe(1);
  });

  it("archiving mid auto-probe stops the deferred send honestly", async () => {
    const seen: TurnContext[] = [];
    const removed: string[] = [];
    const held: { elig?: (v: "eligible") => void } = {};
    const r = rig(seen, { n: 0 }, heldWorktrees(removed, held));
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "second chat");
    await waitFor(() => held.elig !== undefined);
    r.engine.archiveThread(b.id);
    held.elig!("eligible");
    await waitFor(() => thread(r.engine, b.id)!.turn?.status === "cancelled");
    await new Promise((res) => setTimeout(res, 50));
    expect(seen.length).toBe(1);
    expect(thread(r.engine, b.id)!.worktreeDir).toBeUndefined();
  });

  it("a library that cannot save throws so the composer keeps the text", () => {
    const seen: TurnContext[] = [];
    const r = rig(seen, { n: 0 });
    const t = r.engine.createThread(r.projectId);
    r.store.close(); // the write path is gone — ownsWrites false
    expect(() => r.engine.sendTurn(t.id, "do not lose me")).toThrow(/save the library/i);
    // Nothing was recorded and no provider started for an unsaved turn.
    expect(thread(r.engine, t.id)!.messages).toEqual([]);
    expect(thread(r.engine, t.id)!.turn).toBeNull();
    expect(seen.length).toBe(0);
  });

  it("a deferred send rolls back into the composer on gate failure", async () => {
    const seen: TurnContext[] = [];
    const removed: string[] = [];
    // worktreeAdd resolves to a failure — frozen .failed → retain.
    const fail = { kind: "unavailable" as const, reason: "stub" };
    const stub: HeldGit = {
      autoWorktreeEligibility: async () => "eligible" as const,
      worktreeCheck: async (_p, name) => ({ kind: "ok" as const, name }),
      worktreeAdd: async () => fail,
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
      hydraBackupDiff: async () => fail,
    };
    const r = rig(seen, { n: 0 }, stub);
    const unsent: string[] = [];
    r.engine.onEvent((e) => {
      if (e.type === "turn-unsent") unsent.push(e.text);
    });
    const a = r.engine.createThread(r.projectId);
    r.engine.sendTurn(a.id, "holder");
    const b = r.engine.createThread(r.projectId);
    r.engine.sendTurn(b.id, "please stay");
    await waitFor(() => unsent.length === 1);
    expect(unsent[0]).toBe("please stay");
    const cur = thread(r.engine, b.id)!;
    expect(cur.turn).toBeNull();
    expect(cur.messages.at(-1)!.kind).toBe("notice");
    expect(cur.messages.at(-1)!.content).toBe("Could not create a worktree");
    expect(seen.length).toBe(1);
  });

  it("a queue-head retain never flushes — it waits for the next drain", async () => {
    const seen: TurnContext[] = [];
    const r = rig(seen, { n: 0 });
    const t = r.engine.createThread(r.projectId);
    // Frozen: a retained send lands at the head of the queue WITHOUT
    // flushing. Flushing would re-enter sendTurn while the failure that
    // produced the retain still holds — retain→enqueue→drain→fail
    // forever, one notice row per lap.
    r.engine.enqueueFollowUp(t.id, "retained text", { front: true });
    await new Promise((res) => setTimeout(res, 80));
    expect(seen.length).toBe(0);
    expect(thread(r.engine, t.id)!.followUps?.map((f) => f.text)).toEqual([
      "retained text",
    ]);
    // A normal enqueue still flushes while idle — and the retained head
    // of the queue goes first.
    r.engine.enqueueFollowUp(t.id, "normal follow-up");
    await waitFor(() => seen.length > 0);
    expect(seen[0]?.prompt).toContain("retained text");
  });
});
