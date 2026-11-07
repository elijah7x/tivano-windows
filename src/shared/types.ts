// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shared contracts between main, preload and renderer. No Node or DOM APIs here.

import type { KeyChord } from "./shortcuts";
import type { HydraPair } from "./hydra";
import type { ModelPin, ModelSection, ModelPreference } from "./modelList";
import type { McpServerConfig } from "./mcp";
import type { WallpaperSetting } from "./wallpaper";

export const SCHEMA_VERSION = 1;

/** Persisted marker appended to interrupted streaming messages. The
 *  renderer localizes it for display; stored content stays stable. */
export const INTERRUPTED_MARKER = "[interrupted by restart — not resumed]";

/** F26: the full frozen AppTheme catalog (raw case values, allCases order). */
export const THEME_IDS = [
  "breeze",
  "breezeLight",
  "breezeDark",
  "system",
  "light",
  "dark",
  "catppuccinMocha",
  "catppuccinLatte",
  "dracula",
  "tokyoNight",
  "nord",
  "gruvbox",
  "gruvboxLight",
  "oneDark",
  "everforest",
  "kanagawa",
  "rosePine",
  "solarizedDark",
  "solarizedLight",
  "githubDark",
  "githubLight",
  "ayu",
  "nightOwl",
  "monokai",
  "claude",
  "claudeLight",
  "codex",
  "cursor",
  "matrix",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type LanguageId = "en" | "zh-Hans";

export interface Settings {
  theme: ThemeId;
  language: LanguageId;
  /** Mock-scope "always allow" grants, keyed by synthetic action kind. */
  alwaysAllow: string[];
  /**
   * F28: system-notification opt-in — a completed turn posts an OS
   * notification ONLY for an unseen result (different thread on screen
   * or unfocused window). Absent on old stores = off.
   */
  notifyOnDone?: boolean;
  /** F28: frozen chimeWhenFinished (default TRUE) — a soft chime when a
   *  turn finishes, whether or not the thread is in view. Optional so
   *  pre-A49 stores load verbatim; absent means the frozen default. */
  chimeWhenFinished?: boolean;
  // F02: frozen confirmBeforeDeleting (default true) — gates whether a
  // thread delete asks first. Optional so pre-A43 stores load verbatim.
  confirmBeforeDeleting?: boolean;
  /**
   * F05: frozen recentDownloadsPicker (default true) — the attach
   * button opens the recent-downloads popover instead of the file
   * dialog. Optional so pre-A47 stores load verbatim.
   */
  recentDownloadsPicker?: boolean;
  /**
   * F01: frozen newThreadLocation (default "recent") — where an
   * ordinary new thread lands: "recent" follows the selected chat's
   * project (including its standalone status), "standalone" always
   * lands in Tasks. A thread created from a project button still
   * places itself in that project. Optional so pre-A78 stores load
   * verbatim.
   */
  newThreadLocation?: "recent" | "standalone";
  /**
   * F06: frozen defaultRuntimeMode (default "fullAccess") — seeds the
   * new thread's runtimeMode at creation; the per-thread picker then
   * overrides it. Optional so pre-A78 stores load verbatim.
   */
  defaultRuntimeMode?: RuntimeMode;
  /**
   * F11: frozen defaultWorkspaceMode (default "local") — a
   * project-bound ordinary new thread starts in a fresh git worktree
   * when "worktree". Standalone threads have no project, so the
   * default stays local for them. Optional so pre-A78 stores load
   * verbatim.
   */
  defaultWorkspaceMode?: "local" | "worktree";
  /**
   * F03: frozen showReasoning (default false) — the agent's thinking
   * stays hidden unless toggled on. Optional so pre-A78 stores load
   * verbatim.
   */
  showReasoning?: boolean;
  /**
   * F03: frozen showsWorkingCard (default true) — the running turn's
   * working indicator is a card carrying the live progress bar; false
   * shows the plain one-line badge. Optional so pre-A78 stores load
   * verbatim.
   */
  showsWorkingCard?: boolean;
  /**
   * F26: frozen performanceMode (default false) — disables window
   * transparency, blurs, glows and background effects for lowest GPU
   * usage. This build's window is already opaque: the honest port
   * strips the effects it actually renders (drop shadows, glows,
   * transitions, animations, filters). Optional so pre-A48 stores
   * load verbatim.
   */
  performanceMode?: boolean;
  /**
   * F26: frozen showsSkylight (default true) — the sidebar's weather hero.
   * Effective only when performanceMode is off (frozen showsSkylightNow).
   * Absent on old stores = on.
   */
  showsSkylight?: boolean;
  /**
   * F33: receipt for the CLI command shim installed on request — the
   * absolute client path the shim points at (frozen cliInstallationTarget).
   * Absent = nothing installed by us. Never enables local control.
   */
  cliInstallationTarget?: string;
  /**
   * F20: usage-limit auto-continue opt-in — a turn that fails on the
   * provider's usage limit waits for the advertised reset (+60s margin,
   * 5s floor) and sends the continue message itself. Absent = off.
   */
  autoContinueAfterLimit?: boolean;
  /**
   * User-saved Codex CLI path (physical, validated at save time).
   * Consulted ONLY at the next launch's runtime resolution — setting it
   * never hot-swaps the running adapter. Absent on every old store.
   */
  codexExecutable?: string;
  /**
   * F29: while tasks run, optionally keep the machine awake. "system"
   * blocks idle system sleep only (screen may still dim); "display" also
   * keeps the screen lit. Manual sleep and closing the lid still work —
   * the OS owns those. Absent on old stores = off.
   */
  taskSleepMode?: TaskSleepMode;
  /**
   * F31: provider-generated thread titles. "automatic" uses the thread's
   * own provider when the adapter supports it; "off" keeps the
   * prompt-derived fallback. Claude/Codex-specific picks are deferred —
   * they need a signed-in provider CLI, which this build does not have.
   * Absent on old stores = automatic (frozen default).
   */
  textGeneration?: "automatic" | "off";
  /**
   * v2.2.34 Settings › Text generation › Thread titles. "once" names a
   * chat from its first turn and leaves it (today's behavior); "updated"
   * looks at the chat again every six completed turns and renames it
   * when the work has moved on, keeping the title when it still fits.
   * Titles the user set never change either way. Absent = "once".
   */
  threadTitles?: "once" | "updated";
  /**
   * v2.2.x Settings › General › Conversation auto-shelve: idle days
   * before a project shelves itself (0/off = never; frozen 3|7|14).
   * A project with a running, unread or open thread is never auto-shelved.
   */
  autoShelveDays?: 0 | 3 | 7 | 14;
  /**
   * v2.2.22: custom name for the shelved-projects group; null/absent
   * restores the default "Shelved projects".
   */
  shelvedGroupName?: string | null;
  /**
   * v2.2.34 quick chat: the global shortcut (⇧⌘Space default, rebound
   * through Settings › Shortcuts › quickChat) opens the minimal box over
   * other apps. Off by default — frozen parity.
   */
  quickChatEnabled?: boolean;
  /**
   * F27: keyboard-shortcut OVERRIDES only — a present chord replaces the
   * command's default; a stored null clears that command's binding
   * entirely (frozen Override semantics — absent keys fall back to the
   * frozen defaultChord). Keys are ShortcutCommandIds; chords carry the
   * physical KeyboardEvent.code plus modifier flags (mod = platform
   * primary, ctrl = literal Control on macOS).
   */
  shortcuts?: Record<string, KeyChord | null>;
  /**
   * F13: frozen commitInstructions — free-form guidance appended to the
   * generated-commit-message prompt ("use conventional prefixes"). Empty
   * string = no extra instructions (frozen default).
   */
  commitInstructions?: string;
  /**
   * F31: frozen antiSlopEnabled — "Concise AI replies". The built-in
   * guidance block rides the first ordinary message of each provider
   * session once; "off" delivers the disregard notice instead (a
   * resumed conversation may still hold the enabled guidance). Absent
   * on old stores = enabled (frozen default true).
   */
  antiSlopEnabled?: boolean;
  /**
   * F33: the frozen double gate — alpha master switch AND the separate
   * local-control switch must both be on before the control socket
   * listens (frozen `isExternalControlEnabled = alpha && external`).
   * Absent on old stores = both off (secure default).
   */
  alphaEnabled?: boolean;
  externalControlEnabled?: boolean;
  /**
   * F26: frozen uiFontSize/contentFontSize/codeFontSize — absolute point
   * sizes per category (ui 12–18, content 12–18, code 11–17). The offset
   * from stock (13/13/12) applies to every size in that category.
   * Absent on old stores = the frozen defaults 14/15/13.
   */
  fontSizes?: FontSizeSettings;
  /**
   * F21: frozen Hydra configuration layer. `hydraEnabled` is the app-wide
   * master switch (frozen default ON — "what the app is for"); in this
   * build no head-scheduling runtime consumes it yet (F22), so it is
   * inert durable config and the Hydra settings section says so.
   * `hydraDefaultEnabled` is the per-chat default new threads seed from;
   * every per-chat flip saves here too (frozen parity). `hydraPairs`
   * holds the configured lead↔heads pairings (HydraPair model in
   * shared/hydra.ts). Absent on old stores = frozen defaults.
   */
  hydraEnabled?: boolean;
  hydraDefaultEnabled?: boolean;
  /** Queued follow-ups go to a head at once instead of waiting for the
   *  turn (frozen default true). */
  hydraQueueHeads?: boolean;
  /** Every message goes to a head while there is room (frozen default
   *  false). */
  hydraAlwaysHeads?: boolean;
  /** A Tivano-run head gets a copy of the checkout of its own (frozen
   *  default true). */
  hydraIsolateHeads?: boolean;
  /** The page-wide cap on heads at work at once (1–8); absent = no cap
   *  here (a pair's own cap still counts where lower). */
  hydraMaxHeads?: number;
  /** After the team is done, publish+merge its work (frozen default
   *  false — requires a configured remote and access). */
  hydraAutoMerge?: boolean;
  /** The lead audits each head's landed work before finishing (frozen
   *  default false). */
  hydraReviewHeads?: boolean;
  /** Auto-archive finished Codex head sessions (provider-side history;
   *  frozen default false). */
  hydraArchivesCodexHeads?: boolean;
  /** A head's panel shows its whole conversation instead of the progress
   *  bar (frozen default false). */
  hydraShowsHeadDetails?: boolean;
  /** Each head after the first gets a panel of its own (frozen default
   *  false — one panel lists every head). */
  hydraAutoPopsHeads?: boolean;
  /** Lower the default reasoning effort for heads (frozen default true;
   *  effort set in a pair is unaffected). */
  hydraTempersHeadEffort?: boolean;
  /** The first chat's Hydra intro was read (frozen default false). */
  hasSeenHydraIntro?: boolean;
  /** The configured lead↔heads pairings. */
  hydraPairs?: HydraPair[];
  /** The pair the model picker last put a chat on. */
  lastHydraPairId?: string;
  /**
   * F17: frozen modelList / modelSections / collapsedModelSections /
   * modelPreferences. Pins only ORGANIZE the model picker — the catalog
   * itself stays provider-owned (models:list); a pin whose model never
   * appeared in a catalog still shows by id. Sections are headings
   * positioned in the unified list (see shared/modelList.ts); collapsed
   * holds section ids folded in Settings and the picker. Preferences
   * are the per-pin defaults new selections adopt, keyed "provider/
   * modelID". All optional so pre-A53 stores load verbatim; absent =
   * empty list (picker shows every catalog model).
   */
  modelList?: ModelPin[];
  modelSections?: ModelSection[];
  collapsedModelSections?: string[];
  modelPreferences?: Record<string, ModelPreference>;
  /**
   * F18 bounded slice: local MCP servers over stdio (frozen MCPStore
   * connections). Probing spawns the real command; bridging servers
   * into provider sessions is not implemented — these are user config
   * + live-check state only. `env` values persist plaintext here (the
   * frozen Keychain split is out of slice). Absent on old stores.
   */
  mcpServers?: McpServerConfig[];
  /**
   * F26 wallpaper (bounded): a picture the user picked, stored inside
   * the library. `file` is a wallpaper-*.ext BASENAME — main installs
   * it; the renderer never supplies a path. `softness` 0..1 blurs.
   */
  wallpaper?: WallpaperSetting;
  /**
   * F26 transparency slider, frozen 0..1 / default 0.5. On this opaque
   * window it honestly modulates the wallpaper picture's own opacity;
   * real desktop show-through is out of slice.
   */
  backdropOpacity?: number;
  /**
   * F25: the helper panel's user-dragged size (frozen AppSettings.
   * panelSize). Absent = the frozen 400×adaptive default; always
   * re-fitted to the live pane before use.
   */
  helperPanelSize?: { width: number; height: number };
  /** A81: edge-dragged sidebar width — frozen SidebarLayout defaults
   *  (absent = 268; the 210–440 bounds live in the validator and the
   *  drag clamps). */
  sidebarWidth?: number;
  /** A81: top-edge-dragged terminal drawer height — absent = the
   *  frozen 260; bounds 140–760. */
  terminalHeight?: number;
}

export type TaskSleepMode = "off" | "system" | "display";

/** F26 — see shared/typeScale.ts for stocks, ranges and defaults. */
export interface FontSizeSettings {
  ui?: number;
  content?: number;
  code?: number;
}

/** F12: a named project script — run in a real terminal at the thread's
 *  execution directory (worktree-aware). `icon` is the frozen icon key
 *  (play/checkmark.seal/…) carried verbatim; `runOnWorktreeCreate` runs
 *  the script automatically when this app creates a thread worktree. */
export interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: string;
  runOnWorktreeCreate: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  expanded: boolean;
  /**
   * Canonical directory the user attached via the main-owned chooser.
   * DISPLAY metadata only — spawn authorization is the app-private grants
   * file keyed by projectId; a forged value here can never mint a grant.
   */
  directory?: string;
  /**
   * Live availability computed by main inside each snapshot/event — never
   * trusted from disk alone. Absent for projects without a directory.
   */
  directoryStatus?: "available" | "unavailable";
  /** F12 project scripts — user-edited or picked up from tivano.json. */
  scripts?: ProjectScript[];
  /**
   * F01 project icon — an emoji mark chosen in the picker; absent clears
   * back to the folder mark. The frozen .symbol case is Apple SF Symbols,
   * a mark set that cannot render on Windows — unsupported here.
   */
  icon?: string;
  /**
   * v2.2.x shelved projects (frozen Library.Project.isShelved): shelved
   * projects leave the main list for the shelf popover; real work in
   * them (send, new thread, re-add, move-in) unshelves automatically.
   */
  isShelved?: boolean;
  /** When last shelved/unshelved — a manual unshelve restarts the idle clock. */
  shelvedAt?: number;
}

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus =
  | "done"
  | "streaming"
  | "interrupted"
  | "error"
  | "denied"
  | "cancelled";

