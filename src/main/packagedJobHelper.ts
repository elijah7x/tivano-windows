// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Packaged job-helper attestation — the ONLY path by which a real provider
// launch may become supported. Three layers, all fail-closed:
//
//   1. SYNC candidate resolution: fixed packaged-resource locations only
//      (the manifest inside app.asar, the exe at resources/job-helper/),
//      platform win32/x64, real regular file, physical containment inside
//      the resources root, and the SHA-256 + size the BUILD pinned into
//      the ASAR manifest. The manifest supplies the expected identity —
//      the path itself is fixed in code, never taken from it.
//   2. ASYNC execution probe: `tivano-job-helper.exe --version`, bounded
//      in wall time and captured output, requiring exit 0 and the exact
//      protocol contract (helper name, version, spec 1, job-object
//      mechanism). The probe cannot hang startup — it resolves within 5 s plus up to 1 s cleanup observation.
//   3. Anything missing, replaced, mismatched, timed out or failed →
//      supported:false with an explicit reason. Verification failure can
//      NEVER fall back to a plain payload spawn (enforced upstream in
//      CodexAppServerProvider.spawnImplForMode).
//
// No environment variable, renderer value or persisted setting can turn an
// arbitrary file into a supported helper: the only inputs are the fixed
// packaged locations and the build-pinned manifest. TIVANO_CODEX_JOB_HELPER
// remains a diagnostics-only hint for the legacy probe — it cannot mint
// support either.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  JOB_HELPER_CONPTY_MECHANISM,
  JOB_HELPER_RUN_EXIT_BASE,
  JOB_HELPER_RUN_EXIT_MAX,
  JOB_HELPER_TERMINAL_SPEC_VERSION,
  PROCESS_TREE_UNSUPPORTED,
  type ProcessTreeCapability,
} from "./providerProcessLifecycle";

export const JOB_HELPER_MANIFEST_SCHEMA = "tivano-windows-job-helper-manifest/1";
export const JOB_HELPER_EXE_NAME = "tivano-job-helper.exe";
/** Fixed locations — code-owned, never read from config or the manifest. */
export const JOB_HELPER_ASAR_MANIFEST = "dist/job-helper-manifest.json";
export const JOB_HELPER_RESOURCES_DIR = "job-helper";
export const JOB_HELPER_SPEC_VERSION = 1;
export const JOB_HELPER_MANIFEST_MAX_BYTES = 64 * 1024;
export const JOB_HELPER_MAX_EXE_BYTES = 256 * 1024 * 1024;
export const JOB_HELPER_PROBE_TIMEOUT_MS = 5000;
export const JOB_HELPER_PROBE_OUTPUT_CAP = 64 * 1024;
export const JOB_HELPER_PROBE_CLOSE_SETTLE_MS = 500;

export interface JobHelperManifest {
  schema: string;
  file: string;
  bytes: number;
  sha256: string;
  helperVersion: string;
  specVersion: number;
  source?: { commit?: string | null; sourceDigest?: string };
  builtAtUtc?: string;
  toolchain?: Record<string, unknown>;
}

export type PackagedHelperCandidate = {
  kind: "candidate";
  /** Physical absolute path of the verified exe (realpath). */
  helperPath: string;
  manifest: JobHelperManifest;
};

export type PackagedHelperVerdict =
  | PackagedHelperCandidate
  | { kind: "unsupported"; reason: string; helperPath?: string };

/** fs seams so the logic is testable on any host without a real package. */
export interface PackagedHelperFs {
  lstat(path: string): { isFile(): boolean; isSymbolicLink(): boolean; isDirectory(): boolean };
  stat(path: string): { size: number; isFile(): boolean };
  realpath(path: string): string;
  readFile(path: string): string;
}

const defaultFs: PackagedHelperFs = {
  lstat: (p) => lstatSync(p),
  stat: (p) => statSync(p),
  realpath: (p) => realpathSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
};

