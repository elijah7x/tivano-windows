// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-31 (frozen MarkdownLinkTarget): a chat markdown link resolves to a
// web URL, an existing local file, or a missing path. Local paths
// resolve against the chat's working directory (`markdownLinkBase`),
// `~` expands, and a trailing `:line` or `:line:column` is stripped
// only when what is left is an existing file.

import { homedir } from "node:os";
import { win32 as pathWin32 } from "node:path";

export type MarkdownLinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "missing" };

/** What the caller's filesystem reports for one absolute path. */
export type MarkdownLinkStat = "file" | "dir" | "none";

/** Frozen `resolve`: a scheme-bearing URL that is not `file` opens on
 *  the web, EXCEPT a host-less pseudo-scheme (`Foo.swift:12` parses
 *  with scheme `Foo.swift`) whose raw string names an existing file —
 *  the local file wins. Bare paths and `file:` URLs take the path
 *  resolver. Windows additions frozen never needed: a drive-letter
 *  (`C:\x`) or UNC (`\\s\x`) prefix parses as a scheme/authority, so
 *  both take the path resolver first. */
export function resolveMarkdownLinkTarget(
  href: string,
  base: string | undefined,
  stat: (path: string) => MarkdownLinkStat,
): MarkdownLinkTarget {
  const raw = href.trim();
  if (raw === "") return { kind: "missing" };
  if (!isWindowsAbsoluteLike(raw)) {
    const url = tryUrl(raw);
    if (url !== null) {
      if (url.protocol === "file:") {
        const path = fileUrlPath(url);
        return path === null ? { kind: "missing" } : resolveLocalPath(path, base, stat);
      }
      // Frozen: `url.host == nil` marks the pseudo-scheme case — the
      // authority check keeps `https://h/x` from ever reading as a path.
      if (url.host === "") {
        const local = resolveLocalPath(raw, base, stat);
        if (local.kind === "file") return local;
      }
      return { kind: "web", url: raw };
    }
  }
  return resolveLocalPath(raw, base, stat);
}

function isWindowsAbsoluteLike(raw: string): boolean {
  // `C:\x`, `C:/x`, `\\server\share`, `\\?\C:\x` — each parses with a
  // scheme or authority under WHATWG rules but is a filesystem path.
  return /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
}

function tryUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** `file:///C:/x` -> `C:\x`, `file://server/share` -> `\\server\share`,
 *  `file:///x` -> `\x` (drive-relative to the base, like upstream's `/x`
 *  being root-relative). */
function fileUrlPath(url: URL): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).replace(/\//g, "\\");
  } catch {
    // A malformed percent-escape throws URIError — a bad file URL just
    // beeps like a missing path (frozen `resolve` returning nil).
    return null;
  }
  if (url.host !== "" && url.host.toLowerCase() !== "localhost") {
    return `\\\\${url.host}${decoded}`;
  }
  return decoded.replace(/^\\(?=[a-zA-Z]:)/, "");
}

/** Frozen path half of `resolve`: `~` expands, a non-absolute path
 *  joins `base`, an existing path (file OR directory) opens, then the
 *  `:line[:column]` strip — each candidate must be an existing file. */
function resolveLocalPath(
  rawPath: string,
  base: string | undefined,
  stat: (path: string) => MarkdownLinkStat,
): MarkdownLinkTarget {
  let path = expandTilde(rawPath);
  if (!pathWin32.isAbsolute(path)) {
    if (base === undefined || base === "") return { kind: "missing" };
    path = pathWin32.resolve(expandTilde(base), path);
  } else {
    path = pathWin32.resolve(path);
  }
  if (stat(path) !== "none") return { kind: "file", path };
  const stripped = stripLineColumnSuffix(path, stat);
  if (stripped !== undefined) return { kind: "file", path: stripped };
  return { kind: "missing" };
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return homedir() + path.slice(1);
  }
  return path;
}

/** Frozen `stripLineColumnSuffix`: peel one positive `:N`, then a
 *  second — each candidate must exist as a file (never a directory).
 *  A drive-colon never peels: `C:\x` has no all-digit suffix anyway. */
function stripLineColumnSuffix(
  path: string,
  stat: (path: string) => MarkdownLinkStat,
): string | undefined {
  const first = stripPositiveTrailingNumber(path);
  if (first === undefined) return undefined;
  if (stat(first) === "file") return first;
  const second = stripPositiveTrailingNumber(first);
  if (second !== undefined && stat(second) === "file") return second;
  return undefined;
}

function stripPositiveTrailingNumber(path: string): string | undefined {
  const colon = path.lastIndexOf(":");
  if (colon < 0) return undefined;
  const digits = path.slice(colon + 1);
  if (digits === "" || !/^\d+$/.test(digits)) return undefined;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const stripped = path.slice(0, colon);
  if (stripped === "" || /[/\\]$/.test(stripped)) return undefined;
  return stripped;
}
