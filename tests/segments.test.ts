// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F30 segmented turn storage (frozen StoredTurnFile port): the head
// holds metadata only; turns/<id>.json holds messages + the latest turn.
// Covers the legacy-monolith migration, hydration, quarantine on a
// corrupt segment, orphan sweep, dirty-skip writes and crash fidelity.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { SCHEMA_VERSION } from "../src/shared/types";

const dirs: string[] = [];
const stores: Store[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-seg-"));
  dirs.push(d);
  return d;
}
function openStore(root: string): { store: Store; result: ReturnType<Store["open"]> } {
  const store = new Store(root);
  stores.push(store);
  return { store, result: store.open() };
}
afterEach(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  stores.length = 0;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const msg = (id: string, role: "user" | "assistant", content = "c") => ({
  id,
  role,
  content,
  status: "done" as const,
  ts: 1700000000000,
});
const baseThread = (id: string, messages = [] as unknown[]) => ({
  id,
  projectId: null,
  title: `t-${id.slice(0, 4)}`,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  messages,
  turn: null,
  sessionGrants: [],
});
const monolith = (threads: unknown[]) =>
  JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    projects: [],
    threads,
    settings: { theme: "breeze", language: "en", alwaysAllow: [] },
    ui: { selectedThreadId: null },
  });

