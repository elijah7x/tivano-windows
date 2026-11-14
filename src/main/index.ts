// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Entry: resolves an isolated data root, opens the store under its lock,
// recovers in-flight turns honestly, and creates one hardened window.
//
// Provider selection is a trusted-main decision:
//   default                      → MockProvider (unchanged Phase-1 path)
//   TIVANO_PROVIDER=synthetic-stdio + TIVANO_SYNTHETIC_NODE=<abs exe>
//                                → controlled synthetic child turns
//   TIVANO_PROVIDER=codex + TIVANO_CODEX_FIXTURE=<abs .mjs>
//                               + TIVANO_CODEX_NODE=<abs exe>
//                                → offline Codex app-server protocol fixture
//   TIVANO_PROVIDER=codex + TIVANO_CODEX_EXECUTABLE=<abs codex.exe>
//                                → real Codex candidate — launch still
//                                  gated on the process-tree capability
//                                  (Windows Job helper); without it every
//                                  send fails CODEX_REAL_UNAVAILABLE.
// The renderer cannot influence any of this — env/executable/scenario are
// fixed here and read once. Nothing here reads host credentials, inherits
// the production environment, or touches real CLIs unguarded.

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  powerSaveBlocker,
  shell,
} from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./store";
import { Engine, EngineError } from "./engine";
import { effectiveChord } from "../shared/shortcuts";
import { MockProvider } from "./mockProvider";
import {
  SyntheticStdioProvider,
  type SyntheticScenario,
} from "./syntheticStdioProvider";
import { CodexAppServerProvider } from "./codexAppServerProvider";
import {
  CODEX_SCHEMA_PIN,
  CodexSetup,
  codexSavedEffect,
  codexTestPick,
  resolveCodexRuntime,
  validateCodexExecutable,
  type CodexRuntimeConfig,
} from "./codexRuntimeConfig";
import type { ProviderAdapter, WorkspaceGrant } from "./provider";
import type { SpawnSpec } from "./stdioTransport";
import type { CodexInfo, CodexSetupState } from "../shared/types";
import { ProjectRuntimePaths } from "./projectRuntimePaths";
import { DirectoryOpener } from "./openProjectDirectory";
import { AttachmentService } from "./attachmentService";
import { lockdownWebContents } from "./security";
import { forwardEvents, registerIpc } from "./ipc";
import { CloseCoordinator } from "./lifecycle";
import { TerminalService } from "./terminalService";
import { forkPtyHost } from "./ptyHostLauncher";
import { spawnWindowsTerminalHost } from "./windowsTerminalHost";
import { GitService } from "./gitService";
import {
  gitChildEnv,
  makeGitRunner,
  makeGitRunnerViaJobHelper,
  type GitRunner,
} from "./gitExec";
import { FileIndexService } from "./fileIndex";
import { DownloadsService } from "./downloadsService";
import { scoreMentionPaths } from "../shared/fileMention";
import { GIT_POSIX_EXECUTABLE, resolveGitExecutable } from "./gitRuntimeConfig";
import { CheckpointService } from "./checkpointService";
import { WallpaperService } from "./wallpaperService";
import { LocalControlService } from "./localControl";
import { externalOpenLogPath, recordExternalOpen } from "./externalOpen";
import { cliBinDir, cliStatus, installCli, uninstallCli } from "./cliInstall";
import { CheckpointLedger } from "./checkpointLedger";
import { CheckpointCoordinator } from "./checkpointTurns";

import { resolveDataRoot } from "./appDataPaths";
import { probeAndAttestPackagedJobHelper, disposeJobHelperProbes } from "./packagedJobHelper";

function resolveDataRootArg(): string {
  return resolveDataRoot({
    argv: process.argv,
    env: process.env,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    appDataDir: () => app.getPath("appData"),
  }).root;
}

const dataRoot = resolveDataRootArg();
// Isolate the Electron browser state under the same per-run root: two
// different dataRoots must never share cookies, localStorage, cache or
// network state. The directories must exist first and sessionData must be
// assigned before app "ready" — both are guaranteed at module top-level.
// (app.setPath reference: electronjs.org/docs/latest/api/app)
const chromiumUser = join(dataRoot, "chromium", "user");
const chromiumSession = join(dataRoot, "chromium", "session");
mkdirSync(chromiumUser, { recursive: true });
mkdirSync(chromiumSession, { recursive: true });
app.setPath("userData", chromiumUser);
app.setPath("sessionData", chromiumSession);

const store = new Store(dataRoot);

try {
  store.open();
} catch (err) {
  dialog.showErrorBox(
    "Tivano Windows (Dev)",
    `Could not open the isolated data store:\n${(err as Error).message}`,
  );
  app.exit(1);
  throw err;
}

// ---- provider + workspace bootstrap (trusted main only) -------------------

const SCENARIOS: readonly SyntheticScenario[] = [
  "chat", "slow", "flood", "badframe", "stderr", "earlyexit", "nonutf8", "hang",
];
const fixtureFile = join(__dirname, "..", "..", "tests", "fixtures", "synthetic-stdio.mjs");

/** Child env rebuilt from scratch — home/temp/cache point INSIDE the
 * workspace, nothing inherited from the production environment. */