export interface PackagedHelperProbeOptions {
  platform: NodeJS.Platform;
  arch: string;
  /** app.isPackaged — dev/unpackaged runs are never supported. */
  packaged: boolean;
  /** app.getAppPath() — resources/app.asar when packaged. */
  appPath: string | null;
  /** process.resourcesPath — <install>/resources when packaged. */
  resourcesPath: string | null;
  fs?: Partial<PackagedHelperFs>;
  /** sha256 seam (tests); default real digest. */
  sha256File?: (path: string) => string;
}

const unsupported = (reason: string, helperPath?: string): PackagedHelperVerdict => ({
  kind: "unsupported",
  reason: `${PROCESS_TREE_UNSUPPORTED}: ${reason}`,
  ...(helperPath ? { helperPath } : {}),
});

function parseHelperManifest(raw: string): JobHelperManifest | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const m = doc as Partial<JobHelperManifest>;
  if (
    m?.schema !== JOB_HELPER_MANIFEST_SCHEMA ||
    m.file !== JOB_HELPER_EXE_NAME ||
    typeof m.helperVersion !== "string" ||
    m.helperVersion.length === 0 ||
    m.helperVersion.length > 64 ||
    m.specVersion !== JOB_HELPER_SPEC_VERSION ||
    typeof m.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.bytes) ||
    (m.bytes as number) <= 0 ||
    (m.bytes as number) > JOB_HELPER_MAX_EXE_BYTES
  ) {
    return null;
  }
  return m as JobHelperManifest;
}

/**
 * SYNC candidate resolution. Returns either the verified candidate or a
 * fail-closed unsupported verdict with an explainable reason. Pure I/O,
 * no process creation — fast enough to run at bootstrap.
 */
export function resolvePackagedJobHelperCandidate(
  opts: PackagedHelperProbeOptions,
): PackagedHelperVerdict {
  const { platform, arch, packaged, appPath, resourcesPath } = opts;
  if (platform !== "win32")
    return unsupported(
      `packaged job-helper requires win32 (got ${platform}) — ` +
        "POSIX group/session cleanup is not a verified boundary in this phase",
    );
  if (arch !== "x64")
    return unsupported(`packaged job-helper is x64-only (got ${arch})`);
  if (!packaged)
    return unsupported(
      "packaged-helper attestation only applies to a packaged app — " +
        "development/unpackaged runs keep real launches disabled",
    );
  if (!appPath || !resourcesPath)
    return unsupported("packaged resource locations are unavailable");

  const fs = { ...defaultFs, ...(opts.fs ?? {}) };
  const sha256File =
    opts.sha256File ??
    ((p: string) => createHash("sha256").update(readFileSync(p)).digest("hex"));

  // 1. Build-pinned manifest — inside the ASAR, the same trust domain as
  //    the code that verifies it.
  const manifestPath = join(appPath, JOB_HELPER_ASAR_MANIFEST);
  let manifestStat: ReturnType<PackagedHelperFs["stat"]>;
  try {
    manifestStat = fs.stat(manifestPath);
  } catch {
    return unsupported(`job-helper manifest missing: ${manifestPath}`);
  }
  if (!manifestStat.isFile() || manifestStat.size === 0 || manifestStat.size > JOB_HELPER_MANIFEST_MAX_BYTES)
    return unsupported(`job-helper manifest has an invalid size: ${manifestPath}`);
  let manifest: JobHelperManifest | null;
  try {
    manifest = parseHelperManifest(fs.readFile(manifestPath));
  } catch {
    manifest = null;
  }
  if (!manifest)
    return unsupported(`job-helper manifest failed schema validation: ${manifestPath}`);

  // 2. The exe at the FIXED resources location — real file, physically
  //    contained inside the resources root.
  const exePath = join(resourcesPath, JOB_HELPER_RESOURCES_DIR, JOB_HELPER_EXE_NAME);
  let exeLstat: ReturnType<PackagedHelperFs["lstat"]>;
  try {
    exeLstat = fs.lstat(exePath);
  } catch {
    return unsupported(`job-helper is not present: ${exePath}`, exePath);
  }
  if (!exeLstat.isFile() || exeLstat.isSymbolicLink())
    return unsupported(`job-helper is not a real regular file: ${exePath}`, exePath);
  let realExe: string, realResources: string;
  try {
    realExe = fs.realpath(exePath);
    realResources = fs.realpath(resourcesPath);
  } catch {
    return unsupported(`job-helper path cannot be physically resolved: ${exePath}`, exePath);
  }
  const rel = relative(realResources, realExe);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    return unsupported(`job-helper escapes the resources root: ${realExe}`, realExe);

  // 3. Identity: the bytes on disk must equal what the build pinned.
  let exeStat: ReturnType<PackagedHelperFs["stat"]>;
  try {
    exeStat = fs.stat(realExe);
  } catch {
    return unsupported(`job-helper cannot be inspected: ${realExe}`, realExe);
  }
  if (exeStat.size !== manifest.bytes)
    return unsupported(
      `job-helper size ${exeStat.size} does not match build manifest ${manifest.bytes}`,
      realExe,
    );
  let digest: string;
  try {
    digest = sha256File(realExe);
  } catch {
    return unsupported(`job-helper cannot be hashed: ${realExe}`, realExe);
  }
  if (digest !== manifest.sha256)
    return unsupported("job-helper content does not match the build-pinned hash", realExe);

  return { kind: "candidate", helperPath: realExe, manifest };
}

