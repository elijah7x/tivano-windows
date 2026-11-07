// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Process-tree ownership for REAL provider launches. A real Codex child may
// create descendants (the official npm wrapper itself spawns children), so
// "the direct pid exited" or "kill() returned true" is never proof of a
// reclaimed tree. The only mechanism this phase accepts is a Windows Job
// Object owned by a dedicated helper:
//
//   Job created first → payload launched with PROC_THREAD_ATTRIBUTE_JOB_LIST
//   (atomic assignment — no suspended-create window) → the helper proxies
//   stdio and holds the only Job handle; KILL_ON_JOB_CLOSE plus no
//   breakaway flags mean helper death OR owner death tears the tree down.
//
// The helper passed native Windows Server 2022 x64 component tests.
// Packaged attestation (packagedJobHelper.ts) is now the ONLY route to a
// supported verdict: it verifies the build-pinned exe inside the packaged
// resources root and runs a bounded --version probe. This file's
// environment-path probe stays fail-closed — a configured file is never
// evidence, and TIVANO_CODEX_JOB_HELPER cannot mint support. The offline
// fixture uses a single controlled, childless process and does not need
// this layer.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { SpawnImpl, SpawnSpec } from "./stdioTransport";

export const PROCESS_TREE_UNSUPPORTED = "PROCESS_TREE_UNSUPPORTED";

export class ProcessTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessTreeError";
  }
}

export interface ProcessTreeCapability {
  /** true only when real launches may proceed. */
  supported: boolean;
  platform: NodeJS.Platform;
  /** "windows-job-object" when supported. */
  mechanism?: "windows-job-object";
  /** Human/explainable reason when unsupported. */
  reason?: string;
  /** Resolved helper path when configured. */
  helperPath?: string;
  /** Attested helper version — set only on a supported packaged verdict. */
  helperVersion?: string;
  /** true when the attested helper advertises the --run exit-code mode
   *  (runExitBase/runExitMax contract). REQUIRED by the Windows Git
   *  runner — an older helper keeps serving the Codex path but can never
   *  carry Git runs. */
  runCapable?: boolean;
  /** true when the attested helper advertises the ConPTY terminal host
   *  (conpty-terminal mechanism + terminalSpec 1). REQUIRED by the
   *  Windows terminal validation candidate — an older helper keeps
   *  serving Codex/Git but can never host a terminal. */
  terminalCapable?: boolean;
}

export interface ProcessTreeProbeOptions {
  platform?: NodeJS.Platform;
  /** Absolute path to the job-helper executable (win32 only). */
  helperPath?: string | null;
  /** lstat/existence check seam for tests. */
  helperExists?: (path: string) => boolean;
}

function defaultHelperExists(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Main-process verdict: may a REAL provider process be launched such that
 * its whole tree is provably reclaimable? This is the ONLY authority —
 * renderer flags, env toggles and persisted config can never unlock a real
 * launch.
 *
 * This ENVIRONMENT-path probe remains permanently fail-closed: a file on
 * disk — wherever it came from — is never evidence. The only route to
 * supported:true is probeAndAttestPackagedJobHelper (packagedJobHelper.ts):
 * the build-pinned exe inside the packaged resources root plus a bounded
 * --version contract probe. No environment flag, renderer value or
 * arbitrary file can enable a real launch.
 */
export function probeProcessTreeSupport(opts: ProcessTreeProbeOptions = {}): ProcessTreeCapability {
  const platform = opts.platform ?? process.platform;
  const helperPath = opts.helperPath ?? null;
  const base = { supported: false as const, platform };
  if (platform !== "win32") {
    return {
      ...base,
      reason:
        "PROCESS_TREE_UNSUPPORTED: process-tree ownership requires Windows Job Objects; " +
        "POSIX group/session cleanup is not a verified boundary in this phase",
    };
  }
  if (!helperPath || !isAbsolute(helperPath) || helperPath.includes("\0")) {
    return {
      ...base,
      reason:
        "PROCESS_TREE_UNSUPPORTED: no absolute job-helper path configured " +
        "(TIVANO_CODEX_JOB_HELPER)",
    };
  }
  const exists = (opts.helperExists ?? defaultHelperExists)(helperPath);
  if (!exists) {
    return {
      ...base,
      reason: `PROCESS_TREE_UNSUPPORTED: job-helper is not a real file: ${helperPath}`,
      helperPath,
    };
  }
  let resolved = helperPath;
  try {
    resolved = realpathSync(helperPath);
  } catch {
    return {
      ...base,
      reason: `PROCESS_TREE_UNSUPPORTED: job-helper path cannot be resolved: ${helperPath}`,
      helperPath,
    };
  }
  // Native component evidence does not attest an arbitrary configured file
  // or prove the application's lifecycle integration.
  return {
    ...base,
    reason:
      "PROCESS_TREE_UNSUPPORTED: job-helper exists on disk but has no verified " +
      "application integration — real launches stay disabled pending attestation",
    helperPath: resolved,
  };
}

/**
 * SpawnImpl that launches the job-helper instead of the payload directly.
 * The helper receives the launch spec as one base64url JSON argument and
 * then becomes the byte proxy: its stdin/stdout/stderr ARE the payload's
 * stdio (raw byte forwarding, frame boundaries preserved). The transport
 * therefore owns exactly what it already owns — one child whose "close"
 * event the helper only emits after the Job reports empty (or after it
 * has failed loudly on stderr).
 *
 * Wire contract (helper argv) — spec v1, versioned:
 *   tivano-job-helper.exe --serve <base64url(JSON SpawnSpec)>
 *   SpawnSpec v1 = {"v":1,"ownerPid":<launcher pid>,"executable":..,
 *                   "args":[..],"cwd":..,"env":{..}}
 * Helper exit codes:
 *   0 = payload ended AND job provably empty
 *   2 = invalid request/spec — the payload NEVER ran
 *   3 = setup/ownership failure — the payload NEVER ran
 *   4 = job empty could not be confirmed within its bounded wait
 *   5 = CreateProcessW failed — the payload NEVER ran
 *   6 = payload nonzero OR terminated by the helper (payload-exit=<n>)
 * See helpers/win32/tivano-job-helper.cpp (Windows component tested; application integration pending)
 * and docs/phase-2c-windows-helper.md.
 */

/**
 * CreateProcessW lpCommandLine is documented at 32767 UTF-16 chars. The
 * helper's own command line is `"<helperPath>" --serve <base64url spec>`;
 * base64 expands JSON ~4/3×, so a spec at the helper's 32 KiB JSON bound
 * would NOT fit. The launcher must refuse here — before an impossible
 * helper spawn is attempted — instead of relying on the helper's own
 * spec-size check that can never be reached.
 */
const HELPER_CMDLINE_BUDGET = 32700;

function crtQuotedArgLen(arg: string): number {
  // Length of one argument as it appears in lpCommandLine after CRT
  // quoting: 2 quotes + content, with \\ → \\\\ only before a quote and
  // " → \" sequences. An upper bound is fine here (we reject anyway).
  let extra = 0;
  for (const ch of arg) if (ch === '"' || ch === "\\") extra += 1;
  return arg.length + extra + 2;
}

export function encodeJobHelperSpec(spec: SpawnSpec): string {
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      ownerPid: process.pid,
      executable: spec.executable,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
    }),
    "utf8",
  ).toString("base64url");
  return encoded;
}

