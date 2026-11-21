// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-08 heads in non-Git folders (frozen routeHydraHead slice): an
// absolute-path "project" resolves to a working folder — created when
// its parent exists, refused on system roots, file paths and repos
// Tivano cannot read — a non-Git folder is changed in place (no copy,
// no merge) and joins the sidebar.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
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

  it("system folders are refused", async () => {
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
    expect(head2.hydraHead!.targetCheckout).toBe(repo);
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
