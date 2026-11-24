// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-08 heads in non-Git folders (frozen routeHydraHead slice): an
// absolute-path "project" resolves to a working folder — created when
// its parent exists, refused on system roots, file paths and repos
// Tivano cannot read — a non-Git folder is changed in place (no copy,
// no merge) and joins the sidebar.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import {
  copyHydraOwnedFiles,
  hydraBackupReport,
  hydraCanonical,
  hydraOwnedDirectory,
  hydraOwnedPathIsSafe,
  hydraOwnershipPath,
} from "../src/main/hydraBackup";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import { delegatedHeadPrompt, personaAt } from "../src/shared/hydraDelegation";

const roots: string[] = [];
function tmp(prefix = "tivano-nongit-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function rig(tickMs = 1) {
  const dataRoot = tmp("tivano-nongit-data-");
  const store = new Store(dataRoot);
  store.open();
  const paths = new ProjectRuntimePaths(
    [],
    join(dataRoot, "grants.json"),
    dataRoot,
  );
  const engine = new Engine(
    store,
    new MockProvider({ tickMs }),
    dataRoot,
    "0.0.0-test",
    paths,
  );
  const leadDir = tmp("tivano-lead-");
  const { project } = engine.openUserDirectory(leadDir);
  return { engine, paths, projectId: project.id, dataRoot };
}

const heads = (engine: Engine, leadId: string) =>
  engine
    .snapshot()
    .threads.filter((t) => t.hydraHead?.leadId === leadId)
    .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt);

const notices = (engine: Engine, leadId: string) =>
  engine
    .snapshot()
    .threads.find((t) => t.id === leadId)!
    .messages.filter((m) => m.kind === "notice")
    .map((m) => m.content);

