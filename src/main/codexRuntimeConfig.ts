// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex runtime configuration — trusted-main decisions only. Three states:
//
//   "fixture"       TIVANO_CODEX_FIXTURE=<abs .mjs> + TIVANO_CODEX_NODE=<abs>
//                   → offline app-server protocol fixture. Explicitly
//                   synthetic — never presented as a real Codex CLI.
//   "real"          TIVANO_CODEX_EXECUTABLE=<abs codex.exe>
//                   → real CLI 0.164.0 candidate. Launch still requires the
//                   process-tree capability (Windows Job helper); until it
//                   is proven the adapter refuses to start anything real.
//   "unconfigured"  neither set → CODEX_NOT_CONFIGURED on send.
//
// Invariants enforced HERE, not by the renderer: executable must be an
// approved absolute native path (Windows: codex.exe only; .cmd/.bat, shell
// strings, npx and PATH probing are refused); argv is fixed to
// ["app-server"]; env is rebuilt from a whitelist — never inheriting API
// keys, tokens, proxy secrets or other provider configuration;
// CODEX_HOME is an app-private, persistent, main-resolved directory that
// is never shared with ~/.codex or any production location.

import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  PROCESS_TREE_UNSUPPORTED,
  probeProcessTreeSupport,
  type ProcessTreeCapability,
} from "./providerProcessLifecycle";
import type { CodexChooseResult, CodexSetupState, CodexWriteResult } from "../shared/types";

export const CODEX_PROVIDER_ID = "codex";
/** Protocol freeze for this implementation — see docs/phase-2b-codex.md. */
export const CODEX_SCHEMA_PIN = "0.164.0+6aaac694";

export type CodexMode = "fixture" | "real" | "unconfigured";

export interface CodexRuntimeConfig {
  mode: CodexMode;
  /**
   * Which source produced this resolution — "fixture" (env fixture),
   * "environment" (TIVANO_CODEX_EXECUTABLE), "saved" (persisted setting)
   * or "none". Diagnostics only; routing decisions live in index.ts.
   * Optional so pre-existing hand-built configs stay valid.
   */
  configuredFrom?: "fixture" | "environment" | "saved" | "none";
  /** real only: validated absolute executable path (physical). */
  executable?: string;
  /** fixture only: absolute fixture script + node executable. */
  fixtureScript?: string;
  fixtureNode?: string;
  /** App-private CODEX_HOME (realpath). */
  codexHome: string;
  /** Stable identifier stored on thread bindings (realpath). */
  codexHomeId: string;
  /** Fixed argv for the real CLI. */
  args: string[];
  /** Whitelisted environment for the spawned process. */
  env: Record<string, string>;
  /** Process-tree capability at config time (real mode gate). */
  treeCapability: ProcessTreeCapability;
  /** Why "real" cannot launch even though it is configured. */
  realUnavailableReason?: string;
}

export class CodexConfigError extends Error {
  constructor(
    readonly code:
      | "CODEX_NOT_CONFIGURED"
      | "CODEX_EXECUTABLE_INVALID"
      | "CODEX_FIXTURE_INVALID"
      | "CODEX_HOME_UNSAFE"
      | "CODEX_CONFIG_INCOMPATIBLE"
      | typeof PROCESS_TREE_UNSUPPORTED,
    message: string,
  ) {
    super(message);
    this.name = "CodexConfigError";
  }
}

/**
 * Validate a candidate Codex executable path. Windows accepts ONLY a real
 * `codex.exe`; other platforms accept `codex`/`codex.exe` (real launches
 * remain gated by the process-tree capability anyway).
 */
export function validateCodexExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 4000
  )
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      "CODEX_EXECUTABLE_INVALID: executable path is empty or over the 4000-character bound",
    );
  if (!isAbsolute(candidate) || candidate.includes("\0"))
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      "CODEX_EXECUTABLE_INVALID: executable must be a clean absolute path",
    );
  if (/\.(cmd|bat)$/i.test(candidate))
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      "CODEX_EXECUTABLE_INVALID: script entrypoints (.cmd/.bat) are refused — a native executable is required",
    );
  const base = basename(candidate);
  const baseOk =
    platform === "win32"
      ? base.toLowerCase() === "codex.exe"
      : base === "codex" || base === "codex.exe";
  if (!baseOk)
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      `CODEX_EXECUTABLE_INVALID: only the native Codex CLI binary is allowed (got "${base}")`,
    );
  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      `CODEX_EXECUTABLE_INVALID: not a regular file: ${candidate}`,
    );
  }
  if (!st.isFile())
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      `CODEX_EXECUTABLE_INVALID: not a regular file: ${candidate}`,
    );
  try {
    return realpathSync(candidate);
  } catch {
    throw new CodexConfigError(
      "CODEX_EXECUTABLE_INVALID",
      `CODEX_EXECUTABLE_INVALID: path cannot be resolved: ${candidate}`,
    );
  }
}

