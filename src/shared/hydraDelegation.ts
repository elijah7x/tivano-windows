// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22 bounded slice: frozen HydraDelegationStream.swift + the Hydra.swift
// prompt/report/roster pieces the spawn path needs. A ```hydra fenced
// block in a lead's streaming reply holds JSON delegation entries; heads
// go out the moment each entry's brace closes, not when the reply ends.
// Out of this slice (honest): isolated-checkout copies (F23), land/merge
// (F24), queue/send-out-head routing (dispatchSentHead), tool-count
// pacing, native sub-agent bridging (F25), the animated delegation card.
// Heads run in the lead's SHARED checkout — a real frozen mode
// (`workplaceRules .shared`), never a pretended isolation.

import {
  HYDRA_PERSONAS,
  headProfileBriefLabel,
  type HydraHeadProfile,
  type HydraPersona,
} from "./hydra";

// ---------------------------------------------------------------------------
// HydraDelegation — one entry of a delegation block (frozen verbatim).

export interface HydraDelegation {
  /** Single-line task title; derived from the prompt when absent. */
  task: string;
  /** The brief the head runs on. */
  prompt: string;
  /** P1-12 rework send-back (frozen `"continue"`): the name of a head
   *  of this job to send the prompt back to — it continues in that
   *  head's own session and copy instead of spawning a new head. */
  continue?: string | undefined;
  /** Announced roster name ("name"/"head") — authoritative when on roster. */
  name?: string | undefined;
  /** Sidebar project name (or path) the head is sent to. */
  project?: string | undefined;
  /** Head profile name on the pair; unknown = shared worker model. */
  profile?: string | undefined;
  /** P1-37: the adaptive mode's 1-based identity number (frozen
   *  `preset` on Chimera entries) — resolves against the usable
   *  presets the policy listed. */
  identity?: number | undefined;
  /** P2-05 (frozen `files`): the paths this head owns, relative to its
   *  checkout — [] for a head that only reads and reports. Required on
   *  every new-head entry (filesGiven); absent on one means the whole
   *  entry is refused. */
  files?: string[] | undefined;
  /** P2-05 (frozen `filesGiven`): the entry carried a `"files"` array —
   *  even an empty one. A continue entry without one inherits the
   *  head's recorded list where a conversion applies. */
  filesGiven?: boolean | undefined;
}