/** F05 display descriptor for a draft/sent attachment. Deliberately
 *  path-free: the library copy's location is main-owned state the
 *  renderer never receives — the same rule as project directories. */
export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
}

/** F05 downloads popover: one row of the 15 newest files in the OS
 *  downloads directory. The id is opaque — only main resolves it back
 *  to a path, and only inside one listing generation. */
export interface DownloadItem {
  id: string;
  name: string;
  size: number;
  isImage: boolean;
  mtime: number;
}

/** One step in a provider-reported turn plan (frozen TodoStep). */
export interface TodoStep {
  text: string;
  status: "pending" | "active" | "done";
}

/** Frozen ToolCall kind vocabulary. */
export type ToolKind =
  | "command"
  | "read"
  | "search"
  | "edit"
  | "mcp"
  | "web"
  | "agent"
  | "other";

/** F03: structured tool-call note persisted on a kind="tool" message.
 *  The renderer localizes kind/state and `titleKey`-backed titles. */
export interface ToolNote {
  kind: ToolKind;
  /** Provider-side literal title (command text, path, query…). */
  title?: string;
  /** i18n key for adapter-fixed titles; wins over `title` when set. */
  titleKey?: string;
  titleParams?: (string | number)[];
  /** Bounded output tail / change summary. */
  detail?: string;
  state: "running" | "completed" | "failed" | "declined";
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  ts: number;
  /** Turn that produced this message (assistant/system). */
  turnId?: string;
  /** F03: system-role message rendered as a dedicated block
   *  (Codex reasoning/plan/tool items, turn todos, provider notices)
   *  instead of a plain note. */
  kind?: "reasoning" | "plan" | "todos" | "tool" | "notice";
  /** F03 kind="notice": frozen Notice.Level — info renders inline;
   *  warning/error get the tinted pill + level glyph. */
  noticeLevel?: "info" | "warning" | "error";
  /** F03 todos: the turn/plan/updated step list (kind="todos" only). */
  steps?: TodoStep[];
  /** F03 tool: the structured tool-call row (kind="tool" only). */
  tool?: ToolNote;
  /** F05: attachments sent with a user message — display descriptors
   *  only (id/name/size); the library copies' paths stay main-side. */
  attachments?: AttachmentRef[];
  /** F22: roster indexes of the heads whose reports this user-side
   *  message carries (frozen message.hydraHeads). Its presence marks
   *  the message as a heads' report batch, rendered as the digest
   *  pill rather than a plain user bubble. */
  hydraHeads?: number[];
  /** F22: the lead's brief arriving on a head's thread (frozen
   *  message.isHydraBrief) — rendered as the "Name's brief" pill,
   *  not a plain user bubble. */
  hydraBrief?: boolean;
}

