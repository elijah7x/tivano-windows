// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Persisted-document validation: unique ids, reference integrity and
// turn/approval/message status combinations. Persistence capacity limits
// are intentionally separate from IPC payload limits.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, emptyStore } from "../src/main/store";
import type { ChatThread, StoreFile, Turn } from "../src/shared/types";

const dirs: string[] = [];
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-doc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function baseThread(): ChatThread {
  return {
    id: "t1",
    projectId: "p1",
    title: "T",
    createdAt: 1,
    updatedAt: 1,
    sessionGrants: [],
    messages: [{
      id: "m1",
      role: "assistant",
      content: "old",
      status: "done",
      ts: 1,
      turnId: "turn-old", // historical turn — no longer persisted
    }],
    turn: null,
  };
}

function baseDoc(): StoreFile {
  const doc = emptyStore();
  doc.projects = [{ id: "p1", name: "P", createdAt: 1, expanded: true }];
  doc.threads = [baseThread()];
  return doc;
}

function waitingTurn(threadId: string): Turn {
  return {
    id: "turn-1",
    threadId,
    status: "waiting-approval",
    seq: 3,
    startedAt: 1,
    assistantMessageId: "ma1",
    approval: {
      id: "a1",
      turnId: "turn-1",
      kind: "action",
      headline: "Allow this action?",
      title: "mock action",
      symbol: "bolt",
      options: [{ id: "once", title: "Allow once", role: "approve", scope: "once" }],
      status: "pending",
    },
  };
}

function expectCorrupt(doc: StoreFile, marker: string): void {
  const root = fresh();
  writeFileSync(join(root, "store.json"), JSON.stringify(doc));
  const s = new Store(root);
  s.open();
  // Rejected loads are preserved aside, never thrown away.
  expect(s.recoveredFrom, marker).toBeTruthy();
  const backups = readdirSync(root).filter((f) => f.startsWith("store.corrupt-"));
  expect(backups.length, marker).toBe(1);
  s.close();
}

describe("document validation", () => {
  it("refuses over-capacity history without classifying it as corruption", () => {
    const root = fresh();
    const doc = emptyStore();
    doc.projects = Array.from({ length: 10_001 }, (_, i) => ({
      id: `p-${i}`, name: "P", createdAt: 1, expanded: true,
    }));
    const raw = JSON.stringify(doc);
    writeFileSync(join(root, "store.json"), raw);
    const s = new Store(root);
    expect(() => s.open()).toThrow(/capacity/);
    s.close();
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(raw);
    expect(readdirSync(root)).toEqual(["store.json"]);
  });

  it("accepts a clean document with historical turn references", () => {
    const root = fresh();
    writeFileSync(join(root, "store.json"), JSON.stringify(baseDoc()));
    const s = new Store(root);
    s.open();
    expect(s.recoveredFrom).toBeUndefined();
    s.close();
  });

  it("accepts a consistent waiting-approval document", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.turn = waitingTurn(t.id);
    t.messages.push({
      id: "ma1",
      role: "assistant",
      content: "…",
      status: "streaming",
      ts: 2,
      turnId: "turn-1",
    });
    const root = fresh();
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    s.open();
    expect(s.recoveredFrom).toBeUndefined();
    s.close();
  });

  it("rejects duplicate project / thread / message ids", () => {
    const dup = baseDoc();
    dup.projects = [
      { id: "p1", name: "A", createdAt: 1, expanded: true },
      { id: "p1", name: "B", createdAt: 1, expanded: false },
    ];
    expectCorrupt(dup, "dup projects");

    const dupT = baseDoc();
    dupT.threads = [dupT.threads[0]!, { ...dupT.threads[0]! }];
    expectCorrupt(dupT, "dup threads");

    const dupM = baseDoc();
    dupM.threads[0]!.messages.push({ ...dupM.threads[0]!.messages[0]! });
    expectCorrupt(dupM, "dup messages");
  });

  it("rejects a pending approval on a non-waiting turn", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.turn = { ...waitingTurn(t.id), status: "done", endedAt: 2 };
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "done", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc, "pending on done turn");
  });

  it("rejects waiting-approval without a pending approval", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    const turn = waitingTurn(t.id);
    turn.approval = { ...turn.approval!, status: "resolved", resolvedOptionId: "once" };
    t.turn = turn;
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "done", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc, "waiting w/o pending");
  });

  it("rejects resolved-without-option and pending-with-option approvals", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.turn = { ...waitingTurn(t.id), status: "done", endedAt: 2 };
    t.turn.approval = { ...t.turn.approval!, status: "resolved" };
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "done", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc, "resolved w/o option");

    const doc2 = baseDoc();
    const t2 = doc2.threads[0]!;
    t2.turn = waitingTurn(t2.id);
    t2.turn.approval = { ...t2.turn.approval!, resolvedOptionId: "once" };
    t2.messages.push({
      id: "ma1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc2, "pending with option");
  });

  it("rejects resolvedOptionId not present in options and stale turnId", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.turn = { ...waitingTurn(t.id), status: "done", endedAt: 2 };
    t.turn.approval = { ...t.turn.approval!, status: "resolved", resolvedOptionId: "ghost" };
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "done", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc, "option not in list");

    const doc2 = baseDoc();
    const t2 = doc2.threads[0]!;
    t2.turn = waitingTurn(t2.id);
    t2.turn.approval = { ...t2.turn.approval!, turnId: "turn-other" };
    t2.messages.push({
      id: "ma1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc2, "approval bound to other turn");
  });

  it("rejects autoResolved on a non-resolved approval", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "turn-1",
    });
    t.turn = waitingTurn(t.id);
    t.turn.approval = { ...t.turn.approval!, autoResolved: true };
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc, "autoResolved on pending");
  });

  it("accepts a user message carrying a historical turnId (A22 turn groups)", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.turn = { ...waitingTurn(t.id), status: "done", endedAt: 2 };
    t.turn.approval = { ...t.turn.approval!, status: "resolved", resolvedOptionId: "once" };
    t.messages.push(
      { id: "ma1", role: "assistant", content: "", status: "done", ts: 2, turnId: "turn-1" },
      { id: "m2", role: "user", content: "hi", status: "done", ts: 3, turnId: "turn-other" },
    );
    // Historical turn ids are expected — only the latest turn persists,
    // so references to ended turns are legitimate by design.
    const root = fresh();
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    s.open();
    expect(s.recoveredFrom).toBeFalsy();
    expect(s.state.threads[0]!.messages.at(-1)!.turnId).toBe("turn-other");
    s.close();
  });

  it("rejects a streaming message under a terminal turn", () => {
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.turn = { ...waitingTurn(t.id), status: "done", endedAt: 2 };
    t.turn.approval = { ...t.turn.approval!, status: "resolved", resolvedOptionId: "once" };
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "turn-1",
    });
    expectCorrupt(doc, "streaming under done");
  });

  it("accepts a document with 100001 messages — persistence limit, not IPC limit", () => {
    const root = fresh();
    const doc = baseDoc();
    for (let i = 0; i < 100_001; i++) {
      doc.threads[0]!.messages.push({
        id: `m-${i}`,
        role: "assistant",
        content: "x",
        status: "done",
        ts: i,
      });
    }
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    s.open();
    expect(s.recoveredFrom).toBeUndefined();
    s.close();
  });
});