const singleLine = (s: string, limit: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/** Frozen `delegation(fromEntry:)`: kept only with a non-empty prompt. */
export function delegationFromEntry(entry: unknown): HydraDelegation | null {
  if (typeof entry !== "object" || entry === null) return null;
  const get = (k: string): string | undefined => {
    const v = (entry as Record<string, unknown>)[k];
    return typeof v === "string" ? v.trim() || undefined : undefined;
  };
  const prompt = get("prompt");
  if (!prompt) return null;
  // `role` is the adaptive mode's job-title field (frozen Chimera
  // entries); it stands in for `task` when the lead names one.
  const task = get("task") ?? get("role") ?? singleLine(prompt, 60);
  const idn = (entry as Record<string, unknown>).identity;
  // P2-05 (frozen files/filesGiven): only string elements survive;
  // an entry that names no "files" array at all is what `filesGiven`
  // reports — the dispatch refuses new-head entries without it.
  const filesRaw = (entry as Record<string, unknown>).files;
  const filesGiven = Array.isArray(filesRaw);
  return {
    task,
    prompt,
    continue: get("continue"),
    name: get("name") ?? get("head"),
    project: get("project") ?? get("repo"),
    profile: get("profile"),
    identity:
      typeof idn === "number" && Number.isInteger(idn) && idn > 0
        ? idn
        : undefined,
    files: filesGiven
      ? filesRaw.filter((f): f is string => typeof f === "string")
      : undefined,
    filesGiven,
  };
}

// ---------------------------------------------------------------------------
// streamedDelegations — the whole-text rescan (frozen `streamedDelegations(in:)`);
// byte-accurate so a partial entry never half-reads.

export interface StreamedDelegations {
  delegations: HydraDelegation[];
  isComplete: boolean;
}

const OPENER = /```[ \t]*hydra(?:-sent|-leaving)?[ \t]*\r?\n/i;

export function streamedDelegations(text: string): StreamedDelegations | null {
  const m = OPENER.exec(text);
  if (!m || m.index === undefined) return null;
  return streamedDelegationsInBody(text.slice(m.index + m[0].length));
}

function streamedDelegationsInBody(body: string): StreamedDelegations {
  const result: StreamedDelegations = { delegations: [], isComplete: false };
  // TextEncoder, not Buffer — the renderer bundle parses these cards too
  // and has no Node globals. Same byte-accurate UTF-8 view either way.
  const bytes = new TextEncoder().encode(body);
  let i = 0;
  const ws = (b: number) => b === 32 || b === 10 || b === 13 || b === 9;
  while (i < bytes.length && ws(bytes[i]!)) i++;
  if (i >= bytes.length) return result;
  let isArray: boolean;
  if (bytes[i] === 91 /* [ */) {
    isArray = true;
    i++;
  } else if (bytes[i] === 123 /* { */) {
    isArray = false;
  } else {
    return result;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let entryStart = i;
  let atLineStart = true;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (b === 92) escaped = true;
      else if (b === 34) inString = false;
    } else {
      if (b === 34) inString = true;
      else if (b === 123) {
        if (depth === 0) entryStart = i;
        depth++;
      } else if (b === 125) {
        depth--;
        if (depth === 0) {
          // entry bytes → utf8 string: braces are ASCII so both ends sit
          // on character boundaries (frozen verbatim).
          const json = new TextDecoder().decode(bytes.subarray(entryStart, i + 1));
          try {
            const d = delegationFromEntry(JSON.parse(json));
            if (d) result.delegations.push(d);
          } catch {
            /* unparseable entry — skipped like the frozen whole-block path */
          }
          if (!isArray) {
            result.isComplete = true;
            return result;
          }
        } else if (depth < 0) {
          result.isComplete = true;
          return result;
        }
      } else if (b === 93 && depth === 0) {
        result.isComplete = true;
        return result;
      } else if (b === 96 && depth === 0 && atLineStart) {
        result.isComplete = true;
        return result;
      }
    }
    atLineStart = b === 10;
    i++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// HydraDelegationStreamParser — incremental ingest (frozen verbatim): only
// newly appended bytes; a completed/replaced message gets a fresh parser.

export class HydraDelegationStreamParser {
  private readonly entries: HydraDelegation[] = [];
  private done = false;
  private opener = 0;
  private inBody = false;
  private shapeKnown = false;
  private isArray = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private atLineStart = true;
  private entry: number[] = [];
  /** The ```hydra-sent variant records heads that ALREADY went out —
   *  parsed for completeness but never re-dispatched (frozen parity). */
  private sent = false;

  get delegations(): readonly HydraDelegation[] {
    return this.entries;
  }
  get isComplete(): boolean {
    return this.done;
  }
  get isSentBlock(): boolean {
    return this.sent;
  }

  ingest(text: string): void {
    if (this.done) return;
    for (const byte of new TextEncoder().encode(text)) {
      if (this.inBody) this.readBody(byte);
      else this.readOpener(byte);
      if (this.done) break;
    }
  }

  private readOpener(byte: number): void {
    const lower = byte >= 65 && byte <= 90 ? byte + 32 : byte;
    if (this.opener <= 2) {
      this.opener = byte === 96 ? this.opener + 1 : 0;
      return;
    }
    if (this.opener === 3) {
      if (byte === 32 || byte === 9 || byte === 96) return;
      if (lower === 104) {
        this.opener = 4;
        return;
      }
      this.opener = 0;
      return;
    }
    if (this.opener <= 7) {
      const expected = [0, 0, 0, 0, 121, 100, 114, 97][this.opener]!;
      this.opener = lower === expected ? this.opener + 1 : byte === 96 ? 1 : 0;
      return;
    }
    if (this.opener === 8) {
      if (byte === 45) this.opener = 9;
      else this.readOpenerEnd(byte);
      return;
    }
    if (this.opener <= 12) {
      const expected = [0, 0, 0, 0, 0, 0, 0, 0, 0, 115, 101, 110, 116][this.opener]!;
      this.opener = lower === expected ? this.opener + 1 : byte === 96 ? 1 : 0;
      if (this.opener === 13) this.sent = true; // "-sent" consumed
      return;
    }
    if (this.opener <= 14) {
      this.readOpenerEnd(byte);
      return;
    }
    if (this.opener === 15) {
      if (byte === 10) this.inBody = true;
      else this.opener = byte === 96 ? 1 : 0;
    }
  }

  private readOpenerEnd(byte: number): void {
    if (byte === 32 || byte === 9) this.opener = 14;
    else if (byte === 13) this.opener = 15;
    else if (byte === 10) this.inBody = true;
    else this.opener = byte === 96 ? 1 : 0;
  }

  private readBody(byte: number): void {
    if (!this.shapeKnown) {
      if (byte === 32 || byte === 9 || byte === 13 || byte === 10) return;
      this.shapeKnown = true;
      this.isArray = byte === 91;
      if (this.isArray) return;
    }
    if (this.depth > 0) this.entry.push(byte);
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (byte === 92) this.escaped = true;
      else if (byte === 34) this.inString = false;
    } else {
      if (byte === 34) this.inString = true;
      else if (byte === 123) {
        if (this.depth === 0) this.entry = [byte];
        this.depth++;
      } else if (byte === 125) {
        this.depth--;
        if (this.depth === 0) {
          try {
            const d = delegationFromEntry(
              JSON.parse(new TextDecoder().decode(new Uint8Array(this.entry))),
            );
            if (d) this.entries.push(d);
          } catch {
            /* unparseable entry — skipped like the frozen whole-block path */
          }
          this.entry = [];
          if (!this.isArray) this.done = true;
        } else if (this.depth < 0) this.done = true;
      } else if (byte === 93 && this.depth === 0) this.done = true;
      else if (byte === 96 && this.depth === 0 && this.atLineStart) this.done = true;
    }
    this.atLineStart = byte === 10;
  }
}

// ---------------------------------------------------------------------------
// withoutDelegationBlock — the reply with its block taken out (frozen; used
// when a turn ended before its heads went out so the block can't stand).

const BLOCK_RE = /```[ \t]*hydra(?:-sent|-leaving)?[ \t]*\r?\n[\s\S]*?(?:```|$)/i;
export function withoutDelegationBlock(text: string): string {
  const m = BLOCK_RE.exec(text);
  return (m ? text.slice(0, m.index) + text.slice(m.index + m[0].length) : text).trim();
}

// ---------------------------------------------------------------------------
// Roster naming (frozen HydraRoster): announced roster names are
// authoritative; anything else takes the next sequential persona. A name a
// still-working head carries rounds up ("Tova" busy → "Tova 2").

export function personaAt(index: number): HydraPersona {
  const n = HYDRA_PERSONAS.length;
  const base = HYDRA_PERSONAS[((index % n) + n) % n]!;
  const round = Math.floor(Math.max(0, index) / n);
  return round > 0 ? { ...base, name: `${base.name} ${round + 1}` } : base;
}

export function rosterIndex(named: string): number | undefined {
  let bare = named.trim();
  const space = bare.lastIndexOf(" ");
  if (space >= 0 && /^\d+$/.test(bare.slice(space + 1))) bare = bare.slice(0, space).trim();
  const i = HYDRA_PERSONAS.findIndex(
    (p) => p.name.toLowerCase() === bare.toLowerCase(),
  );
  return i < 0 ? undefined : i;
}

