// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F33 local control — real Unix-socket round trips: the frozen double
// gate, hello/welcome handshake, read queries, the write trio with the
// ticket ledger (dedupe/conflict/stale), and refusal surface.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { LocalControlService } from "../src/main/localControl";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-lc-"));
  dirs.push(d);
  return d;
}
const services: LocalControlService[] = [];
function rig(): { engine: Engine; store: Store; svc: LocalControlService; sock: string } {
  const root = freshRoot();
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "t");
  const svc = new LocalControlService(engine, root, "dev");
  services.push(svc);
  return { engine, store, svc, sock: join(root, "control", "control.sock") };
}
afterEach(() => {
  for (const s of services) s.dispose();
  services.length = 0;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const frame = (obj: unknown): Buffer => {
  const p = Buffer.from(JSON.stringify(obj), "utf8");
  const f = Buffer.alloc(4 + p.length);
  f.writeUInt32BE(p.length, 0);
  p.copy(f, 4);
  return f;
};

/** One request/response on a fresh connection after a successful hello. */
function call(sock: string, instance: string, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = Buffer.alloc(0);
    conn.on("connect", () => {
      conn.write(frame({ version: 1, edition: "dev" }));
      conn.write(
        frame({ id: randomUUID(), instance, command: { method, params } }),
      );
    });
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // Consume every complete frame — welcome and the response can
      // arrive coalesced in a single chunk.
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (buf.length < size + 4) break;
        const msg = JSON.parse(
          buf.subarray(4, 4 + size).toString("utf8"),
        ) as Record<string, unknown>;
        buf = buf.subarray(4 + size);
        if (msg.id !== undefined || msg.error !== undefined) {
          conn.destroy();
          resolve(msg);
          return;
        }
      }
    });
    conn.on("error", reject);
    conn.setTimeout(5000, () => reject(new Error("control call timeout")));
  });
}

/** Handshake only — returns the raw hello response. */
function hello(sock: string, h: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = Buffer.alloc(0);
    conn.on("connect", () => conn.write(frame(h)));
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4 && buf.length >= buf.readUInt32BE(0) + 4) {
        const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString("utf8"));
        conn.destroy();
        resolve(msg as Record<string, unknown>);
      }
    });
    conn.on("error", reject);
    conn.setTimeout(5000, () => reject(new Error("hello timeout")));
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enabled = (e: Engine) =>
  e.setSettings({ alphaEnabled: true, externalControlEnabled: true });
const ticket = (svc: LocalControlService) =>
  `${svc.instance}/${randomUUID()}/${Date.now()}`;

