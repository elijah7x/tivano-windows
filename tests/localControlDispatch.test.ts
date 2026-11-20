// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-16.
// F34 local control — the same ops as the socket suite but driven
// through LocalControlService.dispatch directly: deterministic in
// sandboxes that deny filesystem/named-pipe listeners (the socket layer
// itself is covered by tests/localControl.test.ts where binding works).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { LocalControlService } from "../src/main/localControl";

const dirs: string[] = [];
const services: LocalControlService[] = [];
function rig(tickMs = 1) {
  const root = mkdtempSync(join(tmpdir(), "tivano-lcd-"));
  dirs.push(root);
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs }), root, "t");
  const svc = new LocalControlService(engine, root, "dev");
  services.push(svc);
  return { engine, store, svc };
}
afterEach(() => {
  for (const s of services) s.dispose();
  services.length = 0;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const call = (svc: LocalControlService, method: string, params: Record<string, unknown>) =>
  (
    svc as unknown as {
      dispatch: (
        m: string,
        p: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    }
  ).dispatch(method, params);
const ticket = (svc: LocalControlService) =>
  `${svc.instance}/${randomUUID()}/${Date.now()}`;
const err = async (p: Promise<unknown>) =>
  p.then(
    () => ({ code: "<no error>" }),
    (e) => ({ code: (e as { code?: string }).code, detail: (e as { detail?: string }).detail }),
  );

describe("local control dispatch (F34)", () => {
  it("create --hydra on needs the app-wide switch and a saved pair", async () => {
    const { engine, svc } = rig();
    engine.setSettings({ alphaEnabled: true, externalControlEnabled: true });
    await expect(call(svc, "create", { ticket: ticket(svc), workspace: "local", hydra: "yes" }))
      .rejects.toMatchObject({ code: "invalidRequest" });
    engine.setSettings({ hydraEnabled: false });
    await expect(call(svc, "create", { ticket: ticket(svc), workspace: "local", hydra: true }))
      .rejects.toMatchObject({ code: "unsupported", detail: "hydra_disabled" });
    engine.setSettings({ hydraEnabled: true, hydraPairs: [] });
    await expect(call(svc, "create", { ticket: ticket(svc), workspace: "local", hydra: true }))
      .rejects.toMatchObject({ code: "unsupported", detail: "hydra_pair_missing" });
    engine.setSettings({
      hydraPairs: [{ id: "foreign", provider: "claude", headProfiles: [] }],
    });
    await expect(call(svc, "create", { ticket: ticket(svc), workspace: "local", hydra: true }))
      .rejects.toMatchObject({ code: "unsupported", detail: "hydra_pair_missing" });
  });

  it("--hydra on binds the saved pair; absent or off never inherits", async () => {
    const { engine, svc } = rig();
    engine.setSettings({
      alphaEnabled: true,
      externalControlEnabled: true,
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
    const on = (await call(svc, "create", {
      ticket: ticket(svc), workspace: "local", hydra: true,
    })) as { operation: { state: string; threadId: string } };
    expect(on.operation.state).toBe("ready");
    const led = engine.snapshot().threads.find((t) => t.id === on.operation.threadId)!;
    expect(led.hydraEnabled).toBe(true);
    expect(led.hydraPairId).toBe("pair-1");
    expect(led.codexModel).toBe("mock-big");
    expect(led.codexEffort).toBe("high");
    const view = (await call(svc, "thread", { id: led.id })) as {
      thread: { hydra: boolean; role: string };
    };
    expect(view.thread.hydra).toBe(true);
    expect(view.thread.role).toBe("normal");
    const withModel = (await call(svc, "create", {
      ticket: ticket(svc), workspace: "local", hydra: true, model: "asked-model",
    })) as { operation: { threadId: string } };
    const led2 = engine.snapshot().threads.find(
      (t) => t.id === withModel.operation.threadId,
    )!;
    expect(led2.hydraEnabled).toBe(true);
    expect(led2.codexModel).toBe("asked-model");
    for (const params of [
      { workspace: "local" },
      { workspace: "local", hydra: false },
    ]) {
      const made = (await call(svc, "create", { ticket: ticket(svc), ...params })) as {
        operation: { threadId: string };
      };
      const plain = engine.snapshot().threads.find(
        (t) => t.id === made.operation.threadId,
      )!;
      expect(plain.hydraEnabled).toBe(false);
      expect(plain.hydraPairId).toBeUndefined();
      const summary = (await call(svc, "thread", { id: plain.id })) as {
        thread: { hydra: boolean };
      };
      expect(summary.thread.hydra).toBe(false);
    }
    expect(engine.snapshot().settings.hydraDefaultEnabled).toBe(true);
    expect(engine.snapshot().settings.lastHydraPairId).toBe("pair-ui");
  });

  it("a lead is busy while its heads work; heads refuse writes", async () => {
    const { engine, store, svc } = rig(300);
    engine.setSettings({ alphaEnabled: true, externalControlEnabled: true });
    const lead = engine.createThread(null, "lead");
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
    await expect(call(svc, "submit", {
      ticket: ticket(svc), threadId: head.id, text: "hello",
    })).rejects.toMatchObject({ code: "unsupported", detail: "hydra-head-target" });
    await expect(call(svc, "interrupt", {
      ticket: ticket(svc), threadId: head.id, turnId: randomUUID(),
    })).rejects.toMatchObject({ code: "unsupported" });
    await expect(call(svc, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    })).rejects.toMatchObject({ code: "busy" });
    engine.setSettings({ language: "zh-Hans" });
    await expect(call(svc, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    })).rejects.toMatchObject({ code: "busy" });
    engine.setSettings({ language: "en" });
    const normal = (await call(svc, "threads", {})) as {
      threads: { items: { id: string }[] };
    };
    const normalIds = normal.threads.items.map((t) => t.id);
    expect(normalIds).toContain(lead.id);
    expect(normalIds).not.toContain(head.id);
    const heads = (await call(svc, "threads", { role: "head" })) as {
      threads: { items: { id: string; role: string; hydra: boolean }[] };
    };
    expect(heads.threads.items.map((t) => t.id)).toEqual([head.id]);
    expect(heads.threads.items[0]?.role).toBe("head");
    expect(heads.threads.items[0]?.hydra).toBe(false);
    store.update((d) => {
      d.threads.find((t) => t.id === head.id)!.hydraHead!.status = "completed";
    });
    const sent = (await call(svc, "submit", {
      ticket: ticket(svc), threadId: lead.id, text: "more work",
    })) as { operation: { state: string; turnId: string } };
    expect(sent.operation.state).toBe("started");
    const intr = (await call(svc, "interrupt", {
      ticket: ticket(svc), threadId: lead.id, turnId: sent.operation.turnId,
    })) as { operation: { state: string } };
    expect(intr.operation.state).toBe("ended");
    store.close();
  });

  it("failure kinds are stable across UI languages", async () => {
    const { engine, svc } = rig();
    engine.setSettings({
      alphaEnabled: true, externalControlEnabled: true, hydraEnabled: false,
    });
    const run = () => err(call(svc, "create", {
      ticket: ticket(svc), workspace: "local", hydra: true,
    }));
    const en = await run();
    engine.setSettings({ language: "zh-Hans" });
    const zh = await run();
    expect(zh).toEqual(en);
    await expect(call(svc, "thread", { id: randomUUID() }))
      .rejects.toMatchObject({ code: "notFound" });
    engine.setSettings({ language: "en" });
  });
});