function buildChildEnv(workspaceDir: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: workspaceDir,
    USERPROFILE: workspaceDir,
    APPDATA: workspaceDir,
    TMPDIR: workspaceDir,
    TMP: workspaceDir,
    TEMP: workspaceDir,
    XDG_CACHE_HOME: workspaceDir,
    XDG_CONFIG_HOME: workspaceDir,
    XDG_DATA_HOME: workspaceDir,
  };
  // Windows CreateProcess needs the system directory roots to launch
  // anything at all; pass them through on win32 only — never elsewhere.
  if (process.platform === "win32") {
    for (const k of ["SystemRoot", "SystemDrive", "windir"]) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
  }
  return env;
}

const workspaceRoot = process.env.TIVANO_WORKSPACE_ROOT
  ? resolve(process.env.TIVANO_WORKSPACE_ROOT)
  : null;
const paths = new ProjectRuntimePaths(
  workspaceRoot ? [workspaceRoot] : [],
  join(dataRoot, "workspace-grants.json"),
  dataRoot,
);

// Assigned inside whenReady once the async provider bootstrap completes;
// every consumer below is a closure that can only run after bootstrap.
let engine: Engine | null = null;
let adapter: ProviderAdapter | null = null;
let codexRuntime: CodexRuntimeConfig | null = null;

// Packaged job-helper attestation is kicked off HERE — at module load, in
// parallel with Electron startup — and shared by BOTH consumers: the
// codex provider branch (job-object payload spawning) and the Git
// bootstrap (helper --run executor). One probe, one verdict.
// The probe is bounded (5 s probe plus 1 s cleanup observation) and
// fail-closed: any missing/replaced/mismatched artifact yields
// supported:false, never a fallback. On non-win32/dev it resolves
// immediately with an unsupported verdict — running it unconditionally
// is what lets the mock provider's packaged Windows build also get a
// real Git verdict.
const probeChildren = new Set<ChildProcess>();
let bootstrapClosing = false;
let bootstrap: Promise<void>;
const packagedTreeProbe = probeAndAttestPackagedJobHelper({
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath ?? null,
  children: probeChildren,
});

/** Git runtime bootstrap — resolved ONCE here, pinned forever. POSIX
 *  keeps the platform Git (/usr/bin/git). Windows needs BOTH a resolved
 *  real git.exe AND the shared attested helper's --run capability; any
 *  gap reports an honest unavailable reason instead of spawning. */
interface GitBootstrap {
  platform: NodeJS.Platform;
  gitExe: string;
  runner?: GitRunner;
  unavailableReason?: string;
  /** Provenance (env/standard/path/posix) — diagnostic only. */
  resolvedFrom?: string;
}
let gitBootstrap: GitBootstrap | null = null;

async function resolveGitBootstrap(): Promise<GitBootstrap> {
  if (gitBootstrap) return gitBootstrap;
  const platform = process.platform;
  const resolved = resolveGitExecutable(process.env, { platform });
  if (resolved.kind !== "resolved") {
    gitBootstrap = { platform, gitExe: "", unavailableReason: resolved.reason };
    return gitBootstrap;
  }
  if (platform !== "win32") {
    gitBootstrap = { platform, gitExe: resolved.executable, resolvedFrom: resolved.source };
    return gitBootstrap;
  }
  // Windows: Git NEVER spawns directly — only through the attested
  // job-helper's --run mode. Missing/hash-invalid/old helper or a dev
  // (unpackaged) build all mean honest containment-unavailable.
  const cap = await packagedTreeProbe;
  if (!cap?.supported || !cap.helperPath || cap.runCapable !== true) {
    gitBootstrap = {
      platform,
      gitExe: resolved.executable,
      resolvedFrom: resolved.source,
      unavailableReason: "git-containment",
    };
    return gitBootstrap;
  }
  gitBootstrap = {
    platform,
    gitExe: resolved.executable,
    runner: makeGitRunnerViaJobHelper(cap.helperPath, resolved.executable),
    resolvedFrom: resolved.source,
  };
  return gitBootstrap;
}

/** AppInfo.codex — the only codex state the renderer may see. */
export function codexInfoFor(cfg: CodexRuntimeConfig): CodexInfo {
  const base = {
    protocolPin: CODEX_SCHEMA_PIN,
    cliVersion: "unknown",
    codexHomeId: cfg.codexHomeId,
  };
  switch (cfg.mode) {
    case "fixture":
      return {
        ...base,
        state: "fixture",
        executable: `${cfg.fixtureNode} ${cfg.fixtureScript}`,
      };
    case "real": {
      if (cfg.treeCapability.supported)
        return {
          ...base,
          state: "configured-unverified",
          executable: cfg.executable!,
          ...(cfg.treeCapability.helperVersion
            ? { helperVersion: cfg.treeCapability.helperVersion }
            : {}),
        };
      const reason = cfg.realUnavailableReason ?? cfg.treeCapability.reason;
      return {
        ...base,
        state: "unsupported",
        executable: cfg.executable!,
        ...(reason ? { reason } : {}),
      };
    }
    default:
      return {
        ...base,
        state: "unconfigured",
        ...(cfg.realUnavailableReason ? { reason: cfg.realUnavailableReason } : {}),
      };
  }
}

