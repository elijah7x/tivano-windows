// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Full structural + relational validation of the persisted store document.
// A file written by a NEWER schema is refused (fail closed — never wipe a
// newer app's data); an older/unknown version or any structural violation is
// treated as corruption: the original bytes are preserved aside before a
// clean document is started.

import {
  vArray,
  vBoolean,
  vEnum,
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
} from "../shared/validate";
import { SHORTCUT_COMMANDS, type KeyChord } from "../shared/shortcuts";
import { MODEL_LIST_LIMIT, type ModelPreference } from "../shared/modelList";
import {
  SCHEMA_VERSION,
  THEME_IDS,
  type ChatThread,
  type StoreFile,
  type ThreadContinuation,
} from "../shared/types";

/** Persisted bytes we can recover from: corrupt or from an older schema. */
export class CorruptStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptStoreError";
  }
}

/** Persisted bytes we must never touch: written by a newer schema. */
export class NewerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewerStoreError";
  }
}

// Persistence capacity is deliberately separate from the IPC payload caps:
// a long legitimate history must never be declared corrupt. Capacity
// failures leave the original file untouched rather than resetting it.
const PERSIST_MAX_PROJECTS = 10_000;
const PERSIST_MAX_THREADS = 50_000;
const PERSIST_MAX_MESSAGES = 1_000_000; // per thread
const PERSIST_MAX_GRANTS = 10_000;
const PERSIST_MAX_FOLLOWUPS = 32; // per thread — bounded queue (F08)

const vTs = vNumber(0);
const vMessageRole = vEnum(["user", "assistant", "system"] as const);
const vMessageStatus = vEnum(["done", "streaming", "interrupted", "error", "denied", "cancelled"] as const);
const vApprovalStatus = vEnum(["pending", "resolved", "expired"] as const);
const vApprovalKind = vEnum(["command", "action", "plan"] as const);
const vApprovalRole = vEnum(["approve", "deny"] as const);
const vApprovalScope = vEnum(["once", "session", "always", "turn", "none"] as const);
const vTurnStatus = vEnum([
  "running",
  "waiting-approval",
  "done",
  "cancelled",
  "denied",
  "error",
  "interrupted",
] as const);

const vApprovalOption = vObject({
  id: vNonEmptyString(120),
  title: vNonEmptyString(200),
  role: vApprovalRole,
  scope: vApprovalScope,
});

const vApproval = vObject({
  id: vNonEmptyString(120),
  turnId: vNonEmptyString(120),
  kind: vApprovalKind,
  headline: vNonEmptyString(300),
  title: vNonEmptyString(4000),
  detail: vOptional(vString),
  reason: vOptional(vString),
  symbol: vString,
  options: vArray(vApprovalOption, 16),
  status: vApprovalStatus,
  resolvedOptionId: vOptional(vString),
  autoResolved: vOptional(vBoolean),
  providerKey: vOptional(vNonEmptyString(300)),
});

const vQuestionChoice = vObject({
  label: vNonEmptyString(500),
  detail: vOptional(vNonEmptyString(2000)),
});
const vQuestion = vObject({
  id: vNonEmptyString(200),
  header: vNonEmptyString(300),
  prompt: vNonEmptyString(4000),
  choices: vArray(vQuestionChoice, 16),
  allowsOther: vBoolean,
  isSecret: vBoolean,
});
const vQuestionRequest = vObject({
  providerKey: vNonEmptyString(300),
  questions: vArray(vQuestion, 8),
  status: vEnum(["pending", "answered", "expired"] as const),
});

const vTurn = vObject({
  id: vNonEmptyString(120),
  threadId: vNonEmptyString(120),
  status: vTurnStatus,
  seq: vInt(0, Number.MAX_SAFE_INTEGER),
  startedAt: vTs,
  endedAt: vOptional(vTs),
  error: vOptional(vString),
  approval: vOptional(vApproval),
  question: vOptional(vQuestionRequest),
  assistantMessageId: vNonEmptyString(120),
});

