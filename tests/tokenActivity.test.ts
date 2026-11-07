// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F19 token activity: frozen TokenSpendTracker delta rules, the year
// grid builder (Sunday-first columns, three modes, month ticks), the
// persisted ledger (record/reload/corrupt-aside), and engine wiring —
// a synthetic turn's cumulative counter lands as daily spend exactly
// once, and a restart keeps the ledger without re-billing history.

import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { TokenLedger, TokenSpendTracker, dayKey } from "../src/main/tokenLedger";
import {
  ACTIVITY_ROWS,
  buildActivityGrid,
} from "../src/shared/activityGrid";

const dirs: string[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-ta-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("TokenSpendTracker (frozen rules)", () => {
  it("first call counts the whole counter as spend when before=0", () => {
    const tr = new TokenSpendTracker();
    expect(tr.spend(5000)).toBe(5000);
    expect(tr.spend(9000)).toBe(4000);
    expect(tr.spend(9000)).toBe(0);
  });

  it("before excludes the pre-session counter", () => {
    const tr = new TokenSpendTracker();
    expect(tr.spend(9000, 8000)).toBe(1000);
    expect(tr.spend(12000)).toBe(3000);
  });

  it("a counter drop reseeds without billing the drop", () => {
    const tr = new TokenSpendTracker();
    tr.spend(9000);
    expect(tr.spend(1500)).toBe(0); // compaction/reset — 1500 is the new baseline
    expect(tr.spend(3000)).toBe(1500); // growth after it counts
  });

  it("seedBaseline leaves inherited history uncounted", () => {
    const tr = new TokenSpendTracker();
    tr.seedBaseline(9000);
    expect(tr.spend(9500)).toBe(500);
    // Idempotent — a second seed call never re-baselines mid-session.
    tr.seedBaseline(100);
    expect(tr.spend(9800)).toBe(300);
  });
});

describe("buildActivityGrid (frozen shape)", () => {
  const now = new Date(2026, 5, 15); // mid-year Monday

  it("Sunday-first columns cover Jan 1 through Dec 31", () => {
    const g = buildActivityGrid({}, "daily", now);
    const jan1 = new Date(2026, 0, 1);
    const col0 = g.columns[0]!;
    // Jan 1 2026 is a Thursday → row index = its weekday (Sunday-first).
    expect(col0[jan1.getDay()]).toBe(jan1.getTime());
    // Everything before Jan 1 in column 0 is an out-of-year null.
    expect(col0.slice(0, jan1.getDay()).every((d) => d === null)).toBe(true);
    // Dec 31 is a Thursday; the last column keeps all 7 rows and the
    // trailing days wrap into 2027's slots as null.
    const flat = g.columns.flat();
    expect(flat).toContain(new Date(2026, 11, 31).getTime());
    expect(g.columns.every((c) => c.length === ACTIVITY_ROWS)).toBe(true);
    // Tomorrow starts the day after `now` — future cells are flaggable.
    expect(g.tomorrow).toBe(new Date(2026, 5, 16).getTime());
  });

  it("daily mode colors each day by its own total; weekly shares the column; cumulative accumulates", () => {
    const key = (d: Date) => dayKey(d);
    const d1 = new Date(2026, 0, 5); // Monday of week column 1
    const d2 = new Date(2026, 0, 6); // Tuesday
    const daily = { [key(d1)]: 100, [key(d2)]: 200 };
    const g = buildActivityGrid(daily, "daily", now);
    const col = g.columns.findIndex((c) => c.includes(d1.getTime()));
    expect(col).toBeGreaterThanOrEqual(0);
    expect(g.values[col]![d1.getDay()]).toBe(100);
    expect(g.values[col]![d2.getDay()]).toBe(200);
    expect(g.maxValue).toBe(200);

    const w = buildActivityGrid(daily, "weekly", now);
    // Every in-year cell of the column takes the week's 300.
    expect(w.values[col]![d1.getDay()]).toBe(300);
    expect(w.values[col]![d2.getDay()]).toBe(300);
    expect(w.maxValue).toBe(300);

    const c = buildActivityGrid(daily, "cumulative", now);
    expect(c.values[col]![d1.getDay()]).toBe(100);
    expect(c.values[col]![d2.getDay()]).toBe(300);
    expect(c.maxValue).toBe(300);
  });

  it("places one tick per month at the column holding its first day", () => {
    const g = buildActivityGrid({}, "daily", now);
    expect(g.monthTicks).toHaveLength(12);
    expect(g.monthTicks.map((t) => t.label)).toEqual([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);
    for (let m = 0; m < 12; m++) {
      const first = new Date(2026, m, 1);
      expect(g.columns[g.monthTicks[m]!.column]).toContain(first.getTime());
    }
    // Strictly increasing columns.
    for (let i = 1; i < 12; i++)
      expect(g.monthTicks[i]!.column).toBeGreaterThan(g.monthTicks[i - 1]!.column);
  });
});

describe("TokenLedger persistence", () => {
  it("records spend per local day and survives a reload", () => {
    const r = root();
    const l = new TokenLedger(r);
    l.record(500, new Date(2026, 5, 15));
    l.record(250, new Date(2026, 5, 15));
    l.recordCodex(100, "ROLLOUT-X", new Date(2026, 5, 16));
    l.flush();
    const again = new TokenLedger(r);
    expect(again.dailyTotals()).toEqual({
      "2026-06-15": 750,
      "2026-06-16": 100,
    });
  });

  it("ignores non-positive spend and preserves a corrupt file aside", () => {
    const r = root();
    const l = new TokenLedger(r);
    l.record(0);
    l.record(-10);
    l.flush();
    expect(l.dailyTotals()).toEqual({});
    writeFileSync(join(r, "token-activity.json"), "{not json");
    const recovered = new TokenLedger(r);
    expect(recovered.dailyTotals()).toEqual({});
    expect(recovered.recoveryNote).toContain("preserved aside");
    expect(
      readdirSync(r).some((f) => f.startsWith("token-activity.corrupt-")),
    ).toBe(true);
  });
});

describe("engine spend wiring", () => {
  it("a synthetic turn's cumulative counter lands as daily spend exactly once", async () => {
    const r = root();
    const store = new Store(r);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), r, "0.0.0-test");
    // F22: the Hydra lead policy rides the wire prompt while Hydra is
    // on — this deterministic spend formula keys off the bare prompt.
    engine.setSettings({ hydraEnabled: false });
    const t = engine.createThread(null, "spend");
    engine.sendTurn(t.id, "count my synthetic tokens");
    await vi.waitFor(() => {
      const th = engine.snapshot().threads.find((x) => x.id === t.id)!;
      if (th.turn?.status !== "done") throw new Error("pending");
    });
    const today = dayKey(new Date());
    const first = engine.snapshot().tokenActivity[today]!;
    expect(first).toBeGreaterThan(0);
    // A second turn grows the same session counter — only its own delta
    // adds. "again" is 5 chars → the mock's deterministic 1200+5*7.
    engine.sendTurn(t.id, "again");
    await vi.waitFor(() => {
      const th = engine.snapshot().threads.find((x) => x.id === t.id)!;
      if (th.turn?.status !== "done") throw new Error("pending");
    });
    expect(engine.snapshot().tokenActivity[today]!).toBe(first + 1235);
    engine.shutdown();
    store.close();
  });

  it("the ledger survives a restart and a resumed counter is not re-billed", async () => {
    const r = root();
    const store = new Store(r);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), r, "0.0.0-test");
    const t = engine.createThread(null, "persist");
    engine.sendTurn(t.id, "hello");
    await vi.waitFor(() => {
      if (engine.snapshot().threads.find((x) => x.id === t.id)!.turn?.status !== "done")
        throw new Error("pending");
    });
    const today = dayKey(new Date());
    const recorded = engine.snapshot().tokenActivity[today]!;
    expect(recorded).toBeGreaterThan(0);
    engine.shutdown();
    store.close();

    const store2 = new Store(r);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), r, "0.0.0-test");
    // The persisted map comes straight back — nothing needed a replay.
    expect(engine2.snapshot().tokenActivity[today]).toBe(recorded);
    engine2.shutdown();
    store2.close();
  });
});
