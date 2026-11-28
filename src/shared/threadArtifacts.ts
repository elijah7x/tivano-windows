// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-41 Toolbox outputs (v3.0.26 ThreadArtifacts.swift): classify and
// collect the documents, webpages, images and videos a chat produced.
// Only paths the chat itself names are considered — assistant/plan text,
// edit tool rows and per-turn touched paths — newest first; nothing scans
// a directory. Path handling takes an explicit win32/posix API so Windows
// drive, backslash and file:/// forms are testable on any host.

import type { posix } from "node:path";

export type PathApi = typeof posix;

export type ArtifactKind = "document" | "webpage" | "image" | "video";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["document", "webpage", "image", "video"];

/** Renderer-facing row: an opaque id, never an absolute path to act on. */
export interface ThreadArtifactItem {
  id: string;
  name: string;
  /** Project-relative path, or the absolute/home-abbreviated location. */
  displayPath: string;
  /** Forward-slash project-relative path for @ reference; absent outside it. */
  mentionPath?: string;
  kind: ArtifactKind;
  turnIndex?: number;
  size?: number;
}

export interface ResolvedArtifact extends Omit<ThreadArtifactItem, "id"> {
  path: string;
}

export const ARTIFACT_LIMIT = 200;
/** Upper bound on candidate paths checked against the filesystem per list. */
export const ARTIFACT_STAT_LIMIT = 2000;
const TEXT_SCAN_LIMIT = 64 * 1024;

const EXTENSIONS: Record<ArtifactKind, ReadonlySet<string>> = {
  document: new Set([
    "md", "markdown", "mdx", "pdf", "txt", "rtf", "rtfd", "csv", "tsv", "doc", "docx",
    "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "epub",
  ]),
  webpage: new Set(["html", "htm", "xhtml", "mhtml", "webarchive"]),
  image: new Set([
    "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif", "svg",
  ]),
  video: new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"]),
};

const EXCLUDED_SEGMENTS = ["build.noindex", "DerivedData", ".build", "node_modules", ".git"];

const REMOTE_PREFIXES = [
  "http://", "https://", "ws://", "wss://", "ftp://", "mailto:", "data:", "javascript:",
  "about:", "tel:", "localhost:", "127.0.0.1:", "[::1]:",
];

const MARKDOWN_LINK = /\]\(\s*(?:<([^>\n]+)>|([^)\s\n]+))/g;
const BACKTICK = /`([^`\n]+)`/g;
const STOP = "\\s<>()\\[\\]{}\"'`,;!?*，。、；：！？（）【】《》「」『』“”‘’";
const PLAIN_PATH = new RegExp(
  `(?:file:\\/\\/\\/?|~|\\.{1,2}|[A-Za-z]:)?(?:[^${STOP}]+[\\/\\\\])*[^${STOP}\\/\\\\]+\\.[A-Za-z0-9]{2,11}(?::\\d+(?::\\d+)?)?`,
  "g",
);

function stripLineColumn(path: string): string {
  let out = path;
  for (let i = 0; i < 2; i++) {
    const m = /^(.*[^/\\:]):(\d+)$/.exec(out);
    if (!m || /^[A-Za-z]$/.test(m[1]!)) break;
    out = m[1]!;
  }
  return out;
}

/** Strip wrappers, file:// URLs, fragments, queries and :line:col; null for remote targets. */
export function cleanArtifactPath(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.length > 2 && s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
  if (s.length > 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))))
    s = s.slice(1, -1);
  const lower = s.toLowerCase();
  if (lower.startsWith("file://")) {
    s = s.slice("file://".length);
    // file:///C:/x → C:/x ; file:///home/x → /home/x
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep the raw form */
    }
  } else {
    if (s.includes("://")) return null;
    if (REMOTE_PREFIXES.some((p) => lower.startsWith(p))) return null;
  }
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  const query = s.indexOf("?");
  if (query >= 0) s = s.slice(0, query);
  s = stripLineColumn(s);
  return s || null;
}

export function artifactKind(raw: string): ArtifactKind | null {
  const cleaned = cleanArtifactPath(raw);
  if (!cleaned) return null;
  const base = cleaned.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  for (const kind of ARTIFACT_KINDS) if (EXTENSIONS[kind].has(ext)) return kind;
  return null;
}

/** Markdown link targets, backtick spans and bare path-like tokens. */
export function extractArtifactPaths(text: string): string[] {
  if (!text) return [];
  const src = text.length > TEXT_SCAN_LIMIT ? text.slice(0, TEXT_SCAN_LIMIT) : text;
  const out: string[] = [];
  for (const m of src.matchAll(MARKDOWN_LINK)) {
    const target = m[1] ?? m[2];
    if (target && artifactKind(target)) out.push(target);
  }
  for (const m of src.matchAll(BACKTICK)) {
    const c = m[1]!.trim();
    if (artifactKind(c)) out.push(c);
  }
  for (const m of src.matchAll(PLAIN_PATH)) {
    if (artifactKind(m[0])) out.push(m[0]);
  }
  return [...new Set(out)];
}

export interface ArtifactSourceMessage {
  role: "user" | "assistant" | "system";
  content: string;
  turnId?: string | undefined;
  kind?: string | undefined;
  tool?: { kind: string; title?: string | undefined } | undefined;
}