export function personaNamed(name: string): HydraPersona | undefined {
  const index = rosterIndex(name);
  if (index === undefined) return undefined;
  const bare = name.trim();
  const space = bare.lastIndexOf(" ");
  const round = space >= 0 ? Number(bare.slice(space + 1)) : 0;
  return personaAt(round > 1 ? index + (round - 1) * HYDRA_PERSONAS.length : index);
}

// ---------------------------------------------------------------------------
// Head brief — frozen delegatedHeadPrompt, shared-checkout variant. The
// workplace rules below are the frozen `workplaceRules .shared` text with
// the checkout path filled in.

const HOW_TO_WORK = `- Start on the task right away: read what you need and no more, then make the change.
- A brief that names the file, the line and the change needs no second reading: make that edit first, then the next. Think briefly between tool calls; if you find yourself weighing designs for minutes, take the simplest reading of the brief and do it, and mention the choice in your report.
- Do exactly this task and only this. Do not widen it, do not touch files it does not name unless it cannot be done otherwise, and never revert, reformat or clean up work that is not yours.
- Never run a build, a test, a lint, a type check or any other check of your work, and never wait on one: the lead runs every check itself, in its own checkout. Make the edits your brief names and report.
- If something blocks you, stop and say so instead of guessing or working around it.`;

const HOW_TO_REPORT =
  "Report the result, the files you changed and material blockers once, in a few lines the lead can act on: what changed, where, and anything still open or uncertain. No preamble, no restating the brief, no logs. The lead handles validation. Then exactly the three lines `Deviations: ...`, `Unfinished: ...` and `Uncertain: ...`, each `none` when empty.";

/** P1-12 (frozen HydraTilt): how readily the lead hands work to heads.
 *  Restrained delegates only for parallel pieces or heavy reading;
 *  active also sends bounded mechanical work out, even one piece;
 *  aggressive makes heads the default for nearly all work. */
export type HydraTilt = "restrained" | "active" | "aggressive";

export const HYDRA_TILTS: readonly HydraTilt[] = [
  "restrained",
  "active",
  "aggressive",
];

/** Frozen `v2TiltRule` — what each tilt asks of the lead, in its own
 *  words: field data showed leads delegating about one agentic task in
 *  ten whatever the tilt, so the rule names the kinds of work that go
 *  out, not only the principle. */
export function hydraTiltRule(tilt: HydraTilt): string {
  switch (tilt) {
    case "restrained":
      return "Delegate the parts that would crowd your context or take long: an audit or sweep across many files, research across many sources, or several independent pieces that can run at once. Do the rest yourself.";
    case "active":
      return "Default to heads for any part you can brief on its own that would take you more than a few tool calls: research, an audit, a mechanical change, a clearly specified feature or fix, or several variants or modules built in parallel. Do a part yourself when it is short, or when you must judge it while reading.";
    case "aggressive":
      return "Heads are your default for nearly all work: brief every part you can describe on its own, investigations included, where heads gather and report while you decide. Do something yourself only when it is a quick answer or a one-step edit, or when it cannot be briefed without doing the reading yourself.";
  }
}

/** Frozen `v2DelegationRequest` tilt clause — the named level and its
 *  short rule for the front of the user's message. */
function hydraTiltName(tilt: HydraTilt): { name: string; rule: string } {
  switch (tilt) {
    case "restrained":
      return { name: "restrained", rule: "send heads only the parts that would crowd your context: audits, broad research, several parallel pieces" };
    case "active":
      return { name: "proactive", rule: "send heads any part you can brief that would take more than a few tool calls; keep short work and work you must judge while reading" };
    case "aggressive":
      return { name: "aggressive", rule: "send heads nearly everything you can brief; keep only quick answers, one-step edits and work you cannot brief" };
  }
}

/** The three lines every head ends its report with (frozen
 *  HydraReportNotes): nil fields mean the head wrote "none"; a report
 *  without the lines parses to undefined and the raw reply stands
 *  alone. */
export interface HydraReportNotes {
  deviations?: string | undefined;
  unfinished?: string | undefined;
  uncertain?: string | undefined;
}

const REPORT_NOTE_LABELS = ["Deviations", "Unfinished", "Uncertain"] as const;
const REPORT_NOTE_NILS = new Set(["none", "n/a", "无", "没有"]);

/** Frozen `HydraReportNotes.parse`: the `Deviations:`/`Unfinished:`/
 *  `Uncertain:` lines anywhere in a reply, case-insensitive, markdown
 *  bullets and bold allowed; a value runs until the next label or the
 *  end. Undefined unless all three labels are present. */
export function parseHydraReportNotes(reply: string): HydraReportNotes | undefined {
  const found = new Map<string, string[]>();
  let current: string | undefined;
  for (const raw of reply.split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*•\s]+/, "")
      .replace(/\*\*/g, "");
    const label = REPORT_NOTE_LABELS.find((l) =>
      line.toLowerCase().startsWith(l.toLowerCase() + ":"),
    );
    if (label) {
      current = label;
      found.set(label, [line.slice(label.length + 1).trim()]);
    } else if (current) {
      if (line === "") current = undefined;
      else found.get(current)!.push(line);
    }
  }
  if (!REPORT_NOTE_LABELS.every((l) => found.has(l))) return undefined;
  const value = (label: string): string | undefined => {
    const text = (found.get(label) ?? []).join("\n").trim();
    const lowered = text.toLowerCase().replace(/^[.\s]+|[.\s]+$/g, "");
    return text === "" || REPORT_NOTE_NILS.has(lowered) ? undefined : text;
  };
  const notes: HydraReportNotes = {};
  const d = value("Deviations");
  if (d !== undefined) notes.deviations = d;
  const u = value("Unfinished");
  if (u !== undefined) notes.unfinished = u;
  const q = value("Uncertain");
  if (q !== undefined) notes.uncertain = q;
  return notes;
}

