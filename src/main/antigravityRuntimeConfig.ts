// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Antigravity (`agy`) runtime configuration — trusted-main decisions only.
// Three states:
//
//   "fixture"       TIVANO_ANTIGRAVITY_FIXTURE=<abs .mjs> + TIVANO_ANTIGRAVITY_NODE=<abs>
//                   → offline stream-json protocol fixture. Explicitly synthetic.
//   "real"          TIVANO_ANTIGRAVITY_EXECUTABLE=<abs agy.exe>, saved Settings path,
//                   or standard host `agy.exe` installation. Launch requires the
//                   process-tree capability (Windows Job helper); until it is
//                   proven the adapter refuses to start anything real.
//   "unconfigured"  none resolved → ANTIGRAVITY_NOT_CONFIGURED on send.
//
// Invariants enforced HERE:
//   · Executable must be a native binary (Windows: `agy.exe`; POSIX: `agy`/`agy.exe`);
//     `.cmd`/`.bat`, shell strings, and relative paths are refused.
//   · Log files (`--log-file`) live strictly under an app-owned physical
//     `<dataRoot>/antigravity-logs` directory (never following symlinks).
//   · Connected MCP servers are NEVER passed to `agy` and no MCP config file
//     is ever written for Antigravity (P2-35).

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, sep } from "node:path";
import {
  PROCESS_TREE_UNSUPPORTED,
  probeProcessTreeSupport,
  type ProcessTreeCapability,
} from "./providerProcessLifecycle";
import type { CodexChooseResult, CodexWriteResult } from "../shared/types";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_PROTOCOL_PIN = "1.5.16+stream-json";

/** Reject UNC / remote paths before touching the filesystem synchronously. */
export function isUnsafeRemotePath(p: string): boolean {
  const s = p.trim();
  return (
    s.startsWith("\\\\") ||
    s.startsWith("//") ||
    /^file:/i.test(s)
  );
}

export type AntigravityMode = "fixture" | "real" | "unconfigured";

export interface AntigravityRuntimeConfig {
  mode: AntigravityMode;
  configuredFrom?: "fixture" | "environment" | "saved" | "discovered" | "none";
  /** real only: validated absolute executable path (physical). */
  executable?: string;
  /** fixture only: absolute fixture script + node executable. */
  fixtureScript?: string;
  fixtureNode?: string;
  /** App-private log directory for `agy --log-file` (realpath). */
  logDir: string;
  /** Spawn environment (isolated in fixture mode; OS + auth roots in real mode). */
  env: Record<string, string>;
  /** Process-tree capability at config time (real mode gate). */
  treeCapability: ProcessTreeCapability;
  /** Why "real" cannot launch even when configured. */
  realUnavailableReason?: string;
}

export class AntigravityConfigError extends Error {
  constructor(
    readonly code:
      | "ANTIGRAVITY_NOT_CONFIGURED"
      | "ANTIGRAVITY_EXECUTABLE_INVALID"
      | "ANTIGRAVITY_FIXTURE_INVALID"
      | "ANTIGRAVITY_LOG_UNSAFE"
      | "ANTIGRAVITY_CONFIG_INCOMPATIBLE"
      | typeof PROCESS_TREE_UNSUPPORTED,
    message: string,
  ) {
    super(message);
    this.name = "AntigravityConfigError";
  }
}

/**
 * Validate a candidate Antigravity executable path. Windows accepts ONLY a
 * real `agy.exe`; other platforms accept `agy`/`agy.exe`. `.cmd`/`.bat` and
 * symlink/junction paths are refused.
 */
