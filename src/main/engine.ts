// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Application service layer: owns projects, threads, turns and approvals.
// Every mutation flows through the Store; every stream event is checked
// against the live turn id and sequence so late, duplicate or foreign-turn
// events can never contaminate a session.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Store } from "./store";
import {
  captureContinuation,
  continuationPrompt,
} from "./continuation";
import { MockProvider, MOCK_ACTION_ID } from "./mockProvider";
import { probeForgeClis, type ForgeCliStatus } from "./forgeProbe";
import { antiSlopInstructions } from "./antiSlop";
import { builtinSlashCommands } from "../shared/slashCommands";
import { clampFontSize } from "../shared/typeScale";
import {
  clampedHydraCap,
  headProfileMatches,
  hydraPairForLead,
  resolveHydraLaunch,
  HYDRA_BUDGET,
  HYDRA_PERSONAS,
  HYDRA_UNCAPPED_CONCURRENCY,
  type HydraCatalog,
  type HydraPersona,
  type ResolvedHydraLaunch,
} from "../shared/hydra";
import {
  HydraDelegationStreamParser,
  MAX_DELEGATED_TASKS,
  MAX_DELEGATION_ROUNDS,
  STALLED_NOTE,
  delegatedHeadPrompt,
  hydraDelegationRequest,
  hydraLeadPolicy,
  hydraReportNote,
  hydraTeamStatus,
  hydraTurnNote,
  markingDelegationBlockSent,
  personaAt,
  personaIndex,
  personaNamed,
  reportMessage,
  withoutDelegationBlock,
  type HydraDelegation,
  type HydraReport,
} from "../shared/hydraDelegation";
import type {
  ProviderAdapter,
  ProviderTurnHandle,
  ReasoningActivity,
  ToolActivity,
  WorkspaceGrant,
} from "./provider";
import type { ProjectRuntimePaths } from "./projectRuntimePaths";
import type { CheckpointCoordinator } from "./checkpointTurns";
import { TokenLedger, TokenSpendTracker } from "./tokenLedger";
import {
  matches as limitMatches,
  resetTime as limitResetTime,
  scheduleResume as limitSchedule,
  formatReset as limitFormatReset,
} from "./usageLimit";
import { limitHandoffText } from "./limitHandoff";
import type { AppEvent } from "../shared/ipc";
import { INTERRUPTED_MARKER } from "../shared/types";
import { threadsInAffiliation } from "../shared/threadOrder";
import { extractTitle } from "../shared/textGen";
import type {
  AppInfo,
  ApprovalRequest,
  ChatThread,
  CodexInfo,
  CodexModelCatalog,
  CodexQuestionRequest,
  FollowUpItem,
  GitCommitMessageResult,
  Message,
  Project,
  ProjectScript,
  ProviderThreadBinding,
  InteractionMode,
  RuntimeMode,
  Snapshot,
  TodoStep,
  Turn,
  WorktreeResult,
} from "../shared/types";

const RUNTIME_MODES: readonly RuntimeMode[] = [
  "supervised",
  "autoAcceptEdits",
  "auto",
  "fullAccess",
];

/** Bound on any single message's persisted content. */
const MAX_MESSAGE_CHARS = 256 * 1024;
/** v2.2.34 title cadence — one user message == one completed turn sent. */
function countUserTurns(thread: ChatThread): number {
  return thread.messages.filter((m) => m.role === "user").length;
}

