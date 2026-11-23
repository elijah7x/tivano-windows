// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// ZCode provider tests: runtime discovery/validation (win32 + posix paths),
// P2-37 fixes (stopped/errored turns, non-fatal failing tool, omitted
// "native" toolSearchMode, subagent tool filtering), model catalog,
// sign-in detection, setup state machine, IPC validation, and engine E2E
// against the synthetic ZCode app-server fixture.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ZCodeApiKeyStore,
  ZCodeSetup,
  defaultZCodeEntryCandidates,
  detectZCodeAuth,
  detectZCodeLocalCredentials,
  readZCodeBuiltinModels,
  readZCodeBuiltinRevision,
  readZCodeRuntimePreferences,
  resolveZCodeApiKey,
  resolveZCodeAppRoot,
  resolveZCodeRuntime,
  resolveZCodeRuntimeExecutable,
  validateZCodeEntry,
  zcodeBuiltinConfigPath,
  zcodeSavedEffect,
  zcodeTestPick,
  type SecretCipher,
  type ZCodeRuntimeConfig,
} from "../src/main/zcodeRuntimeConfig";
import { ZCodeProvider, ZCodeProviderError } from "../src/main/zcodeProvider";
import type { ProviderCallbacks, TurnContext, WorkspaceGrant } from "../src/main/provider";
import type { ApprovalRequest, CodexQuestionRequest, ProviderThreadBinding } from "../src/shared/types";
import { PROVIDER_CATALOG, providerMetadata, resolveZaiRegion } from "../src/shared/providers";
import { HYDRA_PROVIDER_NAMES, hydraProviderName } from "../src/shared/hydra";
import { REQUEST_CHANNELS, requestValidators } from "../src/shared/ipc";
import { translate } from "../src/renderer/i18n";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";

const FIXTURE = fileURLToPath(new URL("./fixtures/zcode-app-server.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeFakeZCodeInstall(root: string, opts: { platform?: NodeJS.Platform; revision?: number } = {}) {
  const platform = opts.platform ?? process.platform;
  const revision = opts.revision ?? 43;
  const builtinJson = {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "account:zai-individual-coding-plan",
            config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] },
          },
          {
            providerId: "account:bigmodel-individual-coding-plan",
            config: { builtinModelIds: ["GLM-5.3-CN", "GLM-5.3-Flash"] },
          },
        ],
      },
    },
  };
  if (platform === "win32") {
    const glm = join(root, "resources", "glm");
    const cfgDir = join(root, "resources", "config", "provider");
    mkdirSync(glm, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    const entry = join(glm, "zcode.cjs");
    const runtimeExe = join(root, "ZCode.exe");
    const builtin = join(cfgDir, "zcode-builtin.json");
    writeFileSync(entry, "// synthetic zcode entry\n");
    writeFileSync(runtimeExe, "MZ");
    writeFileSync(builtin, JSON.stringify(builtinJson));
    return { entry, runtimeExe, builtin };
  }
  const app = join(root, "ZCode.app");
  const glm = join(app, "Contents", "Resources", "glm");
  const helper = join(app, "Contents", "Frameworks", "ZCode Helper.app", "Contents", "MacOS");
  const cfgDir = join(app, "Contents", "Resources", "config", "provider");
  mkdirSync(glm, { recursive: true });
  mkdirSync(helper, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });
  const entry = join(glm, "zcode.cjs");
  const runtimeExe = join(helper, "ZCode Helper");
  const builtin = join(cfgDir, "zcode-builtin.json");
  writeFileSync(entry, "// synthetic zcode entry\n");
  writeFileSync(runtimeExe, "#!/bin/sh\n");
  writeFileSync(builtin, JSON.stringify(builtinJson));
  return { entry, runtimeExe, builtin };
}

function writeBuiltinForFixture(dir: string): string {
  const cfgDir = join(dir, "resources", "config", "provider");
  mkdirSync(cfgDir, { recursive: true });
  const p = join(cfgDir, "zcode-builtin.json");
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 1,
      revision: 43,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "account:zai-individual-coding-plan",
              config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] },
            },
            {
              providerId: "account:bigmodel-individual-coding-plan",
              config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] },
            },
          ],
        },
      },
    }),
  );
  return p;
}

