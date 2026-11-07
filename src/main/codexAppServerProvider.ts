// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex app-server adapter — speaks the pinned protocol (Codex CLI 0.164.0,
// schema 6aaac694) over the shared byte transport with an injected
// JSON-RPC codec. One local Tivano thread owns ONE app-server session
// (one child process); turns reuse it; process death + a persisted
// provider-thread binding yields a resume on the next turn.
//
// Hard rules (frozen Mac behavior, CodexSession.swift @ d31e093b):
//   · deadlines are per-RPC — initialize 20s, thread start/resume 90s,
//     turn/start 90s, turn/interrupt 10s. A whole model turn has NO
//     completion deadline.
//   · a mutating-RPC timeout poisons the connection (state unknown —
//     never retried): surface the error and tear the session down.
//   · approval responses are server-request answers, written only while
//     the process is alive and the request is still pending; pending
//     entries are removed only after the write is accepted, and a failed
//     write leaves the ticket for the close path to expire visibly.
//   · completion comes only from valid terminal statuses
//     (completed/interrupted/failed) on the ADMITTED provider turn; a
//     missing or failed turn/start can never be overtaken into "done" by
//     a completion that belongs to nothing.
//   · server-side resolution of a pending approval expires the card —
//     it is never mistaken for a user answer.
//   · every inbound frame is correlated to THIS generation, THIS thread
//     and THIS admitted turn — late/foreign/cross-connection traffic is
//     counted and dropped, never crashes, never revives a terminal turn.
//   · a transport keeps its process-attribution until the OS close is
//     DELIVERED — fatal errors, failed binds and session ends retain the
//     still-living child so provider.dispose can retry it honestly.

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type {
  ApprovalRequest,
  CodexModelOption,
  CodexQuestion,
  CodexQuestionChoice,
  ProviderThreadBinding,
  RuntimeMode,
} from "../shared/types";
import {
  DEFAULT_TRANSPORT_LIMITS,
  StdioTransport,
  type SpawnImpl,
  type SpawnSpec,
  type TransportLimits,
} from "./stdioTransport";
import {
  CodexProtocolError,
  CodexRpc,
  codexWireCodec,
  parseRpcId,
  rpcIdKey,
  type CodexMessage,
  type RpcId,
} from "./codexAppServerProtocol";
import {
  CODEX_PROVIDER_ID,
  CODEX_SCHEMA_PIN,
  type CodexRuntimeConfig,
} from "./codexRuntimeConfig";
import {
  makeJobHelperSpawnImpl,
  PROCESS_TREE_UNSUPPORTED,
  ProcessTreeError,
} from "./providerProcessLifecycle";
import {
  codexMcpServers,
  type McpServerConfig,
} from "../shared/mcp";
import type {
  AdapterDisposeResult,
  ChildCleanupResult,
  ProviderAdapter,
  ProviderCallbacks,
  ProviderDescriptor,
  ProviderTurnHandle,
  ToolActivity,
  TurnContext,
  WorkspaceGrant,
} from "./provider";

export class CodexProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CODEX_NOT_CONFIGURED"
      | "CODEX_REAL_UNAVAILABLE"
      | "CODEX_PROTOCOL_ERROR"
      | "CODEX_RESUME_FAILED"
      | "CODEX_BUSY"
      | "CODEX_NOT_RUNNING"
      | "CODEX_SESSION_LIMIT"
      | "CODEX_WORKSPACE_REQUIRED",
  ) {
    super(message);
    this.name = "CodexProviderError";
  }
}

/** Persisted on ChatThread.providerThread — restart resume identity.
 *  Canonical shape lives in shared/types.ts. */
export type { ProviderThreadBinding };

export interface CodexProviderLimits {
  /** Max concurrent app-server sessions (one per local thread). */
  maxSessions: number;
  /** Queued approvals per turn before extra requests are declined. */
  maxPendingApprovals: number;
  /** Distinct agentMessage items tracked per turn. */
  maxAgentItems: number;
  /** Total assistant text retained across items per turn. */
  maxAssistantTextBytes: number;
  /** Distinct tool items tracked per turn. */
  maxToolItems: number;
  /** Distinct reasoning items tracked per turn (F03). */
  maxReasoningItems: number;
  /** F03 plan items per turn + per-item text cap. */
  maxPlanItems: number;
  planTextBytes: number;
  /** turn/plan/updated steps kept per update + per-step text cap. */
  maxTodoSteps: number;
  todoStepTextBytes: number;
  /** Retained reasoning text per item. */
  reasoningTextBytes: number;
  /** Retained tool output tail per item. */
  toolOutputTailBytes: number;
  /** Max notice text length delivered to the engine. */
  noticeBytes: number;
  /** Max permission-request path list entries processed. */
  maxPermissionPaths: number;
  /** Full display budget for an approval card's detail text — a request
   *  whose complete description cannot fit is DECLINED, never truncated. */
  approvalDetailBytes: number;
  /** Same rule for the approval title (e.g. a disclosed command). */
  approvalTitleBytes: number;
  /** Questions per requestUserInput request (frozen parity: the card
   *  pages through them; the bound caps memory + renderer state). */
  maxQuestions: number;
  /** Choices per question. */
  maxQuestionChoices: number;
  /** Full display budgets for question text — like approvals, an
   *  over-long field declines the WHOLE request rather than consent to
   *  something the user could not fully read. */
  questionHeaderBytes: number;
  questionPromptBytes: number;
  questionChoiceLabelBytes: number;
  questionChoiceDetailBytes: number;
  /** Per-answer value bound — answers are echoed verbatim to the wire. */
  questionAnswerBytes: number;
  /** Inbound frames buffered while a turn awaits its start response. */
  maxPreAdmissionFrames: number;
  /** Default client-RPC timeout. */
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  threadTimeoutMs: number;
  turnStartTimeoutMs: number;
  interruptTimeoutMs: number;
  disposeInterruptMs: number;
}

export const DEFAULT_CODEX_LIMITS: CodexProviderLimits = {
  maxSessions: 8,
  maxPendingApprovals: 16,
  maxAgentItems: 256,
  maxAssistantTextBytes: 256 * 1024,
  maxToolItems: 128,
  maxReasoningItems: 64,
  reasoningTextBytes: 64 * 1024,
  maxPlanItems: 64,
  planTextBytes: 64 * 1024,
  maxTodoSteps: 50,
  todoStepTextBytes: 500,
  toolOutputTailBytes: 8 * 1024,
  noticeBytes: 600,
  maxPermissionPaths: 64,
  approvalDetailBytes: 4000,
  approvalTitleBytes: 500,
  maxQuestions: 8,
  maxQuestionChoices: 16,
  questionHeaderBytes: 300,
  questionPromptBytes: 4000,
  questionChoiceLabelBytes: 500,
  questionChoiceDetailBytes: 2000,
  questionAnswerBytes: 2000,
  maxPreAdmissionFrames: 128,
  requestTimeoutMs: 30_000,
  initializeTimeoutMs: 20_000,
  threadTimeoutMs: 90_000,
  turnStartTimeoutMs: 90_000,
  interruptTimeoutMs: 10_000,
  disposeInterruptMs: 5_000,
};

export interface CodexProviderOptions {
  config: CodexRuntimeConfig;
  clientName?: string;
  clientVersion?: string;
  /** Test seam — defaults: fixture → direct spawn; real → job helper. */
  spawnImpl?: SpawnImpl;
  /** Test seam — full control over the child spec. */
  makeSpec?(workspaceDir: string): SpawnSpec;
  transportLimits?: Partial<TransportLimits>;
  limits?: Partial<CodexProviderLimits>;
  /** Binding seam owned by the engine/store. */
  lookupBinding(localThreadId: string): ProviderThreadBinding | undefined;
  /** Persist the binding BEFORE turn/start so a restart can resume. */
  bindThread(localThreadId: string, binding: ProviderThreadBinding): Promise<void>;
  /**
   * Thread-level provider notice arriving OUTSIDE any live turn (e.g.
   * thread/compacted after the turn tore down). The engine renders it as
   * a standalone notice row — never folded into a dead turn.
   */
  onThreadNotice?(
    localThreadId: string,
    text: string,
    level: "info" | "warning" | "error",
  ): void;
  /**
   * F18: Settings-connected MCP servers ride into each thread's
   * `config.mcp_servers` at start/resume time (frozen CodexSession
   * threadParameters). Live-read per call so Settings edits apply to
   * the NEXT thread — never retro-mutate a bound one. Absent/empty →
   * no `config` key at all.
   */
  mcpServers?(): readonly McpServerConfig[] | undefined;
}

// ---------------------------------------------------------------------------

type Phase = "idle" | "connecting" | "ready" | "dead";

interface ActiveTurn {
  localTurnId: string;
  /** null until a SUCCESSFUL turn/start response admitted it — never a
   *  notification. Everything inbound keys off this. */
  providerTurnId: string | null;
  /** Typed key of THIS turn's turn/start request — the frame-level
   *  admission verdict must match this exact request, so a late response
   *  to a PREVIOUS turn's start can never admit a new turn. */
  startRequestKey: string | null;
  cb: ProviderCallbacks;
  seq: number;
  cancelIntent: boolean;
  /** The deny-class option the user picked ("cancel" vs "decline") —
   *  carried into the presented ticket's answer payload; undefined on a
   *  bare interrupt path. */
  cancelOptionId?: string;
  terminal: boolean;
  noticeCount: number;
}

interface ApprovalTicket {
  key: string;
  rpcId: RpcId;
  kind: "command" | "fileChange" | "permissions" | "question";
  itemId: string;
  /** Params already validated for display + response construction. */
  title: string;
  detail: string;
  reason?: string;
  /** Validated, displayable grant profile echoed on approve — never the
   *  raw request (unverifiable fields decline the request instead). */
  permissions?: Record<string, unknown>;
  /** kind === "question": validated engine-side answers, already in the
   *  wire payload shape `{qid: {answers: [...]}}` — staged at answer time
   *  so the queued frame is immutable even if the caller mutates. */
  answerPayload?: Record<string, { answers: string[] }>;
  /** kind === "question": the fully validated question set — display and
   *  answer construction both draw only from this bounded copy. */
  questions?: CodexQuestion[];
  /** kind command/fileChange: the frozen decisionOptions set rendered on
   *  the card (deny-class first; ApprovalCard reverses for display). */
  decisionOptions?: import("../shared/types").ApprovalOption[];
  /** kind command/fileChange: optionId → the verbatim payload the server
   *  offered in availableDecisions (frozen: written back unchanged). */
  decisionPayloads?: Record<string, unknown>;
  /** The answer frame is queued/being written — the ticket stays pending
   *  until the transport's write ack confirms (or fails) delivery. */
  writing?: boolean;
}

