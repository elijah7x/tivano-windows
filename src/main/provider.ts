// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Provider contract for the main process only. An adapter produces turns;
// the engine owns threading/approvals/persistence and re-validates every
// callback (turnId + seq), so a misbehaving adapter cannot corrupt state.
//
// Modes: the in-process Mock ("mock"), the controlled synthetic stdio
// child ("synthetic-stdio") and the Codex app-server adapter ("codex").
// Codex launches are limited to the offline protocol fixture unless the
// process-tree capability is proven — nothing here probes, authenticates
// or runs a real CLI.

import type {
  ApprovalRequest,
  CodexModelOption,
  CodexQuestionRequest,
  TodoStep,
} from "../shared/types";

/** Provider identity shown in UI and gating behavior. */
export interface ProviderDescriptor {
  /** Stable internal id, e.g. "mock", "synthetic-stdio" or "codex". */
  readonly id: string;
  /** Human label — must state its synthetic nature when applicable. */
  readonly label: string;
  /**
   * Provider kind. "mock" runs in-process; "synthetic-stdio" spawns a
   * controlled local child process; "codex" speaks the pinned app-server
   * JSON-RPC protocol (fixture or, when gated in, a real CLI).
   */
  readonly mode: "mock" | "synthetic-stdio" | "codex";
  /** Always true in this phase — real providers are not wired. */
  readonly synthetic: true;
  /**
   * Recorded BEFORE spawn for synthetic adapters: the resolved executable
   * and its actual runtime version. Diagnostic only — never probing a
   * real provider CLI.
   */
  readonly runtimeInfo?: { executable: string; version: string };
  /**
   * F09: the provider runs `/compact` itself (frozen supportsCompact).
   * Absent → the composer sends "/compact" as ordinary text, matching the
   * frozen fall-through for unsupported providers.
   */
  readonly compact?: boolean;
}

/**
 * Bounded tool/request status surfaced by the Codex adapter — rendered as
 * an updatable system note inside the turn, never as assistant text.
 */
export interface ToolActivity {
  /** Server item id the activity belongs to. */
  itemId: string;
  /** Frozen ToolCall kind vocabulary (renderer never sees it — the engine
   *  folds kind+title into the note text). */
  kind: "command" | "read" | "search" | "edit" | "mcp" | "web" | "agent" | "other";
  /** Short title: command text, a file path, "server · tool", a query… */
  title?: string | undefined;
  /** i18n key for adapter-fixed titles ("Edit %@ files", "Review"…) —
   *  the renderer localizes these instead of showing `title`. */
  titleKey?: string | undefined;
  titleParams?: (string | number)[] | undefined;
  status: "started" | "completed" | "failed" | "declined";
  /** Bounded output tail / change summary (may grow between updates). */
  detail?: string | undefined;
}

/**
 * F03 reasoning item (Codex only). Deltas append; `done` carries the
 * completed item's authoritative text (frozen: summary ?? content).
 */
export interface ReasoningActivity {
  itemId: string;
  delta?: string;
  done?: boolean;
  finalText?: string;
}