export type ApprovalOptionRole = "approve" | "deny";
export interface ApprovalOption {
  id: string;
  /** English source string; renderer localizes it. */
  title: string;
  role: ApprovalOptionRole;
  /** Session scope keeps the grant for this thread; always persists it.
   *  "turn" bounds the grant to the remainder of the active turn. */
  scope: "once" | "turn" | "session" | "always" | "none";
}

export type ApprovalStatus = "pending" | "resolved" | "expired";
export interface ApprovalRequest {
  id: string;
  turnId: string;
  kind: "command" | "action" | "plan";
  /** English source headline, e.g. "Allow this action?" */
  headline: string;
  /** Main payload (synthetic command text for kind=command). */
  title: string;
  detail?: string;
  reason?: string;
  symbol: string;
  options: ApprovalOption[];
  status: ApprovalStatus;
  resolvedOptionId?: string;
  /** True when a session/always grant resolved it without new user input. */
  autoResolved?: boolean;
  /**
   * Opaque adapter-side key for the server request this card answers
   * (Codex only): lets the provider expire exactly this card when the
   * server resolves the request itself — never mistaken for a user answer.
   */
  providerKey?: string;
}

export type TurnStatus =
  | "running"
  | "waiting-approval"
  | "done"
  | "cancelled"
  | "denied"
  | "error"
  | "interrupted";

