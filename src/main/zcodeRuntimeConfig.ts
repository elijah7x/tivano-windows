// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// ZCode runtime configuration, discovery, model catalog, sign-in detection,
// and setup controller (frozen ZCodeCLI.swift + ZaiRegion.swift port).
//
// Invariants enforced HERE, not by the renderer:
//   · Remote/UNC/file-URL paths (\\host, //host, file://) are rejected
//     before any fs/stat call so main never blocks on a remote share.
//   · Entry paths must be regular, non-symlink absolute files (.cjs/.mjs
//     or ZCode bundle entrypoints); .cmd/.bat script shims are refused.
//   · Model catalog is read directly from zcode-builtin.json (no fabricated
//     fallback list when the file is missing or unreadable).
//   · Native toolSearchMode ("native") is omitted in runtimePreferences so
//     ZCode's app-runtime-preferences schema accepts it (P2-37).
//   · Z.ai API keys are never persisted plaintext or returned to the renderer.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, win32, posix } from "node:path";
import {
  ZAI_REGIONS,
  resolveZaiRegion,
  type ZaiRegion,
} from "../shared/providers";
import type {
  CodexChooseResult,
  CodexModelOption,
  CodexWriteResult,
  ZCodeInfo,
  ZCodeSetupState,
} from "../shared/types";
import type { ProcessTreeCapability } from "./providerProcessLifecycle";

export const ZCODE_PROVIDER_ID = "zcode";
export const ZCODE_SCHEMA_PIN = "zcode-protocol-1";
export const ZCODE_EFFORTS = ["low", "high", "max"] as const;
export const ZCODE_DEFAULT_EFFORT = "max";

export type ZCodeMode = "fixture" | "real" | "unconfigured";

export interface ZCodeRuntimeConfig {
  mode: ZCodeMode;
  configuredFrom: "fixture" | "environment" | "saved" | "default" | "none";
  /** Real mode: resolved physical path to zcode.cjs. */
  entry?: string;
  /** Real mode: resolved physical path to ZCode.exe / ZCode Helper / node. */
  runtimeExecutable?: string;
  /** Real mode: resolved physical path to zcode-builtin.json. */
  builtinConfigPath?: string;
  /** Fixture mode: absolute fixture script + node executable. */
  fixtureScript?: string;
  fixtureNode?: string;
  /** Home directory used for ~/.zcode/v2/{provider_config,setting,credentials}.json. */
  homeDir: string;
  /** Selected region ("global" | "china"). */
  region: ZaiRegion;
  /** Cached CLI version when probed. */
  version: string;
  /** Process-tree capability (packaged Job helper when present). */
  treeCapability: ProcessTreeCapability;
  /** Why real mode is unavailable when entry/runtime/builtin could not resolve. */
  unavailableReason?: string;
}

export class ZCodeConfigError extends Error {
  constructor(
    readonly code:
      | "ZCODE_NOT_CONFIGURED"
      | "ZCODE_ENTRY_INVALID"
      | "ZCODE_FIXTURE_INVALID"
      | "ZCODE_BUILTIN_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ZCodeConfigError";
  }
}

/** Reject UNC (\\host), //host, or file:// paths before any fs/stat call. */
export function isRemoteOrUncPath(p: string): boolean {
  if (typeof p !== "string") return true;
  const trimmed = p.trim();
  return (
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("//") ||
    /^file:/i.test(trimmed)
  );
}

function isRegularNonSymlinkFile(p: string): string | null {
  if (!p || isRemoteOrUncPath(p)) return null;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Validate a candidate ZCode entry file (`zcode.cjs` or explicit script).
 * Rejects UNC/remote paths, symlinks, `.cmd`/`.bat`, and non-files.
 */
export function validateZCodeEntry(
  candidate: string,
  _platform: NodeJS.Platform = process.platform,
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 4000
  ) {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      "ZCODE_ENTRY_INVALID: entry path is empty or over the 4000-character bound",
    );
  }
  if (candidate.includes("\0") || isRemoteOrUncPath(candidate)) {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      "ZCODE_ENTRY_INVALID: remote or UNC paths are refused",
    );
  }
  if (!isAbsolute(candidate)) {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      "ZCODE_ENTRY_INVALID: entry must be a clean absolute path",
    );
  }
  if (/\.(cmd|bat)$/i.test(candidate)) {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      "ZCODE_ENTRY_INVALID: script wrappers (.cmd/.bat) are refused",
    );
  }
  const base = basename(candidate).toLowerCase();
  if (base !== "zcode.cjs") {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      `ZCODE_ENTRY_INVALID: expected zcode.cjs entrypoint (got "${basename(candidate)}")`,
    );
  }
  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      `ZCODE_ENTRY_INVALID: not a regular file: ${candidate}`,
    );
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      `ZCODE_ENTRY_INVALID: entry must be a regular non-symlink file: ${candidate}`,
    );
  }
  try {
    return realpathSync(candidate);
  } catch {
    throw new ZCodeConfigError(
      "ZCODE_ENTRY_INVALID",
      `ZCODE_ENTRY_INVALID: path cannot be resolved: ${candidate}`,
    );
  }
}

