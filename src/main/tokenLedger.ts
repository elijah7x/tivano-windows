// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F19 token activity ledger — bounded port of frozen TokenSpendTracker +
// TokenLedger @ d31e093b. Live spend only: daily totals recorded as
// provider sessions report cumulative counters, persisted under the data
// root. The frozen Codex-rollout disk-history scan and the v1 mixed-
// provider migration have no counterpart here — no rollout files exist
// under this port's control — so `uncertainTokensThisYear` is always 0
// and the history feed is honestly absent, not faked.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Local-calendar day key, frozen `TokenLedger.dayKey` ("yyyy-MM-dd"). */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Frozen TokenSpendTracker verbatim: converts a session's cumulative
 * token counter into spend. `spend(total, before)` returns the delta
 * since the previous event; a drop (compaction, a fresh session on a
 * reused thread) reseeds the baseline without recording. `before` is
 * the total the counter had before this session, which is not new
 * spend. `seedBaseline` leaves a resumed session's inherited history
 * uncounted instead of charging or zeroing it.
 */
export class TokenSpendTracker {
  private lastTotal = 0;
  private seededFlag = false;

  get seeded(): boolean {
    return this.seededFlag;
  }

  spend(total: number, before = 0): number {
    if (!this.seededFlag) {
      this.seededFlag = true;
      this.lastTotal = Math.max(0, Math.min(total, before));
    }
    const delta = Math.max(0, total - this.lastTotal);
    this.lastTotal = Math.max(0, total);
    return delta;
  }

  seedBaseline(total: number): void {
    if (this.seededFlag) return;
    this.seededFlag = true;
    this.lastTotal = Math.max(0, total);
  }
}

interface LedgerFile {
  v: 1;
  liveDaily: Record<string, number>;
  /** Live spend recorded per Codex rollout identity — kept for the same
   *  reconciliation the frozen history scan performs; retained in the
   *  format so a future scan can subtract it exactly like upstream. */
  codexLive: Record<string, number>;
}

const FILE_NAME = "token-activity.json";
const FLUSH_MS = 120;

/** Persisted daily AI-token spend across providers, feeding the Token
 *  activity heatmap. Mirrors the frozen ledger's live feed: one file,
 *  atomic replace, a corrupt file is preserved aside and starts empty. */
export class TokenLedger {
  private readonly file: string;
  private daily: Record<string, number> = {};
  private codexLive: Record<string, number> = {};
  private flushTimer: NodeJS.Timeout | null = null;
  /** Set when the loaded file was preserved aside (honest recovery note). */
  recoveryNote: string | null = null;

  constructor(private readonly root: string) {
    this.file = join(root, FILE_NAME);
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LedgerFile>;
      if (raw?.v !== 1 || typeof raw.liveDaily !== "object" || raw.liveDaily === null)
        throw new Error("bad shape");
      this.daily = {};
      for (const [k, v] of Object.entries(raw.liveDaily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(v) && (v as number) > 0)
          this.daily[k] = Math.floor(v as number);
      }
      if (typeof raw.codexLive === "object" && raw.codexLive !== null) {
        for (const [k, v] of Object.entries(raw.codexLive)) {
          if (Number.isFinite(v) && (v as number) > 0)
            this.codexLive[k] = Math.floor(v as number);
        }
      }
    } catch {
      const aside = join(
        root,
        `token-activity.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      try {
        renameSync(this.file, aside);
        this.recoveryNote = `corrupt token-activity preserved aside as ${aside}`;
      } catch (e) {
        this.recoveryNote =
          `corrupt token-activity could not be preserved aside (${(e as Error).message}); ` +
          "starting empty";
      }
      this.daily = {};
      this.codexLive = {};
    }
  }

  /** Merged totals keyed by local day — the grid's only input. */
  dailyTotals(): Record<string, number> {
    return { ...this.daily };
  }

  /** Live spend delta for a generic provider session. */
  record(spend: number, date: Date = new Date()): void {
    this.add(spend, null, date);
  }

  /** Live spend attributed to a Codex rollout identity (frozen
   *  record(codexSpend:rolloutID:) — the provenance a future history
   *  scan subtracts from that file's own growth). */
  recordCodex(spend: number, rolloutId: string, date: Date = new Date()): void {
    if (!rolloutId) {
      this.add(spend, null, date);
      return;
    }
    this.add(spend, rolloutId.toLowerCase(), date);
  }

  private add(spend: number, rollout: string | null, date: Date): void {
    const n = Math.floor(spend);
    if (!Number.isFinite(n) || n <= 0) return;
    const key = dayKey(date);
    this.daily[key] = (this.daily[key] ?? 0) + n;
    if (rollout) this.codexLive[rollout] = (this.codexLive[rollout] ?? 0) + n;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Synchronous atomic write — tmp + rename, like the store's flush. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(
      { v: 1, liveDaily: this.daily, codexLive: this.codexLive } satisfies LedgerFile,
      null,
      2,
    );
    const tmp = join(this.root, `.token-activity-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }
}
