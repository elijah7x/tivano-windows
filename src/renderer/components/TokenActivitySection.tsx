// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F19 Token activity — bounded port of frozen TokenActivitySection:
// mode chips (Daily/Weekly/Cumulative), a Sunday-first year heatmap
// painted in the theme accent's five-step ladder, month labels at each
// month's first column and a Less→More legend with the year's total.

import { useMemo, useState } from "react";
import {
  ACTIVITY_MODES,
  ACTIVITY_ROWS,
  buildActivityGrid,
  type TokenActivityMode,
} from "../../shared/activityGrid";
import { useT } from "../locale";

/** Frozen TokenActivityStyle ladder — accent opacity steps by fraction
 *  of the max cell, with quiet and future overlays. */
function cellBackground(value: number, maxValue: number, future: boolean): string {
  if (future) return "var(--ta-future)";
  if (value <= 0 || maxValue <= 0) return "var(--ta-quiet)";
  const f = value / maxValue;
  if (f < 0.25) return "color-mix(in srgb, var(--accent) 32%, transparent)";
  if (f < 0.5) return "color-mix(in srgb, var(--accent) 55%, transparent)";
  if (f < 0.75) return "color-mix(in srgb, var(--accent) 80%, transparent)";
  return "var(--accent)";
}

const LADDER = [0, 1, 3, 5, 7] as const;
const LADDER_MAX = 8;
/** Frozen minLabelAdvance — a month label closer than this to the last
 *  shown label is dropped instead of overlapping it. */
const MIN_LABEL_ADVANCE_PX = 30;

const MODE_TITLE: Record<TokenActivityMode, string> = {
  daily: "Daily",
  weekly: "Weekly",
  cumulative: "Cumulative",
};
const MODE_HELP: Record<TokenActivityMode, string> = {
  daily: "Each day on its own, against the busiest day of the year",
  weekly: "Each week as one shade, against the busiest week",
  cumulative: "The running total, so the year fills as it goes",
};

/** Compact count — frozen UsagePanel.tokens: 1.2k/1.2M/1.2B, no ".0". */
function fmtTokens(count: number): string {
  const compact = (v: number, suffix: string) => {
    const text = v.toFixed(1);
    return (text.endsWith(".0") ? text.slice(0, -2) : text) + suffix;
  };
  if (count >= 1_000_000_000) return compact(count / 1_000_000_000, "B");
  if (count >= 1_000_000) return compact(count / 1_000_000, "M");
  if (count >= 1_000) return compact(count / 1_000, "k");
  return String(count);
}

export function TokenActivitySection(props: {
  daily: Record<string, number>;
}): React.JSX.Element {
  const t = useT();
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const grid = useMemo(
    () => buildActivityGrid(props.daily, mode),
    [props.daily, mode],
  );
  const total = useMemo(
    () => Object.values(props.daily).reduce((a, b) => a + b, 0),
    [props.daily],
  );

  // Approximate column stride for the frozen minLabelAdvance gate — the
  // labels position by percent so the gate only decides which months
  // get dropped on narrow widths; cells never depend on it.
  const STRIDE_PX = 14;
  const ticks = useMemo(() => {
    const placed: typeof grid.monthTicks = [];
    let lastX = -MIN_LABEL_ADVANCE_PX;
    for (const tick of grid.monthTicks) {
      const x = tick.column * STRIDE_PX;
      if (x - lastX >= MIN_LABEL_ADVANCE_PX) {
        placed.push(tick);
        lastX = x;
      }
    }
    return placed;
  }, [grid]);

  const summary = t("%@ tokens", fmtTokens(total));

  return (
    <section className="ta" aria-label={t("Token activity")}>
      <div className="ta-head">
        <h3 className="ta-title">{t("Token activity")}</h3>
        <div className="ta-modes" role="radiogroup" aria-label={t("Token activity")}>
          {ACTIVITY_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`ta-chip${mode === m ? " active" : ""}`}
              title={t(MODE_HELP[m])}
              onClick={() => setMode(m)}
            >
              {t(MODE_TITLE[m])}
            </button>
          ))}
        </div>
      </div>
      <div
        className="ta-grid"
        role="img"
        aria-label={summary}
        style={{ gridTemplateColumns: `repeat(${grid.columns.length}, 1fr)` }}
      >
        {grid.columns.map((col, c) =>
          col.map((date, r) =>
            // Frozen HeatmapCanvas skips out-of-year cells entirely.
            date == null ? null : (
              <span
                key={`${c}-${r}`}
                className={
                  date >= grid.tomorrow ? "ta-cell ta-future" : "ta-cell"
                }
                style={{
                  gridColumn: c + 1,
                  gridRow: r + 1,
                  background: cellBackground(
                    grid.values[c]![r]!,
                    grid.maxValue,
                    date >= grid.tomorrow,
                  ),
                }}
              />
            ),
          ),
        )}
      </div>
      <div className="ta-months" aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={tick.label}
            className="ta-month"
            style={{ left: `${(tick.column / grid.columns.length) * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="ta-legend" title={t("Total tokens recorded this year.")}>
        <span className="ta-total">{summary}</span>
        <span className="ta-spacer" />
        <span className="ta-dim">{t("Less")}</span>
        {LADDER.map((v) => (
          <span
            key={v}
            className="ta-cell ta-ladder"
            style={{ background: cellBackground(v, LADDER_MAX, false) }}
          />
        ))}
        <span className="ta-dim">{t("More")}</span>
      </div>
    </section>
  );
}