async function makeProvider(): Promise<ProviderAdapter> {
  // Persisted setup candidate (P2N). Read once here, like every env var —
  // it can only select the NEXT launch's codex route, never hijack an
  // explicit TIVANO_PROVIDER (synthetic/mock/unknown keep their behavior).
  const savedExe = store.state.settings.codexExecutable?.trim() || undefined;
  const explicitProvider = process.env.TIVANO_PROVIDER;
  if (explicitProvider === "codex" || (explicitProvider === undefined && savedExe !== undefined)) {
    // The attested packaged-helper verdict — awaited once here; the probe
    // itself has been running since module load in parallel with Electron.
    const treeCapability = (await packagedTreeProbe) ?? undefined;
    codexRuntime = resolveCodexRuntime(process.env, dataRoot, {
      ...(treeCapability ? { treeCapability } : {}),
      ...(savedExe ? { savedExecutable: savedExe } : {}),
    });
    return new CodexAppServerProvider({
      config: codexRuntime,
      clientVersion: app.getVersion(),
      lookupBinding: (tid) => engine!.lookupProviderThread(tid),
      bindThread: (tid, b) => engine!.bindProviderThread(tid, b),
      onThreadNotice: (tid, text, level) =>
        engine!.onThreadNotice(tid, text, level),
      // F18: the Settings-connected MCP registry rides into each new
      // thread's config.mcp_servers (live-read per bind).
      mcpServers: () => engine!.snapshot().settings.mcpServers ?? [],
    });
  }
  if (process.env.TIVANO_PROVIDER !== "synthetic-stdio") {
    const mockOpts: ConstructorParameters<typeof MockProvider>[0] = {};
    if (process.env.TIVANO_MOCK_TICK_MS)
      mockOpts.tickMs = Number(process.env.TIVANO_MOCK_TICK_MS);
    return new MockProvider(mockOpts);
  }
  // Synthetic stdio: executable is an explicit absolute Node path supplied
  // by the bootstrap/test harness. Recording the resolved executable and
  // its real version here is diagnostic, not provider probing.
  const nodeExe = process.env.TIVANO_SYNTHETIC_NODE ?? null;
  const scenarioRaw = process.env.TIVANO_SYNTHETIC_SCENARIO ?? "chat";
  const scenario = (SCENARIOS as readonly string[]).includes(scenarioRaw)
    ? (scenarioRaw as SyntheticScenario)
    : "chat";
  const runtimeInfo = nodeExe
    ? (() => {
        try {
          const r = spawnSync(nodeExe, ["--version"], {
            encoding: "utf8",
            timeout: 5000,
            env: {},
          });
          return { executable: nodeExe, version: (r.stdout ?? "").trim() || "unknown" };
        } catch {
          return { executable: nodeExe, version: "unknown" };
        }
      })()
    : undefined;

  return new SyntheticStdioProvider({
    scenario,
    ...(runtimeInfo ? { runtimeInfo } : {}),
    makeSpec(workspaceDir, sc) {
      if (!nodeExe || !isAbsolute(nodeExe) || nodeExe.includes("\0"))
        throw new Error(
          "SYNTHETIC_RUNTIME_NOT_CONFIGURED: TIVANO_SYNTHETIC_NODE must be an absolute executable path",
        );
      return {
        executable: nodeExe,
        args: [fixtureFile, `--scenario=${sc}`],
        cwd: workspaceDir,
        env: buildChildEnv(workspaceDir),
      };
    },
  });
}

let win: BrowserWindow | null = null;
// v2.2.34 quick chat: the only second surface the guard admits. The
// webContents is created synchronously inside `new BrowserWindow()` —
// before our reference can be assigned — so admission rides a flag held
// for exactly that one construction call.
let admittingQuickContents = false;
let quickWin: BrowserWindow | null = null;
const indexFile = join(__dirname, "..", "renderer", "index.html");
const allowedUrl = pathToFileURL(indexFile).href;

app.on("web-contents-created", (_event, contents) => {
  // Only the one application window may exist; destroy stray guests (webview,
  // devtools popouts, background pages) before they attach anywhere.
  if (admittingQuickContents) return;
  if (win && contents !== win.webContents) contents.close();
});

// ---- close flow: block work → dispose children → save → finish ------------

// Test-harness injection: fail the next N dispose passes, then succeed —
// lets e2e cover close-failure → keep-open/retry deterministically.
let disposeFailLeft = Number(process.env.TIVANO_TEST_DISPOSE_FAIL ?? "0") || 0;

// Embedded terminal sessions — main-owned, one PTY host per incarnation.
// Wired before the coordinator so teardown reaches it; the broadcast is
// bound at window creation (registerIpc below shares the same channel).
let terminals: TerminalService | null = null;
let git: GitService | null = null;
let checkpoints: CheckpointCoordinator | null = null;
let localControl: LocalControlService | null = null;