interface MessageItem {
  text: string;
  completed: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/**
 * Structured file-change attribution: a fileChange item's `changes`
 * array carries `{path, kind}` entries in the pinned schema. Only
 * non-empty string paths pass, bounded — anything else is dropped
 * rather than guessed at.
 */
function extractChangePaths(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  const out: string[] = [];
  for (const c of changes.slice(0, 128)) {
    if (!isObj(c)) continue;
    const p = s(c.path);
    if (p && p.length <= 4096 && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Frozen ToolTitles.unwrapShell — strips the `/bin/zsh -lc '…'`-style
 *  wrapper providers put around shell commands. */
function unwrapShell(command: string): string {
  const trimmed = command.trim();
  for (const prefix of ["/bin/zsh -lc ", "/bin/bash -lc ", "bash -lc ", "zsh -lc ", "/bin/sh -c ", "sh -c "]) {
    if (!trimmed.startsWith(prefix)) continue;
    let rest = trimmed.slice(prefix.length);
    const first = rest[0];
    if (rest.length >= 2 && (first === "'" || first === '"') && rest.endsWith(first)) {
      rest = rest.slice(1, -1);
      if (first === "'") rest = rest.replaceAll("'\\''", "'");
    }
    return rest;
  }
  return trimmed;
}

/** Frozen ToolTitles.relativePath. */
function relativePath(path: string, root: string): string {
  const normalizedRoot = root.endsWith("/") ? root : root + "/";
  return path.startsWith(normalizedRoot) ? path.slice(normalizedRoot.length) : path;
}

/** Frozen ToolTitles.diffStats — unified-diff +/- line counts. */
function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** Frozen ToolCall.Status mapping from a raw item status + exit code. */
function toolStatus(raw: string | null, exitCode: number | null): "completed" | "failed" | "declined" | "running" {
  if (raw === "inProgress") return "running";
  if (raw === "failed" || raw === "interrupted") return "failed";
  if (raw === "declined") return "declined";
  if (exitCode !== null && exitCode !== 0) return "failed";
  return "completed";
}

/** A frozen ToolCall: what the row says, not how the wire names it. */
interface ToolCallShape {
  kind: ToolActivity["kind"];
  /** Literal title (provider data) OR an i18n key for fixed strings. */
  title?: string | undefined;
  titleKey?: string | undefined;
  titleParams?: (string | number)[] | undefined;
  detail?: string | undefined;
}

/** Frozen CodexSession.toolCall(from:) — maps every supported item type
 *  to a row, nil for item types that draw nothing. */
function toolCall(item: Record<string, unknown>, workspaceDir: string): ToolCallShape | null {
  switch (item.type) {
    case "commandExecution": {
      const command = unwrapShell(typeof item.command === "string" ? item.command : "");
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const kinds = new Set(actions.map((a) => (isObj(a) ? s(a.type) : null)).filter(Boolean) as string[]);
      if (kinds.size === 1 && kinds.has("read") && isObj(actions[0]) && s(actions[0].path)) {
        return { kind: "read", title: relativePath(s(actions[0].path)!, workspaceDir), detail: command || undefined };
      }
      if (kinds.size > 0 && [...kinds].every((k) => k === "search" || k === "listFiles")) {
        return { kind: "search", title: command };
      }
      return { kind: "command", title: command };
    }
    case "fileChange": {
      const paths = extractChangePaths(item.changes);
      if (paths.length === 1) return { kind: "edit", title: relativePath(paths[0]!, workspaceDir) };
      return { kind: "edit", titleKey: "Edit %@ files", titleParams: [paths.length] };
    }
    case "mcpToolCall": {
      const server = s(item.server) ?? "MCP";
      const tool = s(item.tool) ?? "tool";
      const args = item.arguments === null || item.arguments === undefined ? null : String(JSON.stringify(item.arguments));
      return { kind: "mcp", title: `${server} · ${tool}`, detail: args === "null" ? undefined : args ?? undefined };
    }
    case "dynamicToolCall":
      return { kind: "other", title: s(item.tool) ?? "Tool" };
    case "webSearch":
      return { kind: "web", title: s(item.query) ?? "Web search" };
    case "collabAgentToolCall": {
      const verb =
        item.tool === "spawnAgent" ? "Send out a head"
        : item.tool === "sendInput" || item.tool === "sendMessage" || item.tool === "followupTask" ? "Brief a head"
        : item.tool === "wait" ? "Wait for heads"
        : item.tool === "closeAgent" || item.tool === "interruptAgent" ? "Recall a head"
        : item.tool === "resumeAgent" ? "Resume a head"
        : item.tool === "listAgents" ? "List heads"
        : "Agent";
      const brief = s(item.prompt)?.slice(0, 90);
      return { kind: "agent", title: brief ?? verb, detail: brief ? verb : undefined };
    }
    case "subAgentActivity":
      // Frozen: lead-side head notes drive head state, never draw a row.
      return null;
    case "imageView":
      return { kind: "read", title: relativePath(s(item.path) ?? "Image", workspaceDir) };
    case "imageGeneration":
      return { kind: "other", titleKey: "Generate image", detail: s(item.revisedPrompt) ?? undefined };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { kind: "other", titleKey: "Review", detail: s(item.review) ?? undefined };
    default:
      return null;
  }
}

/** Frozen CodexSession.toolUpdate(from:) — terminal status + output for a
 *  completed item. `tail` is the adapter-retained outputDelta tail. */
function toolUpdate(
  item: Record<string, unknown>,
  workspaceDir: string,
  tail: string,
): { status: "completed" | "failed" | "declined" | "running"; detail?: string | undefined } {
  const raw = s(item.status);
  switch (item.type) {
    case "commandExecution": {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const output = s(item.aggregatedOutput) ?? tail;
      return {
        status: toolStatus(raw, exitCode),
        detail: [output, exitCode !== null ? `exit ${exitCode}` : ""].filter(Boolean).join("\n").trim() || undefined,
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const lines = changes.slice(0, 64).map((c) => {
        if (!isObj(c)) return null;
        const path = relativePath(s(c.path) ?? "", workspaceDir);
        const diff = s(c.diff);
        if (!diff) return path;
        const st = diffStats(diff);
        return `+${st.additions} −${st.deletions}  ${path}`;
      }).filter(Boolean) as string[];
      return { status: toolStatus(raw, null), detail: lines.join("\n") || tail || undefined };
    }
    case "mcpToolCall": {
      let output: string | undefined;
      const err = isObj(item.error) ? s(item.error.message) : null;
      if (err) output = err;
      else if (isObj(item.result) && Array.isArray(item.result.content)) {
        output = item.result.content.map((b) => (isObj(b) ? s(b.text) : null)).filter(Boolean).join("\n") || undefined;
      }
      return { status: toolStatus(raw, null), detail: output };
    }
    case "webSearch":
    case "imageView":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { status: "completed" };
    default:
      return { status: toolStatus(raw, null) };
  }
}

class CodexSession {
  phase: Phase = "idle";
  private gen = 0;
  private transport: StdioTransport<CodexMessage> | null = null;
  private rpc: CodexRpc | null = null;
  /** EVERY spawned transport, held until its OS close is DELIVERED —
   *  live, draining and cleanup-unconfirmed alike. This is how a fatal
   *  error never makes a still-running child vanish from dispose. */
  private transports = new Set<StdioTransport<CodexMessage>>();
  private cleanupFailures = new Map<StdioTransport<CodexMessage>, ChildCleanupResult>();
  private codexThreadId: string | null = null;
  private bindPromise: Promise<void> | null = null;
  private turn: ActiveTurn | null = null;
  private tickets = new Map<string, ApprovalTicket>();
  private ticketOrder: string[] = [];
  private messageItems = new Map<string, MessageItem>();
  /** Total bytes across all messageItems — the retained assistant text is
   *  bounded, so a flood of deltas can never grow memory unboundedly. */
  private messageTextBytes = 0;
  private toolTails = new Map<string, { kind: ToolActivity["kind"]; title: string; detail: string }>();
  /** F03 reasoning items — turn-scoped, cleared with the other item maps. */
  private reasoningItems = new Map<string, { text: string; completed: boolean }>();
  /** F03 plan items — same contract, separate map/budget. */
  private planItems = new Map<string, { text: string; completed: boolean }>();
  /**
   * A turn/started that arrived BEFORE its turn/start response is only a
   * CANDIDATE: it can never admit the turn — only a successful response
   * correlated to our request can. The candidate is reconciled against
   * the response; a mismatch is an explicit protocol failure.
   */
  private candidateTurnId: string | null = null;
  /**
   * Correlation-valid inbound frames buffered while the turn awaits its
   * turn/start response — replayed IN ORDER at admission, discarded with
   * prejudice when the start fails. Never applied early: admission is
   * provable only by the response.
   */
  private preAdmission: Array<
    | { kind: "req"; id: RpcId; method: string; params: unknown }
    | { kind: "notif"; method: string; params: unknown }
  > = [];
  /** Item the last streamed delta belonged to — an item SWITCH re-emits
   *  the whole composition (replace channel) so interleaved items keep
   *  the renderer identical to the provider's ordered composition. */
  private lastDeltaItemId: string | null = null;
  /** Latest user-selected model/effort (F17) — refreshed by every
   *  beginTurn so a RECONNECT binds with the newest selection, not the
   *  one the dead connection had. Sent verbatim; absent = server picks. */
  private desiredModel: string | undefined;
  private desiredEffort: string | undefined;
  /** Latest turn's runtime mode (F06) — a RECONNECT binds with the
   *  newest mode, mirroring desiredModel. */
  private desiredMode: RuntimeMode = "supervised";
  /** Server-reported bound pair (frozen activeModel). */
  private boundModel: string | undefined;
  private boundEffort: string | undefined;
  private finalError: string | null = null;
  dropped = 0;
  private disposed = false;
  /** Physical workspace path — resolved once at construction; a later
   *  turn context carrying a DIFFERENT workspace may not reuse us. */
  readonly workspaceDirectory: string;

  constructor(
    private readonly provider: CodexAppServerProvider,
    readonly localThreadId: string,
    private readonly workspace: WorkspaceGrant,
  ) {
    this.workspaceDirectory = realpathSync(workspace.directory);
  }

  get limits(): CodexProviderLimits {
    return this.provider.limits;
  }

  /** Workspace root, physically resolved once — every approval path check
   *  measures against this, never against renderer-supplied strings. */
  private workspacePhys(): string {
    return this.workspaceDirectory;
  }

  /**
   * Frozen requestThread (CodexSession): thread/start|resume carry the
   * Settings-connected MCP registry as `config.mcp_servers` — merged
   * into whatever `config` the params already hold, never replacing it.
   * A server that cannot load that config ("failed to load
   * configuration" / "invalid transport") earns exactly ONE retry
   * without `mcp_servers` — verbatim frozen; any other failure keeps
   * its own error path.
   */
  private async requestThread(
    rpc: CodexRpc,
    method: "thread/start" | "thread/resume",
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const servers = this.provider.mcpServersForThread();
    const mcp = servers?.length ? codexMcpServers(servers) : undefined;
    const sent = mcp
      ? {
          ...params,
          config: {
            ...(isObj(params.config) ? params.config : {}),
            mcp_servers: mcp,
          },
        }
      : params;
    const call = (p: Record<string, unknown>) =>
      rpc.request(method, p, {
        timeoutMs: this.limits.threadTimeoutMs,
        mutating: true,
      });
    if (!mcp) return call(sent);
    try {
      return await call(sent);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err ?? "");
      if (
        !msg.includes("failed to load configuration") &&
        !msg.includes("invalid transport")
      )
        throw err;
      // Frozen: the mcp_servers override gets one retry stripped — the
      // rest of the params (and config, had it existed) ride again.
      return await call(params);
    }
  }

  /**
   * Physical containment: `candidate` must be absolute, glob-free, and —
   * after normalization AND realpath of its deepest existing ancestor —
   * inside the workspace root. Non-existent tails are allowed (new files),
   * but no existing ancestor may escape via symlink.
   */
  private pathInsideWorkspace(candidate: string): boolean {
    if (
      typeof candidate !== "string" ||
      !isAbsolute(candidate) ||
      candidate.includes("\0") ||
      /[*?[\]{}]/.test(candidate)
    )
      return false;
    let wsPhys: string;
    try {
      wsPhys = this.workspacePhys();
    } catch {
      return false;
    }
    const norm = resolve(candidate);
    // Physical containment: the deepest EXISTING ancestor must resolve
    // inside the workspace — textual spelling never decides (e.g. an
    // unresolved alias of the workspace itself is still the workspace).
    let probe = norm;
    for (;;) {
      try {
        const rp = realpathSync(probe);
        return rp === wsPhys || rp.startsWith(wsPhys + sep);
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
  }

  // ---- turn lifecycle -----------------------------------------------------

  /** Register the active turn synchronously, then drive it async. */
  beginTurn(ctx: TurnContext, cb: ProviderCallbacks): void {
    if (this.turn && !this.turn.terminal)
      throw new CodexProviderError(
        "CODEX_BUSY: a turn is already active on this session",
        "CODEX_BUSY",
      );
    this.turn = {
      localTurnId: ctx.turnId,
      providerTurnId: null,
      startRequestKey: null,
      cb,
      seq: 0,
      cancelIntent: false,
      terminal: false,
      noticeCount: 0,
    };
    this.candidateTurnId = null;
    this.preAdmission = [];
    this.finalError = null;
    this.messageItems.clear();
    this.messageTextBytes = 0;
    this.toolTails.clear();
    this.reasoningItems.clear();
    this.planItems.clear();
    this.lastDeltaItemId = null;
    this.desiredModel = ctx.model;
    this.desiredEffort = ctx.effort;
    this.desiredMode = ctx.runtimeMode ?? "supervised";
    void this.driveTurn(ctx).catch(() => {
      /* driveTurn reports every failure through terminate() itself */
    });
  }

  private async driveTurn(ctx: TurnContext): Promise<void> {
    const turn = this.turn!;
    try {
      await this.ensureBound();
    } catch (err) {
      // Bind failure must still terminate THIS turn — the generation check
      // below belongs only to the post-bind phase (a spawn legitimately
      // bumps the generation it creates).
      if (this.turn === turn && !turn.terminal)
        this.terminate("error", (err as Error).message);
      return;
    }
    const gen = this.gen;
    const rpc = this.rpc;
    try {
      if (this.turn !== turn || turn.terminal) return;
      if (turn.cancelIntent) {
        // Cancelled before a server turn existed — never send turn/start.
        this.terminate("interrupted");
        return;
      }
      const result = await rpc!.request(
        "turn/start",
        {
          threadId: this.codexThreadId,
          input: [{ type: "text", text: ctx.prompt, text_elements: [] }],
          // Frozen CodexSession.swift @ d31e093b: summary always "auto";
          // model/effort are per-turn overrides sent verbatim — the
          // server also applies them to subsequent turns on this thread.
          summary: "auto",
          // F06: per-turn policy override — the same frozen table the
          // thread was bound under, applied for THIS turn only.
          ...turnPolicy(ctx.runtimeMode ?? "supervised"),
          ...(ctx.model ? { model: ctx.model } : {}),
          ...(ctx.effort ? { effort: ctx.effort } : {}),
          ...(ctx.serviceTier ? { serviceTierForTurn: ctx.serviceTier } : {}),
          // F06 plan mode — frozen: collaborationMode rides WITH the
          // resolved model (selected or bound); never fabricated when
          // no model id is known.
          ...(() => {
            const m = ctx.model ?? this.boundModel;
            return m
              ? {
                  collaborationMode: {
                    mode: ctx.interactionMode === "plan" ? "plan" : "default",
                    settings: {
                      model: m,
                      reasoning_effort: ctx.effort ?? this.boundEffort ?? null,
                      developer_instructions: null,
                    },
                  },
                }
              : {};
          })(),
        },
        { timeoutMs: this.limits.turnStartTimeoutMs, mutating: true },
        (id) => {
          // Correlation for the frame-level verdict: only the response to
          // THIS request may admit this turn.
          if (this.turn === turn) turn.startRequestKey = rpcIdKey(id);
        },
      );
      // Re-check BOTH the generation and that this response belongs to the
      // same rpc instance that sent the request.
      if (gen !== this.gen || this.rpc !== rpc || this.turn !== turn || turn.terminal) return;
      const providerTurnId = isObj(result) && isObj(result.turn) ? s(result.turn.id) : null;
      if (!providerTurnId)
        throw new CodexProtocolError(
          "turn/start response lacks turn.id",
          "CODEX_PROTOCOL_ERROR",
        );
      if (turn.providerTurnId && turn.providerTurnId !== providerTurnId) {
        // An id surfaced before/around admission that disagrees with the
        // authoritative response is a protocol conflict — fail loudly.
        this.fatal(
          new CodexProtocolError(
            `turn id conflict: earlier id ${turn.providerTurnId} vs response ${providerTurnId}`,
            "CODEX_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      // Admission normally already happened at frame level (same-chunk
      // correlation). If it somehow didn't, admit here — the response is
      // still the only authority.
      if (!turn.providerTurnId) this.admitTurn(turn, providerTurnId);
      else if (turn.providerTurnId !== providerTurnId) {
        this.fatal(
          new CodexProtocolError(
            `turn id mismatch: admitted ${turn.providerTurnId} vs response ${providerTurnId}`,
            "CODEX_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      if (turn.cancelIntent) void this.interrupt();
    } catch (err) {
      if (gen !== this.gen || this.rpc !== rpc || this.turn !== turn || turn.terminal) return;
      this.terminate("error", (err as Error).message);
    }
  }

  /**
   * A successful turn/start response — the ONLY admission authority — has
   * named the provider turn id. Reconcile the early-started candidate (a
   * conflict is fatal, never ignorable) and replay the bounded
   * pre-admission buffer in wire order; frames naming a different turn
   * die inside the normal per-method correlation checks.
   */
  private admitTurn(turn: ActiveTurn, providerTurnId: string): void {
    const candidate = this.candidateTurnId;
    this.candidateTurnId = null;
    if (candidate !== null && candidate !== providerTurnId) {
      this.fatal(
        new CodexProtocolError(
          `turn id conflict: early turn/started ${candidate} vs turn/start response ${providerTurnId}`,
          "CODEX_PROTOCOL_ERROR",
        ),
      );
      return;
    }
    turn.providerTurnId = providerTurnId;
    const queued = this.preAdmission;
    this.preAdmission = [];
    for (const f of queued) {
      if (this.turn !== turn || turn.terminal) {
        // A replayed frame terminated the turn — stop replaying; the rest
        // is answered/dropped by the termination path.
        this.dropPreAdmission("turn ended during buffered replay");
        return;
      }
      if (f.kind === "req") this.onServerRequest(f.id, f.method, f.params);
      else this.dispatchNotification(f.method, f.params);
    }
  }

  /** Discard buffered pre-admission traffic honestly: pending server
   *  requests get an explicit refusal so the server is never left hanging;
   *  notifications count as drops. */
  private dropPreAdmission(reason: string): void {
    const queued = this.preAdmission;
    this.preAdmission = [];
    const rpc = this.rpc;
    for (const f of queued) {
      if (f.kind === "req") rpc?.respondError(f.id, -32602, `turn never admitted: ${reason}`);
      else this.dropped++;
    }
  }

  /** Cancel pressed (or engine denied an approval): decline outstanding
   *  server requests, then interrupt — only when a provider turn exists. */
  cancelTurn(localTurnId: string): void {
    const t = this.turn;
    if (!t || t.localTurnId !== localTurnId || t.terminal) return;
    t.cancelIntent = true;
    // Release every pending server request politely — the interrupt that
    // follows ends the turn either way. The user's picked deny option
    // ("cancel" → frozen "cancel" payload) only applies to the PRESENTED
    // ticket; anything queued behind it declines.
    const front = this.ticketOrder[0];
    for (const key of [...this.ticketOrder])
      this.answerTicket(key, false, key === front ? t.cancelOptionId : undefined);
    if (t.providerTurnId && this.phase === "ready") void this.interrupt();
  }

  /** Engine resolved the PRESENTED approval (approved=true only — a deny
   *  reaches us through decline/cancelTurn instead). The optionId picks
   *  WHICH grant the server remembers: "session" → scope:"session" on
   *  permissions, a server-offered payload on decision requests. */
  resolveApproval(localTurnId: string, approved: boolean, optionId?: string): void {
    const t = this.turn;
    if (!t || t.localTurnId !== localTurnId || t.terminal) return;
    const key = this.ticketOrder[0];
    if (key === undefined) return; // stale resolve — nothing pending
    if (this.tickets.get(key)?.kind === "question") return; // wrong answer path
    this.answerTicket(key, approved, optionId);
  }

  /** Engine DENIED the presented approval with a specific option — the
   *  option decides the wire payload ("cancel" ⇒ frozen "cancel"), then
   *  the turn is interrupted through the normal cancel path. */
  decline(localTurnId: string, optionId: string): void {
    const t = this.turn;
    if (!t || t.localTurnId !== localTurnId || t.terminal) return;
    t.cancelOptionId = optionId;
    this.cancelTurn(localTurnId);
  }

  /**
   * Engine answered the PRESENTED question request. Only the front ticket
   * may be answered — a stale providerKey (withdrawn/superseded) is a
   * no-op, never a cross-request leak. Answers are re-validated against
   * the ticket's own question set before anything reaches the wire.
   */
  answerQuestion(localTurnId: string, providerKey: string, answers: Record<string, string[]>): void {
    const t = this.turn;
    if (!t || t.localTurnId !== localTurnId || t.terminal) return;
    if (this.ticketOrder[0] !== providerKey) return;
    const ticket = this.tickets.get(providerKey);
    if (!ticket || ticket.kind !== "question" || !ticket.questions) return;
    const payload = this.buildAnswerPayload(ticket.questions, answers);
    if (!payload) {
      this.notice("question answer rejected — it did not match the presented questions", "warning");
      return;
    }
    ticket.answerPayload = payload;
    this.answerTicket(providerKey, true);
  }

  /**
   * Re-validate renderer answers against the VALIDATED question set —
   * never the raw params. Unknown question ids, over-long values, extra
   * keys or non-string content reject the whole answer (nothing is sent),
   * so a crafted IPC payload can never alter the wire shape.
   */
  private buildAnswerPayload(
    questions: CodexQuestion[],
    answers: Record<string, string[]>,
  ): Record<string, { answers: string[] }> | null {
    const known = new Set(questions.map((q) => q.id));
    const payload: Record<string, { answers: string[] }> = {};
    const keys = Object.keys(answers);
    if (keys.length > questions.length) return null;
    for (const qid of keys) {
      if (!known.has(qid)) return null;
      const values = answers[qid];
      if (!Array.isArray(values) || values.length > 16) return null;
      const clean: string[] = [];
      for (const v of values) {
        if (typeof v !== "string" || v.length === 0 || v.length > this.limits.questionAnswerBytes)
          return null;
        clean.push(v);
      }
      payload[qid] = { answers: clean };
    }
    return payload;
  }

  private answerTicket(key: string, approved: boolean, optionId?: string): void {
    const ticket = this.tickets.get(key);
    const rpc = this.rpc;
    if (!ticket || ticket.writing || !rpc) return;
    let result: unknown;
    if (ticket.kind === "permissions") {
      // Frozen: approve echoes the requested grant with the picked scope
      // ("turn" or "session"); deny sends an empty grant, turn-scoped.
      result = {
        permissions: approved ? (ticket.permissions ?? {}) : {},
        scope: approved && optionId === "session" ? "session" : "turn",
      };
    } else if (ticket.kind === "question") {
      // `approved` is only true via answerQuestion — a decline/cancel
      // releases the request with an empty answer map (frozen semantics:
      // skipping sends `{answers:{}}`, never an error frame).
      result = { answers: approved ? (ticket.answerPayload ?? {}) : {} };
    } else {
      // Frozen resolveApproval: write back the EXACT payload the server
      // offered under the picked optionId ("cancel" ⇒ "cancel"); a bare
      // interrupt (no option) declines.
      const picked = optionId !== undefined ? ticket.decisionPayloads?.[optionId] : undefined;
      // Frozen fallback for an unlabeled release is "cancel", not "decline".
      result = { decision: picked ?? (approved ? "accept" : "cancel") };
    }
    // The ticket stays PENDING until the write actually completes — queue
    // admission proves nothing. Only the one-shot write ack may retire
    // the ticket and surface the next card.
    ticket.writing = true;
    const queued = rpc.respond(ticket.rpcId, result, (err) => {
      if (this.rpc !== rpc || this.tickets.get(key) !== ticket) return;
      this.onTicketWritten(key, err);
    });
    if (!queued) this.failTicket(key, "the answer could not be queued");
  }

  /** The transport's write verdict for an answer — the only authority that
   *  may retire the ticket. Withdrawal/termination arriving before this
   *  callback already removed the ticket; a late ack then drops quietly
   *  and can never resurrect it. */
  private onTicketWritten(key: string, err: Error | null): void {
    const ticket = this.tickets.get(key);
    if (!ticket || !ticket.writing) return;
    if (err) {
      this.failTicket(key, `the answer write failed: ${err.message}`);
      return;
    }
    this.tickets.delete(key);
    const idx = this.ticketOrder.indexOf(key);
    if (idx >= 0) this.ticketOrder.splice(idx, 1);
    // The engine commits the confirmed decision BEFORE the next card is
    // presented — resolved state can never run ahead of the wire.
    const t = this.turn;
    if (t && !t.terminal) {
      if (ticket.kind === "question") t.cb.onQuestionAnswered?.(key);
      else t.cb.onApprovalAnswerWritten?.(key);
    }
    this.presentNext();
  }

  /** The answer never provably reached the server: expire the ticket
   *  visibly (withdrawn, never "accepted") and surface why. */
  private failTicket(key: string, why: string): void {
    const ticket = this.tickets.get(key);
    if (!this.tickets.delete(key)) return;
    const idx = this.ticketOrder.indexOf(key);
    if (idx >= 0) this.ticketOrder.splice(idx, 1);
    this.notice(
      `${ticket?.kind === "question" ? "question" : "approval"} answer ${why} — the request was expired unanswered`,
      "warning",
    );
    const t = this.turn;
    if (t && !t.terminal) {
      if (ticket?.kind === "question") t.cb.onQuestionWithdrawn?.(key);
      else t.cb.onApprovalWithdrawn?.(key);
    }
    this.presentNext();
  }

  private presentNext(): void {
    const turn = this.turn;
    if (!turn || turn.terminal) return;
    const key = this.ticketOrder[0];
    if (key === undefined) return;
    const ticket = this.tickets.get(key)!;
    if (ticket.kind === "question") {
      if (ticket.questions) {
        turn.cb.onQuestion?.({ providerKey: key, questions: ticket.questions });
      }
      return;
    }
    const isPerms = ticket.kind === "permissions";
    // Decision tickets carry the frozen decisionOptions set (deny-class
    // first — ApprovalCard reverses). Permissions keep the frozen
    // turn/session/decline triple; legacy tickets fall back to once/deny.
    const options: ApprovalRequest["options"] =
      ticket.decisionOptions ??
      (isPerms
        ? [
            { id: "decline", title: "Decline", role: "deny", scope: "none" },
            { id: "session", title: "Allow for session", role: "approve", scope: "session" },
            // Frozen labels the turn-scoped grant "Allow once" (id turn).
            { id: "turn", title: "Allow once", role: "approve", scope: "turn" },
          ]
        : [
            { id: "deny", title: "Deny", role: "deny", scope: "none" },
            { id: "once", title: "Allow once", role: "approve", scope: "once" },
          ]);
    turn.cb.onApproval({
      kind: ticket.kind === "command" ? "command" : "action",
      headline: isPerms ? "Codex requests permissions" : "Codex requests approval",
      title: bounded(ticket.title, this.limits.approvalTitleBytes),
      detail: bounded(ticket.detail, this.limits.approvalDetailBytes),
      ...(ticket.reason ? { reason: bounded(ticket.reason, 500) } : {}),
      symbol: "exclamationmark.shield",
      options,
      providerKey: key,
    });
  }

  /**
   * Frozen decisionOptions port: the server's availableDecisions maps to
   * Approve / Approve for session / Decline / Stop turn (+ the command-
   * only execpolicy amendment → "Always allow"); missing/malformed input
   * falls back to the frozen default set. Option order is deny-class
   * FIRST so ApprovalCard's reverse paints the frozen sequence
   * (approve, approveAlways, decline, cancel). Payloads are written
   * back verbatim on the wire.
   */
  private decisionOptions(
    available: unknown,
    command: boolean,
  ): { options: import("../shared/types").ApprovalOption[]; payloads: Record<string, unknown> } {
    type Opt = import("../shared/types").ApprovalOption;
    const list = Array.isArray(available) && available.length <= 8
      ? available
      : ["accept", "acceptForSession", "decline", "cancel"];
    const options: Opt[] = [];
    const payloads: Record<string, unknown> = {};
    for (const d of list) {
      if (typeof d === "string" && d.length <= 40) {
        const opt: Opt | null =
          d === "accept"
            ? { id: "accept", title: "Approve", role: "approve", scope: "once" }
            : d === "acceptForSession"
              ? { id: "acceptForSession", title: "Approve for session", role: "approve", scope: "session" }
              : d === "decline"
                ? { id: "decline", title: "Decline", role: "deny", scope: "none" }
                : d === "cancel"
                  ? { id: "cancel", title: "Stop turn", role: "deny", scope: "none" }
                  : null;
        if (opt) {
          options.push(opt);
          payloads[opt.id] = d;
        }
      } else if (
        command &&
        isObj(d) &&
        "acceptWithExecpolicyAmendment" in d &&
        JSON.stringify(d).length <= 2048
      ) {
        options.push({ id: "amend", title: "Always allow", role: "approve", scope: "always" });
        payloads["amend"] = d;
      }
    }
    // Deny-class first in the array: cancel < decline < approveAlways <
    // approve — reversed on the card this is the frozen visual order.
    const rank = (o: Opt): number =>
      o.role === "approve" ? (o.scope === "once" ? 3 : 2) : o.id === "decline" ? 1 : 0;
    options.sort((a, b) => rank(a) - rank(b));
    return { options, payloads };
  }

  private withdrawTicket(key: string): void {
    const ticket = this.tickets.get(key);
    if (!this.tickets.delete(key)) return;
    const idx = this.ticketOrder.indexOf(key);
    if (idx < 0) return;
    this.ticketOrder.splice(idx, 1);
    if (idx === 0) {
      const cb = this.turn && !this.turn.terminal ? this.turn.cb : null;
      if (ticket?.kind === "question") cb?.onQuestionWithdrawn?.(key);
      else cb?.onApprovalWithdrawn?.(key);
      this.presentNext();
    }
  }

  private withdrawAll(): void {
    while (this.ticketOrder.length) this.withdrawTicket(this.ticketOrder[0]!);
    this.tickets.clear();
  }

  // ---- connection ---------------------------------------------------------

  /** Serialized spawn + handshake + thread bind. Reconnects a dead session. */
  private ensureBound(): Promise<void> {
    if (this.phase === "ready" && this.transport && this.rpc) return Promise.resolve();
    this.bindPromise ??= this.spawnAndBind().finally(() => {
      this.bindPromise = null;
    });
    return this.bindPromise;
  }

  private async spawnAndBind(): Promise<void> {
    if (this.disposed) throw new CodexProtocolError("session disposed", "CODEX_CONNECTION_CLOSED");
    // Never let an unconfirmed teardown trail an unbounded chain of new
    // connections: settle the previous transport's cleanup first; if the
    // child STILL hasn't closed, refuse instead of leaking another spawn.
    for (const old of [...this.transports]) {
      const res = await old.dispose();
      if (!res.confirmed && old.hasChild) {
        throw new CodexProtocolError(
          `CODEX_CONNECTION_CLOSED: previous child pid ${old.pid ?? "?"} still unconfirmed — refusing a new spawn`,
          "CODEX_CONNECTION_CLOSED",
        );
      }
    }
    this.gen++;
    const gen = this.gen;
    this.phase = "connecting";
    const cfg = this.provider.config;
    const spec = this.provider.buildSpec(this.workspace.directory);
    let rpc: CodexRpc | null = null;
    const transport = new StdioTransport<CodexMessage>(
      spec,
      { ...DEFAULT_TRANSPORT_LIMITS, ...this.provider.transportLimits },
      {
        // Each callback captures ITS transport/rpc — a late frame or close
        // from an older generation can never reach the new instances.
        onFrame: (m) => {
          if (this.transport === transport && this.rpc === rpc && rpc) {
            // Admission verdicts land at FRAME level, before the request
            // promise's microtask continuation: a successful turn/start
            // response admits its provider turn (buffered frames replay);
            // a failed one terminates the turn synchronously so a
            // same-chunk turn/completed can never overtake it into done.
            if (m.kind === "response") {
              const pt = this.turn;
              // The verdict counts ONLY when the response answers THIS
              // turn's own turn/start request (typed key) — or, for a bare
              // id:null error, when our start request is provably the sole
              // in-flight call. A previous turn's late response can never
              // attach to a new turn.
              const answeredKey =
                m.id !== null
                  ? rpcIdKey(m.id)
                  : m.error !== null
                    ? rpc.solePendingKey()
                    : null;
              const isTurnStart =
                pt !== null &&
                pt.startRequestKey !== null &&
                answeredKey === pt.startRequestKey;
              if (pt && !pt.terminal && isTurnStart) {
                if (m.error) {
                  this.terminate(
                    "error",
                    `${m.error.code}: ${m.error.message}`,
                  );
                } else {
                  const tid =
                    isObj(m.result) && isObj(m.result.turn) ? s(m.result.turn.id) : null;
                  if (tid && !pt.providerTurnId) this.admitTurn(pt, tid);
                  else if (tid && pt.providerTurnId !== tid)
                    this.fatal(
                      new CodexProtocolError(
                        `turn id mismatch: admitted ${pt.providerTurnId} vs response ${tid}`,
                        "CODEX_PROTOCOL_ERROR",
                      ),
                    );
                }
              }
            }
            rpc.onFrame(m);
          } else this.dropped++;
        },
        onProtocolError: (err) => {
          if (this.transport === transport) this.fatal(err);
          else this.dropped++;
        },
        onExit: () => {},
        onClose: (code, signal) => {
          this.onDeliveredClose(transport, code, signal);
        },
        onSpawnError: (err) => {
          if (this.transport === transport)
            this.fatal(new CodexProtocolError(`spawn failed: ${err.message}`, "CODEX_PROTOCOL_ERROR"));
          else this.dropped++;
        },
      },
      this.provider.spawnImplForMode(),
      codexWireCodec(256 * 1024),
    );
    this.transports.add(transport);
    this.transport = transport;
    rpc = new CodexRpc(
      { send: (m, ack) => transport.send(m, ack) },
      {
        onServerRequest: (id, method, params) => {
          if (this.rpc === rpc) this.onServerRequest(id, method, params);
          else this.dropped++;
        },
        onNotification: (method, params) => {
          if (this.rpc === rpc) this.onNotification(method, params);
          else this.dropped++;
        },
        onClosed: () => {},
        onFatal: (err) => {
          if (this.rpc === rpc) this.fatal(err);
          else this.dropped++;
        },
      },
      {
        requestTimeoutMs: this.limits.requestTimeoutMs,
        onMutatingTimeout: (method) =>
          this.fatal(
            new CodexProtocolError(
              `CODEX_REQUEST_TIMEOUT: mutating request ${method} timed out — wire state unknown`,
              "CODEX_REQUEST_TIMEOUT",
            ),
          ),
      },
    );
    this.rpc = rpc;
    try {
      transport.start();
      if (gen !== this.gen || this.rpc !== rpc)
        throw new CodexProtocolError(
          "connection died during spawn",
          "CODEX_CONNECTION_CLOSED",
        );

      // -- initialize + initialized ------------------------------------------
      const init = await rpc.request(
      "initialize",
      {
        clientInfo: {
          name: this.provider.clientName,
          title: "Tivano",
          version: this.provider.clientVersion,
        },
      },
      { timeoutMs: this.limits.initializeTimeoutMs, mutating: true },
    );
    if (gen !== this.gen || this.rpc !== rpc)
      throw new CodexProtocolError("connection died during initialize", "CODEX_CONNECTION_CLOSED");
    if (!isObj(init))
      throw new CodexProtocolError("initialize response is not an object", "CODEX_PROTOCOL_ERROR");
    if (s(init.codexHome) && s(init.codexHome) !== cfg.codexHome)
      throw new CodexProtocolError(
        `CODEX_HOME mismatch: server reports ${s(init.codexHome)}`,
        "CODEX_PROTOCOL_ERROR",
      );
    rpc.notify("initialized");

    // -- bind to a codex thread ---------------------------------------------
    const binding = this.provider.lookupBinding(this.localThreadId);
    if (binding) {
      if (binding.providerId !== CODEX_PROVIDER_ID)
        throw new CodexProviderError(
          "CODEX_RESUME_FAILED: stored binding belongs to a different provider",
          "CODEX_RESUME_FAILED",
        );
      if (binding.schemaPin !== CODEX_SCHEMA_PIN)
        throw new CodexProviderError(
          `CODEX_RESUME_FAILED: binding was written for protocol pin ${binding.schemaPin}, this build speaks ${CODEX_SCHEMA_PIN}`,
          "CODEX_RESUME_FAILED",
        );
      if (binding.codexHomeId !== cfg.codexHomeId)
        throw new CodexProviderError(
          "CODEX_RESUME_FAILED: CODEX_HOME changed — refusing to resume into the wrong history",
          "CODEX_RESUME_FAILED",
        );
      // The persisted cwd is metadata, not a grant: it must equal the
      // current authorized workspace or the binding was tampered/moved.
      if (binding.cwd !== this.workspacePhys())
        throw new CodexProviderError(
          `CODEX_RESUME_FAILED: binding cwd ${binding.cwd} does not match the authorized workspace`,
          "CODEX_RESUME_FAILED",
        );
      let res: unknown;
      try {
        res = await this.requestThread(
          rpc,
          "thread/resume",
          {
            threadId: binding.codexThreadId,
            cwd: this.workspace.directory,
            ...bindPolicy(this.desiredMode),
            excludeTurns: true,
            ...(this.desiredModel ? { model: this.desiredModel } : {}),
          },
        );
      } catch (err) {
        // Wire-fatal errors (close, mutating timeout) keep their own code —
        // the connection is already poisoned. Any other refusal — including
        // the server's own -32000 — is a failed resume, surfaced as such.
        const code = (err as CodexProtocolError).code;
        if (code === "CODEX_CONNECTION_CLOSED" || code === "CODEX_REQUEST_TIMEOUT") throw err;
        throw new CodexProviderError(
          `CODEX_RESUME_FAILED: ${(err as Error).message}`,
          "CODEX_RESUME_FAILED",
        );
      }
      if (gen !== this.gen || this.rpc !== rpc)
        throw new CodexProtocolError("connection died during thread/resume", "CODEX_CONNECTION_CLOSED");
      const threadId = isObj(res) && isObj(res.thread) ? s(res.thread.id) : null;
      if (!threadId)
        throw new CodexProviderError(
          "CODEX_RESUME_FAILED: thread/resume response lacks thread.id",
          "CODEX_RESUME_FAILED",
        );
      if (threadId !== binding.codexThreadId)
        throw new CodexProviderError(
          `CODEX_RESUME_FAILED: server resumed ${threadId}, expected ${binding.codexThreadId}`,
          "CODEX_RESUME_FAILED",
        );
      this.codexThreadId = threadId;
      this.reportThreadModel(res);
    } else {
      const res = await this.requestThread(
        rpc,
        "thread/start",
        {
          cwd: this.workspace.directory,
          ...bindPolicy(this.desiredMode),
          ephemeral: false,
          ...(this.desiredModel ? { model: this.desiredModel } : {}),
        },
      );
      if (gen !== this.gen || this.rpc !== rpc)
        throw new CodexProtocolError("connection died during thread/start", "CODEX_CONNECTION_CLOSED");
      const threadId = isObj(res) && isObj(res.thread) ? s(res.thread.id) : null;
      if (!threadId)
        throw new CodexProtocolError(
          "thread/start response lacks thread.id",
          "CODEX_PROTOCOL_ERROR",
        );
      const newBinding: ProviderThreadBinding = {
        providerId: CODEX_PROVIDER_ID,
        codexThreadId: threadId,
        cwd: this.workspacePhys(),
        codexHomeId: cfg.codexHomeId,
        schemaPin: CODEX_SCHEMA_PIN,
        cliVersion: "unknown",
        savedAt: Date.now(),
      };
      // Persist BEFORE the thread is usable — a restart must be able to
      // resume exactly this codex thread.
      await this.provider.bindThread(this.localThreadId, newBinding);
      this.codexThreadId = threadId;
      this.reportThreadModel(res);
    }
    this.phase = "ready";
    } catch (err) {
      // A half-bound connection must not linger until the next request
      // trips over it: detach + dispose NOW. The transport keeps its
      // `transports` attribution until the OS close is delivered, so a
      // still-living child stays retry-visible instead of orphaned.
      if (this.rpc === rpc) this.rpc = null;
      if (this.transport === transport) this.transport = null;
      this.phase = "dead";
      this.dropPreAdmission("bind failed");
      void transport.dispose();
      throw err;
    }
  }

  /**
   * The thread/start|resume response echoes the thread's effective
   * model/effort (pinned Thread schema). Reported to the engine for the
   * picker's diagnostic state — verbatim, never locally reinterpreted.
   */
  private reportThreadModel(res: unknown): void {
    const thread = isObj(res) && isObj(res.thread) ? res.thread : null;
    if (!thread) return;
    const model = s(thread.model);
    const effort = s(thread.reasoningEffort);
    // The server-resolved bound pair — collaborationMode's home when
    // the user has not selected a model (frozen activeModel).
    if (model !== null) this.boundModel = model;
    if (effort !== null) this.boundEffort = effort;
    const cb = this.turn && !this.turn.terminal ? this.turn.cb : null;
    try {
      cb?.onModelReport?.(model, effort);
    } catch {
      /* a callback fault must never break the bind */
    }
  }

  /**
   * Provider-owned model catalog via model/list (frozen: paginated with
   * `cursor`, ≤10 pages, hidden entries skipped). Read-only — a failure
   * or timeout NEVER poisons the session; the caller maps it to an
   * honest "unavailable" catalog. All fields bounded/defensively parsed.
   */
  async fetchModelCatalog(): Promise<CodexModelOption[]> {
    const rpc = this.rpc;
    if (this.phase !== "ready" || !rpc)
      throw new CodexProtocolError("session is not bound", "CODEX_CONNECTION_CLOSED");
    const models: CodexModelOption[] = [];
    let cursor: unknown = null;
    const gen = this.gen;
    for (let page = 0; page < 10 && models.length <= 128; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== null && cursor !== undefined) params.cursor = cursor;
      const res = await rpc.request("model/list", params, {
        timeoutMs: this.limits.requestTimeoutMs,
      });
      if (gen !== this.gen || this.rpc !== rpc)
        throw new CodexProtocolError("connection recycled", "CODEX_CONNECTION_CLOSED");
      const data = isObj(res) && Array.isArray(res.data) ? res.data : [];
      for (const m of data.slice(0, 128)) {
        if (!isObj(m) || m.hidden === true) continue;
        const id = s(m.id);
        if (!id || id.length > 200) continue;
        const efforts: string[] = [];
        if (Array.isArray(m.supportedReasoningEfforts)) {
          for (const e of m.supportedReasoningEfforts.slice(0, 16)) {
            const v = isObj(e) ? s(e.reasoningEffort) : null;
            if (v && v.length <= 64) efforts.push(v);
          }
        }
        let fastTier: string | undefined;
        if (Array.isArray(m.serviceTiers)) {
          for (const t of m.serviceTiers.slice(0, 16)) {
            if (!isObj(t)) continue;
            const tid = s(t.id);
            if (!tid) continue;
            const label = `${tid} ${s(t.name) ?? ""}`.toLowerCase();
            if (label.includes("fast") || label.includes("priority")) {
              fastTier = tid;
              break;
            }
          }
        }
        const name = s(m.displayName);
        const detail = s(m.description);
        const defaultEffort = s(m.defaultReasoningEffort);
        models.push({
          id,
          name: name && name.length <= 200 ? name : id,
          ...(detail && detail.length <= 1000 ? { detail } : {}),
          efforts,
          ...(defaultEffort && defaultEffort.length <= 64 ? { defaultEffort } : {}),
          isDefault: m.isDefault === true,
          ...(fastTier ? { fastTier } : {}),
        });
      }
      const next = isObj(res) ? res.nextCursor : null;
      if (next === null || next === undefined) break;
      cursor = next;
    }
    return models;
  }

  /**
   * F09: frozen compact() — thread/compact/start against the bound codex
   * thread. A session whose transport is gone is "not running".
   */
  async compact(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || !this.codexThreadId || this.phase !== "ready") {
      throw new CodexProviderError(
        "CODEX_NOT_RUNNING: the session is not live",
        "CODEX_NOT_RUNNING",
      );
    }
    await rpc.request(
      "thread/compact/start",
      { threadId: this.codexThreadId },
      { timeoutMs: 120_000, mutating: true },
    );
  }

  private async interrupt(): Promise<void> {
    const turn = this.turn;
    const rpc = this.rpc;
    if (!turn?.providerTurnId || !rpc || !this.codexThreadId) return;
    try {
      await rpc.request(
        "turn/interrupt",
        { threadId: this.codexThreadId, turnId: turn.providerTurnId },
        { timeoutMs: this.limits.interruptTimeoutMs, mutating: true },
      );
    } catch (err) {
      if (this.turn === turn && !turn.terminal)
        this.notice(`interrupt request failed: ${(err as Error).message}`, "warning");
    }
  }

  // ---- inbound dispatch ----------------------------------------------------

  /** True while a live turn awaits its turn/start response — inbound
   *  traffic that passed thread-level schema waits in the bounded buffer. */
  private inAdmissionWindow(): boolean {
    const t = this.turn;
    return !!t && !t.terminal && t.providerTurnId === null && this.phase === "ready";
  }

  private bufferPreAdmission(
    f:
      | { kind: "req"; id: RpcId; method: string; params: unknown }
      | { kind: "notif"; method: string; params: unknown },
  ): void {
    if (this.preAdmission.length >= this.limits.maxPreAdmissionFrames) {
      this.fatal(
        new CodexProtocolError(
          "pre-admission frame flood exceeded the bound",
          "CODEX_PROTOCOL_ERROR",
        ),
      );
      return;
    }
    this.preAdmission.push(f);
  }

  /**
   * Correlate params to THIS thread and THIS admitted turn — both
   * `threadId` and `turnId` are REQUIRED by the per-method schema; a
   * missing or foreign association is a counted drop, never processed.
   */
  private turnScoped(params: unknown): ActiveTurn | null {
    const t = this.turn;
    if (!t || t.terminal || this.phase !== "ready" || t.providerTurnId === null) {
      this.dropped++;
      return null;
    }
    const p = isObj(params) ? params : {};
    if (s(p.threadId) !== this.codexThreadId || s(p.turnId) !== t.providerTurnId) {
      this.dropped++;
      return null;
    }
    return t;
  }

  private onServerRequest(id: RpcId, method: string, params: unknown): void {
    const rpc = this.rpc;
    if (!rpc) return;
    const decline = (note: string, code = -32601) => {
      this.notice(note, "warning");
      rpc.respondError(id, code, note);
    };
    const p = isObj(params) ? params : {};
    // Strict correlation: the schema makes threadId/turnId/itemId
    // required — a request missing or mismatching them can never be
    // granted or attached to the live turn.
    if (s(p.threadId) !== this.codexThreadId) {
      this.dropped++;
      rpc.respondError(id, -32602, "request does not target this thread");
      return;
    }
    const t = this.turn;
    const liveTurn = t && !t.terminal ? t : null;
    // Admission window: this-thread requests wait in the bounded buffer
    // until the turn/start response arbitrates the real provider turn id —
    // never answered early against an unverified id.
    if (liveTurn && liveTurn.providerTurnId === null) {
      this.bufferPreAdmission({ kind: "req", id, method, params });
      return;
    }
    if (s(p.turnId) === null || !liveTurn?.providerTurnId || s(p.turnId) !== liveTurn.providerTurnId) {
      // Covers missing turnId, unadmitted turn and stale previous turns.
      this.dropped++;
      rpc.respondError(id, -32602, "request does not target the current turn");
      return;
    }
    if (!s(p.itemId)) {
      this.dropped++;
      rpc.respondError(id, -32602, "request lacks itemId");
      return;
    }
    const activeTurn = liveTurn;
    const enqueue = (ticket: ApprovalTicket): boolean => {
      if (this.tickets.has(ticket.key)) {
        // Same typed RPC id twice — never re-enqueue or overwrite.
        this.dropped++;
        rpc.respondError(id, -32602, "duplicate request id");
        return false;
      }
      if (this.ticketOrder.length >= this.limits.maxPendingApprovals) {
        rpc.respondError(id, -32000, "approval queue bound reached");
        return false;
      }
      this.tickets.set(ticket.key, ticket);
      this.ticketOrder.push(ticket.key);
      if (this.ticketOrder.length === 1) this.presentNext();
      return true;
    };
    const base = (kind: ApprovalTicket["kind"], title: string, detail: string): ApprovalTicket => ({
      key: rpcIdKey(id),
      rpcId: id,
      kind,
      itemId: s(p.itemId)!,
      title,
      detail,
      ...(s(p.reason) ? { reason: s(p.reason)! } : {}),
    });

    switch (method) {
      case "item/commandExecution/requestApproval": {
        const cmd = s(p.command) ?? "(command not disclosed)";
        const cwd = s(p.cwd);
        // A cwd outside the authorized workspace would silently widen the
        // grant — decline it visibly instead of dressing it as approvable.
        if (cwd && !this.pathInsideWorkspace(cwd)) {
          decline(`command approval requests cwd outside the workspace — declined`, -32602);
          return;
        }
        // The FULL command must fit the card — a truncated command is a
        // consent the user never saw, so the whole request is declined.
        if (cmd.length > this.limits.approvalTitleBytes) {
          decline("command exceeds the displayable length — declined", -32602);
          return;
        }
        const detail = cwd ? `cwd: ${cwd}` : "";
        if (detail.length > this.limits.approvalDetailBytes) {
          decline("command context exceeds the displayable length — declined", -32602);
          return;
        }
        const ticket = base("command", cmd, detail);
        const dec = this.decisionOptions(p.availableDecisions, true);
        ticket.decisionOptions = dec.options;
        ticket.decisionPayloads = dec.payloads;
        enqueue(ticket);
        break;
      }
      case "item/fileChange/requestApproval": {
        const grant = s(p.grantRoot);
        if (grant && !this.pathInsideWorkspace(grant)) {
          decline("file-change grantRoot escapes the workspace — declined", -32602);
          return;
        }
        const detail = grant ? `requested write root: ${grant}` : "";
        if (detail.length > this.limits.approvalDetailBytes) {
          decline("file-change request exceeds the displayable length — declined", -32602);
          return;
        }
        const ticket = base("fileChange", "Apply file changes", detail);
        const dec = this.decisionOptions(undefined, false);
        ticket.decisionOptions = dec.options;
        ticket.decisionPayloads = dec.payloads;
        enqueue(ticket);
        break;
      }
      case "item/permissions/requestApproval": {
        const validated = this.validatePermissions(p.permissions);
        if (!validated.ok) {
          decline(`unsafe or undisplayable permission request — declined (${validated.why})`, -32602);
          return;
        }
        const ticket = base(
          "permissions",
          "Grant requested permissions",
          validated.describe,
        );
        ticket.permissions = validated.grant;
        enqueue(ticket);
        break;
      }
      case "mcpServer/elicitation/request":
        // Protocol-shaped refusal — never leave the server hanging.
        rpc.respond(id, { action: "decline" });
        this.notice("MCP elicitation declined — interactive forms are unsupported", "warning");
        break;
      case "item/tool/requestUserInput": {
        const parsed = this.parseQuestions(p.questions);
        if (!parsed.ok) {
          // A malformed/oversized question can never strand the turn: the
          // request is refused IN PROTOCOL and the server moves on.
          decline(`question request ${parsed.why} — declined`, -32602);
          return;
        }
        const ticket = base("question", "Codex asks a question", "");
        ticket.questions = parsed.questions;
        enqueue(ticket);
        break;
      }
      default:
        decline(`unsupported Codex server request "${method}" — declined`);
    }
  }

  /**
   * Strict, bounded parse of `requestUserInput.questions` (frozen wire
   * shape: id/header/question/options[{label,description}]/isOther/
   * isSecret). Unlike the frozen compactMap — which silently dropped
   * malformed entries — ANY malformed or oversized field declines the
   * whole request: a partially-shown question is consent the user never
   * gave. Unknown keys decline too (never guessed at). The request is
   * still refused IN PROTOCOL, so a bad question cannot strand the turn.
   */
  private parseQuestions(raw: unknown):
    | { ok: true; questions: CodexQuestion[] }
    | { ok: false; why: string } {
    if (!Array.isArray(raw)) return { ok: false, why: "questions is not an array" };
    if (raw.length === 0) return { ok: false, why: "questions is empty" };
    if (raw.length > this.limits.maxQuestions) return { ok: false, why: "too many questions" };
    const Q_KEYS = new Set(["id", "header", "question", "options", "isOther", "isSecret"]);
    const O_KEYS = new Set(["label", "description"]);
    const out: CodexQuestion[] = [];
    const seenIds = new Set<string>();
    for (const q of raw) {
      if (!isObj(q)) return { ok: false, why: "question is not an object" };
      for (const k of Object.keys(q))
        if (!Q_KEYS.has(k)) return { ok: false, why: `unknown question field ${k}` };
      const id = s(q.id);
      if (!id || id.length > 200) return { ok: false, why: "question id missing or oversized" };
      if (seenIds.has(id)) return { ok: false, why: `duplicate question id "${bounded(id, 60)}"` };
      seenIds.add(id);
      const header = q.header === undefined ? "" : q.header;
      const prompt = q.question === undefined ? "" : q.question;
      if (typeof header !== "string" || header.length > this.limits.questionHeaderBytes)
        return { ok: false, why: `question "${bounded(id, 60)}" header oversized or not a string` };
      if (typeof prompt !== "string" || prompt.length > this.limits.questionPromptBytes)
        return { ok: false, why: `question "${bounded(id, 60)}" prompt oversized or not a string` };
      if (q.isOther !== undefined && typeof q.isOther !== "boolean")
        return { ok: false, why: `question "${bounded(id, 60)}" isOther not boolean` };
      if (q.isSecret !== undefined && typeof q.isSecret !== "boolean")
        return { ok: false, why: `question "${bounded(id, 60)}" isSecret not boolean` };
      const options = q.options === undefined ? [] : q.options;
      if (!Array.isArray(options) || options.length > this.limits.maxQuestionChoices)
        return { ok: false, why: `question "${bounded(id, 60)}" options malformed or oversized` };
      const choices: CodexQuestionChoice[] = [];
      for (const o of options) {
        if (!isObj(o)) return { ok: false, why: `question "${bounded(id, 60)}" option not an object` };
        for (const k of Object.keys(o))
          if (!O_KEYS.has(k)) return { ok: false, why: `question option field ${k} unknown` };
        const label = s(o.label);
        if (!label || label.length > this.limits.questionChoiceLabelBytes)
          return { ok: false, why: `question "${bounded(id, 60)}" option label missing or oversized` };
        const detail = o.description;
        if (detail !== undefined && (typeof detail !== "string" || detail.length > this.limits.questionChoiceDetailBytes))
          return { ok: false, why: `question "${bounded(id, 60)}" option description oversized` };
        choices.push(detail !== undefined ? { label, detail } : { label });
      }
      out.push({
        id,
        header,
        prompt,
        choices,
        allowsOther: q.isOther === true,
        isSecret: q.isSecret === true,
      });
    }
    return { ok: true, questions: out };
  }

  /**
   * Minimal-privilege permission validation (pinned RequestPermissionProfile
   * / AdditionalFileSystemPermissions / FileSystemSandboxEntry): only fields
   * the product can fully display AND physically verify may be granted.
   * Unknown keys, glob/special paths, out-of-workspace paths, oversized
   * lists or unbounded depths decline the WHOLE request — a partial grant
   * would authorize something the user never saw.
   */
  private validatePermissions(raw: unknown):
    | { ok: true; grant: Record<string, unknown>; describe: string }
    | { ok: false; why: string } {
    if (!isObj(raw)) return { ok: false, why: "profile is not an object" };
    for (const k of Object.keys(raw))
      if (k !== "network" && k !== "fileSystem") return { ok: false, why: `unknown field ${k}` };
    const grant: Record<string, unknown> = {};
    const desc: string[] = [];
    if (raw.network !== undefined && raw.network !== null) {
      const net = raw.network;
      if (!isObj(net)) return { ok: false, why: "network is not an object" };
      for (const k of Object.keys(net)) if (k !== "enabled") return { ok: false, why: `network.${k}` };
      if (net.enabled !== true && net.enabled !== false && net.enabled !== null)
        return { ok: false, why: "network.enabled not boolean" };
      if (net.enabled === true) {
        grant.network = { enabled: true };
        desc.push("network access");
      }
    }
    if (raw.fileSystem !== undefined && raw.fileSystem !== null) {
      const fs = raw.fileSystem;
      if (!isObj(fs)) return { ok: false, why: "fileSystem is not an object" };
      for (const k of Object.keys(fs))
        if (!["read", "write", "globScanMaxDepth", "entries"].includes(k))
          return { ok: false, why: `fileSystem.${k}` };
      const grantFs: Record<string, unknown> = {};
      const listCheck = (v: unknown, name: string): string[] | null | "bad" => {
        if (v === undefined || v === null) return null;
        if (!Array.isArray(v)) return "bad";
        if (v.length > this.limits.maxPermissionPaths) return "bad";
        const out: string[] = [];
        for (const e of v) {
          if (typeof e !== "string") return "bad";
          if (!this.pathInsideWorkspace(e)) return "bad";
          out.push(e);
        }
        return out;
      };
      const read = listCheck(fs.read, "read");
      if (read === "bad") return { ok: false, why: "read paths unsafe or out-of-workspace" };
      const write = listCheck(fs.write, "write");
      if (write === "bad") return { ok: false, why: "write paths unsafe or out-of-workspace" };
      if (read && read.length) {
        grantFs.read = read;
        desc.push(`read: ${read.join(", ")}`);
      }
      if (write && write.length) {
        grantFs.write = write;
        desc.push(`write: ${write.join(", ")}`);
      }
      if (fs.globScanMaxDepth !== undefined && fs.globScanMaxDepth !== null) {
        const d = fs.globScanMaxDepth;
        if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 16)
          return { ok: false, why: "globScanMaxDepth out of range" };
        grantFs.globScanMaxDepth = d;
        desc.push(`glob scan depth ${d}`);
      }
      if (fs.entries !== undefined && fs.entries !== null) {
        if (!Array.isArray(fs.entries) || fs.entries.length > this.limits.maxPermissionPaths)
          return { ok: false, why: "entries unbounded" };
        const out: Array<Record<string, unknown>> = [];
        for (const e of fs.entries) {
          if (!isObj(e)) return { ok: false, why: "entry not an object" };
          for (const k of Object.keys(e))
            if (k !== "access" && k !== "path") return { ok: false, why: `entry.${k}` };
          if (e.access !== "read" && e.access !== "write" && e.access !== "deny")
            return { ok: false, why: "entry.access invalid" };
          const path = e.path;
          if (!isObj(path)) return { ok: false, why: "entry.path not an object" };
          for (const k of Object.keys(path))
            if (k !== "type" && k !== "path") return { ok: false, why: `entry.path.${k}` };
          // Only concrete paths are verifiable; globs/special roots are
          // not safely resolvable to the workspace — decline the request.
          if (path.type !== "path" || typeof path.path !== "string")
            return { ok: false, why: "glob or special paths are unsupported" };
          if (!this.pathInsideWorkspace(path.path))
            return { ok: false, why: "entry path outside workspace" };
          out.push({ access: e.access, path: { type: "path", path: path.path } });
        }
        if (out.length) {
          grantFs.entries = out;
          // Every entry is enumerated with its access and FULL concrete
          // path — a grant the user cannot fully read is never granted.
          for (const e of out) {
            const ep = e.path as Record<string, unknown>;
            desc.push(`${e.access}: ${ep.path}`);
          }
        }
      }
      if (Object.keys(grantFs).length) grant.fileSystem = grantFs;
    }
    if (!Object.keys(grant).length)
      return { ok: false, why: "nothing grantable was requested" };
    const describe = desc.join("\n");
    // Display-budget rule: if the complete enumeration cannot be shown,
    // the WHOLE request is refused — approving a truncated description
    // would grant paths the user never saw.
    if (describe.length > this.limits.approvalDetailBytes)
      return { ok: false, why: "permission list exceeds the displayable length" };
    return { ok: true, grant, describe };
  }

  /**
   * Inbound notification gate. Per-method schema: every turn-scoped frame
   * must carry `threadId` equal to this session's bound thread — missing or
   * foreign association is a counted drop, never processed and never
   * buffered. Frames that pass schema while the turn awaits its turn/start
   * response wait in the bounded pre-admission buffer — applied only after
   * the response arbitrates, in arrival order.
   */
  private onNotification(method: string, params: unknown): void {
    const p = isObj(params) ? params : {};
    if (method === "turn/started") {
      // Candidate only — a notification can NEVER admit the turn.
      if (s(p.threadId) !== this.codexThreadId || !isObj(p.turn) || !s(p.turn.id)) {
        this.dropped++;
        return;
      }
      const id = s(p.turn.id)!;
      const t = this.turn;
      if (!t || t.terminal) {
        this.dropped++;
        return;
      }
      if (t.providerTurnId !== null) {
        if (t.providerTurnId === id) {
          this.dropped++; // benign duplicate
          return;
        }
        this.fatal(
          new CodexProtocolError(
            `turn/started ${id} conflicts with admitted turn ${t.providerTurnId}`,
            "CODEX_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      if (this.candidateTurnId === null) this.candidateTurnId = id;
      else if (this.candidateTurnId !== id) this.dropped++;
      return;
    }
    if (s(p.threadId) !== this.codexThreadId) {
      this.dropped++;
      return;
    }
    if (this.inAdmissionWindow()) {
      this.bufferPreAdmission({ kind: "notif", method, params });
      return;
    }
    this.dispatchNotification(method, params);
  }

  /** Dispatch a schema-passed, this-thread frame against an admitted turn. */
  private dispatchNotification(method: string, params: unknown): void {
    const p = isObj(params) ? params : {};
    switch (method) {
      case "item/agentMessage/delta": {
        const t = this.turnScoped(params);
        if (!t) return;
        const itemId = s(p.itemId);
        const delta = s(p.delta);
        if (!itemId || delta === null) {
          this.dropped++;
          return;
        }
        let item = this.messageItems.get(itemId);
        if (item?.completed) {
          // Late delta for a finished item — dropped, never re-displayed.
          this.dropped++;
          return;
        }
        if (!item) {
          if (this.messageItems.size >= this.limits.maxAgentItems) {
            this.dropped++;
            return;
          }
          item = { text: "", completed: false };
          this.messageItems.set(itemId, item);
        }
        // Only retained bytes may reach the renderer — a raw unbounded
        // delta would make stream output diverge from persisted content.
        const room = this.limits.maxAssistantTextBytes - this.messageTextBytes;
        if (room <= 0) {
          this.dropped++;
          return;
        }
        const piece = delta.length <= room ? delta : delta.slice(0, room);
        if (piece.length < delta.length) this.dropped++;
        item.text += piece;
        this.messageTextBytes += piece.length;
        if (this.lastDeltaItemId !== null && this.lastDeltaItemId !== itemId) {
          // Item switch mid-stream: a blind append would diverge from the
          // ordered composition — emit the whole composition instead.
          this.emitMessage(t);
        } else {
          t.cb.onChunk(++t.seq, piece);
        }
        this.lastDeltaItemId = itemId;
        return;
      }
      case "item/started": {
        const t = this.turnScoped(params);
        if (!t) return;
        if (!isObj(p.item) || !s(p.item.id)) {
          this.dropped++;
          return;
        }
        const item = p.item;
        const id = s(item.id)!;
        if (item.type === "agentMessage") {
          if (!this.messageItems.has(id)) {
            if (this.messageItems.size >= this.limits.maxAgentItems) {
              this.dropped++;
              return;
            }
            const initial = typeof item.text === "string" ? item.text : "";
            const room = Math.max(0, this.limits.maxAssistantTextBytes - this.messageTextBytes);
            const kept = initial.length <= room ? initial : initial.slice(0, room);
            this.messageItems.set(id, { text: kept, completed: false });
            this.messageTextBytes += kept.length;
          }
          if (this.messageItems.get(id)!.text) this.emitMessage(t);
          return;
        }
        if (item.type === "reasoning") {
          if (!this.reasoningItems.has(id)) {
            if (this.reasoningItems.size >= this.limits.maxReasoningItems) {
              this.dropped++;
              return;
            }
            this.reasoningItems.set(id, { text: "", completed: false });
          }
          t.cb.onReasoning?.({ itemId: id });
          return;
        }
        if (item.type === "plan") {
          if (!this.planItems.has(id)) {
            if (this.planItems.size >= this.limits.maxPlanItems) {
              this.dropped++;
              return;
            }
            const initial = typeof item.text === "string" ? item.text : "";
            const kept = initial.slice(0, this.limits.planTextBytes);
            this.planItems.set(id, { text: kept, completed: false });
            if (kept) t.cb.onPlan?.({ itemId: id, delta: kept });
          }
          return;
        }
        {
          // Frozen: every other started item maps through toolCall —
          // unsupported types draw nothing.
          const call = toolCall(item, this.workspace.directory);
          if (call) {
            if (!this.toolTails.has(id)) {
              if (this.toolTails.size >= this.limits.maxToolItems) {
                this.dropped++;
                return;
              }
              this.toolTails.set(id, { kind: call.kind, title: call.title ?? "", detail: "" });
            }
            const tail = this.toolTails.get(id)!;
            if (item.type === "fileChange") {
              const paths = extractChangePaths(item.changes);
              if (paths.length) t.cb.onFileChanges?.(paths);
            }
            t.cb.onToolActivity?.({
              itemId: id,
              kind: tail.kind,
              title: call.title,
              titleKey: call.titleKey,
              titleParams: call.titleParams,
              detail: call.detail ? bounded(call.detail, this.limits.toolOutputTailBytes) : undefined,
              status: "started",
            });
            return;
          }
        }
        this.dropped++;
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const t = this.turnScoped(params);
        if (!t) return;
        const itemId = s(p.itemId);
        const delta = s(p.delta);
        if (!itemId || delta === null) {
          this.dropped++;
          return;
        }
        const ri = this.reasoningItems.get(itemId);
        if (!ri || ri.completed) {
          this.dropped++;
          return;
        }
        const room = this.limits.reasoningTextBytes - ri.text.length;
        if (room <= 0) {
          this.dropped++;
          return;
        }
        const kept = delta.length <= room ? delta : delta.slice(0, room);
        ri.text += kept;
        if (kept) t.cb.onReasoning?.({ itemId, delta: kept });
        if (kept.length < delta.length) this.dropped++;
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const t = this.turnScoped(params);
        if (!t) return;
        const itemId = s(p.itemId);
        const idx = typeof p.summaryIndex === "number" ? p.summaryIndex : 0;
        // Frozen: only a part BEYOND the first contributes a separator.
        const ri = itemId ? this.reasoningItems.get(itemId) : undefined;
        if (!ri || ri.completed) {
          this.dropped++;
          return;
        }
        if (idx > 0 && ri.text.length < this.limits.reasoningTextBytes) {
          ri.text += "\n\n";
          t.cb.onReasoning?.({ itemId: itemId!, delta: "\n\n" });
        }
        return;
      }
      case "item/plan/delta": {
        const t = this.turnScoped(params);
        if (!t) return;
        const itemId = s(p.itemId);
        const delta = s(p.delta);
        if (!itemId || delta === null) {
          this.dropped++;
          return;
        }
        const pi = this.planItems.get(itemId);
        if (!pi || pi.completed) {
          this.dropped++;
          return;
        }
        const room = this.limits.planTextBytes - pi.text.length;
        if (room <= 0) {
          this.dropped++;
          return;
        }
        const kept = delta.length <= room ? delta : delta.slice(0, room);
        pi.text += kept;
        if (kept) t.cb.onPlan?.({ itemId, delta: kept });
        if (kept.length < delta.length) this.dropped++;
        return;
      }
      case "thread/tokenUsage/updated": {
        // Thread-scoped telemetry: the thread must match and, when a
        // turnId rides along, it must name the live turn. A reading with
        // no live turn is dropped — the meter shows the last accepted
        // value instead of post-completion noise.
        const t = this.turn;
        if (!t || t.terminal || this.phase !== "ready" || s(p.threadId) !== this.codexThreadId) {
          this.dropped++;
          return;
        }
        const ptid = s(p.turnId);
        if (ptid !== null && ptid !== t.providerTurnId) {
          this.dropped++;
          return;
        }
        const usage = isObj(p.tokenUsage) ? p.tokenUsage : null;
        const last = usage && isObj(usage.last) ? usage.last : null;
        const total = usage && isObj(usage.total) ? usage.total : null;
        const used =
          last && typeof last.totalTokens === "number" && Number.isFinite(last.totalTokens)
            ? Math.max(0, Math.floor(last.totalTokens))
            : 0;
        // F19: the session's cumulative counter feeds the spend ledger —
        // last.totalTokens is per-turn context occupancy, never spend.
        const sessionTotal =
          total && typeof total.totalTokens === "number" && Number.isFinite(total.totalTokens)
            ? Math.max(0, Math.floor(total.totalTokens))
            : undefined;
        const window =
          usage && typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0
            ? Math.floor(usage.modelContextWindow)
            : undefined;
        t.cb.onUsage?.({
          usedTokens: used,
          ...(window !== undefined ? { windowTokens: window } : {}),
          ...(sessionTotal !== undefined ? { sessionTotalTokens: sessionTotal } : {}),
        });
        return;
      }
      case "thread/compacted": {
        // F09: thread-level event — lands while idle, after the turn's
        // callbacks tore down. Routes through the session-level sink;
        // the engine renders a standalone notice row (frozen Notice
        // "Context compacted.", level info).
        if (s(p.threadId) !== this.codexThreadId) {
          this.dropped++;
          return;
        }
        this.provider.threadNotice(this.localThreadId, "Context compacted.", "info");
        return;
      }
      case "turn/plan/updated": {
        const t = this.turnScoped(params);
        if (!t) return;
        const plan = Array.isArray(p.plan) ? p.plan : [];
        const steps: import("../shared/types").TodoStep[] = [];
        for (const step of plan.slice(0, this.limits.maxTodoSteps)) {
          if (!isObj(step)) continue;
          const text = s(step.step);
          if (!text) continue;
          steps.push({
            text: text.slice(0, this.limits.todoStepTextBytes),
            status:
              step.status === "completed" ? "done"
              : step.status === "inProgress" ? "active"
              : "pending",
          });
        }
        if (plan.length > this.limits.maxTodoSteps) this.dropped++;
        t.cb.onTodos?.(steps);
        return;
      }
      case "item/commandExecution/outputDelta": {
        const t = this.turnScoped(params);
        if (!t) return;
        const itemId = s(p.itemId);
        const delta = s(p.delta);
        if (!itemId || delta === null) {
          this.dropped++;
          return;
        }
        const tail = this.toolTails.get(itemId);
        if (tail && delta)
          tail.detail = bounded(tail.detail + delta, this.limits.toolOutputTailBytes);
        else this.dropped++;
        return;
      }
      case "item/completed": {
        const t = this.turnScoped(params);
        if (!t) return;
        if (!isObj(p.item) || !s(p.item.id)) {
          this.dropped++;
          return;
        }
        const item = p.item;
        const id = s(item.id)!;
        if (item.type === "agentMessage") {
          const existing = this.messageItems.get(id);
          if (existing?.completed) {
            // Duplicate completed for the same item — never re-display.
            this.dropped++;
            return;
          }
          const finalText = typeof item.text === "string" ? item.text : "";
          if (!existing) {
            if (this.messageItems.size >= this.limits.maxAgentItems) {
              this.dropped++;
              return;
            }
            const room = Math.max(0, this.limits.maxAssistantTextBytes - this.messageTextBytes);
            const kept = finalText.length <= room ? finalText : finalText.slice(0, room);
            this.messageItems.set(id, { text: kept, completed: true });
            this.messageTextBytes += kept.length;
            // The item produced text without streaming deltas — emit it
            // once through the chunk channel, then reconcile.
            if (kept) t.cb.onChunk(++t.seq, kept);
          } else {
            // A divergent final REPLACES the item's contribution within
            // the same retained budget — including an explicit empty
            // final, which clears earlier streamed text.
            if (finalText !== existing.text) {
              const budget = Math.max(
                0,
                this.limits.maxAssistantTextBytes - (this.messageTextBytes - existing.text.length),
              );
              const kept = finalText.length <= budget ? finalText : finalText.slice(0, budget);
              this.messageTextBytes += kept.length - existing.text.length;
              existing.text = kept;
            }
            existing.completed = true;
          }
          this.lastDeltaItemId = null;
          // Composition reconcile after every accepted completion — the
          // ordered deduplicated whole, never a second appended copy.
          this.emitMessage(t);
          return;
        }
        if (item.type === "reasoning") {
          const ri = this.reasoningItems.get(id);
          if (ri?.completed) {
            this.dropped++;
            return;
          }
          // Frozen: completed text is authoritative —
          // summary.isEmpty ? content : summary.
          const joinParts = (v: unknown) =>
            Array.isArray(v)
              ? v.filter((x): x is string => typeof x === "string").join("\n\n")
              : "";
          const summary = joinParts(item.summary);
          const content = joinParts(item.content);
          const finalText = summary.length > 0 ? summary : content;
          const kept = finalText.slice(0, this.limits.reasoningTextBytes);
          if (ri) ri.completed = true;
          if (ri && ri.text !== kept) ri.text = kept;
          t.cb.onReasoning?.({ itemId: id, done: true, finalText: kept });
          return;
        }
        if (item.type === "plan") {
          const pi = this.planItems.get(id);
          if (pi?.completed) {
            this.dropped++;
            return;
          }
          // Frozen: completed plan text is authoritative markdown.
          const finalText = (typeof item.text === "string" ? item.text : "").slice(
            0,
            this.limits.planTextBytes,
          );
          if (pi) {
            pi.completed = true;
            if (pi.text !== finalText) pi.text = finalText;
          }
          t.cb.onPlan?.({ itemId: id, done: true, finalText });
          return;
        }
        {
          // Frozen: completed tool items emit started+updated — the
          // recomputed call is authoritative over the started snapshot.
          const call = toolCall(item, this.workspace.directory);
          if (call) {
            const tail = this.toolTails.get(id);
            const update = toolUpdate(item, this.workspace.directory, tail?.detail ?? "");
            if (item.type === "fileChange" && update.status === "completed") {
              const paths = extractChangePaths(item.changes);
              if (paths.length) t.cb.onFileChanges?.(paths);
            }
            t.cb.onToolActivity?.({
              itemId: id,
              kind: tail?.kind ?? call.kind,
              title: call.title ?? tail?.title,
              titleKey: call.titleKey,
              titleParams: call.titleParams,
              status: update.status === "running" ? "started" : update.status,
              detail: update.detail
                ? bounded(update.detail, this.limits.toolOutputTailBytes)
                : undefined,
            });
            this.toolTails.delete(id);
            return;
          }
          const orphaned = this.toolTails.get(id);
          if (orphaned) {
            // A tool item we registered at started completed as a type
            // that draws nothing — settle it so the row cannot dangle.
            this.toolTails.delete(id);
            t.cb.onToolActivity?.({
              itemId: id,
              kind: orphaned.kind,
              title: orphaned.title,
              status: "completed",
            });
            return;
          }
        }
        this.dropped++;
        return;
      }
      case "error": {
        const t = this.turn;
        if (!t || t.terminal || this.phase !== "ready") {
          this.dropped++;
          return;
        }
        // turnId is optional here; when present it must name THIS turn.
        const ptid = s(p.turnId);
        if (ptid !== null && ptid !== t.providerTurnId) {
          this.dropped++;
          return;
        }
        const msg = isObj(p.error) ? s(p.error.message) : null;
        if (p.willRetry === true) this.notice(`Codex error (retrying): ${msg ?? "unknown"}`, "error");
        else this.finalError = msg ?? "unknown Codex error";
        return;
      }
      case "serverRequest/resolved": {
        const rid = parseRpcId(p.requestId);
        if (!rid) {
          this.dropped++;
          return;
        }
        this.withdrawTicket(rpcIdKey(rid));
        return;
      }
      case "turn/completed": {
        const t = this.turn;
        if (!t || t.terminal || this.phase !== "ready" || t.providerTurnId === null) {
          this.dropped++;
          return;
        }
        if (!isObj(p.turn)) {
          this.dropped++;
          return;
        }
        const turnId = s(p.turn.id);
        if (!turnId || turnId !== t.providerTurnId) {
          // Missing or foreign turn id — not this turn's completion.
          this.dropped++;
          return;
        }
        const status = s(p.turn.status);
        const errMsg = isObj(p.turn.error) ? s(p.turn.error.message) : null;
        this.applyTurnCompleted(status, errMsg);
        return;
      }
      default:
        this.dropped++;
    }
  }

  private applyTurnCompleted(status: string | null, errorMsg: string | null): void {
    if (status === "completed") this.terminate("done");
    else if (status === "interrupted") this.terminate("interrupted");
    else if (status === "failed")
      this.terminate(
        "error",
        this.finalError ?? errorMsg ?? "Codex turn failed",
      );
    else
      this.fatal(
        new CodexProtocolError(
          `turn/completed carried non-terminal status ${JSON.stringify(status)}`,
          "CODEX_PROTOCOL_ERROR",
        ),
      );
  }

  /** Ordered, deduplicated assistant text — one emit carries the WHOLE
   *  composed content so a replaced item never appends a second copy. */
  private emitMessage(t: ActiveTurn): void {
    if (!t.cb.onMessageText) return;
    const text = [...this.messageItems.values()]
      .map((i) => i.text)
      .filter((x) => x.length > 0)
      .join("\n\n");
    t.cb.onMessageText(++t.seq, text);
  }

  // ---- termination ---------------------------------------------------------

  private notice(text: string, level: "info" | "warning" | "error" = "info"): void {
    const t = this.turn;
    if (!t || t.terminal || !t.cb.onNotice) return;
    if (++t.noticeCount > 16) return;
    t.cb.onNotice(bounded(text, this.limits.noticeBytes), level);
  }

  private terminate(kind: "done" | "interrupted" | "error", message?: string): void {
    const t = this.turn;
    if (!t || t.terminal) return;
    t.terminal = true;
    // Pending approvals die WITH the turn — the card expires first so the
    // terminal state never renders under a live approval card. Buffered
    // pre-admission traffic is answered/dropped honestly, never replayed.
    this.withdrawAll();
    this.dropPreAdmission(`turn ${kind}`);
    this.candidateTurnId = null;
    this.messageItems.clear();
    this.toolTails.clear();
    this.reasoningItems.clear();
    this.planItems.clear();
    this.messageTextBytes = 0;
    this.lastDeltaItemId = null;
    this.finalError = null;
    this.turn = null;
    if (kind === "done") t.cb.onDone();
    else if (kind === "interrupted") t.cb.onInterrupted?.();
    else t.cb.onError(bounded(message ?? "Codex error", 2000));
  }

  /**
   * Protocol-fatal: the turn ends, the rpc is dead — but the transport
   * KEEPS its entry in `transports` until the OS close is delivered, so
   * provider.dispose can still attribute and retry the living child.
   */
  private fatal(err: Error): void {
    this.terminate("error", err.message);
    const tr = this.transport;
    this.phase = "dead";
    this.gen++;
    this.rpc?.failAllPending(`CODEX_CONNECTION_CLOSED: ${err.message}`);
    this.rpc = null;
    if (tr) void tr.dispose();
  }

  /** ONLY the transport's delivered-close may call this — never fatal(),
   *  never a guess. Clears process-attribution for exactly that transport. */
  private onDeliveredClose(
    tr: StdioTransport<CodexMessage>,
    code: number | null,
    signal: string | null,
  ): void {
    this.transports.delete(tr);
    this.recordCleanupFailure(tr, code, signal);
    const wasCurrent = this.transport === tr;
    if (wasCurrent) {
      this.gen++;
      this.phase = "dead";
      this.transport = null;
    }
    const tail = tr.stderrTail();
    const rpc = wasCurrent ? this.rpc : null;
    rpc?.failAllPending("CODEX_CONNECTION_CLOSED: app-server connection closed");
    if (wasCurrent) this.rpc = null;
    const turn = this.turn;
    if (wasCurrent && turn && !turn.terminal) {
      this.terminate(
        "error",
        `CODEX_CONNECTION_CLOSED: process closed (code ${code ?? "?"}, signal ${signal ?? "?"})` +
          (tail ? ` — stderr tail: ${bounded(tail.trim(), 400)}` : ""),
      );
    }
    // A late close from an older transport must NOT touch the current
    // generation: no pending-fail, no ticket withdrawal, no turn end.
  }

  /** A transport entry that still owns an unclosed child. */
  private recordCleanupFailure(tr: StdioTransport<CodexMessage>, code: number | null, signal: string | null): void {
    if (this.provider.config.mode !== "real" || code !== 4) return;
    // Exit 4 means job cleanup was not proven, even if the helper closed.
    this.cleanupFailures.set(tr, { pid: tr.pid, confirmed: false, exitCode: code, signal,
      problem: "CLEANUP_INCOMPLETE: job-helper exited 4; tree cleanup unproven" });
    this.provider.noteUnprovenCleanup();
  }

  hasUnconfirmedChild(): boolean {
    if (this.cleanupFailures.size) return true;
    for (const tr of this.transports) if (tr.hasChild && !tr.closed) return true;
    return false;
  }

  // ---- teardown ------------------------------------------------------------

  /** endSession/dispose: no callbacks — the engine owns shutdown marking.
   *  Retains the transport references until real close so retries report
   *  the same still-living child instead of vanishing it. */
  async shutdown(): Promise<{ children: ChildCleanupResult[]; orphaned: number }> {
    this.disposed = true;
    this.gen++;
    const rpc = this.rpc;
    const providerTurnId = this.turn?.providerTurnId ?? null;
    const codexThreadId = this.codexThreadId;
    const transport = this.transport;
    const children: ChildCleanupResult[] = [];
    // The turn is dead — no callbacks may fire during teardown. Tickets
    // stay live through the grace so a withdrawal arriving in buffered
    // frames still retires them (they only count as orphaned if they were
    // STILL unanswered after real cleanup).
    this.turn = null;
    this.messageItems.clear();
    this.toolTails.clear();
    this.reasoningItems.clear();
    this.planItems.clear();
    this.messageTextBytes = 0;
    this.lastDeltaItemId = null;
    this.candidateTurnId = null;
    this.preAdmission = [];
    this.finalError = null;
    // Snapshot client-request state BEFORE our own interrupt is sent —
    // "orphaned" measures user work pending at entry that never resolved.
    const pendingAtEntry = rpc?.pendingCount ?? 0;
    const resolvedAtEntry = rpc?.resolvedCount ?? 0;
    let interruptResolved = false;
    if (transport?.hasChild && rpc && codexThreadId && providerTurnId) {
      // Best-effort interrupt while RPC receipts are still collectible —
      // bounded, and its own failure is ignored (cleanup proceeds).
      try {
        await Promise.race([
          rpc
            .request(
              "turn/interrupt",
              { threadId: codexThreadId, turnId: providerTurnId },
              { timeoutMs: this.limits.disposeInterruptMs, mutating: true },
            )
            .then(() => {
              interruptResolved = true;
            })
            .catch(() => {}),
          new Promise((r) => setTimeout(r, this.limits.disposeInterruptMs)),
        ]);
      } catch {
        /* cleanup proceeds regardless */
      }
    }
    for (const tr of [...this.transports]) {
      const result = await tr.dispose();
      this.recordCleanupFailure(tr, result.exitCode, result.signal);
      children.push(result);
    }
    children.push(...this.cleanupFailures.values());
    // Count AFTER real cleanup: frames delivered during the close grace may
    // have resolved pending work — those are not orphans. (The delivered
    // close already failed the rest through failAllPending.)
    const resolvedDuring =
      Math.max(0, (rpc?.resolvedCount ?? 0) - resolvedAtEntry) - (interruptResolved ? 1 : 0);
    const orphaned = this.tickets.size + Math.max(0, pendingAtEntry - resolvedDuring);
    this.tickets.clear();
    this.ticketOrder = [];
    rpc?.failAllPending("CODEX_CONNECTION_CLOSED: session shutdown");
    if (this.transport === transport) {
      this.transport = null;
      this.rpc = null;
    }
    if (this.rpc === rpc) this.rpc = null;
    this.phase = "dead";
    return { children, orphaned };
  }
}

// ---------------------------------------------------------------------------

/**
 * F06 runtime-mode → Codex policy, frozen CodexSession.swift @ d31e093b.
 * thread/start|resume take the legacy string form (`sandbox`); turn/start
 * takes the object form (`sandboxPolicy`). `auto` differs only in the
 * reviewer — the provider's reviewer approves routine actions.
 */
function bindPolicy(mode: RuntimeMode): {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
} {
  switch (mode) {
    case "autoAcceptEdits":
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: mode === "auto" ? "auto_review" : "user",
        sandbox: "workspace-write",
      };
    case "fullAccess":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      };
    default:
      return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" };
  }
}
function turnPolicy(mode: RuntimeMode): {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandboxPolicy: { type: string };
} {
  const b = bindPolicy(mode);
  const type =
    b.sandbox === "danger-full-access"
      ? "dangerFullAccess"
      : b.sandbox === "workspace-write"
        ? "workspaceWrite"
        : "readOnly";
  return {
    approvalPolicy: b.approvalPolicy,
    approvalsReviewer: b.approvalsReviewer,
    sandboxPolicy: { type },
  };
}

export class CodexAppServerProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly limits: CodexProviderLimits;
  readonly transportLimits: Partial<TransportLimits>;
  readonly config: CodexRuntimeConfig;
  readonly clientName: string;
  readonly clientVersion: string;
  private readonly opts: CodexProviderOptions;
  private sessions = new Map<string, CodexSession>();
  private cleanupUnproven = false;

  noteUnprovenCleanup(): void { this.cleanupUnproven = true; }
  /** Sessions whose shutdown is unconfirmed — they keep their living
   *  child attribution until provider.dispose confirms the close. */
  private retired = new Set<CodexSession>();
  private disposed = false;

  constructor(opts: CodexProviderOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.limits = { ...DEFAULT_CODEX_LIMITS, ...opts.limits };
    this.transportLimits = opts.transportLimits ?? {};
    this.clientName = opts.clientName ?? "tivano-win";
    this.clientVersion = opts.clientVersion ?? "0.0.0-dev";
    const label =
      this.config.mode === "fixture"
        ? "Codex (offline fixture)"
        : this.config.mode === "real"
          ? "Codex app-server"
          : "Codex app-server (unconfigured)";
    this.descriptor = {
      id: CODEX_PROVIDER_ID,
      label,
      mode: "codex",
      synthetic: true,
      runtimeInfo: {
        executable:
          this.config.mode === "fixture"
            ? `${this.config.fixtureNode} ${this.config.fixtureScript}`
            : this.config.executable ?? "(not configured)",
        version: this.config.mode === "fixture" ? `fixture pin ${CODEX_SCHEMA_PIN}` : "unknown",
      },
      // F09: codex supports the frozen supportsCompact set.
      compact: true,
    };
  }

  lookupBinding(tid: string): ProviderThreadBinding | undefined {
    return this.opts.lookupBinding(tid);
  }
  bindThread(tid: string, b: ProviderThreadBinding): Promise<void> {
    return this.opts.bindThread(tid, b);
  }
  /** F18: Settings-connected MCP registry for thread config injection —
   *  live-read at each thread bind so Settings edits apply to the NEXT
   *  thread, never retro-mutating a bound one. */
  mcpServersForThread(): readonly McpServerConfig[] | undefined {
    return this.opts.mcpServers?.();
  }

  buildSpec(workspaceDir: string): SpawnSpec {
    if (this.opts.makeSpec) return this.opts.makeSpec(workspaceDir);
    if (this.config.mode === "fixture") {
      return {
        executable: this.config.fixtureNode!,
        args: [this.config.fixtureScript!],
        cwd: workspaceDir,
        env: this.config.env,
      };
    }
    return {
      executable: this.config.executable!,
      args: this.config.args,
      cwd: workspaceDir,
      env: this.config.env,
    };
  }

  spawnImplForMode(): SpawnImpl | undefined {
    if (this.opts.spawnImpl) return this.opts.spawnImpl;
    if (this.config.mode === "real") {
      const cap = this.config.treeCapability;
      if (!cap.supported || !cap.helperPath) {
        // Verification never falls back to a plain payload spawn: a
        // real-mode session without an attested helper gets an impl that
        // fails loudly (unreachable in practice — start() gates first).
        return () => {
          throw new ProcessTreeError(
            `${PROCESS_TREE_UNSUPPORTED}: job-helper unavailable — refusing direct payload spawn`,
          );
        };
      }
      return makeJobHelperSpawnImpl(cap.helperPath);
    }
    return undefined;
  }

  start(context: TurnContext, callbacks: ProviderCallbacks): ProviderTurnHandle {
    if (this.cleanupUnproven)
      throw new CodexProviderError("CODEX_BUSY: previous job cleanup is unproven", "CODEX_BUSY");
    if (this.disposed)
      throw new CodexProviderError("CODEX_BUSY: provider is disposed", "CODEX_BUSY");
    if (this.config.mode === "unconfigured")
      throw new CodexProviderError(
        "CODEX_NOT_CONFIGURED: set TIVANO_CODEX_EXECUTABLE to a codex.exe absolute path " +
          "(or TIVANO_CODEX_FIXTURE for the offline protocol fixture)",
        "CODEX_NOT_CONFIGURED",
      );
    if (this.config.mode === "real" && !this.config.treeCapability.supported)
      throw new CodexProviderError(
        `CODEX_REAL_UNAVAILABLE: ${this.config.treeCapability.reason ?? "process-tree cleanup unproven"}`,
        "CODEX_REAL_UNAVAILABLE",
      );
    if (!context.workspace)
      throw new CodexProviderError(
        "CODEX_WORKSPACE_REQUIRED: codex requires a main-authorized workspace",
        "CODEX_WORKSPACE_REQUIRED",
      );
    let session = this.sessions.get(context.threadId);
    // A session is bound to ONE physical workspace for its whole life — a
    // later turn carrying a different authorized directory may not reuse
    // it (the bound codex thread's cwd would silently change meaning).
    if (session && session.workspaceDirectory !== realpathSync(context.workspace.directory))
      throw new CodexProviderError(
        "CODEX_WORKSPACE_REQUIRED: this thread's session is bound to a different workspace",
        "CODEX_WORKSPACE_REQUIRED",
      );
    if (!session) {
      if (this.sessions.size + this.retired.size >= this.limits.maxSessions)
        throw new CodexProviderError(
          `CODEX_SESSION_LIMIT: ${this.limits.maxSessions} sessions`,
          "CODEX_SESSION_LIMIT",
        );
      session = new CodexSession(this, context.threadId, context.workspace);
      this.sessions.set(context.threadId, session);
    }
    session.beginTurn(context, callbacks);
    const turnId = context.turnId;
    const threadId = context.threadId;
    return {
      cancel: () => this.sessions.get(threadId)?.cancelTurn(turnId),
      resume: (approved, optionId) =>
        this.sessions.get(threadId)?.resolveApproval(turnId, approved, optionId),
      decline: (optionId) => this.sessions.get(threadId)?.decline(turnId, optionId),
      answer: (providerKey, answers) =>
        this.sessions.get(threadId)?.answerQuestion(turnId, providerKey, answers),
    };
  }

  endSession(localThreadId: string): void {
    const s = this.sessions.get(localThreadId);
    if (!s) return;
    this.sessions.delete(localThreadId);
    // Keep process-attribution: the session stays trackable until its
    // children provably close, so dispose retries can still see them.
    this.retired.add(s);
    void s.shutdown().then(() => {
      if (!s.hasUnconfirmedChild()) this.retired.delete(s);
    });
  }

  /** Session visibility for tests/diagnostics. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Provider-owned model catalog. model/list needs a live session —
   * sessions are provider-global, so ANY ready one can serve it. No
   * ready session → null (the engine reports "pending"); a failing
   * read propagates → "unavailable". Never fabricates a list.
   */
  /**
   * F09: frozen session.compact — thread/compact/start on the bound
   * session. No bound or no longer-ready session → CODEX_NOT_RUNNING,
   * which the engine maps to "Nothing to compact yet.".
   */
  /** Session → engine: a notice that belongs to a thread, not a turn. */
  threadNotice(
    localThreadId: string,
    text: string,
    level: "info" | "warning" | "error",
  ): void {
    this.opts.onThreadNotice?.(localThreadId, text, level);
  }

  async compact(localThreadId: string): Promise<void> {
    const s = this.sessions.get(localThreadId);
    if (!s) {
      throw new CodexProviderError(
        "CODEX_NOT_RUNNING: no session is bound to this thread",
        "CODEX_NOT_RUNNING",
      );
    }
    await s.compact();
  }

  async modelCatalog(): Promise<CodexModelOption[] | null> {
    for (const s of this.sessions.values()) {
      if (s.phase === "ready") return s.fetchModelCatalog();
    }
    return null;
  }

  async dispose(): Promise<AdapterDisposeResult> {
    this.disposed = true;
    const children: ChildCleanupResult[] = [];
    let orphaned = 0;
    for (const s of [...this.sessions.values(), ...this.retired]) {
      const { children: c, orphaned: o } = await s.shutdown();
      children.push(...c);
      orphaned += o;
      if (!s.hasUnconfirmedChild()) {
        this.retired.delete(s);
        for (const [tid, cur] of this.sessions) if (cur === s) this.sessions.delete(tid);
      }
    }
    return { children, orphanedPending: orphaned };
  }
}

export {};
