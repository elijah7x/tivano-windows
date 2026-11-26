// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F33 / P2-23 local control — real Unix-socket round trips: the
// externalControlEnabled gate (migrated out of Alpha), hello/welcome
// handshake, read queries, the write trio with the ticket ledger
// (dedupe/conflict/stale), and refusal surface.

import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store, emptyStore } from "../src/main/store";
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

/** Some sandboxes deny filesystem/named-pipe listeners outright — the
 *  F34 socket cases probe once and skip there instead of failing on the
 *  environment; tests/localControlDispatch.test.ts covers the same ops
 *  without a socket and always runs. */
const socketBindable = await new Promise<boolean>((resolve) => {
  const probe = join(tmpdir(), `tivano-lc-probe-${randomUUID()}.sock`);
  const s = createServer(() => {});
  s.on("error", () => resolve(false));
  s.listen(probe, () => s.close(() => resolve(true)));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enabled = (e: Engine) =>
  e.setSettings({ externalControlEnabled: true });
const ticket = (svc: LocalControlService) =>
  `${svc.instance}/${randomUUID()}/${Date.now()}`;

describe("local control (F33)", () => {
  it("listens solely on externalControlEnabled; alphaEnabled no longer gates it", async () => {
    const { engine, svc, sock } = rig();
    svc.refreshListening();
    expect(svc.listening).toBe(false);
    expect(existsSync(sock)).toBe(false);
    engine.setSettings({ alphaEnabled: true });
    svc.refreshListening();
    expect(svc.listening).toBe(false);
    expect(existsSync(sock)).toBe(false);
    engine.setSettings({ alphaEnabled: false, externalControlEnabled: true });
    svc.refreshListening();
    expect(svc.listening).toBe(true);
    if (socketBindable) {
      await wait(30);
      expect(existsSync(sock)).toBe(true);
    }
    // Toggling Alpha while externalControlEnabled is on does not stop listening.
    engine.setSettings({ alphaEnabled: true });
    svc.refreshListening();
    expect(svc.listening).toBe(true);
    engine.setSettings({ alphaEnabled: false });
    svc.refreshListening();
    expect(svc.listening).toBe(true);
    // Turning externalControlEnabled off closes the listener and unlinks the socket.
    engine.setSettings({ externalControlEnabled: false });
    svc.refreshListening();
    await wait(30);
    expect(svc.listening).toBe(false);
    expect(existsSync(sock)).toBe(false);
  });

  it("migrates older stores once by keeping (alphaEnabled && externalControlEnabled)", async () => {
    const cases: Array<{
      name: string;
      alphaEnabled?: boolean;
      externalControlEnabled?: boolean;
      expected: boolean;
    }> = [
      { name: "alpha off + control on -> off", alphaEnabled: false, externalControlEnabled: true, expected: false },
      { name: "alpha absent + control on -> off", externalControlEnabled: true, expected: false },
      { name: "alpha on + control on -> on", alphaEnabled: true, externalControlEnabled: true, expected: true },
      { name: "alpha on + control off -> off", alphaEnabled: true, externalControlEnabled: false, expected: false },
      { name: "alpha off + control off -> off", alphaEnabled: false, externalControlEnabled: false, expected: false },
      { name: "both absent -> off", expected: false },
    ];

    for (const c of cases) {
      const root = freshRoot();
      const doc = emptyStore() as unknown as {
        schemaVersion: number;
        projects: unknown[];
        threads: unknown[];
        settings: Record<string, unknown>;
        ui: { selectedThreadId: null };
      };
      delete doc.settings.controlLeftAlpha;
      if (c.alphaEnabled !== undefined) doc.settings.alphaEnabled = c.alphaEnabled;
      if (c.externalControlEnabled !== undefined)
        doc.settings.externalControlEnabled = c.externalControlEnabled;
      writeFileSync(join(root, "store.json"), JSON.stringify(doc));

      const store = new Store(root);
      store.open();
      const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "t");
      const svc = new LocalControlService(engine, root, "dev");
      services.push(svc);
      const sock = join(root, "control", "control.sock");
      svc.refreshListening();

      expect(store.state.settings.externalControlEnabled, c.name).toBe(c.expected);
      expect(store.state.settings.controlLeftAlpha, c.name).toBe(true);
      if (c.expected) {
        expect(svc.listening, c.name).toBe(true);
        if (socketBindable) {
          await wait(30);
          expect(existsSync(sock), c.name).toBe(true);
        }
      } else {
        expect(svc.listening, c.name).toBe(false);
        expect(existsSync(sock), c.name).toBe(false);
      }

      // Persisting and reopening never re-runs the migration even if Alpha is off.
      svc.dispose();
      store.close();
      const persisted = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
        settings: Record<string, unknown>;
      };
      expect(persisted.settings.controlLeftAlpha, c.name).toBe(true);
      expect(persisted.settings.externalControlEnabled, c.name).toBe(c.expected);

      const store2 = new Store(root);
      store2.open();
      expect(store2.state.settings.externalControlEnabled, c.name).toBe(c.expected);
      store2.close();
    }

    // Already-migrated store (controlLeftAlpha: true) keeps externalControlEnabled on when Alpha is off.
    const root = freshRoot();
    const doc = emptyStore();
    doc.settings.alphaEnabled = false;
    doc.settings.externalControlEnabled = true;
    doc.settings.controlLeftAlpha = true;
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));

    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "t");
    const svc = new LocalControlService(engine, root, "dev");
    services.push(svc);
    svc.refreshListening();
    expect(store.state.settings.externalControlEnabled).toBe(true);
    expect(svc.listening).toBe(true);
    if (socketBindable) {
      await wait(30);
      expect(existsSync(join(root, "control", "control.sock"))).toBe(true);
    }
    svc.dispose();
    store.close();
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
    expect(list.map((s) => s.key)).toEqual(["textGeneration", "showsSkylight"]);
    const tg = await call(sock, svc.instance, "settingsSet", {
      ticket: ticket(svc),
      key: "textGeneration",
      textGeneration: "off",
    });
    expect(((tg.result as Record<string, unknown>).operation as { state: string }).state).toBe(
      "ended",
    );
    expect(engine.snapshot().settings.textGeneration).toBe("off");
    // Keys outside the bounded set (including retired v2.x keys) are refused as invalid requests.
    for (const retiredKey of ["sidebarActivityView", "antiSlopEnabled", "performanceMode"]) {
      const un = await call(sock, svc.instance, "settingsSet", {
        ticket: ticket(svc),
        key: retiredKey,
        bool: true,
      });
      expect((un.error as Record<string, unknown>).code).toBe("invalidRequest");
    }
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

  describe.runIf(socketBindable)("F34 socket-level hydra control", () => {
  it("create --hydra on needs the app-wide switch and a saved pair", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    // Non-boolean hydra is a bad request.
    const bad = await call(sock, svc.instance, "create", {
      ticket: ticket(svc), workspace: "local", hydra: "yes",
    });
    expect((bad.error as Record<string, unknown>).code).toBe("invalidRequest");
    // App-wide switch off -> unsupported/hydra_disabled.
    engine.setSettings({ hydraEnabled: false });
    const off = await call(sock, svc.instance, "create", {
      ticket: ticket(svc), workspace: "local", hydra: true,
    });
    expect((off.error as Record<string, unknown>).code).toBe("unsupported");
    expect((off.error as Record<string, unknown>).detail).toBe("hydra_disabled");
    // Switch on but no saved pair -> a clear failure, not a silent
    // Hydra-off chat.
    engine.setSettings({ hydraEnabled: true, hydraPairs: [] });
    const noPair = await call(sock, svc.instance, "create", {
      ticket: ticket(svc), workspace: "local", hydra: true,
    });
    expect((noPair.error as Record<string, unknown>).code).toBe("unsupported");
    expect((noPair.error as Record<string, unknown>).detail).toBe("hydra_pair_missing");
    // A pair saved against ANOTHER provider does not count.
    engine.setSettings({
      hydraPairs: [{ id: "foreign", provider: "claude", headProfiles: [] }],
    });
    const foreign = await call(sock, svc.instance, "create", {
      ticket: ticket(svc), workspace: "local", hydra: true,
    });
    expect((foreign.error as Record<string, unknown>).detail).toBe("hydra_pair_missing");
  });

  it("F34: --hydra on binds the saved pair; absent or off never inherits", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    // The UI's own defaults exist — external create must not touch them.
    engine.setSettings({
      hydraEnabled: true,
      hydraDefaultEnabled: true,
      lastHydraPairId: "pair-ui",
      hydraPairs: [
        {
          id: "pair-1",
          provider: "mock",
          orchestratorModel: "mock-big",
          orchestratorEffort: "high",
          headProfiles: [],
        },
      ],
    });
    type CreateOp = { operation: { state: string; threadId: string } };
    const op = async (params: Record<string, unknown>) =>
      ((await call(sock, svc.instance, "create", { ticket: ticket(svc), ...params }))
        .result as CreateOp).operation;
    // --hydra on, no model: the pair's saved lead model+effort apply.
    const on = await op({ workspace: "local", hydra: true });
    expect(on.state).toBe("ready");
    const led = engine.snapshot().threads.find((t) => t.id === on.threadId)!;
    expect(led.hydraEnabled).toBe(true);
    expect(led.hydraPairId).toBe("pair-1");
    expect(led.codexModel).toBe("mock-big");
    expect(led.codexEffort).toBe("high");
    const view = await call(sock, svc.instance, "thread", { id: led.id });
    const viewThread = (view.result as { thread: { hydra: boolean; role: string } }).thread;
    expect(viewThread.hydra).toBe(true);
    expect(viewThread.role).toBe("normal");
    // --hydra on with an explicit model keeps the asked model.
    const withModel = await op({ workspace: "local", hydra: true, model: "asked-model" });
    const led2 = engine.snapshot().threads.find(
      (t) => t.id === withModel.threadId,
    )!;
    expect(led2.hydraEnabled).toBe(true);
    expect(led2.codexModel).toBe("asked-model");
    // No flag and --hydra off both stay off and inherit nothing — the
    // UI's hydraDefaultEnabled/lastHydraPairId are not consulted.
    for (const params of [
      { workspace: "local" },
      { workspace: "local", hydra: false },
    ]) {
      const made = await op(params);
      const plain = engine.snapshot().threads.find(
        (t) => t.id === made.threadId,
      )!;
      expect(plain.hydraEnabled).toBe(false);
      expect(plain.hydraPairId).toBeUndefined();
      const summary = await call(sock, svc.instance, "thread", { id: plain.id });
      expect(
        (summary.result as { thread: { hydra: boolean } }).thread.hydra,
      ).toBe(false);
    }
    // The UI's per-chat default did not move under any of it.
    expect(engine.snapshot().settings.hydraDefaultEnabled).toBe(true);
    expect(engine.snapshot().settings.lastHydraPairId).toBe("pair-ui");
  });

  it("F34: a lead is busy while its heads work; heads refuse writes", async () => {
    // Slow ticks keep the closing turn alive for the interrupt check —
    // the same shape as the interrupt test above.
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 300 }), root, "t");
    const svc = new LocalControlService(engine, root, "dev");
    services.push(svc);
    const sock = join(root, "control", "control.sock");
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    const lead = engine.createThread(null, "lead");
    // A synthetic running head under the lead — no provider involved.
    const head = engine.createThread(null, "head");
    store.update((d) => {
      const h = d.threads.find((t) => t.id === head.id)!;
      h.hydraEnabled = false;
      h.hydraHead = {
        leadId: lead.id,
        headIndex: 0,
        name: "Nyx",
        task: "probe",
        batchId: "batch-1",
        status: "running",
        spawnedAt: Date.now(),
      };
    });
    // Writes aimed AT a head are unsupported on every write command.
    const headSend = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc), threadId: head.id, text: "hello",
    });
    expect((headSend.error as Record<string, unknown>).code).toBe("unsupported");
    expect((headSend.error as Record<string, unknown>).detail).toBe("hydra-head-target");
    const headIntr = await call(sock, svc.instance, "interrupt", {
      ticket: ticket(svc), threadId: head.id, turnId: randomUUID(),
    });
    expect((headIntr.error as Record<string, unknown>).code).toBe("unsupported");
    // The lead reads busy while the head works — in both UI languages.
    const busyEn = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    });
    expect((busyEn.error as Record<string, unknown>).code).toBe("busy");
    engine.setSettings({ language: "zh-Hans" });
    const busyZh = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    });
    expect((busyZh.error as Record<string, unknown>).code).toBe("busy");
    engine.setSettings({ language: "en" });
    // Head summaries stay honest in the list views.
    const normal = await call(sock, svc.instance, "threads", {});
    const normalItems = (
      normal.result as { threads: { items: { id: string }[] } }
    ).threads.items;
    const normalIds = normalItems.map((t) => t.id);
    expect(normalIds).toContain(lead.id);
    expect(normalIds).not.toContain(head.id);
    const heads = await call(sock, svc.instance, "threads", { role: "head" });
    const headItems = (
      heads.result as {
        threads: { items: { id: string; role: string; hydra: boolean }[] };
      }
    ).threads.items;
    expect(headItems.map((t) => t.id)).toEqual([head.id]);
    expect(headItems[0]?.role).toBe("head");
    expect(headItems[0]?.hydra).toBe(false);
    // Finish the head -> still busy while its landing is in flight
    // (frozen: landing counts as working until the report queues).
    store.update((d) => {
      const h = d.threads.find((t) => t.id === head.id)!.hydraHead!;
      h.status = "completed";
      h.landingPending = true;
    });
    const landingBusy = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    });
    expect((landingBusy.error as Record<string, unknown>).code).toBe("busy");
    // Landing done and an empty leftover report queue -> the lead is free.
    (
      engine as unknown as { hydraPendingReports: Map<string, unknown[]> }
    ).hydraPendingReports.set(lead.id, []);
    store.update((d) => {
      d.threads.find((t) => t.id === head.id)!.hydraHead!.landingPending = false;
    });
    const sent = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    });
    const sentOp = (sent.result as Record<string, unknown>).operation as {
      state: string;
      turnId: string;
    };
    expect(sentOp.state).toBe("started");
    const intr = await call(sock, svc.instance, "interrupt", {
      ticket: ticket(svc), threadId: lead.id, turnId: sentOp.turnId,
    });
    expect(
      ((intr.result as Record<string, unknown>).operation as { state: string }).state,
    ).toBe("ended");
    // A report still queued for the lead holds it busy; the empty map
    // entry a finished flush leaves behind does not.
    (
      engine as unknown as { hydraPendingReports: Map<string, unknown[]> }
    ).hydraPendingReports.set(lead.id, [{ headIndex: 0 }]);
    const queuedBusy = await call(sock, svc.instance, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    });
    expect((queuedBusy.error as Record<string, unknown>).code).toBe("busy");
    (
      engine as unknown as { hydraPendingReports: Map<string, unknown[]> }
    ).hydraPendingReports.delete(lead.id);
    store.close();
  });

  it("F34: failure kinds are stable across UI languages", async () => {
    const { engine, svc, sock } = rig();
    enabled(engine);
    svc.refreshListening();
    await wait(30);
    // The wire carries constant codes — the main process never
    // localizes provider/control failures. Same calls under zh-Hans
    // must return the identical kinds as under English.
    engine.setSettings({ hydraEnabled: false });
    const run = () =>
      call(sock, svc.instance, "create", {
        ticket: ticket(svc), workspace: "local", hydra: true,
      });
    const en = (await run()).error as Record<string, unknown>;
    engine.setSettings({ language: "zh-Hans" });
    const zh = (await run()).error as Record<string, unknown>;
    expect(zh.code).toBe(en.code);
    expect(zh.detail).toBe(en.detail);
    const missing = await call(sock, svc.instance, "thread", { id: randomUUID() });
    expect((missing.error as Record<string, unknown>).code).toBe("notFound");
    engine.setSettings({ language: "en" });
  });
  });
});