/** One choice the provider offered for a question (frozen QuestionRequest). */
export interface CodexQuestionChoice {
  label: string;
  detail?: string;
}

/** A single question inside one Codex item/tool/requestUserInput request. */
export interface CodexQuestion {
  id: string;
  header: string;
  prompt: string;
  choices: CodexQuestionChoice[];
  /** Free-text answer allowed besides the listed choices. */
  allowsOther: boolean;
  /** Answer is sensitive — the input masks it; it is still sent verbatim. */
  isSecret: boolean;
}

/**
 * The provider's outstanding user-input request. Exactly one is presented
 * at a time per turn (the adapter serializes server requests). status:
 * pending → answered (write confirmed) | expired (server resolved it,
 * the write failed, or the turn ended).
 */
export interface CodexQuestionRequest {
  /** Opaque adapter key echoing the server request — the only identity
   *  the answer may name. */
  providerKey: string;
  questions: CodexQuestion[];
  status: "pending" | "answered" | "expired";
}

export interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
  /** Last stream sequence emitted; renderer/engine ignore out-of-order. */
  seq: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  approval?: ApprovalRequest;
  question?: CodexQuestionRequest;
  assistantMessageId: string;
  /**
   * F03 quiet-watchdog readout (volatile): whole minutes since the last
   * provider event once silence passes the 5-minute label threshold —
   * the working line swaps its word for "No response for %@ min…".
   * Cleared on the next event or when the turn ends. A persisted value on
   * a reloaded turn is stale-but-harmless: reload interrupts running
   * turns and the indicator only reads it while status is running.
   */
  quietMinutes?: number | undefined;
}

/**
 * Persisted provider-side thread identity (Codex resume). Written by the
 * engine when the adapter reports a fresh provider thread — before the
 * first turn ever starts, so a restart can resume it.
 */
export interface ProviderThreadBinding {
  providerId: "codex";
  codexThreadId: string;
  /** Workspace directory recorded at bind time. */
  cwd: string;
  /** CODEX_HOME identity the binding is valid for. */
  codexHomeId: string;
  /** Protocol pin the binding was created under. */
  schemaPin: string;
  /** "unknown" until a real CLI is probed. */
  cliVersion: string;
  savedAt: number;
}

