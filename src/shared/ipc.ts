// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Explicit IPC contract: the only channels the preload bridge may expose and
// the only payload shapes main will accept. There is intentionally no channel
// that executes a raw command or opens an arbitrary path.

import {
  vArray,
  vBlob,
  vBoolean,
  vEnum,
  vId,
  vInt,
  vMaxString,
  vNonEmptyString,
  vNullable,
  vNumber,
  vObject,
  vOptional,
  vString,
  ValidationError,
  type Validator,
} from "./validate";
import { THEME_IDS, type LanguageId } from "./types";
import { SHORTCUT_COMMANDS, type KeyChord } from "./shortcuts";
import type { ModelPreference } from "./modelList";

// F27 shortcut overrides: command ids only, chord|null values (frozen
// Override shape — a stored null clears the binding).
// F21 Hydra pairs — same persisted shape as storeDoc's vHydraPair; kept
// local to the IPC contract like every other payload validator.
const vHydraHeadProfile = vObject({
  id: vNonEmptyString(120),
  name: vNonEmptyString(200),
  provider: vOptional(vNonEmptyString(100)),
  model: vOptional(vNonEmptyString(200)),
  effort: vOptional(vNonEmptyString(100)),
});

const vHydraPair = vObject({
  id: vNonEmptyString(120),
  provider: vNonEmptyString(100),
  orchestratorModel: vOptional(vNonEmptyString(200)),
  orchestratorEffort: vOptional(vNonEmptyString(100)),
  workerProvider: vOptional(vNonEmptyString(100)),
  workerModel: vOptional(vNonEmptyString(200)),
  workerEffort: vOptional(vNonEmptyString(100)),
  maxHeads: vOptional(vInt(1, 8)),
  name: vOptional(vMaxString(200)),
  headProfiles: vArray(vHydraHeadProfile, 32),
});

// F17 model-list slices — same persisted shape as storeDoc; pins only
// organize the picker, the catalog stays provider-owned.
const vModelPin = vObject({
  provider: vEnum(["codex"] as const),
  modelID: vNonEmptyString(200),
});
const vModelSection = vObject({
  id: vNonEmptyString(40),
  name: vNonEmptyString(200),
  position: vInt(0, 1000),
});
const vModelPreferences: Validator<Record<string, ModelPreference>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  const pref = vObject({
    effort: vOptional(vNonEmptyString(100)),
    fastMode: vOptional(vBoolean),
  });
  const out: Record<string, ModelPreference> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (!/^[a-z]+\/.{1,200}$/.test(key))
      throw new ValidationError(`bad model preference key "${key}"`);
    out[key] = pref(val);
  }
  return out;
};

// F18: frozen MCP connections — stdio only in this slice. The same
// shape validates both settings writes and mcp:probe payloads.
const vMcpEnv: Validator<Record<string, string>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  if (Object.keys(rec).length > 64) throw new ValidationError("env exceeds 64 entries");
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      throw new ValidationError(`bad env key "${key}"`);
    out[key] = vMaxString(4000)(val);
  }
  return out;
};
// A73: HTTP header map for MCP servers — RFC 7230 token names, bounded.
const vMcpHeaders: Validator<Record<string, string>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  if (Object.keys(rec).length > 32) throw new ValidationError("headers exceed 32 entries");
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(key))
      throw new ValidationError(`bad header name "${key}"`);
    const s = vMaxString(2000)(val);
    if (/[\r\n]/.test(s)) throw new ValidationError(`bad header value "${key}"`);
    out[key] = s;
  }
  return out;
};

const vMcpServer = vObject({
  id: vNonEmptyString(120),
  name: vNonEmptyString(200),
  transport: vOptional(vEnum(["stdio", "http"] as const)),
  // Empty is allowed at the schema edge — HTTP entries carry no
  // command; the probe reports "missing" for a stdio entry without one.
  command: vMaxString(4000),
  args: vArray(vMaxString(4000), 64),
  env: vOptional(vMcpEnv),
  url: vOptional(vMaxString(2000)),
  headers: vOptional(vMcpHeaders),
});