/** Engine callbacks the adapter reports through. */
export interface ProviderCallbacks {
  onChunk(seq: number, delta: string): void;
  /**
   * Whole-composition message update (Codex only): the adapter owns
   * per-item ordering/dedup and emits the FULL assistant text — the
   * engine REPLACES the message content, never appends. Used so a final
   * item text that differs from streamed deltas rewrites instead of
   * duplicating.
   */
  onMessageText?(seq: number, fullText: string): void;
  onApproval(request: Omit<ApprovalRequest, "id" | "turnId" | "status">): void;
  onDone(): void;
  onError(message: string): void;
  /**
   * The server ended the turn early by itself (turn/completed status
   * "interrupted" without a local cancel). Terminal — like onDone it is
   * delivered exactly once per turn.
   */
  onInterrupted?(): void;
  /** Tool/request progress for the active turn (Codex only). */
  onToolActivity?(activity: ToolActivity): void;
  /** Reasoning item progress for the active turn (Codex only). */
  onReasoning?(activity: ReasoningActivity): void;
  /** Plan item progress for the active turn (Codex only). Same streaming
   *  contract as reasoning; `finalText` is the completed item's markdown. */
  onPlan?(activity: ReasoningActivity): void;
  /** Frozen turn/plan/updated — the WHOLE step list each time (Codex only).
   *  Bounded to 50 steps by the adapter. */
  onTodos?(steps: readonly TodoStep[]): void;
  /**
   * F19 context-window reading (Codex thread/tokenUsage/updated):
   * `last.totalTokens` used, `modelContextWindow` when advertised.
   * `sessionTotalTokens` is the provider's CUMULATIVE counter for the
   * session (Codex `total.totalTokens`) — the engine runs it through a
   * frozen-style spend tracker so only growth is charged to the daily
   * ledger; inherited history and counter drops are never billed.
   */
  onUsage?(usage: {
    usedTokens: number;
    windowTokens?: number;
    sessionTotalTokens?: number;
  }): void;
  /**
   * Trusted structured edit attribution (Codex only): repo-relative
   * paths the provider declared changed inside a fileChange item. This
   * is the ONLY source of checkpoint touched paths — assistant text is
   * never parsed for edits. Bounded by the adapter; the engine re-
   * validates each path and attributes it only to the live turn.
   */
  onFileChanges?(paths: readonly string[]): void;
  /** Non-fatal provider/engine note shown inline (bounded length). */
  onNotice?(text: string, level?: "info" | "warning" | "error"): void;
  /**
   * The server-side request behind a previously presented approval went
   * away (serverRequest/resolved, connection loss, terminal event, a
   * failed answer write). The engine expires the card WITHOUT treating
   * it as a user answer. `providerKey` echoes ApprovalRequest.providerKey.
   */
  onApprovalWithdrawn?(providerKey: string): void;
  /**
   * Codex only: the user's decision for `providerKey` was CONFIRMED
   * written to the wire — not merely queued. The engine commits the
   * pending resolution on this signal alone; queue admission never
   * counts. A write that fails instead expires the ticket through
   * onApprovalWithdrawn so no resolved/pending split can form.
   */
  onApprovalAnswerWritten?(providerKey: string): void;
  /**
   * Codex only: the provider's thread/start|resume response reported the
   * thread's effective model/effort. Diagnostic state for the picker —
   * persisted verbatim, never treated as proof of a future turn.
   */
  onModelReport?(model: string | null, effort: string | null): void;
  /**
   * Codex only: a user-input request was PRESENTED (serialized like
   * approvals — never co-presented with another server request).
   * `providerKey` is the only identity the answer may name.
   */
  onQuestion?(request: Omit<CodexQuestionRequest, "status">): void;
  /**
   * Codex only: the user's answers were CONFIRMED written to the wire —
   * same admission semantics as onApprovalAnswerWritten.
   */
  onQuestionAnswered?(providerKey: string): void;
  /**
   * Codex only: the question request went away without an answer —
   * server-side resolution, connection loss, terminal event or a failed
   * write. The card EXPIRES; it is never a user answer.
   */
  onQuestionWithdrawn?(providerKey: string): void;
}

/**
 * Live-turn control. cancel() invalidates synchronously; any process
 * teardown proceeds asynchronously under the adapter's own ownership —
 * the engine dropping its handle reference must never orphan a child.
 * resume(approved) is called after the user answers an approval;
 * `optionId` tells a multi-option provider WHICH grant was picked
 * (Codex decision payloads / permission scope). Providers with a plain
 * once/deny gate ignore it.
 */
export interface ProviderTurnHandle {
  cancel(): void;
  resume(approved: boolean, optionId?: string): void;
  /**
   * Codex only: the user DENIED the presented request with a specific
   * option ("cancel" vs "decline" write different payloads). Engines
   * call this instead of cancel() when the handle offers it.
   */
  decline?(optionId: string): void;
  /**
   * Codex only: answer the PRESENTED question request. `providerKey`
   * must name the currently presented request — a stale key is a no-op.
   */
  answer?(providerKey: string, answers: Record<string, string[]>): void;
}

/**
 * A main-authorized directory a synthetic child may run in. Created only
 * by main/test harness registration — never derived from renderer input,
 * project names or arbitrary strings.
 */