export interface ChatThread {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  turn: Turn | null;
  /** Session-scoped synthetic grants ("allow for session"). */
  sessionGrants: string[];
  /** Provider-side thread identity for resume (Codex only). */
  providerThread?: ProviderThreadBinding;
  /**
   * User-chosen Codex model override for this thread (F17). Sent verbatim
   * to the provider on thread/start|resume and every turn/start until
   * cleared — never validated locally as "usable", never silently
   * substituted. Absent = the provider decides.
   */
  codexModel?: string;
  /** Same semantics for the reasoning effort override. */
  codexEffort?: string;
  /**
   * User-chosen Codex service tier for this thread (F17). Sent verbatim
   * as turn/start's `serviceTierForTurn` — never validated locally as
   * billable/usable. Absent = the provider's default tier.
   */
  codexServiceTier?: string;
  /**
   * Last model/effort the provider itself reported for this thread
   * (thread/start|resume response echo). Diagnostic — a reported id is
   * not proof the next turn succeeds.
   */
  codexModelReported?: string;
  codexEffortReported?: string;
  /**
   * Queued follow-up prompts (F08). Sent as ordinary user turns, in
   * order, once the running turn COMPLETES — a stopped/failed turn never
   * drains the queue (the user waits on it instead). Persisted so a
   * restart keeps the queue, but a restart itself never auto-sends.
   */
  followUps?: FollowUpItem[];
  /**
   * F02: archived threads leave the main list but keep their store
   * record — restorable and deletable from the Archived section. A
   * running turn is NOT cancelled by archiving.
   */
  isArchived?: boolean;
  /**
   * F06: the thread's runtime mode — seeded from settings
   * .defaultRuntimeMode at creation (frozen default fullAccess); the
   * per-thread picker overrides it. Applies to FUTURE turns — never
   * retargets a running one.
   */
  runtimeMode?: RuntimeMode;
  /**
   * F02 pin: pinned threads lead their list section. Archiving clears
   * the mark (frozen parity) — a restored thread returns unpinned.
   */
  isPinned?: boolean;
  /**
   * F21: the thread's Hydra choice — seeded from hydraDefaultEnabled at
   * creation and saved back to it on every flip (frozen parity).
   * Inert until head scheduling (F22) lands.
   */
  hydraEnabled?: boolean;
  /** F21: the Hydra pair this chat leads on; absent = none chosen. */
  hydraPairId?: string;
  /**
   * v2.2.34 title keep-updated: true once the user has set the title
   * themselves — an explicit rename is never overwritten by
   * auto-renaming. Absent/false = title is a fallback or generated one.
   */
  titleUserSet?: boolean;
  /**
   * v2.2.34 title keep-updated: the completed-turn count at the last
   * title write/review — the next auto-review fires at +6.
   */
  titleReviewTurns?: number;
  /**
   * F22: roster counter — heads this lead has sent out (frozen
   * `hydraSpawnCount`). Only bumped by spawns; a lead with no heads left
   * starts the roster over like the frozen build.
   */
  hydraSpawnCount?: number;
  /**
   * F22: present on a head thread only — this chat is a Tivano-run head
   * working for `leadId`. Heads stay OUT of the sidebar (the frozen
   * roster lives in the lead's panel, not the thread list); they persist
   * like any thread so a restart keeps their record.
   */
  hydraHead?: {
    leadId: string;
    /** Roster slot (persona index) this head wears. */
    headIndex: number;
    /** Roster name actually given (announced name or persona). */
    name: string;
    task: string;
    /** The delegation block (lead turn id) this head belongs to — its
     *  reports flush only once the whole batch is back (frozen
     *  settleBatches). A non-batch head's batchId is its own thread id. */
    batchId: string;
    status: "running" | "completed" | "stopped" | "failed";
    /** Last assistant reply at finish — the report text (frozen). */
    summary?: string | undefined;
    /** Watchdog stop note, prepended to the report (frozen). */
    stalledNote?: string | undefined;
    toolCalls?: number | undefined;
    /** Wall-clock run time, filled at finish (frozen report effort). */
    elapsedMs?: number | undefined;
    /** F22: the pair's head profile this head was routed to, when the
     *  delegation's `profile` named one this build can run (frozen
     *  HydraHeadInfo.profile; a profile on a foreign provider is never
     *  routed here — the head runs the shared fields). */
    profile?: string | undefined;
    /** F22 isolation: the capture commit's tree the head's copy was
     *  checked out from (frozen baseTree — `hasOwnCopy`). Absent = the
     *  head worked in the shared checkout. */
    baseTree?: string | undefined;
    /** F22 isolation: the checkout the copy lands back into (frozen
     *  targetCheckout) — the lead's worktree when the head stayed in
     *  the same project, else the head's project directory. */
    landingCheckout?: string | undefined;
    /** F22 isolation: where the head's changes went (frozen
     *  HydraLanding). files+conflicts describe a landing; patchPath a
     *  kept patch when nothing could be applied; error the reason. */
    landing?: {
      files: { path: string; additions: number; deletions: number }[];
      conflicts: string[];
      patchPath?: string | undefined;
      error?: string | undefined;
    } | undefined;
    /** F22 isolation: the copy could not be removed and is kept on
     *  disk at `worktreeDir` (frozen kept-copy path). */
    copyKept?: boolean | undefined;
    /** F22 isolation: the head finished but its landing is still in
     *  flight — its report queues only after it resolves (a persisted
     *  true on boot means the landing was lost to a restart). */
    landingPending?: boolean | undefined;
    spawnedAt: number;
    finishedAt?: number | undefined;
  };
  /**
   * F01: manual position inside the thread's affiliation (frozen
   * ChatThread.sortOrder, ascending). Absent = never reordered — the
   * frozen sort keeps such threads on TOP of their section.
   */
  sortOrder?: number;
  /**
   * F28: an unseen finished/errored/interrupted result. Set on turn end
   * unless the user stopped the turn themselves (cancelled) or answered
   * its card (denied), or the thread was on screen; cleared on select.
   * `unreadStatus` says WHAT ended — the row can show it honestly.
   */
  hasUnread?: boolean;
  unreadStatus?: "done" | "error" | "interrupted";
  /**
   * F19: last context-window reading the provider reported for this
   * thread (Codex thread/tokenUsage/updated) — live telemetry kept so
   * the meter survives restart. Never derived locally; absent = no
   * reading yet.
   */
  contextUsage?: { usedTokens: number; windowTokens?: number };
  /**
   * F06 Build/Plan. Plan asks the provider to plan rather than build —
   * carried on Codex turn/start's collaborationMode (when the thread's
   * model is known). Absent = build.
   */
  interactionMode?: InteractionMode;
  /** F09: forwarded-context snapshot installed on a continuation
   *  thread. `sent` marks the one delivery into the provider session —
   *  persisted so a restart never double-injects on thread/resume. */
  continuation?: ThreadContinuation;
  /**
   * F11: this thread's own worktree directory (created by main via
   * `git worktree add` under the data root). When set AND live, turns
   * execute in the worktree instead of the project's bound directory —
   * a dead worktree honestly fails the turn rather than silently
   * falling back to a different directory. Absent = project directory.
   */
  worktreeDir?: string | undefined;
  /**
   * F25: helper chat (frozen spawnSubagent) — a chat a merge/PR link in
   * `parentThreadId`'s timeline handed its request to. At most one helper
   * per parent; it inherits the parent's project and provider choices and
   * runs as a thread of its own — never a Hydra head. Absent = a normal
   * chat.
   */
  parentThreadId?: string;
  /**
   * F25: while true the helper lives in the parent's helper panel instead
   * of the sidebar (frozen isInPanel); closing the panel drops it into the
   * sidebar as a smaller row under the parent — the record itself never
   * moves.
   */
  isInPanel?: boolean;
}

