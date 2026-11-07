// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F09 continuation — frozen capture budget/markers, install guard,
// one-shot delivery into the provider session, persistence.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureContinuation,
  CONTINUATION_CONTEXT_BUDGET,
  CONTINUATION_FIRST_REQUEST_LIMIT,
  continuationPrompt,
} from "../src/main/continuation";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import type { Message } from "../src/shared/types";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const msg = (role: Message["role"], content: string, i = 0): Message => ({
  id: `m${i}`,
  role,
  content,
  status: "done",
  ts: i,
});

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

describe("captureContinuation (frozen budget)", () => {
  it("renders user+assistant in order, skips other roles", () => {
    const c = captureContinuation(
      [
        msg("user", "build me a thing", 1),
        msg("assistant", "sure, doing that", 2),
        msg("system", "notice", 3),
        msg("user", "  ", 4),
        msg("assistant", "done", 5),
      ],
      "src-1",
      "Source Chat",
    );
    expect(c.context).toBe(
      "User: build me a thing\n\nAssistant: sure, doing that\n\nAssistant: done",
    );
    expect(c.isTruncated).toBe(false);
    expect(c.sent).toBe(false);
    expect(c.sourceThreadId).toBe("src-1");
  });

  it("first request is pinned, newest favoured, marker on overflow", () => {
    const first = "FIRST-REQUEST " + "x".repeat(CONTINUATION_FIRST_REQUEST_LIMIT + 500);
    const omitted = "OMITTED-MIDDLE";
    const big = "BIG-SHORTENED " + "y".repeat(CONTINUATION_CONTEXT_BUDGET);
    const last = "LAST-MESSAGE";
    const c = captureContinuation(
      [
        msg("user", first, 1),
        msg("assistant", omitted, 2),
        msg("assistant", big, 3),
        msg("user", last, 4),
      ],
      "s",
      "T",
    );
    expect(c.isTruncated).toBe(true);
    expect(c.context).toContain("FIRST-REQUEST");
    expect(c.context).toContain("[message shortened]");
    expect(c.context).toContain("omitted here to keep the context");
    expect(c.context).toContain(`User: ${last}`);
    expect(c.context).not.toContain(omitted);
    expect(c.context.length).toBeLessThanOrEqual(CONTINUATION_CONTEXT_BUDGET + 400);
  });

  it("re-forward chains the previous snapshot without re-wrapping", () => {
    const first = captureContinuation([msg("user", "original ask")], "a", "A");
    const again = captureContinuation([], "b", "B", first);
    expect(again.context).toBe(first.context);
    expect(again.isTruncated).toBe(first.isTruncated);
  });
});

describe("continuationPrompt (frozen scaffold)", () => {
  it("wraps the context in the frozen markers", () => {
    const c = captureContinuation([msg("user", "hello")], "s", "My Chat");
    const p = continuationPrompt(c);
    expect(p).toContain('forwarded their earlier chat "My Chat"');
    expect(p).toContain("----- BEGIN FORWARDED CONTEXT -----");
    expect(p).toContain("User: hello");
    expect(p).toContain("----- END FORWARDED CONTEXT -----");
    expect(p).toContain("no provider session, tool state or running heads");
    expect(p).not.toContain("shortened or omitted");
  });

  it("adds the truncation disclaimer when truncated", () => {
    const c = captureContinuation(
      [msg("user", "a".repeat(CONTINUATION_CONTEXT_BUDGET * 2))],
      "s",
      "T",
    );
    expect(c.isTruncated).toBe(true);
    expect(continuationPrompt(c)).toContain("shortened or omitted");
  });
});