export interface WorkspaceGrant {
  readonly projectId: string;
  /** Physically resolved directory; re-verified before every spawn. */
  readonly directory: string;
}

export interface TurnContext {
  prompt: string;
  threadId: string;
  turnId: string;
  /** Required by process adapters; the Mock ignores it. */
  workspace?: WorkspaceGrant;
  /**
   * User-selected Codex model/effort overrides for THIS turn (F17). Sent
   * verbatim on thread/start|resume and turn/start; absent = the provider
   * decides. Adapters that do not support them ignore them — the engine
   * keeps the selection only on threads whose launch provider is Codex.
   */
  model?: string;
  effort?: string;
  /**
   * User-selected Codex service tier for THIS turn — sent verbatim as
   * turn/start's `serviceTierForTurn`. Ignored by non-Codex adapters.
   */
  serviceTier?: string;
  /**
   * F06: the thread's runtime mode for THIS turn — adapters that map
   * modes to provider policy params (Codex) send them verbatim;
   * adapters without a mode concept ignore it.
   */
  runtimeMode?: import("../shared/types").RuntimeMode;
  /** F06: build vs plan for THIS turn (Codex collaborationMode). */
  interactionMode?: import("../shared/types").InteractionMode;
}

/** Outcome of one child teardown, for evidence and the close gate. */
export interface ChildCleanupResult {
  pid: number | undefined;
  /** true only when the process AND its stdio provably ended (close). */
  confirmed: boolean;
  exitCode: number | null;
  signal: string | null;
  /** e.g. "CLEANUP_INCOMPLETE" when the close deadline elapsed. */
  problem?: string;
}

export interface AdapterDisposeResult {
  children: ChildCleanupResult[];
  /** Any pending request that never resolved cleanly. */
  orphanedPending: number;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  /**
   * Start a turn. MUST NOT invoke callbacks before returning the handle —
   * the engine registers it first. A synchronous throw transitions the
   * freshly created turn to "error".
   */
  start(context: TurnContext, callbacks: ProviderCallbacks): ProviderTurnHandle;
  /**
   * Permanently end the provider-side session for one local thread
   * (thread/project deletion): interrupt any live turn, close the
   * app-server process and forget the in-memory session. The persisted
   * provider-thread mapping is owned by the store, not the adapter.
   * Optional — adapters without durable sessions may omit it.
   */
  endSession?(localThreadId: string): void;
  /**
   * Codex only: fetch the provider-owned model catalog via a live
   * session's model/list. Returns null when no session is bound yet —
   * the caller maps that to "pending", never to a fabricated list.
   * Optional — adapters without catalogs omit it.
   */
  modelCatalog?(): Promise<CodexModelOption[] | null>;
  /**
   * F31: one-shot title generation for a thread's first message, run with
   * no tools (frozen TextGeneration.threadTitle). Optional — adapters
   * without a text engine omit it and the engine keeps the prompt-derived
   * fallback title. Null means "no usable title".
   */
  generateTitle?(message: string): Promise<string | null>;
  /**
   * F31/F13: one-shot commit-message draft from the change summary + a
   * bounded patch, run with no tools (frozen TextGeneration.commitMessage).
   * Optional — adapters without a text engine omit it and the caller
   * reports generation unavailable. Null means "no usable draft"; the
   * caller sanitizes and never auto-commits what comes back.
   */
  generateCommitMessage?(
    summary: string,
    patch: string,
    instructions: string,
  ): Promise<string | null>;
  /**
   * F09: run the provider's context compaction for a bound session
   * (frozen session.compact → thread/compact/start). Present only when
   * `descriptor.compact` is set. Throws CodexProviderError
   * CODEX_NOT_RUNNING when the thread has no live session — the engine
   * maps that to the frozen "Nothing to compact yet." notice.
   */
  compact?(localThreadId: string): Promise<void>;
  /**
   * End every owned child and report per-child outcomes. Idempotent; must
   * not throw — individual failures are reported in the result instead so
   * the close gate can surface them.
   */
  dispose(): Promise<AdapterDisposeResult>;
}
