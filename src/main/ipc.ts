// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// IPC boundary: every channel validates its payload against the shared schema
// and its sender against the packaged frame before reaching the engine.

import { clipboard, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import * as openIn from "./openIn";
import { requestValidators, EVENT_CHANNEL, type AppEvent, type RequestChannel } from "../shared/ipc";
import { recordExternalOpen, type ExternalOpenRecord } from "./externalOpen";
import { ValidationError } from "../shared/validate";
import { EngineError, type Engine } from "./engine";
import type {
  CodexChooseResult,
  CodexSetupState,
  CodexWriteResult,
  OpenDirectoryResult,
} from "../shared/types";
import { isHttpUrl, isTrustedSender } from "./security";
import { probeMcpServer } from "./mcpService";

export interface IpcOptions {
  engine: Engine;
  allowedUrl: string;
  broadcast: (event: AppEvent) => void;
  /**
   * main-only hook after a project is created — used to bind an isolated
   * workspace directory to it for synthetic stdio turns.
   */
  onProjectCreated?: (projectId: string) => void;
  /**
   * main-owned directory chooser — injected so the renderer can request
   * the dialog but can never name a path (payload is an empty object).
   */
  openDirectory?: () => Promise<OpenDirectoryResult>;
  /** F27 "Show Tivano": bring the main window to the front — a window
   *  management action only, absent only in builds without a window. */
  focusWindow?: () => void;
  /** v2.2.34 quick chat surface (main-owned second panel + expand
   *  handoff). Undefined in tests without a window. */
  quick?: {
    show: () => void;
    hide: () => void;
    expand: (text: string) => void;
    isVisible: () => boolean;
  };
  /** F33 local control — absent only in builds without the slice. */
  localControl?: import("./localControl").LocalControlService;
  /** Embedded terminal service — absent only in builds without the slice. */
  terminals?: import("./terminalService").TerminalService;
  /** F26 wallpaper library — absent only in builds without the slice. */
  wallpaper?: import("./wallpaperService").WallpaperService;
  /** Read-only Git service — absent only in builds without the slice. */
  git?: import("./gitService").GitService;
  /** A74 frozen MCPKeyPanel pickPath: the native chooser for a path-kind
   *  catalog field — the renderer says file-or-folder, the path arrives
   *  only from main's dialog (or the main-owned test pick). */
  mcpPickPath?: (dirs: boolean) => Promise<string | null>;
  /**
   * Codex setup surface (P2N): narrow choose/save/clear operations owned
   * by main — payloads are empty, paths arrive only via the native dialog.
   */
  codexSetup?: {
    state(): CodexSetupState;
    choose(): Promise<CodexChooseResult>;
    save(): CodexWriteResult;
    clear(): CodexWriteResult;
  };
  /**
   * F05 draft attachments (main-owned picker + library copies). The
   * renderer requests a pick and receives path-free descriptors only.
   */
  attachments?: {
    pick(threadId: string): Promise<{
      attached: { id: string; name: string; size: number }[];
      dropped: number;
      canceled?: boolean;
    }>;
    /** F05 paste/drop — bytes the renderer already holds; no path ever
     *  crosses, so the channel grants no file-read primitive. */
    addBlobs(
      threadId: string,
      files: { name: string; data: Uint8Array }[],
    ): Promise<{ attached: { id: string; name: string; size: number }[]; dropped: number }>;
    /** F05 downloads popover — attach copies of main-resolved paths. */
    addPaths(
      threadId: string,
      paths: string[],
    ): Promise<{ attached: { id: string; name: string; size: number }[]; dropped: number }>;
    /** A80 preview: display bytes for a thread-owned image attachment,
     *  or a plain descriptor — never a path. */
    read(
      threadId: string,
      id: string,
    ):
      | { kind: "image"; dataUrl: string; name: string; size: number }
      | { kind: "file"; name: string; size: number }
      | undefined;
    remove(threadId: string, id: string): void;
  };
  /** F05 @-mention index + downloads popover — absent only in builds
   *  without the slices. The renderer never sees a path. */
  files?: {
    search(threadId: string, query: string): Promise<{ paths: string[] }>;
  };
  downloads?: {
    list(): Promise<import("../shared/types").DownloadItem[]>;
    resolve(id: string): string | null;
    reveal(): Promise<void>;
  };
  /** External-open test seam (owner upgrade-v2234): when set, every
   *  native open is recorded here and never launched. Main-owned; armed
   *  only for unpackaged+env+tmp-test-root launches (index.ts gate). */
  externalLog?: string | undefined;
  /** F33 CLI command install surface (frozen ControlCLIInstaller). */
  cli?: {
    status():
      | { state: "absent"; dir: string }
      | { state: "installed"; path: string; target: string; dir: string }
      | { state: "foreign"; path: string; dir: string };
    install(): { state: "installed"; path: string; target: string; dir: string };
    uninstall(): { state: "absent"; dir: string };
  };
}

export function registerIpc(opts: IpcOptions): () => void {
  const { engine, allowedUrl } = opts;

  const guard = (event: IpcMainInvokeEvent): void => {
    const frameUrl = event.senderFrame?.url;
    if (!isTrustedSender(event.sender, frameUrl, allowedUrl))
      throw new ValidationError("untrusted IPC sender");
  };

  const handle = <C extends RequestChannel>(
    channel: C,
    fn: (payload: ReturnType<(typeof requestValidators)[C]>, event: IpcMainInvokeEvent) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, raw: unknown) => {
      guard(event);
      const validate = requestValidators[channel] as (v: unknown) => ReturnType<
        (typeof requestValidators)[C]
      >;
      return fn(validate(raw), event);
    });
  };

  /** Armed seam → record + report true (caller returns early). */
  const openLogged = (r: ExternalOpenRecord): boolean => {
    if (!opts.externalLog) return false;
    recordExternalOpen(opts.externalLog, r);
    return true;
  };

  handle("state:get", () => engine.snapshot());
  handle("app:info", () => engine.info);
  handle("projects:create", (p) => {
    const project = engine.createProject(p.name);
    // Workspace binding failure must not leave a silently misbound project —
    // report it; the project still exists but sends show WORKSPACE_NOT_CONFIGURED.
    try {
      opts.onProjectCreated?.(project.id);
    } catch {
      /* grant simply won't exist; sendTurn reports the clear error */
    }
    return project;
  });
  handle("projects:open-directory", () => {
    if (!opts.openDirectory)
      throw new Error("directory chooser is not available in this build");
    return opts.openDirectory();
  });
  handle("window:focus", () => opts.focusWindow?.());
  handle("projects:toggle", (p) => engine.toggleProject(p.id, p.expanded));
  handle("projects:set-icon", (p) => engine.setProjectIcon(p.id, p.icon));
  handle("projects:delete", (p) => {
    // Terminal sessions of this project's threads die with it — ids are
    // captured before the threads themselves disappear.
    const threadIds = engine
      .snapshot()
      .threads.filter((t) => t.projectId === p.id)
      .map((t) => t.id);
    const r = engine.deleteProject(p.id);
    opts.terminals?.onThreadsDeleted(threadIds);
    opts.git?.onProjectDeleted(p.id);
    return r;
  });
  // The user-facing create path applies the workspace default (frozen
  // newThread); engine-internal spawns call createThread without it.
  handle("threads:create", (p) =>
    engine.createThread(
      // Frozen newThreadLocation resolved against the freshest settings —
      // "standalone" detaches from the caller's affiliation hint.
      p.locationDefault === true &&
        engine.snapshot().settings.newThreadLocation === "standalone"
        ? null
        : p.projectId,
      p.title,
      {
        workspaceDefault: p.applyWorkspaceDefault !== false,
      },
    ),
  );
  handle("threads:select", (p) => engine.selectThread(p.id));
  handle("threads:spawn-helper", (p) =>
    ({ id: engine.spawnHelper(p.parentId, p.title, p.prompt).id }));
  handle("threads:close-helper", (p) => engine.closeHelper(p.id));
  handle("threads:revert", (p) => engine.revertTurn(p.threadId, p.turnId));
  handle("threads:revert-preview", (p) => engine.revertPreview(p.threadId, p.turnId));
  handle("threads:resend", (p) => engine.resendTurn(p.threadId, p.turnId, p.text));
  handle("threads:rename", (p) => engine.renameThread(p.id, p.title));
  handle("threads:set-runtime-mode", (p) => engine.setRuntimeMode(p.threadId, p.mode));
  handle("threads:set-pinned", (p) => engine.setThreadPinned(p.threadId, p.pinned));
  handle("threads:set-interaction-mode", (p) =>
    engine.setInteractionMode(p.threadId, p.mode),
  );
  handle("threads:forward", (p) => ({ id: engine.forwardThread(p.threadId).id }));
  handle("threads:compact", (p) => engine.compactThread(p.threadId));
  // F05 frozen recordCommand — the typed `/plan` path records here;
  // `/compact` records inside compactThread itself.
  handle("slash:record", (p) => engine.recordCommand(p.name));
  handle("attachments:pick", (p) => {
    if (!opts.attachments)
      throw new Error("attachments are not available in this build");
    return opts.attachments.pick(p.threadId);
  });
  handle("attachments:add-blob", (p) => {
    if (!opts.attachments)
      throw new Error("attachments are not available in this build");
    return opts.attachments.addBlobs(p.threadId, p.files);
  });
  handle("attachments:read", (p) => {
    if (!opts.attachments) return undefined;
    return opts.attachments.read(p.threadId, p.id) ?? null;
  });
  handle("attachments:remove", (p) => {
    opts.attachments?.remove(p.threadId, p.id);
  });
  handle("mention:search", async (p) => {
    if (!opts.files) return { paths: [] };
    return opts.files.search(p.threadId, p.query);
  });
  handle("downloads:list", async () => {
    if (!opts.downloads) return [];
    return opts.downloads.list();
  });
  handle("downloads:attach", async (p) => {
    if (!opts.downloads || !opts.attachments)
      throw new Error("downloads are not available in this build");
    const paths = p.ids
      .map((id) => opts.downloads!.resolve(id))
      .filter((x): x is string => x !== null);
    // Stale/unknown ids shrink to nothing rather than guess a path —
    // an empty resolution attaches nothing and reports it back.
    if (paths.length === 0)
      return { attached: [], dropped: 0, unresolved: p.ids.length };
    const r = await opts.attachments.addPaths(p.threadId, paths);
    return { ...r, unresolved: p.ids.length - paths.length };
  });
  handle("downloads:reveal", async () => {
    if (!opts.downloads) throw new Error("downloads are not available in this build");
    return opts.downloads.reveal();
  });
  handle("threads:reorder", (p) => ({ moved: engine.moveThread(p.id, p.targetId, p.placeAfter) }));
  handle("threads:move-affiliation", (p) => {
    const moved = engine.moveThreadToProject(p.id, p.projectId);
    // A moved thread's terminals die with its old affiliation — same
    // ownership rule as deleteThread (frozen applyThreadAffiliation
    // closes them).
    if (moved) opts.terminals?.onThreadsDeleted([p.id]);
    return { moved };
  });
  handle("projects:reorder", (p) => ({ moved: engine.moveProject(p.id, p.targetId, p.placeAfter) }));
  // v2.2.34 quick chat — the send path is a plain new-thread + sendTurn;
  // openApp additionally raises the main window (frozen ⌘↩).
  handle("quick:show", () => opts.quick?.show());
  handle("quick:hide", () => opts.quick?.hide());
  handle("quick:state", () => ({
    visible: opts.quick?.isVisible() ?? false,
  }));
  handle("quick:send", (p) => {
    const thread = engine.createThread(null);
    if (p.model) engine.setThreadModel(thread.id, p.model, null, null);
    engine.sendTurn(thread.id, p.text);
    opts.quick?.hide();
    if (p.openApp) opts.focusWindow?.();
    return { threadId: thread.id };
  });
  handle("quick:expand", (p) => opts.quick?.expand(p.text));
  handle("projects:set-shelved", (p) => {
    engine.setProjectShelved(p.id, p.shelved);
    return { ok: true };
  });
  // F15: directory actions are main-owned — the renderer supplies only a
  // thread id; the engine resolves the real path or refuses honestly.
  handle("folder:reveal", async (p) => {
    const dir = engine.threadDirectory(p.threadId);
    if (dir === null)
      throw new EngineError("no working directory — the thread has no available folder");
    if (openLogged({ action: "openPath", target: dir })) return { path: dir };
    const err = await shell.openPath(dir);
    if (err) throw new EngineError(err);
    return { path: dir };
  });
  // A75 frozen "Worktrees · Reveal": opens the app-owned worktree root
  // — the directory is engine-derived, never renderer-supplied.
  handle("worktrees:reveal", async () => {
    const dir = engine.info.worktreesDir;
    mkdirSync(dir, { recursive: true });
    if (openLogged({ action: "openPath", target: dir })) return { path: dir };
    const err = await shell.openPath(dir);
    if (err) throw new EngineError(err);
    return { path: dir };
  });
  handle("folder:copy", (p) => {
    const dir = engine.threadDirectory(p.threadId);
    if (dir === null)
      throw new EngineError("no working directory — the thread has no available folder");
    clipboard.writeText(dir);
    return { path: dir };
  });
  // F15 "Open in": editor discovery and opening are main-owned — ids and
  // display names cross IPC, paths and executables never do.
  handle("openin:editors", () => ({ editors: openIn.installedEditors() }));
  handle("openin:open", (p) => {
    const dir = engine.threadDirectory(p.threadId);
    if (dir === null)
      throw new EngineError("no working directory — the thread has no available folder");
    try {
      // Record mode still resolves the editor honestly — unknown ids
      // fail the same way; only the spawn is skipped.
      const name = opts.externalLog
        ? openIn.editorName(p.editorId)
        : openIn.openWithEditor(dir, p.editorId);
      if (opts.externalLog)
        openLogged({ action: "openWithEditor", target: dir, detail: p.editorId });
      return { path: dir, editor: name };
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : String(err));
    }
  });
  // Frozen sidebar reveal — showItemInFolder selects the item in its
  // parent manager (distinct from folder:reveal, which opens the folder
  // itself like the frozen menu's "Finder" item).
  handle("openin:reveal", (p) => {
    let path: string | null = null;
    if (p.projectId !== undefined) {
      path = engine.projectDirectory(p.projectId);
    } else if (p.threadId !== undefined) {
      path = engine.threadWorktreePath(p.threadId);
    } else {
      throw new EngineError("reveal needs a threadId or projectId");
    }
    if (path === null || !existsSync(path))
      throw new EngineError("the folder is unavailable — nothing to reveal");
    if (!openLogged({ action: "showItemInFolder", target: path }))
      shell.showItemInFolder(path);
    return { path };
  });
  handle("threads:archive", (p) => engine.archiveThread(p.id));
  handle("threads:unarchive", (p) => engine.unarchiveThread(p.id));
  handle("threads:delete", (p) => {
    const r = engine.deleteThread(p.id);
    opts.terminals?.onThreadsDeleted([p.id]);
    return r;
  });
  handle("threads:delete-archived", (p) => {
    const deleted = engine.deleteArchivedThreads(p.ids);
    if (deleted.length) opts.terminals?.onThreadsDeleted(deleted);
    return { deleted };
  });
  handle("turns:send", (p) => engine.sendTurn(p.threadId, p.text));
  handle("turns:cancel", (p) => engine.cancelTurn(p.threadId));
  handle("hydra:stop", (p) => engine.stopHydraHead(p.threadId));
  handle("threads:set-hydra", (p) => engine.setThreadHydra(p.threadId, p.enabled));
  handle("approvals:resolve", (p) =>
    engine.resolveApproval(p.threadId, p.approvalId, p.optionId),
  );
  handle("questions:answer", (p) =>
    engine.answerQuestion(p.threadId, p.providerKey, p.answers),
  );
  handle("settings:set", (p) => engine.setSettings(p));
  // F33: status read + retry for the Settings surface. The response
  // reports the real socket state — never an optimistic flag.
  handle("control:status", () => {
    const s = engine.snapshot().settings;
    const enabled = s.alphaEnabled === true && s.externalControlEnabled === true;
    return {
      enabled,
      listening: opts.localControl?.listening === true,
      failure: opts.localControl?.listenFailure ?? null,
    };
  });
  handle("control:retry", () => {
    opts.localControl?.refreshListening();
    const s = engine.snapshot().settings;
    const enabled = s.alphaEnabled === true && s.externalControlEnabled === true;
    return {
      enabled,
      listening: opts.localControl?.listening === true,
      failure: opts.localControl?.listenFailure ?? null,
    };
  });
  // F33 frozen CLIInstallationSettings — install/uninstall on request
  // only; never enables local control; conflict refuses rather than
  // replacing a foreign command. The receipt lands in settings.
  handle("cli:status", () => opts.cli?.status() ?? { state: "unavailable" });
  handle("cli:install", () => {
    if (!opts.cli) return { state: "unavailable" };
    const r = opts.cli.install();
    if (r.state === "installed") engine.setSettings({ cliInstallationTarget: r.target });
    return r;
  });
  handle("cli:uninstall", () => {
    if (!opts.cli) return { state: "unavailable" };
    const r = opts.cli.uninstall();
    if (r.state === "absent") engine.setSettings({ cliInstallationTarget: null });
    return r;
  });
  handle("links:open-external", async (p) => {
    if (!isHttpUrl(p.url)) throw new ValidationError("only http/https links may open externally");
    // Test seams (main-owned env, never renderer input): the unified
    // external-open recorder first, then the legacy URL line log — E2E
    // asserts the requested URL either way without a real browser.
    if (openLogged({ action: "openExternal", target: p.url })) return;
    const log = process.env.TIVANO_TEST_OPEN_LOG;
    if (log) {
      appendFileSync(log, p.url + "\n");
      return;
    }
    await shell.openExternal(p.url);
  });

  const terminals = () => {
    if (!opts.terminals) throw new ValidationError("terminal support is not available");
    return opts.terminals;
  };
  handle("terminals:list", (p) => terminals().list(p.threadId));
  handle("terminals:create", (p) => terminals().create(p.threadId, p.cols, p.rows));
  handle("terminals:select", (p) => terminals().select(p.terminalId));
  handle("terminals:input", (p) =>
    terminals().input(p.terminalId, p.incarnation, p.data),
  );
  handle("terminals:resize", (p) => terminals().resize(p.terminalId, p.incarnation, p.cols, p.rows));
  handle("terminals:close", (p) => terminals().close(p.terminalId));
  handle("terminals:restart", (p) => terminals().restart(p.terminalId));
  handle("terminals:ack", (p) => terminals().ack(p.terminalId, p.incarnation, p.seq));

  const git = () => {
    if (!opts.git) throw new ValidationError("git support is not available");
    return opts.git;
  };
  handle("git:overview", (p) => git().overview(p.projectId));
  handle("git:refresh", (p) => git().refresh(p.projectId));
  handle("git:diff", (p) => git().diff(p.projectId, p.snapshotId, p.entryId, p.side));
  handle("git:working-changes", (p) => git().workingChanges(p.projectId));
  handle("git:commit", (p) => git().commit(p.projectId, p.message, p.pushAfter));
  handle("git:push", (p) => git().push(p.projectId));
  // F11 branch menu — engine resolves the thread's execution directory;
  // these names only ever reach git after the frozen checks.
  handle("git:branches", (p) => engine.threadBranches(p.threadId));
  handle("git:switch-branch", (p) => engine.switchThreadBranch(p.threadId, p.name));
  handle("git:create-branch", (p) => engine.createThreadBranch(p.threadId, p.name));
  handle("git:rename-branch", (p) =>
    engine.renameThreadBranch(p.threadId, p.name, p.confirmedPushed === true));
  // F13: generation needs the live patch — fetched here so the engine
  // never talks to Git directly, then handed to the provider capability.
  handle("git:commit-message", async (p) => {
    const changes = await git().workingChanges(p.projectId);
    if (changes.kind !== "ok") return { kind: "unavailable", reason: changes.reason };
    return engine.commitMessageFor(changes.summary, changes.patch);
  });

  // Checkpoint ledger + non-mutating preview. Thread/turn identity only —
  // a request can never name a checkpoint, a root or a path (P2L).
  handle("checkpoints:list", (p) => engine.listCheckpoints(p.threadId));
  handle("checkpoints:preview", (p) => engine.previewCheckpoint(p.threadId, p.turnId));
  handle("checkpoints:restore", (p) => engine.restoreCheckpoint(p.threadId, p.turnId));
  handle("checkpoints:diff", (p) => engine.checkpointDiff(p.threadId, p.turnId, p.path));
  handle("checkpoints:changes", (p) => engine.threadChanges(p.threadId));
  handle("checkpoints:changes-diff", (p) => engine.threadChangeDiff(p.threadId, p.path));
  handle("threads:create-worktree", (p) => engine.createThreadWorktree(p.threadId, p.branch));
  handle("threads:remove-worktree", (p) => engine.removeThreadWorktree(p.threadId));
  // F12 project scripts — set replaces the list wholesale; run resolves
  // the persisted command and opens a script terminal in the thread's
  // execution directory (worktree-aware, sterile shell).
  handle("projects:scripts:set", (p) => engine.setProjectScripts(p.projectId, p.scripts));
  handle("scripts:run", (p) => engine.runProjectScript(p.threadId, p.scriptId));

  // Codex setup (P2N): empty payloads — the only path source is main's
  // native dialog result; choose/save/clear never accept a value.
  const codexSetup = () => {
    if (!opts.codexSetup) throw new ValidationError("codex setup is not available");
    return opts.codexSetup;
  };
  handle("codex:setup-state", () => codexSetup().state());
  handle("codex:choose", () => codexSetup().choose());
  handle("codex:save", () => codexSetup().save());
  handle("codex:clear", () => codexSetup().clear());

  // Per-thread model/effort overrides (F17). The catalog read takes no
  // payload — provider-owned state only; set-model resolves ids from the
  // caller but never guesses usability.
  handle("models:list", () => engine.codexModels());
  // F18: real stdio probe — spawns the configured command, MCP
  // initialize + tools/list, child always killed before returning.
  handle("mcp:probe", (p) => probeMcpServer(p));
  handle("mcp:pick", async (p) => {
    if (!opts.mcpPickPath) return { path: null };
    return { path: await opts.mcpPickPath(p.dirs) };
  });

  // F26 wallpaper — the file slot is main-owned: choose/install lands a
  // library file, remove clears it; `wallpaper:data` reads an installed
  // basename back for display (regex-guarded in the service).
  handle("wallpaper:choose", async () => {
    if (!opts.wallpaper) return { status: "error", reason: "unavailable" };
    const r = await opts.wallpaper.chooseAndInstall(engine.snapshot().settings.wallpaper?.file);
    if (r.status === "installed") engine.setWallpaperFile(r.file);
    return r;
  });
  handle("wallpaper:install", (p) => {
    if (!opts.wallpaper) return { status: "error", reason: "unavailable" };
    const r = opts.wallpaper.installBytes(
      p.name,
      p.data,
      engine.snapshot().settings.wallpaper?.file,
    );
    if (r.status === "installed") engine.setWallpaperFile(r.file);
    return r;
  });
  handle("wallpaper:remove", () => {
    opts.wallpaper?.remove(engine.snapshot().settings.wallpaper?.file);
    engine.clearWallpaper();
  });
  handle("wallpaper:softness", (p) => engine.setWallpaperSoftness(p.softness));
  handle("wallpaper:data", (p) => {
    const bytes = opts.wallpaper?.read(p.file);
    if (!bytes) return null;
    const ext = p.file.slice(p.file.lastIndexOf(".") + 1);
    const mime =
      ext === "png" ? "image/png" :
      ext === "gif" ? "image/gif" :
      ext === "webp" ? "image/webp" :
      ext === "bmp" ? "image/bmp" : "image/jpeg";
    return { dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` };
  });
  handle("hydra:catalog", () => engine.hydraCatalog());
  handle("threads:set-model", (p) =>
    engine.setThreadModel(p.threadId, p.model, p.effort, p.fastTier),
  );
  handle("followUps:enqueue", (p) => engine.enqueueFollowUp(p.threadId, p.text));
  handle("followUps:remove", (p) => engine.removeFollowUp(p.threadId, p.id));
  handle("followUps:update", (p) => engine.updateFollowUp(p.threadId, p.id, p.text));
  handle("followUps:move", (p) => engine.moveFollowUp(p.threadId, p.id, p.targetId, p.after));
  handle("followUps:bundle", (p) => engine.bundleFollowUp(p.threadId, p.id, p.ontoId));
  handle("followUps:unbundle", (p) => engine.unbundleFollowUp(p.threadId, p.id));
  handle("followUps:send-now", (p) => engine.sendFollowUpNow(p.threadId, p.id));
  handle("followUps:interrupt-send", (p) => engine.interruptAndSend(p.threadId, p.text));
  // F20 usage-limit wait controls — thread identity only.
  handle("limit:cancel", (p) => engine.cancelLimitWait(p.threadId));
  handle("limit:handoff", (p) => engine.handoffLimit(p.threadId));
  // F13 detection slice — empty payload; presence + --version only.
  handle("forge:probe", () => engine.probeForgeClis());

  const detach = engine.onEvent(opts.broadcast);
  return () => {
    detach();
    for (const c of Object.keys(requestValidators)) ipcMain.removeHandler(c);
  };
}

export function forwardEvents(contents: WebContents): (e: AppEvent) => void {
  return (e) => {
    if (!contents.isDestroyed()) contents.send(EVENT_CHANNEL, e);
  };
}