/**
 * Whitelisted child environment: app-private HOME-ish roots plus the OS
 * fields CreateProcess needs on Windows. No PATH, no API keys, no tokens,
 * no proxies — a real CLI that cannot work under this set is a lead
 * finding, not a reason to widen it here.
 */
export function buildCodexEnv(
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    USERPROFILE: codexHome,
    APPDATA: codexHome,
    LOCALAPPDATA: codexHome,
    XDG_CACHE_HOME: codexHome,
    XDG_CONFIG_HOME: codexHome,
    XDG_DATA_HOME: codexHome,
    TMPDIR: join(codexHome, "tmp"),
    TMP: join(codexHome, "tmp"),
    TEMP: join(codexHome, "tmp"),
  };
  if (platform === "win32") {
    for (const k of ["SystemRoot", "SystemDrive", "windir"]) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
  }
  return env;
}

const CRED_STORE_LINE = 'cli_auth_credentials_store = "file"';

/**
 * The ONLY config.toml we accept verbatim: blank lines, full-line comments
 * and exactly one top-level `cli_auth_credentials_store = "file"`. This is
 * NOT a TOML parser — it is a restrictive shape check: any table header,
 * any other key, a duplicate key, single-quoted or differing values, or
 * any form we cannot trivially prove safe makes the file incompatible. We
 * never append to or rewrite an existing file — a foreign config keeps its
 * original bytes and the runtime refuses to adopt it.
 */
function configTomlIsSafe(content: string): boolean {
  let seen = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) return false; // any table — scope unverifiable
    const eq = line.indexOf("=");
    if (eq < 0) return false;
    const key = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1).trim();
    if (key !== "cli_auth_credentials_store") return false;
    if (seen) return false; // duplicate key
    if (!rest.startsWith('"file"')) return false; // wrong/unsafe value form
    const tail = rest.slice(6).trim();
    if (tail !== "" && !tail.startsWith("#")) return false;
    seen = true;
  }
  return seen;
}

/**
 * Resolve (and only then create) the app-private CODEX_HOME. Hard rules:
 *
 *   · codex-home must be a REAL directory physically inside the resolved
 *     dataRoot — a symlink/junction or an out-of-root target refuses
 *     (CODEX_HOME_UNSAFE), so an attacker cannot redirect the isolated
 *     home to arbitrary user files.
 *   · config.toml must be a REAL file we own; a link refuses. We never
 *     read credential files — only this one policy file, only to enforce
 *     `cli_auth_credentials_store = "file"` (no keyring/auto fallback).
 *   · an existing config that specifies a DIFFERENT store (e.g. keyring)
 *     refuses CODEX_CONFIG_INCOMPATIBLE — we never silently override or
 *     rewrite content we didn't author.
 *   · filesystem failures propagate wrapped — only a true EEXIST on the
 *     wx-create is tolerated, and the surviving file is then re-verified.
 *   · tmp/ is created inside the home and re-verified inside the root.
 */