export function validateAntigravityExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4000) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      "ANTIGRAVITY_EXECUTABLE_INVALID: executable path is empty or over the 4000-character bound",
    );
  }
  if (!isAbsolute(candidate) || candidate.includes("\0") || isUnsafeRemotePath(candidate)) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      "ANTIGRAVITY_EXECUTABLE_INVALID: executable must be a clean local absolute path",
    );
  }
  if (/\.(cmd|bat)$/i.test(candidate)) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      "ANTIGRAVITY_EXECUTABLE_INVALID: script entrypoints (.cmd/.bat) are refused — a native executable is required",
    );
  }
  const base = basename(candidate);
  const baseOk =
    platform === "win32"
      ? base.toLowerCase() === "agy.exe"
      : base === "agy" || base === "agy.exe";
  if (!baseOk) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      `ANTIGRAVITY_EXECUTABLE_INVALID: only the native Antigravity CLI binary is allowed (got "${base}")`,
    );
  }
  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      `ANTIGRAVITY_EXECUTABLE_INVALID: not a regular file: ${candidate}`,
    );
  }
  if (!st.isFile()) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      `ANTIGRAVITY_EXECUTABLE_INVALID: not a regular file: ${candidate}`,
    );
  }
  try {
    return realpathSync(candidate);
  } catch {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_EXECUTABLE_INVALID",
      `ANTIGRAVITY_EXECUTABLE_INVALID: path cannot be resolved: ${candidate}`,
    );
  }
}

/**
 * Look up a standard host-installed native `agy` binary (`%LOCALAPPDATA%\agy\bin\agy.exe`
 * or validated native file on PATH). Returns undefined when absent or unsafe.
 */
export function discoverAntigravityExecutable(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const candidates: string[] = [];
  if (platform === "win32") {
    const localAppData = source.LOCALAPPDATA?.trim();
    if (localAppData && isAbsolute(localAppData)) {
      candidates.push(join(localAppData, "agy", "bin", "agy.exe"));
    }
    const userProfile = source.USERPROFILE?.trim();
    if (userProfile && isAbsolute(userProfile)) {
      candidates.push(join(userProfile, "AppData", "Local", "agy", "bin", "agy.exe"));
    }
  } else {
    const home = source.HOME?.trim();
    if (home && isAbsolute(home)) {
      candidates.push(join(home, ".local", "bin", "agy"));
    }
    candidates.push("/opt/homebrew/bin/agy", "/usr/local/bin/agy", "/usr/bin/agy");
  }
  const rawPath = source.PATH ?? source.Path ?? "";
  for (const dir of rawPath.split(delimiter)) {
    const clean = dir.trim();
    if (!clean || !isAbsolute(clean)) continue;
    candidates.push(join(clean, platform === "win32" ? "agy.exe" : "agy"));
  }
  for (const c of candidates) {
    if (isUnsafeRemotePath(c)) continue;
    if (!existsSync(c)) continue;
    try {
      return validateAntigravityExecutable(c, platform);
    } catch {
      /* ignore invalid candidates like .cmd shims or non-regular files */
    }
  }
  return undefined;
}

function resolvePhysicalSubdir(dataRoot: string, childName: string, code: "ANTIGRAVITY_LOG_UNSAFE"): string {
  const unsafe = (m: string) => new AntigravityConfigError(code, `${code}: ${m}`);
  let dataPhys: string;
  try {
    dataPhys = realpathSync(dataRoot);
  } catch {
    throw unsafe(`data root cannot be resolved: ${dataRoot}`);
  }
  const dir = join(dataPhys, childName);
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw unsafe(`cannot inspect ${childName}: ${(err as Error).message}`);
    }
  }
  if (st?.isSymbolicLink()) throw unsafe(`${childName} must not be a link: ${dir}`);
  if (st && !st.isDirectory()) throw unsafe(`${childName} is not a directory: ${dir}`);
  if (!st) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw unsafe(`cannot create ${childName}: ${(err as Error).message}`);
    }
  }
  let phys: string;
  try {
    phys = realpathSync(dir);
  } catch {
    throw unsafe(`${childName} cannot be resolved: ${dir}`);
  }
  const prefix = dataPhys.endsWith(sep) ? dataPhys : dataPhys + sep;
  if (phys !== dataPhys && !phys.startsWith(prefix)) {
    throw unsafe(`${childName} escaped data root: ${phys}`);
  }
  return phys;
}

/**
 * Resolve (and create if needed) `<dataRoot>/antigravity-logs` for `agy --log-file`.
 */
export function resolveAntigravityLogDir(dataRoot: string): string {
  return resolvePhysicalSubdir(dataRoot, "antigravity-logs", "ANTIGRAVITY_LOG_UNSAFE");
}