describe("P1-08 heads in non-Git folders (frozen routeHydraHead)", () => {
  it("a non-Git folder is routed, joins the sidebar and is worked in place", async () => {
    const { engine } = rig();
    const folder = join(tmp("tivano-target-"), "plain-folder");
    mkdirSync(folder, { recursive: true });
    const canonical = realpathSync(folder);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${folder}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const info = head.hydraHead!;
    expect(info.isNonGitCheckout).toBe(true);
    expect(info.targetCheckout).toBe(canonical);
    expect(head.worktreeDir).toBeUndefined();
    // The routed folder joined the sidebar as a bound project.
    const project = engine
      .snapshot()
      .projects.find((p) => p.directory === canonical);
    expect(project).toBeDefined();
    expect(head.projectId).toBe(project!.id);
    // The brief carries the shared-folder rule, not the copy wording.
    await waitFor(() => info.status === "completed");
    const brief = head.messages.find(
      (m) => m.role === "user" && m.content.includes("not a Git repository"),
    );
    expect(brief).toBeDefined();
    // In-place work means no copy fields anywhere.
    expect(info.baseTree).toBeUndefined();
    expect(info.landingCheckout).toBeUndefined();
  });

  it("a missing folder is created when its parent exists", async () => {
    const { engine } = rig();
    const parent = tmp("tivano-parent-");
    const folder = join(parent, "made-here");
    expect(existsSync(folder)).toBe(false);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${folder}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("completed");
    expect(existsSync(folder)).toBe(true);
    expect(head.hydraHead!.isNonGitCheckout).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("system folders are refused", async () => {
    const { engine } = rig();
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${sys}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("is a system folder");
    expect(
      notices(engine, lead.id).some((n) => n.includes("is a system folder")),
    ).toBe(true);
  });

  it("a folder containing a protected root is refused", async () => {
    const { engine, dataRoot } = rig();
    // Frozen hydraPathTouchesProtectedRoot is bidirectional: the data
    // root's parent would let a head write next to Tivano's own state.
    const ancestor = dirname(dataRoot);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${ancestor}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("is a system folder");
  });

  it.skipIf(process.platform !== "win32")(
    "an 8.3 short-name alias of a protected root is refused",
    async () => {
      const { engine } = rig();
      // 8.3 names exist only where the volume keeps them — probe the
      // canonical expansion before asserting a refusal.
      let probe: string | null = null;
      try {
        probe = realpathSync.native("C:\\PROGRA~1");
      } catch {
        probe = null;
      }
      if (!probe || !/program files/i.test(probe)) return;
      const lead = engine.createThread(null, "lead");
      engine.sendTurn(lead.id, "do it [mock:hydra-path]C:\\PROGRA~1");
      await waitFor(() => heads(engine, lead.id).length === 1);
      const head = heads(engine, lead.id)[0]!;
      await waitFor(() => head.hydraHead!.status !== "running");
      expect(head.hydraHead!.status).toBe("failed");
      expect(head.hydraHead!.summary).toContain("is a system folder");
    },
  );

  it("a leading ~ expands to the home folder before routing", async () => {
    const { engine } = rig();
    // The expanded route must behave exactly like spelling the home
    // folder out — an unexpanded ~ would fail "no project named".
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "do it [mock:hydra-path]~");
    const lead2 = engine.createThread(null, "lead2");
    engine.sendTurn(lead2.id, `do it [mock:hydra-path]${homedir()}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    await waitFor(() => heads(engine, lead2.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const twin = heads(engine, lead2.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    await waitFor(() => twin.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe(twin.hydraHead!.status);
    expect(head.hydraHead!.summary).not.toContain("no project named");
    expect(head.hydraHead!.targetCheckout).toBe(
      twin.hydraHead!.targetCheckout,
    );
  });

  it("a quoted path with a space routes whole", async () => {
    const { engine } = rig();
    const folder = join(tmp("tivano-space-"), "with space");
    mkdirSync(folder, { recursive: true });
    const canonical = realpathSync(folder);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]"${folder}"`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("completed");
    expect(head.hydraHead!.targetCheckout).toBe(canonical);
  });

  it.skipIf(process.platform !== "win32")("a namespace-prefixed system folder is refused too", async () => {
    const { engine } = rig();
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const escaped = join(sys, "made-here");
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]\\\\?\\${escaped}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("is a system folder");
    expect(existsSync(escaped)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("a device path that strips to a relative name is refused", async () => {
    const { engine } = rig();
    // \\.\PhysicalDrive0 loses its prefix and must not reach mkdirSync
    // as a CWD-relative name.
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "do it [mock:hydra-path]\\\\.\\PhysicalDrive0");
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("is not a folder");
    expect(existsSync("PhysicalDrive0")).toBe(false);
  });

  it("a missing leaf under a junction into a protected root is refused", async () => {
    const { engine, dataRoot } = rig();
    const base = tmp("tivano-junction-");
    const junction = join(base, "junc");
    try {
      symlinkSync(dataRoot, junction, "junction");
    } catch {
      // Host cannot make junctions — nothing to prove here.
      return;
    }
    const leaf = join(junction, "newleaf");
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${leaf}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("is a system folder");
    // The unresolved form pointed into the data root — nothing created.
    expect(existsSync(join(dataRoot, "newleaf"))).toBe(false);
  });

  it("a file path and a missing parent are refused", async () => {
    const { engine } = rig();
    const parent = tmp("tivano-file-");
    const file = join(parent, "plain.txt");
    writeFileSync(file, "x");
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${file}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("is not a folder");

    const lead2 = engine.createThread(null, "lead2");
    const gone = join(parent, "no-such-parent", "kid");
    engine.sendTurn(lead2.id, `do it [mock:hydra-path]${gone}`);
    await waitFor(() => heads(engine, lead2.id).length === 1);
    const head2 = heads(engine, lead2.id)[0]!;
    await waitFor(() => head2.hydraHead!.status !== "running");
    expect(head2.hydraHead!.status).toBe("failed");
    expect(head2.hydraHead!.summary).toContain("is not a folder");
    expect(existsSync(gone)).toBe(false);
  });

  it("a repo Tivano cannot read is refused, a readable one is not", async () => {
    const { engine } = rig();
    // .git dir exists but holds no HEAD — a broken checkout, not a folder.
    const broken = join(tmp("tivano-broken-"), "repo");
    mkdirSync(join(broken, ".git"), { recursive: true });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${broken}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("not a Git checkout");

    // A readable .git marks a Git checkout — the head is not non-Git.
    const repo = join(tmp("tivano-repo-"), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const lead2 = engine.createThread(null, "lead2");
    engine.sendTurn(lead2.id, `do it [mock:hydra-path]${repo}`);
    await waitFor(() => heads(engine, lead2.id).length === 1);
    const head2 = heads(engine, lead2.id)[0]!;
    await waitFor(() => head2.hydraHead!.status !== "running");
    expect(head2.hydraHead!.status).toBe("completed");
    expect(head2.hydraHead!.isNonGitCheckout).toBe(false);
    expect(head2.hydraHead!.targetCheckout).toBe(realpathSync(repo));
    // The routed repo joins the sidebar as a bound project — the head's
    // execution dir resolves through it on every provider path.
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const bound = engine
      .snapshot()
      .projects.find(
        (p) =>
          p.directory !== undefined &&
          norm(p.directory) === norm(realpathSync(repo)),
      );
    expect(bound).toBeDefined();
    expect(head2.projectId).toBe(bound!.id);
  });

  it("a routed subdir of a repo binds the checkout at the repo top", async () => {
    const { engine } = rig();
    // Frozen: checkout = rev-parse --show-toplevel — a named folder
    // inside a repo routes the head's checkout to the repo root, so the
    // copy and the landing cover the whole checkout, not the subdir.
    const repo = join(tmp("tivano-top-"), "repo");
    const sub = join(repo, "sub");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(sub, { recursive: true });
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${sub}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("completed");
    expect(head.hydraHead!.isNonGitCheckout).toBe(false);
    expect(head.hydraHead!.targetCheckout).toBe(realpathSync(repo));
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const bound = engine
      .snapshot()
      .projects.find(
        (p) =>
          p.directory !== undefined &&
          norm(p.directory) === norm(realpathSync(repo)),
      );
    expect(bound).toBeDefined();
    expect(head.projectId).toBe(bound!.id);
    // Audit follow-up #127: the routed head's report names where it
    // worked — the repo top it was routed to.
    await waitFor(() =>
      engine
        .snapshot()
        .threads.find((t) => t.id === lead.id)!
        .messages.some((m) => m.content.includes("Hydra reports:")),
    );
    const report = engine
      .snapshot()
      .threads.find((t) => t.id === lead.id)!
      .messages.find((m) => m.content.includes("Hydra reports:"))!;
    expect(report.content).toContain(`Worked in ${realpathSync(repo)}`);
  });

  // Win32-only: the drive-letter casing the finding turns on.
  it.skipIf(process.platform !== "win32")(
    "routing to a sidebar project's other letter case reuses that project", async () => {
    // Audit follow-up #124: realpathSync keeps the typed drive-letter
    // case, so a lower-cased spelling must still bind the same project
    // and grant — not re-register a mismatched one.
    const { engine, projectId } = rig();
    // The stub's worktreeCheck passes and worktreeAdd fails "stub" —
    // reaching it proves the project's directoryStatusFor gate passed.
    engine.attachWorktrees(fakeWorktreesStub());
    const dir = engine
      .snapshot()
      .projects.find((p) => p.id === projectId)!.directory!;
    const lowered = dir.replace(/^([A-Za-z]):/, (m) => m.toLowerCase());
    expect(lowered).not.toBe(dir);
    const lead = engine.createThread(projectId, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${lowered}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("completed");
    expect(head.projectId).toBe(projectId);
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const matches = engine
      .snapshot()
      .projects.filter(
        (p) => p.directory !== undefined && norm(p.directory) === norm(dir),
      );
    expect(matches.length).toBe(1);
    // The LEAD's directory resolves through directoryStatusFor — a
    // grant/directory spelling split would come back null here, and the
    // same gate must let a worktree bind past project-directory-unavailable.
    expect(engine.threadDirectory(lead.id)).toBe(dir);
    const wt = await engine.createThreadWorktree(lead.id);
    expect(wt.kind === "unavailable" ? wt.reason : "created").not.toBe(
      "project-directory-unavailable",
    );
  }, 20_000);

  // Win32-only: Acceptance (2) — the lost-grant re-attach branch keeps
  // the project's stored spelling, not the typed letter case.
  it.skipIf(process.platform !== "win32")(
    "a listed project that lost its grant re-attaches on the stored spelling", async () => {
    const { engine, projectId, paths } = rig();
    const dir = engine
      .snapshot()
      .projects.find((p) => p.id === projectId)!.directory!;
    const lowered = dir.replace(/^([A-Za-z]):/, (m) => m.toLowerCase());
    expect(lowered).not.toBe(dir);
    // Lose the grant while the project stays listed — the route must
    // re-attach it, like openUserDirectory does.
    paths.revoke(projectId);
    expect(paths.findProjectByDirectory(dir)).toBeUndefined();
    const lead = engine.createThread(projectId, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${lowered}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("completed");
    // Re-attached against the stored spelling — case-folded lookup
    // finds the project again and the bound directory reports it.
    expect(paths.findProjectByDirectory(dir)).toBe(projectId);
    expect(engine.threadDirectory(lead.id)).toBe(dir);
  }, 20_000);

  it("a routed folder whose repo top is protected is still refused", async () => {
    const { engine, dataRoot } = rig();
    // The named folder sits inside the exempt task-workspaces tree, but
    // the enclosing repo's top is the data root itself — the head's
    // checkout would land there, so the refusal must follow the root.
    const ws = join(dataRoot, "worktrees", "repo", "sub");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(dataRoot, ".git"), { recursive: true });
    writeFileSync(join(dataRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]${ws}`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("system folder");
  });

  it("a name that is no sidebar project and no path is still refused", async () => {
    const { engine } = rig();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path]not-a-path`);
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    await waitFor(() => head.hydraHead!.status !== "running");
    expect(head.hydraHead!.status).toBe("failed");
    expect(head.hydraHead!.summary).toContain("no project named");
  });

  it("the head brief carries the shared-folder rule for non-Git work", () => {
    const prompt = delegatedHeadPrompt(
      personaAt(0),
      { task: "t", prompt: "p" },
      "D:\\plain",
      undefined,
      true,
    );
    expect(prompt).toContain("not a Git repository");
    expect(prompt).toContain("change files in place");
    const gitPrompt = delegatedHeadPrompt(
      personaAt(0),
      { task: "t", prompt: "p" },
      "D:\\repo",
    );
    expect(gitPrompt).not.toContain("not a Git repository");
  });
});

// P2-05 (frozen owned-files contract): every new-head entry carries a
// "files" array — [] for a read-only head — and no two entries of one
// block claim the same path. A non-Git head's owned files are backed
// up before its brief, then the report diffs them against what the
// head left. Home narrows to the deepest common existing folder of
// the owned paths; owned paths never reach a protected root.
describe("P2-05 owned-files contract (frozen v2)", () => {
  // A refused delegation reaches the lead as a queued follow-up turn
  // (frozen refusal-turn), not a notice — search both the queue and
  // the messages the follow-up turn already consumed.
  const refusals = (engine: Engine, leadId: string) => {
    const t = engine.snapshot().threads.find((x) => x.id === leadId)!;
    return [
      ...(t.followUps ?? []).map((f) => f.text),
      ...t.messages.map((m) => m.content),
    ];
  };

  it("an entry with no files array is refused and no head goes out", async () => {
    const { engine } = rig();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "do it [mock:hydra-nofiles]");
    await waitFor(() =>
      refusals(engine, lead.id).some((n) =>
        n.includes('its entry has no "files" array'),
      ),
    );
    expect(heads(engine, lead.id)).toHaveLength(0);
  }, 20_000);

  it("two entries claiming the same path refuse the later one", async () => {
    const { engine, projectId } = rig();
    // The lead's own checkout is the ownership base when an entry names
    // no project — bind it so the claim resolves at all.
    const lead = engine.createThread(projectId, "lead");
    engine.sendTurn(lead.id, "do it [mock:hydra-overlap]");
    await waitFor(() =>
      refusals(engine, lead.id).some((n) =>
        n.includes("claims the same path"),
      ),
    );
    // The first claimant went out; the second was refused with both
    // task names listed (frozen overlap listing).
    expect(heads(engine, lead.id)).toHaveLength(1);
    const refusal = refusals(engine, lead.id).find((n) =>
      n.includes("claims the same path"),
    )!;
    expect(refusal).toContain("First claim");
    expect(refusal).toContain("Second claim");
    expect(refusal).toContain("claimed.txt");
  }, 20_000);

  it("a non-Git head's owned files are backed up before it starts, then diffed on report", async () => {
    const { engine, dataRoot } = rig();
    const folder = tmp("tivano-owned-");
    mkdirSync(join(folder, "sub"), { recursive: true });
    writeFileSync(join(folder, "sub", "a.txt"), "before\n");
    // The head owns the folder `sub`; the mock writes `sub/b.txt`
    // inside it — an owned-path-new file the report counts as added.
    const stub = fakeWorktreesStub();
    engine.attachWorktrees(stub as never);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(
      lead.id,
      `do it [mock:hydra-path-files]${folder}|sub|sub/b.txt`,
    );
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const info = head.hydraHead!;
    await waitFor(() => info.status !== "running");
    expect(info.status).toBe("completed");
    expect(info.isNonGitCheckout).toBe(true);
    // The backup copied the owned dir's contents before the brief.
    const backup = info.backupPath!;
    expect(backup).toBeDefined();
    expect(backup.startsWith(join(dataRoot, "hydra-backups"))).toBe(true);
    expect(readFileSync(join(backup, "sub", "a.txt"), "utf8")).toBe("before\n");
    const norm = (p: string) => p.replace(/[\\/]+/g, "\\").toLowerCase();
    expect((info.backedUpFiles ?? []).map(norm)).toContain(
      norm("sub\\a.txt"),
    );
    // The report carries the frozen footer and the added count, and the
    // stubbed diff ran at least once.
    await waitFor(() =>
      (info.summary ?? "").includes("worked in place in"),
    );
    expect(info.summary).toContain("worked in place in");
    expect(info.summary).toContain("the originals are at");
    expect(info.summary).toMatch(/Added: [1-9]/);
    expect(stub.diffs.length).toBeGreaterThan(0);
    // The real write landed in the owned folder, not anywhere else.
    expect(existsSync(join(folder, "sub", "b.txt"))).toBe(true);
  }, 20_000);

  it("a head stopped while its backup runs never hears its brief", async () => {
    const { engine } = rig();
    const folder = tmp("tivano-stopbackup-");
    mkdirSync(join(folder, "sub"), { recursive: true });
    // A wide backup window — hundreds of owned files keep the async
    // copy in flight long after the head row exists, so the stop lands
    // between the spawn and the post-backup brief send.
    for (let i = 0; i < 300; i += 1)
      writeFileSync(join(folder, "sub", `f${i}.txt`), "x");
    engine.attachWorktrees(fakeWorktreesStub() as never);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, `do it [mock:hydra-path-files]${folder}|sub|sub/f299.txt`);
    const start = Date.now();
    let head = heads(engine, lead.id)[0];
    while (!head && Date.now() - start < 10_000) {
      await new Promise((res) => setTimeout(res, 0));
      head = heads(engine, lead.id)[0];
    }
    expect(head).toBeDefined();
    // Stopped mid-backup: the guard after the copy must see it and never
    // send the brief — no turn, no assistant reply, status stopped.
    engine.stopHydraHead(head!.id);
    await waitFor(() => head!.hydraHead!.status !== "running");
    await new Promise((res) => setTimeout(res, 300));
    expect(head!.hydraHead!.status).toBe("stopped");
    const msgs = engine
      .snapshot()
      .threads.find((t) => t.id === head!.id)!.messages;
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(0);
  }, 20_000);

  it("an unrouted in-place head's report also carries the diff and backup path", async () => {
    // The mainline case the audit flagged: heads spawned into the
    // lead's own project (a plain folder) — backed up, but without
    // targetCheckout their report carried no diff or location.
    const { engine, projectId } = rig();
    const leadDir = engine
      .snapshot()
      .projects.find((p) => p.id === projectId)!.directory!;
    writeFileSync(join(leadDir, "hydra-alpha.txt"), "before\n");
    writeFileSync(join(leadDir, "hydra-beta.txt"), "before\n");
    const stub = fakeWorktreesStub();
    engine.attachWorktrees(stub as never);
    const lead = engine.createThread(projectId, "lead");
    engine.sendTurn(lead.id, "do it [mock:hydra-touch]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    const info = heads(engine, lead.id)[0]!.hydraHead!;
    await waitFor(() => info.status !== "running");
    expect(info.isNonGitCheckout).toBe(true);
    expect(info.backupPath).toBeDefined();
    // Frozen records targetCheckout for every head before the backup —
    // the report's diff, counts and footer land for unrouted heads too.
    await waitFor(() =>
      (info.summary ?? "").includes("worked in place in"),
    );
    expect(info.summary).toContain("the originals are at");
    expect(info.summary).toMatch(/Added: \d+; removed: \d+/);
    expect(stub.diffs.length).toBeGreaterThan(0);
  }, 20_000);

  it("a continuation keeps the same backup folder and re-arms the same head", async () => {
    const { engine } = rig();
    const folder = tmp("tivano-owned-cont-");
    mkdirSync(join(folder, "sub"), { recursive: true });
    writeFileSync(join(folder, "sub", "a.txt"), "one\n");
    engine.attachWorktrees(fakeWorktreesStub() as never);
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(
      lead.id,
      `do it [mock:hydra-path-files]${folder}|sub|sub/a.txt [mock:hydra-continue]`,
    );
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const info = head.hydraHead!;
    await waitFor(() => info.status !== "running");
    const backup1 = info.backupPath!;
    expect(backup1).toBeDefined();
    // The lead's reply to the batch report emits {"continue":"Hank"}
    // — same request, so the SAME head is re-armed and runs again.
    await waitFor(() => info.status === "running", 15_000);
    await waitFor(() => info.status !== "running", 15_000);
    // The backup folder survives a continuation in place.
    expect(info.backupPath).toBe(backup1);
  }, 20_000);

  it("a continue carrying files admits against the head's base on a checkout-less lead", async () => {
    const { engine } = rig();
    const folder = tmp("tivano-cont-files-");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.txt"), "one\n");
    writeFileSync(join(folder, "b.txt"), "two\n");
    engine.attachWorktrees(fakeWorktreesStub() as never);
    // No projectId — the lead has NO checkout. The continue's files
    // must admit against Hank's targetCheckout, not the lead's.
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(
      lead.id,
      `do it [mock:hydra-path-files]${folder}|a.txt [mock:hydra-continue-files]b.txt`,
    );
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const info = head.hydraHead!;
    await waitFor(() => info.status !== "running");
    // The report-turn continue carries files:["b.txt"]. A lead-checkout
    // admission would refuse every file as unresolvable; the head-base
    // admission re-arms Hank and backs the new file up.
    await waitFor(() => info.status === "running", 15_000);
    await waitFor(() => info.status !== "running", 15_000);
    expect(info.status).toBe("completed");
    expect(info.files).toEqual(["b.txt"]);
    expect(info.backupOwnedPaths).toContain("b.txt");
  }, 20_000);

  it("a home-routed head narrows to the deepest common folder of its files", async () => {
    const { engine } = rig();
    let homeLeaf: string;
    try {
      homeLeaf = mkdtempSync(join(homedir(), "tivano-nongit-home-"));
    } catch {
      return; // Cannot stage under this host's home — nothing to prove.
    }
    roots.push(homeLeaf);
    const sub = join(homeLeaf, "deep", "deeper");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "f.txt"), "x\n");
    const rel = (p: string) =>
      p.slice(homedir().length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(
      lead.id,
      `do it [mock:hydra-path-files]${homedir()}|${rel(join(homeLeaf, "deep", "deeper", "f.txt"))}`,
    );
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const info = head.hydraHead!;
    await waitFor(() => info.status !== "running");
    expect(info.status).toBe("completed");
    // filesBase keeps home; the actual checkout narrowed to the file's
    // own folder (the deepest common EXISTING directory of the list).
    const home = realpathSync(homedir());
    expect(realpathSync(info.filesBase!)).toBe(home);
    expect(realpathSync(info.targetCheckout!)).toBe(realpathSync(sub));
    // The brief names the non-Git rule for a shared in-place folder.
    const brief = head.messages.find(
      (m) => m.role === "user" && m.content.includes("not a Git repository"),
    );
    expect(brief).toBeDefined();
  }, 20_000);

  it("an owned path inside a protected folder is refused", async () => {
    const { engine } = rig();
    const lead = engine.createThread(null, "lead");
    // .tivano under home is a protected root — an owned path inside it
    // refuses the head before anything is routed or copied.
    engine.sendTurn(
      lead.id,
      `do it [mock:hydra-path-files]${homedir()}|.tivano/seed.txt`,
    );
    await waitFor(() => heads(engine, lead.id).length === 1);
    const head = heads(engine, lead.id)[0]!;
    const info = head.hydraHead!;
    await waitFor(() => info.status !== "running");
    expect(info.status).toBe("failed");
    expect(info.summary).toContain("system folder");
  }, 20_000);

  it("a continue entry for an earlier-request head converts to a fresh owned head", async () => {
    const { engine } = rig();
    const folder = tmp("tivano-earlier-");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.txt"), "one\n");
    engine.attachWorktrees(fakeWorktreesStub() as never);
    const lead = engine.createThread(null, "lead");
    // Turn 1: Hank owns a.txt in the non-Git folder (files recorded).
    engine.sendTurn(
      lead.id,
      `do it [mock:hydra-path-files]${folder}|a.txt`,
    );
    await waitFor(() => heads(engine, lead.id).length === 1);
    const hank = heads(engine, lead.id)[0]!;
    await waitFor(() => hank.hydraHead!.status !== "running");
    expect(hank.hydraHead!.name).toBe("Hank");
    // Turn 2 (new request generation): a fresh plain head goes out —
    // when ITS report lands, the latched continue of "Hank" must take
    // the earlier-request conversion: a NEW head with the recorded
    // files, not a re-arm of the earlier request's Hank. The lead must
    // be fully idle first: the batch report rides a follow-up turn of
    // its own, so wait for that turn to consume it and drain.
    const other = tmp("tivano-other-");
    mkdirSync(other, { recursive: true });
    await waitFor(() => {
      const t = engine.snapshot().threads.find((x) => x.id === lead.id)!;
      return (
        t.messages.some((m) => m.content.includes("Hydra reports:")) &&
        t.turn?.status !== "running" &&
        (t.followUps ?? []).length === 0
      );
    }, 15_000);
    engine.sendTurn(
      lead.id,
      `again [mock:hydra-continue] [mock:hydra-path]${other}`,
    );
    await waitFor(() => heads(engine, lead.id).length >= 3, 15_000);
    const all = heads(engine, lead.id);
    const fresh = all[2]!.hydraHead!;
    await waitFor(() => fresh.status !== "running", 15_000);
    expect(fresh.name).not.toBe("Hank");
    expect(fresh.status).toBe("completed");
    expect(fresh.files).toEqual(["a.txt"]);
    // The fresh head works in the earlier head's checkout and hears
    // the frozen earlier-head brief.
    expect(realpathSync(fresh.targetCheckout!)).toBe(realpathSync(folder));
    const brief = all[2]!.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("worked on this part in an earlier request"),
    );
    expect(brief).toBeDefined();
    expect(brief!.content).toContain("Hank");
  }, 20_000);
});

// P2-05 unit surface — the port of AppModel+HydraBackup.swift: path
// canonicalization, the owned-path safety check, the deepest common
// owned directory, the pre-brief copy and the bounded report.
describe("P2-05 hydraBackup module (frozen AppModel+HydraBackup)", () => {
  it("hydraCanonical strips NT namespace prefixes and realpaths the existing prefix", () => {
    const base = tmp("tivano-canon-");
    const leaf = join(base, "missing", "leaf");
    const canon = hydraCanonical(leaf);
    expect(canon).toBe(join(realpathSync(base), "missing", "leaf"));
    if (process.platform === "win32") {
      expect(hydraCanonical(`\\\\?\\${base}`)).toBe(realpathSync(base));
      expect(hydraCanonical(`\\\\.\\${base}`)).toBe(realpathSync(base));
      expect(hydraCanonical("\\\\?\\UNC\\server\\share\\x")).toBe(
        "\\\\server\\share\\x",
      );
    }
  });

  it("hydraOwnedPathIsSafe refuses absolute and escaping paths", () => {
    const base = tmp("tivano-safe-");
    expect(hydraOwnedPathIsSafe("a.txt", base)).toBe(true);
    expect(hydraOwnedPathIsSafe("sub/dir/b.txt", base)).toBe(true);
    expect(hydraOwnedPathIsSafe(".", base)).toBe(true);
    expect(hydraOwnedPathIsSafe("..", base)).toBe(false);
    expect(hydraOwnedPathIsSafe("../sib.txt", base)).toBe(false);
    expect(hydraOwnedPathIsSafe(join(base, "abs.txt"), base)).toBe(false);
    if (process.platform === "win32") {
      expect(hydraOwnedPathIsSafe("C:\\abs.txt", base)).toBe(false);
      // A link that resolves outside the base is unsafe even though
      // its lexical path stays inside.
      const link = join(base, "link");
      const outside = tmp("tivano-outside-");
      try {
        symlinkSync(outside, link, "junction");
        expect(hydraOwnedPathIsSafe("link", base)).toBe(false);
      } catch {
        /* host cannot make junctions — nothing to prove here */
      }
    }
  });

  it("hydraOwnedDirectory folds to the deepest common existing folder", () => {
    const base = tmp("tivano-own-");
    mkdirSync(join(base, "a", "b"), { recursive: true });
    writeFileSync(join(base, "a", "b", "f.txt"), "x");
    mkdirSync(join(base, "a", "c"), { recursive: true });
    // Existing leaf dirs: common = their shared parent.
    expect(hydraOwnedDirectory(["a/b", "a/c"], base)).toBe(
      hydraCanonical(join(base, "a")),
    );
    // A missing leaf climbs to the deepest EXISTING ancestor (a/b), and
    // the file path itself never counts as a directory.
    expect(hydraOwnedDirectory(["a/b/f.txt", "a/c/gone.txt"], base)).toBe(
      hydraCanonical(join(base, "a")),
    );
    expect(hydraOwnedDirectory(["a/b"], base)).toBe(
      hydraCanonical(join(base, "a", "b")),
    );
    expect(hydraOwnedDirectory([], base)).toBeUndefined();
  });

  it("hydraOwnershipPath resolves lexically and refuses outsiders", () => {
    const base = tmp("tivano-ownpath-");
    const ok = hydraOwnershipPath("a/b.txt", base);
    expect(ok).toBe(hydraOwnershipPath("a\\b.txt", base));
    expect(hydraOwnershipPath(".", base)).toBeDefined();
    expect(hydraOwnershipPath("", base)).toBeUndefined();
    expect(hydraOwnershipPath("../sib", base)).toBeUndefined();
    // An absolute file under the checkout claims lexically; one
    // outside refuses — v2OwnershipPath never realpaths.
    expect(hydraOwnershipPath(join(base, "in.txt"), base)).toBeDefined();
    expect(hydraOwnershipPath("\\\\outside\\other", base)).toBeUndefined();
  });

  it("copyHydraOwnedFiles copies files, recurses dirs, marks missing new, skips the unsafe", async () => {
    const base = tmp("tivano-copy-");
    mkdirSync(join(base, "dir"), { recursive: true });
    writeFileSync(join(base, "dir", "one.txt"), "1\n");
    writeFileSync(join(base, "top.txt"), "t\n");
    const folder = join(tmp("tivano-backup-"), "head");
    const r = await copyHydraOwnedFiles(
      ["dir", "top.txt", "missing.txt", "../escape.txt"],
      base,
      folder,
    );
    const norm = (p: string) => p.replace(/[\\/]+/g, "\\").toLowerCase();
    expect(r.copied.map(norm)).toEqual(
      expect.arrayContaining([norm("dir\\one.txt"), norm("top.txt")]),
    );
    expect(r.added.map(norm)).toEqual([norm("missing.txt")]);
    expect(r.skipped.map(norm)).toEqual([norm("..\\escape.txt")]);
    expect(readFileSync(join(folder, "dir", "one.txt"), "utf8")).toBe("1\n");
    expect(readFileSync(join(folder, "top.txt"), "utf8")).toBe("t\n");
    // The backup root itself can never be swallowed by an owned folder.
    const inner = await copyHydraOwnedFiles(
      [".."],
      join(folder, "x"),
      join(folder, "x", "y"),
    );
    expect(inner.copied).toHaveLength(0);
  });

  it("hydraBackupReport diffs owned files: changed, added, removed, skipped, footer", async () => {
    const base = tmp("tivano-report-");
    const backup = join(tmp("tivano-rback-"), "h");
    mkdirSync(join(backup, "sub"), { recursive: true });
    // Before-state in the backup; after-state in the live base.
    writeFileSync(join(backup, "same.txt"), "a\n");
    writeFileSync(join(base, "same.txt"), "a\n");
    writeFileSync(join(backup, "changed.txt"), "old\n");
    writeFileSync(join(base, "changed.txt"), "new\n");
    writeFileSync(join(backup, "gone.txt"), "was here\n");
    mkdirSync(join(base, "sub"), { recursive: true });
    writeFileSync(join(base, "sub", "fresh.txt"), "added\n");
    const empty = join(tmp("tivano-empty-"), "e");
    writeFileSync(empty, "");
    const diffs: [string, string][] = [];
    const report = await hydraBackupReport(
      {
        backupPath: backup,
        targetCheckout: base,
        backupOwnedPaths: ["same.txt", "changed.txt", "gone.txt", "sub"],
        backedUpFiles: ["same.txt", "changed.txt", "gone.txt"],
        newFiles: ["sub"],
        notBackedUpFiles: ["big.bin"],
        personaName: "Ada",
      },
      async (before, after) => {
        diffs.push([before, after]);
        return {
          output: `diff ${before} -> ${after}`,
          hitCap: false,
        };
      },
      empty,
    );
    expect(report).toBeDefined();
    expect(report).toContain("Added: 1; removed: 1.");
    expect(report).toContain("Ada worked in place in");
    expect(report).toContain(`the originals are at ${backup}`);
    expect(report).toContain("Not backed up (size, unsupported path or copy failure): big.bin");
    // changed, gone and the new sub/fresh.txt each got a diff run —
    // the same file emits no output but still ran.
    expect(diffs).toHaveLength(4);
    expect(diffs.some(([b]) => b === empty)).toBe(true); // added file's null side
    // A failed diff lands as a line, not a lost file.
    const failed = await hydraBackupReport(
      {
        backupPath: backup,
        targetCheckout: base,
        backupOwnedPaths: ["changed.txt"],
        backedUpFiles: ["changed.txt"],
        personaName: "Bo",
      },
      async () => ({ failed: "Git is unavailable" }),
      empty,
    );
    expect(failed).toContain("Could not diff changed.txt: Git is unavailable");
    expect(failed).toContain("Added: 0; removed: 0.");
    // Truncation: output past the report cap marks the report.
    const huge = "x".repeat(25_000);
    const trunc = await hydraBackupReport(
      {
        backupPath: backup,
        targetCheckout: base,
        backupOwnedPaths: ["changed.txt"],
        backedUpFiles: ["changed.txt"],
        personaName: "Kai",
      },
      async () => ({ output: huge }),
      empty,
    );
    expect(trunc).toContain("[Diff truncated at 20,000 characters.]");
    expect(trunc!.length).toBeLessThan(30_000);
  });
});

/** A worktrees stub whose only live method is `hydraBackupDiff` — the
 *  non-Git report path's diff; everything else fails unavailable like
 *  the other suites' stubs. */
function fakeWorktreesStub() {
  const fail = { kind: "unavailable" as const, reason: "stub" };
  const diffs: [string, string][] = [];
  return {
    diffs,
    autoWorktreeEligibility: async () => "nonGit" as const,
    worktreeCheck: async (_p: string, name: string) => ({ kind: "ok" as const, name }),
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
    hydraBackupDiff: async (_p: string, before: string, after: string) => {
      diffs.push([before, after]);
      const left = existsSync(before) ? readFileSync(before, "utf8") : "";
      const right = existsSync(after) ? readFileSync(after, "utf8") : "";
      return {
        kind: "ok" as const,
        output: left === right ? "" : `stub diff ${before} -> ${after}\n-${left}+${right}`,
        hitCap: false,
      };
    },
  };
}
