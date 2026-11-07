// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F19 contribution grid — frozen TokenActivityGrid @ d31e093b ported to
// Date arithmetic. A year of Sunday-first week columns over the current
// year; three display modes scale the same shape, never re-lay it out.

export type TokenActivityMode = "daily" | "weekly" | "cumulative";
export const ACTIVITY_MODES: readonly TokenActivityMode[] = [
  "daily",
  "weekly",
  "cumulative",
];

export const ACTIVITY_ROWS = 7;
const MONTHS = 12;
/** Fixed English abbreviations like the frozen grid (the app's month
 *  labels read in English under either UI language). */
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface MonthTick {
  label: string;
  column: number;
}

export interface TokenActivityGrid {
  /** One column per week bucket; row r is the day at Sunday+r, null
   *  where the cell falls outside the year. */
  columns: (number | null)[][]; // epoch ms, local day starts
  /** Display value per cell, already scaled for the mode. */
  values: number[][];
  maxValue: number;
  monthTicks: MonthTick[];
  /** First day after today (epoch ms, local) — cells at or after it
   *  draw as future, fainter than a quiet day. */
  tomorrow: number;
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Calendar +1 day at local midnight (DST-safe — Date arithmetic, not ms). */
function nextDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function buildActivityGrid(
  daily: Record<string, number>,
  mode: TokenActivityMode,
  now: Date = new Date(),
): TokenActivityGrid {
  const startOfToday = startOfDay(now);
  const rangeStart = new Date(startOfToday.getFullYear(), 0, 1);
  const rangeEnd = new Date(startOfToday.getFullYear(), 11, 31);
  const tomorrow = nextDay(startOfToday);

  // First column starts on the Sunday on or before the range start.
  const gridStart = new Date(rangeStart);
  gridStart.setDate(gridStart.getDate() - rangeStart.getDay());

  // Day totals inside the range up to today, keyed by local day start.
  const totalsByDay = new Map<number, number>();
  for (let cursor = rangeStart; cursor <= startOfToday; cursor = nextDay(cursor)) {
    const total = daily[dayKey(cursor)];
    if (total !== undefined) totalsByDay.set(cursor.getTime(), total);
  }

  // Pack days into Sunday-first columns through the week holding New
  // Year's Eve; every column keeps all seven rows.
  const columns: (number | null)[][] = [];
  for (let day = gridStart; ; ) {
    const column: (number | null)[] = [];
    for (let r = 0; r < ACTIVITY_ROWS; r++) {
      column.push(day < rangeStart || day > rangeEnd ? null : day.getTime());
      day = nextDay(day);
    }
    columns.push(column);
    if (day > rangeEnd) break;
  }

  // Per-mode display values — the shape never changes, only the value
  // each cell is colored by.
  const values = columns.map((col) => col.map(() => 0));
  if (mode === "daily") {
    for (const c of columns.keys())
      for (let r = 0; r < ACTIVITY_ROWS; r++) {
        const date = columns[c]![r];
        if (date != null) values[c]![r] = totalsByDay.get(date) ?? 0;
      }
  } else if (mode === "weekly") {
    for (const c of columns.keys()) {
      let week = 0;
      for (let r = 0; r < ACTIVITY_ROWS; r++) {
        const date = columns[c]![r];
        if (date != null) week += totalsByDay.get(date) ?? 0;
      }
      for (let r = 0; r < ACTIVITY_ROWS; r++)
        values[c]![r] = columns[c]![r] == null ? 0 : week;
    }
  } else {
    let running = 0;
    for (const c of columns.keys())
      for (let r = 0; r < ACTIVITY_ROWS; r++) {
        const date = columns[c]![r];
        if (date != null) running += totalsByDay.get(date) ?? 0;
        values[c]![r] = running;
      }
  }
  const maxValue = Math.max(0, ...values.flat());

  // One tick per month at the column holding its first day.
  const monthTicks: MonthTick[] = [];
  for (let offset = 0; offset < MONTHS; offset++) {
    const monthDate = new Date(rangeStart.getFullYear(), offset, 1);
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const clamped = Math.max(monthStart.getTime(), rangeStart.getTime());
    const daysOut = Math.round((clamped - gridStart.getTime()) / 86_400_000);
    const column = Math.floor(daysOut / ACTIVITY_ROWS);
    if (column < columns.length)
      monthTicks.push({ label: MONTH_NAMES[monthDate.getMonth()]!, column });
  }

  return { columns, values, maxValue, monthTicks, tomorrow: tomorrow.getTime() };
}