const coordinator = new CloseCoordinator({
  blockNewWork: () => { bootstrapClosing = true; engine?.shutdown(); },
  disposeChildren: async () => {
    await bootstrap;
    const result = adapter
      ? await adapter.dispose()
      : { children: [], orphanedPending: 0 };
    const problems = await disposeJobHelperProbes(probeChildren);
    if (terminals) {
      const t = await terminals.dispose();
      problems.push(...t.problems);
    }
    if (git) {
      const g = await git.dispose();
      problems.push(...g.problems);
    }
    if (checkpoints) {
      const c = await checkpoints.dispose();
      problems.push(...c.problems);
    }
    // F33: the control socket closes with the app — never survives the
    // instance that minted its tickets.
    localControl?.dispose();
    for (const c of result.children) {
      if (!c.confirmed)
        problems.push(`child pid ${c.pid ?? "?"}: ${c.problem ?? "close unconfirmed"}`);
    }
    if (result.orphanedPending > 0)
      problems.push(`${result.orphanedPending} provider request(s) never resolved`);
    if (disposeFailLeft > 0) {
      disposeFailLeft--;
      problems.push("TIVANO_TEST_DISPOSE_FAIL: injected cleanup failure");
    }
    return { problems };
  },
  saveStore: () => store.close(),
  askUser: async (failure) => {
    // Test harness only: bypass the native dialog deterministically.
    if (process.env.TIVANO_TEST_ASK === "keep") return "keep";
    if (process.env.TIVANO_TEST_ASK === "retry") return "retry";
    if (!win || win.isDestroyed()) return "keep";
    const r = await dialog.showMessageBox(win, {
      type: "error",
      message: "Could not finish closing cleanly",
      detail: `${failure}\n\nNothing was deleted; the data file and child processes were left untouched where their state was uncertain.`,
      buttons: ["Retry", "Keep open (read-only)"],
      defaultId: 0,
      cancelId: 1,
    });
    return r.response === 0 ? "retry" : "keep";
  },
  finishQuit: () => {
    // Resume the originally requested close/quit — exactly once.
    if (win && !win.isDestroyed()) win.close();
    else app.quit();
  },
  enterReadOnly: () => engine?.enterReadOnly(),
});

app.on("before-quit", (e) => {
  if (!coordinator.allowQuit) {
    e.preventDefault();
    coordinator.requestClose();
  }
});

