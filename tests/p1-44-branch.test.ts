// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-44 Branch from here — slice semantics (empty, edited, attachments,
// in-flight), engine branch creation, persistence and provider boundary.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import { branchTitle, sliceThreadForBranch } from "../src/main/threadBranch";
import { requestValidators } from "../src/shared/ipc";
import type { Message, Turn } from "../src/shared/types";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

let seq = 0;
const msg = (role: Message["role"], content: string, turnId?: string, extra: Partial<Message> = {}): Message => ({
  id: `m${++seq}`,
  role,
  content,
  status: "done",
  ts: seq,
  ...(turnId !== undefined ? { turnId } : {}),
  ...extra,
});

const turn = (id: string, status: Turn["status"]): Turn =>
  ({ id, status, startedAt: 0 }) as unknown as Turn;

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeEngine(root: string) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}

function history(): Message[] {
  return [
    msg("user", "first question", "t1", { providerTurnId: "p-1" }),
    msg("assistant", "first answer", "t1", { providerTurnId: "p-1" }),
    msg("system", "untagged notice"),
    msg("user", "second question", "t2", {
      attachments: [{ id: "a-1", name: "notes.txt", size: 12 }],
    }),
    msg("assistant", "second answer", "t2"),
    msg("user", "third question", "t3"),
    msg("assistant", "third answer", "t3"),
  ];
}

describe("sliceThreadForBranch", () => {
  it("through keeps everything up to and including the reply's turn, in order", () => {
    const src = history();
    const s = sliceThreadForBranch(src, null, "t2", "through")!;
    expect(s.messages.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "untagged notice",
      "second question",
      "second answer",
    ]);
    expect(s.lastCopiedMessageId).toBe(src[4]!.id);
    expect(s.draft).toBeUndefined();
    expect(s.draftAttachments).toEqual([]);
    // Attachment metadata is copied as-is; provider ids are not.
    expect(s.messages[3]!.attachments).toEqual([{ id: "a-1", name: "notes.txt", size: 12 }]);
    expect(s.messages.some((m) => m.providerTurnId !== undefined)).toBe(false);
    // Copies, never shared references into the source.
    expect(s.messages[0]).not.toBe(src[0]);
    expect(src[0]!.providerTurnId).toBe("p-1");
  });

  it("before keeps prior turns and restores the user message as the draft", () => {
    const s = sliceThreadForBranch(history(), null, "t2", "before")!;
    expect(s.messages.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "untagged notice",
    ]);
    expect(s.draft).toBe("second question");
    expect(s.draftAttachments).toEqual([{ id: "a-1", name: "notes.txt", size: 12 }]);
  });

  it("before the first message yields an empty history with no anchor", () => {
    const s = sliceThreadForBranch(history(), null, "t1", "before")!;
    expect(s.messages).toEqual([]);
    expect(s.lastCopiedMessageId).toBeUndefined();
    expect(s.draft).toBe("first question");
  });

  it("an edited (rewound) chat branches from what it shows now", () => {
    const edited = history().slice(0, 3);
    edited.push(msg("user", "edited second question", "t4"), msg("assistant", "new answer", "t4"));
    expect(sliceThreadForBranch(edited, null, "t2", "through")).toBeNull();
    const s = sliceThreadForBranch(edited, null, "t4", "before")!;
    expect(s.draft).toBe("edited second question");
    expect(s.messages.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "untagged notice",
    ]);
  });

  it("rejects missing turns, empty chats and in-flight turns", () => {
    expect(sliceThreadForBranch([], null, "t1", "through")).toBeNull();
    expect(sliceThreadForBranch(history(), null, "nope", "before")).toBeNull();
    expect(sliceThreadForBranch(history(), turn("t3", "running"), "t3", "through")).toBeNull();
    expect(sliceThreadForBranch(history(), turn("t3", "running"), "t3", "before")).toBeNull();
    // Earlier turns stay branchable while a later one runs.
    expect(sliceThreadForBranch(history(), turn("t3", "running"), "t2", "through")).not.toBeNull();
    const streaming = history();
    streaming[4] = { ...streaming[4]!, status: "streaming" };
    expect(sliceThreadForBranch(streaming, null, "t2", "through")).toBeNull();
    expect(sliceThreadForBranch(streaming, null, "t2", "before")).not.toBeNull();
  });

  it("titles a branch once", () => {
    expect(branchTitle("Plan")).toBe("Branch: Plan");
    expect(branchTitle("Branch: Plan")).toBe("Branch: Plan");
  });
});

describe("threads:branch request", () => {
  const A = "00000000-0000-4000-8000-000000000001";
  const B = "00000000-0000-4000-8000-000000000002";
  it("accepts only before/through points", () => {
    expect(() =>
      requestValidators["threads:branch"]({ threadId: A, turnId: B, point: "through" }),
    ).not.toThrow();
    expect(() =>
      requestValidators["threads:branch"]({ threadId: A, turnId: B, point: "after" }),
    ).toThrow();
    expect(() =>
      requestValidators["threads:branch"]({ threadId: A, turnId: B, point: "before", x: 1 }),
    ).toThrow();
  });
});