describe("turn-scoped approval persistence (Codex permissions)", () => {
  it("a pending permission approval with scope turn survives save + reopen", () => {
    const root = fresh();
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.messages.push({
      id: "ma1", role: "assistant", content: "", status: "streaming", ts: 2, turnId: "turn-1",
    });
    t.turn = waitingTurn(t.id);
    t.turn.approval = {
      id: "a-perm",
      turnId: "turn-1",
      kind: "action",
      headline: "Codex requests permissions",
      title: "Grant requested permissions",
      detail: "write: /w/proj/file.txt",
      symbol: "exclamationmark.shield",
      options: [
        { id: "deny", title: "Deny", role: "deny", scope: "none" },
        { id: "turn", title: "Allow for this turn", role: "approve", scope: "turn" },
      ],
      status: "pending",
    };
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    s.open();
    expect(s.recoveredFrom).toBeUndefined(); // NOT corrupt — history intact
    const reloaded = s.state.threads.find((x) => x.id === "t1")!;
    expect(reloaded.turn?.approval?.status).toBe("pending");
    expect(reloaded.turn?.approval?.options.map((o) => o.scope)).toEqual(["none", "turn"]);
    s.close();

    // Round-trip through a real save: reopened bytes re-validate cleanly.
    const s2 = new Store(root);
    s2.open();
    expect(s2.recoveredFrom).toBeUndefined();
    const reloaded2 = s2.state.threads.find((x) => x.id === "t1")!;
    expect(reloaded2.turn?.approval?.options.map((o) => o.scope)).toEqual(["none", "turn"]);
    s2.close();
  });

  it("a resolved turn-scoped approval keeps its decision across reopen", () => {
    const root = fresh();
    const doc = baseDoc();
    const t = doc.threads[0]!;
    t.messages.push({
      id: "ma1", role: "assistant", content: "answer", status: "done", ts: 2, turnId: "turn-1",
    });
    t.turn = { ...waitingTurn(t.id), status: "running" };
    t.turn.approval = {
      id: "a-perm",
      turnId: "turn-1",
      kind: "action",
      headline: "Codex requests permissions",
      title: "Grant requested permissions",
      symbol: "exclamationmark.shield",
      options: [
        { id: "deny", title: "Deny", role: "deny", scope: "none" },
        { id: "turn", title: "Allow for this turn", role: "approve", scope: "turn" },
      ],
      status: "resolved",
      resolvedOptionId: "turn",
    };
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    s.open();
    expect(s.recoveredFrom).toBeUndefined();
    const reloaded = s.state.threads.find((x) => x.id === "t1")!;
    expect(reloaded.turn?.approval?.status).toBe("resolved");
    expect(reloaded.turn?.approval?.resolvedOptionId).toBe("turn");
    s.close();
  });
});