const vMessage = vObject({
  id: vNonEmptyString(120),
  role: vMessageRole,
  content: vString,
  status: vMessageStatus,
  ts: vTs,
  turnId: vOptional(vString),
  kind: vOptional(vEnum(["reasoning", "plan", "todos", "tool", "notice"] as const)),
  noticeLevel: vOptional(vEnum(["info", "warning", "error"] as const)),
  steps: vOptional(
    vArray(
      vObject({
        text: vNonEmptyString(500),
        status: vEnum(["pending", "active", "done"] as const),
      }),
      50,
    ),
  ),
  tool: vOptional(
    vObject({
      kind: vEnum(["command", "read", "search", "edit", "mcp", "web", "agent", "other"] as const),
      title: vOptional(vString),
      titleKey: vOptional(vNonEmptyString(120)),
      titleParams: vOptional(
        vArray(
          (v): string | number | null =>
            typeof v === "string" && v.length <= 500
              ? v
              : typeof v === "number" && Number.isFinite(v)
                ? v
                : null,
          8,
        ),
      ),
      detail: vOptional(vString),
      state: vEnum(["running", "completed", "failed", "declined"] as const),
    }),
  ),
  // F05 attachment display descriptors — optional so every pre-A29
  // store loads verbatim; paths never cross into the renderer.
  attachments: vOptional(
    vArray(
      vObject({
        id: vNonEmptyString(120),
        name: vNonEmptyString(500),
        size: vNumber(0),
      }),
      8,
    ),
  ),
  // F22 report-batch marker — roster indexes; pre-A68 stores load
  // verbatim (field absent → plain user message).
  hydraHeads: vOptional(vArray(vInt(0, 1000), 64)),
  // F22 head-brief marker — absent on every pre-A70 store (frozen
  // isHydraBrief); the pill render keys off its presence.
  hydraBrief: vOptional(vBoolean),
});

const vProviderThread = vObject({
  providerId: vEnum(["codex"] as const),
  codexThreadId: vNonEmptyString(200),
  cwd: vNonEmptyString(4000),
  codexHomeId: vNonEmptyString(4000),
  schemaPin: vNonEmptyString(120),
  cliVersion: vNonEmptyString(200),
  savedAt: vTs,
});

const vThread = vObject({
  id: vNonEmptyString(120),
  projectId: vNullable(vNonEmptyString(120)),
  title: vNonEmptyString(300),
  createdAt: vTs,
  updatedAt: vTs,
  messages: vArray(vMessage, PERSIST_MAX_MESSAGES),
  turn: vNullable(vTurn),
  sessionGrants: vArray(vString, PERSIST_MAX_GRANTS),
  providerThread: vOptional(vProviderThread),
  // Optional so every pre-F17 store loads verbatim. Structural check
  // only — the provider decides whether an id is usable.
  codexModel: vOptional(vNonEmptyString(200)),
  codexEffort: vOptional(vNonEmptyString(100)),
  codexServiceTier: vOptional(vNonEmptyString(100)),
  codexModelReported: vOptional(vNonEmptyString(200)),
  codexEffortReported: vOptional(vNonEmptyString(100)),
  // F08 queued follow-ups — bounded, optional for pre-F08 stores.
  followUps: vOptional(
    vArray(
      vObject({
        id: vNonEmptyString(120),
        text: vNonEmptyString(8000),
        createdAt: vTs,
        bundleId: vOptional(vNonEmptyString(120)),
      }),
      PERSIST_MAX_FOLLOWUPS,
    ),
  ),
  isArchived: vOptional(vBoolean),
  isPinned: vOptional(vBoolean),
  sortOrder: vOptional(vNumber()),
  hasUnread: vOptional(vBoolean),
  unreadStatus: vOptional(vEnum(["done", "error", "interrupted"] as const)),
  interactionMode: vOptional(vEnum(["build", "plan"] as const)),
  contextUsage: vOptional(
    vObject({
      usedTokens: vInt(0, Number.MAX_SAFE_INTEGER),
      windowTokens: vOptional(vInt(1, Number.MAX_SAFE_INTEGER)),
    }),
  ),
  // F11: thread-bound worktree directory — optional for pre-F11 stores.
  // The value is a path main created; re-verified live before any use.
  worktreeDir: vOptional(vNonEmptyString(2048)),
  continuation: vOptional((v): ThreadContinuation | undefined => {
    if (v === undefined) return undefined;
    const o = vObject({
      sourceThreadId: vNonEmptyString(120),
      sourceTitle: vNonEmptyString(500),
      createdAt: vTs,
      context: (x) => {
        const s = vString(x);
        if (s.length > 200_000)
          throw new ValidationError("string length out of range");
        return s;
      },
      isTruncated: vBoolean,
      sent: vBoolean,
    })(v);
    return o as ThreadContinuation;
  }),
  runtimeMode: vOptional(
    vEnum(["supervised", "autoAcceptEdits", "auto", "fullAccess"] as const),
  ),
  // F21: per-chat Hydra choice + chosen pair — inert until F22 scheduling.
  hydraEnabled: vOptional(vBoolean),
  hydraPairId: vOptional(vNonEmptyString(120)),
  // v2.2.34 keep-updated titles — see ChatThread.
  titleUserSet: vOptional(vBoolean),
  titleReviewTurns: vOptional(vInt(0, 1_000_000)),
  // F25: helper-chat binding (frozen parentThreadID / isInPanel).
  parentThreadId: vOptional(vNonEmptyString(120)),
  isInPanel: vOptional(vBoolean),
});