describe("engine forwardThread (F09)", () => {
  it("creates a Continued: thread in the same project, selected, empty", async () => {
    const r = makeEngine(tmp("tivano-fwd-"));
    const proj = r.engine.createProject("p");
    const src = r.engine.createThread(proj.id, "Source");
    r.engine.sendTurn(src.id, "first question");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === src.id)!.turn?.status ===
        "done",
    );

    const dest = r.engine.forwardThread(src.id);
    expect(dest.title).toBe("Continued: Source");
    expect(dest.projectId).toBe(proj.id);
    expect(dest.messages).toEqual([]);
    expect(dest.continuation?.sent).toBe(false);
    expect(dest.continuation?.context).toContain("User: first question");
    expect(r.engine.snapshot().selectedThreadId).toBe(dest.id);
    expect(() => r.engine.forwardThread("nope")).toThrow();
    r.engine.shutdown();
    r.store.close();
  });

  it("first send carries the forwarded prompt once; shown text stays the user's", async () => {
    const r = makeEngine(tmp("tivano-fwd-"));
    const src = r.engine.createThread(null, "Origin");
    r.engine.sendTurn(src.id, "the original question");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === src.id)!.turn?.status ===
        "done",
    );
    const dest = r.engine.forwardThread(src.id);

    r.engine.sendTurn(dest.id, "now continue please");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === dest.id)!.turn?.status ===
        "done",
    );
    const t1 = r.engine.snapshot().threads.find((t) => t.id === dest.id)!;
    const userMsg = t1.messages.find((m) => m.role === "user")!;
    const reply = t1.messages.find((m) => m.role === "assistant")!;
    // User bubble shows only the user's words (frozen).
    expect(userMsg.content).toBe("now continue please");
    // The WIRE prompt carried the snapshot — visible in the mock echo.
    expect(reply.content).toContain("BEGIN FORWARDED CONTEXT");
    expect(reply.content).toContain("the original question");
    expect(reply.content).toContain("now continue please");
    expect(t1.continuation?.sent).toBe(true);

    // Second turn: no re-injection.
    r.engine.sendTurn(dest.id, "second turn");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === dest.id)!.turn?.status ===
        "done",
    );
    const t2 = r.engine.snapshot().threads.find((t) => t.id === dest.id)!;
    const reply2 = t2.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(reply2.content).not.toContain("BEGIN FORWARDED CONTEXT");
    r.engine.shutdown();
    r.store.close();
  });

  it("sent flag persists across restart — never re-injected on resume", async () => {
    const dir = tmp("tivano-fwd-");
    const r = makeEngine(dir);
    const src = r.engine.createThread(null, "Origin");
    r.engine.sendTurn(src.id, "orig ask");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === src.id)!.turn?.status ===
        "done",
    );
    const dest = r.engine.forwardThread(src.id);
    r.engine.sendTurn(dest.id, "go on");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === dest.id)!.turn?.status ===
        "done",
    );
    r.engine.shutdown();
    r.store.close();

    const r2 = makeEngine(dir);
    const t = r2.engine.snapshot().threads.find((x) => x.id === dest.id)!;
    expect(t.continuation?.sent).toBe(true);
    expect(t.continuation?.sourceThreadId).toBe(src.id);
    r2.engine.sendTurn(dest.id, "after restart");
    await waitFor(
      () =>
        r2.engine.snapshot().threads.find((x) => x.id === dest.id)!.turn?.status ===
        "done",
    );
    const t2 = r2.engine.snapshot().threads.find((x) => x.id === dest.id)!;
    const reply = t2.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(reply.content).not.toContain("BEGIN FORWARDED CONTEXT");
    r2.engine.shutdown();
    r2.store.close();
  });

  it("unsent continuation survives restart and still delivers once", async () => {
    const dir = tmp("tivano-fwd-");
    const r = makeEngine(dir);
    const src = r.engine.createThread(null, "Origin");
    r.engine.sendTurn(src.id, "orig ask");
    await waitFor(
      () =>
        r.engine.snapshot().threads.find((t) => t.id === src.id)!.turn?.status ===
        "done",
    );
    const dest = r.engine.forwardThread(src.id);
    r.engine.shutdown();
    r.store.close();

    const r2 = makeEngine(dir);
    expect(
      r2.engine.snapshot().threads.find((x) => x.id === dest.id)!.continuation?.sent,
    ).toBe(false);
    r2.engine.sendTurn(dest.id, "first after restart");
    await waitFor(
      () =>
        r2.engine.snapshot().threads.find((x) => x.id === dest.id)!.turn?.status ===
        "done",
    );
    const t = r2.engine.snapshot().threads.find((x) => x.id === dest.id)!;
    const reply = t.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(reply.content).toContain("BEGIN FORWARDED CONTEXT");
    expect(t.continuation?.sent).toBe(true);
    r2.engine.shutdown();
    r2.store.close();
  });
});