export interface ArtifactCandidate {
  raw: string;
  turnIndex?: number;
}

/** Newest-first candidate list (frozen collect order): each message from the
 *  end, then the touched paths of its turn the first time that turn is seen,
 *  then touched paths of turns no message referenced. */
export function collectArtifactCandidates(input: {
  messages: readonly ArtifactSourceMessage[];
  touchedByTurn: ReadonlyMap<string, readonly string[]>;
}): ArtifactCandidate[] {
  const turnIndex = new Map<string, number>();
  for (const m of input.messages)
    if (m.turnId !== undefined && !turnIndex.has(m.turnId)) turnIndex.set(m.turnId, turnIndex.size);
  for (const id of input.touchedByTurn.keys()) if (!turnIndex.has(id)) turnIndex.set(id, turnIndex.size);

  const out: ArtifactCandidate[] = [];
  const visited = new Set<string>();
  const push = (raw: string, turnId: string | undefined) => {
    const idx = turnId === undefined ? undefined : turnIndex.get(turnId);
    out.push(idx === undefined ? { raw } : { raw, turnIndex: idx });
  };
  const touched = (turnId: string | undefined) => {
    if (turnId === undefined || visited.has(turnId)) return;
    visited.add(turnId);
    const paths = input.touchedByTurn.get(turnId) ?? [];
    for (let i = paths.length - 1; i >= 0; i--) push(paths[i]!, turnId);
  };

  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]!;
    if (m.role === "assistant" || (m.role === "system" && m.kind === "plan")) {
      for (const c of extractArtifactPaths(m.content)) push(c, m.turnId);
    } else if (m.role === "system" && m.kind === "tool" && m.tool?.kind === "edit" && m.tool.title) {
      push(m.tool.title, m.turnId);
    }
    touched(m.turnId);
  }
  const rest = [...input.touchedByTurn.keys()].filter((id) => !visited.has(id)).reverse();
  for (const id of rest) touched(id);
  return out;
}

export interface ResolveOptions {
  pathApi: PathApi;
  workingDirectory: string | null;
  home: string | null;
  /** Size of an existing regular file, or null when missing / not a file. */
  statFile(path: string): number | null;
  limit?: number;
  statLimit?: number;
}

function resolveCandidate(raw: string, opts: ResolveOptions): string | null {
  const cleaned = cleanArtifactPath(raw);
  if (!cleaned) return null;
  const p = opts.pathApi;
  let abs: string;
  if (cleaned === "~" || cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    if (!opts.home) return null;
    abs = p.join(opts.home, cleaned.slice(1));
  } else if (p.isAbsolute(cleaned) && !(p === p.win32 && /^[\\/](?![\\/])/.test(cleaned))) {
    abs = cleaned;
  } else if (opts.workingDirectory) {
    abs = p.join(opts.workingDirectory, cleaned);
  } else {
    return null;
  }
  return p.resolve(abs);
}

function inside(p: PathApi, root: string, path: string): string | null {
  const rel = p.relative(root, path);
  if (!rel || rel.startsWith("..") || p.isAbsolute(rel)) return null;
  return rel;
}

/** Turn candidates into existing, de-duplicated, bounded artifact rows. */
export function resolveArtifacts(
  candidates: readonly ArtifactCandidate[],
  opts: ResolveOptions,
): ResolvedArtifact[] {
  const p = opts.pathApi;
  const fold = (s: string) => (p === p.win32 ? s.toLowerCase() : s);
  const limit = opts.limit ?? ARTIFACT_LIMIT;
  let stats = opts.statLimit ?? ARTIFACT_STAT_LIMIT;
  const root = opts.workingDirectory ? p.resolve(opts.workingDirectory) : null;
  const seen = new Set<string>();
  const out: ResolvedArtifact[] = [];
  for (const c of candidates) {
    if (out.length >= limit || stats <= 0) break;
    const kind = artifactKind(c.raw);
    if (!kind) continue;
    const variants = [c.raw];
    try {
      const decoded = decodeURIComponent(c.raw);
      if (decoded !== c.raw) variants.push(decoded);
    } catch {
      /* not percent-encoded */
    }
    for (const v of variants) {
      const path = resolveCandidate(v, opts);
      if (!path) continue;
      const segments = path.split(/[\\/]/);
      if (EXCLUDED_SEGMENTS.some((s) => segments.includes(s))) continue;
      const key = fold(path);
      if (seen.has(key)) break;
      seen.add(key);
      stats--;
      const size = opts.statFile(path);
      if (size === null) continue;
      const rel = root ? inside(p, root, path) : null;
      let displayPath = path;
      if (rel === null && opts.home) {
        const homeRel = inside(p, p.resolve(opts.home), path);
        if (homeRel !== null) displayPath = `~${p.sep}${homeRel}`;
      }
      out.push({
        path,
        name: p.basename(path),
        displayPath: rel ?? displayPath,
        ...(rel !== null ? { mentionPath: rel.split(p.sep).join("/") } : {}),
        kind,
        ...(c.turnIndex !== undefined ? { turnIndex: c.turnIndex } : {}),
        ...(size > 0 ? { size } : {}),
      });
      break;
    }
  }
  return out;
}