// F12 project scripts — bounded list; every row needs a command before
// it may persist (the editor refuses to save incomplete rows, and the
// loader drops any that slip through).
const vProjectScript = vObject({
  id: vNonEmptyString(120),
  name: vNonEmptyString(160),
  command: vMaxString(4000),
  icon: vNonEmptyString(60),
  runOnWorktreeCreate: vBoolean,
});
const PERSIST_MAX_SCRIPTS = 32;

const vProject = vObject({
  id: vNonEmptyString(120),
  name: vNonEmptyString(300),
  createdAt: vTs,
  expanded: vBoolean,
  // Canonical attached directory (display metadata — grant authority
  // lives in workspace-grants.json) + the last computed availability.
  directory: vOptional(vNonEmptyString(4000)),
  directoryStatus: vOptional(vEnum(["available", "unavailable"] as const)),
  scripts: vOptional(vArray(vProjectScript, PERSIST_MAX_SCRIPTS)),
  // F01 icon — emoji mark verbatim, absent = folder. sanitizeIcon-shaped:
  // short, no control characters; any emoji (catalogue or not) is allowed.
  icon: vOptional(vNonEmptyString(32)),
  // v2.2.x shelved projects — see Project.
  isShelved: vOptional(vBoolean),
  shelvedAt: vOptional(vTs),
});

// F27 keyboard shortcuts: only real command ids, only the physical-key
// chord shape; a null value clears the command's binding. Structural
// check — refusal/conflict rules are judged by the recorder, not here.
const vChord = vObject({
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
    out[key] = val === null ? null : vChord(val);
  }
  return out;
};

// F26 font sizes — absolute points per category, frozen ranges enforced
// at write time; unknown keys refuse (mirrors vShortcuts discipline).
const vFontSizes = vObject({
  ui: vOptional(vInt(12, 18)),
  content: vOptional(vInt(12, 18)),
  code: vOptional(vInt(11, 17)),
});

// F21 Hydra pairs — provider ids stay open strings (the frozen key space
// includes providers this build does not ship; readiness is a runtime
// question, not a persistence question). maxHeads bounded to the frozen
// 1..8 range.
const PERSIST_MAX_HYDRA_PAIRS = 64;
const PERSIST_MAX_HEAD_PROFILES = 32;

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
  headProfiles: vArray(vHydraHeadProfile, PERSIST_MAX_HEAD_PROFILES),
});

// F17 model-list slices — provider fixed to the one adapter this build
// ships; preference keys carry the pin-id shape "provider/modelID" and
// only reconcile against the live catalog at render time (a pin whose
// model a provider never reports still loads and shows by id).
const vModelPin = vObject({
  provider: vEnum(["codex"] as const),
  modelID: vNonEmptyString(200),
});
const vModelSection = vObject({
  id: vNonEmptyString(40),
  name: vNonEmptyString(200),
  position: vInt(0, 1000),
});
const vModelPreference = vObject({
  effort: vOptional(vNonEmptyString(100)),
  fastMode: vOptional(vBoolean),
});
const vModelPreferences: Validator<Record<string, ModelPreference>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  const out: Record<string, ModelPreference> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (!/^[a-z]+\/.{1,200}$/.test(key))
      throw new ValidationError(`bad model preference key "${key}"`);
    out[key] = vModelPreference(val);
  }
  return out;
};

// F18: env is a bounded KEY=VALUE map — keys are POSIX-safe names,
// values bounded; plain text by design (see Settings.mcpServers).
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

// F18: frozen MCP connections — stdio only in this slice. env values
// persist plaintext (the frozen Keychain split is out of slice).
// A73: HTTP header map for catalog servers — RFC 7230 token names.
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