describe("segmented turn storage (F30)", () => {
  it("migrates a legacy monolith: head goes segmented, segment carries history", () => {
    const root = freshRoot();
    const tid = randomUUID();
    writeFileSync(join(root, "store.json"), monolith([baseThread(tid, [msg("m1", "user", "hi")])]));
    const { result } = openStore(root);
    expect(result.segments?.migrated).toBe(true);
    const t = result.data.threads[0]!;
    expect(t.messages[0]?.content).toBe("hi");
    const { store } = { store: stores.at(-1)! };
    store.flushNow();
    // Head carries metadata + the marker, never inline history.
    const head = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      turnStorage?: string;
      threads: { messages?: unknown; turn?: unknown }[];
    };
    expect(head.turnStorage).toBe("segments");
    expect(head.threads[0]?.messages).toBeUndefined();
    expect(head.threads[0]?.turn).toBeUndefined();
    const seg = JSON.parse(readFileSync(join(root, "turns", `${tid}.json`), "utf8")) as {
      threadId: string;
      messages: { content: string }[];
    };
    expect(seg.threadId).toBe(tid);
    expect(seg.messages[0]?.content).toBe("hi");
  });

  it("round-trips messages + turn state through the segment file", () => {
    const root = freshRoot();
    const { store } = openStore(root);
    const tid = randomUUID();
    store.update((d) => {
      d.threads.push(baseThread(tid, [msg("u1", "user"), msg("a1", "assistant", "reply")]) as never);
    });
    store.flushNow();
    store.close();
    const { result } = openStore(root);
    const t = result.data.threads.find((x) => x.id === tid)!;
    expect(t.messages.map((m) => m.content)).toEqual(["c", "reply"]);
    stores.at(-1)!.close();
  });

  it("a corrupt segment quarantines and reports skipped — library still opens", () => {
    const root = freshRoot();
    const tid = randomUUID();
    writeFileSync(
      join(root, "store.json"),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        projects: [],
        threads: [baseThread(tid, [])],
        settings: { theme: "breeze", language: "en", alwaysAllow: [] },
        ui: { selectedThreadId: null },
        turnStorage: "segments",
      }),
    );
    mkdirSync(join(root, "turns"), { recursive: true });
    writeFileSync(join(root, "turns", `${tid}.json`), "this is not json {");
    const { result } = openStore(root);
    expect(result.segments?.skipped).toEqual([tid]);
    expect(result.data.threads[0]?.messages).toEqual([]);
    const files = readdirSync(join(root, "turns"));
    expect(files.some((f) => f.startsWith(`${tid}.corrupt-`))).toBe(true);
    // The quarantined evidence is never swept or rewritten by a flush.
    stores.at(-1)!.flushNow();
    expect(readdirSync(join(root, "turns")).some((f) => f.startsWith(`${tid}.corrupt-`))).toBe(true);
  });

  it("a missing segment reports honestly, then self-heals on next write", () => {
    const root = freshRoot();
    const tid = randomUUID();
    writeFileSync(
      join(root, "store.json"),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        projects: [],
        threads: [baseThread(tid, [])],
        settings: { theme: "breeze", language: "en", alwaysAllow: [] },
        ui: { selectedThreadId: null },
        turnStorage: "segments",
      }),
    );
    const { store, result } = openStore(root);
    expect(result.segments?.missing).toEqual([tid]);
    store.update((d) => {
      d.threads[0]!.messages.push(msg("n1", "user", "healed") as never);
    });
    store.flushNow();
    expect(existsSync(join(root, "turns", `${tid}.json`))).toBe(true);
  });

  it("deleting a thread sweeps its segment; unrelated segments are protected", () => {
    const root = freshRoot();
    const keep = randomUUID();
    const gone = randomUUID();
    const { store } = openStore(root);
    store.update((d) => {
      d.threads.push(baseThread(keep, [msg("k", "user")]) as never);
      d.threads.push(baseThread(gone, [msg("g", "user")]) as never);
    });
    store.flushNow();
    expect(existsSync(join(root, "turns", `${gone}.json`))).toBe(true);
    store.update((d) => {
      d.threads = d.threads.filter((t) => t.id !== gone);
    });
    store.flushNow();
    expect(existsSync(join(root, "turns", `${gone}.json`))).toBe(false);
    expect(existsSync(join(root, "turns", `${keep}.json`))).toBe(true);
  });

  it("an unchanged thread's segment is not rewritten", () => {
    const root = freshRoot();
    const { store } = openStore(root);
    const a = randomUUID();
    const b = randomUUID();
    store.update((d) => {
      d.threads.push(baseThread(a, [msg("x", "user")]) as never);
      d.threads.push(baseThread(b, [msg("y", "user")]) as never);
    });
    store.flushNow();
    const aBefore = statSync(join(root, "turns", `${a}.json`)).mtimeMs;
    store.update((d) => {
      d.threads.find((t) => t.id === b)!.messages.push(msg("y2", "assistant", "more") as never);
    });
    store.flushNow();
    expect(statSync(join(root, "turns", `${a}.json`)).mtimeMs).toBe(aBefore);
    const segB = JSON.parse(readFileSync(join(root, "turns", `${b}.json`), "utf8")) as {
      messages: unknown[];
    };
    expect(segB.messages).toHaveLength(2);
  });

  it("a live persisted turn survives in the segment across restart", () => {
    const root = freshRoot();
    const tid = randomUUID();
    const turn = {
      id: randomUUID(),
      threadId: tid,
      status: "waiting-approval" as const,
      seq: 1,
      startedAt: 1700000000000,
      assistantMessageId: "am1",
      approval: {
        id: randomUUID(),
        turnId: "",
        providerKey: "codex",
        kind: "command",
        headline: "Run command",
        title: "Run command",
        symbol: "terminal",
        options: [{ id: "o1", role: "approve", scope: "once", title: "Allow once" }],
        status: "pending" as const,
      },
    };
    turn.approval.turnId = turn.id;
    const thread = { ...baseThread(tid, [msg("am1", "assistant")]), turn };
    (thread.messages as { turnId?: string }[])[0]!.turnId = turn.id;
    writeFileSync(join(root, "store.json"), monolith([thread]));
    const { result } = openStore(root);
    expect(result.data.threads[0]?.turn?.status).toBe("waiting-approval");
    const { store } = { store: stores.at(-1)! };
    store.flushNow();
    const seg = JSON.parse(readFileSync(join(root, "turns", `${tid}.json`), "utf8")) as {
      turn: { status: string; approval: { status: string } };
    };
    expect(seg.turn.status).toBe("waiting-approval");
    expect(seg.turn.approval.status).toBe("pending");
  });

  it("a corrupt head still preserves aside exactly once", () => {
    const root = freshRoot();
    writeFileSync(join(root, "store.json"), "{not json");
    const { result } = openStore(root);
    expect(result.recoveredFrom).toBeTruthy();
    expect(existsSync(result.recoveredFrom!)).toBe(true);
  });
});
