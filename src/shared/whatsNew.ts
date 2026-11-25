// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-55: What's new version tracking, SemVer comparison, and CHANGELOG.md
// digest parsing (upstream WhatsNew.swift + UpdateReleaseNotesDigest).
// Pure shared module — no Node or DOM APIs.

import type { LanguageId, Settings, WhatsNewDigest, WhatsNewInfo } from "./types";

export type ReleaseNoteCategory = "newFeatures" | "bugFixes" | "refinements";

export const RELEASE_NOTE_CATEGORIES: readonly ReleaseNoteCategory[] = [
  "newFeatures",
  "bugFixes",
  "refinements",
] as const;

export interface AppVersion {
  components: readonly [number, number, number];
  prerelease: readonly string[];
  isPrerelease: boolean;
}

export interface ChangelogEntry {
  versionText: string;
  version: AppVersion;
  body: string;
}

const PRERELEASE_IDENT_RE = /^[0-9A-Za-z-]+$/;
const NUMERIC_IDENT_RE = /^[0-9]+$/;

/** Parse a SemVer string with optional leading `v`/`V` and 1–3 numeric components. */
export function parseAppVersion(raw: string): AppVersion | null {
  let text = raw.trim();
  if (text.startsWith("v") || text.startsWith("V")) text = text.slice(1);
  if (!text) return null;

  const dashIdx = text.indexOf("-");
  const mainPart = dashIdx === -1 ? text : text.slice(0, dashIdx);
  const prePart = dashIdx === -1 ? null : text.slice(dashIdx + 1);

  let prerelease: string[] = [];
  if (prePart !== null) {
    const idents = prePart.split(".");
    for (const ident of idents) {
      if (!ident || !PRERELEASE_IDENT_RE.test(ident)) return null;
      if (NUMERIC_IDENT_RE.test(ident) && ident.length > 1 && ident.startsWith("0")) {
        return null;
      }
    }
    prerelease = idents;
  }

  const parts = mainPart.split(".");
  if (parts.length < 1 || parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!part || !NUMERIC_IDENT_RE.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    numbers.push(n);
  }
  while (numbers.length < 3) numbers.push(0);

  return {
    components: [numbers[0]!, numbers[1]!, numbers[2]!],
    prerelease,
    isPrerelease: prerelease.length > 0,
  };
}

/** SemVer ordering: negative if a < b, 0 if equal, positive if a > b. */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.components[i]! !== b.components[i]!) {
      return a.components[i]! < b.components[i]! ? -1 : 1;
    }
  }
  if (a.isPrerelease !== b.isPrerelease) {
    return a.isPrerelease ? -1 : 1;
  }
  const len = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const left = a.prerelease[i]!;
    const right = b.prerelease[i]!;
    if (left === right) continue;
    const leftNum = NUMERIC_IDENT_RE.test(left);
    const rightNum = NUMERIC_IDENT_RE.test(right);
    if (leftNum !== rightNum) return leftNum ? -1 : 1;
    if (leftNum) {
      if (left.length !== right.length) return left.length < right.length ? -1 : 1;
      return left < right ? -1 : 1;
    }
    return left < right ? -1 : 1;
  }
  if (a.prerelease.length !== b.prerelease.length) {
    return a.prerelease.length < b.prerelease.length ? -1 : 1;
  }
  return 0;
}

/** Parse `## [version] - date` sections from CHANGELOG.md, skipping `[Unreleased]`. */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let currentHeader: { versionText: string; version: AppVersion } | null = null;
  let bodyLines: string[] = [];

  const flushCurrent = (): void => {
    if (!currentHeader) return;
    const body = bodyLines.join("\n").trim();
    if (body) {
      entries.push({
        versionText: currentHeader.versionText,
        version: currentHeader.version,
        body,
      });
    }
    currentHeader = null;
    bodyLines = [];
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.startsWith("## [")) {
      const closeBracket = trimmed.indexOf("]", 4);
      if (closeBracket !== -1) {
        flushCurrent();
        const versionText = trimmed.slice(4, closeBracket).trim();
        if (versionText.toLowerCase() !== "unreleased") {
          const version = parseAppVersion(versionText);
          if (version) currentHeader = { versionText, version };
        }
        continue;
      }
    }
    if (currentHeader !== null) {
      bodyLines.push(line);
    }
  }
  flushCurrent();
  return entries;
}

/**
 * Filter changelog entries to versions since `previous` up to `current` (newest first).
 * Without a recorded previous version, returns only `current`'s own section when
 * present so an older section is never mislabeled as current.
 */