function boundedText(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS ? text : text.slice(0, MAX_MESSAGE_CHARS) + "…";
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * F29: OS sleep-prevention token holder — the engine owns the policy
 * (frozen TaskSleepPrevention parity: only running work holds a token)
 * and the platform owns the mechanism. "app" maps to Electron's
 * prevent-app-suspension (idle system sleep off, screen free to dim);
 * "display" maps to prevent-display-sleep (screen stays lit too).
 * Manual sleep and lid close always work — the OS owns those.
 */
export interface SleepBlocker {
  start(mode: "app" | "display"): number;
  stop(id: number): void;
}

export class Engine {
  private listeners = new Set<(e: AppEvent) => void>();
  private handles = new Map<string, ProviderTurnHandle>();
  /** Distinct tool-activity store ids seen per live turn (bounded). */
  private toolItemsSeen = new Map<string, Set<string>>();
  /** Codex approvals whose answer is being written to the wire — the
   *  decision is recorded here and commits only on the provider's write
   *  ack (onApprovalAnswerWritten); a withdrawal/error clears it. */
  private inflightDecisions = new Map<string, string>();
  private interruptedThreads: string[] = [];
  private recoveredFrom?: string;
  /**
   * F20 usage-limit auto-continue (frozen AutoContinue port). A provider
   * error parsed as a limit notice is recorded per thread and consumed
   * when that turn ends failed — with the setting on, a wait is set for
   * the reset (+margin, 5s floor) and the continue message sends itself.
   * All three maps are in-memory only: a restart drops the wait exactly
   * like the frozen Task-based scheduler.
   */
  private readonly limitNoted = new Map<string, number | null>();
  private readonly limitWaits = new Map<
    string,
    { token: string; timer: NodeJS.Timeout; model: string | undefined }
  >();
  private readonly limitResumes = new Map<string, number>();
  /** Margin past the reset before resuming (frozen 60s). Injectable for
   *  tests via TIVANO_LIMIT_MARGIN_MS — the 5s floor stays frozen. */
  limitMarginMs = 60_000;
  /** Frozen AutoContinue.continueMessage verbatim. */
  private static readonly LIMIT_CONTINUE_MESSAGE =
    "The usage limit has reset. Continue exactly where you left off and finish the task.";
  /**
   * F03 quiet watchdog (frozen ThreadRuntime.watchQuiet): per-turn clock of
   * the last provider event + one shared ticker while any turn runs. At
   * quietLabelMs the working line shows "No response for N min…"; at
   * quietStopMs (quietToolStopMs while a tool runs) the turn is stopped
   * once with an explanatory notice — the same interrupt path a user stop
   * takes. In-memory only; a reload interrupts running turns anyway.
   * Thresholds are env-overridable for tests — the frozen values stay the
   * defaults: 30s tick / 5min label / 10min stop / 30min tool stop.
   */
  private readonly turnLastEvent = new Map<string, number>();
  private quietTimer: NodeJS.Timeout | null = null;
  private shelveTimer: NodeJS.Timeout | null = null;
  private readonly quietTickMs = Number(process.env.TIVANO_QUIET_TICK_MS) || 30_000;
  private readonly quietLabelMs = Number(process.env.TIVANO_QUIET_LABEL_MS) || 5 * 60_000;
  private readonly quietStopMs = Number(process.env.TIVANO_QUIET_STOP_MS) || 10 * 60_000;
  private readonly quietToolStopMs = Number(process.env.TIVANO_QUIET_TOOL_STOP_MS) || 30 * 60_000;
  /** Per-turn checkpoint lifecycle — attached by bootstrap when the
   *  service exists. Optional so tests/mock runs keep the old path. */
  private checkpoints?: CheckpointCoordinator;
  /**
   * Monotonic event revision. Every emitted event is stamped in the same
   * synchronous block as its mutation, so snapshot().rev forms a clean
   * boundary: events with rev <= snapshot.rev are already reflected in it.
   */
  private rev = 0;
  /**
   * Close gate. "closing" blocks new work while teardown runs; "readonly"
   * is the keep-open state after a failed close — reads and normal
   * mutations stay possible but nothing may start a NEW turn.
   */
  private workGate: "open" | "closing" | "readonly" = "open";
  /**
   * F29: OS sleep-prevention token holder. Attached by bootstrap (real
   * Electron powerSaveBlocker) or by tests (fake). Mode follows the
   * frozen TaskSleepPrevention semantics: "system" blocks idle system
   * sleep, "display" also keeps the screen lit; manual sleep/lid close
   * always work. A token is held ONLY while work is actually running.
   */
  private sleepBlocker?: SleepBlocker;
  private sleepBlockerId: number | undefined;
  private sleepModeActive: "off" | "system" | "display" = "off";
  /**
   * F22: Hydra runtime (bounded frozen slice). Parsers/sent watermarks
   * are keyed per lead turn; delegation rounds and pending reports per
   * lead thread; watchdogs per head thread. Heads are ordinary threads
   * flagged `hydraHead` that run the same provider in the lead's SHARED
   * directory — the brief tells them the workspace is shared and the
   * report tells the lead their work is already there. Nothing here
   * claims an isolation the provider or the checkout doesn't have.
   */
  private readonly hydraParsers = new Map<string, HydraDelegationStreamParser>();
  private readonly hydraTexts = new Map<string, string>();
  private readonly hydraSent = new Map<string, number>();
  private readonly hydraRounds = new Map<string, number>();
  private readonly hydraPendingReports = new Map<string, HydraReport[]>();
  private readonly hydraWatchdogs = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /**
   * F05: draft attachments pending on a thread — main-side records
   * holding the library copy path; the renderer only ever sees the
   * id/name/size descriptors (frozen Storage.attachmentLimit = 8).
   * Ephemeral like the draft itself: a restart drops the pending set
   * while the copies stay in the library as history.
   */
  private readonly pendingAttachments = new Map<
    string,
    { id: string; name: string; size: number; path: string }[]
  >();
  static readonly ATTACHMENT_LIMIT = 8;
  /**
   * F31 anti-slop delivery ledger (frozen `antiSlopFallbackSent` /
   * sessionEpoch). threadId → the session key guidance was delivered
   * under; a new provider binding re-delivers once, an app restart
   * re-delivers once (the frozen flag is in-memory too). The value the
   * user set at send time decides WHICH block goes out — "off" still
   * delivers the disregard notice rather than silence.
   */
  private readonly antiSlopDelivered = new Map<string, string>();

  /** F19: daily token-spend ledger + per-session cumulative trackers.
   *  Trackers key on the PROVIDER session identity (Codex rollout id,
   *  else the local thread id) and live for the whole engine run — a
   *  counter drop reseeds inside spend(), matching the frozen rules. */
  private readonly tokenLedger: TokenLedger;
  private readonly spendTrackers = new Map<string, TokenSpendTracker>();
  /** Codex rollout ids bound during THIS run — their first cumulative
   *  reading is real spend, while a binding loaded from disk means the
   *  resumed session's first total is inherited history (seeded, never
   *  charged — frozen seedBaseline parity). */
  private readonly freshSessionKeys = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly provider: ProviderAdapter = new MockProvider(),
    private readonly dataRoot: string = store.root,
    private readonly appVersion: string = "0.1.0",
    private readonly paths?: ProjectRuntimePaths,
  ) {
    this.tokenLedger = new TokenLedger(this.dataRoot);
    this.armShelveSweep();
  }

  onEvent(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attachCheckpoints(c: CheckpointCoordinator): void {
    this.checkpoints = c;
  }

  /** F11: git worktree ops — the GitService slice wired at bootstrap. */
  private worktrees?: Pick<
    import("./gitService").GitService,
    | "worktreeCheck"
    | "worktreeAdd"
    | "worktreeRemove"
    | "branches"
    | "switchBranch"
    | "createBranch"
    | "renameBranch"
    | "hydraCapture"
    | "hydraCopyAdd"
    | "hydraEndTree"
    | "hydraLand"
    | "hydraCopyRemove"
  >;
  attachWorktrees(w: NonNullable<Engine["worktrees"]>): void {
    this.worktrees = w;
  }

  /** F12: script runs need real terminals — the TerminalService slice
   *  wired at bootstrap (absent → scripts report unavailable honestly). */
  private terminals?: Pick<
    import("./terminalService").TerminalService,
    "create"
  >;
  attachTerminals(t: NonNullable<Engine["terminals"]>): void {
    this.terminals = t;
  }

  attachSleepBlocker(b: SleepBlocker): void {
    this.sleepBlocker = b;
    this.updateSleepGuard();
  }

  /** F28: dock/taskbar badge — injected OS hook (app.setBadgeCount on
   *  platforms that support it, a no-op shim elsewhere). */
  private badgeUpdater?: (count: number) => void;
  attachBadgeUpdater(u: (count: number) => void): void {
    this.badgeUpdater = u;
    this.syncBadge();
  }

  /** Frozen AppModel.updateDockBadge: count unread non-archived
   *  threads; the Mac "panel" exclusion has no single-window analogue. */
  syncBadge(): void {
    this.badgeUpdater?.(
      this.store.state.threads.filter((t) => t.hasUnread && !t.isArchived).length,
    );
  }

  /** v2.2.34 quick chat expand: the draft rides a stamped event into
   *  the selected thread's composer (frozen quickDraft handoff). */
  announceQuickDraft(text: string): void {
    this.emit({ type: "quick-draft", text });
  }

  private emit(e: AppEvent): void {
    const stamped = { ...e, rev: ++this.rev };
    for (const fn of this.listeners) fn(stamped);
    // Unread state only ever changes through an emitted mutation, so one
    // central resync can never miss a site (selectThread, endTurn,
    // archive, delete, move — all covered).
    this.syncBadge();
  }

  /** Record a recovered-from-corruption backup path so it surfaces in info. */
  noteStoreRecovery(backupPath: string | undefined): void {
    if (backupPath) this.recoveredFrom = backupPath;
  }

  /** Codex runtime status for AppInfo — supplied by bootstrap (index.ts)
   *  because it owns the resolved CodexRuntimeConfig. */
  codexInfo?: CodexInfo;

  /** Read-only descriptor for external surfaces (local control). */
  get providerDescriptor() {
    return this.provider.descriptor;
  }

  get info(): AppInfo {
    const desc = this.provider.descriptor;
    return {
      appVersion: this.appVersion,
      baselineTag: "v2.0.0",
      baselineCommit: "d31e093b356846ff538dd8ba0dc22d62598e4427",
      dataRoot: this.dataRoot,
      providerId: desc.id,
      providerLabel: desc.label,
      home: homedir(),
      worktreesDir: join(this.dataRoot, "worktrees"),
      mock: true, // every current provider is synthetic
      mode: desc.mode,
      ...(desc.compact ? { supportsCompact: true as const } : {}),
      realCli: { status: "not-configured" },
      ...(desc.runtimeInfo ? { syntheticRuntime: desc.runtimeInfo } : {}),
      ...(this.codexInfo ? { codex: this.codexInfo } : {}),
      ...(this.recoveredFrom ? { recoveredFrom: this.recoveredFrom } : {}),
      ...(typeof TIVANO_TERMINAL_CANDIDATE !== "undefined" &&
          TIVANO_TERMINAL_CANDIDATE === true
        ? { terminalCandidate: true as const }
        : {}),
    };
  }

  /**
   * Quiesce all live provider handles so no timer can emit (or schedule a
   * store write) while the process tears down, and mark every in-flight
   * turn interrupted — a persisted "running" state must never be left
   * behind for the next launch to stumble over.
   */
  shutdown(): void {
    this.workGate = "closing"; // synchronously blocks every new turn
    this.checkpoints?.closing(); // pending before-captures can never start a provider
    // Limit waits die with the process (frozen Task-based parity).
    for (const w of this.limitWaits.values()) clearTimeout(w.timer);
    this.limitWaits.clear();
    if (this.quietTimer) {
      clearInterval(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.shelveTimer) {
      clearInterval(this.shelveTimer);
      this.shelveTimer = null;
    }
    this.turnLastEvent.clear();
    this.limitResumes.clear();
    for (const h of this.handles.values()) h.cancel();
    this.handles.clear();
    try {
      this.tokenLedger.flush();
    } catch {
      /* teardown — a failed activity write never blocks shutdown */
    }
    const now = Date.now();
    this.store.update((d) => {
      for (const t of d.threads) {
        if (this.markInterrupted(t, now)) this.emit({ type: "thread-updated", thread: t });
      }
    });
    this.updateSleepGuard();
  }

  /** Mark an in-flight turn interrupted; true when anything changed. */
  private markInterrupted(t: ChatThread, now: number): boolean {
    const turn = t.turn;
    if (!turn || (turn.status !== "running" && turn.status !== "waiting-approval"))
      return false;
    turn.status = "interrupted";
    turn.endedAt = now;
    // F28: a recovered in-flight turn is an unseen result — its
    // interruption happened while the app was gone (frozen parity).
    t.hasUnread = true;
    t.unreadStatus = "interrupted";
    // F22: a head killed mid-run persists as stopped — never "running"
    // into the next launch.
    if (t.hydraHead && t.hydraHead.status === "running") {
      t.hydraHead.status = "stopped";
      t.hydraHead.finishedAt = now;
    }
    // F22: a landing in flight when the app died is honestly lost —
    // the copy stays on disk with its work unclaimed.
    if (t.hydraHead?.landingPending === true) {
      t.hydraHead.landingPending = undefined;
      t.hydraHead.landing = {
        files: [],
        conflicts: [],
        error: "the app closed before the landing finished",
      };
      t.hydraHead.copyKept = t.worktreeDir !== undefined;
    }
    if (turn.approval && turn.approval.status === "pending") {
      turn.approval.status = "expired";
    }
    for (const m of t.messages) {
      if (m.turnId === turn.id && m.status === "streaming") {
        m.status = "interrupted";
        m.content += `\n\n*${INTERRUPTED_MARKER}*`;
      }
    }
    return true;
  }

  /**
   * Recovery: any turn that was mid-flight when the previous run ended is
   * marked interrupted — never auto-approved, never silently continued, and
   * no replayed side effects.
   */
  recoverInFlight(): string[] {
    const now = Date.now();
    const recovered: string[] = [];
    this.store.update((d) => {
      for (const t of d.threads) {
        if (this.markInterrupted(t, now)) recovered.push(t.id);
      }
    });
    this.interruptedThreads = recovered;
    return recovered;
  }

  /**
   * Keep-open state after a failed close: reads stay live, but no new
   * turn may start. The close dialog remains retryable.
   */
  enterReadOnly(): void {
    this.workGate = "readonly";
    this.emit({ type: "app-state", readOnly: true });
  }

  get readOnly(): boolean {
    return this.workGate !== "open";
  }

  snapshot(): Snapshot {
    const d = this.store.state;
    return {
      projects: d.projects.map((p) => this.withDirectoryStatus(p)),
      threads: d.threads,
      settings: d.settings,
      selectedThreadId: d.ui.selectedThreadId,
      info: this.info,
      rev: this.rev,
      ...(this.readOnly ? { readOnly: true } : {}),
      ...(this.limitResumes.size > 0
        ? { limitResumesAt: Object.fromEntries(this.limitResumes) }
        : {}),
      ...(this.sleepModeActive !== "off" ? { sleepPreventionActive: true } : {}),
      ...(d.recentCommands && Object.keys(d.recentCommands).length > 0
        ? { recentCommands: d.recentCommands }
        : {}),
      tokenActivity: this.tokenLedger.dailyTotals(),
    };
  }

  /**
   * Authoritative write gate. "closing" blocks everything while teardown
   * runs; "readonly" (keep-open after a failed close) blocks every
   * persisted mutation too — only snapshot/reads and the retry-close
   * path (which never mutates through the engine) stay live.
   */
  private assertMutable(): void {
    if (this.workGate === "closing") throw new EngineError("the application is closing");
    if (this.workGate === "readonly")
      throw new EngineError("read-only: close failed earlier — no new work is accepted");
  }

  // ---- projects -----------------------------------------------------------

  createProject(name: string): Project {
    this.assertMutable();
    const project: Project = {
      id: randomUUID(),
      name: name.trim() || "Untitled project",
      createdAt: Date.now(),
      expanded: true,
    };
    this.store.update((d) => {
      d.projects.push(project);
    });
    this.emit({ type: "project-added", project });
    return project;
  }

  /**
   * Live availability of a project's attached directory — derived, never
   * persisted state: the grant must exist, point at the SAME directory the
   * project displays, and the folder must still be a real canonical dir.
   * A forged display path can never look "available" while the real grant
   * points elsewhere.
   */
  private directoryStatusFor(p: Project): "available" | "unavailable" {
    const grant = p.directory !== undefined ? this.paths?.lookup(p.id) : undefined;
    return grant !== undefined &&
      grant.directory === p.directory &&
      this.paths!.dirLive(p.directory!)
      ? "available"
      : "unavailable";
  }

  private withDirectoryStatus(p: Project): Project {
    if (p.directory === undefined) return p;
    return { ...p, directoryStatus: this.directoryStatusFor(p) };
  }

  /**
   * Attach a USER-SELECTED directory — reachable only from the main-owned
   * chooser; the renderer can never supply this path. Ordering is
   * explicit: canonicalize → dedupe against live grants → durable grant
   * write → persisted project. A failed grant write activates no project;
   * an orphan grant with no project restores nothing on the next launch.
   */
  openUserDirectory(rawPath: string): { project: Project; reused: boolean } {
    this.assertMutable();
    if (!this.paths)
      throw new EngineError("workspace grants are not configured in this build");
    const canonical = this.paths.canonicalizeUserDir(rawPath);

    // Same physical directory → the already-bound project wins. Grant
    // identity (not display metadata) decides — a second selection never
    // mints a duplicate binding for either grant kind.
    const boundId = this.paths.findProjectByDirectory(canonical);
    if (boundId !== undefined) {
      const existing = this.store.state.projects.find((p) => p.id === boundId);
      if (existing) {
        if (!existing.expanded) {
          existing.expanded = true;
          this.store.update(() => {});
        }
        // Frozen: re-adding a shelved project's folder wakes it.
        if (existing.isShelved) this.setProjectShelved(existing.id, false);
        const project = this.withDirectoryStatus(existing);
        this.emit({ type: "project-updated", project });
        this.store.flushNow();
        return { project, reused: true };
      }
      // Grant for a project the store no longer lists — revoke the orphan
      // so a fresh binding can be made cleanly.
      this.paths.revoke(boundId);
    }

    // A project that DISPLAYS this directory but lost its grant (an
    // unrestored or dropped binding) is re-attached, not duplicated.
    const displaying = this.store.state.projects.find((p) => p.directory === canonical);
    if (displaying) {
      this.paths.registerUser(displaying.id, canonical);
      if (!displaying.expanded) displaying.expanded = true;
      this.store.update(() => {});
      const project = this.withDirectoryStatus(displaying);
      this.emit({ type: "project-updated", project });
      this.store.flushNow();
      return { project, reused: true };
    }

    const id = randomUUID();
    // Grant FIRST: no project is exposed as bound before its authorization
    // is durable, and a failed write preserves every older grant.
    this.paths.registerUser(id, canonical);
    // F12 frozen addProject: pick up tivano.json scripts at bind time.
    // Malformed entries are dropped; a bad file never blocks the bind.
    const fileScripts = readProjectFileScripts(canonical);
    const project: Project = {
      id,
      name: basename(canonical) || canonical,
      createdAt: Date.now(),
      expanded: true,
      directory: canonical,
      directoryStatus: "available",
      ...(fileScripts.length ? { scripts: fileScripts } : {}),
    };
    this.store.update((d) => {
      d.projects.push(project);
    });
    // Keep the renderer in sync even when flushing fails: the grant is
    // durable and the project remains usable in memory. Reopening retries
    // the write; success is returned only after it reaches disk.
    this.emit({ type: "project-added", project });
    try {
      this.store.flushNow();
    } catch (err) {
      throw new EngineError(
        `directory attached, but the project record could not be confirmed on disk: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { project, reused: false };
  }

  toggleProject(id: string, expanded: boolean): void {
    this.assertMutable();
    const project = this.mustProject(id);
    project.expanded = expanded;
    this.store.update(() => {});
    this.emit({ type: "project-updated", project: this.withDirectoryStatus(project) });
  }

  /** F01: set or clear (icon === null) a project's emoji mark. */
  setProjectIcon(id: string, icon: string | null): void {
    this.assertMutable();
    const project = this.mustProject(id);
    if (icon === null) delete project.icon;
    else project.icon = icon;
    this.store.update(() => {});
    this.emit({ type: "project-updated", project: this.withDirectoryStatus(project) });
  }

  deleteProject(id: string): void {
    this.assertMutable();
    const d = this.store.state;
    const removedThreads = d.threads.filter((t) => t.projectId === id).map((t) => t.id);
    // A failed durable revocation must leave the project and its threads intact.
    this.paths?.revoke(id);
    this.checkpoints?.projectDeleted(id);
    this.store.update((data) => {
      data.projects = data.projects.filter((p) => p.id !== id);
      data.threads = data.threads.filter((t) => t.projectId !== id);
      if (data.ui.selectedThreadId && removedThreads.includes(data.ui.selectedThreadId))
        data.ui.selectedThreadId = null;
    });
    for (const tid of removedThreads) {
      this.handles.get(tid)?.cancel();
      this.provider.endSession?.(tid);
    }
    this.emit({ type: "project-removed", projectId: id });
  }

  /**
   * F26 wallpaper — dedicated methods own the file slot; `settings:set`
   * never accepts a wallpaper field so the renderer cannot name a path.
   */
  setWallpaperFile(file: string): void {
    this.assertMutable();
    this.store.update((d) => {
      d.settings.wallpaper = { file, softness: d.settings.wallpaper?.softness ?? 0 };
    });
    this.emit({ type: "settings-changed", settings: this.store.state.settings });
  }
  clearWallpaper(): void {
    this.assertMutable();
    this.store.update((d) => {
      delete d.settings.wallpaper;
    });
    this.emit({ type: "settings-changed", settings: this.store.state.settings });
  }
  setWallpaperSoftness(softness: number): void {
    this.assertMutable();
    const clamped = Math.min(1, Math.max(0, softness));
    this.store.update((d) => {
      if (d.settings.wallpaper) d.settings.wallpaper.softness = clamped;
    });
    this.emit({ type: "settings-changed", settings: this.store.state.settings });
  }

  /** Whether a directory may be authorized for a project (bootstrap use). */
  registerWorkspace(projectId: string, dir: string): WorkspaceGrant | undefined {
    // Workspace authorization is itself a persisted-capability mutation —
    // readonly must not mint new grants either.
    this.assertMutable();
    return this.paths?.register(projectId, dir);
  }

  // ---- threads ------------------------------------------------------------

  createThread(
    projectId: string | null,
    title?: string,
    opts?: { workspaceDefault?: boolean },
  ): ChatThread {
    this.assertMutable();
    if (projectId) this.mustProject(projectId);
    // Frozen: starting a thread in a shelved project wakes it.
    if (projectId) this.wakeShelvedProject(projectId);
    const settings = this.store.state.settings;
    const thread: ChatThread = {
      id: randomUUID(),
      projectId,
      title: title?.trim() || "New thread",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      turn: null,
      sessionGrants: [],
      // F06: seed the thread's runtime mode from the saved default
      // (frozen makeThread — absent setting = fullAccess).
      runtimeMode: settings.defaultRuntimeMode ?? "fullAccess",
      // F21: seed the per-chat Hydra flag from the saved default (frozen
      // ChatThread.hydraDefaultKey semantics — absent setting = on). Inert
      // until F22 scheduling consumes it.
      hydraEnabled: settings.hydraDefaultEnabled !== false,
      ...(settings.lastHydraPairId
        ? { hydraPairId: settings.lastHydraPairId }
        : {}),
    };
    this.store.update((d) => {
      d.threads.push(thread);
      d.ui.selectedThreadId = thread.id;
    });
    this.emit({ type: "thread-added", thread });
    this.emit({ type: "thread-selected", threadId: thread.id });
    // F01/F11: frozen newThread — a project-bound thread under
    // defaultWorkspaceMode "worktree" starts its worktree right away
    // (frozen `Task { await createWorktree(for:) }`). Only the
    // user-facing create path applies the default: forwards, helper
    // spawns and head spawns keep their own workspace semantics. A
    // failure surfaces as an event — the thread itself is never
    // faked-bound.
    if (
      opts?.workspaceDefault &&
      thread.projectId &&
      settings.defaultWorkspaceMode === "worktree"
    ) {
      void this.createThreadWorktree(thread.id)
        .then((res) => {
          if (res.kind === "unavailable")
            this.emit({
              type: "worktree-failed",
              threadId: thread.id,
              reason: res.reason,
            });
        })
        .catch((e) => {
          this.emit({
            type: "worktree-failed",
            threadId: thread.id,
            reason: String(e instanceof Error ? e.message : e),
          });
        });
    }
    return thread;
  }

  selectThread(id: string | null): void {
    this.assertMutable();
    const thread = id ? this.mustThread(id) : null;
    // F28: selecting the thread puts the result on screen — the unread
    // mark is spent exactly once, here (frozen markRead).
    const cleared = thread?.hasUnread === true;
    this.store.update((d) => {
      d.ui.selectedThreadId = id;
      if (cleared && thread) {
        thread.hasUnread = false;
        delete thread.unreadStatus;
      }
    });
    if (cleared && thread) this.emit({ type: "thread-updated", thread });
    this.emit({ type: "thread-selected", threadId: id });
  }

  renameThread(id: string, title: string): void {
    this.assertMutable();
    const thread = this.mustThread(id);
    thread.title = title.trim() || thread.title;
    // v2.2.34: a title the user set is never auto-renamed again.
    thread.titleUserSet = true;
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /**
   * F02: archive removes a thread from the main list without deleting
   * it. A running turn is NOT cancelled — the frozen model archives
   * the record only. An archived selected thread leaves the list, so
   * its selection clears with it.
   */
  /**
   * v2.2.x shelved projects (frozen setProjectShelved): manual shelve or
   * unshelve; `shelvedAt` stamps the moment so a manual unshelve restarts
   * the auto-shelve idle clock.
   */
  setProjectShelved(id: string, shelved: boolean): void {
    this.assertMutable();
    const project = this.mustProject(id);
    if ((project.isShelved ?? false) === shelved) return;
    this.store.update(() => {
      if (shelved) {
        project.isShelved = true;
        project.shelvedAt = Date.now();
      } else {
        delete project.isShelved;
        project.shelvedAt = Date.now();
      }
    });
    this.emit({ type: "project-updated", project: this.withDirectoryStatus(project) });
  }

  /** Frozen wake-from-shelf: real work in a shelved project unshelves it
   *  (send, new thread, re-added folder, a thread moved in). Opening an
   *  old thread or searching never does. */
  private wakeShelvedProject(projectId: string | null): void {
    if (!projectId) return;
    const project = this.store.state.projects.find((p) => p.id === projectId);
    if (project?.isShelved) this.setProjectShelved(projectId, false);
  }

  /**
   * v2.2.x Settings › General auto-shelve: a project whose latest
   * non-archived thread has been idle longer than the configured days
   * shelves itself. Exempt: any running, unread or currently-open
   * (selected) thread — frozen keep-put semantics. Called from the quiet
   * watchdog tick so the cadence stays injectable in tests.
   * Public for the hourly sweep + tests; not an IPC surface.
   */
  shelveIdleProjects(now = Date.now()): void {
    const days = this.store.state.settings.autoShelveDays ?? 0;
    if (!days) return;
    const cutoff = now - days * 86_400_000;
    const open = this.store.state.ui.selectedThreadId;
    for (const project of this.store.state.projects) {
      if (project.isShelved) continue;
      const threads = this.store.state.threads.filter(
        (t) => t.projectId === project.id && !t.isArchived,
      );
      // Frozen idles on the LATEST thread's activity — project creation
      // only counts while the project has no threads at all. A manual
      // unshelve restarts the clock even when every thread is stale.
      const last =
        threads.length > 0
          ? Math.max(project.shelvedAt ?? 0, ...threads.map((t) => t.updatedAt))
          : (project.shelvedAt ?? project.createdAt);
      if (last > cutoff) continue;
      const exempt = threads.some(
        (t) =>
          t.id === open ||
          t.hasUnread ||
          (t.turn !== null &&
            ["running", "waiting-approval", "stopping"].includes(t.turn.status)),
      );
      if (exempt) continue;
      project.isShelved = true;
      project.shelvedAt = now;
      this.emit({ type: "project-updated", project: this.withDirectoryStatus(project) });
    }
    // Mutations above ride the next store.update like the watchdog's own.
  }

  archiveThread(id: string): void {
    this.assertMutable();
    const thread = this.mustThread(id);
    if (thread.isArchived) return;
    thread.isArchived = true;
    // Frozen parity: an archived thread loses its pin with its row, and
    // archive() dismisses its auto-continue — the limit wait ends with the
    // thread leaving the list; queued follow-ups stay.
    thread.isPinned = false;
    thread.updatedAt = Date.now();
    this.clearLimitWait(id);
    let deselected = false;
    this.store.update((d) => {
      if (d.ui.selectedThreadId === id) {
        d.ui.selectedThreadId = null;
        deselected = true;
      }
    });
    this.emit({ type: "thread-updated", thread });
    if (deselected) this.emit({ type: "thread-selected", threadId: null });
  }

  /** F02: restore an archived thread back into the main list. */
  unarchiveThread(id: string): void {
    this.assertMutable();
    const thread = this.mustThread(id);
    if (!thread.isArchived) return;
    thread.isArchived = false;
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  deleteThread(id: string): void {
    this.assertMutable();
    // Latch the queue first — a synchronous cancel→endTurn callback must
    // never fire a pendingSend on a thread being deleted.
    this.pendingSends.delete(id);
    this.handles.get(id)?.cancel();
    this.handles.delete(id);
    this.provider.endSession?.(id);
    this.checkpoints?.threadDeleted(id);
    this.pendingAttachments.delete(id);
    // F22: a deleted lead's runtime Hydra state dies with it — queued
    // delegations never spawn into a removed checkout.
    this.hydraWaiting.delete(id);
    this.hydraPendingReports.delete(id);
    for (const k of [...this.hydraFallbackNoted])
      if (k.startsWith(id + ":")) this.hydraFallbackNoted.delete(k);
    for (const k of [...this.hydraCaptures.keys()])
      if (k.startsWith(id + ":")) this.hydraCaptures.delete(k);
    // F11: an app-created worktree leaves the thread — best-effort
    // removal; a dirty checkout keeps its directory honestly (git's
    // plain remove refuses, we never force). A head's own copy is the
    // exception: it is app-managed scratch, removed forcefully once the
    // thread record is gone.
    const del = this.mustThread(id);
    const wt = del.worktreeDir;
    if (wt !== undefined && this.worktrees) {
      const projectId = del.projectId;
      if (projectId) {
        if (del.hydraHead)
          void this.worktrees.hydraCopyRemove(projectId, wt).catch(() => {});
        else void this.worktrees.worktreeRemove(projectId, wt).catch(() => {});
      }
    }
    this.store.update((d) => {
      d.threads = d.threads.filter((t) => t.id !== id);
      if (d.ui.selectedThreadId === id) d.ui.selectedThreadId = null;
    });
    this.emit({ type: "thread-removed", threadId: id });
  }

  /**
   * F02: frozen `deleteArchivedThreads(ids:)` — deletes the archived
   * threads in `ids`. Ids that are not archived (or unknown) are simply
   * not matched, so this channel can never delete a live thread. Each
   * removal goes through deleteThread, so pending sends, running turns,
   * provider sessions, checkpoints, attachments and worktree cleanup all
   * behave exactly as a single delete; segmented turn files are swept by
   * the store's orphan pass on flush. Returns the ids actually deleted.
   */
  deleteArchivedThreads(ids: readonly string[]): string[] {
    this.assertMutable();
    const wanted = new Set(ids);
    const doomed = this.store.state.threads.filter(
      (t) => t.isArchived && wanted.has(t.id),
    );
    for (const t of doomed) this.deleteThread(t.id);
    return doomed.map((t) => t.id);
  }

  // ---- turns --------------------------------------------------------------

  /**
   * F05: register main-owned attachment records against the thread's
   * draft (frozen `Storage.attach` semantics — the copies were already
   * made by the caller; this bounds the set and returns what landed).
   * Returns path-free descriptors plus the over-cap drop count.
   */
  addAttachments(
    threadId: string,
    files: { id: string; name: string; size: number; path: string }[],
  ): { attached: { id: string; name: string; size: number }[]; dropped: number } {
    this.assertMutable();
    this.mustThread(threadId);
    const pending = this.pendingAttachments.get(threadId) ?? [];
    const room = Math.max(0, Engine.ATTACHMENT_LIMIT - pending.length);
    const accepted = files.slice(0, room);
    pending.push(...accepted);
    this.pendingAttachments.set(threadId, pending);
    return {
      attached: accepted.map(({ id, name, size }) => ({ id, name, size })),
      dropped: files.length - accepted.length,
    };
  }

  /** Remove one pending attachment (draft chip ×). Returns its library
   *  path so the caller can drop the copy; unknown ids are a no-op. */
  removeAttachment(threadId: string, id: string): string | undefined {
    this.assertMutable();
    this.mustThread(threadId);
    const pending = this.pendingAttachments.get(threadId);
    if (!pending) return undefined;
    const index = pending.findIndex((a) => a.id === id);
    if (index === -1) return undefined;
    const removed = pending.splice(index, 1)[0];
    if (pending.length === 0) this.pendingAttachments.delete(threadId);
    return removed?.path;
  }

  /** Pending set for a thread — paths (main-side copy destinations). */
  pendingAttachmentPaths(threadId: string): string[] {
    return (this.pendingAttachments.get(threadId) ?? []).map((a) => a.path);
  }

  /** A80 preview: name one attachment the thread owns — a pending draft
   *  (path known) or a descriptor on a sent message (the service
   *  resolves the library copy from id+name). */
  attachmentDescriptor(
    threadId: string,
    id: string,
  ): { name: string; size: number; path?: string } | undefined {
    const t = this.mustThread(threadId);
    const pending = this.pendingAttachments.get(threadId)?.find((a) => a.id === id);
    if (pending) return { name: pending.name, size: pending.size, path: pending.path };
    for (const m of t.messages) {
      const a = m.attachments?.find((x) => x.id === id);
      if (a) return { name: a.name, size: a.size };
    }
    return undefined;
  }

  sendTurn(
    threadId: string,
    text: string,
    opts?: { authored?: boolean; hydraReport?: number[]; hydraBrief?: boolean },
  ): Turn {
    this.assertMutable();
    // Frozen beginTurn(userAuthored): a real user request restarts the
    // delegation-round budget; Hydra report/refusal turns don't.
    if (opts?.authored !== false) this.hydraRounds.delete(threadId);
    const thread = this.mustThread(threadId);
    // Frozen: sending in a shelved project wakes it — real work resumes.
    this.wakeShelvedProject(thread.projectId);
    if (thread.turn && (thread.turn.status === "running" || thread.turn.status === "waiting-approval"))
      throw new EngineError("a turn is already running on this thread");
    // F22 steer: a user message to a finished or stopped head runs it
    // again — its report goes to the lead as a fresh one (frozen).
    const steeredHead =
      thread.hydraHead && thread.hydraHead.status !== "running"
        ? thread
        : undefined;

    // F05: pending draft attachments are consumed by the send — the
    // provider prompt gains the frozen "Attached files:" suffix while
    // the user message keeps the typed text plus display descriptors.
    const attached = this.pendingAttachments.get(threadId) ?? [];
    if (!text.trim() && attached.length === 0)
      throw new EngineError("an empty turn has nothing to send");
    const prompt =
      attached.length === 0
        ? text
        : text +
          "\n\nAttached files:\n" +
          attached.map((a) => `- ${a.path}`).join("\n");
    this.pendingAttachments.delete(threadId);

    const now = Date.now();
    const turn: Turn = {
      id: randomUUID(),
      threadId,
      status: "running",
      seq: 0,
      startedAt: now,
      assistantMessageId: randomUUID(),
    };
    const userMsg: Message = {
      id: randomUUID(),
      role: "user",
      content: text,
      status: "done",
      ts: now,
      turnId: turn.id,
      ...(opts?.hydraReport !== undefined
        ? { hydraHeads: opts.hydraReport }
        : {}),
      ...(opts?.hydraBrief === true ? { hydraBrief: true } : {}),
      ...(attached.length > 0
        ? {
            attachments: attached.map(({ id, name, size }) => ({ id, name, size })),
          }
        : {}),
    };
    const assistantMsg: Message = {
      id: turn.assistantMessageId,
      role: "assistant",
      content: "",
      status: "streaming",
      ts: now,
      turnId: turn.id,
    };
    const needsTitle = thread.title === "New thread";
    this.store.update(() => {
      thread.messages.push(userMsg, assistantMsg);
      thread.turn = turn;
      thread.updatedAt = now;
      if (needsTitle) thread.title = text.slice(0, 60) || attached[0]?.name || "New thread";
    });
    this.emit({ type: "thread-updated", thread });
    this.emit({ type: "turn-status", threadId, turnId: turn.id, status: "running" });
    this.updateSleepGuard();
    // F03 quiet watchdog: frozen noteSessionEvent() seeds the silence
    // clock at turn start; the shared ticker arms lazily on first run.
    this.turnLastEvent.set(turn.id, now);
    this.armQuietWatchdog();
    if (needsTitle) this.maybeGenerateTitle(thread.id, text);
    if (steeredHead?.hydraHead) {
      const info = steeredHead.hydraHead;
      info.status = "running";
      // A fresh batch: this turn's report flushes on its own, never
      // folded into the batch it was originally spawned under.
      info.batchId = `steer-${turn.id}`;
      info.summary = undefined;
      info.landing = undefined;
      info.finishedAt = undefined;
      // A kept copy stays bound — a stopped head's half-done edits are
      // where it carries on. Its base tree stays too, so the next
      // landing still diffs everything that never left the copy.
      this.armHydraWatchdog(steeredHead);
      this.store.update(() => {});
      this.emit({ type: "thread-updated", thread: steeredHead });
    }

    // Every NON-mock adapter needs a workspace authorized for this project
    // by main/test harness. No grant → WORKSPACE_NOT_CONFIGURED; the grant
    // is re-verified at the moment of spawn.
    let workspace: WorkspaceGrant | undefined;
    if (this.provider.descriptor.mode !== "mock") {
      if (!thread.projectId) {
        this.failTurnSync(thread, turn, "WORKSPACE_NOT_CONFIGURED: thread has no project");
        return turn;
      }
      workspace = this.paths?.lookup(thread.projectId);
      if (!workspace) {
        this.failTurnSync(
          thread,
          turn,
          "WORKSPACE_NOT_CONFIGURED: no authorized directory is bound to this project",
        );
        return turn;
      }
      try {
        this.paths!.verify(workspace);
      } catch (err) {
        this.failTurnSync(thread, turn, (err as Error).message);
        return turn;
      }
      // F11: a worktree-bound thread executes in its own directory —
      // authorization is inherited from the live project grant, and a
      // dead worktree refuses rather than silently falling back.
      if (thread.worktreeDir !== undefined) {
        if (!this.paths!.dirLive(thread.worktreeDir)) {
          this.failTurnSync(
            thread,
            turn,
            "WORKSPACE_NOT_CONFIGURED: the thread's worktree is missing or moved",
          );
          return turn;
        }
        workspace = { projectId: thread.projectId, directory: thread.worktreeDir };
      }
    } else if (thread.worktreeDir !== undefined || thread.projectId) {
      // The Mock ignores workspace for its scripts — but an isolation
      // fixture can only show a head's copy working if it sees the same
      // authorized directory a real adapter would run in. Passing an
      // existing grant adds no requirement: no live dir → the fixture
      // simply does nothing (never a turn failure).
      const dir = thread.worktreeDir ?? this.paths?.lookup(thread.projectId!)?.directory;
      if (dir && this.paths?.dirLive(dir))
        workspace = { projectId: thread.projectId ?? "", directory: dir };
    }

    // F22 steer copy gate: an isolated head steered on resolves its copy
    // BEFORE its provider starts — the deferred-start shape the
    // checkpoint gate already uses. A kept copy (stopped head) is
    // reused as-is; a released one is captured+bound fresh; a landing
    // still in flight settles first, so the new turn never writes into
    // a copy the landing is about to remove.
    if (
      steeredHead?.projectId &&
      this.worktrees &&
      (steeredHead.worktreeDir === undefined ||
        steeredHead.hydraHead!.landingPending === true)
    ) {
      const info = steeredHead.hydraHead!;
      const lead = this.store.state.threads.find((t) => t.id === info.leadId);
      const launch = lead ? this.hydraLaunchFor(lead) : null;
      const isolates =
        launch?.isolatesHeads ??
        this.store.state.settings.hydraIsolateHeads !== false;
      if (isolates) {
        const settle =
          info.landingPending === true
            ? (this.hydraLandings.get(info.leadId) ?? Promise.resolve())
            : Promise.resolve();
        const live = () => {
          const c = this.store.state.threads.find((t) => t.id === threadId);
          return c?.turn?.id === turn.id && c.turn.status === "running"
            ? c
            : undefined;
        };
        void settle
          .then(async () => {
            let cur = live();
            if (!cur) return;
            if (!(cur.worktreeDir && this.paths?.dirLive(cur.worktreeDir))) {
              // Landing released the copy (or none survived): capture the
              // checkout afresh — it now contains whatever just landed.
              const source = lead
                ? this.hydraCopySource(lead, cur)
                : this.threadDirectory(cur.id);
              if (source)
                await this.bindIsolatedCopy(
                  cur.id,
                  source,
                  `${info.leadId}:${info.batchId}:${source}`,
                );
              cur = live();
              if (!cur) return;
            }
            // A bound copy outranks the checkout grant resolved above.
            const ws =
              cur.worktreeDir && this.paths?.dirLive(cur.worktreeDir)
                ? { projectId: cur.projectId ?? "", directory: cur.worktreeDir }
                : workspace;
            try {
              this.startProvider(thread, turn, prompt, ws, opts);
            } catch (err) {
              this.failTurnSync(
                thread,
                turn,
                (err as Error)?.message ?? String(err),
              );
            }
          })
          .catch((err) =>
            this.failTurnSync(
              thread,
              turn,
              (err as Error)?.message ?? String(err),
            ),
          );
        return turn;
      }
    }

    // Before-snapshot gate: when a checkpoint coordinator owns this
    // project's turns, the provider may start ONLY after the capture
    // resolved and the turn is still alive — a cancel/delete/close
    // during capture must never start it (P2L). Checkpoint preparation
    // failure must never strand the turn: an unexpected coordinator
    // rejection still lets ordinary chat proceed (visibly failed via
    // the coordinator's own record), and a provider-start failure ends
    // the turn honestly instead of leaving it running forever.
    // Checkpoints are bound to the project's grant directory — a
    // worktree thread's snapshots would silently describe the WRONG
    // directory, so capture is skipped honestly (F11 bounded scope).
    if (this.checkpoints && workspace && thread.projectId && thread.worktreeDir === undefined) {
      const ckpt = this.checkpoints;
      void ckpt
        .beginTurn(thread, turn.id)
        .then((mayStart) => {
          if (!mayStart) return;
          try {
            this.startProvider(thread, turn, prompt, workspace!, opts);
          } catch (err) {
            this.failTurnSync(thread, turn, (err as Error)?.message ?? String(err));
          }
        })
        .catch((err) => {
          try {
            this.startProvider(thread, turn, prompt, workspace!, opts);
          } catch (e) {
            this.failTurnSync(thread, turn, (e as Error)?.message ?? String(e ?? err));
          }
        });
      return turn;
    }
    this.startProvider(thread, turn, prompt, workspace, opts);
    return turn;
  }

  /** Start the provider for a live turn. Re-proves thread+turn identity
   *  and re-verifies the grant — the call may arrive after the async
   *  checkpoint boundary, where a stale or rebound turn must fail
   *  instead of mutating the project. */
  private startProvider(
    thread: ChatThread,
    turn: Turn,
    text: string,
    workspace: WorkspaceGrant | undefined,
    opts?: { authored?: boolean; hydraReport?: number[]; hydraBrief?: boolean },
  ): void {
    const live = this.store.state.threads.find((t) => t.id === thread.id);
    const liveTurn = live?.turn;
    if (
      !live ||
      !liveTurn ||
      liveTurn.id !== turn.id ||
      (liveTurn.status !== "running" && liveTurn.status !== "waiting-approval")
    )
      return;
    if (workspace) {
      try {
        // A worktree-bound thread executes in its app-owned checkout —
        // verifyExec proves the dir is confined under the project worktree
        // root AND the project grant is still live (F11). Every other
        // turn still must equal the registered grant exactly.
        if (live.worktreeDir !== undefined) this.paths!.verifyExec(workspace);
        else this.paths!.verify(workspace);
      } catch (err) {
        this.failTurnSync(live, liveTurn, (err as Error).message);
        return;
      }
    }
    const threadId = thread.id;
    // F31: anti-slop guidance rides the FIRST ordinary message of each
    // provider session (frozen AntiSlopPolicy + antiSlopFallbackSent —
    // skipped for slash commands, which consume no ordinary prompt, and
    // spent only when the provider actually starts).
    const sessionKey = live.providerThread?.codexThreadId ?? "local";
    const antiSlopPending =
      !this.opensWithKnownCommand(text) &&
      this.antiSlopDelivered.get(threadId) !== sessionKey;
    // F09: an unsent forwarded snapshot prefixes the FIRST ordinary
    // prompt only; delivery is spent when the provider actually starts
    // (frozen: failed sends leave delivery pending).
    let wireText = text;
    // F22: the lead's Hydra policy rides the front of every turn (frozen
    // fallbackPreamble — this build's providers keep no session
    // instructions, so the policy arrives per message). Report turns take
    // the report note instead of the delegation request.
    const hydraPrefix = this.hydraWirePrefix(thread, opts?.hydraReport !== undefined);
    if (hydraPrefix) wireText = hydraPrefix + wireText;
    if (antiSlopPending)
      wireText =
        antiSlopInstructions(this.store.state.settings.antiSlopEnabled ?? true) +
        "\n\n" +
        wireText;
    const pendingContinuation =
      live.continuation && !live.continuation.sent ? live.continuation : null;
    if (pendingContinuation)
      wireText = continuationPrompt(pendingContinuation) + "\n\n" + wireText;
    try {
      const handle = this.provider.start(
        {
          prompt: wireText,
          threadId,
          turnId: turn.id,
          ...(workspace ? { workspace } : {}),
          // F17: user-chosen per-thread overrides — Codex only, sent
          // verbatim; other adapters ignore them.
          // F06: the thread's runtime mode travels on every turn —
          // adapters with a policy mapping (Codex) apply it; others
          // ignore it. Threads created before the setting existed may
          // still lack the field — the read-path fallback stays the
          // conservative "supervised" (new threads seed from
          // defaultRuntimeMode, frozen default fullAccess).
          runtimeMode: live.runtimeMode ?? "supervised",
          interactionMode: live.interactionMode ?? "build",
          ...(this.provider.descriptor.mode === "codex"
            ? {
                ...(live.codexModel ? { model: live.codexModel } : {}),
                ...(live.codexEffort ? { effort: live.codexEffort } : {}),
                ...(live.codexServiceTier
                  ? { serviceTier: live.codexServiceTier }
                  : {}),
              }
            : {}),
        },
        {
          // F03 quiet watchdog (frozen noteSessionEvent): every provider
          // callback is a session event — the silence clock resets here so
          // the ticker below never has to chase per-event bookkeeping.
          onChunk: (seq, delta) => { this.noteTurnEvent(turn.id); this.onProviderChunk(threadId, turn.id, seq, delta); },
          onMessageText: (seq, text) => { this.noteTurnEvent(turn.id); this.onProviderMessageText(threadId, turn.id, seq, text); },
          onApproval: (req) => { this.noteTurnEvent(turn.id); this.onProviderApproval(threadId, turn.id, req); },
          onDone: () => { this.noteTurnEvent(turn.id); this.finishTurn(threadId, turn.id, "done"); },
          onError: (msg) => { this.noteTurnEvent(turn.id); this.failTurn(threadId, turn.id, msg); },
          onInterrupted: () => { this.noteTurnEvent(turn.id); this.interruptTurn(threadId, turn.id); },
          onToolActivity: (a) => { this.noteTurnEvent(turn.id); this.onToolActivity(threadId, turn.id, a); },
          onReasoning: (a) => { this.noteTurnEvent(turn.id); this.onReasoning(threadId, turn.id, a); },
          onPlan: (a) => { this.noteTurnEvent(turn.id); this.onPlan(threadId, turn.id, a); },
          onTodos: (steps) => { this.noteTurnEvent(turn.id); this.onTodos(threadId, turn.id, steps); },
          onUsage: (u) => { this.noteTurnEvent(turn.id); this.onUsage(threadId, turn.id, u); },
          onFileChanges: (paths) => { this.noteTurnEvent(turn.id); this.onProviderFileChanges(threadId, turn.id, paths); },
          onNotice: (text, level) => { this.noteTurnEvent(turn.id); this.onProviderNotice(threadId, turn.id, text, level); },
          onApprovalWithdrawn: (key) => { this.noteTurnEvent(turn.id); this.onApprovalWithdrawn(threadId, turn.id, key); },
          onApprovalAnswerWritten: (key) => { this.noteTurnEvent(turn.id); this.onApprovalAnswerWritten(threadId, turn.id, key); },
          onQuestion: (req) => { this.noteTurnEvent(turn.id); this.onProviderQuestion(threadId, turn.id, req); },
          onQuestionAnswered: (key) => { this.noteTurnEvent(turn.id); this.onQuestionAnswered(threadId, turn.id, key); },
          onQuestionWithdrawn: (key) => { this.noteTurnEvent(turn.id); this.onQuestionWithdrawn(threadId, turn.id, key); },
          onModelReport: (model, effort) => { this.noteTurnEvent(turn.id); this.onModelReport(threadId, model, effort); },
        },
      );
      this.handles.set(threadId, handle);
      if (antiSlopPending) {
        // Spent only on an actual start — like the frozen epoch check,
        // a session rebound in the meantime keeps the delivery pending.
        const cur = this.store.state.threads.find((t) => t.id === threadId);
        if ((cur?.providerThread?.codexThreadId ?? "local") === sessionKey)
          this.antiSlopDelivered.set(threadId, sessionKey);
      }
      if (pendingContinuation) {
        this.store.update(() => {
          const t = this.store.state.threads.find((x) => x.id === threadId);
          if (t?.continuation && !t.continuation.sent)
            t.continuation.sent = true;
        });
        this.emit({ type: "thread-updated", thread: live });
      }
    } catch (err) {
      // Synchronous start failure (spawn spec invalid, capacity, revoked
      // workspace …) must still leave a consistent, user-visible turn.
      this.failTurnSync(live, liveTurn, (err as Error).message);
    }
  }

  /** Mark a just-created turn failed before any provider callback ran. */
  private failTurnSync(thread: ChatThread, turn: Turn, message: string): void {
    turn.error = message;
    this.endTurn(thread, turn, "error");
  }

  cancelTurn(threadId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const turn = thread.turn;
    if (!turn || (turn.status !== "running" && turn.status !== "waiting-approval")) return;
    // Latch BEFORE endTurn so a pending before-capture resolving later
    // can never start this turn's provider.
    this.checkpoints?.turnCancelled(threadId, turn.id);
    this.handles.get(threadId)?.cancel();
    this.handles.delete(threadId);
    this.endTurn(thread, turn, "cancelled");
  }

  /**
   * F29 (frozen updateTaskSleepPrevention parity): recompute whether a
   * sleep-prevention token should be held — wanted = running work AND
   * the user's taskSleepMode. Busy = any turn running/waiting-approval
   * or a limit wait pending (frozen isWaitingForLimit counts as work).
   * Only state transitions touch the OS token; failures degrade to off
   * and the snapshot reports what is ACTUALLY held, never the intent.
   */
  private updateSleepGuard(): void {
    const busy =
      this.limitWaits.size > 0 ||
      this.store.state.threads.some(
        (th) =>
          th.turn &&
          (th.turn.status === "running" || th.turn.status === "waiting-approval"),
      );
    const wanted = busy ? (this.store.state.settings.taskSleepMode ?? "off") : "off";
    if (wanted === this.sleepModeActive) return;
    if (this.sleepBlockerId !== undefined) {
      try {
        this.sleepBlocker?.stop(this.sleepBlockerId);
      } catch {
        /* token release is best-effort; a stale handle degrades to off */
      }
      this.sleepBlockerId = undefined;
    }
    this.sleepModeActive = wanted;
    if (wanted !== "off") {
      try {
        this.sleepBlockerId = this.sleepBlocker?.start(
          wanted === "display" ? "display" : "app",
        );
      } catch {
        this.sleepBlockerId = undefined;
        this.sleepModeActive = "off";
      }
    }
    this.emit({
      type: "sleep-prevention-changed",
      active: this.sleepModeActive !== "off",
    });
  }

  // ---- F03 quiet watchdog (frozen ThreadRuntime.watchQuiet) -----------
  //
  // Frozen parity: one 30-second timer runs while the phase is .running;
  // every provider event resets the clock; a turn parked on the USER —
  // pending approval/question, a limit wait — or a lead whose heads are
  // the real work is never "quiet". Heads have their own budget watchdog
  // instead (armHydraWatchdog), matching the frozen isHydraHead guard.

  /** Stamp the turn's silence clock (frozen noteSessionEvent). */
  private noteTurnEvent(turnId: string): void {
    this.turnLastEvent.set(turnId, Date.now());
  }

  private armQuietWatchdog(): void {
    if (this.quietTimer) return;
    this.quietTimer = setInterval(() => this.watchQuiet(), this.quietTickMs);
    this.quietTimer.unref?.();
  }

  private watchQuiet(): void {
    const now = Date.now();
    let anyLive = false;
    for (const thread of this.store.state.threads) {
      const turn = thread.turn;
      if (!turn || (turn.status !== "running" && turn.status !== "waiting-approval")) continue;
      anyLive = true;
      // Frozen exemptions (watchQuiet guard): head threads run their own
      // watchdog; anything waiting on the user or on delegated heads is
      // awake by definition, not silent.
      if (thread.hydraHead) continue;
      if (turn.approval?.status === "pending" || turn.question?.status === "pending") continue;
      if (this.limitWaits.has(thread.id)) continue;
      if (
        this.store.state.threads.some(
          (h) => h.hydraHead?.leadId === thread.id && h.hydraHead.status === "running",
        )
      )
        continue;
      const quiet = now - (this.turnLastEvent.get(turn.id) ?? turn.startedAt);
      const toolRunning = thread.messages.some(
        (m) => m.turnId === turn.id && m.kind === "tool" && m.tool?.state === "running",
      );
      if (quiet >= (toolRunning ? this.quietToolStopMs : this.quietStopMs)) {
        // Frozen: stopQuietInterrupt → error notice + stop once. The
        // interrupt path is the same one a user stop takes, so cancel,
        // expiry and unread marking all reuse it.
        const minutes = toolRunning
          ? Math.round(this.quietToolStopMs / 60_000)
          : Math.round(this.quietStopMs / 60_000);
        this.appendNotice(
          thread,
          `${this.provider.descriptor.label} sent nothing for ${minutes} minutes${toolRunning ? " while a tool ran" : ""}, so Tivano stopped the turn.`,
          "error",
          turn.id,
        );
        this.checkpoints?.turnCancelled(thread.id, turn.id);
        this.handles.get(thread.id)?.cancel();
        this.handles.delete(thread.id);
        this.endTurn(thread, turn, "interrupted");
        continue;
      }
      // Frozen quietMinutes — set only while the turn is otherwise idle;
      // a running tool suppresses the label until the long threshold.
      const minutes =
        !toolRunning && quiet >= this.quietLabelMs ? Math.floor(quiet / 60_000) : undefined;
      if (turn.quietMinutes !== minutes) {
        turn.quietMinutes = minutes;
        this.store.update(() => {});
        this.emit({ type: "thread-updated", thread });
      }
    }
    if (!anyLive && this.quietTimer) {
      clearInterval(this.quietTimer);
      this.quietTimer = null;
    }
  }

  private armShelveSweep(): void {
    if (this.shelveTimer) return;
    this.shelveTimer = setInterval(() => this.shelveIdleProjects(), 3_600_000);
    this.shelveTimer.unref?.();
  }

  // ---- follow-up queue (F08, no-Hydra subset) -------------------------
  //
  // Frozen parity (ThreadRuntime.swift): a queued prompt goes out as an
  // ordinary user turn IN ORDER once the running turn COMPLETES. A turn
  // the user stopped (cancelled/interrupted) never drains the queue —
  // "a turn the user stopped waits for them instead". Send-now takes an
  // item out and fires it as soon as the current stop lands (pendingSend);
  // Enter-while-running does the same with the draft. A restart keeps
  // the queue persisted but never auto-sends.

  private static readonly FOLLOWUP_MAX = 32;
  /** Text to send the moment the running turn's stop lands. */
  private readonly pendingSends = new Map<string, string>();
  /** Reentrancy guard: a drain that starts a turn must not re-drain. */
  private drainingFollowUps = new Set<string>();

  private threadBusy(thread: ChatThread): boolean {
    const s = thread.turn?.status;
    return s === "running" || s === "waiting-approval";
  }

  private queueOf(thread: ChatThread): FollowUpItem[] {
    return (thread.followUps ??= []);
  }

  private emitQueue(thread: ChatThread): void {
    this.store.update(() => {
      thread.updatedAt = Date.now();
    });
    this.emit({ type: "thread-updated", thread });
  }

  /** Queue the text behind the running turn; idle, it goes out at once
   *  (unless the last turn was stopped — that queue waits for the user). */
  enqueueFollowUp(threadId: string, text: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const trimmed = text.trim();
    if (!trimmed) throw new EngineError("empty follow-up");
    const items = this.queueOf(thread);
    if (items.length >= Engine.FOLLOWUP_MAX)
      throw new EngineError("follow-up queue is full");
    this.store.update(() => {
      items.push({ id: randomUUID(), text: trimmed, createdAt: Date.now() });
      thread.updatedAt = Date.now();
    });
    this.emit({ type: "thread-updated", thread });
    this.flushFollowUpsIfIdle(thread);
  }

  removeFollowUp(threadId: string, id: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const items = this.queueOf(thread);
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw new EngineError("no such queued follow-up");
    this.store.update(() => {
      items.splice(idx, 1);
      this.tidyBundles(items);
    });
    this.emitQueue(thread);
  }

  updateFollowUp(threadId: string, id: string, text: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const item = this.queueOf(thread).find((i) => i.id === id);
    if (!item) throw new EngineError("no such queued follow-up");
    const trimmed = text.trim();
    if (!trimmed) throw new EngineError("empty follow-up");
    this.store.update(() => {
      item.text = trimmed;
    });
    this.emitQueue(thread);
  }

  /** Drag parity: move `id` to right before/after `target`; leaving a
   *  bundle gap on purpose unbundles it (frozen unbundleIfSeparated). */
  moveFollowUp(threadId: string, id: string, targetId: string, after: boolean): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const items = this.queueOf(thread);
    const from = items.findIndex((i) => i.id === id);
    const to = items.findIndex((i) => i.id === targetId);
    if (id === targetId || from < 0 || to < 0)
      throw new EngineError("cannot move this follow-up there");
    let dest = to + (after ? 1 : 0);
    if (from < dest) dest -= 1;
    if (from === dest) return;
    this.store.update(() => {
      const [item] = items.splice(from, 1);
      items.splice(dest, 0, item!);
      this.unbundleIfSeparated(items, id);
    });
    this.emitQueue(thread);
  }

  /** Bundle `id` onto `ontoId`: both share a bundle; the dragged item
   *  moves right after the bundle's last member (frozen parity). */
  bundleFollowUp(threadId: string, id: string, ontoId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const items = this.queueOf(thread);
    const targetIndex = items.findIndex((i) => i.id === ontoId);
    const from = items.findIndex((i) => i.id === id);
    if (id === ontoId || targetIndex < 0 || from < 0)
      throw new EngineError("cannot bundle these follow-ups");
    this.store.update(() => {
      const bundle = items[targetIndex]!.bundleId ?? randomUUID();
      items[targetIndex]!.bundleId = bundle;
      const [dragged] = items.splice(items.findIndex((i) => i.id === id), 1);
      dragged!.bundleId = bundle;
      const last = items.reduce((m, i, n) => (i.bundleId === bundle ? n : m), -1);
      items.splice(Math.min(last + 1, items.length), 0, dragged!);
    });
    this.emitQueue(thread);
  }

  unbundleFollowUp(threadId: string, id: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const item = this.queueOf(thread).find((i) => i.id === id);
    if (!item?.bundleId) return;
    this.store.update(() => {
      delete item.bundleId;
      this.tidyBundles(this.queueOf(thread));
    });
    this.emitQueue(thread);
  }

  /** Send a queued item right away: idle → its turn starts now; a turn
   *  running → the stop lands first, then it goes (pendingSend); a send
   *  already behind the stop → the item requeues at the front. */
  sendFollowUpNow(threadId: string, id: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const items = this.queueOf(thread);
    const index = items.findIndex((i) => i.id === id);
    if (index < 0) throw new EngineError("no such queued follow-up");
    const text = this.takeBundleText(thread, index);
    if (!text.trim()) {
      this.emitQueue(thread);
      return;
    }
    if (!this.threadBusy(thread)) {
      this.sendTurn(threadId, text);
      return;
    }
    if (!this.pendingSends.has(threadId)) {
      this.pendingSends.set(threadId, text);
      this.cancelTurn(threadId);
    } else {
      // Return already has a message going out the moment the turn stops;
      // this one goes right behind it (frozen insert at 0).
      this.store.update(() => {
        items.unshift({ id: randomUUID(), text, createdAt: Date.now() });
      });
      this.emitQueue(thread);
    }
  }

  /** Enter while a turn runs (frozen interruptAndSend): stop the turn and
   *  send the draft as soon as the stop lands. Idle, it just sends. */
  interruptAndSend(threadId: string, text: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const trimmed = text.trim();
    if (!trimmed) throw new EngineError("empty message");
    if (!this.threadBusy(thread)) {
      this.sendTurn(threadId, trimmed);
      return;
    }
    if (!this.pendingSends.has(threadId)) {
      this.pendingSends.set(threadId, trimmed);
      this.cancelTurn(threadId);
    } else {
      // 2.2.12 parity: a second message sent while the stop is still landing
      // queues at the front of followUps — overwriting the latched send
      // would lose the first message.
      this.store.update(() => {
        this.queueOf(thread).unshift({ id: randomUUID(), text: trimmed, createdAt: Date.now() });
        thread.updatedAt = Date.now();
      });
      this.emitQueue(thread);
    }
  }

  /** Removes the item(s) starting at `index` — plus every following
   *  adjacent item sharing its bundle — and returns the merged text. */
  /** Non-destructive twin of takeBundleText(0): would draining the queue
   *  now actually start a successor turn? Bundle members join the same
   *  way (a bundle of blanks sends nothing). */
  private nextBundleHasText(thread: ChatThread): boolean {
    const items = thread.followUps ?? [];
    const first = items[0];
    if (!first) return false;
    let end = 0;
    if (first.bundleId)
      while (end + 1 < items.length && items[end + 1]!.bundleId === first.bundleId) end++;
    return items.slice(0, end + 1).some((m) => m.text.trim().length > 0);
  }

  private takeBundleText(thread: ChatThread, index: number): string {
    const items = this.queueOf(thread);
    const first = items[index];
    if (!first) return "";
    const bundle = first.bundleId;
    let end = index;
    if (bundle) while (end + 1 < items.length && items[end + 1]!.bundleId === bundle) end++;
    const members = items.slice(index, end + 1);
    this.store.update(() => {
      items.splice(index, members.length);
    });
    return members
      .map((m) => m.text.trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
  }

  /** A bundle left with one member dissolves (frozen tidyBundles). */
  private tidyBundles(items: FollowUpItem[]): void {
    const counts = new Map<string, number>();
    for (const i of items) if (i.bundleId) counts.set(i.bundleId, (counts.get(i.bundleId) ?? 0) + 1);
    for (const i of items) if (i.bundleId && counts.get(i.bundleId) === 1) delete i.bundleId;
  }

  /** A move that separates a prompt from both bundle neighbours unbundles
   *  it; a bundle that leaves one member dissolves (frozen parity). */
  private unbundleIfSeparated(items: FollowUpItem[], id: string): void {
    const index = items.findIndex((i) => i.id === id);
    const bundle = items[index]?.bundleId;
    if (index < 0 || !bundle) return;
    const prevShares = index > 0 && items[index - 1]!.bundleId === bundle;
    const nextShares = index + 1 < items.length && items[index + 1]!.bundleId === bundle;
    if (prevShares || nextShares) return;
    delete items[index]!.bundleId;
    this.tidyBundles(items);
  }

  /** Enqueue-while-idle flush: drains unless the last turn was stopped —
   *  a turn the user cancelled waits for the user instead (frozen
   *  flushFollowUpsIfIdle + lastStatus != .interrupted). */
  private flushFollowUpsIfIdle(thread: ChatThread): void {
    if (this.threadBusy(thread)) return;
    const last = thread.turn?.status;
    if (last === "cancelled" || last === "interrupted") return;
    this.drainFollowUps(thread);
  }

  /** Pop the merged head item and send it as an ordinary turn. */
  private drainFollowUps(thread: ChatThread): void {
    if (this.threadBusy(thread) || this.drainingFollowUps.has(thread.id)) return;
    if (!thread.followUps?.length) return;
    this.drainingFollowUps.add(thread.id);
    try {
      const text = this.takeBundleText(thread, 0);
      if (!text.trim()) {
        this.emitQueue(thread);
        return;
      }
      this.sendTurn(thread.id, text);
    } finally {
      this.drainingFollowUps.delete(thread.id);
    }
  }

  resolveApproval(threadId: string, approvalId: string, optionId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const turn = thread.turn;
    const approval = turn?.approval;
    if (!turn || !approval || approval.id !== approvalId)
      throw new EngineError("no such pending approval");
    if (approval.status !== "pending") {
      // Re-resolving the SAME settled request with the SAME option is the
      // only harmless repeat; anything else on a settled approval fails.
      if (approval.resolvedOptionId === optionId) return;
      throw new EngineError("approval already resolved");
    }
    // A pending approval may only be answered while its turn is actually
    // waiting on it and the provider handle is still live — a terminal
    // turn can never be revived into "running" or mint a grant.
    if (turn.status !== "waiting-approval")
      throw new EngineError("turn is not waiting on this approval");
    if (!this.handles.has(threadId))
      throw new EngineError("approval has no live turn to resume");
    const option = approval.options.find((o) => o.id === optionId);
    if (!option) throw new EngineError("unknown approval option");

    const approved = option.role === "approve";
    const isCodex = this.provider.descriptor.mode === "codex";
    if (isCodex && approved) {
      // Write-acknowledged approval: the answer commits ONLY when the
      // provider confirms the response bytes hit the wire. Until then the
      // approval stays pending and the turn keeps waiting — a second
      // click with the same option is a no-op, a different one throws.
      if (this.inflightDecisions.has(approvalId)) {
        if (this.inflightDecisions.get(approvalId) === optionId) return;
        throw new EngineError("approval answer is being written");
      }
      this.inflightDecisions.set(approvalId, optionId);
      this.handles.get(threadId)?.resume(true, optionId);
      return;
    }
    if (this.inflightDecisions.has(approvalId))
      throw new EngineError("approval answer is being written");

    approval.status = "resolved";
    approval.resolvedOptionId = optionId;
    // Session/always grants exist only in the Mock's identity. Synthetic
    // stdio approvals are once/deny and never mint a persisted grant.
    const isMock = this.provider.descriptor.mode === "mock";
    if (isMock && approved && option.scope === "session" && !thread.sessionGrants.includes(MOCK_ACTION_ID))
      thread.sessionGrants.push(MOCK_ACTION_ID);
    if (isMock && approved && option.scope === "always") {
      this.store.update((d) => {
        if (!d.settings.alwaysAllow.includes(MOCK_ACTION_ID))
          d.settings.alwaysAllow.push(MOCK_ACTION_ID);
      });
    }
    this.store.update(() => {});

    this.emit({ type: "approval-resolved", threadId, turnId: turn.id, approval });

    if (approved) {
      turn.status = "running";
      this.emit({ type: "turn-status", threadId, turnId: turn.id, status: "running" });
      this.updateSleepGuard();
      this.handles.get(threadId)?.resume(true, optionId);
    } else {
      // A deny-class option the provider understands ("cancel" ⇒ frozen
      // "cancel" payload) writes through decline(); everything else is
      // the plain interrupt path.
      const h = this.handles.get(threadId);
      if (h?.decline) h.decline(optionId);
      else h?.cancel();
      this.handles.delete(threadId);
      this.endTurn(thread, turn, "denied");
    }
  }

  setSettings(patch: {
    theme?: import("../shared/types").ThemeId | undefined;
    language?: "en" | "zh-Hans" | undefined;
    notifyOnDone?: boolean | undefined;
    chimeWhenFinished?: boolean | undefined;
    autoContinueAfterLimit?: boolean | undefined;
    confirmBeforeDeleting?: boolean | undefined;
    recentDownloadsPicker?: boolean | undefined;
    newThreadLocation?: "recent" | "standalone" | undefined;
    defaultRuntimeMode?: import("../shared/types").RuntimeMode | undefined;
    defaultWorkspaceMode?: "local" | "worktree" | undefined;
    showReasoning?: boolean | undefined;
    showsWorkingCard?: boolean | undefined;
    performanceMode?: boolean | undefined;
    showsSkylight?: boolean | undefined;
    cliInstallationTarget?: string | null | undefined;
    taskSleepMode?: "off" | "system" | "display" | undefined;
    textGeneration?: "automatic" | "off" | undefined;
    threadTitles?: "once" | "updated" | undefined;
    autoShelveDays?: number | undefined;
    shelvedGroupName?: string | null | undefined;
    commitInstructions?: string | undefined;
    shortcuts?: Record<string, import("../shared/shortcuts").KeyChord | null> | undefined;
    antiSlopEnabled?: boolean | undefined;
    alphaEnabled?: boolean | undefined;
    externalControlEnabled?: boolean | undefined;
    fontSizes?:
      | { ui?: number | undefined; content?: number | undefined; code?: number | undefined }
      | undefined;
    hydraEnabled?: boolean | undefined;
    hydraDefaultEnabled?: boolean | undefined;
    hydraQueueHeads?: boolean | undefined;
    hydraAlwaysHeads?: boolean | undefined;
    hydraIsolateHeads?: boolean | undefined;
    hydraMaxHeads?: number | null | undefined;
    hydraAutoMerge?: boolean | undefined;
    hydraReviewHeads?: boolean | undefined;
    hydraArchivesCodexHeads?: boolean | undefined;
    hydraShowsHeadDetails?: boolean | undefined;
    hydraAutoPopsHeads?: boolean | undefined;
    hydraTempersHeadEffort?: boolean | undefined;
    hasSeenHydraIntro?: boolean | undefined;
    hydraPairs?: import("../shared/hydra").HydraPair[] | undefined;
    lastHydraPairId?: string | null | undefined;
    modelList?: import("../shared/modelList").ModelPin[] | undefined;
    modelSections?: import("../shared/modelList").ModelSection[] | undefined;
    collapsedModelSections?: string[] | undefined;
    modelPreferences?:
      | Record<string, import("../shared/modelList").ModelPreference>
      | undefined;
    mcpServers?: import("../shared/mcp").McpServerConfig[] | undefined;
    backdropOpacity?: number | undefined;
    helperPanelSize?: { width: number; height: number } | undefined;
    sidebarWidth?: number | undefined;
    terminalHeight?: number | undefined;
  }): void {
    this.assertMutable();
    this.store.update((d) => {
      if (patch.theme) d.settings.theme = patch.theme;
      if (patch.language) d.settings.language = patch.language;
      if (patch.notifyOnDone !== undefined) d.settings.notifyOnDone = patch.notifyOnDone;
      if (patch.chimeWhenFinished !== undefined)
        d.settings.chimeWhenFinished = patch.chimeWhenFinished;
      if (patch.autoContinueAfterLimit !== undefined)
        d.settings.autoContinueAfterLimit = patch.autoContinueAfterLimit;
      if (patch.confirmBeforeDeleting !== undefined)
        d.settings.confirmBeforeDeleting = patch.confirmBeforeDeleting;
      if (patch.recentDownloadsPicker !== undefined)
        d.settings.recentDownloadsPicker = patch.recentDownloadsPicker;
      // F01: the frozen General defaults write verbatim.
      if (patch.newThreadLocation !== undefined)
        d.settings.newThreadLocation = patch.newThreadLocation;
      if (patch.defaultRuntimeMode !== undefined)
        d.settings.defaultRuntimeMode = patch.defaultRuntimeMode;
      if (patch.defaultWorkspaceMode !== undefined)
        d.settings.defaultWorkspaceMode = patch.defaultWorkspaceMode;
      if (patch.showReasoning !== undefined)
        d.settings.showReasoning = patch.showReasoning;
      if (patch.showsWorkingCard !== undefined)
        d.settings.showsWorkingCard = patch.showsWorkingCard;
      if (patch.performanceMode !== undefined)
        d.settings.performanceMode = patch.performanceMode;
      if (patch.showsSkylight !== undefined) d.settings.showsSkylight = patch.showsSkylight;
      // F33: null clears the install receipt (frozen uninstall path).
      if (patch.cliInstallationTarget !== undefined) {
        if (patch.cliInstallationTarget === null) delete d.settings.cliInstallationTarget;
        else d.settings.cliInstallationTarget = patch.cliInstallationTarget;
      }
      if (patch.taskSleepMode !== undefined) d.settings.taskSleepMode = patch.taskSleepMode;
      if (patch.textGeneration !== undefined) d.settings.textGeneration = patch.textGeneration;
      if (patch.threadTitles !== undefined) d.settings.threadTitles = patch.threadTitles;
      if (patch.autoShelveDays !== undefined)
        // Frozen picker only offers 0/3/7/14 — a stray value degrades
        // to off rather than inventing a cadence.
        d.settings.autoShelveDays =
          patch.autoShelveDays === 3 || patch.autoShelveDays === 7 || patch.autoShelveDays === 14
            ? patch.autoShelveDays
            : 0;
      if (patch.shelvedGroupName !== undefined)
        d.settings.shelvedGroupName = patch.shelvedGroupName?.trim() || null;
      // F13: empty instructions mean "no extra guidance" — drop the field
      // rather than persist a meaningless empty string (frozen default).
      if (patch.commitInstructions !== undefined) {
        if (patch.commitInstructions === "") delete d.settings.commitInstructions;
        else d.settings.commitInstructions = patch.commitInstructions;
      }
      // F27: the whole overrides map arrives validated — replace wholesale
      // so a removed override truly unsets (frozen Override semantics).
      if (patch.shortcuts !== undefined) {
        if (Object.keys(patch.shortcuts).length === 0) delete d.settings.shortcuts;
        else d.settings.shortcuts = patch.shortcuts;
      }
      if (patch.antiSlopEnabled !== undefined)
        d.settings.antiSlopEnabled = patch.antiSlopEnabled;
      if (patch.alphaEnabled !== undefined) d.settings.alphaEnabled = patch.alphaEnabled;
      if (patch.externalControlEnabled !== undefined)
        d.settings.externalControlEnabled = patch.externalControlEnabled;
      // F26: per-category writes merge and clamp like the frozen didSet —
      // a category never lands out of its range; reset writes the frozen
      // defaults explicitly (the Settings button sends all three).
      if (patch.fontSizes !== undefined) {
        const next = { ...(d.settings.fontSizes ?? {}) };
        if (patch.fontSizes.ui !== undefined)
          next.ui = clampFontSize(patch.fontSizes.ui, "ui");
        if (patch.fontSizes.content !== undefined)
          next.content = clampFontSize(patch.fontSizes.content, "content");
        if (patch.fontSizes.code !== undefined)
          next.code = clampFontSize(patch.fontSizes.code, "code");
        if (Object.keys(next).length > 0) d.settings.fontSizes = next;
      }
      // F21 Hydra — wholesale assigns for booleans/pairs; the caps use
      // null to mean "no cap" (frozen defaults.removeObject parity), and
      // values are clamped into the frozen 1..8 range at write time.
      if (patch.hydraEnabled !== undefined) d.settings.hydraEnabled = patch.hydraEnabled;
      if (patch.hydraDefaultEnabled !== undefined)
        d.settings.hydraDefaultEnabled = patch.hydraDefaultEnabled;
      if (patch.hydraQueueHeads !== undefined)
        d.settings.hydraQueueHeads = patch.hydraQueueHeads;
      if (patch.hydraAlwaysHeads !== undefined)
        d.settings.hydraAlwaysHeads = patch.hydraAlwaysHeads;
      if (patch.hydraIsolateHeads !== undefined)
        d.settings.hydraIsolateHeads = patch.hydraIsolateHeads;
      if (patch.hydraMaxHeads !== undefined) {
        if (patch.hydraMaxHeads === null) delete d.settings.hydraMaxHeads;
        else {
          const cap = clampedHydraCap(patch.hydraMaxHeads);
          if (cap === undefined) delete d.settings.hydraMaxHeads;
          else d.settings.hydraMaxHeads = cap;
        }
      }
      if (patch.hydraAutoMerge !== undefined)
        d.settings.hydraAutoMerge = patch.hydraAutoMerge;
      if (patch.hydraReviewHeads !== undefined)
        d.settings.hydraReviewHeads = patch.hydraReviewHeads;
      if (patch.hydraArchivesCodexHeads !== undefined)
        d.settings.hydraArchivesCodexHeads = patch.hydraArchivesCodexHeads;
      if (patch.hydraShowsHeadDetails !== undefined)
        d.settings.hydraShowsHeadDetails = patch.hydraShowsHeadDetails;
      if (patch.hydraAutoPopsHeads !== undefined)
        d.settings.hydraAutoPopsHeads = patch.hydraAutoPopsHeads;
      if (patch.hydraTempersHeadEffort !== undefined)
        d.settings.hydraTempersHeadEffort = patch.hydraTempersHeadEffort;
      if (patch.hasSeenHydraIntro !== undefined)
        d.settings.hasSeenHydraIntro = patch.hasSeenHydraIntro;
      if (patch.hydraPairs !== undefined) {
        if (patch.hydraPairs.length === 0) delete d.settings.hydraPairs;
        else
          d.settings.hydraPairs = patch.hydraPairs.map((p) => ({
            ...p,
            maxHeads: clampedHydraCap(p.maxHeads),
          }));
      }
      if (patch.lastHydraPairId !== undefined) {
        if (patch.lastHydraPairId === null) delete d.settings.lastHydraPairId;
        else d.settings.lastHydraPairId = patch.lastHydraPairId;
      }
      // F17 model-list — whole-array writes; the shared layout ops already
      // produced valid ordering, so each slice persists verbatim (empty
      // arrays delete, mirroring frozen "absent = empty" semantics).
      if (patch.modelList !== undefined) {
        if (patch.modelList.length === 0) delete d.settings.modelList;
        else d.settings.modelList = patch.modelList;
      }
      if (patch.modelSections !== undefined) {
        if (patch.modelSections.length === 0) delete d.settings.modelSections;
        else d.settings.modelSections = patch.modelSections;
      }
      if (patch.collapsedModelSections !== undefined) {
        if (patch.collapsedModelSections.length === 0)
          delete d.settings.collapsedModelSections;
        else d.settings.collapsedModelSections = patch.collapsedModelSections;
      }
      if (patch.modelPreferences !== undefined) {
        if (Object.keys(patch.modelPreferences).length === 0)
          delete d.settings.modelPreferences;
        else d.settings.modelPreferences = patch.modelPreferences;
      }
      // F18: whole-array write; empty clears (frozen absent = none).
      if (patch.mcpServers !== undefined) {
        if (patch.mcpServers.length === 0) delete d.settings.mcpServers;
        else d.settings.mcpServers = patch.mcpServers;
      }
      // F26: transparency slider — plain user preference.
      if (patch.backdropOpacity !== undefined) {
        d.settings.backdropOpacity = Math.min(1, Math.max(0, patch.backdropOpacity));
      }
      // F25: dragged helper-panel size — clamped to sane bounds; the
      // panel refits it to the live pane before use anyway.
      if (patch.helperPanelSize !== undefined) {
        d.settings.helperPanelSize = {
          width: Math.min(4000, Math.max(200, Math.round(patch.helperPanelSize.width))),
          height: Math.min(4000, Math.max(140, Math.round(patch.helperPanelSize.height))),
        };
      }
      // A81: dragged layout sizes — frozen bounds (SidebarLayout
      // 210–440, terminal drawer 140–760).
      if (patch.sidebarWidth !== undefined) {
        d.settings.sidebarWidth = Math.min(
          440,
          Math.max(210, Math.round(patch.sidebarWidth)),
        );
      }
      if (patch.terminalHeight !== undefined) {
        d.settings.terminalHeight = Math.min(
          760,
          Math.max(140, Math.round(patch.terminalHeight)),
        );
      }
    });
    this.emit({ type: "settings-changed", settings: this.store.state.settings });
    this.updateSleepGuard();
    // Turning the auto-shelve picker on applies the new window right
    // away — frozen parity, and the exemption set is re-evaluated here.
    if (patch.autoShelveDays !== undefined) this.shelveIdleProjects();
  }

  /**
   * Durable save/clear of the user-chosen Codex executable (P2N). Touches
   * ONLY settings.codexExecutable — every other field and pending change
   * keeps its value. Success requires an actual durable commit: the field
   * is updated in memory, then flushed immediately; a failed flush reverts
   * the in-memory field so no later scheduled write can silently persist
   * the failed candidate, and the error propagates to the caller.
   */
  setCodexExecutable(path: string | undefined): void {
    this.assertMutable();
    if (!this.store.ownsWrites)
      throw new EngineError("store is not writable — the saved path cannot be persisted");
    const prev = this.store.state.settings.codexExecutable;
    this.store.update((d) => {
      if (path === undefined) delete d.settings.codexExecutable;
      else d.settings.codexExecutable = path;
    });
    try {
      this.store.flushNow();
    } catch (err) {
      this.store.update((d) => {
        if (prev === undefined) delete d.settings.codexExecutable;
        else d.settings.codexExecutable = prev;
      });
      throw err;
    }
    this.emit({ type: "settings-changed", settings: this.store.state.settings });
  }

  // ---- per-thread model/effort selection (F17) -----------------------------

  /**
   * User-chosen Codex model/effort overrides for one thread. Persisted
   * verbatim — the provider decides whether an id is usable; clearing
   * (null) returns the thread to the provider default. Honest bounds:
   * the selection applies to the NEXT turn; a running turn is untouched.
   */
  setThreadModel(
    threadId: string,
    model: string | null,
    effort: string | null,
    fastTier: string | null = null,
  ): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (model !== null && (model.length === 0 || model.length > 200))
      throw new EngineError("invalid model id");
    if (effort !== null && (effort.length === 0 || effort.length > 100))
      throw new EngineError("invalid effort");
    if (fastTier !== null && (fastTier.length === 0 || fastTier.length > 100))
      throw new EngineError("invalid service tier");
    const modelBefore = thread.codexModel;
    this.store.update(() => {
      if (model === null) delete thread.codexModel;
      else thread.codexModel = model;
      if (effort === null) delete thread.codexEffort;
      else thread.codexEffort = effort;
      if (fastTier === null) delete thread.codexServiceTier;
      else thread.codexServiceTier = fastTier;
      thread.updatedAt = Date.now();
    });
    this.emit({ type: "thread-updated", thread });
    // 2.2.12 parity (frozen AutoContinue.applies): a wait armed against
    // the old model's limit must end the moment the model changes — the
    // composer wait state clears now, not at fire time. Effort and
    // service-tier-only changes leave the wait alone.
    if (thread.codexModel !== modelBefore && this.limitWaits.has(thread.id))
      this.clearLimitWait(thread.id);
  }

  /**
   * F15/F11: the thread's working directory — its OWN worktree when the
   * binding is recorded and still live, else its project's bound
   * directory. A dead worktree honestly reports null (never silently
   * falls back to a different directory — the frozen standalone-task
   * rule); a thread without a project has no execution directory yet.
   */
  threadDirectory(threadId: string): string | null {
    const thread = this.mustThread(threadId);
    if (thread.worktreeDir !== undefined) {
      return this.paths?.dirLive(thread.worktreeDir) ? thread.worktreeDir : null;
    }
    if (!thread.projectId) return null;
    const project = this.store.state.projects.find((p) => p.id === thread.projectId);
    if (!project?.directory) return null;
    return this.directoryStatusFor(project) === "available" ? project.directory : null;
  }

  /**
   * F15 sidebar reveal: the project row's bound directory, or the
   * worktree-bound thread's own worktree directory (frozen condition —
   * only shown when the thread HAS a recorded worktree). Both report
   * null rather than a guessed path; the IPC layer separately refuses
   * when the directory no longer exists.
   */
  projectDirectory(projectId: string): string | null {
    const project = this.store.state.projects.find((p) => p.id === projectId);
    if (!project) throw new EngineError("project not found");
    return project.directory ?? null;
  }

  threadWorktreePath(threadId: string): string | null {
    const thread = this.mustThread(threadId);
    return thread.worktreeDir ?? null;
  }

  /**
   * F11: create an app-owned worktree for this thread (`git worktree
   * add` under <dataRoot>/worktrees) and bind it as the thread's
   * execution directory. The branch name is user-supplied but only ever
   * reaches git after `check-ref-format` + a collision check; the
   * directory itself is always main-chosen.
   */
  async createThreadWorktree(threadId: string, branch?: string): Promise<WorktreeResult> {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!this.worktrees) return { kind: "unavailable", reason: "worktrees-unavailable" };
    if (!thread.projectId) return { kind: "unavailable", reason: "thread-has-no-project" };
    if (thread.worktreeDir) return { kind: "unavailable", reason: "already-bound" };
    if (thread.turn && (thread.turn.status === "running" || thread.turn.status === "waiting-approval"))
      return { kind: "unavailable", reason: "turn-active" };
    const project = this.store.state.projects.find((p) => p.id === thread.projectId);
    if (!project?.directory || this.directoryStatusFor(project) !== "available")
      return { kind: "unavailable", reason: "project-directory-unavailable" };
    const name = (branch ?? "").trim() || `wt-${threadId.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`;
    const check = await this.worktrees.worktreeCheck(thread.projectId, name);
    if (check.kind !== "ok") return check;
    const res = await this.worktrees.worktreeAdd(
      thread.projectId,
      threadId.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase() || "thread",
      check.name,
    );
    if (res.kind !== "created") return res;
    this.store.update((d) => {
      const t = d.threads.find((x) => x.id === threadId);
      if (!t) return;
      t.worktreeDir = res.directory;
      t.updatedAt = Date.now();
    });
    // F12: scripts marked "run when a worktree is created" run inside the
    // fresh worktree via real terminals — failures are reported by name,
    // never silently skipped and never a worktree-creation failure.
    const setup = this.runWorktreeSetupScripts(threadId, project);
    if (setup.ran + setup.failed.length > 0) res.setup = setup;
    const updated = this.mustThread(threadId);
    this.emit({ type: "thread-updated", thread: updated });
    return res;
  }

  /** F11 branch menu — the thread's execution directory (own worktree
   *  when bound, else the project checkout) is resolved and verified
   *  here; the renderer never names a directory. */
  private threadGitContext(threadId: string): { projectId: string; cwd: string } | null {
    const thread = this.mustThread(threadId);
    if (!thread.projectId) return null;
    const cwd = this.threadDirectory(threadId);
    if (!cwd) return null;
    return { projectId: thread.projectId, cwd };
  }

  /** Read-only: the menu's branch rows + detached marker. */
  async threadBranches(threadId: string) {
    const ctx = this.threadGitContext(threadId);
    if (!ctx || !this.worktrees) return { kind: "unavailable" as const, reason: "no-directory" };
    return this.worktrees.branches(ctx.projectId, ctx.cwd);
  }

  /** Frozen switch gate: not the current branch, and never mid-turn. */
  async switchThreadBranch(threadId: string, name: string) {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (thread.turn && (thread.turn.status === "running" || thread.turn.status === "waiting-approval"))
      return { kind: "unavailable" as const, reason: "turn-active" };
    const ctx = this.threadGitContext(threadId);
    if (!ctx || !this.worktrees) return { kind: "unavailable" as const, reason: "no-directory" };
    return this.worktrees.switchBranch(ctx.projectId, ctx.cwd, name);
  }

  /** `git switch -c` moves HEAD too — same mid-turn refusal as switch. */
  async createThreadBranch(threadId: string, name: string) {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (thread.turn && (thread.turn.status === "running" || thread.turn.status === "waiting-approval"))
      return { kind: "unavailable" as const, reason: "turn-active" };
    const ctx = this.threadGitContext(threadId);
    if (!ctx || !this.worktrees) return { kind: "unavailable" as const, reason: "no-directory" };
    return this.worktrees.createBranch(ctx.projectId, ctx.cwd, name);
  }

  /** Frozen rename is worktree-bound only — plain checkouts are never
   *  renamed through this menu. `old` is derived live in the service. */
  async renameThreadBranch(threadId: string, name: string, confirmedPushed: boolean) {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!thread.worktreeDir) return { kind: "unavailable" as const, reason: "no-worktree" };
    const ctx = this.threadGitContext(threadId);
    if (!ctx || !this.worktrees) return { kind: "unavailable" as const, reason: "no-directory" };
    return this.worktrees.renameBranch(ctx.projectId, ctx.cwd, name, confirmedPushed);
  }

  /** F11: remove the thread's worktree (`git worktree remove`, plain —
   *  a dirty worktree reports git's refusal, never force-discards). On
   *  success the binding is cleared; on refusal it stays. */
  async removeThreadWorktree(threadId: string): Promise<WorktreeResult> {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!this.worktrees) return { kind: "unavailable", reason: "worktrees-unavailable" };
    if (!thread.projectId) return { kind: "unavailable", reason: "thread-has-no-project" };
    if (!thread.worktreeDir) return { kind: "unavailable", reason: "no-worktree" };
    if (thread.turn && (thread.turn.status === "running" || thread.turn.status === "waiting-approval"))
      return { kind: "unavailable", reason: "turn-active" };
    const res = await this.worktrees.worktreeRemove(thread.projectId, thread.worktreeDir);
    if (res.kind !== "removed") return res;
    this.store.update((d) => {
      const t = d.threads.find((x) => x.id === threadId);
      if (!t) return;
      delete t.worktreeDir;
      t.updatedAt = Date.now();
    });
    const updated = this.mustThread(threadId);
    this.emit({ type: "thread-updated", thread: updated });
    return res;
  }

  // ---- F12 project scripts ------------------------------------------------
  // Scripts run in a REAL terminal at the thread's execution directory
  // (worktree-aware) — the command is typed into the sterile shell, never
  // spawned unsandboxed by main. `runOnWorktreeCreate` scripts run the same
  // way right after `createThreadWorktree` binds a worktree, capped at 16
  // (frozen control-path bound).

  /** Replace a project's script list (frozen updateProject{scripts}).
   *  Every row needs a command — an incomplete row refuses the whole
   *  save, matching the frozen editor's disabled Save. */
  setProjectScripts(
    projectId: string,
    scripts: Array<{
      id: string | undefined;
      name: string;
      command: string;
      icon: string | undefined;
      runOnWorktreeCreate: boolean | undefined;
    }>,
  ): void {
    this.assertMutable();
    const project = this.store.state.projects.find((p) => p.id === projectId);
    if (!project) throw new EngineError(`unknown project ${projectId}`);
    if (!Array.isArray(scripts) || scripts.length > 32)
      throw new EngineError("too many scripts");
    const cleaned = scripts.map((s, i) => {
      const command = (s.command ?? "").trim();
      if (!command) throw new EngineError("every script needs a command");
      const name = (s.name ?? "").trim().slice(0, 160) || `Script ${i + 1}`;
      return {
        id: typeof s.id === "string" && s.id ? s.id.slice(0, 120) : randomUUID(),
        name,
        command: command.slice(0, 4000),
        icon: (s.icon ?? "").trim().slice(0, 60) || "play",
        runOnWorktreeCreate: s.runOnWorktreeCreate === true,
      };
    });
    this.store.update((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (!p) return;
      if (cleaned.length) p.scripts = cleaned;
      else delete p.scripts;
    });
    const updated = this.store.state.projects.find((p) => p.id === projectId)!;
    this.emit({ type: "project-updated", project: this.withDirectoryStatus(updated) });
  }

  /** Frozen `runScript`: open a terminal titled by the script in the
   *  thread's execution directory and run the command there. Honest
   *  unavailable states pass through — nothing fakes a run. */
  runProjectScript(
    threadId: string,
    scriptId: string,
  ): { terminal?: import("../shared/types").TerminalInfo; unavailable?: string } {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!thread.projectId) return { unavailable: "unbound" };
    if (!this.terminals) return { unavailable: "unavailable" };
    const project = this.store.state.projects.find((p) => p.id === thread.projectId);
    const script = project?.scripts?.find((s) => s.id === scriptId);
    if (!script) return { unavailable: "unknown-script" };
    if (!script.command.trim()) return { unavailable: "script-empty" };
    return this.terminals.create(threadId, 120, 30, {
      title: script.name,
      command: script.command,
    });
  }

  /** F12: scripts marked runOnWorktreeCreate run right after a worktree
   *  binds — inside the worktree, via the same terminal path. */
  private runWorktreeSetupScripts(threadId: string, project: Project): {
    ran: number;
    failed: { name: string; reason: string }[];
  } {
    const out = { ran: 0, failed: [] as { name: string; reason: string }[] };
    if (!this.terminals) {
      for (const s of (project.scripts ?? []).filter((s) => s.runOnWorktreeCreate).slice(0, 16))
        out.failed.push({ name: s.name, reason: "unavailable" });
      return out;
    }
    for (const s of (project.scripts ?? []).filter((s) => s.runOnWorktreeCreate).slice(0, 16)) {
      try {
        const r = this.terminals.create(threadId, 120, 30, {
          title: s.name,
          command: s.command,
        });
        if (r.terminal) out.ran += 1;
        else out.failed.push({ name: s.name, reason: r.unavailable ?? "unavailable" });
      } catch (e) {
        out.failed.push({ name: s.name, reason: (e as Error).message });
      }
    }
    return out;
  }

  /** F06: Build/Plan — persisted per thread, next turn only. */
  /** Frozen `SlashCommand.name(in:)` — non-empty only when the text
   *  opens with a KNOWN command word. This build never loads provider
   *  commands, so the known set is the builtin list plus names this
   *  provider has actually recorded using (the only provider-command
   *  evidence available here). An unknown `/foo` is ordinary text. */
  private opensWithKnownCommand(text: string): boolean {
    const m = /^\/([a-z0-9-]+)/i.exec(text);
    if (!m) return false;
    const name = m[1]!.toLowerCase();
    const mode = this.provider.descriptor.mode;
    if (
      builtinSlashCommands(this.provider.descriptor.compact === true).some(
        (c) => c.name === name,
      )
    )
      return true;
    return (this.store.state.recentCommands?.[mode] ?? []).includes(name);
  }

  /**
   * F05 frozen `recordCommand`: a slash command was actually used —
   * prepend it to this provider's recency list (dedupe, cap 100) and
   * persist. Ordering input for the composer suggestion menu; the typed
   * `/plan` path calls this while the Build/Plan toggle button does not.
   */
  recordCommand(name: string): void {
    this.assertMutable();
    if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new EngineError("invalid command name");
    const key = this.provider.descriptor.mode;
    this.store.update((d) => {
      const recent = (d.recentCommands?.[key] ?? []).filter((n) => n !== name);
      recent.unshift(name);
      d.recentCommands = { ...d.recentCommands, [key]: recent.slice(0, 100) };
    });
    this.emit({
      type: "slash-recorded",
      recentCommands: this.store.state.recentCommands ?? {},
    });
  }

  setInteractionMode(threadId: string, mode: InteractionMode): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (mode !== "build" && mode !== "plan") throw new EngineError("invalid interaction mode");
    if (thread.interactionMode === mode) return;
    this.store.update(() => {
      thread.interactionMode = mode;
      thread.updatedAt = Date.now();
    });
    this.emit({ type: "thread-updated", thread });
  }

  /**
   * F09: copy conversation context into a NEW thread in the same
   * project with independent provider state (frozen forwardThread).
   * The snapshot is budgeted; delivery happens once, on the first
   * ordinary send, inside startProvider.
   */
  forwardThread(sourceId: string): ChatThread {
    this.assertMutable();
    const source = this.mustThread(sourceId);
    const continuation = captureContinuation(
      source.messages,
      source.id,
      source.title,
      source.continuation,
    );
    const thread: ChatThread = {
      id: randomUUID(),
      projectId: source.projectId,
      title: `Continued: ${source.title}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      turn: null,
      sessionGrants: [],
      // F06: frozen makeThread seeds every new thread from the saved
      // default runtime mode — a continuation is a new thread too.
      runtimeMode: this.store.state.settings.defaultRuntimeMode ?? "fullAccess",
      continuation,
    };
    this.store.update((d) => {
      d.threads.push(thread);
      d.ui.selectedThreadId = thread.id;
    });
    this.emit({ type: "thread-added", thread });
    this.emit({ type: "thread-selected", threadId: thread.id });
    return thread;
  }

  /**
   * F01/F02: reorder a thread inside its own affiliation (frozen
   * `moveThread(id,to:placeAfter:)`). The dragged thread takes the
   * target's pin state; the whole section is renumbered 0..n-1.
   * Returns whether the order changed.
   */
  moveThread(id: string, targetId: string, placeAfter: boolean): boolean {
    this.assertMutable();
    if (id === targetId) return false;
    const moving = this.mustThread(id);
    const target = this.mustThread(targetId);
    if (moving.projectId !== target.projectId) return false;
    if (moving.isArchived || target.isArchived) return false;
    const shown = threadsInAffiliation(this.store.state.threads, moving.projectId);
    const before = shown.map((t) => t.id);
    const order = before.filter((x) => x !== id);
    const index = order.indexOf(targetId);
    if (index < 0) return false;
    order.splice(placeAfter ? index + 1 : index, 0, id);
    if (order.join() === before.join()) return false;
    const byId = new Map(shown.map((t) => [t.id, t]));
    this.store.update(() => {
      order.forEach((tid, position) => {
        const t = byId.get(tid);
        if (!t) return;
        if (tid === id) t.isPinned = target.isPinned === true;
        t.sortOrder = position;
      });
    });
    this.emit({ type: "thread-updated", thread: moving });
    return true;
  }

  /**
   * F01: move a thread to another project or to standalone (frozen
   * `moveThread(id,to:affiliation)` + `applyThreadAffiliation`). Only a
   * thread that has never started a turn may move — the session,
   * provider binding and terminals cannot follow it. Clears the
   * provider thread binding and manual order (nil sortOrder → top of
   * the target section, frozen parity). Returns false when the gate
   * refuses; throws only for unknown ids.
   */
  moveThreadToProject(id: string, projectId: string | null): boolean {
    this.assertMutable();
    const thread = this.mustThread(id);
    const target = projectId ?? null;
    if (target) this.mustProject(target);
    if (thread.projectId === target) return true;
    // Frozen gate: not archived, no started turn, nothing live.
    const started =
      thread.turn !== null || thread.messages.some((m) => m.role === "user");
    if (thread.isArchived || started || this.limitWaits.has(id)) return false;
    // applyThreadAffiliation: stop the session, drop queued sends, clear
    // the provider identity — terminals are closed by the IPC layer
    // (terminals live outside the engine, same as deleteThread).
    this.pendingSends.delete(id);
    this.handles.get(id)?.cancel();
    this.handles.delete(id);
    this.provider.endSession?.(id);
    this.store.update(() => {
      thread.projectId = target;
      delete thread.providerThread;
      delete thread.sortOrder;
      if (target) {
        const p = this.store.state.projects.find((x) => x.id === target);
        if (p) p.expanded = true;
      }
    });
    this.emit({ type: "thread-updated", thread });
    // Frozen: a thread moved into a shelved project wakes it.
    if (target) this.wakeShelvedProject(target);
    return true;
  }

  /**
   * F01: reorder projects (frozen `moveProject`) — the projects array
   * order IS the sidebar order. Returns whether the order changed.
   */
  moveProject(id: string, targetId: string, placeAfter: boolean): boolean {
    this.assertMutable();
    if (id === targetId) return false;
    const data = this.store.state;
    if (!data.projects.some((p) => p.id === id)) return false;
    if (!data.projects.some((p) => p.id === targetId)) return false;
    const before = data.projects.map((p) => p.id);
    const order = before.filter((x) => x !== id);
    const index = order.indexOf(targetId);
    if (index < 0) return false;
    order.splice(placeAfter ? index + 1 : index, 0, id);
    if (order.join() === before.join()) return false;
    this.store.update((d) => {
      const byId = new Map(d.projects.map((p) => [p.id, p]));
      d.projects = order.map((pid) => byId.get(pid)!);
    });
    this.emit({
      type: "project-updated",
      project: this.withDirectoryStatus(this.mustProject(id)),
    });
    return true;
  }

  /** F02: pin keeps a thread at the top of its list section. */
  setThreadPinned(threadId: string, pinned: boolean): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!!thread.isPinned === pinned) return;
    this.store.update(() => {
      thread.isPinned = pinned;
      thread.updatedAt = Date.now();
    });
    this.emit({ type: "thread-updated", thread });
  }

  /**
   * F06: persist the thread's runtime mode. Applies to future turns
   * only — a running turn keeps the policy it was admitted with.
   */
  setRuntimeMode(threadId: string, mode: RuntimeMode): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!RUNTIME_MODES.includes(mode)) throw new EngineError("invalid runtime mode");
    if (thread.runtimeMode === mode) return;
    this.store.update(() => {
      thread.runtimeMode = mode;
      thread.updatedAt = Date.now();
    });
    this.emit({ type: "thread-updated", thread });
  }

  /**
   * F21/F22: the per-chat Hydra switch (frozen AppModel.setHydra). Every
   * per-chat flip also saves `hydraDefaultEnabled` — the frozen build
   * seeds each new chat from the last explicit choice. Pair selection
   * stays where the frozen build puts it (model picker / Settings);
   * `hydraPairId` is not retargeted here.
   */
  setThreadHydra(threadId: string, enabled: boolean): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (thread.hydraEnabled === enabled &&
        this.store.state.settings.hydraDefaultEnabled === enabled) return;
    this.store.update((d) => {
      thread.hydraEnabled = enabled;
      thread.updatedAt = Date.now();
      d.settings.hydraDefaultEnabled = enabled;
    });
    this.emit({ type: "thread-updated", thread });
    this.emit({ type: "settings-changed", settings: this.store.state.settings });
  }

  /**
   * The provider-owned model catalog (Codex model/list). Never
   * fabricated: non-Codex providers → unsupported; no live session →
   * pending; a failed read → unavailable with the real reason.
   */
  async codexModels(): Promise<CodexModelCatalog> {
    if (this.provider.descriptor.mode !== "codex")
      return { state: "unsupported", reason: "the active provider has no model catalog" };
    const fetcher = this.provider.modelCatalog;
    if (!fetcher)
      return { state: "unsupported", reason: "this provider build cannot list models" };
    try {
      const models = await fetcher.call(this.provider);
      if (models === null)
        return {
          state: "pending",
          reason: "no Codex session is bound yet — send a turn, then reopen",
        };
      return { state: "ready", models };
    } catch (err) {
      return { state: "unavailable", reason: (err as Error)?.message ?? String(err) };
    }
  }

  /**
   * F21: the provider-catalog view the Hydra pair editor and cookbook
   * resolve against (frozen ProviderRegistry slice). Only the bound
   * adapter exists in this build — other providers are unlistable, the
   * same outcome as the frozen enabled+installed filter producing an
   * empty picker. A pending/unavailable catalog reports empty models;
   * recipes naming models this provider never reported stay unoffered.
   */
  async hydraCatalog(): Promise<{
    providers: {
      id: string;
      label: string;
      ready: boolean;
      models: { id: string; name: string; efforts: string[] }[];
      defaultModel?: string | undefined;
    }[];
  }> {
    const desc = this.provider.descriptor;
    const entry: {
      id: string;
      label: string;
      ready: boolean;
      models: { id: string; name: string; efforts: string[] }[];
      defaultModel?: string | undefined;
    } = { id: desc.mode, label: desc.label, ready: true, models: [] };
    if (desc.mode === "codex") {
      const cat = await this.codexModels();
      if (cat.state === "ready") {
        entry.models = cat.models.map((m) => ({
          id: m.id,
          name: m.name,
          efforts: m.efforts,
        }));
        entry.defaultModel = cat.models.find((m) => m.isDefault)?.id;
      }
    }
    return { providers: [entry] };
  }

  /**
   * Provider-reported effective model/effort for a thread (thread/
   * start|resume echo). Diagnostic only — persisted verbatim next to the
   * user's selection, never rewritten into it.
   */
  private onModelReport(threadId: string, model: string | null, effort: string | null): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const m = model && model.length <= 200 ? model : undefined;
    const e = effort && effort.length <= 100 ? effort : undefined;
    if (thread.codexModelReported === m && thread.codexEffortReported === e) return;
    this.store.update(() => {
      if (m === undefined) delete thread.codexModelReported;
      else thread.codexModelReported = m;
      if (e === undefined) delete thread.codexEffortReported;
      else thread.codexEffortReported = e;
    });
    this.emit({ type: "thread-updated", thread });
  }

  // ---- provider event intake (turnId-guarded) -----------------------------

  /** Late or foreign-turn chunks are dropped; seq must move forward. The
   *  emitted delta is exactly what the bounded store retained — renderer
   *  and persisted content can never diverge. */
  private onProviderChunk(threadId: string, turnId: string, seq: number, delta: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId || turn.status !== "running") return;
    if (seq <= turn.seq) return;
    turn.seq = seq;
    const msg = thread.messages.find((m) => m.id === turn.assistantMessageId);
    const prev = msg?.content ?? "";
    const next = boundedText(prev + delta);
    if (msg) msg.content = next;
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    const appended = next.startsWith(prev) ? next.slice(prev.length) : next;
    if (appended) {
      this.emit({ type: "turn-chunk", threadId, turnId, seq, delta: appended });
      this.feedHydraAppend(thread, turn, appended);
    }
  }

  /**
   * Whole-composition assistant text (Codex): the provider already
   * deduplicated ordered items — the message content is REPLACED, never
   * appended, so a rewritten final item cannot double its text.
   */
  private onProviderMessageText(
    threadId: string,
    turnId: string,
    seq: number,
    text: string,
  ): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId || turn.status !== "running") return;
    if (seq <= turn.seq) return;
    turn.seq = seq;
    const content = boundedText(text);
    const msg = thread.messages.find((m) => m.id === turn.assistantMessageId);
    if (msg) msg.content = content;
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "turn-chunk", threadId, turnId, seq, content });
    this.feedHydraWhole(thread, turn, content);
  }

  private onProviderApproval(
    threadId: string,
    turnId: string,
    req: Omit<ApprovalRequest, "id" | "turnId" | "status">,
  ): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId || turn.status !== "running") return;
    const approval: ApprovalRequest = { ...req, id: randomUUID(), turnId, status: "pending" };
    turn.approval = approval;
    turn.status = "waiting-approval";
    this.store.update(() => {});
    this.emit({ type: "approval-requested", threadId, turnId, approval });
    this.emit({ type: "turn-status", threadId, turnId, status: "waiting-approval" });

    const granted =
      this.provider.descriptor.mode === "mock" &&
      (thread.sessionGrants.includes(MOCK_ACTION_ID) ||
        this.store.state.settings.alwaysAllow.includes(MOCK_ACTION_ID));
    if (granted) {
      const option =
        approval.options.find((o) =>
          thread.sessionGrants.includes(MOCK_ACTION_ID) ? o.scope === "session" : o.scope === "always",
        ) ?? approval.options.find((o) => o.id === "once");
      if (option) {
        approval.status = "resolved";
        approval.resolvedOptionId = option.id;
        approval.autoResolved = true;
        this.store.update(() => {});
        this.emit({ type: "approval-resolved", threadId, turnId, approval });
        turn.status = "running";
        this.emit({ type: "turn-status", threadId, turnId, status: "running" });
        this.updateSleepGuard();
        this.handles.get(threadId)?.resume(true);
      }
    }
  }

  private finishTurn(threadId: string, turnId: string, status: "done"): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    // A waiting-approval turn can still complete: the server may finish or
    // terminate it while an answer was in flight — the pending approval
    // expires via endTurn instead of leaving a zombie card.
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    this.endTurn(thread, turn, status);
  }

  private failTurn(threadId: string, turnId: string, message: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    // F20: the provider error text IS the limit signal — parsed exactly
    // like the frozen CodexSession.finishTurn, which emits usageLimit
    // ahead of turnCompleted. The note is consumed by limitFinished.
    if (limitMatches(message)) this.noteLimit(threadId, limitResetTime(message, Date.now()));
    turn.error = message;
    this.endTurn(thread, turn, "error");
  }

  /**
   * IPC entry: the renderer answered (or skipped) the pending question.
   * `providerKey` must name the live pending request — a stale key from
   * an expired card can never reach the wire.
   */
  answerQuestion(threadId: string, providerKey: string, answers: Record<string, string[]>): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const turn = thread.turn;
    const question = turn?.question;
    if (!turn || !question || question.status !== "pending")
      throw new EngineError("no such pending question");
    if (question.providerKey !== providerKey)
      throw new EngineError("question key does not match the pending request");
    // Only a genuinely running turn may carry answers to the wire.
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    if (!this.handles.has(threadId)) return; // handle already gone — the
    // adapter withdraws it; the pending card expires via onQuestionWithdrawn
    this.handles.get(threadId)!.answer?.(providerKey, answers);
  }

  /** Codex only: a user-input request was presented on this turn. Kept
   *  on the turn (like approvals) so a mid-question snapshot/restart
   *  still shows the card truthfully. */
  private onProviderQuestion(
    threadId: string,
    turnId: string,
    req: Omit<CodexQuestionRequest, "status">,
  ): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running") return; // questions present only while live
    turn.question = { ...req, status: "pending" };
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** Codex only: the answer bytes were CONFIRMED on the wire — NOW the
   *  card commits (answered). Never before. */
  private onQuestionAnswered(threadId: string, turnId: string, providerKey: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    const question = turn?.question;
    if (!thread || !turn || turn.id !== turnId || !question) return;
    if (question.status !== "pending" || question.providerKey !== providerKey) return;
    question.status = "answered";
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** Codex only: the question went away unanswered — server-side
   *  resolution, a failed answer write, connection loss or terminal
   *  events. The card EXPIRES; it is never a user answer. */
  private onQuestionWithdrawn(threadId: string, turnId: string, providerKey: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    const question = turn?.question;
    if (!thread || !turn || turn.id !== turnId || !question) return;
    if (question.status !== "pending" || question.providerKey !== providerKey) return;
    question.status = "expired";
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** Server-side interruption (turn/completed: interrupted) — terminal,
   *  WITHOUT the restart-recovery marker text. */
  private interruptTurn(threadId: string, turnId: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    this.endTurn(thread, turn, "interrupted");
  }

  /** Server resolved a pending approval itself (or a queued answer write
   *  provably failed) — expire the card, never treat it as a user answer,
   *  clear any in-flight decision, and return the turn to running. */
  private onApprovalWithdrawn(threadId: string, turnId: string, providerKey: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    const approval = turn?.approval;
    if (!thread || !turn || turn.id !== turnId || !approval) return;
    if (turn.status !== "waiting-approval" || approval.status !== "pending") return;
    if (approval.providerKey !== providerKey) return;
    this.inflightDecisions.delete(approval.id);
    approval.status = "expired";
    turn.status = "running";
    this.store.update(() => {});
    this.emit({ type: "approval-resolved", threadId, turnId, approval });
    this.emit({ type: "turn-status", threadId, turnId, status: "running" });
    this.updateSleepGuard();
  }

  /**
   * Codex only: the provider confirmed the answer bytes hit stdin — NOW
   * the approval commits (resolved) and the turn resumes running. If the
   * recorded in-flight decision is gone (withdrawal/terminal raced it)
   * this ack is a no-op — it can never resurrect state.
   */
  private onApprovalAnswerWritten(threadId: string, turnId: string, providerKey: string): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    const approval = turn?.approval;
    if (!thread || !turn || turn.id !== turnId || !approval) return;
    if (approval.providerKey !== providerKey) return;
    const optionId = this.inflightDecisions.get(approval.id);
    if (optionId === undefined) return;
    this.inflightDecisions.delete(approval.id);
    approval.status = "resolved";
    approval.resolvedOptionId = optionId;
    this.store.update(() => {});
    this.emit({ type: "approval-resolved", threadId, turnId, approval });
    if (turn.status === "waiting-approval") {
      turn.status = "running";
      this.emit({ type: "turn-status", threadId, turnId, status: "running" });
      this.updateSleepGuard();
    }
  }

  /**
   * F03: reasoning item → a persisted, updatable system message tagged
   * `kind:"reasoning"` (collapsible block in the renderer). Deltas
   * append within a 64KiB bound; `done` installs the item's completed
   * text as authoritative (frozen summary ?? content).
   */
  private onReasoning(threadId: string, turnId: string, a: ReasoningActivity): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    const id = `codexreason-${turnId}-${createHash("sha1").update(a.itemId).digest("hex").slice(0, 12)}`;
    const seen = this.toolItemsSeen.get(turnId) ?? new Set<string>();
    this.toolItemsSeen.set(turnId, seen);
    if (!seen.has(id)) {
      if (seen.size >= 128) return; // shared per-turn bound — drop late items
      seen.add(id);
    }
    const CAP = 64 * 1024;
    let msg = thread.messages.find((m) => m.id === id);
    if (!msg) {
      msg = {
        id,
        role: "system",
        kind: "reasoning",
        content: "",
        status: "streaming",
        ts: Date.now(),
        turnId,
      };
      thread.messages.push(msg);
    }
    if (a.done) {
      const final = a.finalText ?? msg.content;
      msg.content = final.length > CAP ? final.slice(0, CAP) : final;
      msg.status = "done";
    } else if (a.delta) {
      const room = CAP - msg.content.length;
      if (room > 0)
        msg.content += a.delta.length <= room ? a.delta : a.delta.slice(0, room);
    }
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** Bounded tool/request status → a structured, updatable tool row. */
  private onToolActivity(threadId: string, turnId: string, a: ToolActivity): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    // Server item ids are arbitrary strings — hash them so the derived
    // store id is stable, collision-safe and ALWAYS within the 120-char
    // store limit (10 + 36 + 1 + 12 = 59).
    const id = `codextool-${turnId}-${createHash("sha1").update(a.itemId).digest("hex").slice(0, 12)}`;
    const seen = this.toolItemsSeen.get(turnId) ?? new Set<string>();
    this.toolItemsSeen.set(turnId, seen);
    if (!seen.has(id)) {
      if (seen.size >= 128) return; // per-turn bound — drop late items
      seen.add(id);
    }
    const state =
      a.status === "started" ? ("running" as const)
      : a.status === "completed" ? ("completed" as const)
      : a.status === "declined" ? ("declined" as const)
      : ("failed" as const);
    const tool = {
      kind: a.kind,
      ...(a.title !== undefined ? { title: a.title.slice(0, 500) } : {}),
      ...(a.titleKey !== undefined ? { titleKey: a.titleKey.slice(0, 120) } : {}),
      ...(a.titleParams ? { titleParams: a.titleParams.slice(0, 8) } : {}),
      ...(a.detail ? { detail: a.detail.slice(0, 32 * 1024) } : {}),
      state,
    };
    let msg = thread.messages.find((m) => m.id === id);
    if (msg) {
      msg.tool = tool;
      msg.status = state === "running" ? "streaming" : "done";
    } else {
      msg = {
        id,
        role: "system",
        kind: "tool",
        // Plain-text fallback for search/copy; the row renders `tool`.
        content: `${a.title ?? a.titleKey ?? a.kind} — ${state}`,
        tool,
        status: state === "running" ? "streaming" : "done",
        ts: Date.now(),
        turnId,
      };
      // Tool notes stay behind the assistant stream in insertion order.
      thread.messages.push(msg);
    }
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** F03 plan item → an updatable collapsible plan block (same contract
   *  as reasoning; the completed item's markdown is authoritative). */
  private onPlan(threadId: string, turnId: string, a: ReasoningActivity): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    const id = `codexplan-${turnId}-${createHash("sha1").update(a.itemId).digest("hex").slice(0, 12)}`;
    const seen = this.toolItemsSeen.get(turnId) ?? new Set<string>();
    this.toolItemsSeen.set(turnId, seen);
    if (!seen.has(id)) {
      if (seen.size >= 128) return;
      seen.add(id);
    }
    const CAP = 64 * 1024;
    let msg = thread.messages.find((m) => m.id === id);
    if (!msg) {
      msg = {
        id,
        role: "system",
        kind: "plan",
        content: "",
        status: "streaming",
        ts: Date.now(),
        turnId,
      };
      thread.messages.push(msg);
    }
    if (a.done) {
      const final = a.finalText ?? msg.content;
      msg.content = final.length > CAP ? final.slice(0, CAP) : final;
      msg.status = "done";
    } else if (a.delta) {
      const room = CAP - msg.content.length;
      if (room > 0)
        msg.content += a.delta.length <= room ? a.delta : a.delta.slice(0, room);
    }
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** Frozen turn/plan/updated → ONE updatable todos row per turn. */
  private onTodos(threadId: string, turnId: string, steps: readonly TodoStep[]): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    const id = `codextodos-${turnId}`;
    const kept = steps.slice(0, 50).map((st) => ({
      text: st.text.slice(0, 500),
      status: st.status,
    }));
    const done = kept.filter((st) => st.status === "done").length;
    let msg = thread.messages.find((m) => m.id === id);
    if (msg) {
      msg.steps = kept;
      msg.content = `${done}/${kept.length}`;
    } else {
      msg = {
        id,
        role: "system",
        kind: "todos",
        content: `${done}/${kept.length}`,
        steps: kept,
        status: "done",
        ts: Date.now(),
        turnId,
      };
      thread.messages.push(msg);
    }
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** F19 context-window reading → the thread's last-known telemetry.
   *  Turn-scoped at the callback, persisted on the thread so the meter
   *  survives turn end and restart. */
  private onUsage(
    threadId: string,
    turnId: string,
    u: { usedTokens: number; windowTokens?: number; sessionTotalTokens?: number },
  ): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!thread || !turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    const usedTokens = Math.max(0, Math.floor(u.usedTokens));
    const windowTokens =
      u.windowTokens !== undefined && u.windowTokens > 0
        ? Math.floor(u.windowTokens)
        : undefined;
    thread.contextUsage =
      windowTokens !== undefined ? { usedTokens, windowTokens } : { usedTokens };
    // F19: the session's cumulative counter → ledger deltas (frozen
    // TokenSpendTracker). A binding created this run counts from zero;
    // a loaded binding means the resumed session's first total is
    // inherited history — seeded, never charged. Local counters (mock
    // and other adapters) start at zero each run, so their first total
    // is genuinely new spend.
    if (u.sessionTotalTokens !== undefined && u.sessionTotalTokens >= 0) {
      const total = Math.floor(u.sessionTotalTokens);
      const rollout = thread.providerThread?.codexThreadId;
      const key = rollout ?? `thread:${threadId}`;
      let tracker = this.spendTrackers.get(key);
      if (!tracker) {
        tracker = new TokenSpendTracker();
        this.spendTrackers.set(key, tracker);
      }
      let delta = 0;
      if (!tracker.seeded) {
        if (rollout !== undefined && !this.freshSessionKeys.has(key))
          tracker.seedBaseline(total);
        else delta = tracker.spend(total);
      } else delta = tracker.spend(total);
      if (delta > 0) {
        if (rollout) this.tokenLedger.recordCodex(delta, rollout);
        else this.tokenLedger.record(delta);
      }
    }
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /** Trusted structured edit attribution → the live turn's ledger set.
   *  Stale/foreign-turn paths can never accumulate (P2L). */
  private onProviderFileChanges(threadId: string, turnId: string, paths: readonly string[]): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    const turn = thread?.turn;
    if (!turn || turn.id !== turnId) return;
    if (turn.status !== "running" && turn.status !== "waiting-approval") return;
    this.checkpoints?.recordEdits(turnId, paths);
  }

  /** Per-turn checkpoint records for one OWNED thread (IPC). */
  listCheckpoints(threadId: string) {
    this.mustThread(threadId);
    return this.checkpoints?.list(threadId) ?? [];
  }

  /** Non-mutating restore preview by ledger identity only (IPC). */
  previewCheckpoint(threadId: string, turnId: string) {
    this.mustThread(threadId);
    if (!this.checkpoints)
      return {
        kind: "unavailable" as const,
        baseCheckpointId: "",
        endCheckpointId: "",
        touchedPaths: [],
        entries: [],
        limitations: [],
        reason: "checkpoints-unavailable",
      };
    return this.checkpoints.preview(threadId, turnId);
  }

  /** Mutating undo by ledger identity — same ownership gates as preview. */
  restoreCheckpoint(threadId: string, turnId: string) {
    this.mustThread(threadId);
    if (!this.checkpoints)
      return { kind: "unavailable" as const, entries: [], reason: "checkpoints-unavailable" };
    return this.checkpoints.restore(threadId, turnId);
  }

  /** Per-turn file diff — read-only blob comparison (F10/A32). */
  checkpointDiff(threadId: string, turnId: string, path: string) {
    this.mustThread(threadId);
    if (!this.checkpoints)
      return { kind: "unavailable" as const, reason: "checkpoints-unavailable" };
    return this.checkpoints.diff(threadId, turnId, path);
  }

  /** Whole-thread change summary — first base→last end over the union
   *  of touched paths (frozen ThreadChangesTab / parsedDiff(selection:nil)). */
  threadChanges(threadId: string) {
    this.mustThread(threadId);
    if (!this.checkpoints) return null;
    return this.checkpoints.threadChangeSummary(threadId);
  }

  /** Whole-thread per-path diff — read-only, same scope as summary. */
  threadChangeDiff(threadId: string, path: string) {
    this.mustThread(threadId);
    if (!this.checkpoints)
      return { kind: "unavailable" as const, reason: "checkpoints-unavailable" };
    return this.checkpoints.threadDiff(threadId, path);
  }

  /** Non-fatal adapter note → one bounded system message in the thread. */
  /**
   * F31: provider-generated thread title (frozen TextGeneration.threadTitle
   * flow). Fire-and-forget after the first send: the prompt-derived fallback
   * shows immediately; a valid generated title replaces it only while the
   * thread still carries that fallback — a user rename is never clobbered.
   * Off setting, missing adapter support, and invalid output all keep the
   * fallback silently, as frozen does.
   */
  /** F13: commit-sheet "Write message" — frozen TextGeneration.commitMessage.
   *  The off setting and a missing adapter capability report the same
   *  honest unavailable; output is sanitized like frozen (fences stripped,
   *  empty rejected) and returned as a DRAFT — never auto-committed. */
  async commitMessageFor(summary: string, patch: string): Promise<GitCommitMessageResult> {
    if (this.store.state.settings.textGeneration === "off")
      return { kind: "unavailable", reason: "text-generation-off" };
    const gen = this.provider.generateCommitMessage?.bind(this.provider);
    if (!gen) return { kind: "unavailable", reason: "no-engine" };
    try {
      const raw = await gen(
        summary,
        patch,
        this.store.state.settings.commitInstructions ?? "",
      );
      const message = (raw ?? "").replace(/```/g, "").trim();
      if (!message) return { kind: "unavailable", reason: "generation-empty" };
      return { kind: "ok", message };
    } catch (e) {
      return { kind: "unavailable", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private maybeGenerateTitle(threadId: string, prompt: string): void {
    if (this.store.state.settings.textGeneration === "off") return;
    const gen = this.provider.generateTitle?.bind(this.provider);
    if (!gen) return;
    const atSend = this.store.state.threads.find((t) => t.id === threadId)?.title;
    void gen(prompt)
      .then((raw) => {
        const title = raw ? extractTitle(raw) : null;
        if (!title) return;
        const t = this.store.state.threads.find((x) => x.id === threadId);
        if (!t || t.title !== atSend || t.titleUserSet) return;
        t.title = title;
        t.titleReviewTurns = countUserTurns(t);
        t.updatedAt = Date.now();
        this.store.update(() => {});
        this.emit({ type: "thread-updated", thread: t });
      })
      .catch(() => {});
  }

  /**
   * v2.2.34 Settings › Text generation › Thread titles = "Keep updated":
   * every six completed turns the chat is looked at again — renamed when
   * the work has moved on, kept when it still fits. A user-set title
   * (titleUserSet) is never touched; the review marker advances on any
   * completed review so an unproductive look does not retry every turn.
   */
  private maybeReviewTitle(thread: ChatThread): void {
    if (this.store.state.settings.threadTitles !== "updated") return;
    if (thread.titleUserSet) return;
    const gen = this.provider.generateTitle?.bind(this.provider);
    if (!gen) return;
    const done = countUserTurns(thread);
    if (done - (thread.titleReviewTurns ?? 0) < 6) return;
    thread.titleReviewTurns = done;
    const context = thread.messages
      .filter((m) => m.role === "user")
      .slice(-4)
      .map((m) => m.content.slice(0, 400))
      .join("\n---\n");
    if (!context.trim()) return;
    const atReview = thread.title;
    void gen(context)
      .then((raw) => {
        const title = raw ? extractTitle(raw) : null;
        if (!title || title === atReview) return;
        const t = this.store.state.threads.find((x) => x.id === thread.id);
        if (!t || t.title !== atReview || t.titleUserSet) return;
        t.title = title;
        t.updatedAt = Date.now();
        this.store.update(() => {});
        this.emit({ type: "thread-updated", thread: t });
      })
      .catch(() => {});
  }

  private onProviderNotice(
    threadId: string,
    turnId: string,
    text: string,
    level?: "info" | "warning" | "error",
  ): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    if (!thread) return;
    // Frozen turnIDForNewRows = currentTurnID ?? closingTurnID: a notice
    // claims its turn only while the turn is live; one arriving after the
    // turn settled (e.g. thread/compacted) renders as a standalone row.
    const turn = thread.turn;
    const live =
      !!turn &&
      turn.id === turnId &&
      (turn.status === "running" || turn.status === "waiting-approval");
    this.appendNotice(thread, text, level ?? "info", live ? turn.id : undefined);
  }

  /**
   * Provider → engine: a thread-level notice outside any live turn (the
   * codex compacted event is the current caller). Standalone row — frozen
   * turnIDForNewRows is nil at idle, so nothing folds it under a dead turn.
   */
  onThreadNotice(
    threadId: string,
    text: string,
    level: "info" | "warning" | "error",
  ): void {
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    if (!thread) return;
    this.appendNotice(thread, text, level);
  }

  /** Append a structured notice row; `turnId` folds it into a live turn's
   *  steps, absent → a standalone thread-level row (frozen turnID nil). */
  private appendNotice(
    thread: ChatThread,
    text: string,
    level: "info" | "warning" | "error",
    turnId?: string,
  ): void {
    thread.messages.push({
      id: `codexnote-${turnId ?? "thread"}-${randomUUID()}`,
      role: "system",
      content: boundedText(text),
      status: "done",
      ts: Date.now(),
      ...(turnId !== undefined ? { turnId } : {}),
      kind: "notice",
      noticeLevel: level,
    });
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /**
   * F09: frozen ThreadRuntime.compact — the composer intercepted `/compact`
   * already; here the provider runs its own compaction. Busy threads are a
   * frozen silent no-op; an absent session is the frozen "Nothing to
   * compact yet."; any other failure lands as a warning notice.
   */
  async compactThread(threadId: string): Promise<void> {
    this.assertMutable();
    if (!this.provider.compact) return;
    const thread = this.mustThread(threadId);
    const turn = thread.turn;
    if (
      turn &&
      (turn.status === "running" || turn.status === "waiting-approval")
    )
      return;
    // Frozen handleLocalCommand records the use before dispatching.
    this.recordCommand("compact");
    this.appendNotice(thread, "Compacting context.", "info");
    try {
      await this.provider.compact(threadId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      this.appendNotice(
        thread,
        code === "CODEX_NOT_RUNNING"
          ? "Nothing to compact yet."
          : (err as Error).message || "Compact failed.",
        code === "CODEX_NOT_RUNNING" ? "info" : "warning",
      );
    }
  }

  /**
   * Persist a provider-side thread binding (Codex resume identity). The
   * adapter awaits this BEFORE turn/start so a restart can always resume.
   * Rejects when the thread is gone or the binding disagrees with the one
   * already persisted.
   */
  async bindProviderThread(threadId: string, binding: ProviderThreadBinding): Promise<void> {
    const thread = this.mustThread(threadId);
    const existing = thread.providerThread;
    if (existing) {
      if (existing.codexThreadId !== binding.codexThreadId)
        throw new EngineError(
          `provider thread already bound to ${existing.codexThreadId} — refusing rebind`,
        );
      return; // idempotent — same binding re-confirmed
    }
    thread.providerThread = binding;
    // F19: bound this run → its first cumulative reading counts as spend.
    this.freshSessionKeys.add(binding.codexThreadId);
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    try {
      this.store.flushNow();
    } catch (err) {
      // A binding that exists only in memory would masquerade as durable —
      // a restart could never resume it. Revert before surfacing.
      delete thread.providerThread;
      this.store.update(() => {});
      throw new EngineError(
        `provider-thread binding could not be persisted: ${(err as Error).message}`,
      );
    }
    this.emit({ type: "thread-updated", thread });
  }

  lookupProviderThread(threadId: string): ProviderThreadBinding | undefined {
    return this.store.state.threads.find((t) => t.id === threadId)?.providerThread;
  }

  private endTurn(thread: ChatThread, turn: Turn, status: Turn["status"]): void {
    turn.status = status;
    turn.endedAt = Date.now();
    this.turnLastEvent.delete(turn.id);
    turn.quietMinutes = undefined;
    const msg = thread.messages.find((m) => m.id === turn.assistantMessageId);
    if (msg && msg.status === "streaming") {
      msg.status =
        status === "done" ? "done"
        : status === "cancelled" ? "cancelled"
        : status === "denied" ? "denied"
        : status === "interrupted" ? "interrupted"
        : "error";
    }
    if (turn.approval && turn.approval.status === "pending" && status !== "waiting-approval") {
      turn.approval.status = "expired";
    }
    if (turn.question && turn.question.status === "pending") {
      turn.question.status = "expired";
    }
    if (turn.approval) this.inflightDecisions.delete(turn.approval.id);
    thread.updatedAt = Date.now();
    this.handles.delete(thread.id);
    this.toolItemsSeen.delete(turn.id);
    this.checkpoints?.turnEnded(thread.id, turn.id, status);
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
    this.emit({
      type: "turn-status",
      threadId: thread.id,
      turnId: turn.id,
      status,
      ...(turn.error ? { error: turn.error } : {}),
    });

    // F20: a failure that was the provider's usage limit may start an
    // auto-continue wait — while it waits the thread still counts as
    // working (frozen stillWorking), so the failure leaves NO unread
    // mark and fires no completion: it isn't a finished result.
    if (status === "done") this.maybeReviewTitle(thread);

    const waitingForLimit = this.limitFinished(thread, turn.id, status);

    // F28 frozen turnFinished — completion signals. `continues` = a
    // queued message picks up right away (a send-now fires on ANY end
    // status; the queue itself drains only after a completed turn whose
    // first bundle holds real text). `userStopped` = the user cancelled
    // or answered the turn away — both witnessed. A thread still working
    // (a successor or a limit wait) claims neither the chime nor a
    // notification.
    const pending = this.pendingSends.get(thread.id);
    const continues =
      pending !== undefined ||
      (status === "done" && this.nextBundleHasText(thread));
    const userStopped = status === "cancelled" || status === "denied";
    const stillWorking = continues || waitingForLimit;
    const chimed =
      this.store.state.settings.chimeWhenFinished !== false &&
      status !== "interrupted" &&
      !stillWorking &&
      !userStopped;
    const notifyKind =
      status === "done"
        ? ("done" as const)
        : status === "interrupted"
          ? ("stopped" as const)
          : status === "error"
            ? ("failed" as const)
            : null;
    const wantsNotify =
      notifyKind !== null &&
      this.store.state.settings.notifyOnDone === true &&
      !stillWorking &&
      !userStopped;
    this.emit({
      type: "finish-signal",
      threadId: thread.id,
      status,
      chime: chimed,
      notify: wantsNotify ? notifyKind : null,
      silent: chimed,
    });

    // F28: a finished/errored/interrupted result on a thread the user
    // is NOT looking at becomes an unread mark (frozen turnFinished).
    // "cancelled" is a user stop and "denied" is a user answer — both
    // were witnessed, never unread. A queued successor (pendingSend /
    // drain) does not suppress the mark: the result still happened.
    if (
      (status === "done" || status === "error" || status === "interrupted") &&
      !waitingForLimit &&
      this.store.state.ui.selectedThreadId !== thread.id
    ) {
      thread.hasUnread = true;
      thread.unreadStatus = status;
      this.store.update(() => {});
      this.emit({ type: "thread-updated", thread });
    }

    // F08: a pendingSend fires the moment the stop lands — ANY end status.
    // The queue itself drains only after a COMPLETED turn (frozen
    // drainFollowUps(after: .completed)); stopped/failed turns wait.
    if (pending !== undefined) {
      this.pendingSends.delete(thread.id);
      try {
        this.sendTurn(thread.id, pending);
      } catch (err) {
        // A send-now that cannot start must still be SEEN — a system
        // message on the thread, never a silent drop.
        thread.messages.push({
          id: `followup-${randomUUID()}`,
          role: "system",
          content: `Queued message could not be sent: ${(err as Error)?.message ?? String(err)}`,
          status: "done",
          ts: Date.now(),
        });
        this.store.update(() => {});
        this.emit({ type: "thread-updated", thread });
      }
    } else if (status === "done") {
      this.drainFollowUps(thread);
    }
    this.endTurnHydra(thread, turn, status);
    this.updateSleepGuard();
  }

  // ---- F22 Hydra runtime (frozen delegation slice, bounded) ---------
  //
  // Lead turns stream fenced ```hydra blocks; each closed entry spawns
  // a head — an ordinary thread flagged `hydraHead` running the same
  // provider in the lead's SHARED directory. A batch's reports flush
  // together once every head in it is back and the lead is idle
  // (frozen ThreadRuntime pendingReports parity).

  /** Delta path: ingest only the appended bytes. */
  private feedHydraAppend(thread: ChatThread, turn: Turn, appended: string): void {
    const key = `${thread.id}:${turn.id}`;
    let parser = this.hydraParsers.get(key);
    if (!parser) {
      parser = new HydraDelegationStreamParser();
      this.hydraParsers.set(key, parser);
    }
    parser.ingest(appended);
    this.dispatchNewDelegations(thread, key, parser);
  }

  /** Whole-text path: ingest only the new suffix; a rewritten
   *  composition gets a fresh parser (frozen completed/replaced rule) —
   *  the sent watermark still prevents double dispatch. */
  private feedHydraWhole(thread: ChatThread, turn: Turn, text: string): void {
    const key = `${thread.id}:${turn.id}`;
    const last = this.hydraTexts.get(key);
    let parser = this.hydraParsers.get(key);
    if (!parser || last === undefined || !text.startsWith(last)) {
      parser = new HydraDelegationStreamParser();
      this.hydraParsers.set(key, parser);
      parser.ingest(text);
    } else if (text.length > last.length) {
      parser.ingest(text.slice(last.length));
    }
    this.hydraTexts.set(key, text);
    this.dispatchNewDelegations(thread, key, parser);
  }

  private dispatchNewDelegations(
    thread: ChatThread,
    key: string,
    parser: HydraDelegationStreamParser,
  ): void {
    if (this.readOnly) return;
    const sent = this.hydraSent.get(key) ?? 0;
    const news = parser.delegations.slice(sent);
    if (!news.length) return;
    this.hydraSent.set(key, sent + news.length);
    // A ```hydra-sent block records heads that already went out —
    // advancing the watermark only (frozen parity).
    if (parser.isSentBlock) return;
    // Frozen HydraPrompts.maxDelegatedTasks: a block's entries are
    // bounded; overflow is refused, never dropped silently.
    const room = Math.max(0, MAX_DELEGATED_TASKS - sent);
    news.forEach((d, i) => {
      if (i >= room) {
        this.refuseDelegation(thread, `a delegation block holds at most ${MAX_DELEGATED_TASKS} tasks`);
        return;
      }
      this.dispatchDelegation(thread, d);
    });
  }

  /** A refused delegation is TOLD to the lead — a queued message the
   *  provider reads after this turn (frozen refusal-turn semantics via
   *  the existing follow-up queue); never a silent drop. */
  private refuseDelegation(lead: ChatThread, why: string): void {
    try {
      this.enqueueFollowUp(
        lead.id,
        `Hydra did not send the head you just asked for — ${why}. Do that part yourself and answer the user.`,
      );
    } catch {
      // A full queue must not break the lead's own turn.
    }
  }

  /** The pair-bound launch view for a lead (frozen AppModel.hydraLaunch,
   *  bounded): the stored pair applies only while it names this build's
   *  one provider; undefined while Hydra is off for app or chat. */
  private hydraLaunchFor(lead: ChatThread): ResolvedHydraLaunch | undefined {
    const s = this.store.state.settings;
    if (s.hydraEnabled === false || lead.hydraEnabled === false) return undefined;
    const mode = this.provider.descriptor.mode;
    const pair = hydraPairForLead(lead.hydraPairId, s.hydraPairs ?? [], mode);
    return resolveHydraLaunch(
      pair,
      s.hydraMaxHeads ?? undefined,
      mode,
      (id) => (id === mode ? this.provider.descriptor.label : id),
      s.hydraIsolateHeads !== false,
    );
  }

  /** The lead's team as the frozen teamStatus line, or undefined. */
  private hydraTeamLine(leadId: string): string | undefined {
    const heads = this.store.state.threads
      .filter((t) => t.hydraHead?.leadId === leadId)
      .map((t) => {
        const h = t.hydraHead!;
        return {
          name: h.name,
          status: h.status,
          startedAt: h.spawnedAt,
          landing: h.landing,
          copyPath: h.copyKept ? t.worktreeDir : undefined,
        };
      });
    return hydraTeamStatus(heads);
  }

  /** What rides the front of a lead's turn (frozen fallbackPreamble /
   *  fallbackReportPreamble + delegationRequest for user turns). Heads
   *  and Hydra-off chats get nothing; slash commands carry no guidance. */
  private hydraWirePrefix(lead: ChatThread, isReport: boolean): string {
    if (lead.hydraHead) return "";
    const launch = this.hydraLaunchFor(lead);
    if (!launch) return "";
    const project = this.store.state.projects.find((p) => p.id === lead.projectId);
    const policy = hydraLeadPolicy({
      maxHeads: launch.maxHeads,
      profiles: launch.headProfiles,
      projects: this.store.state.projects
        .filter((p) => p.id !== lead.projectId && p.directory)
        .map((p) => ({ name: p.name, path: p.directory! })),
      ownProjectName: project?.name,
      isolated: launch.isolatesHeads,
      providerLabel: (id) =>
        id === this.provider.descriptor.mode
          ? this.provider.descriptor.label
          : id,
    });
    const team = this.hydraTeamLine(lead.id);
    if (isReport) {
      const canDelegate =
        (this.hydraRounds.get(lead.id) ?? 0) < MAX_DELEGATION_ROUNDS;
      return policy + "\n\n" + hydraReportNote(team, canDelegate);
    }
    return (
      hydraDelegationRequest() +
      policy +
      "\n\n" +
      (hydraTurnNote(team) || "---\n\n")
    );
  }

  /** Delegations waiting for room under the launch cap (frozen
   *  hydraWaiting) — paced out by spawnWaitingHeads, never refused for
   *  fullness alone. Runtime-only like the frozen queue. */
  private readonly hydraWaiting = new Map<
    string,
    { d: HydraDelegation; batchId: string; queuedAt: number }[]
  >();
  /** Pairs whose heads-provider note this lead already heard once per
   *  job (frozen hydraFallbackNoted, per lead+pair). */
  private readonly hydraFallbackNoted = new Set<string>();
  /** Frozen HydraTreeCache: heads of one delegation block share ONE
   *  capture of the same checkout — keyed batchId:checkout, dropped when
   *  the batch's reports flush. */
  private readonly hydraCaptures = new Map<
    string,
    Promise<
      | { kind: "captured"; tree: string; commit: string }
      | { kind: "unavailable"; reason: string }
    >
  >();
  /** Frozen hydraLanding queue — landings into one lead's checkout
   *  serialize, so two returning heads never merge onto each other. */
  private readonly hydraLandings = new Map<string, Promise<void>>();

  /** Frozen spawnWaitingHeads: send out queued delegations as far as the
   *  launch's cap has room — after every spawn and every head finish. */
  private spawnWaitingHeads(leadId: string): void {
    const lead = this.store.state.threads.find((t) => t.id === leadId);
    if (!lead || lead.hydraHead || this.readOnly) return;
    const queue = this.hydraWaiting.get(leadId);
    if (!queue?.length) return;
    const launch = this.hydraLaunchFor(lead);
    if (!launch) return;
    while (queue.length) {
      const running = this.store.state.threads.filter(
        (t) => t.hydraHead?.leadId === leadId && t.hydraHead.status === "running",
      ).length;
      const cap = launch.maxHeads ?? HYDRA_UNCAPPED_CONCURRENCY;
      if (running >= cap) break;
      const next = queue.shift()!;
      this.spawnHydraHead(lead, next.d, next.batchId);
    }
    if (!queue.length) this.hydraWaiting.delete(leadId);
  }

  private dispatchDelegation(lead: ChatThread, d: HydraDelegation): void {
    // Heads never delegate — tell the head plainly via its own queue.
    if (lead.hydraHead) return this.refuseDelegation(lead, "heads cannot delegate");
    const s = this.store.state.settings;
    if (s.hydraEnabled === false)
      return this.refuseDelegation(lead, "Hydra is off");
    if (lead.hydraEnabled === false)
      return this.refuseDelegation(lead, "this chat has Hydra off");
    // Frozen maxDelegationRounds: one round per lead TURN that actually
    // dispatches heads (bounded slice — per-turn, stricter than the
    // frozen per-block accounting).
    const leadTurn = lead.turn;
    const roundKey = leadTurn ? `${lead.id}:${leadTurn.id}` : null;
    if (roundKey && !this.hydraRounds.has(roundKey)) {
      const rounds = this.hydraRounds.get(lead.id) ?? 0;
      if (rounds >= MAX_DELEGATION_ROUNDS) {
        return this.refuseDelegation(
          lead,
          `this request used all ${MAX_DELEGATION_ROUNDS} of its rounds of heads`,
        );
      }
      this.hydraRounds.set(lead.id, rounds + 1);
      this.hydraRounds.set(roundKey, 1);
    }
    const team = this.store.state.threads.filter(
      (t) => t.hydraHead?.leadId === lead.id,
    );
    const running = team.filter((t) => t.hydraHead?.status === "running").length;
    const launch = this.hydraLaunchFor(lead);
    const cap = launch?.maxHeads ?? HYDRA_UNCAPPED_CONCURRENCY;
    const batchId = leadTurn?.id ?? "batch";
    // The pair's cap paces the rest through hydraWaiting (frozen
    // parity): over-cap entries wait for room, they are never refused.
    if (running >= cap) {
      const queue = this.hydraWaiting.get(lead.id) ?? [];
      queue.push({ d, batchId, queuedAt: Date.now() });
      this.hydraWaiting.set(lead.id, queue);
      return;
    }
    this.spawnHydraHead(lead, d, batchId, launch);
  }

  /** Actually send one head out (frozen spawnTivanoHead, bounded):
   *  roster name, optional profile routing, the pair's worker
   *  model/effort when it keeps them, the heads-provider fallback note
   *  once per job. */
  private spawnHydraHead(
    lead: ChatThread,
    d: HydraDelegation,
    batchId: string,
    launch?: ResolvedHydraLaunch | undefined,
  ): void {
    const s = this.store.state.settings;
    launch = launch ?? this.hydraLaunchFor(lead);
    const mode = this.provider.descriptor.mode;
    const pair = hydraPairForLead(lead.hydraPairId, s.hydraPairs ?? [], mode);
    // A pair that names a heads-provider this build cannot run: the
    // heads stay on the lead's and the lead hears it once per job.
    if (pair && launch?.headsFallbackNote) {
      const noteKey = `${lead.id}:${pair.id}`;
      if (!this.hydraFallbackNoted.has(noteKey)) {
        this.hydraFallbackNoted.add(noteKey);
        this.appendNotice(
          lead,
          `Hydra: ${launch.headsFallbackNote}`,
          "info",
        );
      }
    }
    // A delegation routed to one of the pair's head profiles runs on that
    // profile's model and effort — but only when the profile stays on
    // this build's provider; a foreign-provider profile falls back to
    // the shared fields like an unrouted one.
    const routed = d.profile
      ? launch?.headProfiles.find(
          (p) =>
            headProfileMatches(p, d.profile!) &&
            (p.provider === undefined || p.provider === mode),
        )
      : undefined;

    const team = this.store.state.threads.filter(
      (t) => t.hydraHead?.leadId === lead.id,
    );
    // Frozen roster: a named persona keeps its rounds; a name already
    // worn by a WORKING head bumps to the next round (Otto → Otto 2).
    const worn = new Set(
      team
        .filter((t) => t.hydraHead!.status === "running")
        .map((t) => t.hydraHead!.name),
    );
    let persona: HydraPersona;
    let headIndex: number;
    if (d.name && personaIndex(d.name) !== undefined) {
      headIndex = personaIndex(d.name)!;
      while (worn.has(personaAt(headIndex).name)) headIndex += HYDRA_PERSONAS.length;
      persona = personaAt(headIndex);
    } else if (d.name && personaNamed(d.name)) {
      persona = personaNamed(d.name)!;
      headIndex = personaIndex(persona.name) ?? 0;
      while (worn.has(personaAt(headIndex).name)) headIndex += HYDRA_PERSONAS.length;
      persona = personaAt(headIndex);
    } else {
      headIndex = lead.hydraSpawnCount ?? 0;
      while (worn.has(personaAt(headIndex).name)) headIndex += 1;
      persona = personaAt(headIndex);
    }

    const head = this.insertHeadThread(lead, d, persona, headIndex, batchId);
    if (!head) return this.refuseDelegation(lead, "the thread store is full");
    if (routed) {
      head.hydraHead!.profile = routed.name;
      head.title += ` · ${routed.name}`;
    }
    // The head's model/effort (frozen): routed profile's, else the pair's
    // worker fields when it keeps them, else the chat's own. Codex-only
    // fields — adapters without per-thread models ignore them.
    const headModel = routed?.model ?? launch?.workerModel ?? lead.codexModel;
    const headEffort = routed?.effort ?? launch?.workerEffort ?? lead.codexEffort;
    if (headModel) head.codexModel = headModel;
    if (headEffort) head.codexEffort = headEffort;
    // F22 isolation (frozen makeHydraCopy): with copies on and a copyable
    // checkout the head gets its own detached worktree first and runs
    // there; a checkout that cannot be copied honestly keeps the shared
    // one — the head's record shows which it was.
    const copySource = this.hydraCopySource(lead, head);
    if (launch?.isolatesHeads && copySource && this.worktrees) {
      void this.prepareIsolatedHead(head.id, lead, d, persona, copySource, batchId);
      return;
    }
    const dir = this.threadDirectory(head.id);
    try {
      this.sendTurn(head.id, delegatedHeadPrompt(persona, d, dir ?? "(no project checkout)"), {
        authored: false,
        hydraBrief: true,
      });
    } catch (err) {
      head.hydraHead!.status = "failed";
      head.hydraHead!.finishedAt = Date.now();
      head.hydraHead!.summary = `The head could not start: ${(err as Error)?.message ?? String(err)}`;
      this.queueHydraReport(head);
      this.store.update(() => {});
      this.emit({ type: "thread-updated", thread: head });
      return;
    }
    this.armHydraWatchdog(head);
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread: head });
  }

  /** A head is a real thread — inserted WITHOUT stealing selection
   *  (the sidebar filters `hydraHead`; the Hydra panel opens them). */
  private insertHeadThread(
    lead: ChatThread,
    d: HydraDelegation,
    persona: HydraPersona,
    headIndex: number,
    batchId: string,
  ): ChatThread | null {
    const projectId = d.project
      ? (this.store.state.projects.find(
          (p) => p.name.toLowerCase() === d.project!.toLowerCase(),
        )?.id ?? lead.projectId)
      : lead.projectId;
    const head: ChatThread = {
      id: randomUUID(),
      projectId,
      title: d.task.slice(0, 60) || `Hydra head ${persona.name}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      turn: null,
      // F06/F21: a head runs on the lead's own provider, model and
      // permission lane — inherit its runtime mode rather than the
      // global default (frozen heads share the chat's lane).
      runtimeMode: lead.runtimeMode ?? this.store.state.settings.defaultRuntimeMode ?? "fullAccess",
      sessionGrants: [],
      hydraEnabled: false,
      hydraHead: {
        leadId: lead.id,
        headIndex,
        name: persona.name,
        task: d.task,
        batchId,
        status: "running",
        spawnedAt: Date.now(),
      },
    };
    this.store.update((doc) => {
      doc.threads.push(head);
      lead.hydraSpawnCount = (lead.hydraSpawnCount ?? 0) + 1;
      lead.updatedAt = Date.now();
    });
    this.emit({ type: "thread-added", thread: head });
    this.emit({ type: "thread-updated", thread: lead });
    return head;
  }

  /** The checkout a head's copy is made OF (frozen): a head kept in the
   *  lead's project copies the lead's own worktree when it has one;
   *  a head sent to another project copies that project's directory.
   *  undefined = no live directory to copy. */
  private hydraCopySource(lead: ChatThread, head: ChatThread): string | undefined {
    if (head.projectId === lead.projectId && lead.worktreeDir)
      return this.paths?.dirLive(lead.worktreeDir) ? lead.worktreeDir : undefined;
    const project = this.store.state.projects.find((p) => p.id === head.projectId);
    if (!project?.directory) return undefined;
    return this.paths?.dirLive(project.directory) ? project.directory : undefined;
  }

  /** Frozen makeHydraCopy's bind half: capture the checkout once per
   *  captureKey, give the head a detached worktree of it. Shared by the
   *  spawn path (one key per delegation block) and a re-steer (one key
   *  per new turn). Every failure honestly leaves the head to the
   *  shared checkout. */
  private async bindIsolatedCopy(
    headId: string,
    source: string,
    captureKey: string,
  ): Promise<void> {
    const head = this.store.state.threads.find((t) => t.id === headId);
    if (!head?.hydraHead || head.hydraHead.status !== "running" || !head.projectId)
      return;
    let captureP = this.hydraCaptures.get(captureKey);
    if (!captureP) {
      captureP = this.worktrees!.hydraCapture(head.projectId, source);
      this.hydraCaptures.set(captureKey, captureP);
    }
    const capture = await captureP.catch(() => null);
    const cur = this.store.state.threads.find((t) => t.id === headId);
    if (!cur?.hydraHead || cur.hydraHead.status !== "running" || !cur.projectId)
      return;
    if (capture?.kind !== "captured") return;
    const slug =
      cur.hydraHead.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "head";
    const added = await this.worktrees!.hydraCopyAdd(
      cur.projectId,
      slug,
      capture.commit,
    );
    if (added.kind !== "created") return;
    // A head stopped while its copy was being made: the copy belongs
    // to nobody — remove it instead of orphaning it on disk.
    if (cur.hydraHead.status !== "running") {
      void this.worktrees!.hydraCopyRemove(cur.projectId, added.directory).catch(
        () => {},
      );
      return;
    }
    cur.worktreeDir = added.directory;
    cur.hydraHead.baseTree = capture.tree;
    cur.hydraHead.landingCheckout = source;
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread: cur });
  }

  /** Frozen makeHydraCopy: capture the checkout once per delegation
   *  block, give the head a detached worktree of it, then brief it.
   *  Every failure honestly falls back to the shared checkout. */
  private async prepareIsolatedHead(
    headId: string,
    lead: ChatThread,
    d: HydraDelegation,
    persona: HydraPersona,
    source: string,
    batchId: string,
  ): Promise<void> {
    await this.bindIsolatedCopy(headId, source, `${lead.id}:${batchId}:${source}`);
    const cur = this.store.state.threads.find((t) => t.id === headId);
    if (!cur?.hydraHead || cur.hydraHead.status !== "running") return;
    const dir = this.threadDirectory(cur.id);
    const brief = delegatedHeadPrompt(persona, d, dir ?? "(no project checkout)");
    try {
      this.sendTurn(cur.id, brief, {
        authored: false,
        hydraBrief: true,
      });
    } catch (err) {
      // 2.2.12 parity: a head already turning (its row was messaged while
      // the copy bound) keeps its brief queued at the front until that
      // turn ends — being busy is not a start failure.
      const busy =
        cur.turn &&
        (cur.turn.status === "running" || cur.turn.status === "waiting-approval");
      if (busy && (cur.followUps?.length ?? 0) < Engine.FOLLOWUP_MAX) {
        this.store.update(() => {
          this.queueOf(cur).unshift({
            id: randomUUID(),
            text: brief,
            createdAt: Date.now(),
          });
          cur.updatedAt = Date.now();
        });
        this.emitQueue(cur);
        this.armHydraWatchdog(cur);
        this.emit({ type: "thread-updated", thread: cur });
        return;
      }
      cur.hydraHead!.status = "failed";
      cur.hydraHead!.finishedAt = Date.now();
      cur.hydraHead!.summary = `The head could not start: ${(err as Error)?.message ?? String(err)}`;
      this.queueHydraReport(cur);
      this.store.update(() => {});
      this.emit({ type: "thread-updated", thread: cur });
      return;
    }
    this.armHydraWatchdog(cur);
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread: cur });
  }

  /** Frozen applyHydraHead, serialized per lead: diff the copy's work
   *  against its base tree, apply it three-way into the landing
   *  checkout, then release the copy. The report queues only after the
   *  landing resolved — landingPending keeps the batch open. */
  private landHydraHead(headId: string): void {
    const head = this.store.state.threads.find((t) => t.id === headId);
    const leadId = head?.hydraHead?.leadId;
    if (!head?.hydraHead || !leadId) return;
    const prev = this.hydraLandings.get(leadId) ?? Promise.resolve();
    const run = prev.then(() => this.doLandHead(headId));
    this.hydraLandings.set(leadId, run);
    void run;
  }

  private async doLandHead(headId: string): Promise<void> {
    const head = this.store.state.threads.find((t) => t.id === headId);
    const info = head?.hydraHead;
    if (!head || !info || info.landingPending !== true) return;
    const finish = () => this.finishHydraLanding(headId);
    if (!info.baseTree || !info.landingCheckout || !head.projectId || !this.worktrees) {
      return finish();
    }
    const copy = head.worktreeDir;
    const name = info.name;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "head";
    let landing: NonNullable<typeof info.landing> | undefined;
    if (copy) {
      const end = await this.worktrees
        .hydraEndTree(head.projectId, copy, info.baseTree)
        .catch(() => null);
      if (end?.kind === "ok") {
        const res = await this.worktrees
          .hydraLand(
            head.projectId,
            info.landingCheckout,
            slug,
            headId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "head",
            info.baseTree,
            end.tree,
          )
          .catch((e) => ({ kind: "unavailable" as const, reason: String(e) }));
        if (res.kind === "landed") {
          landing = { files: res.files, conflicts: res.conflicts };
        } else if (res.kind === "patch") {
          landing = {
            files: res.files,
            conflicts: [],
            ...(res.patchPath !== undefined ? { patchPath: res.patchPath } : {}),
            error: res.error,
          };
        } else {
          landing = { files: [], conflicts: [], error: res.reason };
        }
      } else {
        landing = {
          files: [],
          conflicts: [],
          error:
            end?.kind === "unavailable"
              ? end.reason
              : "the copy's state could not be read",
        };
      }
      // The work is preserved only when it landed, changed nothing, or
      // was kept as a patch — then the copy can go (frozen release).
      const preserved =
        landing !== undefined &&
        (landing.files.length === 0 ||
          landing.patchPath !== undefined ||
          landing.error === undefined);
      if (preserved) {
        const removed = await this.worktrees
          .hydraCopyRemove(head.projectId, copy)
          .catch(() => null);
        if (removed?.kind === "removed") {
          head.worktreeDir = undefined;
          info.baseTree = undefined;
          info.landingCheckout = undefined;
          info.copyKept = false;
        } else {
          info.copyKept = true;
        }
      } else {
        info.copyKept = true;
      }
    } else {
      info.copyKept = false;
      landing = {
        files: [],
        conflicts: [],
        error: "the copy was gone before its work could land",
      };
    }
    info.landing = landing;
    // Frozen noteHydraLanding: a non-clean landing reaches the lead's
    // timeline — conflicts and kept patches are otherwise invisible.
    const lead = this.store.state.threads.find((t) => t.id === info.leadId);
    if (lead) {
      if (landing.conflicts.length) {
        const files = landing.conflicts.map((f) => `\`${f}\``).join(", ");
        this.appendNotice(
          lead,
          `${name}'s work landed; the lead is settling a conflict in ${landing.conflicts.length === 1 ? "1 file" : `${landing.conflicts.length} files`}.\n${files}\n\nThe checkout had moved on where ${name} was working, so the merge was three-way and left markers in ${landing.conflicts.length === 1 ? "this file" : "these files"}. The lead resolves them before the work goes out; nothing to do on your side.`,
          "info",
        );
      }
      if (landing.patchPath) {
        const files = landing.files.map((f) => `\`${f.path}\``).join(", ");
        this.appendNotice(
          lead,
          `${name}'s work did not land and was kept as a patch.\n${files}\n\n${landing.error ? `Why it did not land: ${landing.error}.\n\n` : ""}Apply it with \`git apply --3way ${landing.patchPath}\` and settle what conflicts.`,
          "info",
        );
      }
    }
    finish();
  }

  /** Landing resolved (or skipped): queue the report, open the cap,
   *  flush — the frozen finish tail landings defer until this point. */
  private finishHydraLanding(headId: string): void {
    const head = this.store.state.threads.find((t) => t.id === headId);
    if (!head?.hydraHead) return;
    head.hydraHead.landingPending = undefined;
    // Frozen: a head steered on while its landing ran is at work again,
    // not finished — its report comes when that new turn ends. The
    // landing itself stands: `info.landing` already records where the
    // turn's work went.
    if (
      head.turn &&
      (head.turn.status === "running" || head.turn.status === "waiting-approval")
    ) {
      this.store.update(() => {});
      this.emit({ type: "thread-updated", thread: head });
      return;
    }
    this.queueHydraReport(head);
    this.spawnWaitingHeads(head.hydraHead.leadId);
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread: head });
    this.flushHydraReports(head.hydraHead.leadId);
  }

  /** Frozen HydraWatchdog: a head that outlives its budget is
   *  interrupted with the stalled note attached to its report. */
  private armHydraWatchdog(head: ChatThread): void {
    const ms =
      Number(process.env.TIVANO_HYDRA_HEAD_BUDGET_MS) ||
      HYDRA_BUDGET.maxSeconds * 1000;
    const existing = this.hydraWatchdogs.get(head.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.hydraWatchdogs.delete(head.id);
      const cur = this.store.state.threads.find((t) => t.id === head.id);
      if (!cur?.hydraHead || cur.hydraHead.status !== "running") return;
      cur.hydraHead.stalledNote = STALLED_NOTE;
      const turn = cur.turn;
      if (turn && (turn.status === "running" || turn.status === "waiting-approval")) {
        this.interruptTurn(cur.id, turn.id);
      } else {
        this.finishHydraHead(cur, "interrupted");
        this.flushHydraReports(cur.hydraHead!.leadId);
      }
    }, ms);
    timer.unref?.();
    this.hydraWatchdogs.set(head.id, timer);
  }

  /** A head turn's end becomes its report — queued for the lead until
   *  the whole batch is back and the lead is idle. */
  private finishHydraHead(head: ChatThread, status: Turn["status"]): void {
    const info = head.hydraHead;
    if (!info || info.status !== "running") return;
    const outcome =
      status === "done"
        ? "completed"
        : status === "cancelled" || status === "interrupted"
          ? "stopped"
          : "failed";
    const lastAssistant = [...head.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.trim());
    let summary = lastAssistant?.content.trim() ?? "";
    if (outcome === "failed") {
      summary = `The turn failed.${summary ? ` Partial output:\n${summary}` : ""}`;
    }
    if (info.stalledNote) summary = `${info.stalledNote}\n\n${summary}`.trim();
    info.status = outcome;
    info.summary = summary;
    info.toolCalls = head.messages.filter(
      (m) => m.kind === "tool" && m.turnId === head.turn?.id,
    ).length;
    info.finishedAt = Date.now();
    info.elapsedMs = head.turn ? info.finishedAt - head.turn.startedAt : undefined;
    // F22 isolation: a COMPLETED head with its own copy lands its diff
    // BEFORE its report queues (frozen — the report names where the
    // work went). landingPending holds the batch open until the
    // landing resolves. A stopped or failed head does NOT land: its
    // half-done edits stay in the copy, which the report names via
    // copyPath — the copy leaves when the head is steered on or
    // cleared, never mid-work (frozen releaseHydraCopy on completed).
    if (info.baseTree !== undefined && head.worktreeDir !== undefined) {
      if (outcome === "completed") {
        info.landingPending = true;
        this.landHydraHead(head.id);
      } else {
        info.copyKept = true;
        this.queueHydraReport(head);
        this.spawnWaitingHeads(info.leadId);
      }
      this.store.update(() => {});
      this.emit({ type: "thread-updated", thread: head });
      return;
    }
    this.queueHydraReport(head);
    // A finished head makes room: delegations waiting on the cap go out
    // first, then the batch settles and the report flushes (frozen order).
    this.spawnWaitingHeads(info.leadId);
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread: head });
  }

  private queueHydraReport(head: ChatThread): void {
    const info = head.hydraHead;
    if (!info) return;
    const reports = this.hydraPendingReports.get(info.leadId) ?? [];
    reports.push({
      headIndex: info.headIndex,
      task: info.task,
      status: info.status === "running" ? "stopped" : info.status,
      text: info.summary ?? "",
      batchId: info.batchId,
      elapsedMs: info.elapsedMs,
      toolCalls: info.toolCalls,
      ...(info.landing !== undefined ? { landing: info.landing } : {}),
      ...(info.copyKept === true && head.worktreeDir !== undefined
        ? { copyPath: head.worktreeDir }
        : {}),
    });
    this.hydraPendingReports.set(info.leadId, reports);
  }

  /** Frozen pendingReports: a batch's reports flush together once every
   *  head in the batch is back AND the lead is idle. Reports whose
   *  batch still has running heads keep waiting; unrelated batches
   *  don't block each other. */
  private flushHydraReports(leadId: string): void {
    const lead = this.store.state.threads.find((t) => t.id === leadId);
    if (!lead || lead.hydraHead) return;
    const pending = this.hydraPendingReports.get(leadId);
    if (!pending?.length) return;
    const leadTurn = lead.turn;
    if (
      (leadTurn && (leadTurn.status === "running" || leadTurn.status === "waiting-approval")) ||
      this.pendingSends.has(leadId)
    ) {
      return;
    }
    const runningBatches = new Set(
      this.store.state.threads
        .filter(
          (t) =>
            t.hydraHead?.leadId === leadId &&
            (t.hydraHead.status === "running" || t.hydraHead.landingPending === true),
        )
        .map((t) => t.hydraHead!.batchId),
    );
    for (const w of this.hydraWaiting.get(leadId) ?? [])
      runningBatches.add(w.batchId);
    const flushable = pending.filter((r) => !runningBatches.has(r.batchId ?? ""));
    if (!flushable.length) return;
    this.hydraPendingReports.set(
      leadId,
      pending.filter((r) => runningBatches.has(r.batchId ?? "")),
    );
    const stillWorking = this.store.state.threads
      .filter((t) => t.hydraHead?.leadId === leadId && t.hydraHead.status === "running")
      .map((t) => t.hydraHead!.name);
    // Frozen HydraTreeCache lifetime: a batch's captures die with its
    // reports — the next block captures the checkout afresh.
    for (const r of flushable) {
      for (const k of [...this.hydraCaptures.keys()])
        if (k.startsWith(`${leadId}:${r.batchId}:`)) this.hydraCaptures.delete(k);
    }
    try {
      this.sendTurn(leadId, reportMessage(flushable, stillWorking), {
        authored: false,
        hydraReport: flushable.map((r) => r.headIndex),
      });
    } catch {
      // Busy/closed raced — reports go back pending; the next endTurn
      // retries the flush.
      this.hydraPendingReports.set(leadId, [
        ...(this.hydraPendingReports.get(leadId) ?? []),
        ...flushable,
      ]);
    }
  }

  /** User stop on a head (frozen Stop) — routed through the normal
   *  cancel path so the report honestly reads "stopped by the user". */
  stopHydraHead(threadId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!thread.hydraHead) throw new EngineError("not a hydra head");
    if (thread.hydraHead.status !== "running") return;
    const w = this.hydraWatchdogs.get(threadId);
    if (w) clearTimeout(w);
    this.hydraWatchdogs.delete(threadId);
    const turn = thread.turn;
    if (turn && (turn.status === "running" || turn.status === "waiting-approval")) {
      this.checkpoints?.turnCancelled(threadId, turn.id);
      this.handles.get(threadId)?.cancel();
      this.handles.delete(threadId);
      this.endTurn(thread, turn, "cancelled");
    } else {
      this.finishHydraHead(thread, "cancelled");
      this.flushHydraReports(thread.hydraHead.leadId);
    }
  }

  /** Turn-end bookkeeping: head → report path; lead → dropped-block
   *  rewrite + a flush now that it is idle. */
  private endTurnHydra(thread: ChatThread, turn: Turn, status: Turn["status"]): void {
    const key = `${thread.id}:${turn.id}`;
    const sent = this.hydraSent.get(key) ?? 0;
    this.hydraParsers.delete(key);
    this.hydraSent.delete(key);
    this.hydraTexts.delete(key);
    if (thread.hydraHead) {
      const w = this.hydraWatchdogs.get(thread.id);
      if (w) clearTimeout(w);
      this.hydraWatchdogs.delete(thread.id);
      this.finishHydraHead(thread, status);
      this.flushHydraReports(thread.hydraHead.leadId);
      return;
    }
    // Frozen drop-block rule: a lead turn that dispatched heads but did
    // NOT complete leaves a partial fenced block — rewrite it so the
    // text never claims the rest of the block went out.
    if (sent > 0 && status === "done") {
      const msg = thread.messages.find((m) => m.id === turn.assistantMessageId);
      if (msg) {
        const marked = markingDelegationBlockSent(msg.content);
        if (marked !== msg.content) {
          msg.content = marked;
          this.store.update(() => {});
          this.emit({ type: "thread-updated", thread });
        }
      }
    }
    if (sent > 0 && status !== "done") {
      const msg = thread.messages.find((m) => m.id === turn.assistantMessageId);
      if (msg) {
        const stripped = withoutDelegationBlock(msg.content);
        const note = `Hydra sent ${sent === 1 ? "one head" : `${sent} heads`} before the turn ${status === "interrupted" || status === "cancelled" ? "was stopped" : "failed"}; the rest of the block never went out.`;
        msg.content = stripped ? `${stripped}\n\n*${note}*` : `*${note}*`;
        this.store.update(() => {});
        this.emit({ type: "thread-updated", thread });
      }
    }
    this.flushHydraReports(thread.id);
  }

  // ---- F20 usage-limit auto-continue (frozen AutoContinue port) --------

  /** The provider said its usage limit is spent (frozen noteLimit: a
   *  later note with a time beats an earlier one without). */
  private noteLimit(threadId: string, resetsAt: number | null): void {
    const existing = this.limitNoted.get(threadId);
    if (existing !== undefined && existing !== null && resetsAt === null) return;
    this.limitNoted.set(threadId, resetsAt);
  }

  /**
   * A turn ended. Consumes a noted limit; with the setting on and the
   * turn failed, a wait is set for the reset (or, when the provider
   * never named a time, the honest "send a message" warning). Returns
   * whether the thread now waits — a waiting thread still counts as
   * working (frozen stillWorking): no unread mark, no completion chime.
   */
  private limitFinished(
    thread: ChatThread,
    turnId: string,
    status: Turn["status"],
  ): boolean {
    const note = this.limitNoted.get(thread.id);
    if (note === undefined) return false;
    this.limitNoted.delete(thread.id);
    if (status !== "error" || !this.store.state.settings.autoContinueAfterLimit)
      return false;
    this.clearLimitWait(thread.id);
    const now = Date.now();
    const resumeAt =
      note !== null ? limitSchedule(note, now, this.limitMarginMs) : null;
    if (resumeAt === null) {
      this.pushSystemNote(
        thread,
        "⚠ Usage limit reached, and the provider did not say when it resets. Send a message to continue.",
      );
      return true;
    }
    const token = randomUUID();
    this.limitResumes.set(thread.id, resumeAt);
    this.limitWaits.set(thread.id, {
      token,
      model: thread.codexModel,
      timer: setTimeout(
        () => this.limitWaitFired(thread.id, turnId, token),
        resumeAt - now,
      ),
    });
    this.pushSystemNote(
      thread,
      `Usage limit reached. Continuing automatically at ${limitFormatReset(resumeAt)}.`,
    );
    this.emit({ type: "limit-wait", threadId: thread.id, resumeAt });
    this.updateSleepGuard();
    return true;
  }

  /** The wait elapsed: re-verify everything still holds, then queue and
   *  send the continue message (frozen wait→enqueueFollowUp→sendNow). A
   *  user who picked the chat up meanwhile leaves nothing to continue. */
  private limitWaitFired(threadId: string, turnId: string, token: string): void {
    const wait = this.limitWaits.get(threadId);
    if (!wait || wait.token !== token) return;
    this.limitWaits.delete(threadId);
    this.limitResumes.delete(threadId);
    this.emit({ type: "limit-wait-ended", threadId });
    this.updateSleepGuard();
    const thread = this.store.state.threads.find((t) => t.id === threadId);
    if (!thread) return;
    if (!this.store.state.settings.autoContinueAfterLimit) return;
    if (thread.turn?.id !== turnId || this.threadBusy(thread)) return;
    // 2.2.12 parity (frozen AutoContinue.applies): the wait was armed
    // against this model's limit — a model change ends it, nothing sends.
    if (thread.codexModel !== wait.model) return;
    try {
      this.enqueueFollowUp(threadId, Engine.LIMIT_CONTINUE_MESSAGE);
      const items = this.queueOf(thread);
      const item = [...items]
        .reverse()
        .find((i) => i.text === Engine.LIMIT_CONTINUE_MESSAGE);
      if (item) this.sendFollowUpNow(threadId, item.id);
    } catch (err) {
      this.pushSystemNote(
        thread,
        `⚠ Automatic continue failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  private clearLimitWait(threadId: string): void {
    const wait = this.limitWaits.get(threadId);
    if (wait) {
      clearTimeout(wait.timer);
      this.limitWaits.delete(threadId);
    }
    if (this.limitResumes.delete(threadId))
      this.emit({ type: "limit-wait-ended", threadId });
    this.updateSleepGuard();
  }

  /** IPC: cancel the wait — the thread will not continue on its own. */
  cancelLimitWait(threadId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!this.limitWaits.has(threadId))
      throw new EngineError("no usage-limit wait on this thread");
    this.clearLimitWait(threadId);
    this.pushSystemNote(
      thread,
      "Limit wait cancelled — the thread will not continue on its own.",
    );
  }

  /**
   * IPC: end the wait and hand the stopped turn to a NEW chat of the
   * same project (frozen handOff). Returns the new thread id and the
   * hand-off text — the renderer places it in the composer draft so the
   * USER picks the model and sends it, never an automatic send.
   */
  handoffLimit(threadId: string): { threadId: string; text: string } {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (!this.limitWaits.has(threadId))
      throw new EngineError("no usage-limit wait on this thread");
    const touched =
      this.checkpoints?.touchedPathsFor(threadId, thread.turn?.id ?? "") ?? [];
    const text = limitHandoffText(thread, touched);
    this.clearLimitWait(threadId);
    const made = this.createThread(thread.projectId);
    this.pushSystemNote(thread, `Work handed off to "${made.title}".`);
    return { threadId: made.id, text };
  }

  /**
   * F25 frozen `subagent(of:)` — at most one helper per parent; the
   * binding survives the panel closing (a closed helper still receives
   * later merge prompts as ordinary turns).
   */
  helperOf(parentId: string): ChatThread | undefined {
    return this.store.state.threads.find((t) => t.parentThreadId === parentId);
  }

  /**
   * F25 frozen `spawnSubagent(from:title:prompt:)`: a merge/PR link hands
   * its request to the parent's helper — an existing one gets the prompt
   * (queued behind its running turn, sent at once when idle), otherwise a
   * helper thread is created in the parent's project with the parent's
   * provider choices, marked `isInPanel`, and sent the brief. The parent
   * keeps the selection — the helper opens in its panel, not the main
   * timeline.
   */
  spawnHelper(parentId: string, title: string, prompt: string): ChatThread {
    this.assertMutable();
    const parent = this.mustThread(parentId);
    const trimmed = prompt.trim();
    if (!trimmed) throw new EngineError("empty helper prompt");
    const existing = this.helperOf(parentId);
    if (existing) {
      const busy =
        existing.turn?.status === "running" ||
        existing.turn?.status === "waiting-approval";
      if (busy) this.enqueueFollowUp(existing.id, trimmed);
      else this.sendTurn(existing.id, trimmed);
      return existing;
    }
    const thread: ChatThread = {
      id: randomUUID(),
      projectId: parent.projectId,
      title: title.trim() || "Helper",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      turn: null,
      sessionGrants: [],
      hydraEnabled: this.store.state.settings.hydraDefaultEnabled !== false,
      ...(this.store.state.settings.lastHydraPairId
        ? { hydraPairId: this.store.state.settings.lastHydraPairId }
        : {}),
      // Frozen inherits provider/model/effort/runtimeMode/fastMode.
      ...(parent.codexModel !== undefined ? { codexModel: parent.codexModel } : {}),
      ...(parent.codexEffort !== undefined ? { codexEffort: parent.codexEffort } : {}),
      ...(parent.codexServiceTier !== undefined
        ? { codexServiceTier: parent.codexServiceTier }
        : {}),
      ...(parent.runtimeMode !== undefined ? { runtimeMode: parent.runtimeMode } : {}),
      ...(parent.interactionMode !== undefined
        ? { interactionMode: parent.interactionMode }
        : {}),
      parentThreadId: parentId,
      isInPanel: true,
    };
    this.store.update((d) => {
      d.threads.push(thread);
    });
    this.emit({ type: "thread-added", thread });
    this.sendTurn(thread.id, trimmed);
    return thread;
  }

  /**
   * F25 frozen `closeSubagent`: the panel closes — a running turn is
   * interrupted (frozen releases the session once it finishes; ours ends
   * the turn the same way through cancelTurn) and the helper drops into
   * the sidebar under its parent as a smaller row.
   */
  closeHelper(threadId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    if (thread.turn?.status === "running" || thread.turn?.status === "waiting-approval")
      this.cancelTurn(threadId);
    if (thread.isInPanel !== true) return;
    thread.isInPanel = false;
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  /**
   * F13/F22 detection slice (frozen GitHubConnection.githubCLI): which
   * forge CLIs merge/PR handoffs could actually run — presence and
   * `--version` only. Sign-in state is never probed and no credential
   * command is ever run, so this is honest about capability without
   * touching the user's tokens.
   */
  async probeForgeClis(): Promise<ForgeCliStatus[]> {
    return probeForgeClis();
  }

  /**
   * F09 (frozen ThreadRuntime.revert, bounded): rewind the conversation
   * to before a turn — removes that turn and everything after it from
   * the timeline, clears queued follow-ups (they answer a timeline that
   * no longer exists), and drops the provider binding so the next turn
   * opens a fresh conversation (frozen "provider cannot rewind" default
   * path — neither mock nor the codex fixture implements rollback).
   * Files are KEPT: in-place checkpoint restore stays disabled (A17),
   * so the destructive "revert files too" variant is not offered and
   * the notice says so plainly. Refuses while a turn runs or hydra
   * heads are still working.
   */
  revertTurn(threadId: string, turnId: string): void {
    this.assertMutable();
    const thread = this.mustThread(threadId);
    const live = thread.turn;
    if (live && (live.status === "running" || live.status === "waiting-approval"))
      throw new EngineError("Wait for the running turn to finish first.");
    if (
      this.store.state.threads.some(
        (t) => t.hydraHead?.leadId === threadId && t.hydraHead.status === "running",
      )
    )
      throw new EngineError("Stop the running agents before reverting this conversation.");
    const removed = this.removedTurnSet(thread, turnId);
    thread.messages = thread.messages.filter(
      (m) => !(m.turnId !== undefined && removed.has(m.turnId)),
    );
    // Thread records keep only the LATEST turn — if it was rewound away
    // there is no live record left (done history lives in messages).
    if (live && removed.has(live.id)) thread.turn = null;
    thread.followUps = [];
    this.handles.get(threadId)?.cancel();
    this.handles.delete(threadId);
    delete thread.providerThread;
    thread.hasUnread = false;
    delete thread.unreadStatus;
    thread.updatedAt = Date.now();
    this.appendNotice(
      thread,
      "Conversation rewound to before this turn. File changes were kept — restoring files isn't available in this build.",
      "info",
    );
  }

  /**
   * F09 (frozen ThreadRuntime.resend): rewind + send the edited text.
   * The composer intercepts this path when an edit target is set.
   */
  resendTurn(threadId: string, turnId: string, text: string): Turn {
    this.revertTurn(threadId, turnId);
    return this.sendTurn(threadId, text);
  }

  /** Removed turns = the target and every turn after it, in the order
   *  their first message appears (frozen turns[index...]). */
  private removedTurnSet(thread: ChatThread, turnId: string): Set<string> {
    const removed = new Set<string>();
    let seen = false;
    for (const m of thread.messages) {
      if (m.turnId === turnId) seen = true;
      if (seen && m.turnId) removed.add(m.turnId);
    }
    if (!seen) throw new EngineError("This message is no longer in the thread.");
    return removed;
  }

  /**
   * F09 (frozen revertPreview, bounded): what a rewind would touch —
   * the union of paths the removed turns touched, for the honest
   * confirm label. Files are never restored (A17) — this count is
   * information, not a restore promise.
   */
  revertPreview(threadId: string, turnId: string): { turns: number; files: number } {
    const thread = this.mustThread(threadId);
    const removed = this.removedTurnSet(thread, turnId);
    const paths = new Set<string>();
    for (const r of this.listCheckpoints(threadId))
      if (removed.has(r.turnId)) for (const p of r.touchedPaths) paths.add(p);
    return { turns: removed.size, files: paths.size };
  }

  /** System note outside a live turn (limit wait, hand-off outcome). */
  private pushSystemNote(thread: ChatThread, text: string): void {
    thread.messages.push({
      id: `limitnote-${randomUUID()}`,
      role: "system",
      content: text,
      status: "done",
      ts: Date.now(),
    });
    thread.updatedAt = Date.now();
    this.store.update(() => {});
    this.emit({ type: "thread-updated", thread });
  }

  private mustProject(id: string): Project {
    const p = this.store.state.projects.find((x) => x.id === id);
    if (!p) throw new EngineError(`unknown project ${id}`);
    return p;
  }

  private mustThread(id: string): ChatThread {
    const t = this.store.state.threads.find((x) => x.id === id);
    if (!t) throw new EngineError(`unknown thread ${id}`);
    return t;
  }
}

/**
 * F12 frozen `ProjectFile.scripts(at:)`: read `<project>/tivano.json`
 * `{"scripts":[{"name","command","icon","runOnWorktreeCreate"}]}` — name
 * and command must both be non-empty strings; icon maps to the frozen
 * symbol key (default "play"); malformed rows are dropped and a missing
 * or unreadable file yields none. Never throws — a bad file must not
 * block binding the directory it sits in.
 */
function readProjectFileScripts(dir: string): ProjectScript[] {
  try {
    const doc = JSON.parse(readFileSync(join(dir, "tivano.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const list = doc?.["scripts"];
    if (!Array.isArray(list)) return [];
    const iconFor = (icon: unknown): string => {
      switch (icon) {
        case "test":
          return "checkmark.seal";
        case "lint":
          return "wand.and.stars";
        case "configure":
          return "gearshape";
        case "build":
          return "hammer";
        case "debug":
          return "ant";
        default:
          return "play";
      }
    };
    const out: ProjectScript[] = [];
    for (const raw of list.slice(0, 32)) {
      if (typeof raw !== "object" || raw === null) continue;
      const s = raw as Record<string, unknown>;
      const name = typeof s["name"] === "string" ? s["name"].trim() : "";
      const command = typeof s["command"] === "string" ? s["command"].trim() : "";
      if (!name || !command) continue;
      out.push({
        id: randomUUID(),
        name: name.slice(0, 160),
        command: command.slice(0, 4000),
        icon: iconFor(s["icon"]),
        runOnWorktreeCreate: s["runOnWorktreeCreate"] === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}