/** F11 worktree operation result — created reports the directory main
 *  actually created; unavailable carries the honest reason. `setup`
 *  reports runOnWorktreeCreate script outcomes honestly — a script that
 *  could not get a terminal is named, never silently skipped. */
export type WorktreeResult =
  | {
      kind: "created";
      directory: string;
      branch: string;
      setup?: { ran: number; failed: { name: string; reason: string }[] };
    }
  | { kind: "removed" }
  | { kind: "unavailable"; reason: string };

/** F13: `git status --short` + `git diff HEAD` for the commit sheet —
 *  read-only; patch capped like the frozen 40 KB prefix. */
export type GitWorkingChanges =
  | { kind: "ok"; summary: string; patch: string; truncated: boolean }
  | { kind: "unavailable"; reason: string };

/** F13 one-shot commit-message generation — ok carries sanitized text;
 *  unavailable reports why (engine off, no capable provider, bad output). */
export type GitCommitMessageResult =
  | { kind: "ok"; message: string }
  | { kind: "unavailable"; reason: string };

/** F13 commit outcome — committed carries the new HEAD oid (the push
 *  attempt, when requested, reports honestly even after a successful
 *  commit); unavailable carries the reason verbatim. */
export type GitCommitResult =
  | { kind: "committed"; oid: string; pushed: boolean; pushError?: string }
  | { kind: "unavailable"; reason: string };

/** F13 standalone push outcome. */
export type GitPushResult =
  | { kind: "pushed" }
  | { kind: "unavailable"; reason: string };

/** F09 forwarded context — frozen ThreadContinuation @ d31e093b
 *  (attachments omitted; no attachment model exists here). */
export interface ThreadContinuation {
  sourceThreadId: string;
  sourceTitle: string;
  createdAt: number;
  context: string;
  isTruncated: boolean;
  sent: boolean;
}

/** One queued follow-up. `bundleId` groups items that go out as ONE
 *  merged message (frozen bundleFollowUp parity, attachments aside). */
/**
 * F06 runtime modes — frozen Provider.swift @ d31e093b. The mode is a
 * per-thread preference; it maps to provider policy parameters at
 * bind/turn time (Codex table in codexAppServerProvider). Providers
 * that cannot honor a mode still store it — clamping belongs to the
 * provider, the stored value never lies.
 */
export type RuntimeMode = "supervised" | "autoAcceptEdits" | "auto" | "fullAccess";

/** F06 interaction modes — frozen Provider.swift @ d31e093b. */
export type InteractionMode = "build" | "plan";

export interface FollowUpItem {
  id: string;
  text: string;
  createdAt: number;
  bundleId?: string;
}

export interface StoreFile {
  schemaVersion: number;
  projects: Project[];
  threads: ChatThread[];
  settings: Settings;
  ui: { selectedThreadId: string | null };
  /**
   * F05: per-provider slash-command recency, most-recent-first
   * (frozen `recentSlashCommands`, capped at 100 per provider). Used
   * only to order the composer suggestion menu — never sent anywhere.
   */
  recentCommands?: Record<string, string[]>;
}

/** Codex runtime status — the ONLY codex state the renderer ever sees. */
export interface CodexInfo {
  /**
   * "fixture": offline protocol fixture (explicitly synthetic).
   * "configured-unverified": a real codex.exe is configured AND the
   *   packaged job-helper attestation passed — the CLI itself is still
   *   unverified by the lead (no real launch has ever been accepted).
   * "unsupported": configured AND launch would be refused (gate failed).
   * "unconfigured": neither fixture nor real is set up.
   */
  state: "fixture" | "configured-unverified" | "unsupported" | "unconfigured";
  /** Absolute configured path when present (diagnostics only). */
  executable?: string;
  /** Resolved app-private CODEX_HOME identity. */
  codexHomeId?: string;
  /** Attested packaged helper version — set only on a supported verdict. */
  helperVersion?: string;
  /** Frozen protocol pin this build implements. */
  protocolPin: string;
  /** "unknown" until a real CLI is version-probed by the lead. */
  cliVersion: string;
  /** Why real launch is unavailable, when applicable. */
  reason?: string;
}

/** One model the provider's model/list reported (frozen ModelOption).
 *  The catalog is provider-owned state — listed here exactly as reported. */
export interface CodexModelOption {
  id: string;
  name: string;
  detail?: string;
  /** Reasoning-effort ids this model advertises (may be empty). */
  efforts: string[];
  defaultEffort?: string;
  isDefault: boolean;
  /** Faster service-tier id when advertised ("fast"/"priority" in id+name). */
  fastTier?: string;
}

/** Honest model-catalog answer for models:list — never a fabricated list. */
export type CodexModelCatalog =
  | { state: "ready"; models: CodexModelOption[] }
  /** No live Codex session yet — the catalog exists only once a session
   *  binds; the picker can still carry a persisted selection meanwhile. */
  | { state: "pending"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "unsupported"; reason: string };

/** Result of codex:choose — the path, when present, is always
 *  the main-validated physical path from the native dialog. */
export type CodexChooseResult =
  | { status: "chosen"; path: string }
  | { status: "canceled" }
  | { status: "busy" }
  | { status: "superseded" }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string };

/** Result of codex:save / codex:clear. */
export type CodexWriteResult =
  | { status: "saved"; path: string; changed: boolean }
  | { status: "cleared"; changed: boolean }
  | { status: "error"; error: string };