describe("local control (F33)", () => {
  it("stays silent until BOTH gates are on, and stops when a gate closes", async () => {
    const { engine, svc, sock } = rig();
    svc.refreshListening();
    expect(svc.listening).toBe(false);
    expect(existsSync(sock)).toBe(false);
    engine.setSettings({ alphaEnabled: true });
    svc.refreshListening();
    expect(svc.listening).toBe(false);
    enabled(engine);
    svc.refreshListening();
    expect(svc.listening).toBe(true);
    await wait(30);
    expect(existsSync(sock)).toBe(true);
    engine.setSettings({ externalControlEnabled: false });
    svc.refreshListening();
    await wait(30);
    expect(svc.listening).toBe(false);
    expect(existsSync(sock)).toBe(false);
  });

  it("handshake enforces version, edition and instance", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const ok = await hello(sock, { version: 1, edition: "dev" });
    const welcome = (ok.result as Record<string, unknown>).welcome as Record<string, unknown>;
    expect(welcome.version).toBe(1);
    expect(welcome.edition).toBe("dev");
    expect(welcome.instance).toBe(svc.instance);
    expect(welcome.methods).toContain("submit");
    const badVersion = await hello(sock, { version: 99, edition: "dev" });
    expect((badVersion.error as Record<string, unknown>).code).toBe("protocolMismatch");
    const badEdition = await hello(sock, { version: 1, edition: "release" });
    expect((badEdition.error as Record<string, unknown>).code).toBe("editionMismatch");
    const badInstance = await hello(sock, {
      version: 1,
      edition: "dev",
      expectedInstance: randomUUID(),
    });
    expect((badInstance.error as Record<string, unknown>).code).toBe("instanceMismatch");
  });

  it("answers read queries: info/projects/threads/thread/history", async () => {
    const { engine, svc, sock } = rig();
    const p = engine.createProject("proj-a");
    const t = engine.createThread(p.id, "thread one");
    engine.sendTurn(t.id, "hello");
    await wait(50);
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const info = await call(sock, svc.instance, "info");
    expect((info.result as Record<string, unknown>).info).toBeTruthy();
    const projects = await call(sock, svc.instance, "projects", { limit: 10 });
    const pItems = (projects.result as Record<string, unknown>).projects as {
      items: { id: string; name: string }[];
    };
    expect(pItems.items.map((x) => x.name)).toContain("proj-a");
    const threads = await call(sock, svc.instance, "threads", {});
    const tItems = (threads.result as Record<string, unknown>).threads as {
      items: { id: string; affiliation: string }[];
    };
    expect(tItems.items[0]?.id).toBe(t.id);
    expect(tItems.items[0]?.affiliation).toBe("project");
    const one = await call(sock, svc.instance, "thread", { threadId: t.id });
    expect(((one.result as Record<string, unknown>).thread as { id: string }).id).toBe(t.id);
    const hist = await call(sock, svc.instance, "history", { threadId: t.id });
    const entries = (hist.result as Record<string, unknown>).history as {
      items: { kind: string }[];
      persistedOnly: boolean;
    };
    expect(entries.persistedOnly).toBe(true);
    expect(entries.items.some((e) => e.kind === "user")).toBe(true);
  });

  it("rejects instance-mismatched and unknown-method requests", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const wrong = await call(sock, randomUUID(), "info");
    expect((wrong.error as Record<string, unknown>).code).toBe("instanceMismatch");
    const unknown = await call(sock, svc.instance, "approve");
    expect((unknown.error as Record<string, unknown>).code).toBe("invalidRequest");
    const deny = await call(sock, svc.instance, "answer");
    expect((deny.error as Record<string, unknown>).code).toBe("invalidRequest");
  });

  it("creates a local thread and refuses worktree + missing project", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const p = engine.createProject("p2");
    const created = await call(sock, svc.instance, "create", {
      ticket: ticket(svc),
      workspace: "local",
      project: p.id,
    });
    const op = (created.result as Record<string, unknown>).operation as {
      state: string;
      threadId: string;
    };
    expect(op.state).toBe("ready");
    expect(engine.snapshot().threads.find((t) => t.id === op.threadId)).toBeTruthy();
    const wt = await call(sock, svc.instance, "create", {
      ticket: ticket(svc),
      workspace: "worktree",
      project: p.id,
    });
    expect((wt.error as Record<string, unknown>).code).toBe("unsupported");
    const missing = await call(sock, svc.instance, "create", {
      ticket: ticket(svc),
      workspace: "local",
      project: randomUUID(),
    });
    expect((missing.error as Record<string, unknown>).code).toBe("missingProject");
  });

  it("submits a turn and tracks it through the ticket ledger", async () => {
    const { engine, svc, sock } = rig();
    const t = engine.createThread(null, "subj");
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const tk = ticket(svc);
    const sent = await call(sock, svc.instance, "submit", {
      ticket: tk,
      threadId: t.id,
      text: "hello via control",
    });
    const op = (sent.result as Record<string, unknown>).operation as {
      state: string;
      turnId: string;
    };
    expect(op.state).toBe("started");
    // Wait for the mock turn to end, then query the same ticket.
    await wait(120);
    const queried = await call(sock, svc.instance, "operation", { ticket: tk });
    const outcome = (queried.result as Record<string, unknown>).operation as {
      state: string;
      turnStatus?: string;
    };
    expect(outcome.state).toBe("ended");
    expect(outcome.turnStatus).toBe("done");
    // Same ticket + same payload returns the receipt — never re-runs.
    const again = await call(sock, svc.instance, "submit", {
      ticket: tk,
      threadId: t.id,
      text: "hello via control",
    });
    expect(
      ((again.result as Record<string, unknown>).operation as { turnId: string }).turnId,
    ).toBe(op.turnId);
    // Same ticket + DIFFERENT payload is a conflict.
    const conflict = await call(sock, svc.instance, "submit", {
      ticket: tk,
      threadId: t.id,
      text: "different text",
    });
    expect((conflict.error as Record<string, unknown>).code).toBe("conflict");
    // Slash commands ride no ordinary prompt.
    const slash = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc),
      threadId: t.id,
      text: "/plan do things",
    });
    expect((slash.error as Record<string, unknown>).code).toBe("invalidRequest");
    // Archived threads reject.
    engine.archiveThread(t.id);
    const archived = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc),
      threadId: t.id,
      text: "nope",
    });
    expect((archived.error as Record<string, unknown>).code).toBe("archived");
  });

  it("interrupts a running turn via its ticket", async () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 400 }), root, "t");
    const svc = new LocalControlService(engine, root, "dev");
    services.push(svc);
    const sock = join(root, "control", "control.sock");
    const t = engine.createThread(null);
    const turn = engine.sendTurn(t.id, "slow work please");
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const res = await call(sock, svc.instance, "interrupt", {
      ticket: ticket(svc),
      threadId: t.id,
      turnId: turn.id,
    });
    const op = (res.result as Record<string, unknown>).operation as {
      state: string;
      stopEvidence: string;
    };
    expect(op.state).toBe("ended");
    expect(op.stopEvidence).toBe("runtime_ended_only");
    const after = engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(after.turn?.status).not.toBe("running");
    store.close();
  });

  it("settings get/set honor the bounded key set", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const got = await call(sock, svc.instance, "settingsGet");
    const list = (got.result as Record<string, unknown>).settings as { key: string }[];
    expect(list.map((s) => s.key)).toContain("textGeneration");
    const set = await call(sock, svc.instance, "settingsSet", {
      ticket: ticket(svc),
      key: "antiSlopEnabled",
      bool: false,
    });
    expect(((set.result as Record<string, unknown>).operation as { state: string }).state).toBe(
      "ended",
    );
    expect(engine.snapshot().settings.antiSlopEnabled).toBe(false);
    // Keys outside the bounded set are refused as invalid requests.
    const un = await call(sock, svc.instance, "settingsSet", {
      ticket: ticket(svc),
      key: "sidebarActivityView",
      bool: true,
    });
    expect((un.error as Record<string, unknown>).code).toBe("invalidRequest");
    // performanceMode/showsSkylight are real settings in this build.
    const pm = await call(sock, svc.instance, "settingsSet", {
      ticket: ticket(svc),
      key: "performanceMode",
      bool: true,
    });
    expect(((pm.result as Record<string, unknown>).operation as { state: string }).state).toBe(
      "ended",
    );
    expect(engine.snapshot().settings.performanceMode).toBe(true);
    const sky = await call(sock, svc.instance, "settingsSet", {
      ticket: ticket(svc),
      key: "showsSkylight",
      bool: false,
    });
    expect(((sky.result as Record<string, unknown>).operation as { state: string }).state).toBe(
      "ended",
    );
    expect(engine.snapshot().settings.showsSkylight).toBe(false);
  });

  it("a stale ticket is unknown and never executed", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const stale = `${svc.instance}/${randomUUID()}/${Date.now() - 60_000}`;
    const res = await call(sock, svc.instance, "submit", {
      ticket: stale,
      threadId: engine.createThread(null).id,
      text: "old write",
    });
    expect((res.error as Record<string, unknown>).code).toBe("unknown");
  });
});
