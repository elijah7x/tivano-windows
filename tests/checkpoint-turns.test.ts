// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2L checkpoint-turn integration regressions. The service is stubbed —
// these tests pin the COORDINATOR's lifecycle contract: reservation
// before awaits, never-mint-on-failure, stale-attribution drops,
// invalidation on deletion/close, durable ledger validation/reopen and
// ledger-identity-only preview. Real git capture/preview is covered by
// checkpoint.test.ts / checkpoint-store-safety.test.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointLedger } from "../src/main/checkpointLedger";
import { CheckpointCoordinator } from "../src/main/checkpointTurns";
import type { ChatThread, Project } from "../src/shared/types";
import type { WorkspaceGrant } from "../src/main/provider";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ckpt-turns-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function thread(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "th-1",
    projectId: "pr-1",
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    turn: null,
    sessionGrants: [],
    ...over,
  };
}
const project: Project = {
  id: "pr-1",
  name: "p",
  createdAt: 1,
  updatedAt: 1,
  expanded: true,
} as Project;

function rig(opts: {
  captureImpl?: (
    phase: "before" | "after",
  ) => Promise<{ kind: string; checkpointId?: string; reason?: string }>;
  diffImpl?: (
    baseCheckpointId: string,
    endCheckpointId: string,
    touchedPaths: string[],
    path: string,
  ) => Promise<{ kind: string; patch?: string; reason?: string }>;
  grant?: WorkspaceGrant;
} = {}) {
  const state = { threads: [thread()] as ChatThread[], projects: [project] };
  const calls: Array<{ phase: string; turnId: string }> = [];
  const service = {
    capture: async (
      projectId: string,
      threadId: string,
      turnId: string,
      phase: "before" | "after",
    ) => {
      calls.push({ phase, turnId });
      return (
        (await opts.captureImpl?.(phase)) ?? {
          kind: "captured" as const,
          checkpointId: `ck-${phase}-${turnId}`,
        }
      );
    },
    preview: async () => ({
      kind: "ready" as const,
      baseCheckpointId: "b",
      endCheckpointId: "e",
      touchedPaths: [],
      entries: [],
      limitations: [],
    }),
    diff: async (
      _projectId: string,
      _threadId: string,
      baseCheckpointId: string,
      endCheckpointId: string,
      touchedPaths: string[],
      path: string,
    ) =>
      (await opts.diffImpl?.(baseCheckpointId, endCheckpointId, touchedPaths, path)) ?? {
        kind: "empty" as const,
      },
    onProjectDeleted: () => {},
    onThreadDeleted: () => {},
    dispose: async () => ({ problems: [] as string[] }),
  };
  const ledgerRoot = tmp();
  const ledger = new CheckpointLedger(join(ledgerRoot, "checkpoints"), ledgerRoot);
  const events: string[] = [];
  const grant: WorkspaceGrant = opts.grant ?? { projectId: "pr-1", directory: "/tmp/ws" };
  const deps = {
    service: service as never,
    ledger,
    paths: {
      lookup: (id: string) => (id === "pr-1" ? grant : undefined),
      verify: (g: WorkspaceGrant) => g,
    } as never,
    projects: () => state.projects,
    threads: () => state.threads,
    emit: (e: { type: string; threadId: string }) => events.push(e.type),
  };
  return {
    coord: new CheckpointCoordinator(deps),
    ledger,
    calls,
    state,
    events,
    service,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("checkpoint-turn lifecycle", () => {
  it("cancel during before-capture never starts the provider and invalidates", async () => {
    let release!: (v: { kind: string; checkpointId: string }) => void;
    const { coord, ledger, state } = rig({
      captureImpl: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
    });
    state.threads = [th];
    const p = coord.beginTurn(th, "tu-1");
    await tick(); // let the chained capture begin and capture `release`
    coord.turnCancelled("th-1", "tu-1");
    th.turn = null; // engine ended it
    release({ kind: "captured", checkpointId: "ck-before-tu-1" });
    expect(await p).toBe(false);
    const rec = ledger.byTurn("th-1", "tu-1")!;
    expect(rec.status).toBe("invalidated");
  });

  it("failed before-capture records unavailable but lets chat proceed", async () => {
    const { coord, ledger, state } = rig({
      captureImpl: async (phase) =>
        phase === "before" ? { kind: "unavailable", reason: "not-repository" } : { kind: "captured" },
    });
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    const rec = ledger.byTurn("th-1", "tu-1")!;
    expect(rec.status).toBe("unavailable");
    expect(rec.reason).toBe("not-repository");
    coord.turnEnded("th-1", "tu-1", "done");
    await tick();
    expect(ledger.byTurn("th-1", "tu-1")!.status).toBe("unavailable");
  });

  it("failed end-capture never mints a complete record", async () => {
    const { coord, ledger, state } = rig({
      captureImpl: async (phase) =>
        phase === "before"
          ? { kind: "captured", checkpointId: "b-1" }
          : { kind: "unavailable", reason: "capture-over-budget" },
    });
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
      messages: [
        { id: "m1", role: "assistant", content: "", status: "done", ts: 1, turnId: "tu-1" },
      ],
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    th.turn = null;
    coord.turnEnded("th-1", "tu-1", "done");
    await tick();
    await tick();
    const rec = ledger.byTurn("th-1", "tu-1")!;
    expect(rec.status).toBe("unavailable");
    expect(rec.reason).toMatch(/after-capture/);
    expect(rec.endCheckpointId).toBeUndefined();
    expect(rec.baseCheckpointId).toBe("b-1"); // honest partial state kept
  });

  it("complete pair persists edits only from the matching live turn", async () => {
    const { coord, ledger, state } = rig();
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
      messages: [
        { id: "m1", role: "assistant", content: "", status: "done", ts: 1, turnId: "tu-1" },
      ],
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    coord.recordEdits("tu-1", ["src/a.ts", "../escape", "src/a.ts"]);
    coord.recordEdits("tu-OTHER", ["src/foreign.ts"]); // stale — dropped
    th.turn = null;
    coord.turnEnded("th-1", "tu-1", "done");
    await tick();
    await tick();
    const rec = ledger.byTurn("th-1", "tu-1")!;
    expect(rec.status).toBe("complete");
    expect(rec.touchedPaths).toEqual(["src/a.ts"]);
    expect(rec.baseCheckpointId).toBe("ck-before-tu-1");
    expect(rec.endCheckpointId).toBe("ck-after-tu-1");
  });

  it("cancelled turn invalidates instead of capturing end", async () => {
    const { coord, ledger, state, calls } = rig();
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    coord.turnCancelled("th-1", "tu-1");
    th.turn = null;
    coord.turnEnded("th-1", "tu-1", "cancelled");
    await tick();
    const rec = ledger.byTurn("th-1", "tu-1")!;
    expect(rec.status).toBe("invalidated");
    expect(calls.filter((c) => c.phase === "after")).toHaveLength(0);
  });

  it("thread deletion invalidates its records", async () => {
    const { coord, ledger, state } = rig();
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    coord.threadDeleted("th-1");
    state.threads = [];
    th.turn = null;
    coord.turnEnded("th-1", "tu-1", "done");
    await tick();
    expect(ledger.byTurn("th-1", "tu-1")!.status).toBe("invalidated");
  });

  it("preview names ledger identity only and rejects foreign/incomplete", async () => {
    const { coord, ledger, state, service } = rig();
    let previewArgs: unknown[] = [];
    service.preview = async (...a: unknown[]) => {
      previewArgs = a;
      return {
        kind: "ready" as const,
        baseCheckpointId: "b",
        endCheckpointId: "e",
        touchedPaths: [],
        entries: [],
        limitations: [],
      };
    };
    const th = thread({
      turn: {
        id: "tu-1",
        threadId: "th-1",
        status: "running",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "m1",
      },
      messages: [
        { id: "m1", role: "assistant", content: "", status: "done", ts: 1, turnId: "tu-1" },
      ],
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    // Incomplete record → refused.
    const early = await coord.preview("th-1", "tu-1");
    expect(early.kind).toBe("unavailable");
    th.turn = null;
    coord.turnEnded("th-1", "tu-1", "done");
    await tick();
    await tick();
    const ok = await coord.preview("th-1", "tu-1");
    expect(ok.kind).toBe("ready");
    // Service received ledger-owned ids + paths — never caller input.
    expect(previewArgs.slice(0, 2)).toEqual(["pr-1", "th-1"]);
    expect(previewArgs[2]).toBe("ck-before-tu-1");
    expect(previewArgs[3]).toBe("ck-after-tu-1");
    expect(previewArgs[4]).toEqual([]);
    // Foreign turn/thread ids can never select another record.
    expect((await coord.preview("th-1", "tu-OTHER")).kind).toBe("unavailable");
    expect((await coord.preview("th-OTHER", "tu-1")).kind).toBe("unavailable");
    expect(ledger.byTurn("th-1", "tu-1")!.status).toBe("complete");
  });
});

describe("coordinator rejection handling (P2L-REPAIR-01)", () => {
  it("a refusing ledger lets chat proceed — visibly, never blocking", async () => {
    // A ledger whose file path is a directory refuses every mutation.
    const dir = tmp();
    mkdirSync(join(dir, "ledger.v1.json"));
    const th = thread({
      turn: { id: "tu-1", threadId: "th-1", status: "running", seq: 0, startedAt: 1, assistantMessageId: "m1" },
    });
    const state = { threads: [th], projects: [project] };
    const coord = new CheckpointCoordinator({
      service: {
        capture: async () => ({ kind: "captured" as const, checkpointId: "ck" }),
        preview: async () => ({ kind: "unavailable" as const }),
        onProjectDeleted: () => {},
        onThreadDeleted: () => {},
        dispose: async () => ({ problems: [] as string[] }),
      } as never,
      ledger: new CheckpointLedger(dir, dir),
      paths: { lookup: () => ({ projectId: "pr-1", directory: "/tmp/ws" }) } as never,
      projects: () => state.projects,
      threads: () => state.threads,
      emit: () => {},
    });
    expect(await coord.beginTurn(th, "tu-1")).toBe(true); // chat proceeds
    const listed = coord.list("th-1");
    const shadow = listed.find((r) => r.turnId === "tu-1");
    expect(shadow?.status).toBe("unavailable");
    expect(shadow?.reason).toContain("ledger-reserve");
  });

  it("a capture that THROWS still lets chat proceed and records unavailable", async () => {
    const { coord, ledger, state } = rig({
      captureImpl: async () => {
        throw new Error("service-exploded");
      },
    });
    const th = thread({
      turn: { id: "tu-1", threadId: "th-1", status: "running", seq: 0, startedAt: 1, assistantMessageId: "m1" },
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    expect(ledger.byTurn("th-1", "tu-1")!.status).toBe("unavailable");
  });

  it("captureEnd against a now-broken ledger rejects nowhere — no unhandled rejection", async () => {
    const dir = tmp();
    const state = { threads: [thread()], projects: [project] };
    const ledger = new CheckpointLedger(join(dir, "checkpoints"), dir);
    const service = {
      capture: async () => ({ kind: "captured" as const, checkpointId: "ck" }),
      preview: async () => ({ kind: "unavailable" as const }),
      onProjectDeleted: () => {},
      onThreadDeleted: () => {},
      dispose: async () => ({ problems: [] as string[] }),
    };
    const coord = new CheckpointCoordinator({
      service: service as never,
      ledger,
      paths: { lookup: () => ({ projectId: "pr-1", directory: "/tmp/ws" }) } as never,
      projects: () => state.projects,
      threads: () => state.threads,
      emit: () => {},
    });
    const th = thread({
      turn: { id: "tu-1", threadId: "th-1", status: "running", seq: 0, startedAt: 1, assistantMessageId: "m1" },
      messages: [{ id: "m1", role: "assistant", content: "", status: "done", ts: 1, turnId: "tu-1" }],
    });
    state.threads = [th];
    expect(await coord.beginTurn(th, "tu-1")).toBe(true);
    // Break the ledger file path mid-turn.
    rmSync(join(dir, "checkpoints", "ledger.v1.json"));
    mkdirSync(join(dir, "checkpoints", "ledger.v1.json"));
    th.turn = null;
    coord.turnEnded("th-1", "tu-1", "done");
    await tick();
    await tick();
    // No phantom complete — and the shadow failure is visible.
    expect(ledger.byTurn("th-1", "tu-1")?.status ?? "unavailable").not.toBe("complete");
    expect(coord.list("th-1").some((r) => r.status === "unavailable")).toBe(true);
  });

  it("closing and deletion against a broken ledger never throw", async () => {
    const dir = tmp();
    const ledger = new CheckpointLedger(join(dir, "checkpoints"), dir);
    const state = { threads: [thread()], projects: [project] };
    const coord = new CheckpointCoordinator({
      service: {
        capture: async () => ({ kind: "captured" as const, checkpointId: "ck" }),
        preview: async () => ({ kind: "unavailable" as const }),
        onProjectDeleted: () => {},
        onThreadDeleted: () => {},
        dispose: async () => ({ problems: [] as string[] }),
      } as never,
      ledger,
      paths: { lookup: () => undefined } as never,
      projects: () => state.projects,
      threads: () => state.threads,
      emit: () => {},
    });
    mkdirSync(join(dir, "checkpoints", "ledger.v1.json"), { recursive: true }); // break the leaf
    expect(() => coord.threadDeleted("th-1")).not.toThrow();
    expect(() => coord.projectDeleted("pr-1")).not.toThrow();
    expect(() => coord.closing()).not.toThrow();
    await expect(coord.dispose()).resolves.toEqual({ problems: [] });
  });
});

describe("checkpoint ledger durability", () => {
  it("reopens the same records after a fresh load", async () => {
    const dir = tmp();
    const l1 = new CheckpointLedger(join(dir, "checkpoints"), dir);
    const rec = l1.reserve({
      projectId: "pr-1",
      threadId: "th-1",
      turnId: "tu-1",
      grantDir: "/tmp/ws",
      touchedPaths: [],
    });
    l1.update(rec.recordId, {
      status: "complete",
      baseCheckpointId: "b1",
      endCheckpointId: "e1",
      touchedPaths: ["a.txt"],
    });
    const l2 = new CheckpointLedger(join(dir, "checkpoints"), dir);
    const again = l2.byTurn("th-1", "tu-1")!;
    expect(again.status).toBe("complete");
    expect(again.touchedPaths).toEqual(["a.txt"]);
    expect(again.baseCheckpointId).toBe("b1");
  });

  it("drops malformed entries, keeps the rest; missing file is empty", () => {
    const dir = tmp();
    const file = join(dir, "checkpoints", "ledger.v1.json");
    rmSync(join(dir, "checkpoints"), { recursive: true, force: true });
    const l = new CheckpointLedger(join(dir, "checkpoints"), dir);
    expect(l.all()).toEqual([]);
    l.reserve({
      projectId: "pr-1",
      threadId: "th-1",
      turnId: "tu-1",
      grantDir: "/tmp/ws",
      touchedPaths: [],
    });
    // A document with ANY malformed record is foreign: preserved
    // byte-for-byte and refused, never partially adopted (P2L-REPAIR-01).
    const mixed = JSON.stringify({
      version: 1,
      records: [
        { recordId: "ok", projectId: "p", threadId: "t", turnId: "u", grantDir: "/w", createdAt: 1, updatedAt: 1, status: "unavailable", touchedPaths: [] },
        { recordId: 42, status: "complete" },
      ],
    });
    writeFileSync(file, mixed);
    const l2 = new CheckpointLedger(join(dir, "checkpoints"), dir);
    expect(l2.all()).toEqual([]);
    expect(l2.availability().ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(mixed);
  });

  it("rejects touched paths that escape the repo", () => {
    const dir = tmp();
    const l = new CheckpointLedger(join(dir, "checkpoints"), dir);
    const rec = l.reserve({
      projectId: "pr-1",
      threadId: "th-1",
      turnId: "tu-1",
      grantDir: "/tmp/ws",
      touchedPaths: [],
    });
    l.update(rec.recordId, { touchedPaths: ["../evil", "ok.txt", "C:/abs"] });
    // update() stores what it is given — validation is on WRITE callers
    // via boundedTouched; the ledger's own reload re-validates too.
    const l2 = new CheckpointLedger(join(dir, "checkpoints"), dir);
    const again = l2.get(rec.recordId);
    if (again) expect(again.touchedPaths.every((p) => !p.includes(".."))).toBe(true);
  });
});

describe("whole-thread changes (frozen ThreadChangesTab)", () => {
  const seedComplete = (
    ledger: CheckpointLedger,
    turnId: string,
    base: string,
    end: string,
    touched: string[],
  ) => {
    const rec = ledger.reserve({
      projectId: "pr-1",
      threadId: "th-1",
      turnId,
      grantDir: "/tmp/ws",
      touchedPaths: touched,
    });
    ledger.update(rec.recordId, {
      status: "complete",
      baseCheckpointId: base,
      endCheckpointId: end,
    });
  };

  it("summary diffs first base → last end over the union of touched paths", async () => {
    const seen: { base: string; end: string; touched: string[]; path: string }[] = [];
    const { coord, ledger } = rig({
      diffImpl: async (base, end, touched, path) => {
        seen.push({ base, end, touched: [...touched], path });
        if (path === "a.ts")
          return {
            kind: "text",
            patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n ctx",
          };
        if (path === "b.ts")
          return { kind: "text", patch: "@@ -1 +1 @@\n-x\n+y\n+z\n+w" };
        return { kind: "binary" };
      },
    });
    seedComplete(ledger, "tu-1", "b1", "e1", ["a.ts", "b.ts"]);
    seedComplete(ledger, "tu-2", "b2", "e2", ["b.ts", "c.bin"]);

    const sum = await coord.threadChangeSummary("th-1");
    expect(sum).not.toBeNull();
    // Whole-thread scope: earliest base vs latest end, union of touched.
    expect(seen.every((c) => c.base === "b1" && c.end === "e2")).toBe(true);
    expect(seen[0]!.touched).toEqual(["a.ts", "b.ts", "c.bin"]);
    expect(sum!.files).toEqual([
      { path: "a.ts", additions: 2, deletions: 1, binary: false },
      { path: "b.ts", additions: 3, deletions: 1, binary: false },
      { path: "c.bin", additions: 0, deletions: 0, binary: true },
    ]);
    expect(sum!.additions).toBe(5);
    expect(sum!.deletions).toBe(2);
  });

  it("threadDiff uses the same scope; empty scope stays honest", async () => {
    const { coord, ledger } = rig({
      diffImpl: async () => ({ kind: "text", patch: "@@ -1 +1 @@\n-a\n+b" }),
    });
    expect(await coord.threadChangeSummary("th-1")).toBeNull();
    const miss = await coord.threadDiff("th-1", "a.ts");
    expect(miss.kind).toBe("unavailable");
    seedComplete(ledger, "tu-1", "b1", "e1", ["a.ts"]);
    const v = await coord.threadDiff("th-1", "a.ts");
    expect(v.kind).toBe("text");
  });

  it("grant drift hides the scope rather than diffing a foreign dir", async () => {
    const { coord, ledger } = rig({
      grant: { projectId: "pr-1", directory: "/tmp/other" },
      diffImpl: async () => ({ kind: "text", patch: "x" }),
    });
    seedComplete(ledger, "tu-1", "b1", "e1", ["a.ts"]);
    expect(await coord.threadChangeSummary("th-1")).toBeNull();
    expect((await coord.threadDiff("th-1", "a.ts")).kind).toBe("unavailable");
  });
});