function fixtureConfig(partial: Partial<ZCodeRuntimeConfig> = {}): ZCodeRuntimeConfig {
  const homeDir = tmp("tivano-zcode-home-");
  const builtinConfigPath = writeBuiltinForFixture(tmp("tivano-zcode-builtin-"));
  return {
    mode: "fixture",
    configuredFrom: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: NODE,
    builtinConfigPath,
    homeDir,
    region: "global",
    version: "fixture zcode-protocol-1",
    treeCapability: { supported: false, platform: process.platform, reason: "test" },
    ...partial,
  };
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface Collected {
  chunks: string[];
  reasoning: string[];
  approvals: Array<Omit<ApprovalRequest, "id" | "turnId" | "status">>;
  questions: Array<Omit<CodexQuestionRequest, "status">>;
  tools: Array<{ itemId: string; status: string; title?: string; detail?: string }>;
  fileChanges: string[];
  usages: Array<{ usedTokens: number; windowTokens?: number; sessionTotalTokens?: number }>;
  reports: Array<{ model: string | null; effort: string | null }>;
  done: boolean;
  interrupted: boolean;
  errors: string[];
  approvedWritten: string[];
  questionAnswered: string[];
}

function collectCallbacks(): { cb: ProviderCallbacks; c: Collected } {
  const c: Collected = {
    chunks: [],
    reasoning: [],
    approvals: [],
    questions: [],
    tools: [],
    fileChanges: [],
    usages: [],
    reports: [],
    done: false,
    interrupted: false,
    errors: [],
    approvedWritten: [],
    questionAnswered: [],
  };
  return {
    c,
    cb: {
      onChunk: (_s, d) => c.chunks.push(d),
      onReasoning: (r) => {
        if (r.delta) c.reasoning.push(r.delta);
      },
      onApproval: (a) => c.approvals.push(a),
      onApprovalAnswerWritten: (k) => c.approvedWritten.push(k),
      onQuestion: (q) => c.questions.push(q),
      onQuestionAnswered: (k) => c.questionAnswered.push(k),
      onToolActivity: (a) =>
        c.tools.push({
          itemId: a.itemId,
          status: a.status,
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.detail !== undefined ? { detail: a.detail } : {}),
        }),
      onFileChanges: (paths) => c.fileChanges.push(...paths),
      onUsage: (u) => c.usages.push({ ...u }),
      onModelReport: (m, e) => c.reports.push({ model: m, effort: e }),
      onDone: () => {
        c.done = true;
      },
      onInterrupted: () => {
        c.interrupted = true;
      },
      onError: (m) => {
        c.errors.push(m);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Runtime discovery, validation, model catalog, and sign-in detection
// ---------------------------------------------------------------------------

describe("zcodeRuntimeConfig", () => {
  it("builds explicit win32 and darwin default install candidates", () => {
    const winCands = defaultZCodeEntryCandidates(
      {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
      },
      "win32",
      "C:\\Users\\demo",
    );
    expect(winCands).toEqual([
      "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
      "C:\\Program Files (x86)\\ZCode\\resources\\glm\\zcode.cjs",
      "C:\\Users\\demo\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs",
    ]);

    const macCands = defaultZCodeEntryCandidates({}, "darwin", "/Users/demo");
    expect(macCands).toEqual([
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      "/Users/demo/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    ]);
  });

  it("refuses UNC, remote URLs, relative paths, .cmd/.bat, non-zcode.cjs, and symlinks", () => {
    expect(() => validateZCodeEntry("\\\\server\\share\\zcode.cjs")).toThrow("ZCODE_ENTRY_INVALID");
    expect(() => validateZCodeEntry("//server/share/zcode.cjs")).toThrow("ZCODE_ENTRY_INVALID");
    expect(() => validateZCodeEntry("file:///C:/zcode.cjs")).toThrow("ZCODE_ENTRY_INVALID");
    expect(() => validateZCodeEntry("relative/zcode.cjs")).toThrow("ZCODE_ENTRY_INVALID");
    expect(() => validateZCodeEntry(join(tmp("zc-"), "zcode.cmd"))).toThrow("ZCODE_ENTRY_INVALID");
    const d = tmp("zc-");
    const wrong = join(d, "other.cjs");
    writeFileSync(wrong, "");
    expect(() => validateZCodeEntry(wrong)).toThrow("ZCODE_ENTRY_INVALID");

    const real = join(d, "zcode.cjs");
    writeFileSync(real, "// ok\n");
    expect(validateZCodeEntry(real)).toBe(realpathSync(real));

    const link = join(d, "link.cjs");
    try {
      symlinkSync(real, link);
      expect(() => validateZCodeEntry(link)).toThrow("ZCODE_ENTRY_INVALID");
    } catch {
      /* symlink creation can fail on unprivileged win32 */
    }
  });

  it("resolves app root, runtime binary, builtin config, revision hash, and region catalogs", () => {
    const root = tmp("tivano-zc-install-");
    const { entry, runtimeExe, builtin } = makeFakeZCodeInstall(root);
    expect(resolveZCodeAppRoot(entry)).toBe(
      process.platform === "win32" ? root : join(root, "ZCode.app"),
    );
    expect(resolveZCodeRuntimeExecutable(entry)).toBe(realpathSync(runtimeExe));
    expect(zcodeBuiltinConfigPath(entry)).toBe(realpathSync(builtin));

    const physBuiltin = realpathSync(builtin);
    const expectedDigest = createHash("sha256").update(physBuiltin, "utf8").digest("hex");
    expect(readZCodeBuiltinRevision(physBuiltin)).toBe(`zcode-builtin:43:${expectedDigest}`);

    const globalModels = readZCodeBuiltinModels(physBuiltin, "global");
    expect(globalModels.map((m) => m.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(globalModels[0]).toMatchObject({
      efforts: ["low", "high", "max"],
      defaultEffort: "max",
      isDefault: true,
    });

    const chinaModels = readZCodeBuiltinModels(physBuiltin, "china");
    expect(chinaModels.map((m) => m.id)).toEqual(["GLM-5.3-CN", "GLM-5.3-Flash"]);
  });

  it("resolves runtime priority (fixture > environment > saved) and savedEffect", () => {
    const d1 = tmp("zc-env-");
    const d2 = tmp("zc-saved-");
    const envInstall = makeFakeZCodeInstall(d1);
    const savedInstall = makeFakeZCodeInstall(d2);

    const cfgEnv = resolveZCodeRuntime(
      { TIVANO_ZCODE_EXECUTABLE: envInstall.entry },
      { savedExecutable: savedInstall.entry, probeVersion: false },
    );
    expect(cfgEnv.mode).toBe("real");
    expect(cfgEnv.configuredFrom).toBe("environment");
    expect(cfgEnv.entry).toBe(realpathSync(envInstall.entry));

    const cfgSaved = resolveZCodeRuntime(
      {},
      { savedExecutable: savedInstall.entry, probeVersion: false },
    );
    expect(cfgSaved.mode).toBe("real");
    expect(cfgSaved.configuredFrom).toBe("saved");
    expect(
      zcodeSavedEffect(realpathSync(savedInstall.entry), cfgSaved, {}, undefined),
    ).toEqual({ savedEffect: "active" });

    expect(
      zcodeSavedEffect(realpathSync(savedInstall.entry), cfgSaved, {}, undefined, "C:\\codex.exe"),
    ).toMatchObject({ savedEffect: "blocked" });
  });

  it("omits unsupported 'native' toolSearchMode in readZCodeRuntimePreferences (P2-37)", () => {
    const home = tmp("zc-pref-");
    const dir = join(home, ".zcode", "v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "setting.json"),
      JSON.stringify({
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: true,
        askUserQuestionAutoResolutionEnabled: false,
        toolSearchMode: "native",
      }),
    );
    expect(readZCodeRuntimePreferences(home)).toEqual({
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: true,
      askUserQuestionAutoResolutionEnabled: false,
    });

    writeFileSync(join(dir, "setting.json"), JSON.stringify({ toolSearchMode: "auto" }));
    expect(readZCodeRuntimePreferences(home)).toEqual({
      nativeSearchEnhancementsEnabled: false,
      toolSearchMode: "auto",
    });
  });

  it("detects sign-in from GLM Coding Plan key (settings/env) and local credential key names only", () => {
    const home = tmp("zc-cred-");
    expect(detectZCodeLocalCredentials(home)).toEqual({ hasLocalCredentials: false });
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "v2", "credentials.json"),
      JSON.stringify({ "oauth:active_provider": "synthetic-marker" }),
    );
    expect(detectZCodeLocalCredentials(home)).toEqual({ hasLocalCredentials: true });

    expect(resolveZCodeApiKey("  sk-saved ", { ZAI_API_KEY: "sk-env" })).toEqual({
      apiKey: "sk-saved",
      source: "settings",
    });
    expect(resolveZCodeApiKey("", { ZAI_API_KEY: "sk-env" })).toEqual({
      apiKey: "sk-env",
      source: "environment",
    });

    expect(
      detectZCodeAuth({ mode: "real", apiKey: "", apiKeySource: "none", installed: true }),
    ).toMatchObject({ auth: "signedOut" });
    expect(
      detectZCodeAuth({ mode: "real", apiKey: "sk-test", apiKeySource: "settings", installed: true }),
    ).toEqual({ auth: "signedIn", authDetail: "GLM Coding Plan key" });
    expect(
      detectZCodeAuth({ mode: "unconfigured", apiKey: "sk-test", apiKeySource: "settings", installed: false }),
    ).toMatchObject({ auth: "unknown" });
  });

  it("encrypts/decrypts Z.ai API key via SecretCipher and refuses plaintext storage", () => {
    const root = tmp("zc-cipher-");
    const cipher: SecretCipher = {
      isAvailable: () => true,
      encryptString: (v) => Buffer.from(`enc:${v}`, "utf8"),
      decryptString: (b) => b.toString("utf8").replace(/^enc:/, ""),
    };
    const store = new ZCodeApiKeyStore(root, cipher);
    expect(store.hasKey()).toBe(false);
    store.write("sk-synthetic-123");
    expect(store.hasKey()).toBe(true);
    expect(store.read()).toBe("sk-synthetic-123");
    store.write(null);
    expect(store.hasKey()).toBe(false);

    const noCipher: SecretCipher = {
      isAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    };
    expect(() => new ZCodeApiKeyStore(root, noCipher).write("sk-x")).toThrow(/encryption is unavailable/);
  });

  it("runs ZCodeSetup choose/save/clear and zcodeTestPick", async () => {
    const d = tmp("zc-setup-");
    const entry = join(d, "zcode.cjs");
    writeFileSync(entry, "// entry\n");
    let saved: string | undefined;
    const setup = new ZCodeSetup({
      mutable: () => true,
      savedExecutable: () => saved,
      commit: (p) => {
        saved = p;
      },
    });
    expect(await setup.choose(async () => ({ canceled: false, filePaths: [entry] }))).toEqual({
      status: "chosen",
      path: realpathSync(entry),
    });
    expect(setup.save()).toEqual({ status: "saved", path: realpathSync(entry), changed: true });
    expect(saved).toBe(realpathSync(entry));
    expect(setup.clear()).toEqual({ status: "cleared", changed: true });
    expect(saved).toBeUndefined();
    expect(
      zcodeTestPick(false, { TIVANO_TEST_MODE: "zcode-setup", TIVANO_TEST_ZCODE_PICK: entry }),
    ).toBe(entry);
    expect(
      zcodeTestPick(true, { TIVANO_TEST_MODE: "zcode-setup", TIVANO_TEST_ZCODE_PICK: entry }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. ZCodeProvider against offline ZCode protocol fixture
// ---------------------------------------------------------------------------

describe("ZCodeProvider (fixture)", () => {
  it("streams replies, reasoning, tools, file diffs, usage, and session resume", async () => {
    const stateDir = tmp("zc-state-");
    const ws = tmp("zc-ws-");
    const cfg = fixtureConfig();
    const bindings = new Map<string, ProviderThreadBinding>();

    const makeAdapter = () =>
      new ZCodeProvider({
        config: cfg,
        apiKey: () => "sk-synthetic-fixture",
        lookupBinding: (t) => bindings.get(t),
        bindThread: async (t, b) => {
          bindings.set(t, b);
        },
        makeSpec: (cwd) => ({
          executable: NODE,
          args: [FIXTURE],
          cwd,
          env: {
            ...process.env,
            TIVANO_ZCODE_FIXTURE_STATE_DIR: stateDir,
          },
        }),
        runtimePreferences: () =>
          readZCodeRuntimePreferences(
            (() => {
              const h = tmp("zc-pref-");
              mkdirSync(join(h, ".zcode", "v2"), { recursive: true });
              writeFileSync(
                join(h, ".zcode", "v2", "setting.json"),
                JSON.stringify({ toolSearchMode: "native", memoryEnabled: true }),
              );
              return h;
            })(),
          ),
      });

    const p1 = makeAdapter();
    expect(p1.descriptor.mode).toBe("zcode");
    expect(await p1.modelCatalog()).toHaveLength(2);

    const { cb: cb1, c: c1 } = collectCallbacks();
    const grant: WorkspaceGrant = { projectId: "p1", directory: ws };
    p1.start(
      {
        prompt: "file-edit please",
        threadId: "local-1",
        turnId: "turn-1",
        workspace: grant,
        model: "GLM-5.3-Flash",
        effort: "low",
        runtimeMode: "autoAcceptEdits",
        interactionMode: "build",
      },
      cb1,
    );
    await waitFor(() => c1.done || c1.errors.length > 0);
    expect(c1.errors).toEqual([]);
    expect(c1.done).toBe(true);
    expect(c1.chunks.join("")).toContain("m=GLM-5.3-Flash e=low mode=edit ts=omitted auth=authed");
    expect(c1.reasoning.join("")).toContain("thinking...");
    expect(c1.fileChanges).toEqual(["src/example.ts"]);
    expect(c1.usages.length).toBeGreaterThan(0);
    expect(bindings.get("local-1")?.providerId).toBe("zcode");
    await p1.dispose();

    // Resume in a fresh adapter instance
    const p2 = makeAdapter();
    const { cb: cb2, c: c2 } = collectCallbacks();
    p2.start(
      {
        prompt: "follow-up",
        threadId: "local-1",
        turnId: "turn-2",
        workspace: grant,
        runtimeMode: "fullAccess",
        interactionMode: "plan",
      },
      cb2,
    );
    await waitFor(() => c2.done || c2.errors.length > 0);
    expect(c2.errors).toEqual([]);
    expect(c2.chunks.join("")).toContain("mode=plan");
    await p2.dispose();
  });

  it("enforces P2-37 fixes: stopped/errored turns never finish done, failing tool does not end turn, subagent results dropped", async () => {
    const ws = tmp("zc-ws-p237-");
    const cfg = fixtureConfig();
    const p = new ZCodeProvider({
      config: cfg,
      apiKey: () => "sk-synthetic-fixture",
      lookupBinding: () => undefined,
      bindThread: async () => {},
    });
    const grant: WorkspaceGrant = { projectId: "p1", directory: ws };

    // 1) tool-fail-nonfatal: failing tool + subagent result -> turn still completes done
    const r1 = collectCallbacks();
    p.start({ prompt: "tool-fail-nonfatal", threadId: "t-tool", turnId: "1", workspace: grant }, r1.cb);
    await waitFor(() => r1.c.done || r1.c.errors.length > 0);
    expect(r1.c.done).toBe(true);
    expect(r1.c.errors).toEqual([]);
    expect(r1.c.tools.some((t) => t.status === "failed")).toBe(true);
    // Subagent tool result tc-sub-* without parent tool_call must NOT appear
    expect(r1.c.tools.some((t) => t.itemId.startsWith("tc-sub-"))).toBe(false);

    // 2) telemetry-cancel -> interrupted, NOT done
    const r2 = collectCallbacks();
    p.start({ prompt: "telemetry-cancel", threadId: "t-tc", turnId: "2", workspace: grant }, r2.cb);
    await waitFor(() => r2.c.interrupted || r2.c.done || r2.c.errors.length > 0);
    expect(r2.c.interrupted).toBe(true);
    expect(r2.c.done).toBe(false);

    // 3) telemetry-error -> failed, NOT done
    const r3 = collectCallbacks();
    p.start({ prompt: "telemetry-error", threadId: "t-te", turnId: "3", workspace: grant }, r3.cb);
    await waitFor(() => r3.c.errors.length > 0 || r3.c.done);
    expect(r3.c.errors[0]).toContain("fixture telemetry failure");
    expect(r3.c.done).toBe(false);

    // 4) turn.completed with resultType=error_api -> failed, NOT done
    const r4 = collectCallbacks();
    p.start({ prompt: "completed-error", threadId: "t-ce", turnId: "4", workspace: grant }, r4.cb);
    await waitFor(() => r4.c.errors.length > 0 || r4.c.done);
    expect(r4.c.errors[0]).toContain("fixture completed error");
    expect(r4.c.done).toBe(false);

    // 5) turn.completed with resultType=cancelled -> interrupted, NOT done
    const r5 = collectCallbacks();
    p.start({ prompt: "completed-cancelled", threadId: "t-cc", turnId: "5", workspace: grant }, r5.cb);
    await waitFor(() => r5.c.interrupted || r5.c.done || r5.c.errors.length > 0);
    expect(r5.c.interrupted).toBe(true);
    expect(r5.c.done).toBe(false);

    await p.dispose();
  });

  it("handles permission approvals, user input questions, and turn cancellation", async () => {
    const ws = tmp("zc-ws-interact-");
    const cfg = fixtureConfig();
    const p = new ZCodeProvider({
      config: cfg,
      apiKey: () => "sk-synthetic-fixture",
      lookupBinding: () => undefined,
      bindThread: async () => {},
    });
    const grant: WorkspaceGrant = { projectId: "p1", directory: ws };

    // Approval flow
    const rApp = collectCallbacks();
    const hApp = p.start({ prompt: "approval", threadId: "t-app", turnId: "a1", workspace: grant }, rApp.cb);
    await waitFor(() => rApp.c.approvals.length > 0);
    expect(rApp.c.approvals[0]!.headline).toBe("ZCode requests command approval");
    hApp.resume(true, "allow_once");
    await waitFor(() => rApp.c.done || rApp.c.errors.length > 0);
    expect(rApp.c.done).toBe(true);
    expect(rApp.c.approvedWritten.length).toBe(1);

    // Question flow
    const rQ = collectCallbacks();
    const hQ = p.start({ prompt: "question", threadId: "t-q", turnId: "q1", workspace: grant }, rQ.cb);
    await waitFor(() => rQ.c.questions.length > 0);
    hQ.answer?.(rQ.c.questions[0]!.providerKey, { "0": ["Global (recommended)"] });
    await waitFor(() => rQ.c.done || rQ.c.errors.length > 0);
    expect(rQ.c.done).toBe(true);
    expect(rQ.c.questionAnswered.length).toBe(1);
    expect(rQ.c.chunks.join("")).toContain("Global (recommended)");

    // Cancel flow
    const rStop = collectCallbacks();
    const hStop = p.start({ prompt: "sleep", threadId: "t-s", turnId: "s1", workspace: grant }, rStop.cb);
    await new Promise((r) => setTimeout(r, 150));
    hStop.cancel();
    await waitFor(() => rStop.c.interrupted || rStop.c.done || rStop.c.errors.length > 0);
    expect(rStop.c.interrupted).toBe(true);

    await p.dispose();
  });

  it("fails cleanly with ZCODE_NOT_INSTALLED when unconfigured", () => {
    const p = new ZCodeProvider({
      config: {
        mode: "unconfigured",
        configuredFrom: "none",
        homeDir: tmp("zc-unconf-"),
        region: "global",
        version: "unknown",
        treeCapability: { supported: false, platform: process.platform, reason: "test" },
        unavailableReason: "ZCode is not installed.",
      },
      apiKey: () => "",
      lookupBinding: () => undefined,
      bindThread: async () => {},
    });
    expect(() =>
      p.start(
        { prompt: "hi", threadId: "t", turnId: "1", workspace: { projectId: "p", directory: tmp("w-") } },
        collectCallbacks().cb,
      ),
    ).toThrow(ZCodeProviderError);
  });
});

// ---------------------------------------------------------------------------
// 3. Shared catalog, IPC validators, Engine integration, and i18n
// ---------------------------------------------------------------------------

describe("ZCode registration, Engine, IPC, and i18n", () => {
  it("registers ZCode in PROVIDER_CATALOG, Hydra names, IPC validators, and i18n", () => {
    expect(PROVIDER_CATALOG.map((p) => p.id)).toEqual(["codex", "zcode"]);
    expect(providerMetadata("zcode")).toMatchObject({
      id: "zcode",
      displayName: "ZCode",
      agentName: "ZCode CLI",
      accountLabel: "GLM Coding Plan",
    });
    expect(resolveZaiRegion("china")).toBe("china");
    expect(resolveZaiRegion("anything-else")).toBe("global");
    expect(HYDRA_PROVIDER_NAMES.zcode).toBe("ZCode");
    expect(hydraProviderName("zcode")).toBe("ZCode");

    for (const ch of [
      "providers:list",
      "zcode:setup-state",
      "zcode:choose",
      "zcode:save",
      "zcode:clear",
      "zcode:refresh",
      "zcode:set-api-key",
    ] as const) {
      expect(REQUEST_CHANNELS).toContain(ch);
      expect(requestValidators[ch]).toBeTypeOf("function");
    }
    expect(requestValidators["settings:set"]({ zaiRegion: "china" }).zaiRegion).toBe("china");
    expect(requestValidators["zcode:set-api-key"]({ apiKey: null }).apiKey).toBeNull();

    expect(translate("zh-Hans", "ZCode")).toBe("ZCode");
    expect(translate("zh-Hans", "Providers")).toBe("服务商");
    expect(translate("zh-Hans", "GLM Coding Plan key")).toBe("GLM Coding Plan 密钥");
    expect(translate("zh-Hans", "China")).toBe("中国区");
  });

  it("drives a full Engine turn with ZCodeProvider, model catalog, and persistence", async () => {
    const root = tmp("zc-eng-");
    const ws = tmp("zc-eng-ws-");
    const store = new Store(root);
    store.open();
    const cfg = fixtureConfig();
    let engine!: Engine;
    const zcode = new ZCodeProvider({
      config: cfg,
      apiKey: () => "sk-synthetic-fixture",
      lookupBinding: (tid) => engine.lookupProviderThread(tid),
      bindThread: (tid, b) => engine.bindProviderThread(tid, b),
    });
    const paths = new ProjectRuntimePaths([], join(root, "grants.json"), root);
    engine = new Engine(store, zcode, root, "0.1.0-test", paths);

    expect(engine.info.mode).toBe("zcode");
    const cat = await engine.codexModels();
    expect(cat.state).toBe("ready");
    if (cat.state === "ready") {
      expect(cat.models.map((m) => m.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    }

    const proj = engine.createProject("zcode-proj");
    engine.registerWorkspace(proj.id, ws);
    const thread = engine.createThread(proj.id, "chat");
    engine.setThreadModel(thread.id, "GLM-5.3-Flash", "high");
    engine.sendTurn(thread.id, "hello zcode");

    try {
      await waitFor(() => {
        const th = engine.snapshot().threads.find((t) => t.id === thread.id)!;
        return th.turn?.status === "done" || th.turn?.status === "error";
      });
      const doneThread = engine.snapshot().threads.find((t) => t.id === thread.id)!;
      expect(doneThread.turn?.status).toBe("done");
      expect(doneThread.providerThread?.providerId).toBe("zcode");
      expect(doneThread.messages.some((m) => m.role === "assistant" && m.content.includes("m=GLM-5.3-Flash e=high"))).toBe(true);

      engine.setSettings({ zaiRegion: "china" });
      expect(engine.snapshot().settings.zaiRegion).toBe("china");
      engine.setZCodeExecutable(join(root, "zcode.cjs"));
      expect(engine.snapshot().settings.zcodeExecutable).toBe(join(root, "zcode.cjs"));
      engine.setZCodeExecutable(undefined);
      expect(engine.snapshot().settings.zcodeExecutable).toBeUndefined();
    } finally {
      engine.shutdown();
      await zcode.dispose();
      store.close();
    }
  });
});