/** Frozen `sharedFolderRule` (v3.0.0): the in-place contract — Tivano
 *  backed the owned files up first and diffs them for the lead. */
export const HYDRA_SHARED_FOLDER_RULE =
  "This folder is not a Git repository, so you change files in place. Tivano backed up the files you own before you started and shows the lead their diff. Change only the files you own. If you need to change any other file, stop before changing it and report under Unfinished which file, what change and why; the lead decides whether to send you back to do it.";

export function sharedWorkplaceRules(
  path: string,
  isNonGit?: boolean | undefined,
  filesBase?: string | undefined,
): string {
  // Frozen workplaceRules .shared: a filesBase line leads when the
  // head's list resolves against a folder other than its workplace.
  const baseLine = filesBase
    ? `Paths in your file list and the team split are relative to ${filesBase}; you work in ${path}.\n`
    : "";
  return `${baseLine}${isNonGit ? HYDRA_SHARED_FOLDER_RULE + "\n" : ""}You work in the lead's checkout at ${path}, alongside the lead and the other heads, who are changing other files at the same time. Changes you did not make are expected there: leave every one of them alone, never stash, check out, reset, restore or clean anything, and never move work into a branch or worktree, whatever the project's own guidelines say about agents and worktrees. Do not use git status or git diff to check your work: they show everyone's changes, and the lead does the verifying.`;
}

export function delegatedHeadPrompt(
  persona: HydraPersona,
  delegation: HydraDelegation,
  checkoutPath: string,
  identityPrompt?: string | undefined,
  isNonGit?: boolean | undefined,
  filesBase?: string | undefined,
): string {
  // P1-37: the adaptive mode's identity rides the brief (frozen
  // rolePrompt on the waiting item) — one line under the task.
  const identity = identityPrompt?.trim()
    ? `\nYou work as this sub-agent identity: ${identityPrompt.trim()}\n`
    : "";
  // Frozen v2HeadPrompt's own-files line (the Team split it follows in
  // the packet is outside this port's brief surface — the line stands
  // on its own).
  const filesLine = (delegation.files ?? []).length
    ? "Change only files you own. Report any needed change to other files under Unfinished before changing them."
    : "You change no files: read, investigate and report what you found.";
  return `You are ${persona.name}, a Hydra head in Tivano: one of several helpers working in parallel for a lead agent. The lead delegated this task to you.

## Your task: ${delegation.task}${identity}
${withoutVerificationSteps(delegation.prompt)}

## Where you work
${sharedWorkplaceRules(checkoutPath, isNonGit, filesBase)}

${filesLine}

## How to work
${HOW_TO_WORK}

## Your report
${HOW_TO_REPORT}`;
}

// ---------------------------------------------------------------------------
// reportMessage — the message the lead receives once heads report (frozen
// reportMessage, minus the landing/conflict branches this slice can't
// produce: shared-checkout heads have no patch to apply — the closing line
// says their work is already in the lead's checkout).

export type HydraHeadStatus = "running" | "completed" | "stopped" | "failed";

/** Where an isolated head's changes went (frozen HydraLanding). */
export interface HydraLanding {
  files: { path: string; additions: number; deletions: number }[];
  /** Files the three-way apply left conflict markers in. */
  conflicts: string[];
  /** Where the patch went when none of it could be applied. */
  patchPath?: string | undefined;
  error?: string | undefined;
}

export interface HydraReport {
  headIndex: number;
  task: string;
  status: HydraHeadStatus;
  text: string;
  /** Delegation-block id this report belongs to — a batch's reports flush
   *  together only once every head in the batch is back. */
  batchId?: string | undefined;
  elapsedMs?: number | undefined;
  toolCalls?: number | undefined;
  /** Frozen HydraReport.landing — absent for shared-checkout heads. */
  landing?: HydraLanding | undefined;
  /** Frozen copyPath — the head's own copy kept for unlanded work. */
  copyPath?: string | undefined;
  /** Frozen HydraReport.provider — the provider's display name the head
   *  ran on; heads that failed to start group their cause by it. */
  provider?: string | undefined;
  /** Frozen HydraReport.startupFailure — the head failed with a
   *  non-transient error before it said anything or ran a tool. */
  startupFailure?: boolean | undefined;
  /** Frozen HydraHeadInfo.stopReason — set when the quiet watchdog
   *  stopped the head, so the report says Tivano stopped it, not the
   *  user, and tells the lead it can be continued. */
  stopReason?: "stalled" | undefined;
  /** Frozen HydraJobHeadRecord.notes — the structured Deviations/
   *  Unfinished/Uncertain lines when the report carried all three. */
  notes?: HydraReportNotes | undefined;
  /** Frozen HydraJobHeadRecord.expectsNotes — true on heads of a v2
   *  job, so a completed report missing the three lines is flagged
   *  "Report format not followed." */
  expectsNotes?: boolean | undefined;
}

/** Frozen `isTransientFailure`: a failure likely to clear on its own —
 *  rate limits, dropped connections, timeouts — is never evidence the
 *  provider is broken, so it never marks a startup failure. */
export function hydraIsTransientFailure(error: string): boolean {
  const text = error.toLowerCase();
  return [
    "rate limit", "rate-limit", "ratelimit", "429", "too many requests", "overloaded",
    "try again", "timed out", "timeout", "network", "connection", "offline",
    "503", "502", "500", "504", "service unavailable", "bad gateway",
    "temporarily", "usage limit", "quota", "econnreset", "enotfound", "socket",
  ].some((m) => text.includes(m));
}

const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

const landed = (l: HydraLanding): boolean =>
  l.files.length > 0 && l.patchPath === undefined && l.error === undefined;
const landingEmpty = (l: HydraLanding): boolean =>
  l.files.length === 0 && l.patchPath === undefined && l.error === undefined;

/** Frozen `landingLine` — where a head's work went, one line for its
 *  report section. Nothing for a shared-checkout head. */
