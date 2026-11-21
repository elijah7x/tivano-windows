// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-38/P1-09: the independent Hydra review — synthetic only (mock
// provider + a recording diff stub; no real model, Git or network).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";
import {
  countReviewFindings,
  hydraReviewerLabel,
  parseReviewVerdicts,
} from "../src/shared/hydraReview";

const roots: string[] = [];
const stores: Store[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface DiffCall {
  cwd: string;
  base: string;
  paths: string[];
}

function rig() {
  const dataRoot = tmp("hydra-review-data-");
  const projectDir = tmp("hydra-review-proj-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const { project } = engine.openUserDirectory(projectDir);
  const calls: DiffCall[] = [];
  // Only the review's diff is exercised; heads stay in the shared
  // checkout (isolation off) so no capture/landing call is reached.
  engine.attachWorktrees({
    hydraReviewDiff: async (_p: string, cwd: string, base: string, ps: string[]) => {
      calls.push({ cwd, base, paths: [...ps].sort() });
      return {
        kind: "ok" as const,
        diff: ps.map((p) => `diff --git a/${p} b/${p}\n+synthetic\n`).join(""),
      };
    },
  } as unknown as Parameters<Engine["attachWorktrees"]>[0]);
  engine.setSettings({ hydraIsolateHeads: false });
  return { engine, store, dataRoot, projectId: project.id, calls };
}

const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const idle = (engine: Engine, id: string) => {
  const t = thread(engine, id);
  return t.turn?.status !== "running" && t.turn?.status !== "waiting-approval";
};
const engineHeadsDone = (engine: Engine, leadId: string) => {
  const hs = engine.snapshot().threads.filter((t) => t.hydraHead?.leadId === leadId);
  return hs.length === 2 && hs.every((h) => h.hydraHead!.status !== "running");
};
const userTurns = (engine: Engine, id: string) =>
  thread(engine, id).messages.filter((m) => m.role === "user").map((m) => m.content);

describe("P1-38 independent review", () => {
  it("a settled job's touched files are reviewed; findings reach the lead and its verdicts fold into the card", async () => {
    const r = rig();
    const lead = r.engine.createThread(r.projectId, "lead");
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch] [mock:review-findings]");
    await waitFor(() => (thread(r.engine, lead.id).hydraReviews?.[0]?.accepted ?? -1) >= 0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.base).toBe("HEAD");
    expect(r.calls[0]!.paths).toEqual(["hydra-alpha.txt", "hydra-beta.txt"]);
    const card = thread(r.engine, lead.id).hydraReviews![0]!;
    expect(card.findingCount).toBe(2);
    expect(card.reviewer).toContain("Mock");
    expect(card.diffBytes).toBeGreaterThan(0);
    expect(card.accepted).toBe(1);
    expect(card.rejected).toBe(1);
    const review = userTurns(r.engine, lead.id).find((c) => c.startsWith("[Hydra] Review:"));
    expect(review).toContain("Finding 1:");
    expect(review).toContain("Finding N: accepted - <what you changed>");
    await waitFor(() => idle(r.engine, lead.id));
  });

  it("NO FINDINGS keeps a card with zero findings and sends the lead nothing", async () => {
    const r = rig();
    const lead = r.engine.createThread(r.projectId, "lead");
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => (thread(r.engine, lead.id).hydraReviews?.length ?? 0) === 1);
    await new Promise((res) => setTimeout(res, 150));
    const card = thread(r.engine, lead.id).hydraReviews![0]!;
    expect(card.findingCount).toBe(0);
    expect(card.accepted).toBeUndefined();
    expect(userTurns(r.engine, lead.id).some((c) => c.startsWith("[Hydra] Review:"))).toBe(false);
  });

  it("review off: no diff is read and no card is written", async () => {
    const r = rig();
    r.engine.setSettings({ hydraReviewEnabled: false });
    const lead = r.engine.createThread(r.projectId, "lead");
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch] [mock:review-findings]");
    await waitFor(
      () =>
        userTurns(r.engine, lead.id).length >= 2 &&
        idle(r.engine, lead.id) &&
        engineHeadsDone(r.engine, lead.id),
    );
    await new Promise((res) => setTimeout(res, 150));
    expect(r.calls).toHaveLength(0);
    expect(thread(r.engine, lead.id).hydraReviews).toBeUndefined();
  });

  it("the first reviewer off falls back to the second, whose model the card names", async () => {
    const r = rig();
    r.engine.setSettings({
      hydraReviewFirst: { provider: "" },
      hydraReviewSecond: { provider: "codex", model: "review-model", effort: "high" },
    });
    const lead = r.engine.createThread(r.projectId, "lead");
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => (thread(r.engine, lead.id).hydraReviews?.length ?? 0) === 1);
    expect(thread(r.engine, lead.id).hydraReviews![0]!.reviewer).toMatch(/^Mock .* review-model · High$/);
  });

  it("a reviewer that returns nothing usable leaves no card", async () => {
    const r = rig();
    const lead = r.engine.createThread(r.projectId, "lead");
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch] [mock:review-error]");
    await waitFor(() => r.calls.length === 1);
    await new Promise((res) => setTimeout(res, 150));
    expect(thread(r.engine, lead.id).hydraReviews).toBeUndefined();
  });

  it("review cards and settings survive a store reload (strict validators)", async () => {
    const r = rig();
    r.engine.setSettings({ hydraReviewSecond: { provider: "codex", model: "m2" } });
    const lead = r.engine.createThread(r.projectId, "lead");
    r.engine.sendTurn(lead.id, "split it [mock:hydra-touch]");
    await waitFor(() => (thread(r.engine, lead.id).hydraReviews?.length ?? 0) === 1);
    await waitFor(() => idle(r.engine, lead.id));
    r.store.close();
    stores.pop();
    const again = new Store(r.dataRoot);
    again.open();
    stores.push(again);
    const t = again.state.threads.find((x) => x.id === lead.id)!;
    expect(t.hydraReviews).toHaveLength(1);
    expect(again.state.settings.hydraReviewSecond).toEqual({ provider: "codex", model: "m2" });
  });
});

describe("P1-38 review protocol helpers", () => {
  it("counts findings and parses verdicts (later verdict wins, placeholders ignored)", () => {
    expect(countReviewFindings("Finding 1: a\n- Finding 2: b\nnot one")).toBe(2);
    const v = parseReviewVerdicts(
      [
        "Finding N: accepted - <what you changed>",
        "Finding 1: rejected - first take",
        "**Finding 1:** accepted - fixed it",
        "Finding 2：驳回 - 已处理",
      ].join("\n"),
    );
    expect(v.map((x) => [x.number, x.accepted])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("labels the reviewer with model and effort", () => {
    expect(hydraReviewerLabel({ provider: "codex", model: "m", effort: "low" }, () => "Codex")).toBe(
      "Codex m · Low",
    );
  });
});