// ---- bounded async execution probe ------------------------------------------

export interface AttestationResult {
  ok: boolean;
  reason?: string;
  /** true when the probed helper advertises the --run exit-code channel
   *  (runExitBase 1024 + runExitMax 255). Optional capability — an older
   *  helper still attests for --serve consumers but can never carry Git. */
  runCapable?: boolean;
  /** true when the probed helper advertises the ConPTY terminal host
   *  (conpty-terminal mechanism + terminalSpec 1). Optional capability —
   *  an older helper still attests for serve/run but can never host a
   *  Windows terminal. */
  terminalCapable?: boolean;
  /** What the probe actually observed — kept honest for diagnostics. */
  observed?: {
    exitObserved: boolean;
    closeObserved: boolean;
    code: number | null;
    timedOut: boolean;
    spawnError?: string;
  };
}

// The --run exit-code contract constants live in providerProcessLifecycle
// (single definition shared by this attestation and the Git runner).

/**
 * Run `<helper> --version` under a wall-time bound and an output cap.
 * Success requires: spawn observed, exit 0 and pipe close observed, exactly one
 * JSON contract matching the manifest's version/spec and advertising the
 * job-object mechanism. Timeout requests termination and still resolves —
 * the probe can never hang application startup.
 */
export interface AttestationOptions {
  timeoutMs?: number;
  spawnImpl?: () => ChildProcess;
  children?: Set<ChildProcess>;
}

/** Retain unclosed probes so shutdown can retry instead of forgetting them. */
export async function disposeJobHelperProbes(
  children: Set<ChildProcess>, timeoutMs = 1000,
): Promise<string[]> {
  const results = await Promise.all([...children].map((child) => new Promise<string | null>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener("close", closed);
      resolve(children.has(child) ? `job-helper probe pid ${child.pid ?? "?"}: close unconfirmed` : null);
    };
    const closed = () => { children.delete(child); done(); };
    const timer = setTimeout(done, timeoutMs);
    child.once("close", closed);
    try { child.kill("SIGKILL"); } catch { /* close observation decides */ }
  })));
  return results.filter((r): r is string => r !== null);
}