function landingLine(report: HydraReport): string | undefined {
  const landing = report.landing;
  if (!landing) {
    if (!report.copyPath) return undefined;
    return report.status === "completed"
      ? "Changed nothing."
      : `Nothing landed; its unfinished work is in its copy at ${report.copyPath}.`;
  }
  if (landingEmpty(landing)) return "Changed nothing.";
  const listed =
    landing.files
      .slice(0, 25)
      .map(
        (f) =>
          `${f.path} (+${f.additions} −${f.deletions})` +
          (landing.conflicts.includes(f.path) ? " with conflicts" : ""),
      )
      .join(", ") +
    (landing.files.length > 25 ? `, and ${landing.files.length - 25} more` : "");
  if (landing.patchPath !== undefined) return `Did not land: ${listed}.`;
  if (landing.error) return `Did not land (${landing.error}): ${listed}.`;
  return `Landed in your checkout: ${listed}.`;
}

export function reportMessage(
  reports: HydraReport[],
  stillWorking: string[] = [],
): string {
  const names = reports.map((r) => personaAt(r.headIndex).name);
  let opening = `Hydra reports: ${list(names)} finished.`;
  if (stillWorking.length) {
    opening += ` ${list(stillWorking)} ${stillWorking.length === 1 ? "is" : "are"} still at work; ${stillWorking.length === 1 ? "its report comes" : "their reports come"} as a later message.`;
  }
  // Frozen: heads that failed to start on one provider share one cause,
  // and the same error is shown once per provider, not once per head.
  const startupGroups = new Map<string, HydraReport[]>();
  for (const r of reports) {
    if (r.status !== "failed" || r.startupFailure !== true) continue;
    const provider = r.provider ?? "their provider";
    const group = startupGroups.get(provider) ?? [];
    group.push(r);
    startupGroups.set(provider, group);
  }
  const firstWithError = new Map<string, string>();
  const sections: string[] = [];
  for (const r of reports) {
    const outcome =
      r.status === "failed" ? " (failed)"
      : r.status === "stopped"
        ? r.stopReason === "stalled"
          ? " (stopped by Tivano: it stalled with no progress; its copy and session are kept, so you can continue it)"
          : " (stopped by the user before finishing)"
        : "";
    const effort: string[] = [];
    if (r.elapsedMs !== undefined && r.elapsedMs >= 1000) effort.push(duration(r.elapsedMs));
    if (r.toolCalls) effort.push(r.toolCalls === 1 ? "1 tool" : `${r.toolCalls} tools`);
    const took = effort.length ? ` (${effort.join(", ")})` : "";
    const body = r.text.trim();
    const land = landingLine(r);
    let bodyLine = body || "No report.";
    if (r.status === "failed" && r.startupFailure === true && body) {
      const key = `${r.provider ?? ""} ${body}`;
      const first = firstWithError.get(key);
      if (first !== undefined) {
        bodyLine = `Same startup failure as ${first}.`;
      } else {
        firstWithError.set(key, personaAt(r.headIndex).name);
      }
    }
    // Frozen report flags: the structured notes ride the Flags block
    // right after the header so the lead sees what to look at first;
    // a completed report that should have carried notes but didn't is
    // called out.
    const flags: string[] = [];
    if (r.notes) {
      if (r.notes.deviations) flags.push(`Deviations: ${r.notes.deviations}`);
      if (r.notes.unfinished) flags.push(`Unfinished: ${r.notes.unfinished}`);
      if (r.notes.uncertain) flags.push(`Uncertain: ${r.notes.uncertain}`);
    } else if (r.status === "completed" && r.expectsNotes) {
      flags.push("Report format not followed.");
    }
    sections.push(
      `## ${personaAt(r.headIndex).name}: ${r.task}${outcome}${took}\n` +
        `Flags:\n${flags.length ? flags.join("\n") : "none"}\n` +
        `${land ? land + "\n" : ""}${bodyLine}`,
    );
  }
  const closing: string[] = [];
  if (reports.some((r) => r.landing && landed(r.landing))) {
    closing.push(
      "The changes listed above are in your checkout already; nothing needs applying.",
    );
  }
  if (reports.some((r) => r.copyPath === undefined && r.status === "completed")) {
    closing.push(
      "The heads worked in your checkout, so their changes are there already.",
    );
  }
  if (reports.some((r) => (r.landing?.conflicts.length ?? 0) > 0)) {
    closing.push(
      "A file listed with conflicts was merged three-way and keeps conflict markers: resolve those first, and tell the user in one line that you settled them, so the landing card above does not read as broken.",
    );
  }
  // Two heads on one file is the split the lead was told not to make;
  // it hears which file, so it reads the result instead of trusting it.
  const owners = new Map<string, string[]>();
  for (const r of reports) {
    for (const f of r.landing?.files ?? []) {
      const seen = owners.get(f.path) ?? [];
      seen.push(personaAt(r.headIndex).name);
      owners.set(f.path, seen);
    }
  }
  for (const [path, ns] of [...owners.entries()].sort()) {
    if (ns.length > 1)
      closing.push(`${list(ns)} both changed ${path}: read it as it is now before you build on it.`);
  }
  for (const r of reports) {
    const path = r.landing?.patchPath;
    if (path)
      closing.push(
        `${personaAt(r.headIndex).name}'s changes would not apply on their own; the patch is at ${path}. Apply it with \`git apply --3way ${path}\` and settle what conflicts.`,
      );
  }
  // Frozen: one cause per provider. Another head done on it makes the
  // failure likely temporary; none done at all makes the provider's own
  // environment the cause, so resending fails the same way.
  for (const [provider, group] of startupGroups) {
    const names = group.map((r) => personaAt(r.headIndex).name);
    const onProvider = reports.filter(
      (r) => (r.provider ?? "their provider") === provider,
    );
    if (onProvider.some((r) => r.status === "completed")) {
      closing.push(
        `${list(names)} failed on ${provider} before doing any work while other heads on ${provider} succeeded, so the failure is likely temporary: you may send their parts to ${provider} again or do them yourself.`,
      );
    } else if (!onProvider.some((r) => r.status === "running")) {
      closing.push(
        `${list(names)} failed on ${provider} before doing any work. The cause is ${provider}'s environment (its install, sign-in, configuration or MCP servers), not the task: sending heads to ${provider} again fails the same way. Do ${names.length === 1 ? "its part" : "their parts"} yourself, and tell the user in one line the error above and that it needs fixing on ${provider}'s side.`,
      );
    }
  }
  if (reports.some((r) => r.status === "failed" && r.startupFailure !== true)) {
    closing.push(
      "A head that failed leaves its part to you: do it yourself or send it out again.",
    );
  }
  if (reports.some((r) => r.status === "stopped" && r.stopReason === undefined)) {
    closing.push(
      "A head the user stopped leaves its part alone unless the user asks for it.",
    );
  }
  if (reports.some((r) => r.stopReason === "stalled")) {
    closing.push(
      "A head Tivano stopped for stalling may be continued once with a smaller, more specific step, or its part given to a new head.",
    );
  }
  return [opening, "", ...sections, "", ...closing].join("\n").trim();
}