const vSettings = vObject({
  theme: vEnum(THEME_IDS),
  language: vEnum(["en", "zh-Hans"] as const),
  alwaysAllow: vArray(vString, PERSIST_MAX_GRANTS),
  // Optional so every pre-A18 store loads verbatim — absent means off.
  notifyOnDone: vOptional(vBoolean),
  // Optional so every pre-A49 store loads verbatim — absent means the
  // frozen default (on).
  chimeWhenFinished: vOptional(vBoolean),
  autoContinueAfterLimit: vOptional(vBoolean),
  // Optional so every pre-A43 store loads verbatim — absent means the
  // frozen default (on).
  confirmBeforeDeleting: vOptional(vBoolean),
  // Optional so every pre-A47 store loads verbatim — absent means the
  // frozen default (on).
  recentDownloadsPicker: vOptional(vBoolean),
  // Optional so every pre-A78 store loads verbatim — absent means the
  // frozen defaults: recent location, fullAccess mode, local workspace,
  // thinking hidden, working card on.
  newThreadLocation: vOptional(vEnum(["recent", "standalone"] as const)),
  defaultRuntimeMode: vOptional(
    vEnum(["supervised", "autoAcceptEdits", "auto", "fullAccess"] as const),
  ),
  defaultWorkspaceMode: vOptional(vEnum(["local", "worktree"] as const)),
  showReasoning: vOptional(vBoolean),
  showsWorkingCard: vOptional(vBoolean),
  performanceMode: vOptional(vBoolean),
  showsSkylight: vOptional(vBoolean),
  // F33: CLI install receipt — path of the client our shim points at.
  cliInstallationTarget: vOptional(vNonEmptyString(4000)),
  // Optional so every pre-P2N store loads verbatim. Structural check only
  // — path validity is re-proven separately at runtime resolution.
  codexExecutable: vOptional(vNonEmptyString(4000)),
  // Optional so every pre-A21 store loads verbatim — absent means off.
  taskSleepMode: vOptional(vEnum(["off", "system", "display"] as const)),
  textGeneration: vOptional(vEnum(["automatic", "off"] as const)),
  // Optional so every pre-A35 store loads verbatim — overrides only;
  // a stored null chord means the shortcut was cleared (frozen Override).
  shortcuts: vOptional(vShortcuts),
  // Optional so every pre-A36 store loads verbatim — frozen
  // commitInstructions is a free-form string (empty = none).
  commitInstructions: vOptional(vMaxString(4096)),
  // Optional so every pre-A37 store loads verbatim — absent = enabled
  // (frozen antiSlopEnabled defaults true).
  antiSlopEnabled: vOptional(vBoolean),
  // Optional so every pre-A39 store loads verbatim — absent = both
  // gates off (the control socket never listens without them).
  alphaEnabled: vOptional(vBoolean),
  externalControlEnabled: vOptional(vBoolean),
  // Optional so every pre-A38 store loads verbatim — absent = the
  // frozen defaults 14/15/13 (see shared/typeScale.ts).
  fontSizes: vOptional(vFontSizes),
  // F21 Hydra — optional so every pre-A41 store loads verbatim; absent
  // means the frozen defaults (see shared/hydra.ts + Settings docs).
  hydraEnabled: vOptional(vBoolean),
  hydraDefaultEnabled: vOptional(vBoolean),
  hydraQueueHeads: vOptional(vBoolean),
  hydraAlwaysHeads: vOptional(vBoolean),
  hydraIsolateHeads: vOptional(vBoolean),
  hydraMaxHeads: vOptional(vInt(1, 8)),
  hydraAutoMerge: vOptional(vBoolean),
  hydraReviewHeads: vOptional(vBoolean),
  hydraArchivesCodexHeads: vOptional(vBoolean),
  hydraShowsHeadDetails: vOptional(vBoolean),
  hydraAutoPopsHeads: vOptional(vBoolean),
  hydraTempersHeadEffort: vOptional(vBoolean),
  hasSeenHydraIntro: vOptional(vBoolean),
  hydraPairs: vOptional(vArray(vHydraPair, PERSIST_MAX_HYDRA_PAIRS)),
  lastHydraPairId: vOptional(vNonEmptyString(120)),
  // F17: frozen modelList / modelSections / collapsedModelSections /
  // modelPreferences — pins organize the picker; the catalog stays
  // provider-owned. Optional so every pre-A53 store loads verbatim.
  modelList: vOptional(vArray(vModelPin, MODEL_LIST_LIMIT)),
  modelSections: vOptional(vArray(vModelSection, 60)),
  collapsedModelSections: vOptional(vArray(vNonEmptyString(40), 60)),
  modelPreferences: vOptional(vModelPreferences),
  // F18: optional so every pre-A54 store loads verbatim.
  mcpServers: vOptional(vArray(vMcpServer, 32)),
  // F26: wallpaper file is a library basename the install path minted;
  // softness/opacity clamp to the frozen 0..1 slider range.
  wallpaper: vOptional(
    vObject({
      file: (v): string => {
        const s = vNonEmptyString(200)(v);
        if (!/^wallpaper-[0-9a-f-]{36}\.(png|jpe?g|webp|gif|bmp)$/.test(s))
          throw new ValidationError("bad wallpaper file name");
        return s;
      },
      softness: vNumber(0, 1),
    }),
  ),
  backdropOpacity: vOptional(vNumber(0, 1)),
  // F25: optional so every pre-A65 store loads verbatim — the dragged
  // helper-panel size (frozen panelSize), refitted to the pane on use.
  helperPanelSize: vOptional(
    vObject({ width: vInt(200, 4000), height: vInt(140, 4000) }),
  ),
  // A81: dragged layout sizes — sidebar edge (210–440) and terminal
  // drawer top edge (140–760), frozen SidebarLayout/terminalHeight.
  sidebarWidth: vOptional(vNumber(210, 440)),
  terminalHeight: vOptional(vNumber(140, 760)),
});