/** Honest codex setup snapshot for the Settings surface. Separates the
 *  CURRENT launch's runtime from the persisted next-launch candidate —
 *  nothing here implies the saved path is installed, verified or able
 *  to authenticate. */
export interface CodexSetupState {
  /** Persisted settings value (next-launch candidate). */
  savedExecutable: string | null;
  /** Live revalidation failure of the saved path, if it no longer checks out. */
  savedInvalidReason?: string;
  /** Validated dialog choice awaiting an explicit save. */
  pendingExecutable: string | null;
  /** A native chooser is currently open. */
  chooserBusy: boolean;
  /** Raw TIVANO_PROVIDER value at bootstrap (null = unset). */
  providerOverride: string | null;
  /** Provider actually launched this run. */
  launchProvider: "mock" | "synthetic-stdio" | "codex";
  /** Which source produced this launch's codex runtime (null = not codex). */
  effectiveSource: "fixture" | "environment" | "saved" | "none" | null;
  /** Executable this launch resolved (real mode only). */
  effectiveExecutable: string | null;
  /**
   * What the saved value does: "active" — it produced this launch's
   * runtime; "pending-restart" — it will be consulted next launch;
   * "blocked" — an explicit override means it cannot apply;
   * "none" — nothing saved.
   */
  savedEffect: "none" | "active" | "pending-restart" | "blocked";
  /** Why "blocked" — names the override that wins. */
  savedBlockReason?: string;
  /** This launch's codex runtime status (null when provider is not codex). */
  runtime: CodexInfo | null;
  /** May save/clear run now (window alive, mutable, store writable). */
  mutable: boolean;
}

export interface AppInfo {
  appVersion: string;
  baselineTag: string;
  baselineCommit: string;
  dataRoot: string;
  providerId: string;
  providerLabel: string;
  mock: true;
  /** Provider kind shown in the UI. */
  mode: "mock" | "synthetic-stdio" | "codex";
  /** F09: present (true) only when the provider runs `/compact` itself —
   *  the composer sends the command as plain text otherwise (frozen
   *  fall-through for unsupported providers). */
  supportsCompact?: true;
  /** F13: present (true) only when the provider adapter can generate a
   *  commit message from the frozen prompt — the Commit sheet's "Write
   *  for me" is disabled with the frozen guidance otherwise. */
  supportsCommitMessage?: true;
  /** Real CLI integration status — always not-configured in this phase. */
  realCli: { status: "not-configured" };
  /** Resolved executable + runtime version recorded before spawn (synthetic). */
  syntheticRuntime?: { executable: string; version: string };
  /** Codex adapter runtime status — present whenever mode is "codex". */
  codex?: CodexInfo;
  /** Set when the previous store file was unreadable and preserved aside. */
  recoveredFrom?: string;
  /** Present (true) ONLY in bundles compiled with --terminal-candidate:
   *  the Windows terminal validation candidate. Unmistakable to the
   *  renderer and to packaged-manifest inspection — never set by
   *  environment, settings or IPC. */
  terminalCandidate?: true;
  /** A73: OS home directory — the catalog picker expands "~" defaults
   *  (e.g. a filesystem server's root) against it. */
  home: string;
  /** A75: the app-owned worktree root `<dataRoot>/worktrees` — shown
   *  (and revealed) by the Source-control settings rows. Main-computed;
   *  the renderer can display it but never writes to it directly. */
  worktreesDir: string;
}

/** Per-turn checkpoint record as the renderer may see it — ledger
 *  identity plus honest status; never raw checkpoint ids or paths the
 *  caller could use to select foreign state. */
export interface CheckpointRecordView {
  recordId: string;
  turnId: string;
  status: "capturing" | "complete" | "unavailable" | "invalidated";
  reason?: string;
  createdAt: number;
  updatedAt: number;
  touchedPaths: string[];
  /** The grant moved since reservation — shown, never restorable. */
  stale: boolean;
}

export type CheckpointPreviewAction = "restore" | "remove" | "keep" | "noop";

export interface CheckpointPreviewEntry {
  path: string;
  action: CheckpointPreviewAction;
  reason?: string;
}

/** Non-mutating restore preview — analysis only; no file is changed. */
export interface CheckpointPreviewView {
  kind: "ready" | "unavailable";
  reason?: string;
  touchedPaths: string[];
  entries: CheckpointPreviewEntry[];
  limitations: string[];
}

export interface CheckpointRestoreEntry {
  path: string;
  /** What the apply actually did — never what it intended. */
  action: "restored" | "removed" | "kept" | "noop";
  reason?: string;
}

/** Mutating undo result — per-path outcomes, index never written. */
export interface CheckpointRestoreView {
  kind: "applied" | "unavailable";
  reason?: string;
  entries: CheckpointRestoreEntry[];
}

/** Per-turn file diff — read-only comparison of the stored base and
 *  end blob for one touched path. Never reads the live worktree. */
export type CheckpointDiffView =
  | { kind: "text"; path: string; patch: string }
  | { kind: "empty" | "binary" | "oversized"; path: string }
  | { kind: "unavailable"; path?: string; reason: string };

/**
 * Result of the main-owned directory chooser (projects:open-directory).
 * `opened` lists only projects main actually bound; `cancelled` means the
 * chooser produced nothing usable (user cancel, dead window, closing).
 */
export interface OpenDirectoryResult {
  opened: Project[];
  cancelled: boolean;
  /** Per-path failures inside a multi-selection (opened may still be
   *  non-empty); surfaced to the user, never silently swallowed. */
  errors?: string[];
}

