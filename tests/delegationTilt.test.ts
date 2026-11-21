// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-12 delegation levels, structured head reports and the rework
// send-back: the frozen tilt rule rides every lead turn, the three
// report lines parse only when all three are present, and a
// `"continue"` entry reworks in the named head's own session.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import {
  delegationFromEntry,
  hydraDelegationRequest,
  hydraTiltRule,
  parseHydraReportNotes,
  reportMessage,
} from "../src/shared/hydraDelegation";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-tilt-"));
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
  engine.snapshot().threads.find((t) => t.id === id)!;
const heads = (engine: Engine, leadId: string) =>
  engine
    .snapshot()
    .threads.filter((t) => t.hydraHead?.leadId === leadId)
    .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt);

describe("P1-12 delegation levels (frozen HydraTilt)", () => {
  it("each tilt carries its frozen rule", () => {
    expect(hydraTiltRule("restrained")).toContain("crowd your context");
    expect(hydraTiltRule("active")).toContain("more than a few tool calls");
    expect(hydraTiltRule("aggressive")).toContain("nearly all work");
  });

  it("the delegation request names the level and its short rule", () => {
    expect(hydraDelegationRequest("restrained")).toContain("enabled, restrained");
    expect(hydraDelegationRequest("active")).toContain("enabled, proactive");
    expect(hydraDelegationRequest("aggressive")).toContain("enabled, aggressive");
    // Absent setting reads as the frozen default.
    expect(hydraDelegationRequest()).toContain("enabled, proactive");
  });
});

describe("P1-12 structured head reports (frozen HydraReportNotes)", () => {
  it("parses all three lines, case-insensitive with bullets and bold", () => {
    const notes = parseHydraReportNotes(
      "Did the task.\n\n- **deviations:** none\n* Unfinished: tests still red\nUncertain: whether the cache survives restart",
    );
    expect(notes).toEqual({
      unfinished: "tests still red",
      uncertain: "whether the cache survives restart",
    });
  });

  it("returns undefined unless all three labels are present", () => {
    expect(
      parseHydraReportNotes("Deviations: none\nUnfinished: none"),
    ).toBeUndefined();
    expect(parseHydraReportNotes("plain prose report")).toBeUndefined();
  });

  it("a value runs until the next label or the end", () => {
    const notes = parseHydraReportNotes(
      "Deviations: renamed the helper\nand moved it\nUnfinished: none\nUncertain: n/a",
    );
    expect(notes?.deviations).toBe("renamed the helper\nand moved it");
    expect(notes?.unfinished).toBeUndefined();
    expect(notes?.uncertain).toBeUndefined();
  });

  it("the report message surfaces the structured flags", () => {
    const msg = reportMessage([
      {
        headIndex: 0,
        task: "do it",
        status: "completed",
        text: "done",
        notes: { unfinished: "edge case open" },
      },
    ]);
    expect(msg).toContain("Unfinished: edge case open");
  });
});

describe("P1-12 rework send-back (frozen continue entry)", () => {
  it("the entry parser keeps the continue name", () => {
    const d = delegationFromEntry({
      task: "Rework",
      prompt: "tighten it",
      continue: "Hank",
    });
    expect(d?.continue).toBe("Hank");
    expect(delegationFromEntry({ task: "x", prompt: "y" })?.continue).toBeUndefined();
  });

  it("a continue reworks in the named head's own session — no new head", { timeout: 20_000 }, async () => {
    const { engine } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "split this up [mock:hydra]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    await waitFor(() =>
      heads(engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    // The batch report turn must fully land before the next send.
    await waitFor(
      () =>
        !["running", "waiting-approval"].includes(
          thread(engine, lead.id).turn?.status ?? "",
        ),
    );
    const hank = heads(engine, lead.id).find(
      (h) => h.hydraHead!.name === "Hank",
    )!;
    const before = hank.messages.length;

    // The lead sends Hank's part back for rework in its own session.
    engine.sendTurn(lead.id, "rework it [mock:hydra-continue]");
    await waitFor(() => thread(engine, hank.id).messages.length > before);
    // No third head spawned — Hank itself runs again on the instruction.
    expect(heads(engine, lead.id).length).toBe(2);
    await waitFor(
      () => thread(engine, hank.id).hydraHead!.status === "completed",
    );
    const cur = thread(engine, hank.id);
    expect(
      cur.messages.some(
        (m) =>
          m.role === "user" && m.content.includes("tighten the intro"),
      ),
    ).toBe(true);
  });

  it("an unknown continue name falls back to a head wearing it", { timeout: 20_000 }, async () => {
    const { engine } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(lead.id, "first job [mock:hydra-continue]");
    await waitFor(() => heads(engine, lead.id).length === 1);
    expect(heads(engine, lead.id)[0]!.hydraHead!.name).toBe("Hank");
    await waitFor(
      () => heads(engine, lead.id)[0]!.hydraHead!.status === "completed",
    );
  });
});
