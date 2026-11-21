// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-12 delegation levels, structured head reports and the rework
// send-back: the frozen tilt rule rides every lead turn, the three
// report lines parse only when all three are present, and a
// `"continue"` entry reworks in the named head's own session.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { parseHydraReportDigest } from "../src/shared/hydraReportDigest";

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

  it("settings:set persists the delegation level", () => {
    const { engine, store } = make();
    engine.setSettings({ hydraTilt: "aggressive" });
    expect(store.state.settings.hydraTilt).toBe("aggressive");
    engine.setSettings({ hydraTilt: "restrained" });
    expect(store.state.settings.hydraTilt).toBe("restrained");
  });

  it("a store carrying the removed hydraReviewHeads key still opens", () => {
    const root = tmp();
    const ts = 1_000_000;
    // The legacy monolith shape a pre-removal store presents: the
    // dropped key is tolerated on load, never a corruption verdict.
    writeFileSync(
      join(root, "store.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ id: "p1", name: "p1", createdAt: ts, expanded: true }],
        threads: [
          {
            id: "t1",
            projectId: "p1",
            title: "chat",
            createdAt: ts,
            updatedAt: ts,
            sessionGrants: [],
            messages: [],
            turn: null,
          },
        ],
        settings: {
          theme: "dark",
          language: "en",
          alwaysAllow: [],
          hydraReviewHeads: true,
        },
        ui: { selectedThreadId: "t1" },
      }),
    );
    const store = new Store(root);
    expect(() => store.open()).not.toThrow();
    expect(store.state.threads).toHaveLength(1);
    store.close();
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
    expect(msg).toContain("Flags:\nUnfinished: edge case open");
  });

  it("a completed report without notes is flagged not followed", () => {
    const msg = reportMessage([
      {
        headIndex: 0,
        task: "do it",
        status: "completed",
        text: "done",
        expectsNotes: true,
      },
    ]);
    expect(msg).toContain("Flags:\nReport format not followed.");
    // A stopped head never owed the three lines.
    const stopped = reportMessage([
      { headIndex: 0, task: "t", status: "stopped", text: "", expectsNotes: true },
    ]);
    expect(stopped).toContain("Flags:\nnone");
  });

  it("the digest reads the Flags block and strips the trailing lines", () => {
    const msg = reportMessage([
      {
        headIndex: 0,
        task: "do it",
        status: "completed",
        text: "All set.\n\nDeviations: renamed the helper\nUnfinished: none\nUncertain: n/a",
        notes: { deviations: "renamed the helper" },
      },
      {
        headIndex: 1,
        task: "other",
        status: "completed",
        text: "ok",
        expectsNotes: true,
      },
    ]);
    const digest = parseHydraReportDigest(msg);
    expect(digest.heads).toHaveLength(2);
    expect(digest.heads[0]!.flags.deviations).toBe("renamed the helper");
    expect(digest.heads[0]!.reportFormatMissing).toBe(false);
    // The raw three-line tail leaves the card body — the flag row shows it.
    expect(digest.heads[0]!.body).toBe("All set.");
    expect(digest.heads[1]!.reportFormatMissing).toBe(true);
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
    // The latch arms the lead's report-turn reply with a continue entry.
    engine.sendTurn(lead.id, "split this up [mock:hydra] [mock:hydra-continue]");
    await waitFor(() => heads(engine, lead.id).length === 2);
    await waitFor(() =>
      heads(engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    const hank = heads(engine, lead.id).find(
      (h) => h.hydraHead!.name === "Hank",
    )!;
    const before = hank.messages.length;

    // The lead's report-reply sends Hank's part back for rework in its
    // own session — no third head spawns.
    await waitFor(() => thread(engine, hank.id).messages.length > before);
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

  it("an unknown continue name is refused (frozen v2ContinueRefusal)", { timeout: 20_000 }, async () => {
    const { engine } = make();
    const lead = engine.createThread(null, "lead");
    engine.sendTurn(
      lead.id,
      "first job [mock:hydra] [mock:hydra-continue-ghost]",
    );
    await waitFor(() =>
      heads(engine, lead.id).every((h) => h.hydraHead!.status === "completed"),
    );
    // "Nova" never spawned — the lead hears the refusal, no head runs.
    await waitFor(() =>
      thread(engine, lead.id).messages.some(
        (m) =>
          m.role === "user" &&
          m.content.includes("Hydra did not send") &&
          m.content.includes("Nova was not sent back: no head of that name"),
      ),
    );
    expect(heads(engine, lead.id).length).toBe(2);
  });
});