/** Frozen `maxDelegationRounds` — rounds of heads per user request. */
export const MAX_DELEGATION_ROUNDS = 5;
/** Frozen `maxRefundedRounds` — a request refunds at most this many
 *  rounds whose every head provably did nothing (all failed/stopped
 *  with no landing, on a kept copy or a startup failure). */
export const MAX_REFUNDED_ROUNDS = 2;
/** Frozen `HydraPrompts.maxDelegatedTasks` — entries per delegation block. */
export const MAX_DELEGATED_TASKS = 32;
/** Frozen `HydraWatchdog.stalledNote` lead-in for budget-stopped heads. */
export const STALLED_NOTE =
  "[Tivano] This head was stopped for spending its budget.";
/** Frozen `HydraWatchdog.stalledNote` — the report's own words when the
 *  quiet watchdog stopped the head for sitting still. Upstream appends
 *  the provider's last-output age; that is Antigravity-only there, so
 *  this build keeps the plain note. */
export const QUIET_STALL_NOTE =
  "Stalled: no edits or tool calls for 10 minutes; stopped by Tivano.";

/** Index into the repeating roster for a possibly-rounded name —
 *  `personaAt(personaIndex(n)) === personaNamed(n)` whenever both resolve. */
export function personaIndex(named: string): number | undefined {
  const idx = rosterIndex(named);
  if (idx === undefined) return undefined;
  const bare = named.trim();
  const space = bare.lastIndexOf(" ");
  const round = space >= 0 ? Number(bare.slice(space + 1)) : 0;
  return round > 1 ? idx + (round - 1) * HYDRA_PERSONAS.length : idx;
}

// ---------------------------------------------------------------------------
// Block-state rewrites + the lead's own policy text (frozen HydraPrompts
// marking/fallback functions — the slice our single instructions-less
// provider can carry: every lead turn takes the preamble, report turns
// take the report note, user turns take the delegation request).

/** The opener fence of a delegation block, any info-state (frozen
 *  `delegationOpener`): ```hydra, ```hydra-sent or ```hydra-leaving. */
const DELEGATION_OPENER = /^```[ \t]*hydra(?:-sent|-leaving)?[ \t]*$/m;
const SENT_OPENER = /^```[ \t]*hydra-(?:sent|leaving)[ \t]*$/m;

/** Frozen `hasSentDelegationBlock`: the block's card is already in its
 *  sent (or leaving) state. */
export function hasSentDelegationBlock(text: string): boolean {
  return SENT_OPENER.test(text);
}

/** Frozen `markingDelegationBlockSent`: rewrite a finished reply's
 *  ```hydra opener to ```hydra-sent so the block reads as dispatched
 *  (and a later rescan sends nothing twice). No-op without an
 *  un-sent opener. */