// F05 recent-slash-commands map: provider-keyed, names bounded to the
// slash-command charset, 100 entries per provider (frozen cap).
const vCommandName: Validator<string> = (v) => {
  const s = vString(v);
  if (!/^[a-z0-9-]{1,64}$/.test(s))
    throw new ValidationError(`bad command name "${s}"`);
  return s;
};

const vRecentCommands: Validator<Record<string, string[]>> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError("expected object");
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length > 32) throw new ValidationError("too many provider keys");
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    if (!/^[a-z0-9-]{1,32}$/.test(key))
      throw new ValidationError(`bad provider key "${key}"`);
    out[key] = vArray(vCommandName, 100)(rec[key]);
  }
  return out;
};

/**
 * F30 segmented turn storage (frozen StoredTurnFile port): the head's
 * thread rows carry metadata only — messages/turn live in
 * turns/<id>.json. A legacy monolith head still carries them inline, so
 * both fields are optional AT THE HEAD; the store hydrates them before
 * anything else reads the document.
 */
const vThreadHead = vObject({
  id: vNonEmptyString(120),
  projectId: vNullable(vNonEmptyString(120)),
  title: vNonEmptyString(300),
  createdAt: vTs,
  updatedAt: vTs,
  messages: vOptional(vArray(vMessage, PERSIST_MAX_MESSAGES)),
  turn: vOptional(vNullable(vTurn)),
  sessionGrants: vArray(vString, PERSIST_MAX_GRANTS),
  providerThread: vOptional(vProviderThread),
  codexModel: vOptional(vNonEmptyString(200)),
  codexEffort: vOptional(vNonEmptyString(100)),
  codexServiceTier: vOptional(vNonEmptyString(100)),
  codexModelReported: vOptional(vNonEmptyString(200)),
  codexEffortReported: vOptional(vNonEmptyString(100)),
  followUps: vOptional(
    vArray(
      vObject({
        id: vNonEmptyString(120),
        text: vNonEmptyString(8000),
        createdAt: vTs,
        bundleId: vOptional(vNonEmptyString(120)),
      }),
      PERSIST_MAX_FOLLOWUPS,
    ),
  ),
  isArchived: vOptional(vBoolean),
  isPinned: vOptional(vBoolean),
  sortOrder: vOptional(vNumber()),
  hasUnread: vOptional(vBoolean),
  unreadStatus: vOptional(vEnum(["done", "error", "interrupted"] as const)),
  interactionMode: vOptional(vEnum(["build", "plan"] as const)),
  contextUsage: vOptional(
    vObject({
      usedTokens: vInt(0, Number.MAX_SAFE_INTEGER),
      windowTokens: vOptional(vInt(1, Number.MAX_SAFE_INTEGER)),
    }),
  ),
  worktreeDir: vOptional(vNonEmptyString(2048)),
  continuation: vOptional((v): ThreadContinuation | undefined => {
    if (v === undefined) return undefined;
    const o = vObject({
      sourceThreadId: vNonEmptyString(120),
      sourceTitle: vNonEmptyString(500),
      createdAt: vTs,
      context: (x) => {
        const s = vString(x);
        if (s.length > 200_000)
          throw new ValidationError("string length out of range");
        return s;
      },
      isTruncated: vBoolean,
      sent: vBoolean,
    })(v);
    return o as ThreadContinuation;
  }),
  runtimeMode: vOptional(
    vEnum(["supervised", "autoAcceptEdits", "auto", "fullAccess"] as const),
  ),
  // F21: per-chat Hydra choice + chosen pair — inert until F22 scheduling.
  hydraEnabled: vOptional(vBoolean),
  hydraPairId: vOptional(vNonEmptyString(120)),
  // v2.2.34 keep-updated titles — see ChatThread.
  titleUserSet: vOptional(vBoolean),
  titleReviewTurns: vOptional(vInt(0, 1_000_000)),
  // F22: head-thread marker + lead roster counter (see ChatThread).
  hydraSpawnCount: vOptional(vInt(0, 1_000_000)),
  hydraHead: vOptional(
    vObject({
      leadId: vNonEmptyString(120),
      headIndex: vInt(0, 10_000),
      name: vNonEmptyString(80),
      task: vNonEmptyString(600),
      batchId: vNonEmptyString(120),
      status: vEnum(["running", "completed", "stopped", "failed"] as const),
      summary: vOptional(vMaxString(64 * 1024)),
      stalledNote: vOptional(vMaxString(4000)),
      toolCalls: vOptional(vInt(0, 1_000_000)),
      elapsedMs: vOptional(vNumber(0, 1e12)),
      profile: vOptional(vMaxString(120)),
      baseTree: vOptional(vMaxString(120)),
      landingCheckout: vOptional(vMaxString(2000)),
      landing: vOptional(
        vObject({
          files: vArray(
            vObject({
              path: vMaxString(2000),
              additions: vInt(0, 100_000_000),
              deletions: vInt(0, 100_000_000),
            }),
            10_000,
          ),
          conflicts: vArray(vMaxString(2000), 10_000),
          patchPath: vOptional(vMaxString(2000)),
          error: vOptional(vMaxString(4000)),
        }),
      ),
      copyKept: vOptional(vBoolean),
      landingPending: vOptional(vBoolean),
      spawnedAt: vTs,
      finishedAt: vOptional(vTs),
    }),
  ),
  // F25: helper-chat binding (frozen parentThreadID / isInPanel).
  parentThreadId: vOptional(vNonEmptyString(120)),
  isInPanel: vOptional(vBoolean),
});