const vChordPayload = vObject({
  key: vNonEmptyString(40),
  mod: vBoolean,
  ctrl: vBoolean,
  alt: vBoolean,
  shift: vBoolean,
});
const vShortcuts: Validator<Record<string, KeyChord | null>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  const out: Record<string, KeyChord | null> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (!(SHORTCUT_COMMANDS as readonly string[]).includes(key))
      throw new ValidationError(`unknown shortcut command "${key}"`);
    out[key] = val === null ? null : vChordPayload(val);
  }
  return out;
};

export const REQUEST_CHANNELS = [
  "state:get",
  "app:info",
  "window:focus",
  "projects:create",
  "projects:open-directory",
  "projects:toggle",
  "projects:set-icon",
  "projects:delete",
  "projects:set-shelved",
  "quick:show",
  "quick:hide",
  "quick:state",
  "quick:send",
  "quick:expand",
  "projects:scripts:set",
  "scripts:run",
  "threads:create",
  "threads:select",
  "threads:spawn-helper",
  "threads:close-helper",
  "threads:rename",
  "threads:delete",
  "threads:delete-archived",
  "threads:archive",
  "threads:unarchive",
  "threads:set-runtime-mode",
  "threads:set-pinned",
  "threads:set-hydra",
  "threads:set-interaction-mode",
  "threads:forward",
  "threads:revert",
  "threads:revert-preview",
  "threads:resend",
  "threads:create-worktree",
  "threads:remove-worktree",
  "threads:compact",
  "slash:record",
  "attachments:pick",
  "attachments:add-blob",
  "attachments:read",
  "attachments:remove",
  "mention:search",
  "downloads:list",
  "downloads:attach",
  "downloads:reveal",
  "threads:reorder",
  "threads:move-affiliation",
  "projects:reorder",
  "folder:reveal",
  "worktrees:reveal",
  "folder:copy",
  "openin:editors",
  "openin:open",
  "openin:reveal",
  "turns:send",
  "turns:cancel",
  "approvals:resolve",
  "settings:set",
  "links:open-external",
  "terminals:list",
  "terminals:create",
  "terminals:select",
  "terminals:input",
  "terminals:resize",
  "terminals:close",
  "terminals:restart",
  "terminals:ack",
  "git:overview",
  "git:refresh",
  "git:diff",
  "git:working-changes",
  "git:commit",
  "git:push",
  "git:commit-message",
  "git:branches",
  "git:switch-branch",
  "git:create-branch",
  "git:rename-branch",
  "checkpoints:list",
  "checkpoints:preview",
  "checkpoints:restore",
  "checkpoints:diff",
  "checkpoints:changes",
  "checkpoints:changes-diff",
  "codex:setup-state",
  "codex:choose",
  "codex:save",
  "codex:clear",
  "control:status",
  "control:retry",
  "cli:status",
  "cli:install",
  "cli:uninstall",
  "models:list",
  "mcp:probe",
  "mcp:pick",
  "wallpaper:choose",
  "wallpaper:install",
  "wallpaper:remove",
  "wallpaper:softness",
  "wallpaper:data",
  "hydra:catalog",
  "hydra:stop",
  "threads:set-model",
  "questions:answer",
  "followUps:enqueue",
  "followUps:remove",
  "followUps:update",
  "followUps:move",
  "followUps:bundle",
  "followUps:unbundle",
  "followUps:send-now",
  "followUps:interrupt-send",
  "limit:cancel",
  "limit:handoff",
  "forge:probe",
] as const;

export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export const EVENT_CHANNEL = "tivano:event";

const vTheme = vEnum(THEME_IDS);
const vLanguage = vEnum(["en", "zh-Hans"] as const satisfies readonly LanguageId[]);

/** Bounded dynamic record {questionId: answer[]} — the ONLY map-shaped
 *  payload in the contract. Question ids are re-validated against the
 *  presented request in main, so this schema bounds shape, not identity. */
const vAnswers: Validator<Record<string, string[]>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length > 8) throw new ValidationError("too many answers");
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > 200)
      throw new ValidationError(`answer key oversized`);
    const list = rec[key];
    if (!Array.isArray(list) || list.length > 16)
      throw new ValidationError(`field "${key}": expected bounded string array`);
    const vals: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" || item.length === 0 || item.length > 2000)
        throw new ValidationError(`field "${key}": answer oversized or not a string`);
      vals.push(item);
    }
    out[key] = vals;
  }
  return out;
};