export function matchingChangelogEntries(
  entries: readonly ChangelogEntry[],
  current: AppVersion,
  previous: AppVersion | null,
): ChangelogEntry[] {
  const includePrereleases = current.isPrerelease;
  const eligible = entries
    .filter(
      (entry) =>
        (includePrereleases || !entry.version.isPrerelease) &&
        compareAppVersions(entry.version, current) <= 0,
    )
    .sort((a, b) => compareAppVersions(b.version, a.version));

  if (previous) {
    return eligible.filter((entry) => compareAppVersions(entry.version, previous) > 0);
  }
  const newest = eligible[0];
  return newest && compareAppVersions(newest.version, current) === 0 ? [newest] : [];
}

function headerTitle(trimmedLine: string): string | null {
  if (trimmedLine.startsWith("### ")) return trimmedLine.slice(4).trim();
  if (trimmedLine.startsWith("## ")) return trimmedLine.slice(3).trim();
  return null;
}

function categoryForHeader(line: string): ReleaseNoteCategory | null {
  let text = line.replace(/^#+/, "").trim();
  if (text.startsWith("**")) text = text.slice(2);
  if (text.endsWith("**")) text = text.slice(0, -2);
  text = text.replace(/^[ \t:]+|[ \t:]+$/g, "").toLowerCase();
  switch (text) {
    case "new features":
    case "new":
    case "新功能":
      return "newFeatures";
    case "bug fixes":
    case "fixes":
    case "bugs":
    case "问题修复":
      return "bugFixes";
    case "refinements":
    case "improvements":
    case "优化改进":
      return "refinements";
    default:
      return null;
  }
}

/** Select the English or Simplified Chinese language block (falling back to English). */
export function selectedReleaseNotes(raw: string, language: LanguageId): string {
  const english: string[] = [];
  const chinese: string[] = [];
  const thanks: string[] = [];
  let current: "English" | "简体中文" | "Thanks" | null = null;
  let hasLanguageSections = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const header = headerTitle(trimmed);
    if (header === "English" || header === "简体中文") {
      hasLanguageSections = true;
      current = header;
      continue;
    }
    if (header === "Thanks" && hasLanguageSections) {
      current = "Thanks";
    }
    if (current === "English") english.push(line);
    else if (current === "简体中文") chinese.push(line);
    else if (current === "Thanks") thanks.push(line);
  }

  if (!hasLanguageSections) return raw;
  const hasChineseContent = chinese.some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && categoryForHeader(trimmed) === null;
  });
  const selected = language === "zh-Hans" && hasChineseContent ? chinese : english;
  const body = selected.join("\n").trim();
  const sharedThanks = thanks.join("\n").trim();
  return [body, sharedThanks].filter(Boolean).join("\n\n");
}

const BULLET_MARKERS = new Set(["-", "\u2010", "\u2013", "\u2014", "\u2212", "*", "•"]);

function bulletBody(trimmedLine: string): string | null {
  if (!trimmedLine) return null;
  const marker = trimmedLine[0]!;
  if (!BULLET_MARKERS.has(marker)) return null;
  const next = trimmedLine[1];
  if (next !== " " && next !== "\t") return null;
  const body = trimmedLine.slice(2).trim();
  return body.length > 0 ? body : null;
}

