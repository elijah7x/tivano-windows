// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Git runtime resolution — trusted-main decisions only, resolved ONCE at
// bootstrap and then pinned. POSIX keeps the platform Git convention
// (/usr/bin/git). Windows resolves a real Git for Windows git.exe from
// exactly three places, in order:
//
//   1. TIVANO_GIT_EXECUTABLE — an explicit ABSOLUTE path. Anything that is
//      not a real regular *.exe file named git.exe is "git-config-invalid"
//      — an invalid explicit configuration NEVER falls back to a
//      different executable silently.
//   2. Standard Git for Windows install roots (ProgramFiles /
//      ProgramFiles(x86) / ProgramW6432 / LocalAppData\Programs) at their
//      canonical <root>\Git\cmd\git.exe.
//   3. The startup PATH, but ONLY its absolute directories — relative,
//      empty or "." entries are skipped, and the lookup is a literal
//      <dir>\git.exe file check: no PATHEXT expansion, no .cmd/.bat/
//      PowerShell/sh resolution, no cwd search, ever.
//
// The resolved executable is then verified to be a real regular file
// (lstat — links rejected) and its PHYSICAL path is what gets launched.
// Nothing here reads repository config, user/global Git config, account
// data or credentials — resolution is a filesystem check only.
// A resolved executable still requires the packaged job-helper's --run
// capability before any Windows Git spawn is attempted (see index.ts).

import { lstatSync, realpathSync } from "node:fs";

export const GIT_POSIX_EXECUTABLE = "/usr/bin/git";

export type GitExecutableSource =
  | "posix"
  | "env" // explicit TIVANO_GIT_EXECUTABLE
  | "standard" // standard Git-for-Windows install root
  | "path"; // absolute PATH directory

export type GitRuntime =
  | { kind: "resolved"; executable: string; source: GitExecutableSource }
  | {
      kind: "unavailable";
      /** Stable machine reason — the UI maps it, never the detail text. */
      reason: "no-git" | "git-config-invalid";
      detail: string;
    };

/** Environment-bag access for Windows-style case-insensitive lookup —
 *  the caller hands in process.env at bootstrap; tests hand in literals. */
export type GitRuntimeSource = Record<string, string | undefined>;

/** Windows absolute path: `C:\…`, `C:/…`, UNC `\\server\share` or
 *  device-prefixed `\\?\…` — Node's isAbsolute is platform-shaped, so the
 *  Windows check is explicit (this code also runs under host tests that
 *  only SIMULATE win32). */
const WIN_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
export const winIsAbsolute = (p: string): boolean => WIN_ABSOLUTE.test(p);

export interface GitRuntimeFs {
  /** Real regular file, not a link/junction — false on ANY failure. */
  existsFile(path: string): boolean;
  /** Physical path (links resolved); throws on failure. */
  realpath(path: string): string;
}

const defaultFs: GitRuntimeFs = {
  existsFile: (p) => {
    try {
      const st = lstatSync(p);
      return st.isFile() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  },
  realpath: (p) => realpathSync(p),
};

const envValue = (source: GitRuntimeSource, name: string): string | null => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(source))
    if (k.toLowerCase() === want && typeof v === "string") return v;
  return null;
};

/** Standard Git for Windows install candidates, in preference order.
 *  ProgramFiles* roots carry <root>\Git; the LOCALAPPDATA root carries
 *  <root>\Programs\Git — the distinction is the variable NAME, never a
 *  guess from the path value. */
function standardGitCandidates(source: GitRuntimeSource): string[] {
  const out: string[] = [];
  for (const [name, suffix] of [
    ["ProgramFiles", "\\Git\\cmd\\git.exe"],
    ["ProgramFiles(x86)", "\\Git\\cmd\\git.exe"],
    ["ProgramW6432", "\\Git\\cmd\\git.exe"],
    ["LOCALAPPDATA", "\\Programs\\Git\\cmd\\git.exe"],
  ] as const) {
    const v = envValue(source, name);
    if (v && winIsAbsolute(v)) out.push(`${v.replace(/[\\/]+$/, "")}${suffix}`);
  }
  return out;
}

function checkCandidate(
  candidate: string,
  fs: GitRuntimeFs,
): { ok: true; real: string } | { ok: false; why: string } {
  if (!winIsAbsolute(candidate) || candidate.includes("\0"))
    return { ok: false, why: "not an absolute path" };
  if (!/\\git\.exe$/i.test(candidate.replace(/\//g, "\\")))
    return { ok: false, why: "must name git.exe" };
  if (!fs.existsFile(candidate)) return { ok: false, why: "not a real regular file" };
  try {
    return { ok: true, real: fs.realpath(candidate) };
  } catch {
    return { ok: false, why: "cannot resolve path" };
  }
}

/**
 * Resolve the Git executable once. `source` is the main-process
 * environment snapshot — never renderer input, never persisted settings.
 */
export function resolveGitExecutable(
  source: GitRuntimeSource,
  opts: { platform?: NodeJS.Platform; fs?: Partial<GitRuntimeFs> } = {},
): GitRuntime {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32")
    return { kind: "resolved", executable: GIT_POSIX_EXECUTABLE, source: "posix" };

  const fs: GitRuntimeFs = { ...defaultFs, ...(opts.fs ?? {}) };

  // 1. Explicit configuration — invalid means UNAVAILABLE, not fallback.
  const explicit = envValue(source, "TIVANO_GIT_EXECUTABLE");
  if (explicit !== null) {
    const r = checkCandidate(explicit, fs);
    if (!r.ok)
      return {
        kind: "unavailable",
        reason: "git-config-invalid",
        detail: `TIVANO_GIT_EXECUTABLE is not a usable git.exe (${r.why}): ${explicit}`,
      };
    return { kind: "resolved", executable: r.real, source: "env" };
  }

  // 2. Standard install roots.
  for (const candidate of standardGitCandidates(source)) {
    const r = checkCandidate(candidate, fs);
    if (r.ok) return { kind: "resolved", executable: r.real, source: "standard" };
  }

  // 3. Startup PATH — absolute directories only, literal git.exe lookup.
  const pathEnv = envValue(source, "PATH");
  if (pathEnv) {
    for (const raw of pathEnv.split(";")) {
      const dir = raw.trim();
      if (!dir || dir === "." || !winIsAbsolute(dir)) continue;
      const candidate = `${dir.replace(/[\\/]+$/, "")}\\git.exe`;
      const r = checkCandidate(candidate, fs);
      if (r.ok) return { kind: "resolved", executable: r.real, source: "path" };
    }
  }

  return {
    kind: "unavailable",
    reason: "no-git",
    detail:
      "no Git for Windows executable found (TIVANO_GIT_EXECUTABLE unset; " +
      "no standard install; no absolute PATH entry contains git.exe)",
  };
}