function resolveFixtureAntigravityHome(dataRoot: string): string {
  const dir = resolvePhysicalSubdir(dataRoot, "antigravity-home", "ANTIGRAVITY_LOG_UNSAFE");
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Build child environment for Antigravity.
 *  - Fixture mode stays strictly isolated under `fixtureHome` inside `dataRoot`.
 *  - Real mode carries whitelisted OS + user auth-location variables (HOME/USERPROFILE/
 *    APPDATA/LOCALAPPDATA/XDG_*) so host-signed-in `agy` can access its existing login,
 *    while stripping unrelated Tivano internal test/config env vars.
 */
export function buildAntigravityEnv(opts: {
  mode: "fixture" | "real";
  fixtureHome?: string;
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  const source = opts.sourceEnv ?? process.env;
  if (opts.mode === "fixture") {
    const home = opts.fixtureHome!;
    const tmp = join(home, "tmp");
    const env: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      XDG_CACHE_HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
    };
    if (platform === "win32") {
      for (const k of ["SystemRoot", "SystemDrive", "windir"]) {
        if (source[k]) env[k] = source[k]!;
      }
    }
    return env;
  }

  const keys =
    platform === "win32"
      ? [
          "HOME",
          "USERPROFILE",
          "HOMEDRIVE",
          "HOMEPATH",
          "APPDATA",
          "LOCALAPPDATA",
          "PATH",
          "Path",
          "PATHEXT",
          "TEMP",
          "TMP",
          "TMPDIR",
          "SystemRoot",
          "SystemDrive",
          "windir",
          "COMSPEC",
          "ComSpec",
          "LANG",
          "LC_ALL",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
        ]
      : [
          "HOME",
          "USER",
          "LOGNAME",
          "PATH",
          "TMPDIR",
          "TMP",
          "TEMP",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "LANG",
          "LC_ALL",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
        ];
  const env: Record<string, string> = {};
  for (const k of keys) {
    if (typeof source[k] === "string" && source[k]!.length > 0) env[k] = source[k]!;
  }
  return env;
}

function validateFixturePart(candidate: string, label: string): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4000) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_FIXTURE_INVALID",
      `ANTIGRAVITY_FIXTURE_INVALID: ${label} path is empty or oversized`,
    );
  }
  if (!isAbsolute(candidate) || candidate.includes("\0") || isUnsafeRemotePath(candidate)) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_FIXTURE_INVALID",
      `ANTIGRAVITY_FIXTURE_INVALID: ${label} must be a local absolute path`,
    );
  }
  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_FIXTURE_INVALID",
      `ANTIGRAVITY_FIXTURE_INVALID: ${label} not found: ${candidate}`,
    );
  }
  if (!st.isFile()) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_FIXTURE_INVALID",
      `ANTIGRAVITY_FIXTURE_INVALID: ${label} must be a regular file: ${candidate}`,
    );
  }
  return realpathSync(candidate);
}

/**
 * Resolve Antigravity runtime config from main-owned environment, saved setting,
 * or standard installation discovery.
 */