export interface Snapshot {
  projects: Project[];
  threads: ChatThread[];
  settings: Settings;
  selectedThreadId: string | null;
  info: AppInfo;
  /**
   * Event revision at snapshot time: events stamped with rev <= this are
   * already reflected in the snapshot and must not be applied again.
   */
  rev: number;
  /** True while teardown is running or a failed close kept the app open. */
  readOnly?: boolean;
  /**
   * F20: threads waiting for a usage-limit reset, epoch ms of the
   * scheduled auto-resume. EPHEMERAL — never persisted; a restart drops
   * the wait exactly like the frozen Task-based scheduler does.
   */
  limitResumesAt?: Record<string, number>;
  /**
   * F29: true while the main process holds an OS sleep-prevention token
   * (a task is running AND taskSleepMode is not off). Diagnostic mirror
   * of the main-side blocker state — the token itself is never exposed.
   */
  sleepPreventionActive?: boolean;
  /**
   * F05: per-provider slash-command recency (most-recent-first), the
   * ordering input for the composer suggestion menu. Omitted while no
   * command has ever been used.
   */
  recentCommands?: Record<string, string[]>;
  /**
   * F19: recorded AI-token spend per local day ("yyyy-MM-dd" → tokens),
   * the Token activity heatmap's only input. Always present — an empty
   * map honestly means nothing recorded yet.
   */
  tokenActivity: Record<string, number>;
}

/** Embedded terminal slice (P2E). Ephemeral by design — nothing below is
 *  ever persisted to the store. */

export type TerminalState =
  | "starting"
  | "running"
  | "exited"
  | "error"
  | "closing"
  | "unavailable";

export interface TerminalInfo {
  /** Opaque id chosen by main; renderer never derives paths/commands from it. */
  id: string;
  threadId: string;
  /** Tab label, e.g. "Terminal 1". */
  title: string;
  state: TerminalState;
  /** Fences everything below: every restart increments it and any
   *  data/exit/input addressed to an older value is dropped. */
  incarnation: number;
  /** Authorized canonical directory the shell was spawned in (display hint). */
  cwd?: string;
  /** PTY owner-process pid — diagnostics only. */
  pid?: number;
  exitCode?: number;
  signal?: number;
  /** Human- or code-level reason for error/unavailable states. */
  reason?: string;
}

/** terminals:create result — either a live session or an honest reason the
 *  slice could not start one (unbound project, lost directory, capacity,
 *  unsupported platform). Schema violations still throw before this. */
export interface TerminalCreateResult {
  terminal?: TerminalInfo;
  unavailable?: string;
}

/** terminals:select result — full info plus the bounded output tail the
 *  renderer replays when (re)attaching an xterm instance. */
export interface TerminalAttach {
  info: TerminalInfo;
  /** Output bytes retained by main (bounded, see terminalService). */
  tail: string;
  /** Sequence of the first chunk retained in `tail`. */
  tailFromSeq: number;
  /** Sequence of the last chunk inside `tail` — live chunks with seq <= this
   *  are already covered and must be dropped on attach. */
  tailEndSeq: number;
}

/** Read-only Git panel (P2F). Snapshots are captured inside a controlled
 *  ephemeral git-dir; nothing below is persisted and no path/executable/
 *  command from the renderer can ever reach Git. */

export type GitEntryKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "untracked";

export interface GitStatusEntry {
  /** Opaque per-snapshot id — the renderer can never derive a path from it. */
  id: string;
  /** Repo-relative display path (post-rename path). Newlines/Unicode kept. */
  path: string;
  /** Source path for renames/copies. */
  origPath?: string;
  kind: GitEntryKind;
  /** XY codes from porcelain v2 (staged / worktree side). */
  staged: string;
  unstaged: string;
  unmerged: boolean;
  untracked: boolean;
  /** Which diff sides the slice may produce for this entry. */
  canDiffStaged: boolean;
  canDiffWorktree: boolean;
}

export interface GitBranchInfo {
  /** Branch short name; null while detached. */
  name: string | null;
  detached: boolean;
  /** True when HEAD points at a ref with no commits yet. */
  unborn: boolean;
  oid?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

/** F11 branch menu (frozen GitBranch): a local ref row for the picker's
 *  switch section; upstream marks a pushed branch. */
export interface GitBranchRow {
  name: string;
  isCurrent: boolean;
  upstream?: string;
}

export type BranchListResult =
  | { kind: "ready"; branches: GitBranchRow[]; detached: boolean }
  | { kind: "unavailable"; reason: string };

/** Frozen checkBranchName outcome — `rejected("")` is the frozen
 *  "empty/unchanged name closes quietly" case. */
export type BranchNameCheck =
  | { kind: "ok"; name: string }
  | { kind: "rejected"; reason: string }
  | { kind: "pushed"; name: string; upstream: string };

export type BranchOpResult =
  | { kind: "ok"; branch: string; oldBranch?: string }
  | { kind: "rejected"; reason: string }
  | { kind: "pushed"; name: string; upstream: string }
  | { kind: "unavailable"; reason: string };

/** "ready" carries entries+branch (possibly empty — a clean repository);
 *  the other kinds are honest terminal states with a `reason` code. */
export interface GitSnapshot {
  snapshotId: string;
  projectId: string;
  capturedAt: number;
  kind: "ready" | "not-repository" | "unsupported" | "unavailable";
  branch?: GitBranchInfo;
  entries: GitStatusEntry[];
  /** F13: `git remote get-url origin` — absent when the repository has no
   *  configured origin; never partially guessed. */
  remoteUrl?: string;
  /** Limitation codes: "filters" — configured content helpers exist so
   *  worktree comparisons are refused; "entries-truncated" — the 5000
   *  entry cap was reached. */
  limitations: string[];
  reason?: string;
}

export type GitDiffSide = "staged" | "worktree";

export interface GitDiffResult {
  snapshotId: string;
  entryId: string;
  side: GitDiffSide;
  kind: "text" | "binary" | "oversized" | "empty" | "unavailable";
  patch?: string;
  reason?: string;
}
