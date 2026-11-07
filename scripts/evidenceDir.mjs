// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Evidence-directory resolution for e2e runs, isolated for testing.
// Rules: evidence never lives inside the source tree; an explicit
// E2E_EVIDENCE_DIR must be non-empty and is checked only after its
// physical (symlink-resolved) path is known; every run gets a fresh
// mkdtemp subdirectory — nothing is ever reused or cleared.

import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";

function isInside(base, p) {
  const rel = relative(base, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

/** Physical git common-dir for the checkout at `dir` (handles worktrees). */
export function findGitCommonDir(dir) {
  const dot = join(dir, ".git");
  if (!existsSync(dot)) return null;
  const st = lstatSync(dot);
  if (st.isDirectory()) return realpathSync(dot);
  if (st.isFile()) {
    const m = readFileSync(dot, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitdir = realpathSync(resolve(dir, m[1].trim()));
    // worktrees/<name> → the real common dir is two levels up
    if (basename(dirname(gitdir)) === "worktrees") return dirname(dirname(gitdir));
    return gitdir;
  }
  return null;
}

/**
 * Resolve a fresh, empty, out-of-source evidence directory.
 * @param {object} o
 * @param {string|undefined} o.explicit - E2E_EVIDENCE_DIR value; empty or
 *   whitespace-only is a hard error (an unset var falls back to git).
 * @param {string} o.sourceDir - the checkout root; compared physically.
 */
export function resolveEvidenceDir({ explicit, sourceDir }) {
  const realSource = realpathSync(sourceDir);
  if (explicit !== undefined && explicit !== null) {
    if (explicit.trim() === "")
      throw new Error("E2E_EVIDENCE_DIR is set but empty; unset it or give a real directory");
    const abs = resolve(explicit);
    mkdirSync(abs, { recursive: true });
    // Resolve AFTER creating: a directory (or ancestor) symlink pointing
    // into the source tree is only visible in the physical path.
    const real = realpathSync(abs);
    if (isInside(realSource, real))
      throw new Error(`E2E_EVIDENCE_DIR must not point inside the source tree: ${explicit}`);
    return mkdtempSync(join(real, "e2e-"));
  }
  const commonDir = findGitCommonDir(realSource);
  if (!commonDir)
    throw new Error(
      "no git common-dir to derive an out-of-source evidence dir; set E2E_EVIDENCE_DIR explicitly",
    );
  // Physical layout: <commonDir> = <checkout>/.git → artifacts root is the
  // checkout's PARENT. mkdtemp gives every run a fresh directory.
  return mkdtempSync(join(dirname(dirname(commonDir)), "tivano-win-e2e-"));
}
