// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22 Hydra isolation (frozen makeHydraCopy / applyHydraHead): a capture
// carries the checkout's working state (uncommitted + untracked) into a
// commit no branch sees; a head works in a detached copy of it; on its
// report the copy's diff lands three-way back into the checkout —
// conflicts merge with markers, an unsafe landing keeps its patch, and
// an uncopyable checkout honestly keeps the shared one.

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
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { GitService } from "../src/main/gitService";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";

const GIT = process.platform === "win32" ? "git.exe" : "git";
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
  return d;
}

function git(dir: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd: dir,
    env: {
      // POSIX keeps the deterministic minimal PATH; Windows has no
      // /usr/bin — stripping the system PATH loses git.exe entirely.
      PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
    encoding: "utf8",
  });
}

function mkRepo(): string {
  const dir = tmp("hydra-iso-repo-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function rig(repoDir: string, tickMs = 1) {
  const dataRoot = tmp("hydra-iso-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs }), dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(repoDir);
  const git = new GitService({
    paths,
    projects: () => engine.snapshot().projects,
    mutable: () => true,
    emit: () => {},
    dataRoot,
  });
  services.push(git);
  engine.attachWorktrees(git);
  return { engine, git, projectId: project.id, dataRoot };
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
const heads = (engine: Engine, leadId: string) =>
  engine
    .snapshot()
    .threads.filter((t) => t.hydraHead?.leadId === leadId)
    .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt);

describe.skipIf(!haveDirectGit)("hydra copies — service slice (frozen HydraTreeCache)", () => {
  it("capture carries uncommitted and untracked state; HEAD stays put", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    writeFileSync(join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();
    const cap = await r.git.hydraCapture(r.projectId, repo);
    expect(cap.kind).toBe("captured");
    if (cap.kind !== "captured") return;
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    // The captured tree sees both files; HEAD's tree does not.
    expect(git(repo, ["ls-tree", "-r", "--name-only", cap.tree])).toContain("new.txt");
    expect(git(repo, ["show", `${cap.tree}:a.txt`])).toContain("changed");
    // The hidden commit sits on top of HEAD for copy checkouts.
    expect(git(repo, ["rev-parse", `${cap.commit}^`])).toContain(headBefore);
  });

  it("copy checkout contains the working state, detached and app-owned", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    writeFileSync(join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    const cap = await r.git.hydraCapture(r.projectId, repo);
    if (cap.kind !== "captured") throw new Error("capture failed");
    const copy = await r.git.hydraCopyAdd(r.projectId, "hank", cap.commit);
    expect(copy.kind).toBe("created");
    if (copy.kind !== "created") return;
    // realpath both sides — /var vs /private/var on the macOS host.
    expect(
      copy.directory.startsWith(
        realpathSync(join(r.dataRoot, "worktrees")) + sep,
      ),
    ).toBe(true);
    expect(readFileSync(join(copy.directory, "a.txt"), "utf8")).toBe("one\nchanged\n");
    expect(readFileSync(join(copy.directory, "new.txt"), "utf8")).toBe("fresh\n");
    expect(git(repo, ["-C", copy.directory, "rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD\n");
    const gone = await r.git.hydraCopyRemove(r.projectId, copy.directory);
    expect(gone.kind).toBe("removed");
    expect(existsSync(copy.directory)).toBe(false);
  });

  it("a head's diff lands into the checkout; unrelated checkout work coexists", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const cap = await r.git.hydraCapture(r.projectId, repo);
    if (cap.kind !== "captured") throw new Error("capture failed");
    const copy = await r.git.hydraCopyAdd(r.projectId, "hank", cap.commit);
    if (copy.kind !== "created") throw new Error("copy failed");
    // The head adds a file; the lead meanwhile edits a DIFFERENT file.
    writeFileSync(join(copy.directory, "from-head.txt"), "head wrote this\n");
    writeFileSync(join(repo, "lead.txt"), "lead moved on\n");
    const end = await r.git.hydraEndTree(r.projectId, copy.directory, cap.tree);
    if (end.kind !== "ok") throw new Error("endTree failed");
    const res = await r.git.hydraLand(r.projectId, repo, "hank", "deadbeef", cap.tree, end.tree);
    expect(res.kind).toBe("landed");
    if (res.kind !== "landed") return;
    expect(res.files.map((f) => f.path)).toEqual(["from-head.txt"]);
    expect(res.conflicts).toEqual([]);
    expect(readFileSync(join(repo, "from-head.txt"), "utf8")).toBe("head wrote this\n");
    expect(readFileSync(join(repo, "lead.txt"), "utf8")).toBe("lead moved on\n");
  });

  it("a same-file landing merges three-way and names its conflicts", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const cap = await r.git.hydraCapture(r.projectId, repo);
    if (cap.kind !== "captured") throw new Error("capture failed");
    const copy = await r.git.hydraCopyAdd(r.projectId, "hank", cap.commit);
    if (copy.kind !== "created") throw new Error("copy failed");
    writeFileSync(join(copy.directory, "a.txt"), "one\nhead version\n");
    writeFileSync(join(repo, "a.txt"), "one\ncheckout moved\n");
    const end = await r.git.hydraEndTree(r.projectId, copy.directory, cap.tree);
    if (end.kind !== "ok") throw new Error("endTree failed");
    const res = await r.git.hydraLand(r.projectId, repo, "hank", "deadbeef", cap.tree, end.tree);
    expect(res.kind).toBe("landed");
    if (res.kind !== "landed") return;
    expect(res.conflicts).toEqual(["a.txt"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("a checkout mid-operation keeps the work as a patch, honestly", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const cap = await r.git.hydraCapture(r.projectId, repo);
    if (cap.kind !== "captured") throw new Error("capture failed");
    const copy = await r.git.hydraCopyAdd(r.projectId, "hank", cap.commit);
    if (copy.kind !== "created") throw new Error("copy failed");
    writeFileSync(join(copy.directory, "from-head.txt"), "head wrote this\n");
    const end = await r.git.hydraEndTree(r.projectId, copy.directory, cap.tree);
    if (end.kind !== "ok") throw new Error("endTree failed");
    // Simulate an in-progress merge: the landing refuses to touch the
    // checkout and keeps the diff on disk instead.
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), git(repo, ["rev-parse", "HEAD"]));
    const res = await r.git.hydraLand(r.projectId, repo, "hank", "deadbeef", cap.tree, end.tree);
    expect(res.kind).toBe("patch");
    if (res.kind !== "patch") return;
    expect(res.patchPath).toBeTruthy();
    expect(res.error).toContain("rebase or merge");
    expect(existsSync(res.patchPath!)).toBe(true);
    expect(existsSync(join(repo, "from-head.txt"))).toBe(false);
  });

  it("a head that changed nothing lands cleanly", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const cap = await r.git.hydraCapture(r.projectId, repo);
    if (cap.kind !== "captured") throw new Error("capture failed");
    const res = await r.git.hydraLand(r.projectId, repo, "hank", "deadbeef", cap.tree, cap.tree);
    expect(res).toEqual({ kind: "landed", files: [], conflicts: [] });
  });

  it("a plain directory honestly cannot be captured or copied", async () => {
    const plain = tmp("hydra-iso-plain-");
    const r = rig(plain);
    const cap = await r.git.hydraCapture(r.projectId, plain);
    expect(cap.kind).toBe("unavailable");
    if (cap.kind !== "unavailable") return;
    expect(cap.reason).toBe("not-a-repository");
  });

  it("end/land refuse a directory outside the app-owned copy root", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    const cap = await r.git.hydraCapture(r.projectId, repo);
    if (cap.kind !== "captured") throw new Error("capture failed");
    const foreign = tmp("hydra-iso-foreign-");
    const end = await r.git.hydraEndTree(r.projectId, foreign, cap.tree);
    expect(end.kind).toBe("unavailable");
    const land = await r.git.hydraLand(r.projectId, foreign, "hank", "deadbeef", cap.tree, cap.tree);
    expect(land.kind).toBe("unavailable");
  });
});

describe.skipIf(!haveDirectGit)("hydra isolation — engine slice (frozen makeHydraCopy)", () => {
  it("isolated heads run in copies and their work lands in the checkout", async () => {
    const repo = mkRepo();
    const r = rig(repo, 40); // slow head turns: the copy is observable mid-flight
    r.engine.setSettings({ hydraIsolateHeads: true });
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");

    await waitFor(() => heads(r.engine, lead.id).length === 2);
    // Copy creation is async git work — wait until both heads are bound
    // to their copies (baseTree/landingCheckout are stamped together).
    await waitFor(() =>
      heads(r.engine, lead.id).every((h) => h.worktreeDir !== undefined),
    );
    const wtRoot = realpathSync(join(r.dataRoot, "worktrees")) + sep;
    for (const h of heads(r.engine, lead.id)) {
      expect(realpathSync(h.worktreeDir!).startsWith(wtRoot)).toBe(true);
      expect(h.hydraHead!.baseTree).toMatch(/^[0-9a-f]{40}$/);
      expect(realpathSync(h.hydraHead!.landingCheckout!)).toBe(realpathSync(repo));
    }

    // Heads finish → landing resolves → the files they wrote in their
    // copies appear in the real checkout; the copies are released.
    await waitFor(() =>
      existsSync(join(repo, "hydra-alpha.txt")) &&
      existsSync(join(repo, "hydra-beta.txt")),
    );
    await waitFor(() =>
      heads(r.engine, lead.id).every(
        (h) => h.hydraHead!.status === "completed" && h.hydraHead!.landingPending !== true,
      ),
    );
    for (const h of heads(r.engine, lead.id)) {
      expect(h.worktreeDir).toBeUndefined();
      expect(h.hydraHead!.landing?.files.length).toBeGreaterThan(0);
      expect(h.hydraHead!.copyKept).not.toBe(true);
    }
    expect(readFileSync(join(repo, "hydra-alpha.txt"), "utf8")).toContain("hydra-alpha.txt");

    // The batch report names where the work went (frozen landingLine).
    await waitFor(() =>
      thread(r.engine, lead.id).messages.some(
        (m) => m.role === "user" && m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(r.engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("Landed in your checkout");
    expect(report.content).toContain("hydra-alpha.txt");

    // Regression: a head's summary rides inside the report turn's prompt,
    // so fixture markers must never echo back — a carried `[mock:touch]`
    // would re-run the write in the LEAD's workspace (the checkout).
    for (const h of heads(r.engine, lead.id))
      for (const m of h.messages)
        if (m.role === "assistant") expect(m.content).not.toContain("[mock:");
    expect(report.content).not.toContain("[mock:");

    // The brief arriving on a head's thread is marked (frozen
    // message.isHydraBrief) — the pill render keys off it.
    for (const h of heads(r.engine, lead.id)) {
      const brief = h.messages.find((m) => m.role === "user");
      expect(brief?.hydraBrief).toBe(true);
    }
    // …while the lead's own turns and the report batch are NOT briefs.
    for (const m of thread(r.engine, lead.id).messages)
      expect(m.hydraBrief).not.toBe(true);
  });

  it("a steered isolated head binds a fresh copy and lands only the new work", async () => {
    const repo = mkRepo();
    const r = rig(repo, 30);
    r.engine.setSettings({ hydraIsolateHeads: true });
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(
      () =>
        heads(r.engine, lead.id).length === 2 &&
        heads(r.engine, lead.id).every(
          (h) => h.hydraHead!.status === "completed" && h.hydraHead!.landingPending !== true,
        ),
    );
    const hank = heads(r.engine, lead.id)[0]!;
    const firstCopy = hank.worktreeDir;
    expect(firstCopy).toBeUndefined(); // released after a clean landing

    // Steer the head on: fresh capture + fresh copy, only the new write lands.
    r.engine.sendTurn(hank.id, "more work [mock:touch hydra-alpha2.txt]");
    await waitFor(() => hank.worktreeDir !== undefined);
    const steerCopy = hank.worktreeDir!;
    const wtRoot = realpathSync(join(r.dataRoot, "worktrees")) + sep;
    expect(realpathSync(steerCopy).startsWith(wtRoot)).toBe(true);
    await waitFor(
      () => existsSync(join(repo, "hydra-alpha2.txt")),
      15_000,
    );
    await waitFor(() =>
      hank.hydraHead!.status === "completed" && hank.hydraHead!.landingPending !== true,
    );
    // Only the steer turn's write landed — the base moved to the fresh
    // capture, so earlier work isn't reported twice (frozen).
    const paths = hank.hydraHead!.landing!.files.map((f) => f.path);
    expect(paths).toEqual(["hydra-alpha2.txt"]);
    expect(hank.worktreeDir).toBeUndefined();
    expect(existsSync(steerCopy)).toBe(false);
    // The lead hears it as a second, solo report.
    await waitFor(
      () =>
        thread(r.engine, lead.id).messages.filter((m) =>
          m.content.includes("Hydra reports:"),
        ).length === 2,
    );
    await waitFor(() => thread(r.engine, lead.id).turn?.status === "done");
  });

  it("a head messaged while its copy binds keeps the brief queued, never fails (2.2.12)", async () => {
    const repo = mkRepo();
    const r = rig(repo, 1);
    r.engine.setSettings({ hydraIsolateHeads: true });
    const lead = r.engine.createThread(r.projectId);
    // The head's insert emits thread-updated while its copy bind is still
    // in flight — a user message landing in that window starts the head's
    // own turn before the delegation brief can send.
    let raced = false;
    const off = r.engine.onEvent((e) => {
      if (e.type === "thread-added" && e.thread.hydraHead && !raced) {
        raced = true;
        // A held approval turn keeps the head busy deterministically —
        // the copy bind resolves long before it ends.
        r.engine.sendTurn(e.thread.id, "hold [mock:approval]");
      }
    });
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => heads(r.engine, lead.id).length === 2);
    off();
    expect(raced).toBe(true);
    // The brief lands while the raced head is still waiting on its
    // approval — busy is not a start failure: the brief queues at the
    // front and the head is never failed.
    await waitFor(() =>
      heads(r.engine, lead.id).some((x) => x.followUps?.length === 1),
    );
    const racedHead = heads(r.engine, lead.id).find(
      (x) => x.followUps?.length === 1,
    )!;
    expect(racedHead.hydraHead!.status).not.toBe("failed");
    expect(racedHead.hydraHead!.summary ?? "").not.toContain("could not start");
    expect(racedHead.turn?.status).toBe("waiting-approval");
    // Resolving the head's own turn lets the queued brief drain — the
    // head then does its delegated work (writes its file) and completes.
    r.engine.resolveApproval(racedHead.id, racedHead.turn!.approval!.id, "once");
    await waitFor(
      () =>
        existsSync(join(repo, "hydra-alpha.txt")) &&
        heads(r.engine, lead.id).find((x) => x.id === racedHead.id)!.hydraHead!
          .status === "completed",
      15_000,
    );
    const after = heads(r.engine, lead.id).find((x) => x.id === racedHead.id)!;
    expect(after.followUps?.length ?? 0).toBe(0);
    expect(after.hydraHead!.summary ?? "").not.toContain("could not start");
  });

  it("a stopped isolated head keeps its copy and carries on inside it", async () => {
    const repo = mkRepo();
    const r = rig(repo, 30);
    r.engine.setSettings({ hydraIsolateHeads: true });
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "go [mock:hydra-wait]");
    await waitFor(
      () =>
        heads(r.engine, lead.id).length === 1 &&
        heads(r.engine, lead.id)[0]!.turn?.status === "waiting-approval",
    );
    const hank = heads(r.engine, lead.id)[0]!;
    const kept = hank.worktreeDir!;
    expect(kept).toBeTruthy();
    r.engine.stopHydraHead(hank.id);
    await waitFor(() => hank.hydraHead!.status === "stopped");
    // Frozen: no landing for unfinished work — the copy stays, named in
    // the report, so a later turn can carry on from it.
    expect(hank.hydraHead!.copyKept).toBe(true);
    expect(hank.worktreeDir).toBe(kept);
    expect(hank.hydraHead!.landing).toBeUndefined();
    expect(existsSync(kept)).toBe(true);

    // Steering continues in the SAME copy — not a fresh capture.
    r.engine.sendTurn(hank.id, "finish it [mock:touch hydra-beta.txt]");
    await waitFor(() => hank.turn?.status === "running");
    expect(hank.worktreeDir).toBe(kept);
    await waitFor(() =>
      hank.hydraHead!.status === "completed" && hank.hydraHead!.landingPending !== true,
    );
    // Now that it completed, its accumulated work lands and the copy goes.
    expect(readFileSync(join(repo, "hydra-beta.txt"), "utf8")).toContain("hydra-beta.txt");
    expect(hank.worktreeDir).toBeUndefined();
    expect(hank.hydraHead!.copyKept).not.toBe(true);
    await waitFor(() => thread(r.engine, lead.id).turn?.status === "done");
  });

  it("a steer mid-landing defers the old report to the new turn", async () => {
    const repo = mkRepo();
    const r = rig(repo, 30);
    r.engine.setSettings({ hydraIsolateHeads: true });
    // Park hank's landing inside hydraLand so the steer lands squarely
    // while `landingPending` is live.
    let releaseLanding!: () => void;
    const gate = new Promise<void>((res) => (releaseLanding = res));
    let gateEntered!: () => void;
    const gateWait = new Promise<void>((res) => (gateEntered = res));
    const origLand = r.git.hydraLand.bind(r.git);
    let parked = false;
    (r.git as { hydraLand: GitService["hydraLand"] }).hydraLand = async (
      projectId,
      checkout,
      slug,
      headKey,
      base,
      end,
    ) => {
      if (slug === "hank" && !parked) {
        parked = true;
        gateEntered();
        await gate;
      }
      return origLand(projectId, checkout, slug, headKey, base, end);
    };
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => parked);
    const hank = heads(r.engine, lead.id).find(
      (h) => h.hydraHead!.name === "Hank",
    )!;
    expect(hank.hydraHead!.landingPending).toBe(true);
    const oldCopy = hank.worktreeDir!;

    // Steer while the landing is parked: the turn is live immediately,
    // the copy resolution waits for the landing to settle.
    r.engine.sendTurn(hank.id, "more work [mock:touch hydra-alpha3.txt]");
    expect(hank.hydraHead!.status).toBe("running");
    expect(hank.turn?.status).toBe("running");
    expect(hank.worktreeDir).toBe(oldCopy);

    // The parked landing still owns the copy — the steer turn has not
    // started writing (its assistant reply is still empty).
    releaseLanding();
    await waitFor(() => existsSync(join(repo, "hydra-alpha.txt")));
    // The landing released its copy; the steer gate binds a fresh one.
    await waitFor(
      () => hank.worktreeDir !== undefined && hank.worktreeDir !== oldCopy,
    );
    const steerCopy = hank.worktreeDir!;
    expect(steerCopy).not.toBe(oldCopy);
    await waitFor(
      () =>
        hank.hydraHead!.status === "completed" &&
        hank.hydraHead!.landingPending !== true,
      15_000,
    );
    // Old landing stood (alpha is in the checkout); the new landing
    // reports only the steer turn's work — its base moved past it.
    expect(hank.hydraHead!.landing!.files.map((f) => f.path)).toEqual([
      "hydra-alpha3.txt",
    ]);
    expect(existsSync(join(repo, "hydra-alpha3.txt"))).toBe(true);
    // Hank reports exactly once — the parked landing's report deferred
    // to the new turn instead of flushing a stale one mid-steer. A
    // report names what it landed: the suppressed report would have
    // named hydra-alpha.txt (zero mentions), the real one names the
    // steer turn's hydra-alpha3.txt (exactly one).
    await waitFor(() =>
      thread(r.engine, lead.id).messages.some(
        (m) =>
          m.content.includes("Hydra reports:") &&
          m.content.includes("hydra-alpha3.txt"),
      ),
    );
    const reports = thread(r.engine, lead.id).messages.filter((m) =>
      m.content.includes("Hydra reports:"),
    );
    expect(
      reports.filter((m) => m.content.includes("hydra-alpha.txt")).length,
    ).toBe(0);
    expect(
      reports.filter((m) => m.content.includes("hydra-alpha3.txt")).length,
    ).toBe(1);
    expect(hank.worktreeDir).toBeUndefined();
    await waitFor(() => thread(r.engine, lead.id).turn?.status === "done");
  });

});

// Shared-checkout paths need no Git ops — they run on Windows too, where
// isolated copies honestly require the contained runner the rigs lack.
describe("hydra shared-checkout fallbacks", () => {
  it("isolation off keeps the frozen shared-checkout behaviour", async () => {
    const repo = mkRepo();
    const r = rig(repo);
    r.engine.setSettings({ hydraIsolateHeads: false });
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => heads(r.engine, lead.id).length === 2);
    await waitFor(() =>
      heads(r.engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    for (const h of heads(r.engine, lead.id)) {
      expect(h.hydraHead!.baseTree).toBeUndefined();
      expect(h.hydraHead!.landing).toBeUndefined();
    }
    // Shared checkout: the heads' files are there directly, no landing.
    expect(existsSync(join(repo, "hydra-alpha.txt"))).toBe(true);
  });

  it("an uncopyable checkout honestly keeps the shared one", async () => {
    const plain = tmp("hydra-iso-plain-");
    const r = rig(plain);
    r.engine.setSettings({ hydraIsolateHeads: true });
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => heads(r.engine, lead.id).length === 2);
    await waitFor(() =>
      heads(r.engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    for (const h of heads(r.engine, lead.id)) {
      expect(h.hydraHead!.baseTree).toBeUndefined();
      expect(h.hydraHead!.landingCheckout).toBeUndefined();
      expect(h.worktreeDir).toBeUndefined();
    }
    // The head still ran — in the shared checkout, as it honestly would.
    expect(existsSync(join(plain, "hydra-alpha.txt"))).toBe(true);
  });

  it("a vanished checkout fails the heads at spawn and still reports (2.2.12)", async () => {
    const plain = tmp("hydra-iso-plain-");
    const r = rig(plain);
    r.engine.setSettings({ hydraIsolateHeads: false });
    // The grant still exists but the directory is gone — the checkout
    // cannot be read, so each head ends failed instead of running
    // without a turn.
    rmSync(plain, { recursive: true, force: true });
    const lead = r.engine.createThread(r.projectId);
    r.engine.sendTurn(lead.id, "split it [mock:hydra]");
    await waitFor(() => heads(r.engine, lead.id).length === 2);
    await waitFor(() =>
      heads(r.engine, lead.id).every((h) => h.hydraHead!.status === "failed"),
    );
    for (const h of heads(r.engine, lead.id)) {
      expect(h.turn).toBeNull();
      expect(h.hydraHead!.summary).toContain("checkout could not be read");
    }
    // The lead hears each failure once as a note…
    const notes = thread(r.engine, lead.id).messages.filter(
      (m) =>
        m.kind === "notice" && m.content.includes("checkout could not be read"),
    );
    expect(notes).toHaveLength(2);
    // …and once the lead is idle the batch's report arrives — the
    // failed spawn never leaves it queued.
    await waitFor(() =>
      thread(r.engine, lead.id).messages.some(
        (m) => m.role === "user" && m.content.includes("Hydra reports:"),
      ),
    );
    const report = thread(r.engine, lead.id).messages.find((m) =>
      m.content.includes("Hydra reports:"),
    )!;
    expect(report.content).toContain("(failed)");
    expect(report.content).toContain("checkout could not be read");
    await waitFor(() => thread(r.engine, lead.id).turn?.status === "done");
  });
});
