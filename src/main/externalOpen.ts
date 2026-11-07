// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// External-open test seam (owner task upgrade-v2234-20261031T142344Z):
// every native external-open call — shell.openPath (Finder),
// shell.showItemInFolder, shell.openExternal (browser), editor spawns
// (Terminal) — routes through one main-owned recorder when the seam is
// armed, so regression runs exercise IPC/path validation and refusal
// handling WITHOUT launching host windows.
//
// Gating is deliberate and narrow — ALL required:
//   1. unpackaged build      — packaged apps always open for real
//   2. TIVANO_TEST_EXTERNAL_OPEN=<abs log path> — explicit test mode
//   3. dataRoot under the OS temp dir — the isolated test-root identity;
//      a project .devdata or real app-data root can never arm it
// A renderer cannot enable it (env is main-side) and cannot choose the
// output file (the path comes from the launch env, never IPC).

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export type ExternalOpenAction =
  | "openPath"
  | "showItemInFolder"
  | "openExternal"
  | "openWithEditor";

export interface ExternalOpenRecord {
  action: ExternalOpenAction;
  target: string;
  detail?: string;
}

/** Resolve the recorder's log path, or null when the seam must not arm. */
export function externalOpenLogPath(
  env: NodeJS.ProcessEnv,
  opts: { packaged: boolean; dataRoot: string },
): string | null {
  const v = env.TIVANO_TEST_EXTERNAL_OPEN;
  if (typeof v !== "string" || v.trim() === "" || !isAbsolute(v)) return null;
  if (opts.packaged) return null;
  const tmp = resolve(tmpdir()) + sep;
  const root = resolve(opts.dataRoot) + sep;
  if (!root.startsWith(tmp)) return null;
  return v;
}

/** Append one record line; swallow nothing — a log the test cannot
 *  read must fail loudly at the test, not silently pass here. */
export function recordExternalOpen(logPath: string, rec: ExternalOpenRecord): void {
  appendFileSync(logPath, JSON.stringify(rec) + "\n");
}