export function resolveCodexHome(dataRoot: string): { codexHome: string; codexHomeId: string } {
  const unsafe = (m: string) => new CodexConfigError("CODEX_HOME_UNSAFE", `CODEX_HOME_UNSAFE: ${m}`);
  let dataPhys: string;
  try {
    dataPhys = realpathSync(dataRoot);
  } catch {
    throw unsafe(`data root cannot be resolved: ${dataRoot}`);
  }
  const dir = join(dataPhys, "codex-home");
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe(`cannot inspect codex-home: ${(err as Error).message}`);
  }
  if (st?.isSymbolicLink()) throw unsafe(`codex-home must not be a link: ${dir}`);
  if (st && !st.isDirectory()) throw unsafe(`codex-home is not a directory: ${dir}`);
  if (!st) {
    try {
      mkdirSync(dir);
    } catch (err) {
      throw unsafe(`cannot create codex-home: ${(err as Error).message}`);
    }
  }
  let physical: string;
  try {
    physical = realpathSync(dir);
  } catch (err) {
    throw unsafe(`codex-home cannot be resolved: ${(err as Error).message}`);
  }
  if (physical !== dir && !physical.startsWith(dataPhys + sep))
    throw unsafe(`codex-home escapes the data root: ${physical}`);

  // config.toml — we auto-generate ONLY our fixed minimal file. An
  // existing file is accepted solely when the restricted check above
  // proves a top-level file credential-store policy; anything else is
  // CODEX_CONFIG_INCOMPATIBLE with the original bytes left untouched —
  // no appends, no rewrites (an append could land inside a table or a
  // file without a trailing newline, silently corrupting user config).
  const cfg = join(physical, "config.toml");
  let cst;
  try {
    cst = lstatSync(cfg);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe(`cannot inspect config.toml: ${(err as Error).message}`);
  }
  if (cst?.isSymbolicLink()) throw unsafe(`config.toml must not be a link: ${cfg}`);
  if (cst && !cst.isFile()) throw unsafe(`config.toml is not a regular file: ${cfg}`);
  if (!cst) {
    try {
      writeFileSync(cfg, CRED_STORE_LINE + "\n", { flag: "wx", mode: 0o600 });
    } catch (err) {
      // A genuine EEXIST means another first-run raced us — re-lstat the
      // survivor and reject links/non-files before content verification.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST")
        throw unsafe(`cannot write config.toml: ${(err as Error).message}`);
      const est = lstatSync(cfg);
      if (est.isSymbolicLink() || !est.isFile())
        throw unsafe(`config.toml appeared as a non-regular/link file: ${cfg}`);
    }
  }
  let content: string;
  try {
    content = readFileSync(cfg, "utf8");
  } catch (err) {
    throw unsafe(`cannot read config.toml: ${(err as Error).message}`);
  }
  if (!configTomlIsSafe(content)) {
    throw new CodexConfigError(
      "CODEX_CONFIG_INCOMPATIBLE",
      `CODEX_CONFIG_INCOMPATIBLE: existing config.toml is not the app's minimal ` +
        `credential-store policy — refusing to adopt or modify it`,
    );
  }

  // tmp/ — created if absent, must be a real dir inside the home.
  const tmp = join(physical, "tmp");
  let tst;
  try {
    tst = lstatSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe(`cannot inspect tmp: ${(err as Error).message}`);
  }
  if (tst?.isSymbolicLink()) throw unsafe(`tmp must not be a link: ${tmp}`);
  if (tst && !tst.isDirectory()) throw unsafe(`tmp is not a directory: ${tmp}`);
  if (!tst) {
    try {
      mkdirSync(tmp);
    } catch (err) {
      throw unsafe(`cannot create tmp: ${(err as Error).message}`);
    }
  }
  try {
    const tmpPhys = realpathSync(tmp);
    if (!tmpPhys.startsWith(physical + sep)) throw unsafe(`tmp escapes codex-home: ${tmpPhys}`);
  } catch (err) {
    if (err instanceof CodexConfigError) throw err;
    throw unsafe(`tmp cannot be resolved: ${(err as Error).message}`);
  }
  return { codexHome: physical, codexHomeId: physical };
}

export interface CodexRuntimeSource {
  TIVANO_CODEX_FIXTURE?: string | undefined;
  TIVANO_CODEX_NODE?: string | undefined;
  TIVANO_CODEX_EXECUTABLE?: string | undefined;
  TIVANO_CODEX_JOB_HELPER?: string | undefined;
}

/**
 * Resolve the runtime once, at bootstrap. Env reads happen HERE — the
 * renderer has no channel that can influence any of it.
 *
 * `opts.treeCapability`: the FINAL process-tree verdict, already
 * attested by the caller (packaged-app path → packagedJobHelper). When
 * injected it is used verbatim — the TIVANO_CODEX_JOB_HELPER environment
 * hint is ignored for support decisions (it can only feed the legacy
 * probe, which is permanently fail-closed).
 *
 * `opts.savedExecutable`: the persisted Settings path (P2N). STRICTLY
 * lower priority than every explicit env source — env fixture and env
 * executable always win, a fixture+executable conflict still refuses,
 * and the saved value never rescues a broken explicit configuration.
 * An invalid saved path degrades to unconfigured + reason; the stored
 * value itself is never deleted or substituted here.
 */