describe("engine branchThread", () => {
  async function seeded(root: string) {
    const r = makeEngine(root);
    const proj = r.engine.createProject("p");
    const src = r.engine.createThread(proj.id, "Source");
    const done = () =>
      r.engine.snapshot().threads.find((t) => t.id === src.id)!.turn?.status === "done";
    r.engine.sendTurn(src.id, "alpha question");
    await waitFor(done);
    r.engine.sendTurn(src.id, "beta question");
    await waitFor(done);
    const msgs = r.engine.snapshot().threads.find((t) => t.id === src.id)!.messages;
    const turns = [...new Set(msgs.map((m) => m.turnId).filter((x): x is string => !!x))];
    return { ...r, proj, src, turns, msgs };
  }

  it("a reply branch copies history, records provenance and selects the new chat", async () => {
    const r = await seeded(tmp("tivano-branch-"));
    const made = r.engine.branchThread(r.src.id, r.turns[0]!, "through");
    const t = made.thread;
    expect(made.draft).toBeUndefined();
    expect(t.title).toBe("Branch: Source");
    expect(t.projectId).toBe(r.proj.id);
    const copied = t.messages.filter((m) => m.role === "user" || m.role === "assistant");
    expect(copied.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(copied[0]!.content).toBe("alpha question");
    expect(t.branchOrigin).toEqual({
      sourceThreadId: r.src.id,
      sourceTitle: "Source",
      lastCopiedMessageId: t.messages[t.messages.length - 1]!.id,
    });
    expect(t.continuation?.sent).toBe(false);
    expect(r.engine.snapshot().selectedThreadId).toBe(t.id);
    // The source chat is untouched.
    const src = r.engine.snapshot().threads.find((x) => x.id === r.src.id)!;
    expect(src.messages.length).toBe(r.msgs.length);
    r.engine.shutdown();
    r.store.close();
  });

  it("a user-message branch returns the prompt as the draft", async () => {
    const r = await seeded(tmp("tivano-branch-"));
    const made = r.engine.branchThread(r.src.id, r.turns[1]!, "before");
    expect(made.draft).toBe("beta question");
    expect(made.thread.messages.some((m) => m.content === "beta question")).toBe(false);
    expect(made.thread.messages.some((m) => m.content === "alpha question")).toBe(true);
    // Branching before the very first message gives an empty chat.
    const empty = r.engine.branchThread(r.src.id, r.turns[0]!, "before");
    expect(empty.thread.messages).toEqual([]);
    expect(empty.thread.continuation).toBeUndefined();
    expect(empty.thread.branchOrigin?.lastCopiedMessageId).toBeUndefined();
    expect(() => r.engine.branchThread(r.src.id, "missing-turn", "through")).toThrow(
      /no longer be branched/,
    );
    expect(() => r.engine.branchThread("missing-thread", r.turns[0]!, "through")).toThrow();
    r.engine.shutdown();
    r.store.close();
  });

  it("refuses while the source is replying", async () => {
    const r = await seeded(tmp("tivano-branch-"));
    r.engine.sendTurn(r.src.id, "gamma question");
    expect(() => r.engine.branchThread(r.src.id, r.turns[0]!, "through")).toThrow(
      /Wait for the current reply/,
    );
    await waitFor(
      () => r.engine.snapshot().threads.find((t) => t.id === r.src.id)!.turn?.status === "done",
    );
    r.engine.shutdown();
    r.store.close();
  });

  it("provider boundary: the first send carries copied history once; reload keeps provenance", async () => {
    const root = tmp("tivano-branch-");
    const r = await seeded(root);
    const id = r.engine.branchThread(r.src.id, r.turns[0]!, "through").thread.id;
    const branchDone = () =>
      r.engine.snapshot().threads.find((t) => t.id === id)!.turn?.status === "done";
    r.engine.sendTurn(id, "carry on");
    await waitFor(branchDone);
    const t1 = r.engine.snapshot().threads.find((t) => t.id === id)!;
    const reply = t1.messages[t1.messages.length - 1]!;
    expect(reply.content).toContain("alpha question");
    expect(reply.content).not.toContain("beta question");
    expect(t1.continuation?.sent).toBe(true);
    r.engine.shutdown();
    r.store.close();

    const again = makeEngine(root);
    const back = again.engine.snapshot().threads.find((t) => t.id === id)!;
    expect(back.branchOrigin?.sourceThreadId).toBe(r.src.id);
    expect(back.title).toBe("Branch: Source");
    again.engine.shutdown();
    again.store.close();
  });
});