const vStoreHead = vObject({
  schemaVersion: vInt(0, Number.MAX_SAFE_INTEGER),
  projects: vArray(vProject, PERSIST_MAX_PROJECTS),
  threads: vArray(vThreadHead, PERSIST_MAX_THREADS),
  settings: vSettings,
  ui: vObject({ selectedThreadId: vNullable(vString) }),
  recentCommands: vOptional(vRecentCommands),
  // Marker distinguishing a segmented head from a legacy monolith —
  // absent means threads carry messages/turn inline (pre-A40 files).
  turnStorage: vOptional(vEnum(["segments"] as const)),
});

/** One turns/<id>.json segment — the thread's whole message history plus
 *  its latest (possibly live) turn record. */
const vTurnSegment = vObject({
  schemaVersion: vInt(0, Number.MAX_SAFE_INTEGER),
  threadId: vNonEmptyString(120),
  messages: vArray(vMessage, PERSIST_MAX_MESSAGES),
  turn: vNullable(vTurn),
});

export interface TurnSegmentDoc {
  schemaVersion: number;
  threadId: string;
  messages: ChatThread["messages"];
  turn: ChatThread["turn"];
}

/** Head-thread shape after hydration begins — messages/turn may still
 *  be absent until the segment loads. */
export type HeadThread = Omit<ChatThread, "messages" | "turn"> & {
  messages?: ChatThread["messages"];
  turn?: ChatThread["turn"] | null;
};
export type StoreHead = Omit<StoreFile, "threads"> & {
  threads: HeadThread[];
  turnStorage?: "segments";
};

/**
 * Per-thread relational integrity — identical rules for a monolith
 * thread and a hydrated head thread. Exported so the segment loader can
 * quarantine a single bad turn file instead of failing the library.
 */