export const requestValidators = {
  "state:get": vObject({}),
  "app:info": vObject({}),
  // F27 "Show Tivano" — no payload; main focuses the main window.
  "window:focus": vObject({}),
  "projects:create": vObject({ name: vNonEmptyString(120) }),
  // Deliberately EMPTY: the renderer can ask for the chooser but can never
  // name a path — the selected directory arrives only from main's dialog.
  "projects:open-directory": vObject({}),
  "projects:toggle": vObject({ id: vId, expanded: vBoolean }),
  // F01: emoji mark verbatim (sanitizeIcon shape) or null to clear back
  // to the folder mark — the frozen Folder tile sends the clear.
  "projects:set-icon": vObject({ id: vId, icon: vNullable(vNonEmptyString(32)) }),
  "projects:set-shelved": vObject({ id: vId, shelved: vBoolean }),
  "quick:show": vObject({}),
  "quick:hide": vObject({}),
  "quick:state": vObject({}),
  "quick:send": vObject({
    text: vNonEmptyString(4000),
    openApp: vBoolean,
    model: vOptional(vNullable(vNonEmptyString(160))),
  }),
  "quick:expand": vObject({ text: vString }),
  "projects:delete": vObject({ id: vId }),
  "threads:create": vObject({
    projectId: vNullable(vId),
    title: vOptional(vNonEmptyString(200)),
    // F01: explicit-worktree callers opt out of the default-workspace
    // kick — they own their own create-worktree call (frozen
    // newThread(affiliation:workspace:) single-worktree semantics).
    applyWorkspaceDefault: vOptional(vBoolean),
    // F01: "the ordinary new-thread action" — main resolves the frozen
    // newThreadLocation default against ITS current settings, so a chord
    // fired mid-apply can never read a stale location. projectId then
    // acts as the "recent" hint only.
    locationDefault: vOptional(vBoolean),
  }),
  "threads:select": vObject({ id: vNullable(vId) }),
  // F25: a merge/PR link hands its brief to the parent's helper chat
  // (frozen spawnSubagent); closing the panel drops it to the sidebar.
  "threads:spawn-helper": vObject({
    parentId: vId,
    title: vNonEmptyString(200),
    prompt: vNonEmptyString(8000),
  }),
  "threads:close-helper": vObject({ id: vId }),
  "threads:rename": vObject({ id: vId, title: vNonEmptyString(200) }),
  "threads:delete": vObject({ id: vId }),
  // F02: frozen deleteArchivedThreads(ids:) — the renderer sends the set
  // it shows; the engine intersects with actually-archived threads, so
  // an id that is not archived is simply not deleted by this channel.
  "threads:delete-archived": vObject({ ids: vArray(vId, 512) }),
  "threads:archive": vObject({ id: vId }),
  "threads:unarchive": vObject({ id: vId }),
  "threads:set-runtime-mode": vObject({
    threadId: vId,
    mode: vEnum(["supervised", "autoAcceptEdits", "auto", "fullAccess"] as const),
  }),
  "threads:set-pinned": vObject({ threadId: vId, pinned: vBoolean }),
  "threads:set-hydra": vObject({ threadId: vId, enabled: vBoolean }),
  "threads:set-interaction-mode": vObject({
    threadId: vId,
    mode: vEnum(["build", "plan"] as const),
  }),
  "threads:forward": vObject({ threadId: vId }),
  // F09 (frozen ThreadRuntime.revert/resend, bounded): rewind the
  // conversation to before a turn — files are kept (in-place checkpoint
  // restore stays disabled), the provider history restarts fresh.
  "threads:revert": vObject({ threadId: vId, turnId: vId }),
  "threads:revert-preview": vObject({ threadId: vId, turnId: vId }),
  "threads:resend": vObject({
    threadId: vId,
    turnId: vId,
    text: vNonEmptyString(32000),
  }),
  "threads:compact": vObject({ threadId: vId }),
  "slash:record": vObject({ name: vNonEmptyString(64) }),
  "attachments:pick": vObject({ threadId: vId }),
  // F05 paste/drop: the renderer ships the bytes it already holds
  // (clipboard/drop File objects) — never a path, which stays
  // renderer-unreachable by design. Same bounds as the picker flow.
  "attachments:add-blob": vObject({
    threadId: vId,
    files: vArray(
      vObject({ name: vNonEmptyString(500), data: vBlob(64 * 1024 * 1024) }),
      32,
    ),
  }),
  // A80 preview: the renderer names an attachment it can already see —
  // main resolves the library copy and returns display bytes for
  // images only; paths never cross.
  "attachments:read": vObject({ threadId: vId, id: vNonEmptyString(120) }),
  "attachments:remove": vObject({ threadId: vId, id: vNonEmptyString(120) }),
  // F05 @-mention: the renderer names a thread and a query only — main
  // resolves the thread's working directory and returns relative paths.
  "mention:search": vObject({
    threadId: vId,
    query: vMaxString(500),
  }),
  // F05 downloads popover: listing, id-scoped attach, folder reveal.
  // The renderer never sees or supplies a path.
  "downloads:list": vObject({}),
  "downloads:attach": vObject({
    threadId: vId,
    ids: vArray(vNonEmptyString(60), 15),
  }),
  "downloads:reveal": vObject({}),
  "threads:reorder": vObject({ id: vId, targetId: vId, placeAfter: vBoolean }),
  "threads:move-affiliation": vObject({ id: vId, projectId: vNullable(vId) }),
  "projects:reorder": vObject({ id: vId, targetId: vId, placeAfter: vBoolean }),
  "folder:reveal": vObject({ threadId: vId }),
  // A75: reveal the app-owned worktree root — no payload, the path is
  // engine-derived (frozen SourceControlSettingsPage "Worktrees · Reveal").
  "worktrees:reveal": vObject({}),
  "folder:copy": vObject({ threadId: vId }),
  // F15 "Open in" — the renderer supplies ids only; main resolves the
  // directory and the editor, so no path or command crosses the boundary.
  "openin:editors": vObject({}),
  "openin:open": vObject({ threadId: vId, editorId: vNonEmptyString(60) }),
  "openin:reveal": vObject({
    threadId: vOptional(vId),
    projectId: vOptional(vId),
  }),
  // Empty-allowed: an attachment-carried send (F05) arrives with no
  // typed text; the engine refuses empty turns with nothing attached.
  "turns:send": vObject({ threadId: vId, text: vMaxString(16000) }),
  "turns:cancel": vObject({ threadId: vId }),
  "approvals:resolve": vObject({ threadId: vId, approvalId: vId, optionId: vString }),
  "settings:set": vObject({
    theme: vOptional(vTheme),
    language: vOptional(vLanguage),
    notifyOnDone: vOptional(vBoolean),
    // F28: frozen chimeWhenFinished (default on) — a soft chime when a
    // turn finishes, whether or not the thread is in view.
    chimeWhenFinished: vOptional(vBoolean),
    autoContinueAfterLimit: vOptional(vBoolean),
    confirmBeforeDeleting: vOptional(vBoolean),
    // F05: the attach button offers recent downloads first (frozen
    // recentDownloadsPicker, default true).
    recentDownloadsPicker: vOptional(vBoolean),
    // F01: frozen General defaults — new-thread location, runtime mode,
    // workspace mode, thinking visibility, working-line style.
    newThreadLocation: vOptional(vEnum(["recent", "standalone"] as const)),
    defaultRuntimeMode: vOptional(
      vEnum(["supervised", "autoAcceptEdits", "auto", "fullAccess"] as const),
    ),
    defaultWorkspaceMode: vOptional(vEnum(["local", "worktree"] as const)),
    showReasoning: vOptional(vBoolean),
    showsWorkingCard: vOptional(vBoolean),
    // F26: strips rendered effects for lowest GPU usage (frozen
    // performanceMode, default false).
    performanceMode: vOptional(vBoolean),
    // F26: sidebar weather hero (frozen showsSkylight, default true).
    showsSkylight: vOptional(vBoolean),
    // F33: CLI install receipt (frozen cliInstallationTarget) — the shim
    // target path; the settings:set patch clears it with null.
    cliInstallationTarget: vOptional(vNullable(vNonEmptyString(4000))),
    taskSleepMode: vOptional(vEnum(["off", "system", "display"] as const)),
    textGeneration: vOptional(vEnum(["automatic", "off"] as const)),
    threadTitles: vOptional(vEnum(["once", "updated"] as const)),
    autoShelveDays: vOptional(vInt(0, 14)),
    quickChatEnabled: vOptional(vBoolean),
    shelvedGroupName: vOptional(vNullable(vNonEmptyString(60))),
    // F13: free-form commit-message guidance (frozen commitInstructions).
    commitInstructions: vOptional(vMaxString(4096)),
    // F27: whole overrides map (id → chord|null); structural shape only —
    // the refusal/conflict rules live in the recorder + shortcut model.
    shortcuts: vOptional(vShortcuts),
    // F31: frozen antiSlopEnabled toggle ("Concise AI replies").
    antiSlopEnabled: vOptional(vBoolean),
    // F33: double gate — both must be true before the socket listens.
    alphaEnabled: vOptional(vBoolean),
    externalControlEnabled: vOptional(vBoolean),
    // F26: per-category absolute sizes; frozen ranges enforced at write.
    fontSizes: vOptional(
      vObject({
        ui: vOptional(vInt(12, 18)),
        content: vOptional(vInt(12, 18)),
        code: vOptional(vInt(11, 17)),
      }),
    ),
    // F21 Hydra configuration — booleans write verbatim; the caps carry
    // null for "no cap" (frozen removeObject parity) and clamp to 1..8.
    hydraEnabled: vOptional(vBoolean),
    hydraDefaultEnabled: vOptional(vBoolean),
    hydraQueueHeads: vOptional(vBoolean),
    hydraAlwaysHeads: vOptional(vBoolean),
    hydraIsolateHeads: vOptional(vBoolean),
    hydraMaxHeads: vOptional(vNullable(vInt(1, 8))),
    hydraAutoMerge: vOptional(vBoolean),
    hydraReviewHeads: vOptional(vBoolean),
    hydraArchivesCodexHeads: vOptional(vBoolean),
    hydraShowsHeadDetails: vOptional(vBoolean),
    hydraAutoPopsHeads: vOptional(vBoolean),
    hydraTempersHeadEffort: vOptional(vBoolean),
    hasSeenHydraIntro: vOptional(vBoolean),
    hydraPairs: vOptional(vArray(vHydraPair, 64)),
    lastHydraPairId: vOptional(vNullable(vNonEmptyString(120))),
    // F17: frozen modelList / modelSections / collapsedModelSections /
    // modelPreferences — whole-array writes (layout ops are computed
    // renderer-side via shared/modelList.ts, then persisted wholesale).
    modelList: vOptional(vArray(vModelPin, 30)),
    modelSections: vOptional(vArray(vModelSection, 60)),
    collapsedModelSections: vOptional(vArray(vNonEmptyString(40), 60)),
    modelPreferences: vOptional(vModelPreferences),
    // F18: local MCP server registry (stdio slice only).
    mcpServers: vOptional(vArray(vMcpServer, 32)),
    // F26: the transparency slider is a plain user preference — the
    // wallpaper FILE slot is deliberately absent here (dedicated
    // wallpaper:* channels own it; the renderer never names a path).
    backdropOpacity: vOptional(vNumber(0, 1)),
    // F25: user-dragged helper-panel size (frozen panelSize).
    helperPanelSize: vOptional(
      vObject({ width: vInt(200, 4000), height: vInt(140, 4000) }),
    ),
    // A81: edge-dragged sidebar width (frozen SidebarLayout, 210–440).
    sidebarWidth: vOptional(vNumber(210, 440)),
    // A81: top-edge-dragged terminal drawer height (frozen 140–760).
    terminalHeight: vOptional(vNumber(140, 760)),
  }),
  "links:open-external": vObject({ url: vNonEmptyString(2048) }),
  // Embedded terminal. No shell/command/path keys exist anywhere in these
  // schemas — main derives shell and cwd from the authorized grant alone.
  "terminals:list": vObject({ threadId: vId }),
  "terminals:create": vObject({
    threadId: vId,
    cols: vInt(2, 500),
    rows: vInt(2, 200),
  }),
  "terminals:select": vObject({ terminalId: vId }),
  "terminals:input": vObject({
    terminalId: vId,
    incarnation: vInt(1, Number.MAX_SAFE_INTEGER),
    data: vNonEmptyString(65536),
  }),
  "terminals:resize": vObject({
    terminalId: vId,
    incarnation: vInt(1, Number.MAX_SAFE_INTEGER),
    cols: vInt(2, 500),
    rows: vInt(2, 200),
  }),
  "terminals:close": vObject({ terminalId: vId }),
  "terminals:restart": vObject({ terminalId: vId }),
  "terminals:ack": vObject({
    terminalId: vId,
    incarnation: vInt(1, Number.MAX_SAFE_INTEGER),
    seq: vInt(1, Number.MAX_SAFE_INTEGER),
  }),
  // Read-only Git panel. No path, revision, executable or argument fields
  // exist — main resolves opaque ids back to captured snapshot state only.
  "git:overview": vObject({ projectId: vId }),
  "git:refresh": vObject({ projectId: vId }),
  "git:diff": vObject({
    projectId: vId,
    snapshotId: vId,
    entryId: vId,
    side: vEnum(["staged", "worktree"] as const),
  }),
  // F13 commit flow — project identity + the message + a push flag. No
  // path, revision, remote or executable crosses the boundary; staging is
  // always `add -A` and the message is written main-side to a
  // service-owned file (the runner never pipes stdin).
  "git:working-changes": vObject({ projectId: vId }),
  "git:commit": vObject({
    projectId: vId,
    message: vMaxString(262_144),
    pushAfter: vBoolean,
  }),
  "git:push": vObject({ projectId: vId }),
  "git:commit-message": vObject({ projectId: vId }),
  // Checkpoint restore PREVIEW. Only thread/turn identity crosses the
  // boundary — checkpoint ids, repository roots and touched paths are
  // resolved from the durable ledger inside main, never from the caller.
  "checkpoints:list": vObject({ threadId: vId }),
  "checkpoints:preview": vObject({ threadId: vId, turnId: vId }),
  "checkpoints:restore": vObject({ threadId: vId, turnId: vId }),
  // Per-turn diff — the path is validated main-side against the
  // ledger's touched set; it can never address an arbitrary file.
  "checkpoints:diff": vObject({ threadId: vId, turnId: vId, path: vMaxString(1024) }),
  "checkpoints:changes": vObject({ threadId: vId }),
  "checkpoints:changes-diff": vObject({ threadId: vId, path: vMaxString(1024) }),
  // F11 worktree: the renderer may suggest a branch name — it is
  // re-validated by git check-ref-format main-side. The directory is
  // ALWAYS main-chosen; no path crosses this boundary.
  "threads:create-worktree": vObject({ threadId: vId, branch: vOptional(vMaxString(240)) }),
  // F11 branch menu — thread-scoped; main resolves the execution
  // directory, the renderer never names one.
  "git:branches": vObject({ threadId: vId }),
  "git:switch-branch": vObject({ threadId: vId, name: vNonEmptyString(240) }),
  "git:create-branch": vObject({ threadId: vId, name: vNonEmptyString(240) }),
  "git:rename-branch": vObject({
    threadId: vId,
    name: vNonEmptyString(240),
    confirmedPushed: vOptional(vBoolean),
  }),
  "threads:remove-worktree": vObject({ threadId: vId }),
  // F12 project scripts: the editor replaces the whole bounded list;
  // running names ONLY thread+script identity — the command itself is
  // resolved from the persisted project record inside main and is typed
  // into a sterile-shell terminal, never spawned by main directly.
  "projects:scripts:set": vObject({
    projectId: vId,
    scripts: vArray(
      vObject({
        id: vOptional(vMaxString(120)),
        name: vMaxString(160),
        command: vMaxString(4000),
        icon: vOptional(vMaxString(60)),
        runOnWorktreeCreate: vOptional(vBoolean),
      }),
      32,
    ),
  }),
  "scripts:run": vObject({ threadId: vId, scriptId: vId }),
  "limit:cancel": vObject({ threadId: vId }),
  "limit:handoff": vObject({ threadId: vId }),
  // F13 detection slice: which forge CLIs the merge/PR handoffs could
  // run. Empty payload — the renderer can ask for a probe, never name a
  // binary, argv or env. Presence + --version only; sign-in state is
  // never probed and no credential command (`gh auth token`…) is run.
  "forge:probe": vObject({}),
  // Codex setup — every payload deliberately EMPTY: the renderer can ask
  // for the chooser/save/clear but can never name a path, argv or env.
  // The selected path arrives only from main's native dialog result.
  "codex:setup-state": vObject({}),
  // F33 local control: status read + retry — empty payloads, the socket
  // itself is never reachable through IPC (Unix socket only).
  "control:status": vObject({}),
  "control:retry": vObject({}),
  // F33 CLI install surface — bounded: no paths cross the bridge; main
  // owns dir/target resolution and reports honest state back.
  "cli:status": vObject({}),
  "cli:install": vObject({}),
  "cli:uninstall": vObject({}),
  "codex:choose": vObject({}),
  "codex:save": vObject({}),
  "codex:clear": vObject({}),
  // Per-thread model/effort overrides (F17). Deliberately EMPTY for the
  // catalog read — the list is provider-owned state, never callable with
  // renderer-supplied filters. set-model carries bounded string-or-null
  // ids only; usability is the provider's call, never guessed locally.
  "models:list": vObject({}),
  // F18: probe an MCP server config (saved or draft) — real stdio spawn.
  "mcp:probe": vObject({
    transport: vOptional(vEnum(["stdio", "http"] as const)),
    command: vMaxString(4000),
    args: vArray(vMaxString(4000), 64),
    env: vOptional(vMcpEnv),
    url: vOptional(vMaxString(2000)),
    headers: vOptional(vMcpHeaders),
  }),
  // A74 frozen MCPKeyPanel pickPath: a path-kind catalog field's browse
  // button asks main for a native chooser — dirs only says whether a
  // folder or a file is wanted (frozen: filesystem → dirs, else files).
  "mcp:pick": vObject({ dirs: vBoolean }),
  // F26 wallpaper — the renderer picks through the OS dialog (empty
  // payload) or drops BYTES (name + data); it never supplies a path.
  "wallpaper:choose": vObject({}),
  "wallpaper:install": vObject({
    name: vNonEmptyString(400),
    data: vBlob(25 * 1024 * 1024),
  }),
  "wallpaper:remove": vObject({}),
  "wallpaper:softness": vObject({ softness: vNumber(0, 1) }),
  // Reads one installed library file back for display — basename only,
  // re-validated in main; a foreign path cannot pass the file regex.
  "wallpaper:data": vObject({ file: vNonEmptyString(200) }),
  // F21: read-only Hydra catalog view for the pair editor + cookbook —
  // renderer never names a provider/model id it wasn't shown.
  "hydra:catalog": vObject({}),
  // F22: stop a running head — renderer names only the opaque thread id
  // it was shown in the Hydra panel.
  "hydra:stop": vObject({ threadId: vId }),
  "threads:set-model": vObject({
    threadId: vId,
    model: vNullable(vNonEmptyString(200)),
    effort: vNullable(vNonEmptyString(100)),
    fastTier: vNullable(vNonEmptyString(100)),
  }),
  // Codex question card. The renderer names only the opaque providerKey
  // it was SHOWN plus bounded answer strings — never raw RPC content,
  // paths, commands or provider ids. `answers` is a bounded dynamic map
  // {questionId: string[]}; the adapter re-validates every key against
  // the validated question set before anything reaches the wire.
  "questions:answer": vObject({
    threadId: vId,
    providerKey: vNonEmptyString(300),
    answers: vAnswers,
  }),
  // F08 follow-up queue. Item ids are re-validated against the thread's
  // own queue in main; item text bounds match the queue's, not a turn's.
  "followUps:enqueue": vObject({ threadId: vId, text: vNonEmptyString(8000) }),
  "followUps:remove": vObject({ threadId: vId, id: vId }),
  "followUps:update": vObject({ threadId: vId, id: vId, text: vNonEmptyString(8000) }),
  "followUps:move": vObject({ threadId: vId, id: vId, targetId: vId, after: vBoolean }),
  "followUps:bundle": vObject({ threadId: vId, id: vId, ontoId: vId }),
  "followUps:unbundle": vObject({ threadId: vId, id: vId }),
  "followUps:send-now": vObject({ threadId: vId, id: vId }),
  "followUps:interrupt-send": vObject({ threadId: vId, text: vNonEmptyString(16000) }),
} as const;