export function resolveAntigravityRuntime(
  env: NodeJS.ProcessEnv,
  dataRoot: string,
  opts?: {
    treeCapability?: ProcessTreeCapability;
    savedExecutable?: string;
    platform?: NodeJS.Platform;
    discover?: boolean;
  },
): AntigravityRuntimeConfig {
  const platform = opts?.platform ?? process.platform;
  const fixtureRaw = env.TIVANO_ANTIGRAVITY_FIXTURE?.trim();
  const nodeRaw = env.TIVANO_ANTIGRAVITY_NODE?.trim();
  const exeRaw = env.TIVANO_ANTIGRAVITY_EXECUTABLE?.trim();
  const savedRaw = opts?.savedExecutable?.trim();

  if (fixtureRaw && exeRaw) {
    throw new AntigravityConfigError(
      "ANTIGRAVITY_CONFIG_INCOMPATIBLE",
      "ANTIGRAVITY_CONFIG_INCOMPATIBLE: TIVANO_ANTIGRAVITY_FIXTURE and TIVANO_ANTIGRAVITY_EXECUTABLE cannot both be set",
    );
  }

  const treeCapability = opts?.treeCapability ?? probeProcessTreeSupport({ platform });
  const logDir = resolveAntigravityLogDir(dataRoot);

  if (fixtureRaw || nodeRaw) {
    if (!fixtureRaw || !nodeRaw) {
      throw new AntigravityConfigError(
        "ANTIGRAVITY_FIXTURE_INVALID",
        "ANTIGRAVITY_FIXTURE_INVALID: both TIVANO_ANTIGRAVITY_FIXTURE and TIVANO_ANTIGRAVITY_NODE are required",
      );
    }
    const fixtureScript = validateFixturePart(fixtureRaw, "fixture script");
    const fixtureNode = validateFixturePart(nodeRaw, "fixture node binary");
    const fixtureHome = resolveFixtureAntigravityHome(dataRoot);
    return {
      mode: "fixture",
      configuredFrom: "fixture",
      fixtureScript,
      fixtureNode,
      logDir,
      env: buildAntigravityEnv({ mode: "fixture", fixtureHome, platform, sourceEnv: env }),
      treeCapability,
    };
  }

  if (exeRaw) {
    const executable = validateAntigravityExecutable(exeRaw, platform);
    return {
      mode: "real",
      configuredFrom: "environment",
      executable,
      logDir,
      env: buildAntigravityEnv({ mode: "real", platform, sourceEnv: env }),
      treeCapability,
      ...(treeCapability.supported ? {} : { realUnavailableReason: treeCapability.reason }),
    };
  }

  if (savedRaw) {
    try {
      const executable = validateAntigravityExecutable(savedRaw, platform);
      return {
        mode: "real",
        configuredFrom: "saved",
        executable,
        logDir,
        env: buildAntigravityEnv({ mode: "real", platform, sourceEnv: env }),
        treeCapability,
        ...(treeCapability.supported ? {} : { realUnavailableReason: treeCapability.reason }),
      };
    } catch (err) {
      return {
        mode: "unconfigured",
        configuredFrom: "none",
        logDir,
        env: buildAntigravityEnv({ mode: "real", platform, sourceEnv: env }),
        treeCapability,
        realUnavailableReason: (err as Error).message,
      };
    }
  }

  if (opts?.discover !== false) {
    const discovered = discoverAntigravityExecutable(env, platform);
    if (discovered) {
      return {
        mode: "real",
        configuredFrom: "discovered",
        executable: discovered,
        logDir,
        env: buildAntigravityEnv({ mode: "real", platform, sourceEnv: env }),
        treeCapability,
        ...(treeCapability.supported ? {} : { realUnavailableReason: treeCapability.reason }),
      };
    }
  }

  return {
    mode: "unconfigured",
    configuredFrom: "none",
    logDir,
    env: buildAntigravityEnv({ mode: "real", platform, sourceEnv: env }),
    treeCapability,
    realUnavailableReason:
      "ANTIGRAVITY_NOT_CONFIGURED: Antigravity is not configured — install `agy` or select it in Settings",
  };
}

/**
 * Pure explanation of what `settings.antigravityExecutable` does on next launch.
 */
