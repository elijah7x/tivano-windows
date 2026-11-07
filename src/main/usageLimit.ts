// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F20: port of the frozen UsageLimitSignal — a provider saying the
// account's usage limit is spent, and when it comes back. All parsing is
// bounded and defensive: any ambiguity yields NO reset time, never a
// fabricated schedule.

const MAX_WAIT_S = 365 * 86_400;
const MIN_WAIT_S = 5;

function supportsWait(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_WAIT_S;
}

function supportsResetTime(dateMs: number, nowMs: number): boolean {
  return (
    Number.isFinite(dateMs) &&
    Number.isFinite(nowMs) &&
    supportsWait((dateMs - nowMs) / 1000)
  );
}

/** Whether an error message is the provider refusing work until a usage
 *  limit resets: Claude's and Codex's wording, or the rate, spend, quota
 *  and credit phrasing API providers return (frozen verbatim). */
export function matches(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("usage limit") ||
    lower.includes("hit your limit") ||
    lower.includes("usage_limit") ||
    lower.includes("limit reached") ||
    lower.includes("out of extra usage") ||
    lower.includes("account's rate limit") ||
    lower.includes("spend limit") ||
    lower.includes("usage credits are required") ||
    lower.includes("quota will reset") ||
    lower.includes("exhausted your capacity") ||
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted") ||
    lower.includes("insufficient_quota") ||
    lower.includes("out of credits")
  );
}

const UNIT_S: Record<string, number> = {
  d: 86_400, day: 86_400, days: 86_400,
  h: 3_600, hr: 3_600, hrs: 3_600, hour: 3_600, hours: 3_600,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  ms: 0.001, millisecond: 0.001, milliseconds: 0.001,
};

/** "18h31m10s", "2 hours 5 min", "3 days", "158 min", "12s", "5 ms": the
 *  units of one contiguous run add up. A bare number carries no unit; `ms`
 *  is milliseconds, not minutes plus seconds (frozen verbatim). */
function durationIn(text: string): number | null {
  let total = 0;
  let found = false;
  let rest = text.toLowerCase();
  const re = /^([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    const m = re.exec(rest);
    if (!m) break;
    const amount = Number(m[1]);
    const scale = UNIT_S[m[2]!]!;
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_WAIT_S / scale) return null;
    const seconds = amount * scale;
    if (!Number.isFinite(seconds) || !Number.isFinite(total + seconds) || total + seconds > MAX_WAIT_S)
      return null;
    total += seconds;
    found = true;
    rest = rest.slice(m[0].length);
  }
  return found && supportsWait(total) ? total : null;
}

/** The wait an error message names, the longest when it names several:
 *  "retry-after-ms=1800000", "Try again in ~158 min", "Please retry in
 *  12s", "reset after 18h31m10s", "resets in 3 days". Any malformed phrase
 *  poisons the whole read (frozen: return nil inside the loop). */
export function waitTime(text: string): number | null {
  const waits: number[] = [];
  for (const pattern of [/retry-after-ms\s*[:=]\s*(\d+)/gi, /provider requested\s+(\d+)\s*ms\s+wait/gi]) {
    for (const m of text.matchAll(pattern)) {
      const ms = Number(m[1]);
      if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_WAIT_S * 1000) return null;
      const seconds = ms / 1000;
      if (!supportsWait(seconds)) return null;
      waits.push(seconds);
    }
  }
  for (const pattern of [/(?:try again|retry)\s+in\s+~?\s*/gi, /resets?\s+(?:after|in)\s+/gi]) {
    for (const m of text.matchAll(pattern)) {
      const seconds = durationIn(text.slice(m.index + m[0].length));
      if (seconds === null) return null;
      waits.push(seconds);
    }
  }
  const max = waits.length ? Math.max(...waits) : null;
  return max !== null && supportsWait(max) ? max : null;
}

/** The reset time an error message carries, when it does: a Unix
 *  timestamp after a bar ("usage limit reached|1757865600"), a clock time
 *  such as "resets 3pm"/"resets at 3:30 pm" taken as the next such time
 *  from now, or a wait (see waitTime) counted from now. */
export function resetTime(text: string, nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const bar = /\|\s*(\d{9,})/.exec(text);
  if (bar) {
    const raw = Number(bar[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const seconds = raw > 1e11 ? raw / 1000 : raw; // some providers write ms
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const dateMs = seconds * 1000;
    return supportsResetTime(dateMs, nowMs) ? dateMs : null;
  }
  const clock =
    /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] !== undefined ? Number(clock[2]) : 0;
    if (!(hour >= 1 && hour <= 12) || !(minute >= 0 && minute <= 59)) return null;
    const isPM = clock[3]!.toLowerCase() === "pm";
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    // Next occurrence of that wall-clock time (local timezone — the
    // frozen port honours an explicit "(Zone/Name)" suffix; JS Date
    // parsing of arbitrary IANA zones is not available, so the named
    // zone is deliberately unsupported here and falls through honest).
    const candidate = new Date(nowMs);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= nowMs) candidate.setDate(candidate.getDate() + 1);
    const ms = candidate.getTime();
    return supportsResetTime(ms, nowMs) ? ms : null;
  }
  const wait = waitTime(text);
  if (wait !== null) {
    const ms = nowMs + wait * 1000;
    return supportsResetTime(ms, nowMs) ? ms : null;
  }
  return null;
}

/** Frozen AutoContinue.schedule: reset + margin, floored at 5s and
 *  bounded by the maximum wait. Returns the absolute resume time or null
 *  when the reset time cannot produce a sane schedule. */
export function scheduleResume(resetMs: number, nowMs: number, marginMs: number): number | null {
  if (!supportsResetTime(resetMs, nowMs)) return null;
  const seconds = Math.max((resetMs - nowMs + marginMs) / 1000, MIN_WAIT_S);
  if (!supportsWait(seconds)) return null;
  const resumeMs = nowMs + seconds * 1000;
  return supportsResetTime(resumeMs, nowMs) ? resumeMs : null;
}

/** The reset time as the notices print it: "3:31 PM" today, "tomorrow at
 *  9:00 AM" or "Thursday at 9:00 AM" further out (frozen format). */
export function formatReset(dateMs: number): string {
  if (!Number.isFinite(dateMs)) return "Unknown reset time";
  const date = new Date(dateMs);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(date, now)) return time;
  if (sameDay(date, tomorrow)) return `tomorrow at ${time}`;
  const week = new Date(now);
  week.setDate(now.getDate() + 6);
  if (date < week)
    return `${date.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