export function checkThreadIntegrity(t: {
  id: string;
  messages: ChatThread["messages"];
  turn: ChatThread["turn"];
}): void {
  const messageIds = new Set<string>();
  for (const m of t.messages) {
    if (messageIds.has(m.id)) throw new CorruptStoreError(`duplicate message id ${m.id}`);
    messageIds.add(m.id);
    if (m.status === "streaming") {
      const live =
        t.turn !== null &&
        t.turn !== undefined &&
        m.turnId === t.turn.id &&
        (t.turn.status === "running" || t.turn.status === "waiting-approval");
      if (!live)
        throw new CorruptStoreError(
          `streaming message ${m.id} without a live turn to produce it`,
        );
    }
  }
  const turn = t.turn;
  if (turn) {
    if (turn.threadId !== t.id)
      throw new CorruptStoreError(`turn ${turn.id} claims foreign thread ${turn.threadId}`);
    const assistantMsg = t.messages.find((m) => m.id === turn.assistantMessageId);
    if (!assistantMsg)
      throw new CorruptStoreError(`turn ${turn.id} references missing assistant message`);
    if (assistantMsg.role !== "assistant")
      throw new CorruptStoreError(`turn ${turn.id} assistant message has role ${assistantMsg.role}`);
    if (assistantMsg.turnId !== turn.id)
      throw new CorruptStoreError(
        `turn ${turn.id} assistant message belongs to turn ${assistantMsg.turnId}`,
      );
    const approval = turn.approval;
    if (approval) {
      if (approval.turnId !== turn.id)
        throw new CorruptStoreError(`approval ${approval.id} claims foreign turn ${approval.turnId}`);
      const optionIds = new Set(approval.options.map((o) => o.id));
      if (optionIds.size !== approval.options.length)
        throw new CorruptStoreError(`approval ${approval.id} has duplicate option ids`);
      if (approval.status === "pending" && turn.status !== "waiting-approval")
        throw new CorruptStoreError(
          `pending approval ${approval.id} on ${turn.status} turn ${turn.id}`,
        );
      if (approval.resolvedOptionId !== undefined && !optionIds.has(approval.resolvedOptionId))
        throw new CorruptStoreError(`approval ${approval.id} resolves to unknown option`);
      if (approval.status === "resolved" && approval.resolvedOptionId === undefined)
        throw new CorruptStoreError(`approval ${approval.id} resolved without an option`);
      if (approval.status === "pending" && approval.resolvedOptionId !== undefined)
        throw new CorruptStoreError(`pending approval ${approval.id} already records an option`);
      if (approval.autoResolved === true && approval.status !== "resolved")
        throw new CorruptStoreError(`autoResolved flag on unresolved approval ${approval.id}`);
    }
    if (turn.status === "waiting-approval" && (!approval || approval.status !== "pending"))
      throw new CorruptStoreError(`waiting-approval turn ${turn.id} lacks a pending approval`);
  }
}

/** Validate one turns/<id>.json file — shape only; integrity against the
 *  head row is the caller's (checkThreadIntegrity on the merged row). */