export function markingDelegationBlockSent(text: string): string {
  if (hasSentDelegationBlock(text)) return text;
  return text.replace(/^```[ \t]*hydra[ \t]*$/m, "```hydra-sent");
}

/** A lead has been told never to put a check in a brief, but some do
 *  anyway: the lines that ask a head to build or verify are taken out
 *  before the head sees them (frozen `verificationMarkers`, verbatim —
 *  a prompt check is a prompt check whatever the toolchain). */
const VERIFICATION_MARKERS = [
  "xcodebuild", "swift build", "swift test", "swiftlint", "npm test",
  "npm run build", "npm run test", "yarn build", "yarn test",
  "pnpm test", "cargo build", "cargo test", "go test", "pytest",
  "gradle", "eslint", "tsc ", "build succeeded", "run the build",
  "run the tests", "run the test suite", "build and prove",
  "prove it builds", "prove it compiles", "check that it builds",
  "check it still builds", "make sure it builds",
  "make sure it compiles", "confirm the build", "verify the build",
  "verify that it builds", "make sure nothing else broke",
  "run the suite", "build verification",
];

/** Frozen `withoutVerificationSteps`: drop every brief line that asks
 *  the head to build, test, lint or verify — all checks are the lead's.
 *  A prompt with no such line comes back unchanged; one left empty gets
 *  the frozen one-line replacement. */
export function withoutVerificationSteps(prompt: string): string {
  const lines = prompt.split("\n");
  const kept = lines.filter(
    (line) => !VERIFICATION_MARKERS.some((m) => line.toLowerCase().includes(m)),
  );
  if (kept.length === lines.length) return prompt;
  const body = kept.join("\n").trimEnd();
  return (
    (body ? body + "\n" : "") +
    "Make the assigned edits and report; the lead handles all validation."
  );
}

// ---------------------------------------------------------------------------
// The lead's policy — frozen `HydraPrompts.fallbackPolicy` adapted to this
// build's honest surface: shared checkout (no isolation), the chat's own
// provider and tools (no promised read/edit/run), project routing by
// sidebar name only, no auto-merge or review machinery. Wording kept
// verbatim where the claim is true here.

const POLICY_BRIEF_RULE =
  "Write each brief as numbered, executable steps naming the file, symbol or line anchor, and exact change. Resolve design choices first; ask no questions and offer no alternatives. Give enough context to begin editing within a few tool calls.";
const POLICY_VERIFICATION_RULE =
  "Heads edit or research and report; they never build, test, lint or verify. Do not assign checks or request pass reports. Run required validation yourself in the checkout after the heads return.";
const POLICY_REPORT_STYLE_RULE =
  "For each head, give one plain sentence starting with its name and describing the user-visible result; add the file details only when useful, and keep the whole account bounded to a line or two per head. Omit repeated summaries, audit jargon and decorative symbols. Say plainly what you still need from the user and what you settled or fixed yourself.";

/** Frozen `projectRule`/`v2DelegationRequest` route clause, bounded:
 *  a head routes by a sidebar project's NAME or an ABSOLUTE PATH — the
 *  path is created when its parent exists, system folders are refused
 *  and a non-Git folder is changed in place without a copy or merge.
 *  P2-05: the frozen home/backup sentences apply verbatim now. */
function policyProjectRule(
  projects: { name: string; path: string }[],
  ownName: string | undefined,
): string {
  const own = ownName ? `this chat's project, ${ownName}` : "this chat's project";
  const named = projects.length
    ? " The other projects in the sidebar: " +
      projects.map((p) => `${p.name} (\`${p.path}\`)`).join(", ") +
      "."
    : "";
  return `Heads may work in any project. A head works in ${own} unless it is sent to another: an entry of the delegation block names it with "project", a sidebar project's name or the absolute path of a worktree, another repository or any folder, including non-Git folders — a folder the path names is created when its parent exists, system folders are refused, and a name that matches no sidebar project and is no absolute path does not start the head. Non-Git folders, the home folder included, are changed in place without a copy or merge. Tivano backs up a head's listed files first and shows you their diff when it reports, so list exact files. A head that only reads may work in the home folder with "files": []. A head that writes there gets the narrowest folder containing its files. A head that needs other files stops and reports, and you send it back with "continue" if you agree.${named} Whatever a head changes lands in the checkout it worked in, already there when its report arrives.`;
}

/**
 * The standing rules for a lead on this build (frozen `fallbackPolicy`
 * for a provider with no system prompt: it rides the front of every
 * lead turn). `maxHeads` undefined = uncapped; `profiles` from the
 * bound pair only; `team` is the live team line from `hydraTeamStatus`.
 */
export function hydraLeadPolicy(opts: {
  /** P1-12: the delegation level — its frozen rule names the kinds of
   *  work that go out, on top of the standing delegate-first wording. */
  tilt?: HydraTilt | undefined;
  maxHeads?: number | undefined;
  profiles?: HydraHeadProfile[] | undefined;
  projects?: { name: string; path: string }[] | undefined;
  ownProjectName?: string | undefined;
  /** Frozen `isolated` — heads work in copies Tivano lands back. */
  isolated?: boolean | undefined;
  providerLabel: (id: string) => string;
}): string {
  const team = opts.maxHeads !== undefined
    ? `a team of up to ${opts.maxHeads} helper agents`
    : "a team of helper agents";
  const whereHeadsWork = opts.isolated
    ? "Each head works in a copy of its project of its own and Tivano lands its changes in that project's checkout when it reports"
    : "The heads work in your checkout";
  const profiles = (opts.profiles ?? []).filter((p) => p.name.trim());
  const profileRule = profiles.length
    ? ` Some heads are tuned for a purpose: ${profiles.map((p) => headProfileBriefLabel(p, opts.providerLabel)).join(", ")}. Route a task to one with "profile", as in \`{"task": "...", "prompt": "...", "profile": "${profiles[0]!.name}"}\`; a task that fits none of them goes without a profile and runs on the heads' shared model, as does one whose profile names none of these.`
    : "";
  const tiltRule = opts.tilt ? ` ${hydraTiltRule(opts.tilt)}` : "";
  return `[Hydra is on] You lead ${team} ("heads").${tiltRule} Delegate first, work second: anything bigger than a single obvious change to a single file is a job for heads. Audits, reviews, a feature across several files, a refactor, "check everything", research across many files, several tasks in one message: in your first reply, look at the code only long enough to write good briefs, a minute and a handful of files rather than ten, and then send the heads out, all of them in that one block. Never spend minutes reading before you delegate, and never do inline what heads could be doing in parallel. Only a truly single-focus request, one file and one obvious change, is yours to do alone, and size the team to the work rather than to how many heads are free: a small job whose pieces depend on each other is one head's task, or your own, not a team of heads.         Finish your reply with one fenced block

\`\`\`hydra
[{"task": "short title", "prompt": "complete, self-contained instructions with the exact files and acceptance criteria", "files": ["paths/this/head/changes"]}]
\`\`\`

and stop there: do not wait, poll or verify anything after it. Every new-head entry needs "files": the paths that head changes, or [] for a head that only reads and reports. No path may appear in two entries. When a request is yours to do alone, do it and end with no block at all: an empty block sends no heads and is not needed. An entry may also carry its head's announced name, as in \`{"task": "...", "prompt": "...", "name": "Otto"}\`: the announced name is authoritative and the spawned head carries exactly it, so repeating the same block spawns the same names. An entry for work in another project carries \`"project"\` with that project's name, as in \`{"task": "...", "prompt": "...", "project": "gaze-site"}\`. To send a finished head of this request back to its part, use an entry \`{"continue": "<head name>", "prompt": "..."}\`; heads of earlier requests cannot be sent back, so give their part to a new head. Name new heads with the next roster names in order after the team listed above (Hank, Walter, Ada, Otto, Nova, Remy, Iris, Milo, Juno, Ezra, Lena, Bo, Kai, Vera, Finn, Mira, Odin, Suki, Rex, Zola, Pip, Ivo, Lux, Tova, Gus, then Hank 2 and so on), and omit the name when unsure: the next heads in order go out instead. Never invent names outside the roster: there is no head called Ives (the roster has Ivo), and an unknown name falls back to the next head in order rather than renaming anyone.${profileRule} Inside a prompt never open a fenced code block of your own (three backticks would end the hydra block early and no head would go out): describe code in words, quote identifiers with single backticks, or indent a snippet by four spaces. Each entry goes out to a head the moment its closing brace streams, before the block is finished, so write the entries in the order the heads should start and complete one entry before beginning the next. ${whereHeadsWork}; heads never see your context, so write every prompt for a capable colleague who has read nothing yet, with the exact files, symbols and acceptance criteria, give no two heads the same file, and give no head work that rests on another head's unfinished changes: they run in parallel and never see each other's work. Keep each brief bounded: one head, one task, one report you can act on. ${POLICY_BRIEF_RULE} ${POLICY_VERIFICATION_RULE} ${policyProjectRule(opts.projects ?? [], opts.ownProjectName)} A head can be sent to read and report as well as to change files, so the reading goes out in parallel too. Say in one line which heads you sent out and what each one does. The block is the only way to send heads out: never use an agent, task, spawn_agent or sub-agent tool of your own, which would run the work inside your own session instead of as a head in Tivano. Every head runs on this chat's own provider and model, with whatever tools that provider gives a chat. The reports arrive as a later message with the work already in place: build on them, do not redo them, never send out heads to verify or redo other heads, and never use git status or git diff to check on heads, since the checkout changes under you while they work. A message that opens with [Hydra] is from Tivano, not the user. ${POLICY_REPORT_STYLE_RULE}`;
}

/** Frozen `teamStatus` — the lead's team in a line, for the front of
 *  its messages: who is still out, what came back. */
export function hydraTeamStatus(
  heads: {
    name: string;
    status: "running" | "completed" | "stopped" | "failed";
    startedAt: number;
    /** Frozen: a completed isolated head's landing decides its words. */
    landing?: HydraLanding | undefined;
    copyPath?: string | undefined;
  }[],
  now: number = Date.now(),
): string | undefined {
  if (!heads.length) return undefined;
  const parts = heads.map((h) => {
    switch (h.status) {
      case "running": {
        const minutes = Math.floor((now - h.startedAt) / 60000);
        return `${h.name} (working${minutes > 0 ? ` for ${minutes}m` : ""})`;
      }
      case "completed": {
        const l = h.landing;
        if (l) {
          if (landingEmpty(l)) return `${h.name} (done, changed nothing)`;
          if (landed(l))
            return `${h.name} (done, landed ${l.files.length === 1 ? "1 file" : `${l.files.length} files`})`;
          return `${h.name} (done, patch kept)`;
        }
        return `${h.name} (done)`;
      }
      case "failed":
        return `${h.name} (failed)`;
      case "stopped":
        return `${h.name} (stopped)`;
    }
  });
  return `Your heads so far: ${parts.join(", ")}.`;
}

/** Frozen `fallbackTurnNote` — in front of the user's own message:
 *  the team so far, when there is one. Empty string when there is none. */
export function hydraTurnNote(team: string | undefined): string {
  if (!team) return "";
  return `[Hydra] ${team}\n\n---\n\n`;
}

/** Frozen `delegationRequest` — the user's enabled Hydra setting
 *  expressed alongside their request; kept off automatic reports. */
export function hydraDelegationRequest(tilt: HydraTilt = "active"): string {
  // Frozen v2DelegationRequest tilt clause: the level is named and the
  // decision rule rides every user turn.
  const t = hydraTiltName(tilt);
  return `[Hydra setting: enabled, ${t.name}]
Use Hydra heads for this request when it involves multiple files, an audit, broad research, or independent tasks. Keep a single obvious change in one file with the lead. Before you start, decide which parts go to heads: ${t.rule}. Delegate through the final hydra block so Tivano runs the selected heads; do not use native agent tools. Every new-head entry needs "files" ([] for read-only). Follow any explicit request below to work alone or limit delegation.

---

`;
}

/** Frozen `fallbackReportNote` — in front of a report message: the
 *  heads are back; the lead's job is to finish, not to send out more.
 *  `canDelegate` says a round is still left for what failed or turned
 *  out missing. */
export function hydraReportNote(
  team: string | undefined,
  canDelegate: boolean,
): string {
  const more = canDelegate
    ? "If the reports open up the next stage of the work, or a head failed, or a piece of the user's request is still undone, send heads out again for exactly that, with the same ```hydra block at the end of your reply; to rework the own part of a head of this request, prefer an entry with \"continue\": \"<head name>\" and the instruction in \"prompt\", which continues in its own session and copy; never for verifying, redoing or finishing what a head already did."
    : "Send out no more heads for this request; whatever is left, do yourself.";
  return `[Hydra] Your heads reported back below.${team ? " " + team : ""} ${more}\n\n---\n\n`;
}

/** Frozen `v2QueuedHeadsNote` — tells the lead that tasks from its
 *  delegation block are waiting on the concurrency cap, so it does not
 *  conclude the dispatch failed and send them again. Rides the front of
 *  the next lead prompt while the queue is non-empty. */
export function hydraQueuedHeadsNote(queued: number, maxHeads: number): string {
  const tasks = queued === 1 ? "1 of your tasks is" : `${queued} of your tasks are`;
  const heads = maxHeads === 1 ? "1 head" : `${maxHeads} heads`;
  return `[Hydra] ${tasks} queued, not lost: the cap allows ${heads} at once. They start automatically as heads finish; do not send them again.\n\n---\n\n`;
}