function isHeaderLine(trimmedLine: string): boolean {
  if (trimmedLine.startsWith("#")) {
    const rest = trimmedLine.replace(/^#+/, "");
    return rest.length === 0 || rest[0] === " " || rest[0] === "\t";
  }
  return trimmedLine.startsWith("**") && trimmedLine.endsWith("**") && trimmedLine.length > 4;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** Parse one release's notes into New features, Bug fixes, and Refinements bullets. */
export function parseReleaseNotesDigest(
  raw: string,
): Record<ReleaseNoteCategory, string[]> {
  const collected: Record<ReleaseNoteCategory, string[]> = {
    newFeatures: [],
    bugFixes: [],
    refinements: [],
  };
  const seen: Record<ReleaseNoteCategory, Set<string>> = {
    newFeatures: new Set(),
    bugFixes: new Set(),
    refinements: new Set(),
  };
  let current: ReleaseNoteCategory | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---" || trimmed.startsWith("<")) continue;
    const bullet = bulletBody(trimmed);
    if (bullet !== null) {
      if (!current) continue;
      const clean = stripInlineMarkdown(bullet);
      const norm = clean.toLowerCase();
      if (clean && !seen[current].has(norm)) {
        seen[current].add(norm);
        collected[current].push(clean);
      }
      continue;
    }
    const category = categoryForHeader(trimmed);
    if (category !== null) {
      current = category;
    } else if (isHeaderLine(trimmed)) {
      current = null;
    }
  }
  return collected;
}

/** Build the localized What's New digest for all versions since `previousRaw` up to `currentRaw`. */
export function buildWhatsNewDigest(
  markdown: string,
  currentRaw: string,
  previousRaw: string | undefined,
  language: LanguageId,
): WhatsNewDigest | null {
  const current = parseAppVersion(currentRaw);
  if (!current || !markdown) return null;

  const previous = previousRaw ? parseAppVersion(previousRaw) : null;
  const matched = matchingChangelogEntries(parseChangelog(markdown), current, previous);
  if (matched.length === 0) return null;

  const categories: Record<ReleaseNoteCategory, string[]> = {
    newFeatures: [],
    bugFixes: [],
    refinements: [],
  };
  const seenBullets: Record<ReleaseNoteCategory, Set<string>> = {
    newFeatures: new Set(),
    bugFixes: new Set(),
    refinements: new Set(),
  };

  for (const entry of matched) {
    const notes = selectedReleaseNotes(entry.body, language);
    const parsed = parseReleaseNotesDigest(notes);
    for (const category of RELEASE_NOTE_CATEGORIES) {
      for (const bullet of parsed[category]) {
        const key = bullet.toLowerCase();
        if (!seenBullets[category].has(key)) {
          seenBullets[category].add(key);
          categories[category].push(bullet);
        }
      }
    }
  }

  const total =
    categories.newFeatures.length +
    categories.bugFixes.length +
    categories.refinements.length;
  if (total === 0) return null;

  const oldest = matched[matched.length - 1]?.versionText;
  return {
    displayVersion: currentRaw,
    versionCount: matched.length,
    ...(oldest ? { oldestIncludedVersion: oldest } : {}),
    categories,
  };
}

/** Build both English and Simplified Chinese What's New digests for AppInfo. */
export function buildWhatsNewInfo(
  markdown: string | undefined,
  currentRaw: string,
  previousRaw: string | undefined,
): WhatsNewInfo | undefined {
  if (!markdown) return undefined;
  const en = buildWhatsNewDigest(markdown, currentRaw, previousRaw, "en");
  const zh = buildWhatsNewDigest(markdown, currentRaw, previousRaw, "zh-Hans");
  if (!en && !zh) return undefined;
  return {
    en: en ?? zh!,
    "zh-Hans": zh ?? en!,
  };
}

/**
 * Tracks version upgrades across launches (mirrors upstream WhatsNew.recordLaunch).
 * Existing users upgrading onto a build with this feature for the first time see
 * the current version's notes; fresh installs start marked seen.
 */
export function recordWhatsNewLaunch(
  settings: Settings,
  currentRaw: string,
  isExistingUser: boolean,
): boolean {
  const current = parseAppVersion(currentRaw);
  if (!current) return false;

  let changed = false;
  const installedRaw = settings.whatsNewInstalledVersion;
  if (installedRaw !== undefined) {
    const installed = parseAppVersion(installedRaw);
    if (installed && compareAppVersions(installed, current) < 0) {
      if (settings.whatsNewPreviousVersion !== installedRaw) {
        settings.whatsNewPreviousVersion = installedRaw;
        changed = true;
      }
    }
  } else if (isExistingUser) {
    if (settings.whatsNewPreviousVersion !== undefined) {
      delete settings.whatsNewPreviousVersion;
      changed = true;
    }
  } else if (settings.whatsNewSeenVersion !== currentRaw) {
    settings.whatsNewSeenVersion = currentRaw;
    changed = true;
  }

  if (settings.whatsNewInstalledVersion !== currentRaw) {
    settings.whatsNewInstalledVersion = currentRaw;
    changed = true;
  }
  return changed;
}

export function hasWhatsNewContent(digest: WhatsNewDigest | null | undefined): boolean {
  if (!digest || digest.versionCount <= 0) return false;
  return (
    digest.categories.newFeatures.length > 0 ||
    digest.categories.bugFixes.length > 0 ||
    digest.categories.refinements.length > 0
  );
}

export function isWhatsNewUnread(
  digest: WhatsNewDigest | null | undefined,
  settings: Pick<Settings, "whatsNewSeenVersion">,
): boolean {
  return Boolean(
    digest && hasWhatsNewContent(digest) && settings.whatsNewSeenVersion !== digest.displayVersion,
  );
}

export function whatsNewSummaryLine(
  digest: WhatsNewDigest,
  t: (key: string, ...vars: string[]) => string,
): string {
  const parts: string[] = [];
  if (digest.versionCount > 1) {
    parts.push(t("%d versions", String(digest.versionCount)));
  }
  const counts: [ReleaseNoteCategory, number, string, string][] = [
    ["newFeatures", digest.categories.newFeatures.length, "1 new feature", "%d new features"],
    ["bugFixes", digest.categories.bugFixes.length, "1 fix", "%d fixes"],
    ["refinements", digest.categories.refinements.length, "1 refinement", "%d refinements"],
  ];
  for (const [, count, oneKey, manyKey] of counts) {
    if (count <= 0) continue;
    parts.push(count === 1 ? t(oneKey) : t(manyKey, String(count)));
  }
  return parts.join(" · ");
}