/**
 * Default ZCode install locations (never relies on PATH).
 * Windows: %ProgramFiles%\ZCode\resources\glm\zcode.cjs,
 *          %ProgramFiles(x86)%\ZCode\resources\glm\zcode.cjs,
 *          %LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs.
 * macOS:   /Applications/ZCode.app/..., ~/Applications/ZCode.app/...
 */
export function defaultZCodeEntryCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Programs") : undefined,
      home ? win32.join(home, "AppData", "Local", "Programs") : undefined,
    ].filter((x): x is string => typeof x === "string" && x.trim().length > 0 && !isRemoteOrUncPath(x));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const root of roots) {
      const p = win32.join(root, "ZCode", "resources", "glm", "zcode.cjs");
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  }
  return [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    posix.join(home, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
  ];
}

export function findDefaultZCodeEntry(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | null {
  for (const candidate of defaultZCodeEntryCandidates(env, platform, home)) {
    const phys = isRegularNonSymlinkFile(candidate);
    if (phys) return phys;
  }
  return null;
}

/** Locate the ZCode app bundle/install root containing the given zcode.cjs. */
export function resolveZCodeAppRoot(entry: string): string | null {
  if (!entry || isRemoteOrUncPath(entry)) return null;
  let dir = dirname(entry);
  for (let i = 0; i < 8; i++) {
    const base = basename(dir);
    if (base.endsWith(".app")) return dir;
    if (
      existsSync(join(dir, "ZCode.exe")) ||
      existsSync(join(dir, "resources", "config", "provider", "zcode-builtin.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Locate the runtime binary used with ELECTRON_RUN_AS_NODE=1 to run zcode.cjs. */
export function resolveZCodeRuntimeExecutable(
  entry: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const root = resolveZCodeAppRoot(entry);
  if (!root) return null;
  const candidates =
    platform === "win32"
      ? [join(root, "ZCode.exe")]
      : [
          join(root, "Contents", "Frameworks", "ZCode Helper.app", "Contents", "MacOS", "ZCode Helper"),
          join(root, "Contents", "MacOS", "ZCode"),
          join(root, "ZCode"),
        ];
  for (const c of candidates) {
    const phys = isRegularNonSymlinkFile(c);
    if (phys) return phys;
  }
  return null;
}

/** Locate the bundled zcode-builtin.json config file for a ZCode install. */
export function zcodeBuiltinConfigPath(entry: string): string | null {
  const root = resolveZCodeAppRoot(entry);
  if (!root) return null;
  const candidates = [
    join(root, "resources", "config", "provider", "zcode-builtin.json"),
    join(root, "Contents", "Resources", "config", "provider", "zcode-builtin.json"),
  ];
  for (const c of candidates) {
    const phys = isRegularNonSymlinkFile(c);
    if (phys) return phys;
  }
  return null;
}

export function zcodeAccountProviderId(region: ZaiRegion): string {
  return ZAI_REGIONS[region].zcodeAccountProviderId;
}

export function zcodePersonalConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, ".zcode", "v2", "provider_config.json");
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!path || isRemoteOrUncPath(path)) return null;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Compute `"zcode-builtin:<revision>:<sha256(path)>"` (frozen ZCodeCLI.builtinRevision). */
export function readZCodeBuiltinRevision(builtinPath: string): string | null {
  const json = readJsonFile(builtinPath);
  if (!json) return null;
  const rev = json.revision;
  if (typeof rev !== "number" || !Number.isInteger(rev)) return null;
  const digest = createHash("sha256").update(builtinPath, "utf8").digest("hex");
  return `zcode-builtin:${rev}:${digest}`;
}

/** Read bundled ZCode Coding Plan models for `region` from zcode-builtin.json. */
export function readZCodeBuiltinModels(
  builtinPath: string,
  region: ZaiRegion,
): CodexModelOption[] {
  const json = readJsonFile(builtinPath);
  if (!json) return [];
  const cfg = json.config as Record<string, unknown> | undefined;
  const pcr = cfg?.providerConfigRules as Record<string, unknown> | undefined;
  const rules = Array.isArray(pcr?.providerRules) ? pcr.providerRules : [];
  const targetId = zcodeAccountProviderId(region);
  const rule = rules.find(
    (r): r is Record<string, unknown> =>
      typeof r === "object" && r !== null && (r as Record<string, unknown>).providerId === targetId,
  );
  const ruleCfg = rule?.config as Record<string, unknown> | undefined;
  const ids = Array.isArray(ruleCfg?.builtinModelIds) ? ruleCfg.builtinModelIds : [];
  if (ids.length === 0 || !ids.every((x) => typeof x === "string" && x.length > 0)) {
    return [];
  }
  return (ids as string[]).map((id, index) => ({
    id,
    name: id,
    efforts: [...ZCODE_EFFORTS],
    defaultEffort: ZCODE_DEFAULT_EFFORT,
    isDefault: index === 0,
  }));
}

/**
 * Read ~/.zcode/v2/setting.json for `session/requestRuntimePreferences`.
 * P2-37 fix: ZCode's app-runtime-preferences schema rejects "native" even
 * though setting.json allows it, so only "auto" | "local" | "off" pass.
 */
export function readZCodeRuntimePreferences(homeDir: string = homedir()): Record<string, unknown> {
  const settingsPath = join(homeDir, ".zcode", "v2", "setting.json");
  const settings = readJsonFile(settingsPath);
  const result: Record<string, unknown> = {
    nativeSearchEnhancementsEnabled:
      typeof settings?.nativeSearchEnhancementsEnabled === "boolean"
        ? settings.nativeSearchEnhancementsEnabled
        : false,
  };
  for (const key of ["memoryEnabled", "askUserQuestionAutoResolutionEnabled"] as const) {
    if (typeof settings?.[key] === "boolean") {
      result[key] = settings[key];
    }
  }
  const mode = settings?.toolSearchMode;
  if (mode === "auto" || mode === "local" || mode === "off") {
    result.toolSearchMode = mode;
  }
  return result;
}

/**
 * Inspect ~/.zcode/v2/credentials.json key names ONLY (never reads, decrypts,
 * or logs credential values) to report whether ZCode local sign-in keys exist.
 */
export function detectZCodeLocalCredentials(homeDir: string = homedir()): {
  hasLocalCredentials: boolean;
} {
  const credPath = join(homeDir, ".zcode", "v2", "credentials.json");
  const json = readJsonFile(credPath);
  if (!json) return { hasLocalCredentials: false };
  const keys = Object.keys(json);
  const has = keys.some(
    (k) =>
      k === "oauth:active_provider" ||
      k === "oauth:bigmodel:access_token" ||
      k === "oauth:zai:access_token" ||
      k.startsWith("account-provider:"),
  );
  return { hasLocalCredentials: has };
}

export function buildZCodeEnv(
  opts: {
    entry: string;
    builtinConfigPath?: string | undefined;
    homeDir?: string | undefined;
    baseEnv?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
  },
): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? homedir();
  const base = opts.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of [
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "COMSPEC",
    "ComSpec",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (base[k]) env[k] = base[k]!;
  }
  if (!env.HOME) env.HOME = homeDir;
  if (platform === "win32" && !env.USERPROFILE) env.USERPROFILE = homeDir;
  env.ELECTRON_RUN_AS_NODE = "1";
  const builtin = opts.builtinConfigPath ?? zcodeBuiltinConfigPath(opts.entry) ?? "";
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = zcodePersonalConfigPath(homeDir);
  return env;
}

const versionCache = new Map<string, string>();

export function probeZCodeVersion(
  runtimeExecutable: string,
  entry: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): string {
  const cacheKey = `${runtimeExecutable}\0${entry}`;
  const cached = versionCache.get(cacheKey);
  if (cached) return cached;
  try {
    const r = spawnSync(runtimeExecutable, [entry, "--version"], {
      env: buildZCodeEnv({ entry, baseEnv }),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const out = `${r.stdout ?? ""} ${r.stderr ?? ""}`.trim();
    const match = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(out);
    const version = match?.[1] ?? (out || "unknown");
    if (r.status === 0 && match) versionCache.set(cacheKey, version);
    return version;
  } catch {
    return "unknown";
  }
}

export interface ZCodeApiKeyResolution {
  apiKey: string;
  source: "settings" | "environment" | "none";
}

export function resolveZCodeApiKey(
  savedKey: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ZCodeApiKeyResolution {
  const trimmedSaved = savedKey?.trim() ?? "";
  if (trimmedSaved) return { apiKey: trimmedSaved, source: "settings" };
  const envKey = env.ZAI_API_KEY?.trim() ?? "";
  if (envKey) return { apiKey: envKey, source: "environment" };
  return { apiKey: "", source: "none" };
}

export function detectZCodeAuth(
  opts: {
    mode: ZCodeMode;
    apiKey: string;
    apiKeySource: "settings" | "environment" | "none";
    installed: boolean;
  },
): {
  auth: "signedIn" | "signedOut" | "unknown";
  authDetail?: string;
  authMessage?: string;
} {
  if (opts.mode === "fixture") {
    return {
      auth: "signedIn",
      authDetail: "Offline fixture",
    };
  }
  if (!opts.installed) {
    return {
      auth: "unknown",
      authMessage:
        "ZCode is not installed. Install the ZCode app, then refresh in Settings › Providers.",
    };
  }
  if (opts.apiKey.trim().length > 0) {
    return {
      auth: "signedIn",
      authDetail: "GLM Coding Plan key",
    };
  }
  return {
    auth: "signedOut",
    authMessage:
      "ZCode signs in with your GLM Coding Plan key. Add it in Settings › Providers › Z.ai.",
  };
}

export interface ZCodeRuntimeSource {
  TIVANO_ZCODE_FIXTURE?: string | undefined;
  TIVANO_ZCODE_NODE?: string | undefined;
  TIVANO_ZCODE_EXECUTABLE?: string | undefined;
  ProgramFiles?: string | undefined;
  "ProgramFiles(x86)"?: string | undefined;
  LOCALAPPDATA?: string | undefined;
}

export function resolveZCodeRuntime(
  source: ZCodeRuntimeSource & NodeJS.ProcessEnv,
  opts: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    region?: ZaiRegion;
    treeCapability?: ProcessTreeCapability;
    savedExecutable?: string;
    probeVersion?: boolean;
  } = {},
): ZCodeRuntimeConfig {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? homedir();
  const region = opts.region ?? "global";
  const treeCapability: ProcessTreeCapability = opts.treeCapability ?? {
    supported: false,
    platform,
    reason: "not probed",
  };
  const base: ZCodeRuntimeConfig = {
    mode: "unconfigured",
    configuredFrom: "none",
    homeDir,
    region,
    version: "unknown",
    treeCapability,
  };

  const fixture = source.TIVANO_ZCODE_FIXTURE?.trim() || null;
  const envExe = source.TIVANO_ZCODE_EXECUTABLE?.trim() || null;
  const savedExe = opts.savedExecutable?.trim() || null;

  if (fixture && envExe) {
    return {
      ...base,
      unavailableReason:
        "TIVANO_ZCODE_FIXTURE and TIVANO_ZCODE_EXECUTABLE are both set — refusing to guess which runtime you meant",
    };
  }

  if (fixture) {
    const node = source.TIVANO_ZCODE_NODE?.trim() || null;
    if (!node || !isAbsolute(node) || node.includes("\0") || isRemoteOrUncPath(node)) {
      return {
        ...base,
        unavailableReason:
          "ZCODE_FIXTURE_INVALID: TIVANO_ZCODE_NODE must be an absolute executable path",
      };
    }
    if (
      !isAbsolute(fixture) ||
      fixture.includes("\0") ||
      isRemoteOrUncPath(fixture) ||
      (!fixture.endsWith(".mjs") && !fixture.endsWith(".cjs"))
    ) {
      return {
        ...base,
        unavailableReason:
          "ZCODE_FIXTURE_INVALID: TIVANO_ZCODE_FIXTURE must be an absolute .mjs/.cjs path",
      };
    }
    const builtinConfigPath = zcodeBuiltinConfigPath(fixture) ?? undefined;
    return {
      ...base,
      mode: "fixture",
      configuredFrom: "fixture",
      fixtureScript: fixture,
      fixtureNode: node,
      ...(builtinConfigPath ? { builtinConfigPath } : {}),
      version: `fixture ${ZCODE_SCHEMA_PIN}`,
    };
  }

  const tryEntry = (
    candidate: string,
    configuredFrom: "environment" | "saved" | "default",
  ): ZCodeRuntimeConfig => {
    let entry: string;
    try {
      entry = validateZCodeEntry(candidate, platform);
    } catch (err) {
      return {
        ...base,
        configuredFrom,
        unavailableReason: (err as Error).message,
      };
    }
    const runtimeExecutable = resolveZCodeRuntimeExecutable(entry, platform);
    if (!runtimeExecutable) {
      return {
        ...base,
        configuredFrom,
        entry,
        unavailableReason: "ZCode runtime binary (ZCode.exe / ZCode Helper) was not found next to zcode.cjs",
      };
    }
    const builtinConfigPath = zcodeBuiltinConfigPath(entry);
    if (!builtinConfigPath) {
      return {
        ...base,
        configuredFrom,
        entry,
        runtimeExecutable,
        unavailableReason: "ZCode's bundled provider configuration could not be read.",
      };
    }
    const version = opts.probeVersion ? probeZCodeVersion(runtimeExecutable, entry, source) : "unknown";
    return {
      ...base,
      mode: "real",
      configuredFrom,
      entry,
      runtimeExecutable,
      builtinConfigPath,
      version,
    };
  };

  if (envExe) return tryEntry(envExe, "environment");
  if (savedExe) return tryEntry(savedExe, "saved");

  const def = findDefaultZCodeEntry(source, platform, homeDir);
  if (def) return tryEntry(def, "default");

  return {
    ...base,
    unavailableReason: "ZCode is not installed.",
  };
}

export function zcodeInfoFor(
  cfg: ZCodeRuntimeConfig,
  apiKey: string,
  apiKeySource: "settings" | "environment" | "none",
): ZCodeInfo {
  const installed = cfg.mode === "real" || cfg.mode === "fixture";
  const auth = detectZCodeAuth({
    mode: cfg.mode,
    apiKey,
    apiKeySource,
    installed,
  });
  const localCred = detectZCodeLocalCredentials(cfg.homeDir);
  const common = {
    version: cfg.version,
    region: cfg.region,
    auth: auth.auth,
    ...(auth.authDetail ? { authDetail: auth.authDetail } : {}),
    ...(auth.authMessage ? { authMessage: auth.authMessage } : {}),
    hasLocalCredentials: localCred.hasLocalCredentials,
  };
  if (cfg.mode === "fixture") {
    return {
      ...common,
      state: "fixture",
      executable: `${cfg.fixtureNode} ${cfg.fixtureScript}`,
    };
  }
  if (cfg.mode === "real") {
    return {
      ...common,
      state: auth.auth === "signedIn" ? "ready" : "configured-unverified",
      ...(cfg.entry ? { executable: cfg.entry } : {}),
      ...(cfg.runtimeExecutable ? { runtimeExecutable: cfg.runtimeExecutable } : {}),
    };
  }
  return {
    ...common,
    state: cfg.unavailableReason && cfg.entry ? "unsupported" : "unconfigured",
    ...(cfg.entry ? { executable: cfg.entry } : {}),
    ...(cfg.unavailableReason ? { reason: cfg.unavailableReason } : {}),
  };
}

export function zcodeSavedEffect(
  saved: string | null,
  runtime: ZCodeRuntimeConfig | null,
  source: ZCodeRuntimeSource & { TIVANO_PROVIDER?: string | undefined },
  invalidReason?: string,
  savedCodexExecutable?: string,
): Pick<ZCodeSetupState, "savedEffect" | "savedBlockReason"> {
  if (saved === null) return { savedEffect: "none" };
  const provider = source.TIVANO_PROVIDER;
  if (provider !== undefined && provider !== "zcode") {
    return {
      savedEffect: "blocked",
      savedBlockReason: `TIVANO_PROVIDER=${provider} routes this launch away from ZCode`,
    };
  }
  if (provider === undefined && savedCodexExecutable?.trim()) {
    return {
      savedEffect: "blocked",
      savedBlockReason:
        "A saved Codex executable takes priority at launch — clear Codex CLI first to launch ZCode",
    };
  }
  const envExe = !!source.TIVANO_ZCODE_EXECUTABLE?.trim();
  const envFixture = !!source.TIVANO_ZCODE_FIXTURE?.trim();
  if (envExe || envFixture) {
    return {
      savedEffect: "blocked",
      savedBlockReason: envFixture
        ? "TIVANO_ZCODE_FIXTURE overrides the saved path for this launch"
        : "TIVANO_ZCODE_EXECUTABLE overrides the saved path for this launch",
    };
  }
  if (invalidReason) return { savedEffect: "blocked", savedBlockReason: invalidReason };
  return {
    savedEffect:
      runtime?.configuredFrom === "saved" &&
      runtime.mode === "real" &&
      runtime.entry === saved
        ? "active"
        : "pending-restart",
  };
}

export function zcodeTestPick(
  packaged: boolean,
  source: {
    TIVANO_TEST_MODE?: string | undefined;
    TIVANO_TEST_ZCODE_PICK?: string | undefined;
  },
): string | undefined {
  return !packaged && source.TIVANO_TEST_MODE === "zcode-setup"
    ? source.TIVANO_TEST_ZCODE_PICK
    : undefined;
}

export interface SecretCipher {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(buf: Buffer): string;
}

/**
 * Encrypted at-rest storage for the Z.ai GLM Coding Plan API key (Electron
 * safeStorage / Windows DPAPI). Refuses to store plaintext on disk when OS
 * encryption is unavailable; never exposes the secret back over IPC.
 */
export class ZCodeApiKeyStore {
  private readonly filePath: string;
  private cached: string | null | undefined = undefined;

  constructor(
    dataRoot: string,
    private readonly cipher: SecretCipher,
  ) {
    this.filePath = join(dataRoot, "zcode-zai-key.bin");
  }

  read(): string {
    if (this.cached !== undefined) return this.cached ?? "";
    try {
      if (!existsSync(this.filePath)) {
        this.cached = null;
        return "";
      }
      const st = lstatSync(this.filePath);
      if (st.isSymbolicLink() || !st.isFile() || !this.cipher.isAvailable()) {
        this.cached = null;
        return "";
      }
      const buf = readFileSync(this.filePath);
      const plain = this.cipher.decryptString(buf).trim();
      this.cached = plain || null;
      return this.cached ?? "";
    } catch {
      this.cached = null;
      return "";
    }
  }

  hasKey(): boolean {
    return this.read().length > 0;
  }

  write(apiKey: string | null): void {
    const trimmed = apiKey?.trim() ?? "";
    if (!trimmed) {
      this.cached = null;
      try {
        if (existsSync(this.filePath)) unlinkSync(this.filePath);
      } catch {
        /* already gone */
      }
      return;
    }
    if (!this.cipher.isAvailable()) {
      throw new Error("OS credential encryption is unavailable on this host");
    }
    const encrypted = this.cipher.encryptString(trimmed);
    writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    this.cached = trimmed;
  }
}

export interface ZCodeSetupDeps {
  mutable(): boolean;
  savedExecutable(): string | undefined;
  commit(path: string | undefined): void;
  platform?: NodeJS.Platform;
}

/** Epoch-guarded native file chooser controller for `zcode.cjs`. */
export class ZCodeSetup {
  private epoch = 0;
  private chooserBusy = false;
  private pendingPath: string | null = null;

  constructor(private readonly deps: ZCodeSetupDeps) {}

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
      if (!this.deps.mutable())
        return { status: "unavailable", reason: "closed while choosing" };
      const raw = Array.isArray(result?.filePaths)
        ? result.filePaths.find((p) => typeof p === "string" && p.length > 0)
        : undefined;
      if (result?.canceled || !raw) return { status: "canceled" };
      try {
        this.pendingPath = validateZCodeEntry(raw, this.platform);
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
      validated = validateZCodeEntry(pending, this.platform);
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