/** Helper operating mode: "--serve" (byte-proxy, Codex), "--run"
 *  (exit-code channel, Git) or "--terminal" (ConPTY session host — its
 *  own TerminalSpec wire format and exit taxonomy). */
export type JobHelperMode = "serve" | "run" | "terminal";

/** The --run exit-code contract, defined ONCE here: a payload that exits
 *  naturally (no forced cleanup, Job proven empty, stdio drained, code
 *  provable and <=255) maps to BASE+code. These mirror the C++ helper's
 *  kRunExitBase/kRunExitMax and are asserted by packaged attestation. */
export const JOB_HELPER_RUN_EXIT_BASE = 1024;
export const JOB_HELPER_RUN_EXIT_MAX = 255;

/** Terminal-mode contract version advertised by the helper's --version
 *  (terminalSpec field) and required by the windowsTerminalHost adapter.
 *  Mirrors the C++ helper's th::kTerminalSpecVersion. */
export const JOB_HELPER_TERMINAL_SPEC_VERSION = 1;

/** The ConPTY terminal mechanism marker in the helper's mechanisms list. */
export const JOB_HELPER_CONPTY_MECHANISM = "conpty-terminal";

const modeFlag = (mode: JobHelperMode): string =>
  mode === "run" ? "--run" : mode === "terminal" ? "--terminal" : "--serve";

export function helperCommandLineFits(
  helperPath: string,
  encoded: string,
  mode: JobHelperMode = "serve",
): boolean {
  return (
    crtQuotedArgLen(helperPath) + 1 + modeFlag(mode).length + 1 + encoded.length <=
    HELPER_CMDLINE_BUDGET
  );
}

export function makeJobHelperSpawnImpl(
  helperPath: string,
  mode: JobHelperMode = "serve",
): SpawnImpl {
  return (spec: SpawnSpec): ChildProcess => {
    const encoded = encodeJobHelperSpec(spec);
    if (!helperCommandLineFits(helperPath, encoded, mode)) {
      throw new ProcessTreeError(
        `${PROCESS_TREE_UNSUPPORTED}: encoded launch spec exceeds the ` +
          `helper command-line budget (${HELPER_CMDLINE_BUDGET} chars) — ` +
          `refusing before an impossible CreateProcessW`,
      );
    }
    // The helper itself is spawned with a sterile environment — it builds
    // the payload environment exclusively from the spec.
    return spawn(helperPath, [modeFlag(mode), encoded], {
      cwd: spec.cwd,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
    });
  };
}

/** Files this phase ships for the Windows tree-cleanup boundary. */
export const JOB_HELPER_SOURCE = "helpers/win32/tivano-job-helper.cpp";
export const JOB_HELPER_BUILD_DOC = "helpers/win32/BUILD.md";