export function antigravitySavedEffect(
  saved: string | undefined | null,
  runtime: AntigravityRuntimeConfig | null,
  source: {
    TIVANO_PROVIDER?: string | undefined;
    TIVANO_ANTIGRAVITY_EXECUTABLE?: string | undefined;
    TIVANO_ANTIGRAVITY_FIXTURE?: string | undefined;
  },
  invalidReason?: string,
): { savedEffect: "none" | "active" | "pending-restart" | "blocked"; savedBlockReason?: string } {
  if (!saved) return { savedEffect: "none" };
  const provider = source.TIVANO_PROVIDER;
  if (provider !== undefined && provider !== ANTIGRAVITY_PROVIDER_ID) {
    return {
      savedEffect: "blocked",
      savedBlockReason: `TIVANO_PROVIDER=${provider} routes this launch away from Antigravity — the saved path can only apply when Antigravity routing is selected`,
    };
  }
  const envExe = !!source.TIVANO_ANTIGRAVITY_EXECUTABLE?.trim();
  const envFixture = !!source.TIVANO_ANTIGRAVITY_FIXTURE?.trim();
  if (envExe || envFixture) {
    return {
      savedEffect: "blocked",
      savedBlockReason:
        envExe && envFixture
          ? "TIVANO_ANTIGRAVITY_EXECUTABLE and TIVANO_ANTIGRAVITY_FIXTURE are both set — explicit environment always wins over the saved path"
          : envExe
            ? "TIVANO_ANTIGRAVITY_EXECUTABLE overrides the saved path for this launch"
            : "TIVANO_ANTIGRAVITY_FIXTURE overrides the saved path for this launch",
    };
  }
  if (invalidReason) return { savedEffect: "blocked", savedBlockReason: invalidReason };
  return {
    savedEffect:
      runtime?.configuredFrom === "saved" &&
      runtime.mode === "real" &&
      runtime.executable === saved
        ? "active"
        : "pending-restart",
  };
}

export function antigravityTestPick(
  packaged: boolean,
  source: {
    TIVANO_TEST_MODE?: string | undefined;
    TIVANO_TEST_ANTIGRAVITY_PICK?: string | undefined;
  },
): string | undefined {
  return !packaged && source.TIVANO_TEST_MODE === "antigravity-setup"
    ? source.TIVANO_TEST_ANTIGRAVITY_PICK
    : undefined;
}

export interface AntigravitySetupDeps {
  mutable(): boolean;
  savedExecutable(): string | undefined;
  commit(path: string | undefined): void;
  platform?: NodeJS.Platform;
}

export class AntigravitySetup {
  private epoch = 0;
  private chooserBusy = false;
  private pendingPath: string | null = null;

  constructor(private readonly deps: AntigravitySetupDeps) {}

  get pendingExecutable(): string | null {
    return this.pendingPath;
  }
  get isChooserBusy(): boolean {
    return this.chooserBusy;
  }
  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  async choose(
    showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  ): Promise<CodexChooseResult> {
    if (!this.deps.mutable()) return { status: "unavailable", reason: "read-only" };
    if (this.chooserBusy) return { status: "busy" };
    this.chooserBusy = true;
    const epoch = ++this.epoch;
    try {
      const result = await showOpenDialog();
      if (epoch !== this.epoch) return { status: "superseded" };
      if (!this.deps.mutable()) return { status: "unavailable", reason: "closed while choosing" };
      const raw = Array.isArray(result?.filePaths)
        ? result.filePaths.find((p) => typeof p === "string" && p.length > 0)
        : undefined;
      if (result?.canceled || !raw) return { status: "canceled" };
      try {
        this.pendingPath = validateAntigravityExecutable(raw, this.platform);
      } catch (err) {
        return { status: "invalid", reason: (err as Error).message };
      }
      return { status: "chosen", path: this.pendingPath };
    } finally {
      this.chooserBusy = false;
    }
  }

  save(): CodexWriteResult {
    if (!this.deps.mutable()) return { status: "error", error: "read-only" };
    if (this.chooserBusy) return { status: "error", error: "chooser is still open" };
    const pending = this.pendingPath;
    if (!pending) return { status: "error", error: "nothing selected" };
    let validated: string;
    try {
      validated = validateAntigravityExecutable(pending, this.platform);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }
    const prev = this.deps.savedExecutable();
    if (prev === validated) {
      this.pendingPath = null;
      return { status: "saved", path: validated, changed: false };
    }
    try {
      this.deps.commit(validated);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }
    this.pendingPath = null;
    return { status: "saved", path: validated, changed: true };
  }

  clear(): CodexWriteResult {
    if (!this.deps.mutable()) return { status: "error", error: "read-only" };
    this.epoch++;
    this.pendingPath = null;
    const prev = this.deps.savedExecutable();
    if (prev === undefined) return { status: "cleared", changed: false };
    try {
      this.deps.commit(undefined);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }
    return { status: "cleared", changed: true };
  }
}
