// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Frozen HydraReportDigest: a heads' report batch read as a digest —
// the intro, then one entry per head with its outcome, its files and
// its report. The lead's closing instructions ride in the last head's
// body and are dropped, since they are for the lead, not the user.

import { rosterIndex } from "./hydraDelegation";

export interface HydraReportDigest {
  intro?: string;
  heads: Head[];
}

export interface Head {
  name: string;
  task: string;
  outcome: "done" | "failed" | "stopped";
  effort?: string;
  landing: Landing;
  body: string;
}

export type Landing =
  | { kind: "landed"; files: LandedFile[] }
  | { kind: "notLanded"; files: LandedFile[]; error?: string }
  | { kind: "nothing" }
  | { kind: "unfinished"; copyPath?: string }
  | { kind: "none" };

export interface LandedFile {
  path: string;
  additions: number;
  deletions: number;
  hasConflicts: boolean;
}

/** A `## ` line starts a head only when the text before its first colon
 *  is a roster name; anything else (a head's own markdown headings)
 *  stays in the body. */
function isHeadHeader(header: string): boolean {
  const colon = header.indexOf(":");
  if (colon < 0) return false;
  return rosterIndex(header.slice(0, colon).trim()) !== undefined;
}

const META_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "minimal",
  "fast",
  "default",
]);

/** The name off the colon, then trailing `(...)` groups stripped from
 *  the task: `failed` or `stopped...` is the outcome, anything else the
 *  effort. */
function parseHeader(header: string): {
  name: string;
  task: string;
  outcome: Head["outcome"];
  effort?: string;
} {
  const trimmed = header.trim();
  let name: string;
  let rest: string;
  const colon = trimmed.indexOf(":");
  if (colon >= 0) {
    name = trimmed.slice(0, colon).trim();
    rest = trimmed.slice(colon + 1).trim();
  } else {
    name = trimmed;
    rest = "";
  }
  let outcome: Head["outcome"] = "done";
  const efforts: string[] = [];
  while (rest.endsWith(")")) {
    const open = rest.lastIndexOf("(");
    if (open < 0) break;
    const group = rest.slice(open + 1, -1);
    const lower = group.toLowerCase();
    const isMeta =
      lower === "failed" ||
      lower.startsWith("stopped") ||
      /\d/.test(group) ||
      META_EFFORTS.has(lower);
    if (!isMeta) break;
    rest = rest.slice(0, open).trim();
    if (lower === "failed") outcome = "failed";
    else if (lower.startsWith("stopped")) outcome = "stopped";
    else if (group !== "") efforts.unshift(group.replaceAll(", ", " · "));
  }
  return {
    name,
    task: rest,
    outcome,
    ...(efforts.length ? { effort: efforts.join(" · ") } : {}),
  };
}

function landingPrefix(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("Landed in your checkout:") ||
    t.startsWith("Did not land") ||
    t.startsWith("Changed nothing.") ||
    t.startsWith("Nothing landed")
  );
}

/** The landing line off its prefix: the files part is comma-separated
 *  `path (+A −D)` items, before any `, and N more` or build-output tail. */
function parseLanding(line: string): Landing {
  if (line.startsWith("Changed nothing.")) return { kind: "nothing" };
  if (line.startsWith("Nothing landed")) {
    const at = line.indexOf("in its copy at ");
    if (at >= 0) {
      let path = line.slice(at + "in its copy at ".length).trim();
      if (path.endsWith(".")) path = path.slice(0, -1);
      return { kind: "unfinished", ...(path ? { copyPath: path } : {}) };
    }
    return { kind: "unfinished" };
  }
  if (line.startsWith("Landed in your checkout:")) {
    return {
      kind: "landed",
      files: parseFiles(line.slice("Landed in your checkout:".length)),
    };
  }
  if (line.startsWith("Did not land")) {
    let rest = line.slice("Did not land".length);
    let error: string | undefined;
    if (rest.startsWith(" (")) {
      const close = rest.indexOf(")");
      if (close >= 0) {
        error = rest.slice(2, close).trim();
        rest = rest.slice(close + 1);
      }
    }
    if (rest.startsWith(":")) rest = rest.slice(1);
    return {
      kind: "notLanded",
      files: parseFiles(rest),
      ...(error ? { error } : {}),
    };
  }
  return { kind: "none" };
}

function parseFiles(raw: string): LandedFile[] {
  let text = raw.trim();
  if (text.endsWith(".")) text = text.slice(0, -1);
  // The tails the lead appends after the files, longest first.
  text = text
    .replace(/; \d+ build-output files? (?:was|were) left out$/, "")
    .replace(/, and \d+ more$/, "");
  return text
    .split(", ")
    .map((item) => matchFile(item.trim()))
    .filter((f): f is LandedFile => f !== null);
}

function matchFile(item: string): LandedFile | null {
  // The minus the lead writes is U+2212; a hyphen still matches for safety.
  const m = /^(\S+) \(\+(\d+) [−-](\d+)\)( with conflicts)?$/.exec(item);
  if (!m) return null;
  return {
    path: m[1]!,
    additions: parseInt(m[2]!, 10),
    deletions: parseInt(m[3]!, 10),
    hasConflicts: m[4] !== undefined,
  };
}

/** The closing paragraph the lead appends for itself is not the heads'
 *  report; it leaves with the last head's final paragraph when it reads
 *  like instructions. */
const LEAD_PREFIXES = [
  "The changes listed above",
  "The heads worked in your checkout",
  "A file listed with conflicts",
  "Do not check any of this",
  "Do not wait for",
  "A head that failed",
  "A head the user stopped",
  "The user queued",
  "The user sent",
];

function withoutLeadInstructions(body: string): string {
  const at = body.lastIndexOf("\n\n");
  if (at < 0) return body;
  const tail = body.slice(at + 2).trim();
  if (!LEAD_PREFIXES.some((p) => tail.startsWith(p))) return body;
  return body.slice(0, at).trim();
}

/** The report off the lead's `reportMessage`: everything before the
 *  first head header is the intro, each head header starts a head,
 *  other `## ` headings stay in the report, and trailing `(...)` groups
 *  on the header are the outcome or the effort rather than the task. */
export function parseHydraReportDigest(text: string): HydraReportDigest {
  const lines = text.split("\n");
  const introLines: string[] = [];
  const sections: { header: string; lines: string[] }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") && isHeadHeader(trimmed.slice(3))) {
      sections.push({ header: trimmed.slice(3), lines: [] });
    } else if (sections.length === 0) {
      introLines.push(line);
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  const intro = introLines.join("\n").trim();
  const heads: Head[] = [];
  for (const [index, section] of sections.entries()) {
    const { name, task, outcome, effort } = parseHeader(section.header);
    let rest = section.lines;
    while (rest.length && rest[0]!.trim() === "") rest = rest.slice(1);
    let landing: Landing = { kind: "none" };
    if (rest.length && landingPrefix(rest[0]!)) {
      landing = parseLanding(rest[0]!.trim());
      rest = rest.slice(1);
    }
    let body = rest.join("\n").trim();
    if (index === sections.length - 1) body = withoutLeadInstructions(body);
    heads.push({ name, task, outcome, ...(effort ? { effort } : {}), landing, body });
  }
  return { ...(intro ? { intro } : {}), heads };
}