export function validateTurnSegment(parsed: unknown): TurnSegmentDoc {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CorruptStoreError("turn segment is not an object");
  try {
    return vTurnSegment(parsed) as TurnSegmentDoc;
  } catch (e) {
    throw new CorruptStoreError(
      `invalid turn segment: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Validate the head document: shape, capacities, marker and the
 *  head-level relational rules (id uniqueness, project refs, selection).
 *  Per-thread message/turn integrity runs after hydration. */
export function validateStoreHead(parsed: unknown): StoreHead {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CorruptStoreError("store document is not an object");
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > SCHEMA_VERSION)
    throw new NewerStoreError(
      `store was written by schema version ${version} (this build reads ${SCHEMA_VERSION}); refusing to overwrite it`,
    );
  const raw = parsed as Record<string, unknown>;
  const checkCapacity = (value: unknown, limit: number, label: string): void => {
    if (Array.isArray(value) && value.length > limit)
      throw new Error(`store ${label} exceeds this build's capacity; original data is unchanged`);
  };
  checkCapacity(raw.projects, PERSIST_MAX_PROJECTS, "projects");
  checkCapacity(raw.threads, PERSIST_MAX_THREADS, "threads");
  if (Array.isArray(raw.threads)) {
    for (const thread of raw.threads) {
      if (typeof thread !== "object" || thread === null) continue;
      checkCapacity(thread.messages, PERSIST_MAX_MESSAGES, "messages");
      checkCapacity(thread.sessionGrants, PERSIST_MAX_GRANTS, "session grants");
    }
  }
  if (typeof raw.settings === "object" && raw.settings !== null)
    checkCapacity((raw.settings as Record<string, unknown>).alwaysAllow, PERSIST_MAX_GRANTS, "grants");
  let doc: StoreHead;
  try {
    doc = vStoreHead(parsed) as StoreHead;
  } catch (e) {
    throw new CorruptStoreError(
      `invalid store document: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (doc.schemaVersion !== SCHEMA_VERSION)
    throw new CorruptStoreError(`unsupported schemaVersion ${doc.schemaVersion}`);
  const projectIds = new Set<string>();
  for (const p of doc.projects) {
    if (projectIds.has(p.id)) throw new CorruptStoreError(`duplicate project id ${p.id}`);
    projectIds.add(p.id);
  }
  const threadIds = new Set<string>();
  for (const t of doc.threads) {
    if (threadIds.has(t.id)) throw new CorruptStoreError(`duplicate thread id ${t.id}`);
    threadIds.add(t.id);
    if (t.projectId !== null && !projectIds.has(t.projectId))
      throw new CorruptStoreError(`thread ${t.id} points at unknown project ${t.projectId}`);
    // Legacy inline rows are complete already — check them here so a
    // monolith head needs no second pass.
    if (t.messages !== undefined || t.turn !== undefined)
      checkThreadIntegrity({
        id: t.id,
        messages: t.messages ?? [],
        turn: t.turn ?? null,
      });
  }
  if (doc.ui.selectedThreadId !== null && !threadIds.has(doc.ui.selectedThreadId))
    throw new CorruptStoreError(`ui.selectedThreadId points at unknown thread`);
  return doc;
}

const vStoreFile = vObject({
  schemaVersion: vInt(0, Number.MAX_SAFE_INTEGER),
  projects: vArray(vProject, PERSIST_MAX_PROJECTS),
  threads: vArray(vThread, PERSIST_MAX_THREADS),
  settings: vSettings,
  ui: vObject({ selectedThreadId: vNullable(vString) }),
  // Optional so every pre-A28 store loads verbatim.
  recentCommands: vOptional(vRecentCommands),
});

/**
 * Validate a parsed store document: strict shape, enums, unique ids and
 * referential integrity. Throws NewerStoreError for newer schema files,
 * CorruptStoreError for anything else that does not conform.
 */
export function validateStoreFile(parsed: unknown): StoreFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CorruptStoreError("store document is not an object");
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > SCHEMA_VERSION)
    throw new NewerStoreError(
      `store was written by schema version ${version} (this build reads ${SCHEMA_VERSION}); refusing to overwrite it`,
    );

  const raw = parsed as Record<string, unknown>;
  const checkCapacity = (value: unknown, limit: number, label: string): void => {
    if (Array.isArray(value) && value.length > limit)
      throw new Error(`store ${label} exceeds this build's capacity; original data is unchanged`);
  };
  checkCapacity(raw.projects, PERSIST_MAX_PROJECTS, "projects");
  checkCapacity(raw.threads, PERSIST_MAX_THREADS, "threads");
  if (Array.isArray(raw.threads)) {
    for (const thread of raw.threads) {
      if (typeof thread !== "object" || thread === null) continue;
      checkCapacity(thread.messages, PERSIST_MAX_MESSAGES, "messages");
      checkCapacity(thread.sessionGrants, PERSIST_MAX_GRANTS, "session grants");
    }
  }
  if (typeof raw.settings === "object" && raw.settings !== null)
    checkCapacity((raw.settings as Record<string, unknown>).alwaysAllow, PERSIST_MAX_GRANTS, "grants");

  let doc: StoreFile;
  try {
    doc = vStoreFile(parsed) as StoreFile;
  } catch (e) {
    throw new CorruptStoreError(
      `invalid store document: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (doc.schemaVersion !== SCHEMA_VERSION)
    throw new CorruptStoreError(`unsupported schemaVersion ${doc.schemaVersion}`);

  // ---- relational integrity ---------------------------------------------
  const projectIds = new Set<string>();
  for (const p of doc.projects) {
    if (projectIds.has(p.id)) throw new CorruptStoreError(`duplicate project id ${p.id}`);
    projectIds.add(p.id);
  }
  const threadIds = new Set<string>();
  for (const t of doc.threads) {
    if (threadIds.has(t.id)) throw new CorruptStoreError(`duplicate thread id ${t.id}`);
    threadIds.add(t.id);
    if (t.projectId !== null && !projectIds.has(t.projectId))
      throw new CorruptStoreError(`thread ${t.id} points at unknown project ${t.projectId}`);
    // Only the LATEST turn is persisted per thread, so messages produced
    // by earlier (ended) turns legitimately reference turn ids that no
    // longer exist in the file — that includes A22+ user messages, which
    // carry the id of the turn they started. What IS checkable:
    //  · "streaming" is only legal on the current turn's assistant while
    //    that turn is running or waiting — every other path ends the
    //    message (done/interrupted/…) before it can persist.
    checkThreadIntegrity(t);
  }
  if (doc.ui.selectedThreadId !== null && !threadIds.has(doc.ui.selectedThreadId))
    throw new CorruptStoreError(`ui.selectedThreadId points at unknown thread`);
  return doc;
}