export function resolveCodexRuntime(
  source: CodexRuntimeSource,
  dataRoot: string,
  opts: {
    platform?: NodeJS.Platform;
    treeCapability?: ProcessTreeCapability;
    savedExecutable?: string;
  } = {},
): CodexRuntimeConfig {
  const platform = opts.platform ?? process.platform;
  const { codexHome, codexHomeId } = resolveCodexHome(dataRoot);
  const env = buildCodexEnv(codexHome, platform);
  const treeCapability =
    opts.treeCapability ??
    probeProcessTreeSupport({
      platform,
      helperPath: source.TIVANO_CODEX_JOB_HELPER ?? null,
    });

  const fixture = source.TIVANO_CODEX_FIXTURE?.trim() || null;
  const realExe = source.TIVANO_CODEX_EXECUTABLE?.trim() || null;
  const savedExe = opts.savedExecutable?.trim() || null;
  const base: CodexRuntimeConfig = {
    mode: "unconfigured",
    configuredFrom: "none",
    codexHome,
    codexHomeId,
    // The credential-store policy is pinned on argv too — a config file
    // that merely *tolerates* our line can never silently demote it.
    args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
    env,
    treeCapability,
  };

  if (fixture && realExe) {
    return {
      ...base,
      realUnavailableReason:
        "TIVANO_CODEX_FIXTURE and TIVANO_CODEX_EXECUTABLE are both set — refusing to guess which runtime you meant",
    };
  }

  if (fixture) {
    const node = source.TIVANO_CODEX_NODE?.trim() || null;
    if (!node || !isAbsolute(node) || node.includes("\0")) {
      return {
        ...base,
        realUnavailableReason:
          "CODEX_FIXTURE_INVALID: TIVANO_CODEX_NODE must be an absolute executable path",
      };
    }
    if (!isAbsolute(fixture) || fixture.includes("\0") || !fixture.endsWith(".mjs")) {
      return {
        ...base,
        realUnavailableReason:
          "CODEX_FIXTURE_INVALID: TIVANO_CODEX_FIXTURE must be an absolute .mjs path",
      };
    }
    return {
      ...base,
      mode: "fixture",
      configuredFrom: "fixture",
      fixtureScript: fixture,
      fixtureNode: node,
    };
  }

  if (realExe) {
    let executable: string;
    try {
      executable = validateCodexExecutable(realExe, platform);
    } catch (err) {
      return { ...base, realUnavailableReason: (err as Error).message };
    }
    return {
      ...base,
      mode: "real",
      configuredFrom: "environment",
      executable,
      ...(treeCapability.supported
        ? {}
        : { realUnavailableReason: treeCapability.reason }),
    };
  }

  if (savedExe) {
    // The saved path gets the same full validation as an env candidate.
    // Failure is loud (reason below) and the stored value is left for the
    // user to correct — never deleted, never silently substituted.
    let executable: string;
    try {
      executable = validateCodexExecutable(savedExe, platform);
    } catch (err) {
      return {
        ...base,
        configuredFrom: "saved",
        realUnavailableReason: `saved executable no longer valid: ${(err as Error).message}`,
      };
    }
    return {
      ...base,
      mode: "real",
      configuredFrom: "saved",
      executable,
      ...(treeCapability.supported
        ? {}
        : { realUnavailableReason: treeCapability.reason }),
    };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Codex setup controller (P2N) — the main-owned state machine behind the
// Settings chooser/save/clear IPC surface. The renderer can only request
// operations; a path enters pending state ONLY from a native dialog result
// that passed validateCodexExecutable. Epoch ordering guarantees a late
// dialog result can never overwrite a newer clear/decision.
// ---------------------------------------------------------------------------

export function codexSavedEffect(
  saved: string | null,
  runtime: CodexRuntimeConfig | null,
  source: CodexRuntimeSource & { TIVANO_PROVIDER?: string | undefined },
  invalidReason?: string,
): Pick<CodexSetupState, "savedEffect" | "savedBlockReason"> {
  if (saved === null) return { savedEffect: "none" };
  const provider = source.TIVANO_PROVIDER;
  if (provider !== undefined && provider !== "codex") {
    return {
      savedEffect: "blocked",
      savedBlockReason: `TIVANO_PROVIDER=${provider} routes this launch away from Codex — the saved path can only apply when Codex routing is selected`,
    };
  }
  const envExe = !!source.TIVANO_CODEX_EXECUTABLE?.trim();
  const envFixture = !!source.TIVANO_CODEX_FIXTURE?.trim();
  if (envExe || envFixture) {
    return {
      savedEffect: "blocked",
      savedBlockReason: envExe && envFixture
        ? "TIVANO_CODEX_EXECUTABLE and TIVANO_CODEX_FIXTURE are both set — explicit environment always wins over the saved path"
        : envExe
          ? "TIVANO_CODEX_EXECUTABLE overrides the saved path for this launch"
          : "TIVANO_CODEX_FIXTURE overrides the saved path for this launch",
    };
  }
  if (invalidReason) return { savedEffect: "blocked", savedBlockReason: invalidReason };
  return {
    savedEffect: runtime?.configuredFrom === "saved" &&
      runtime.mode === "real" && runtime.executable === saved
      ? "active" : "pending-restart",
  };
}

export function codexTestPick(
  packaged: boolean,
  source: {
    TIVANO_TEST_MODE?: string | undefined;
    TIVANO_TEST_CODEX_PICK?: string | undefined;
  },
): string | undefined {
  return !packaged && source.TIVANO_TEST_MODE === "codex-setup"
    ? source.TIVANO_TEST_CODEX_PICK : undefined;
}

export type { CodexChooseResult, CodexWriteResult };

export interface CodexSetupDeps {
  /** Window alive + engine mutable + store writable — rechecked at every step. */
  mutable(): boolean;
  /** The persisted settings value (undefined = absent). */
  savedExecutable(): string | undefined;
  /**
   * Engine-backed durable commit of `settings.codexExecutable` — throws
   * on gate or persistence failure; the callee already reverted the
   * in-memory field before throwing, so a later flush cannot sneak the
   * failed candidate in.
   */
  commit(path: string | undefined): void;
  platform?: NodeJS.Platform;
}

export class CodexSetup {
  /** Bumped on every chooser start AND every clear — a dialog result that
   *  resolves under an older epoch is superseded, never applied. */
  private epoch = 0;
  private chooserBusy = false;
  /** Validated dialog choice awaiting an explicit save. */
  private pendingPath: string | null = null;

  constructor(private readonly deps: CodexSetupDeps) {}

  get pendingExecutable(): string | null {
    return this.pendingPath;
  }
  get isChooserBusy(): boolean {
    return this.chooserBusy;
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  /**
   * One chooser at a time. Usability is checked before the dialog opens
   * and again after it resolves — closing/read-only can never mint a
   * pending choice, and an out-of-epoch result is dropped.
   */
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
      if (!this.deps.mutable())
        return { status: "unavailable", reason: "closed while choosing" };
      const raw = Array.isArray(result?.filePaths)
        ? result.filePaths.find((p) => typeof p === "string" && p.length > 0)
        : undefined;
      if (result?.canceled || !raw) return { status: "canceled" };
      try {
        this.pendingPath = validateCodexExecutable(raw, this.platform);
      } catch (err) {
        return { status: "invalid", reason: (err as Error).message };
      }
      return { status: "chosen", path: this.pendingPath };
    } finally {
      this.chooserBusy = false;
    }
  }

  /** Persist the pending validated choice — durable write or nothing. */
  save(): CodexWriteResult {
    if (!this.deps.mutable()) return { status: "error", error: "read-only" };
    if (this.chooserBusy) return { status: "error", error: "chooser is still open" };
    const pending = this.pendingPath;
    if (!pending) return { status: "error", error: "nothing selected" };
    // Re-prove the path — it may have vanished since the dialog returned.
    let validated: string;
    try {
      validated = validateCodexExecutable(pending, this.platform);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }
    const prev = this.deps.savedExecutable();
    if (prev === validated) {
      // Same value already persisted: report saved, never fabricate a
      // fake pending-restart by rewriting it.
      this.pendingPath = null;
      return { status: "saved", path: validated, changed: false };
    }
    try {
      this.deps.commit(validated);
    } catch (err) {
      // Keep pending — the choice survives for an explicit retry; the UI
      // shows the recoverable error, the persisted value is unchanged.
      return { status: "error", error: (err as Error).message };
    }
    this.pendingPath = null;
    return { status: "saved", path: validated, changed: true };
  }

  /** Remove the persisted path — also invalidates any in-flight chooser. */
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