bootstrap = app.whenReady().then(async () => {
  // Provider + engine bootstrap: the codex branch awaits the bounded
  // helper attestation (started at module load) — everything downstream
  // (store recovery, grants restore, IPC) only exists after this.
  adapter = await makeProvider();
  engine = new Engine(store, adapter, store.root, app.getVersion(), paths);
  // F20 test hook: shrink the post-reset margin so e2e/vitest can watch a
  // real auto-resume inside seconds — the frozen 5s floor never moves.
  if (process.env.TIVANO_LIMIT_MARGIN_MS)
    engine.limitMarginMs = Math.max(0, Number(process.env.TIVANO_LIMIT_MARGIN_MS) || 0);
  if (codexRuntime) engine.codexInfo = codexInfoFor(codexRuntime);
  engine.noteStoreRecovery(store.recoveredFrom);
  // Rebuild authorized workspace grants from the persisted file — each
  // entry is revalidated against the live filesystem and the live project
  // list; failures are loud, never silently substituted or recreated.
  {
    const res = paths.restore(new Set(engine.snapshot().projects.map((p) => p.id)));
    for (const f of res.failed)
      console.warn(
        `[workspace] project ${f.projectId}: grant could not be restored (${f.directory}): ${f.reason}`,
      );
  }
  engine.recoverInFlight();
  if (bootstrapClosing) engine.shutdown();

  const provider = adapter;
  const eng = engine;

  const validationTitle = typeof TIVANO_TERMINAL_CANDIDATE !== "undefined" && TIVANO_TERMINAL_CANDIDATE === true
    ? eng.snapshot().settings.language === "zh-Hans"
      ? "Tivano Windows Dev — 终端验证候选版"
      : "Tivano Windows Dev — Terminal validation candidate"
    : null;
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: validationTitle ?? "Tivano Windows (Dev)",
    backgroundColor: "#1E1E20",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  if (validationTitle) win.on("page-title-updated", (event) => event.preventDefault());

  // External-open test seam (owner upgrade-v2234): armed only for
  // unpackaged builds launched with TIVANO_TEST_EXTERNAL_OPEN under a
  // temp test root — records instead of launching host windows.
  const externalLog = externalOpenLogPath(process.env, {
    packaged: app.isPackaged,
    dataRoot,
  });
  lockdownWebContents(win.webContents, {
    allowedUrl,
    onExternalRequest: (url) => {
      if (externalLog) {
        recordExternalOpen(externalLog, { action: "openExternal", target: url });
        return;
      }
      void shell.openExternal(url);
    },
  });

  // F27: ⌘W is an APP command (the frozen archive prompt), not a window
  // close — intercept it before the default menu accelerator can eat it.
  // A cleared/rebound ⌘W still never closes the window by surprise. All
  // other system chords (⌘H/⌘M/⌘Q…) stay the OS's — the recorder refuses
  // them via the reserved list.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (
      input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      return;
    }
    // A82: the frozen font-size chords (CmdOrCtrl + = / + / - / 0) are
    // app commands, not chromium zoom — stop the default menu's Zoom
    // accelerators from eating them; the page still sees the keydown.
    if (
      (input.meta || input.control) &&
      !input.alt &&
      ["=", "+", "-", "_", "0"].includes(input.key)
    )
      event.preventDefault();
  });

  // Main-owned directory chooser: the renderer can only request it; every
  // path arrives exclusively from dialog.showOpenDialog on this window.
  // usability is checked before the dialog opens AND after it resolves —
  // a destroyed window or an engine in closing/read-only can never
  // materialize a late project.
  const dirOpener = new DirectoryOpener({
    showOpenDialog: () => {
      if (!win || win.isDestroyed())
        return Promise.resolve({ canceled: true, filePaths: [] });
      return dialog.showOpenDialog(win, {
        title:
          eng.snapshot().settings.language === "zh-Hans" ? "打开文件夹" : "Open folder",
        properties: ["openDirectory", "multiSelections"],
      });
    },
    usable: () => !!win && !win.isDestroyed() && !eng.readOnly,
    attach: (raw) => eng.openUserDirectory(raw),
  });

  const broadcast = forwardEvents(win.webContents);

  // Codex setup (P2N): main-owned chooser + pending choice; the renderer
  // only ever receives the validated physical path that came back from
  // the native dialog. A TIVANO_TEST_CODEX_PICK env value bypasses the
  // dialog itself for deterministic E2E — the value still passes through
  // full validateCodexExecutable before it can become a pending choice,
  // and it is main-side only (a renderer can never set env).
  const codexSetupMutable = () =>
    !!win && !win.isDestroyed() && !eng.readOnly && store.ownsWrites;
  const codexSetup = new CodexSetup({
    mutable: codexSetupMutable,
    savedExecutable: () => store.state.settings.codexExecutable,
    commit: (p) => eng.setCodexExecutable(p),
    platform: process.platform,
  });
  const codexShowOpenDialog = () => {
    const pick = codexTestPick(app.isPackaged, process.env);
    if (pick !== undefined)
      return Promise.resolve(
        pick === ""
          ? { canceled: true, filePaths: [] as string[] }
          : { canceled: false, filePaths: [pick] },
      );
    if (!win || win.isDestroyed())
      return Promise.resolve({ canceled: true, filePaths: [] as string[] });
    return dialog.showOpenDialog(win, {
      title:
        eng.snapshot().settings.language === "zh-Hans"
          ? "选择 Codex 程序"
          : "Choose Codex executable",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [{ name: "codex.exe", extensions: ["exe"] }]
          : [{ name: "Codex CLI", extensions: ["exe", "*"] }],
    });
  };
  /** Live, honest setup snapshot — the launch's pinned runtime separated
   *  from the persisted next-launch candidate. */
  const codexSetupState = (): CodexSetupState => {
    const saved = store.state.settings.codexExecutable ?? null;
    const providerOverride = process.env.TIVANO_PROVIDER ?? null;
    const launchProvider = adapter?.descriptor.mode ?? "mock";
    const effSource = codexRuntime?.configuredFrom ?? null;
    const effExe =
      codexRuntime?.mode === "real" ? codexRuntime.executable ?? null : null;
    let savedInvalidReason: string | undefined;
    if (saved) {
      try {
        validateCodexExecutable(saved);
      } catch (err) {
        savedInvalidReason = (err as Error).message;
      }
    }
    const { savedEffect, savedBlockReason } = codexSavedEffect(
      saved, codexRuntime, process.env, savedInvalidReason,
    );
    return {
      savedExecutable: saved,
      ...(savedInvalidReason ? { savedInvalidReason } : {}),
      pendingExecutable: codexSetup.pendingExecutable,
      chooserBusy: codexSetup.isChooserBusy,
      providerOverride,
      launchProvider,
      effectiveSource: effSource,
      effectiveExecutable: effExe,
      savedEffect,
      ...(savedBlockReason ? { savedBlockReason } : {}),
      runtime: codexRuntime ? codexInfoFor(codexRuntime) : null,
      mutable: codexSetupMutable(),
    };
  };
  // Windows terminal gate — a VALIDATION CANDIDATE only: the compile-time
  // flag (--terminal-candidate, a baked esbuild literal — never an env
  // var) AND the SAME shared packaged-helper attestation must report
  // terminalCapable. Ordinary builds/deep paths leave it false and the
  // service keeps answering { unavailable: "platform" }. The verdict is
  // pinned here at bootstrap; nothing later can re-mint it.
  const treeCap = await packagedTreeProbe;
  const windowsTerminalCapable =
    process.platform === "win32" &&
    typeof TIVANO_TERMINAL_CANDIDATE !== "undefined" &&
    TIVANO_TERMINAL_CANDIDATE === true &&
    treeCap?.supported === true &&
    treeCap.terminalCapable === true &&
    typeof treeCap.helperPath === "string";
  terminals = new TerminalService({
    paths,
    threads: () => eng.snapshot().threads,
    mutable: () => !eng.readOnly,
    emit: broadcast,
    spawnHost:
      process.platform === "win32"
        ? () => {
            // The service gate guarantees this is only reached when the
            // candidate AND attestation hold; the throw is a fail-closed
            // backstop, never a fallback path.
            if (!windowsTerminalCapable || !treeCap?.helperPath)
              throw new Error("windows terminal capability was never attested");
            return spawnWindowsTerminalHost({ helperPath: treeCap.helperPath });
          }
        : forkPtyHost,
    isolatedHomeRoot: join(dataRoot, "terminal-home"),
    ...(process.platform === "win32"
      ? { windowsTerminalReady: () => windowsTerminalCapable }
      : {}),
  });
  eng.attachTerminals(terminals);
  const gitBoot = await resolveGitBootstrap();
  git = new GitService({
    paths,
    projects: () => eng.snapshot().projects,
    mutable: () => !eng.readOnly,
    emit: broadcast,
    dataRoot,
    gitExe: gitBoot.gitExe || GIT_POSIX_EXECUTABLE,
    platform: gitBoot.platform,
    ...(gitBoot.unavailableReason ? { unavailableReason: gitBoot.unavailableReason } : {}),
    ...(gitBoot.runner ? { runner: gitBoot.runner } : {}),
  });
  // F11: worktree ops ride the SAME runner/grant gates as read-only git.
  eng.attachWorktrees(git);

  // Checkpoint slice (P2L): the SAME resolved Git bootstrap as GitService —
  // on Windows the attested Job --run runner or the pinned unavailable
  // reason, never a direct spawn. The coordinator owns the per-turn
  // before/end lifecycle and the durable ledger; engine callbacks reach
  // it through attachCheckpoints only.
  {
    const service = new CheckpointService({
      paths,
      projects: () => eng.snapshot().projects,
      threads: () => eng.snapshot().threads,
      mutable: () => !eng.readOnly,
      dataRoot,
      gitExe: gitBoot.gitExe || GIT_POSIX_EXECUTABLE,
      platform: gitBoot.platform,
      ...(gitBoot.unavailableReason ? { unavailableReason: gitBoot.unavailableReason } : {}),
      ...(gitBoot.runner ? { runner: gitBoot.runner } : {}),
    });
    checkpoints = new CheckpointCoordinator({
      service,
      ledger: new CheckpointLedger(join(dataRoot, "checkpoints"), dataRoot),
      paths,
      projects: () => eng.snapshot().projects,
      threads: () => eng.snapshot().threads,
      emit: broadcast,
    });
    eng.attachCheckpoints(checkpoints);
  }

  // F29: real OS sleep-prevention via Electron powerSaveBlocker. The
  // engine owns the policy (only running work holds a token); the modes
  // map to prevent-app-suspension / prevent-display-sleep. A failed
  // start degrades honestly to off — the snapshot reports held state.
  eng.attachSleepBlocker({
    start: (mode) =>
      powerSaveBlocker.start(
        mode === "display" ? "prevent-display-sleep" : "prevent-app-suspension",
      ),
    stop: (id) => powerSaveBlocker.stop(id),
  });
  // F28 dock/taskbar badge — real app.setBadgeCount where the platform
  // supports it (macOS dock, Linux launcher); a Windows no-op today,
  // honestly so until the taskbar overlay lands.
  eng.attachBadgeUpdater((count) => {
    try {
      app.setBadgeCount(count);
    } catch {
      /* badge support varies by platform */
    }
  });

  // F33 local control: same-account Unix socket, off by default behind
  // BOTH settings gates. refreshListening on every settings change —
  // closing either gate stops listening and drops live connections.
  localControl = new LocalControlService(eng, dataRoot);
  localControl.refreshListening();
  eng.onEvent((e) => {
    if (e.type === "settings-changed") {
      localControl?.refreshListening();
      refreshQuickChord();
    }
  });

  // v2.2.34 quick chat: one hidden always-on-top panel lazily created;
  // the global shortcut is registered only while quickChatEnabled is on
  // (frozen ⇧⌘Space default). Electron has no nonactivating NSPanel —
  // the box takes real focus and click-away hides it, keeping the draft.
  const ensureQuickWin = (): BrowserWindow => {
    if (quickWin && !quickWin.isDestroyed()) return quickWin;
    admittingQuickContents = true;
    try {
      quickWin = new BrowserWindow({
      width: 620,
      height: 220,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#1E1E20",
      webPreferences: {
        preload: join(__dirname, "..", "preload", "index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
      });
    } finally {
      admittingQuickContents = false;
    }
    void quickWin.loadFile(indexFile, { hash: "quick" });
    quickWin.on("blur", () => quickWin?.hide());
    quickWin.on("closed", () => {
      quickWin = null;
    });
    return quickWin;
  };
  const showQuick = (): void => {
    const q = ensureQuickWin();
    if (eng.readOnly) return;
    q.center();
    q.show();
    q.focus();
  };
  const hideQuick = (): void => {
    quickWin?.hide();
  };
  const chordToAccelerator = (chord: {
    key: string;
    mod: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }): string | null => {
    // Bounded DOM-code → accelerator map; keys outside it refuse to arm
    // rather than registering a wrong chord.
    let key: string;
    if (/^Key[A-Z]$/.test(chord.key)) key = chord.key.slice(3);
    else if (/^Digit[0-9]$/.test(chord.key)) key = chord.key.slice(5);
    else if (chord.key === "Space") key = "Space";
    else if (chord.key === "Tab") key = "Tab";
    else if (chord.key === "Enter") key = "Enter";
    else return null;
    const parts: string[] = [];
    if (chord.ctrl) parts.push("Ctrl");
    if (chord.alt) parts.push("Alt");
    if (chord.shift) parts.push("Shift");
    if (chord.mod) parts.push("CommandOrControl");
    parts.push(key);
    return parts.join("+");
  };
  let quickAcc: string | null = null;
  const refreshQuickChord = (): void => {
    if (quickAcc) {
      globalShortcut.unregister(quickAcc);
      quickAcc = null;
    }
    const s = eng.snapshot().settings;
    if (!s.quickChatEnabled || eng.readOnly) return;
    const chord = effectiveChord(
      "quickChat",
      s.shortcuts,
      process.platform === "darwin",
    );
    if (!chord) return;
    const acc = chordToAccelerator(chord);
    if (!acc) return;
    if (globalShortcut.register(acc, showQuick)) quickAcc = acc;
    // A failed register (chord already held by another app) leaves the
    // feature simply inactive — honest, no retry storm.
  };
  refreshQuickChord();

  // F33 CLI command surface (frozen ControlCLIInstaller): the bundled
  // client is cli/tivano.mjs next to the app root (unbundled) or under
  // resourcesPath when packaged. Install is request-only and never
  // enables local control. TIVANO_TEST_CLI_DIR redirects the bin dir in
  // tests so no real ~/.local/bin is touched.
  const cliDir =
    process.env.TIVANO_TEST_CLI_DIR && !app.isPackaged
      ? process.env.TIVANO_TEST_CLI_DIR
      : cliBinDir();
  const cliTarget = app.isPackaged
    ? join(process.resourcesPath, "cli", "tivano.mjs")
    : join(app.getAppPath(), "cli", "tivano.mjs");
  const cliSurface = {
    status: () => ({ ...cliStatus(cliDir, cliTarget), dir: cliDir }),
    install: () => {
      const r = installCli(cliDir, cliTarget);
      return { ...r, dir: cliDir };
    },
    uninstall: () => {
      const r = uninstallCli(cliDir);
      return { ...r, dir: cliDir };
    },
  };

  registerIpc({
    engine: eng,
    allowedUrl,
    broadcast,
    terminals,
    git,
    localControl,
    cli: cliSurface,
    externalLog: externalLog ?? undefined,
    openDirectory: () => dirOpener.open(),
    // A74 frozen MCPKeyPanel pickPath: native file/folder chooser for a
    // path-kind catalog field — main-owned like dirOpener;
    // TIVANO_TEST_MCP_PICK bypasses the dialog for deterministic E2E
    // exactly like TIVANO_TEST_CODEX_PICK.
    mcpPickPath: async (dirs) => {
      const test = process.env.TIVANO_TEST_MCP_PICK;
      if (test !== undefined) return test === "" ? null : test;
      if (!win || win.isDestroyed() || eng.readOnly) return null;
      const zh = eng.snapshot().settings.language === "zh-Hans";
      const r = await dialog.showOpenDialog(win, {
        title: zh ? "选择路径" : "Choose a path",
        properties: dirs ? ["openDirectory"] : ["openFile"],
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    focusWindow: () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    quick: {
      show: showQuick,
      hide: hideQuick,
      isVisible: () => quickWin?.isVisible() ?? false,
      // Expand carries the text into the main composer's selected thread
      // (frozen quickDraft → full chat handoff).
      expand: (text) => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        // Must ride engine emit — direct broadcast lacks the rev stamp
        // and the renderer drops unstamped events.
        eng.announceQuickDraft(text);
        hideQuick();
      },
    },
    codexSetup: {
      state: codexSetupState,
      choose: () => codexSetup.choose(codexShowOpenDialog),
      save: () => codexSetup.save(),
      clear: () => codexSetup.clear(),
    },
    // F05 draft attachments: the dialog is main-owned; a
    // TIVANO_TEST_ATTACH env value (path-delimited) bypasses it for
    // deterministic E2E exactly like TIVANO_TEST_CODEX_PICK.
    // F05 @-mention index + downloads popover — the same attested Git
    // runner as GitService (Windows: the Job --run helper), the thread's
    // OWN resolved directory, and ids that never expose a path.
    files: (() => {
      const runner =
        gitBoot.runner ??
        makeGitRunner(gitBoot.gitExe || GIT_POSIX_EXECUTABLE);
      const env = gitChildEnv(join(dataRoot, "git-home"), undefined, {
        platform: gitBoot.platform,
        executable: gitBoot.gitExe || GIT_POSIX_EXECUTABLE,
      });
      // Test seam of the TIVANO_MOCK_TICK_MS kind: the e2e shrinks the
      // frozen 60s freshness window so a check can watch the refresh
      // trigger fire; unset means the frozen window applies.
      const indexFreshMs = Number(process.env.TIVANO_FILE_INDEX_FRESH_MS);
      const index = new FileIndexService({
        isRepo: async (dir) => {
          const r = await runner
            .run(["rev-parse", "--is-inside-work-tree"], {
              cwd: dir,
              env,
              timeoutMs: 10_000,
              maxBytes: 64 * 1024,
            })
            .done;
          return r.code === 0 && r.stdout.trim() === "true";
        },
        gitFiles: async (dir) => {
          const r = await runner
            .run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
              cwd: dir,
              env,
              timeoutMs: 30_000,
              maxBytes: 8 * 1024 * 1024,
            })
            .done;
          if (r.code !== 0) return [];
          return r.stdout.split("\0").filter((s) => s.length > 0);
        },
        ...(indexFreshMs > 0 ? { freshMs: indexFreshMs } : {}),
      });
      return {
        search: async (threadId: string, query: string) => {
          const dir = eng.threadDirectory(threadId);
          if (dir === null || !FileIndexService.exists(dir))
            return { paths: [] };
          const paths = await index.list(dir);
          return { paths: scoreMentionPaths(paths, query) };
        },
      };
    })(),
    downloads: (() => {
      // TIVANO_DOWNLOADS_DIR is the deterministic test seam — like
      // TIVANO_TEST_ATTACH it overrides a main-owned folder, never
      // grants a renderer-named path.
      const dir =
        process.env.TIVANO_DOWNLOADS_DIR ??
        (() => {
          try {
            return app.getPath("downloads");
          } catch {
            return null;
          }
        })();
      const service = new DownloadsService(dir);
      return {
        list: () => service.list(),
        resolve: (id: string) => service.resolve(id),
        reveal: async () => {
          const d = service.dir();
          if (d === null) throw new EngineError("no downloads directory on this system");
          if (externalLog) {
            recordExternalOpen(externalLog, { action: "openPath", target: d });
            return;
          }
          const err = await shell.openPath(d);
          if (err) throw new EngineError(err);
        },
      };
    })(),
    attachments: (() => {
      const service = new AttachmentService({
        attachmentsRoot: join(dataRoot, "attachments"),
        showOpenDialog: () => {
          const test = process.env.TIVANO_TEST_ATTACH;
          if (test !== undefined) {
            return Promise.resolve({
              canceled: test === "",
              filePaths: test === "" ? [] : test.split(delimiter).filter(Boolean),
            });
          }
          if (!win || win.isDestroyed())
            return Promise.resolve({ canceled: true, filePaths: [] });
          return dialog.showOpenDialog(win, {
            title:
              eng.snapshot().settings.language === "zh-Hans" ? "添加附件" : "Attach",
            properties: ["openFile", "multiSelections"],
          });
        },
        add: (threadId, files) => eng.addAttachments(threadId, files),
        remove: (threadId, id) => eng.removeAttachment(threadId, id),
        resolve: (threadId, id) => eng.attachmentDescriptor(threadId, id),
      });
      return {
        pick: (threadId: string) => service.pick(threadId),
        addBlobs: (threadId: string, files: { name: string; data: Uint8Array }[]) =>
          service.addBlobs(threadId, files),
        addPaths: (threadId: string, paths: string[]) =>
          service.addPaths(threadId, paths),
        read: (threadId: string, id: string) => service.read(threadId, id),
        remove: (threadId: string, id: string) => service.remove(threadId, id),
      };
    })(),
    // F26 wallpaper library: one user-picked picture under the app data
    // root. The chooser is main-owned — TIVANO_TEST_WALLPAPER bypasses
    // the OS dialog for deterministic E2E (a path only main ever sees;
    // the persisted slot stays a generated basename).
    wallpaper: new WallpaperService(join(dataRoot, "wallpaper-store"), () => {
      const test = process.env.TIVANO_TEST_WALLPAPER;
      if (test !== undefined)
        return Promise.resolve(test === "" ? null : test);
      if (!win || win.isDestroyed()) return Promise.resolve(null);
      return dialog
        .showOpenDialog(win, {
          title:
            eng.snapshot().settings.language === "zh-Hans" ? "选择图片" : "Choose picture",
          properties: ["openFile"],
          filters: [
            {
              name: eng.snapshot().settings.language === "zh-Hans" ? "图片" : "Images",
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            },
          ],
        })
        .then((r) => (r.canceled || !r.filePaths[0] ? null : r.filePaths[0]));
    }),
    // Auto-register an isolated workspace for each new project ONLY when
    // a process provider (synthetic stdio or codex) and a workspace root
    // are both configured.
    ...(provider.descriptor.mode !== "mock" && workspaceRoot
      ? {
          onProjectCreated: (id: string) => {
            // Main-created directory: exclusive marker + persisted grant,
            // committed only after both provably succeeded.
            const dir = mkdtempSync(join(workspaceRoot, "proj-"));
            paths.registerManaged(id, dir);
          },
        }
      : {}),
  });

  void win.loadFile(indexFile);
  win.on("closed", () => {
    win = null;
  });

  // preventDefault FIRST — the async teardown runs while the window stays
  // alive; on success finishQuit() re-issues the close exactly once.
  win.on("close", (e) => {
    if (!coordinator.allowQuit) {
      e.preventDefault();
      coordinator.requestClose();
    }
  });
}).catch((error) => {
  console.error("provider bootstrap failed", error);
  dialog.showErrorBox("Tivano Windows (Dev)", `Could not initialize the application:\n${String(error?.message ?? error)}`);
  coordinator.requestClose();
});

app.on("window-all-closed", () => {
  app.quit();
});