export type RequestPayload<C extends RequestChannel> = ReturnType<
  (typeof requestValidators)[C]
>;

/** Events main pushes to the renderer over EVENT_CHANNEL. The engine
 * stamps each broadcast with a monotonic `rev`; the state:get snapshot
 * reports its own boundary so the renderer can drop events it already
 * contains instead of replaying them. */
export type AppEvent = AppEventPayload & { rev?: number };

type AppEventPayload =
  | { type: "snapshot"; snapshot: import("./types").Snapshot }
  /** v2.2.34 quick chat: expand carries the draft into the main
   *  composer's selected thread (frozen "expand" button). */
  | { type: "quick-draft"; text: string }
  | { type: "project-added"; project: import("./types").Project }
  | { type: "project-updated"; project: import("./types").Project }
  | { type: "project-removed"; projectId: string }
  | { type: "thread-added"; thread: import("./types").ChatThread }
  | { type: "thread-updated"; thread: import("./types").ChatThread }
  | { type: "thread-removed"; threadId: string }
  | { type: "thread-selected"; threadId: string | null }
  | { type: "settings-changed"; settings: import("./types").Settings }
  | {
      type: "turn-chunk";
      threadId: string;
      turnId: string;
      seq: number;
      /** Append-delta (mock/synthetic stream). */
      delta?: string;
      /** Whole-content replacement (Codex deduplicated composition). */
      content?: string;
    }
  | {
      type: "turn-status";
      threadId: string;
      turnId: string;
      status: import("./types").TurnStatus;
      error?: string;
    }
  | {
      type: "approval-requested";
      threadId: string;
      turnId: string;
      approval: import("./types").ApprovalRequest;
    }
  | {
      type: "approval-resolved";
      threadId: string;
      turnId: string;
      approval: import("./types").ApprovalRequest;
    }
  | { type: "app-state"; readOnly: boolean }
  | { type: "terminal-state"; terminal: import("./types").TerminalInfo }
  | {
      type: "terminal-data";
      terminalId: string;
      incarnation: number;
      seq: number;
      data: string;
    }
  | { type: "terminal-removed"; terminalId: string }
  | { type: "git-snapshot"; snapshot: import("./types").GitSnapshot }
  | { type: "checkpoints-changed"; threadId: string }
  | { type: "limit-wait"; threadId: string; resumeAt: number }
  | { type: "limit-wait-ended"; threadId: string }
  | {
      /** F28 frozen turnFinished: emitted once when a turn reaches a real
       *  end. `chime` — play the finish chime (setting on, real result,
       *  not user-stopped, nothing still working). `notify` — the result
       *  kind a notification MAY surface once the renderer confirms the
       *  thread is off screen; `silent` when the chime already sounded. */
      type: "finish-signal";
      threadId: string;
      status: import("./types").Turn["status"];
      chime: boolean;
      notify: "done" | "stopped" | "failed" | null;
      silent: boolean;
    }
  | { type: "sleep-prevention-changed"; active: boolean }
  | {
      /** F01: a worktree the default-workspace rule kicked off failed —
       *  the thread still exists, bound to the plain project dir; the
       *  reason surfaces in the error banner, never silently. */
      type: "worktree-failed";
      threadId: string;
      reason: string;
    }
  | {
      type: "slash-recorded";
      recentCommands: Record<string, string[]>;
    };
