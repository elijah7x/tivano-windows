// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F25 helper chat (frozen spawnSubagent/closeSubagent): a merge/PR link
// hands its brief to the parent's helper — one helper per parent, a
// busy helper queues the new brief, closing the panel interrupts a
// running turn and drops the helper into the sidebar; the record never
// moves or deletes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import { parseMergeRequestLink } from "../src/shared/mergeRequestLink";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-helper-"));
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

function make(tickMs = 1) {
  const root = tmp();
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs }), root, "0.0.0-test");
  return { store, engine, root };
}

const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id);
const turn = (engine: Engine, id: string) => thread(engine, id)?.turn;

const GITHUB_BRIEF = parseMergeRequestLink("https://github.com/o/r/pull/95")!;

describe("F25 helper chat (frozen spawnSubagent/closeSubagent)", () => {
  it("spawn creates a panel-bound helper inheriting the parent's choices", async () => {
    const { engine } = make();
    const parent = engine.createThread(null, "parent");
    const helper = engine.spawnHelper(parent.id, GITHUB_BRIEF.title, GITHUB_BRIEF.prompt);

    const h = thread(engine, helper.id)!;
    expect(h.parentThreadId).toBe(parent.id);
    expect(h.isInPanel).toBe(true);
    expect(h.title).toBe("Merge #95");
    // Frozen: the parent keeps the selection — the helper opens in a
    // panel, it never becomes the selected chat.
    expect(engine.snapshot().selectedThreadId).toBe(parent.id);
    await waitFor(() => turn(engine, helper.id)?.status === "done");
    // The brief went out as the helper's first user message.
    expect(h.id).toBe(helper.id);
    const msgs = thread(engine, helper.id)!.messages;
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe(GITHUB_BRIEF.prompt);
  });

  it("a second merge while the helper waits queues the brief (frozen enqueueFollowUp)", async () => {
    const { engine } = make();
    const parent = engine.createThread(null, "parent");
    const helper = engine.spawnHelper(
      parent.id,
      "Merge #95",
      "merge it [mock:approval]",
    );
    await waitFor(() => turn(engine, helper.id)?.status === "waiting-approval");

    const again = engine.spawnHelper(parent.id, "Merge #96", "merge the next one");
    expect(again.id).toBe(helper.id); // one helper per parent
    await waitFor(() => (thread(engine, helper.id)!.followUps?.length ?? 0) === 1);
    expect(thread(engine, helper.id)!.followUps![0]!.text).toBe("merge the next one");
  });

  it("an idle existing helper receives the brief as a fresh turn", async () => {
    const { engine } = make();
    const parent = engine.createThread(null, "parent");
    const helper = engine.spawnHelper(parent.id, "Merge #95", "first brief");
    await waitFor(() => turn(engine, helper.id)?.status === "done");

    const again = engine.spawnHelper(parent.id, "Merge #96", "second brief");
    expect(again.id).toBe(helper.id);
    await waitFor(
      () =>
        turn(engine, helper.id)?.status === "done" &&
        thread(engine, helper.id)!.messages.filter((m) => m.role === "user").length === 2,
    );
    const users = thread(engine, helper.id)!.messages.filter((m) => m.role === "user");
    expect(users[1]!.content).toBe("second brief");
  });

  it("close interrupts a running turn and drops the helper to the sidebar", async () => {
    const { engine } = make();
    const parent = engine.createThread(null, "parent");
    const helper = engine.spawnHelper(
      parent.id,
      "Merge #95",
      "merge it [mock:approval]",
    );
    await waitFor(() => turn(engine, helper.id)?.status === "waiting-approval");

    engine.closeHelper(helper.id);
    const h = thread(engine, helper.id)!;
    expect(h.isInPanel).toBe(false);
    // Frozen: the running turn is interrupted — not completed.
    await waitFor(() =>
      ["interrupted", "stopped", "cancelled"].includes(turn(engine, helper.id)?.status ?? ""),
    );

    // The binding survives closing — a later merge hands its brief to
    // the SAME helper (now sidebar-resident, not reopened).
    const again = engine.spawnHelper(parent.id, "Merge #96", "next brief");
    expect(again.id).toBe(helper.id);
    expect(thread(engine, helper.id)!.isInPanel).toBe(false);
    await waitFor(() => turn(engine, helper.id)?.status === "done");
  });

  it("spawn rejects an empty brief; helper of an unknown parent fails", () => {
    const { engine } = make();
    const parent = engine.createThread(null, "parent");
    expect(() => engine.spawnHelper(parent.id, "t", "   ")).toThrow(/empty helper prompt/);
    expect(() => engine.spawnHelper("missing", "t", "p")).toThrow(/unknown thread/);
  });
});

describe("F25 floating panel size (frozen AppSettings.panelSize)", () => {
  it("helperPanelSize persists through a restart, clamped to sane bounds", () => {
    const { store, engine, root } = make();
    engine.setSettings({ helperPanelSize: { width: 480.6, height: 424.2 } });
    expect(engine.snapshot().settings.helperPanelSize).toEqual({
      width: 481,
      height: 424,
    });
    // Out-of-range drags clamp instead of corrupting the panel.
    engine.setSettings({ helperPanelSize: { width: 50, height: 99999 } });
    expect(engine.snapshot().settings.helperPanelSize).toEqual({
      width: 200,
      height: 4000,
    });
    engine.setSettings({ helperPanelSize: { width: 480, height: 424 } });
    store.close();

    const store2 = new Store(root);
    store2.open();
    const e2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    expect(e2.snapshot().settings.helperPanelSize).toEqual({
      width: 480,
      height: 424,
    });
    store2.close();
  });
});