export function attestJobHelper(
  candidate: PackagedHelperCandidate,
  opts: AttestationOptions = {},
): Promise<AttestationResult> {
  const timeoutMs = opts.timeoutMs ?? JOB_HELPER_PROBE_TIMEOUT_MS;
  const observed: NonNullable<AttestationResult["observed"]> = {
    exitObserved: false, closeObserved: false, code: null, timedOut: false,
  };
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let out = "", bytes = 0, failure: string | undefined, runCapable = false,
        terminalCapable = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(settleTimer);
      if (!failure && (!observed.exitObserved || !observed.closeObserved))
        failure = "job-helper probe exit or pipe close unconfirmed";
      if (!failure && observed.code !== 0)
        failure = `job-helper --version exited ${observed.code}`;
      if (!failure) {
        try {
          const doc = JSON.parse(out.trim());
          if (doc?.helper !== "tivano-job-helper" ||
              doc.version !== candidate.manifest.helperVersion ||
              doc.spec !== candidate.manifest.specVersion ||
              doc.diagnosticOnly !== true ||
              !Array.isArray(doc.mechanisms) || !doc.mechanisms.includes("job-object"))
            failure = "job-helper --version contract does not match the build manifest";
          else {
            runCapable =
              doc.runExitBase === JOB_HELPER_RUN_EXIT_BASE &&
              doc.runExitMax === JOB_HELPER_RUN_EXIT_MAX;
            terminalCapable =
              doc.terminalSpec === JOB_HELPER_TERMINAL_SPEC_VERSION &&
              doc.mechanisms.includes(JOB_HELPER_CONPTY_MECHANISM) &&
              doc.mechanisms.includes("proc-thread-attr-job-list") &&
              doc.mechanisms.includes("kill-on-job-close");
          }
        } catch { failure = "job-helper --version output is not valid JSON"; }
      }
      // Keep the handles/listeners when cleanup is uncertain. The app's
      // coordinator owns retries; destroying pipes would manufacture close.
      resolve({ ok: !failure, ...(failure ? { reason: failure } : {}),
                runCapable, terminalCapable, observed });
    };
    const stop = (reason: string) => {
      if (settled || failure) return;
      failure = reason;
      clearTimeout(timer); clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, 1000);
      try { child.kill("SIGKILL"); } catch { /* request is not proof */ }
    };
    try {
      child = opts.spawnImpl?.() ?? spawn(candidate.helperPath, ["--version"], {
        env: {}, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failure = `job-helper probe spawn failed: ${(e as Error).message}`;
      finish(); return;
    }
    opts.children?.add(child);
    child.once("close", (code) => {
      opts.children?.delete(child);
      observed.closeObserved = true;
      if (observed.code === null) observed.code = code;
      finish();
    });
    const capture = (chunk: string | Buffer, stdout: boolean) => {
      if (settled || failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > JOB_HELPER_PROBE_OUTPUT_CAP) { stop("job-helper probe output limit exceeded"); return; }
      if (stdout) out += chunk.toString();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => capture(chunk, true));
    child.stderr?.on("data", (chunk) => capture(chunk, false));
    child.once("error", (e) => {
      observed.spawnError = String(e?.message ?? e);
      stop(`job-helper probe spawn error: ${observed.spawnError}`);
    });
    child.once("exit", (code) => {
      observed.exitObserved = true; observed.code = code;
      if (!settleTimer) settleTimer = setTimeout(finish, JOB_HELPER_PROBE_CLOSE_SETTLE_MS);
    });
    timer = setTimeout(() => {
      observed.timedOut = true;
      stop(`job-helper probe did not exit within ${timeoutMs}ms`);
    }, timeoutMs);
  });
}

/**
 * Full attestation: sync candidate checks → bounded async probe. Returns
 * the final ProcessTreeCapability — `supported:true` only when EVERY
 * layer passed.
 */
export async function probeAndAttestPackagedJobHelper(
  opts: PackagedHelperProbeOptions & AttestationOptions,
): Promise<ProcessTreeCapability> {
  const platform = opts.platform;
  const candidate = resolvePackagedJobHelperCandidate(opts);
  if (candidate.kind === "unsupported")
    return {
      supported: false,
      platform,
      reason: candidate.reason,
      ...(candidate.helperPath ? { helperPath: candidate.helperPath } : {}),
    };
  const attest = await attestJobHelper(candidate, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
    ...(opts.children ? { children: opts.children } : {}),
  });
  if (!attest.ok)
    return {
      supported: false,
      platform,
      reason: `${PROCESS_TREE_UNSUPPORTED}: ${attest.reason}`,
      helperPath: candidate.helperPath,
    };
  return {
    supported: true,
    platform,
    mechanism: "windows-job-object",
    helperPath: candidate.helperPath,
    helperVersion: candidate.manifest.helperVersion,
    runCapable: attest.runCapable === true,
    terminalCapable: attest.terminalCapable === true,
  };
}
