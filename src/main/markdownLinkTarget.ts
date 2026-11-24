// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-31 (frozen MarkdownLinkTarget): a chat markdown link resolves to a
// web URL, an existing local file, or a missing path. Local paths
// resolve against the chat's working directory (`markdownLinkBase`),
// `~` expands, and a trailing `:line` or `:line:column` is stripped
// only when what is left is an existing file.

import { homedir } from "node:os";
import nodePath from "node:path";

export type MarkdownLinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "missing" };

/** What the caller's filesystem reports for one absolute path. */
export type MarkdownLinkStat = "file" | "dir" | "none";

/** The path semantics the resolver runs under — `node:path` in
 *  production (win32 on this host); tests on other platforms inject
 *  `node:path.win32` for Windows semantics or `node:path.posix` for
 *  theirs. */
export type MarkdownLinkPaths = Pick<
  typeof nodePath,
  "isAbsolute" | "resolve"
>;

/** Windows executables/shortcuts/launchers a disguised markdown link
 *  must never hand to `shell.openPath` — opening any of these can run
 *  code or fetch a payload. They beep like a missing path. */
const EXECUTABLE_EXTS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".msp", ".scr", ".pif",
  ".vbs", ".vbe", ".wsf", ".wsh", ".hta", ".cpl", ".msc", ".lnk",
  ".url", ".reg",
  // Stock-Windows script/launch verbs that RUN on the plain open
  // action: .js/.jse execute via wscript, .chm can carry shortcut
  // payloads, and .jar/.ps1 execute wherever their runtime owns the
  // association — a link must never reach shell.openPath with one.
  ".js", ".jse", ".chm", ".jar", ".ps1",
]);

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
  paths: MarkdownLinkPaths = nodePath,
): MarkdownLinkTarget {
  const raw = href.trim();
  if (raw === "") return { kind: "missing" };
  if (!isWindowsAbsoluteLike(raw)) {
    const url = tryUrl(raw);
    if (url !== null) {
      if (url.protocol === "file:") {
        const path = fileUrlPath(url);
        return path === null
          ? { kind: "missing" }
          : resolveLocalPath(path, base, stat, paths);
      }
      // Frozen: `url.host == nil` marks the pseudo-scheme case — the
      // authority check keeps `https://h/x` from ever reading as a path.
      if (url.host === "") {
        const local = resolveLocalPath(
          decodePathEscapes(raw),
          base,
          stat,
          paths,
        );
        if (local.kind === "file") return local;
      }
      return { kind: "web", url: raw };
    }
  }
  return resolveLocalPath(decodePathEscapes(raw), base, stat, paths);
}

/** The renderer forbids literal whitespace in link targets, so a local
 *  path with spaces arrives percent-encoded (`my%20dir/a.txt`). Frozen
 *  decodes via `removingPercentEncoding`, which leaves malformed
 *  escapes alone — decode each maximal run of %XX pairs and keep
 *  anything else verbatim (a stray `%` stays literal). */
function decodePathEscapes(raw: string): string {
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
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
 *  `:line[:column]` strip — each candidate must be an existing file.
 *  Windows refusals frozen never needed: a UNC share or non-drive
 *  device-namespace path is never statted or opened — a synchronous
 *  stat would block main on SMB and `shell.openPath` on `\\host\…`
 *  leaks NTLM credentials and can execute a remote share's files —
 *  and a link that names an executable/shortcut extension never opens. */
function resolveLocalPath(
  rawPath: string,
  base: string | undefined,
  stat: (path: string) => MarkdownLinkStat,
  paths: MarkdownLinkPaths,
): MarkdownLinkTarget {
  let path = expandTilde(rawPath);
  if (isUncPath(path)) return { kind: "missing" };
  // Drive-form device spellings (`\\?\C:\x`, `\\.\C:\x`) are absolute
  // drive paths — strip the namespace prefix before the rooted check,
  // which would otherwise treat them as driveless.
  const device = path.match(/^\\\\[.?]\\([a-zA-Z]:[\\/].*)$/);
  if (device !== null && device[1] !== undefined) path = device[1];
  if (/^[\\/]/.test(path)) {
    // A rooted but driveless path (`\x`, `/x`) resolves on the BASE's
    // drive — `isAbsolute` counts it absolute on win32, so without this
    // branch it would silently anchor to the process cwd's drive.
    if (base === undefined || base === "") return { kind: "missing" };
    path = paths.resolve(expandTilde(base), path);
  } else if (!paths.isAbsolute(path)) {
    if (base === undefined || base === "") return { kind: "missing" };
    path = paths.resolve(expandTilde(base), path);
  } else {
    path = paths.resolve(path);
  }
  if (isUncPath(path)) return { kind: "missing" };
  const st = stat(path);
  // A directory hit opens in Explorer regardless of its extension —
  // the exec deny list guards launches, not folders named `tools.com`.
  if (st === "dir") return { kind: "file", path };
  if (isExecutablePath(path)) return { kind: "missing" };
  if (st === "file") return { kind: "file", path };
  const stripped = stripLineColumnSuffix(path, stat);
  if (stripped !== undefined && !isExecutablePath(stripped))
    return { kind: "file", path: stripped };
  return { kind: "missing" };
}

/** `\\host\share` (also `//host/x` after resolve, and `file://host/x`
 *  via fileUrlPath) is network-shaped and refused outright — one click
 *  must not block main on SMB, leak NTLM, or launch a remote file.
 *  Only drive-form device spellings (`\\?\C:\x`, `\\.\C:\x`) are the
 *  local namespace; `\\?\UNC\host\…` and `\\?\GLOBALROOT\Device\Mup\…`
 *  are UNC in disguise and refused with the rest. */
function isUncPath(path: string): boolean {
  if (!path.startsWith("\\\\")) return false;
  return !/^\\\\[.?]\\[a-zA-Z]:[\\/]/.test(path);
}

/** Lower-case extension check — `.\x\APP.EXE` refuses the same as
 *  `app.exe`; a directory hit is still opened (the exec check guards
 *  `shell.openPath`, and opening a directory launches Explorer). */
function isExecutablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return EXECUTABLE_EXTS.has(path.slice(dot).toLowerCase());
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
