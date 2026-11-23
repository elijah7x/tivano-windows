// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// ZCode provider adapter — drives the bundled ZCode Protocol app-server
// (`zcode.cjs app-server --stdio`) over StdioTransport + CodexRpc.
//
// Ported from frozen Tivano/Services/Providers/ZCodeSession.swift (v3.0.0),
// including the 2.5.41 / P2-37 fixes:
//   · Stopped / cancelled / errored turns never finish as completed
//     (v4/telemetry/event turn.terminal + turn.completed resultType/error).
//   · A single failing tool event (`tool.updated`) never ends the turn.
//   · `session/requestRuntimePreferences` omits unsupported `"native"`
//     toolSearchMode so ZCode starts when tool search is set to Native.
//   · Subagent-forwarded tool results without a matching parent tool_call
//     are filtered so they never appear as untitled rows.

import { realpathSync } from "node:fs";
import type {
  ApprovalOption,
  CodexModelOption,
  CodexQuestion,
  CodexQuestionChoice,
  InteractionMode,
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
  CodexRpc,
  codexWireCodec,
  rpcIdKey,
  type CodexMessage,
  type RpcId,
} from "./codexAppServerProtocol";
import { makeJobHelperSpawnImpl } from "./providerProcessLifecycle";
import {
  ZCODE_DEFAULT_EFFORT,
  ZCODE_EFFORTS,
  ZCODE_PROVIDER_ID,
  ZCODE_SCHEMA_PIN,
  buildZCodeEnv,
  readZCodeBuiltinModels,
  readZCodeBuiltinRevision,
  readZCodeRuntimePreferences,
  zcodeAccountProviderId,
  type ZCodeRuntimeConfig,
} from "./zcodeRuntimeConfig";
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

export class ZCodeProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ZCODE_NOT_INSTALLED"
      | "ZCODE_BUILTIN_UNREADABLE"
      | "ZCODE_PROTOCOL_ERROR"
      | "ZCODE_BUSY"
      | "ZCODE_WORKSPACE_REQUIRED",
  ) {
    super(message);
    this.name = "ZCodeProviderError";
  }
}

export interface ZCodeProviderOptions {
  config: ZCodeRuntimeConfig;
  /** Live reader for the Z.ai GLM Coding Plan API key (Settings or env). */
  apiKey(): string;
  /** Live reader for Z.ai region ("global" | "china"). */
  region?(): "global" | "china";
  lookupBinding(localThreadId: string): ProviderThreadBinding | undefined;
  bindThread(localThreadId: string, binding: ProviderThreadBinding): Promise<void>;
  spawnImpl?: SpawnImpl;
  makeSpec?(workspaceDir: string): SpawnSpec;
  transportLimits?: Partial<TransportLimits>;
  /** Override runtime preferences reader for tests. */
  runtimePreferences?(): Record<string, unknown>;
}

interface PendingPermission {
  kind: "permission";
  rpcId: RpcId;
  payloads: Record<string, unknown>;
  writing?: boolean;
}

interface PendingQuestion {
  kind: "question";
  rpcId: RpcId;
  questions: CodexQuestion[];
  writing?: boolean;
}

type PendingTicket = PendingPermission | PendingQuestion;

interface ActiveTurn {
  localTurnId: string;
  providerTurnId: string | null;
  cb: ProviderCallbacks;
  seq: number;
  terminal: boolean;
  cancelIntent: boolean;
  messageId: string | null;
  reasoningId: string | null;
  reasoningText: string;
  startedTools: Set<string>;
  turnUsage: { input: number; output: number; cached: number };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function relativePath(p: string, root: string): string {
  const normP = p.replaceAll("\\", "/");
  const normR = root.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  if (normP.toLowerCase().startsWith(normR.toLowerCase())) {
    return normP.slice(normR.length);
  }
  return p;
}

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

function mapToolCall(
  name: string,
  input: Record<string, unknown> | null,
  workspaceDir: string,
): { kind: ToolActivity["kind"]; title: string; detail?: string | undefined } {
  const filePath = input ? str(input.file_path) : null;
  const rel = filePath ? relativePath(filePath, workspaceDir) : undefined;
  switch (name) {
    case "Bash": {
      const cmd = input ? str(input.command) : null;
      return { kind: "command", title: cmd ? unwrapShell(cmd) : name };
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "edit", title: rel ?? name };
    case "Read":
      return { kind: "read", title: rel ?? name };
    case "Grep":
    case "Glob":
      return {
        kind: "search",
        title: (input ? str(input.pattern) : null) ?? name,
        ...(rel ? { detail: rel } : {}),
      };
    case "Agent":
    case "Task":
      return {
        kind: "agent",
        title: (input ? str(input.description) : null) ?? "Subagent",
        ...(input && str(input.subagent_type) ? { detail: str(input.subagent_type)! } : {}),
      };
    default: {
      const compact = input ? JSON.stringify(input).slice(0, 400) : undefined;
      return {
        kind: "other",
        title: name,
        ...(compact && compact !== "{}" ? { detail: compact } : {}),
      };
    }
  }
}

function extractTextBlocks(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string" && item) parts.push(item);
    else if (isObj(item) && str(item.text)) parts.push(str(item.text)!);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function zcodeMode(
  runtimeMode: RuntimeMode | undefined,
  interactionMode: InteractionMode | undefined,
): string {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "supervised":
      return "build";
    case "autoAcceptEdits":
      return "edit";
    case "auto":
      return "guarded";
    case "fullAccess":
      return "yolo";
    default:
      return "build";
  }
}

class ZCodeSession {
  phase: "idle" | "connecting" | "ready" | "dead" = "idle";
  private transport: StdioTransport<CodexMessage> | null = null;
  private rpc: CodexRpc | null = null;
  private transports = new Set<StdioTransport<CodexMessage>>();
  private cleanupFailures = new Map<StdioTransport<CodexMessage>, ChildCleanupResult>();
  private zcodeSessionId: string | null = null;
  private appliedMode: string | null = null;
  private completedProviderTurns = new Set<string>();
  private turn: ActiveTurn | null = null;
  private pending = new Map<string, PendingTicket>();
  private connectPromise: Promise<void> | null = null;
  private disposed = false;
  readonly workspaceDirectory: string;

  constructor(
    private readonly provider: ZCodeProvider,
    readonly localThreadId: string,
    workspace: WorkspaceGrant,
  ) {
    this.workspaceDirectory = realpathSync(workspace.directory);
  }

  hasUnconfirmedChild(): boolean {
    return this.transports.size > 0 || this.cleanupFailures.size > 0;
  }

  private get accountProviderId(): string {
    return zcodeAccountProviderId(this.provider.currentRegion());
  }

  private selection(model?: string, effort?: string): Record<string, unknown> {
    const models = this.provider.cachedModels();
    const chosen = model ?? models[0]?.id ?? "GLM-5.3";
    const level =
      effort && (ZCODE_EFFORTS as readonly string[]).includes(effort)
        ? effort
        : ZCODE_DEFAULT_EFFORT;
    return {
      providerId: this.accountProviderId,
      modelId: chosen,
      options: { reasoningLevel: level },
    };
  }

  beginTurn(context: TurnContext, cb: ProviderCallbacks): void {
    const active: ActiveTurn = {
      localTurnId: context.turnId,
      providerTurnId: null,
      cb,
      seq: 0,
      terminal: false,
      cancelIntent: false,
      messageId: null,
      reasoningId: null,
      reasoningText: "",
      startedTools: new Set(),
      turnUsage: { input: 0, output: 0, cached: 0 },
    };
    this.turn = active;
    void this.runTurn(context, active);
  }

  private async runTurn(context: TurnContext, active: ActiveTurn): Promise<void> {
    try {
      await this.ensureConnected(context);
      if (active.terminal || active.cancelIntent || this.turn !== active || !this.rpc || !this.zcodeSessionId) {
        if (!active.terminal && active.cancelIntent) {
          this.finishTurn(active, "interrupted");
        }
        return;
      }
      const mode = zcodeMode(context.runtimeMode, context.interactionMode);
      if (this.appliedMode !== mode) {
        await this.rpc.request(
          "session/setMode",
          { sessionId: this.zcodeSessionId, mode },
          { timeoutMs: 90_000, mutating: true },
        );
        this.appliedMode = mode;
      }
      const modelSelection = this.selection(context.model, context.effort);
      active.cb.onModelReport?.(
        String(modelSelection.modelId),
        String((modelSelection.options as Record<string, unknown>).reasoningLevel),
      );
      const sendRes = await this.rpc.request(
        "session/send",
        {
          sessionId: this.zcodeSessionId,
          content: context.prompt,
          modelSelection,
        },
        { timeoutMs: 90_000, mutating: true },
      );
      if (!isObj(sendRes) || sendRes.accepted !== true) {
        throw new ZCodeProviderError(
          "ZCode did not accept the message.",
          "ZCODE_PROTOCOL_ERROR",
        );
      }
    } catch (err) {
      if (!active.terminal && this.turn === active) {
        this.finishTurn(
          active,
          active.cancelIntent ? "interrupted" : "failed",
          (err as Error)?.message ?? "ZCode reported an error.",
        );
      }
    }
  }

  private async ensureConnected(context: TurnContext): Promise<void> {
    if (this.phase === "ready" && this.rpc && this.zcodeSessionId) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect(context).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(context: TurnContext): Promise<void> {
    if (this.disposed) {
      throw new ZCodeProviderError("ZCode session is disposed", "ZCODE_BUSY");
    }
    this.phase = "connecting";
    const revision = this.provider.builtinRevision();
    if (!revision) {
      throw new ZCodeProviderError(
        "ZCode's bundled provider configuration could not be read.",
        "ZCODE_BUILTIN_UNREADABLE",
      );
    }

    const spec = this.provider.buildSpec(this.workspaceDirectory);
    const limits: TransportLimits = {
      ...DEFAULT_TRANSPORT_LIMITS,
      frameBytes: 4 * 1024 * 1024,
      ...this.provider.transportLimits,
    };

    const transport = new StdioTransport<CodexMessage>(
      spec,
      limits,
      {
        onFrame: (msg) => this.rpc?.onFrame(msg),
        onProtocolError: (err) => {
          this.rpc?.failAllPending(err.message);
          this.handleDead(err.message);
        },
        onExit: () => {},
        onClose: (code, signal) => {
          this.transports.delete(transport);
          const tail = transport.stderrTail();
          const reason =
            tail.trim() ||
            `ZCode process exited (${code !== null ? `code ${code}` : `signal ${signal ?? "?"}`})`;
          this.rpc?.failAllPending(reason);
          this.handleDead(reason);
        },
        onSpawnError: (err) => {
          this.rpc?.failAllPending(err.message);
          this.handleDead(err.message);
        },
      },
      this.provider.spawnImplForMode(),
      codexWireCodec(limits.frameBytes),
    );
    this.transport = transport;
    this.transports.add(transport);

    const rpc = new CodexRpc(
      transport,
      {
        onServerRequest: (id, method, params) => this.handleServerRequest(rpc, id, method, params),
        onNotification: (method, params) => this.handleNotification(method, params),
        onClosed: (reason) => this.handleDead(reason),
        onFatal: (err) => {
          this.handleDead(err.message);
          void transport.dispose();
        },
      },
      {
        requestTimeoutMs: 90_000,
        onMutatingTimeout: (method) => {
          this.handleDead(`ZCode request timed out (${method})`);
          void transport.dispose();
        },
      },
    );
    this.rpc = rpc;
    transport.start();

    const pid = this.accountProviderId;
    const accRes = await rpc.request(
      "provider/updateAccountConfig",
      {
        revision: "tivano-1",
        basedOnZCodeBuiltinRevision: revision,
        providers: { [pid]: { access: { type: "zhipu-account", entitled: true } } },
        states: { [pid]: { availability: "available", entitled: true, current: true } },
      },
      { timeoutMs: 90_000, mutating: true },
    );
    if (!isObj(accRes) || accRes.status !== "received") {
      throw new ZCodeProviderError(
        "ZCode did not accept the account configuration.",
        "ZCODE_PROTOCOL_ERROR",
      );
    }

    const existing = this.provider.lookupBinding(this.localThreadId);
    const resumeId = existing?.providerId === "zcode" ? existing.codexThreadId : undefined;
    const mode = zcodeMode(context.runtimeMode, context.interactionMode);

    let sessionRes: unknown;
    if (resumeId) {
      sessionRes = await rpc.request(
        "session/resume",
        { sessionId: resumeId },
        { timeoutMs: 90_000, mutating: true },
      );
    } else {
      sessionRes = await rpc.request(
        "session/create",
        {
          workspace: {
            workspacePath: this.workspaceDirectory,
            workspaceKey: this.workspaceDirectory,
          },
          model: this.selection(context.model, context.effort),
          mode,
          persistence: "deferred",
        },
        { timeoutMs: 90_000, mutating: true },
      );
    }
    const sessionObj = isObj(sessionRes) && isObj(sessionRes.session) ? sessionRes.session : null;
    const sid = sessionObj ? str(sessionObj.sessionId) : null;
    if (!sid || (resumeId && sid !== resumeId)) {
      throw new ZCodeProviderError(
        "ZCode did not return the requested session.",
        "ZCODE_PROTOCOL_ERROR",
      );
    }
    this.zcodeSessionId = sid;

    if (!existing || existing.providerId !== "zcode") {
      await this.provider.bindThread(this.localThreadId, {
        providerId: "zcode",
        codexThreadId: sid,
        cwd: this.workspaceDirectory,
        codexHomeId: pid,
        schemaPin: ZCODE_SCHEMA_PIN,
        cliVersion: this.provider.config.version,
        savedAt: Date.now(),
      });
    }

    await rpc.request(
      "session/setMode",
      { sessionId: sid, mode },
      { timeoutMs: 90_000, mutating: true },
    );
    this.appliedMode = mode;

    await rpc.request(
      "session/subscribe",
      { sessionId: sid, deliveryKind: "desktop-continuous" },
      { timeoutMs: 90_000, mutating: true },
    );

    this.phase = "ready";
  }

  private handleServerRequest(rpc: CodexRpc, id: RpcId, method: string, params: unknown): void {
    const p = isObj(params) ? params : {};
    switch (method) {
      case "session/requestRuntimePreferences":
        rpc.respond(id, this.provider.getRuntimePreferences());
        return;
      case "interaction/requestProviderRuntimeHeaders": {
        const key = this.provider.currentApiKey().trim();
        if (key.length > 0) {
          rpc.respond(id, { headersApplied: true, requestAuth: { apiKey: key } });
        } else {
          rpc.respond(id, {
            headersApplied: false,
            errorMessage:
              "ZCode needs your GLM Coding Plan key. Add it in Settings › Providers › Z.ai.",
          });
        }
        return;
      }
      case "interaction/requestPermission": {
        const active = this.turn;
        if (!active || active.terminal) {
          rpc.respondError(id, -32601, "No active turn");
          return;
        }
        const key = rpcIdKey(id);
        const toolName = str(p.toolName) ?? "Tool";
        const rawOpts = Array.isArray(p.options) ? p.options : [];
        const payloads: Record<string, unknown> = {};
        const options: ApprovalOption[] = [];
        for (const opt of rawOpts) {
          if (!isObj(opt)) continue;
          const optionId = str(opt.optionId);
          if (!optionId || !("response" in opt)) continue;
          payloads[optionId] = opt.response;
          const role: ApprovalOption["role"] =
            str(opt.kind) === "allow_once" ? "approve" : "deny";
          options.push({
            id: optionId,
            title: str(opt.name) ?? optionId,
            role,
            scope: "once",
          });
        }
        this.pending.set(key, { kind: "permission", rpcId: id, payloads });
        const input = isObj(p.input) ? p.input : null;
        const command = input ? str(input.command) : null;
        const filePath = input ? str(input.file_path) : null;
        const kind =
          toolName === "Bash"
            ? "command"
            : ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)
              ? "fileChange"
              : "tool";
        const title =
          command ??
          (filePath ? relativePath(filePath, this.workspaceDirectory) : null) ??
          toolName;
        const reason = str(p.reason);
        active.cb.onApproval({
          kind: kind === "command" ? "command" : "action",
          symbol: kind === "command" ? "terminal" : kind === "fileChange" ? "doc" : "shield",
          headline:
            kind === "command"
              ? "ZCode requests command approval"
              : kind === "fileChange"
                ? "ZCode requests file approval"
                : "ZCode requests permissions",
          title,
          detail: reason ?? toolName,
          options,
          providerKey: key,
        });
        return;
      }
      case "interaction/requestUserInput": {
        const active = this.turn;
        if (!active || active.terminal) {
          rpc.respond(id, { action: "decline" });
          return;
        }
        const rawQs = Array.isArray(p.questions) ? p.questions : [];
        const questions: CodexQuestion[] = [];
        rawQs.forEach((item, index) => {
          if (!isObj(item)) return;
          const prompt = str(item.question);
          if (!prompt) return;
          const rawChoices = Array.isArray(item.options) ? item.options : [];
          const choices: CodexQuestionChoice[] = [];
          for (const ch of rawChoices) {
            if (!isObj(ch)) continue;
            const label = str(ch.label);
            if (!label) continue;
            const desc = str(ch.description);
            choices.push({ label, ...(desc ? { detail: desc } : {}) });
          }
          questions.push({
            id: String(index),
            header: str(item.header) ?? "",
            prompt,
            choices,
            allowsOther: true,
            isSecret: false,
          });
        });
        if (questions.length === 0 && str(p.prompt)) {
          questions.push({
            id: "0",
            header: "",
            prompt: str(p.prompt)!,
            choices: [],
            allowsOther: true,
            isSecret: false,
          });
        }
        if (questions.length === 0) {
          rpc.respond(id, { action: "decline" });
          return;
        }
        const key = rpcIdKey(id);
        this.pending.set(key, { kind: "question", rpcId: id, questions });
        active.cb.onQuestion?.({ providerKey: key, questions });
        return;
      }
      default:
        rpc.respondError(id, -32601, "Method not found");
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!isObj(params)) return;
    const sid = str(params.sessionId);
    if (sid && this.zcodeSessionId && sid !== this.zcodeSessionId) return;

    const active = this.turn;
    if (!active || active.terminal) return;

    // P2-37: stopped/errored turns reported via v4/telemetry/event turn.terminal
    if (method === "v4/telemetry/event") {
      if (params.kind !== "turn.terminal") return;
      const tid = str(params.turnId);
      const status = str(params.status);
      if (!tid || tid !== active.providerTurnId || !status || status === "success") return;
      const interrupted = status === "cancelled" || status === "interrupted";
      this.finishTurn(
        active,
        interrupted ? "interrupted" : "failed",
        interrupted ? undefined : str(params.errorMessage) ?? "ZCode reported an error.",
      );
      return;
    }

    if (method !== "session/event") return;
    const type = str(params.type);
    const id = str(params.turnId);
    const payload = isObj(params.payload) ? params.payload : {};

    if (type === "session.titleUpdated") {
      return;
    }

    if (type === "turn.started" && id && !this.completedProviderTurns.has(id)) {
      if (active.providerTurnId !== id) {
        active.providerTurnId = id;
        active.turnUsage = { input: 0, output: 0, cached: 0 };
      }
      return;
    }

    if (id && this.completedProviderTurns.has(id)) return;
    if (id && active.providerTurnId && id !== active.providerTurnId) return;

    // P2-37: a single failing tool (`tool.updated`) must NOT end the turn.
    if (
      type !== "tool.updated" &&
      type !== "turn.completed" &&
      isObj(payload.error) &&
      id &&
      id === active.providerTurnId
    ) {
      this.finishTurn(
        active,
        "failed",
        str(payload.error.message) ?? "ZCode reported an error.",
      );
      return;
    }

    switch (type) {
      case "model.streaming":
        this.handleStreaming(active, payload);
        break;
      case "tool.updated":
        this.handleToolResult(active, payload);
        break;
      case "session.updated": {
        if ("hookEventName" in payload && payload.hookEventName != null) return;
        if (payload.querySource !== "main_turn") return;
        const usage = isObj(payload.usage) ? payload.usage : null;
        if (!usage) return;
        const input = typeof usage.inputTokens === "number" ? usage.inputTokens : null;
        const output = typeof usage.outputTokens === "number" ? usage.outputTokens : null;
        if (input === null || output === null) return;
        const cached = typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
        active.turnUsage.input += input;
        active.turnUsage.output += output;
        active.turnUsage.cached += cached;
        const win = typeof payload.contextWindow === "number" ? payload.contextWindow : undefined;
        active.cb.onUsage?.({
          usedTokens: input + output,
          ...(win !== undefined ? { windowTokens: win } : {}),
          sessionTotalTokens: active.turnUsage.input + active.turnUsage.output,
        });
        break;
      }
      case "turn.completed": {
        if (id && active.providerTurnId && id !== active.providerTurnId) return;
        const effectiveTurnId = id ?? active.providerTurnId ?? active.localTurnId;
        this.completedProviderTurns.add(effectiveTurnId);
        this.finishReasoning(active);
        const usage = isObj(payload.usage) ? payload.usage : null;
        if (usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
          active.turnUsage = {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cached: typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
          };
          const win = typeof payload.contextWindow === "number" ? payload.contextWindow : undefined;
          active.cb.onUsage?.({
            usedTokens: active.turnUsage.input + active.turnUsage.output,
            ...(win !== undefined ? { windowTokens: win } : {}),
            sessionTotalTokens: active.turnUsage.input + active.turnUsage.output,
          });
        }
        // P2-37: cancelled / error_* / payload.error turns are NOT completed.
        const resultType = str(payload.resultType);
        if (resultType === "cancelled") {
          this.finishTurn(active, "interrupted");
        } else if (
          resultType === "error" ||
          resultType?.startsWith("error_") ||
          isObj(payload.error) ||
          str(payload.error) !== null
        ) {
          const msg =
            (isObj(payload.error) ? str(payload.error.message) : null) ??
            str(payload.error) ??
            str(payload.errorMessage) ??
            "ZCode reported an error.";
          this.finishTurn(active, "failed", msg);
        } else {
          this.finishTurn(active, "done");
        }
        break;
      }
      default:
        break;
    }
  }

  private handleStreaming(active: ActiveTurn, payload: Record<string, unknown>): void {
    const kind = str(payload.kind);
    if (kind === "text_delta" || kind === "reasoning_delta") {
      const msgId = str(payload.assistantMessageId);
      const delta = typeof payload.delta === "string" ? payload.delta : null;
      if (!msgId || delta === null) return;
      if (active.reasoningId !== null && active.reasoningId !== msgId) {
        this.finishReasoning(active);
      }
      if (kind === "text_delta") {
        active.messageId = msgId;
        if (delta.length > 0) active.cb.onChunk(++active.seq, delta);
      } else {
        const rid = `${msgId}:reasoning`;
        active.reasoningId = msgId;
        active.reasoningText += delta;
        active.cb.onReasoning?.({ itemId: rid, delta });
      }
      return;
    }
    if (kind === "tool_call") {
      const id = str(payload.toolCallId);
      if (!id) return;
      const name = str(payload.toolName) ?? "Tool";
      const input = isObj(payload.input) ? payload.input : null;
      const mapped = mapToolCall(name, input, this.workspaceDirectory);
      active.startedTools.add(id);
      active.cb.onToolActivity?.({
        itemId: id,
        kind: mapped.kind,
        title: mapped.title,
        status: "started",
        ...(mapped.detail ? { detail: mapped.detail } : {}),
      });
    }
  }

  private handleToolResult(active: ActiveTurn, payload: Record<string, unknown>): void {
    if (payload.kind !== "result") return;
    const id = str(payload.toolCallId);
    const result = isObj(payload.result) ? payload.result : null;
    if (!id || !result) return;
    // ZCode forwards subagent tool results into the parent session; drop any
    // subagent result without a parent-owned tool_call.
    if (payload.source === "subagent" && !active.startedTools.has(id)) return;

    const ok = result.success === true;
    const output = extractTextBlocks(result.content);
    const display = isObj(result.display) ? result.display : null;
    let detail = output;
    if (display && display.kind === "file_diff") {
      const filePath = str(display.filePath);
      const hunks = Array.isArray(display.structuredPatch) ? display.structuredPatch : [];
      const lines: string[] = [];
      for (const h of hunks) {
        if (isObj(h) && Array.isArray(h.lines)) {
          for (const l of h.lines) if (typeof l === "string") lines.push(l);
        }
      }
      if (filePath) {
        const rel = relativePath(filePath, this.workspaceDirectory);
        active.cb.onFileChanges?.([rel]);
        if (lines.length > 0) {
          const add = lines.filter((l) => l.startsWith("+")).length;
          const del = lines.filter((l) => l.startsWith("-")).length;
          detail = `+${add} −${del}  ${rel}`;
        }
      }
    }
    active.cb.onToolActivity?.({
      itemId: id,
      kind: "other",
      status: ok ? "completed" : "failed",
      ...(detail ? { detail } : {}),
    });
  }

  private finishReasoning(active: ActiveTurn): void {
    if (!active.reasoningId) return;
    const rid = `${active.reasoningId}:reasoning`;
    const finalText = active.reasoningText;
    active.reasoningId = null;
    active.reasoningText = "";
    active.cb.onReasoning?.({ itemId: rid, done: true, finalText });
  }

  private withdrawAllPending(active: ActiveTurn): void {
    for (const [key, ticket] of this.pending.entries()) {
      this.pending.delete(key);
      if (ticket.kind === "permission") active.cb.onApprovalWithdrawn?.(key);
      else active.cb.onQuestionWithdrawn?.(key);
    }
  }

  private finishTurn(
    active: ActiveTurn,
    outcome: "done" | "interrupted" | "failed",
    error?: string,
  ): void {
    if (active.terminal) return;
    active.terminal = true;
    if (active.providerTurnId) this.completedProviderTurns.add(active.providerTurnId);
    this.finishReasoning(active);
    this.withdrawAllPending(active);
    if (this.turn === active) this.turn = null;
    if (outcome === "done") active.cb.onDone();
    else if (outcome === "interrupted") active.cb.onInterrupted?.();
    else active.cb.onError(error ?? "ZCode reported an error.");
  }

  private handleDead(reason: string): void {
    this.phase = "dead";
    this.rpc = null;
    const active = this.turn;
    if (active && !active.terminal) {
      this.finishTurn(
        active,
        active.cancelIntent ? "interrupted" : "failed",
        active.cancelIntent ? undefined : reason,
      );
    }
  }

  resolveApproval(turnId: string, approved: boolean, optionId?: string): void {
    const active = this.turn;
    if (!active || active.localTurnId !== turnId || active.terminal || !this.rpc) return;
    for (const [key, ticket] of this.pending.entries()) {
      if (ticket.kind !== "permission" || ticket.writing) continue;
      const chosenId = optionId ?? Object.keys(ticket.payloads)[0];
      if (!chosenId || !(chosenId in ticket.payloads)) {
        this.pending.delete(key);
        active.cb.onApprovalWithdrawn?.(key);
        return;
      }
      const payload = ticket.payloads[chosenId];
      if (!approved) {
        this.pending.delete(key);
        this.rpc.respond(ticket.rpcId, payload);
        return;
      }
      ticket.writing = true;
      const ok = this.rpc.respond(ticket.rpcId, payload, (err) => {
        this.pending.delete(key);
        if (err) active.cb.onApprovalWithdrawn?.(key);
        else active.cb.onApprovalAnswerWritten?.(key);
      });
      if (!ok) {
        this.pending.delete(key);
        active.cb.onApprovalWithdrawn?.(key);
      }
      return;
    }
  }

  decline(turnId: string, optionId: string): void {
    this.resolveApproval(turnId, false, optionId);
  }

  answerQuestion(
    turnId: string,
    providerKey: string,
    answers: Record<string, string[]>,
  ): void {
    const active = this.turn;
    if (!active || active.localTurnId !== turnId || active.terminal || !this.rpc) return;
    const ticket = this.pending.get(providerKey);
    if (!ticket || ticket.kind !== "question" || ticket.writing) return;
    const content: Record<string, string> = {};
    for (const q of ticket.questions) {
      const vals = (answers[q.id] ?? []).filter((v) => v.trim().length > 0);
      if (vals.length > 0) content[q.prompt] = vals.join(", ");
    }
    const result =
      Object.keys(content).length === 0
        ? { action: "decline" }
        : { action: "accept", content: { answers: content } };
    ticket.writing = true;
    const ok = this.rpc.respond(ticket.rpcId, result, (err) => {
      this.pending.delete(providerKey);
      if (err) active.cb.onQuestionWithdrawn?.(providerKey);
      else active.cb.onQuestionAnswered?.(providerKey);
    });
    if (!ok) {
      this.pending.delete(providerKey);
      active.cb.onQuestionWithdrawn?.(providerKey);
    }
  }

  cancelTurn(turnId: string): void {
    const active = this.turn;
    if (!active || active.localTurnId !== turnId || active.terminal) return;
    active.cancelIntent = true;
    if (this.rpc && this.zcodeSessionId) {
      void this.rpc
        .request("session/stop", { sessionId: this.zcodeSessionId }, { timeoutMs: 10_000 })
        .catch(() => {});
    }
  }

  async shutdown(): Promise<{ children: ChildCleanupResult[]; orphaned: number }> {
    this.disposed = true;
    const active = this.turn;
    if (active && !active.terminal) {
      active.cancelIntent = true;
      this.finishTurn(active, "interrupted");
    }
    if (this.rpc && this.zcodeSessionId) {
      try {
        await this.rpc.request(
          "session/close",
          { sessionId: this.zcodeSessionId },
          { timeoutMs: 2_000 },
        );
      } catch {
        /* proceed to transport dispose */
      }
    }
    const children: ChildCleanupResult[] = [];
    for (const t of [...this.transports]) {
      const res = await t.dispose();
      children.push(res);
      if (!res.confirmed) this.cleanupFailures.set(t, res);
      else this.cleanupFailures.delete(t);
    }
    this.phase = "dead";
    this.rpc = null;
    this.transport = null;
    return { children, orphaned: this.pending.size };
  }
}

export class ZCodeProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly config: ZCodeRuntimeConfig;
  readonly transportLimits: Partial<TransportLimits>;
  private readonly opts: ZCodeProviderOptions;
  private sessions = new Map<string, ZCodeSession>();
  private retired = new Set<ZCodeSession>();
  private disposed = false;

  constructor(opts: ZCodeProviderOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.transportLimits = opts.transportLimits ?? {};
    const label =
      this.config.mode === "fixture"
        ? "ZCode (offline fixture)"
        : this.config.mode === "real"
          ? "ZCode"
          : "ZCode (unconfigured)";
    this.descriptor = {
      id: ZCODE_PROVIDER_ID,
      label,
      mode: "zcode",
      synthetic: true,
      runtimeInfo: {
        executable:
          this.config.mode === "fixture"
            ? `${this.config.fixtureNode} ${this.config.fixtureScript}`
            : this.config.entry ?? "(not configured)",
        version: this.config.version,
      },
      compact: false,
    };
  }

  currentApiKey(): string {
    return this.opts.apiKey();
  }

  currentRegion(): "global" | "china" {
    return this.opts.region?.() ?? this.config.region;
  }

  getRuntimePreferences(): Record<string, unknown> {
    if (this.opts.runtimePreferences) return this.opts.runtimePreferences();
    return readZCodeRuntimePreferences(this.config.homeDir);
  }

  builtinRevision(): string | null {
    if (!this.config.builtinConfigPath) {
      return this.config.mode === "fixture" ? "zcode-builtin:1:fixture" : null;
    }
    return readZCodeBuiltinRevision(this.config.builtinConfigPath);
  }

  cachedModels(): CodexModelOption[] {
    if (!this.config.builtinConfigPath) return [];
    return readZCodeBuiltinModels(this.config.builtinConfigPath, this.currentRegion());
  }

  lookupBinding(tid: string): ProviderThreadBinding | undefined {
    return this.opts.lookupBinding(tid);
  }

  bindThread(tid: string, b: ProviderThreadBinding): Promise<void> {
    return this.opts.bindThread(tid, b);
  }

  buildSpec(workspaceDir: string): SpawnSpec {
    if (this.opts.makeSpec) return this.opts.makeSpec(workspaceDir);
    if (this.config.mode === "fixture") {
      return {
        executable: this.config.fixtureNode!,
        args: [this.config.fixtureScript!],
        cwd: workspaceDir,
        env: buildZCodeEnv({
          entry: this.config.fixtureScript!,
          builtinConfigPath: this.config.builtinConfigPath,
          homeDir: this.config.homeDir,
        }),
      };
    }
    return {
      executable: this.config.runtimeExecutable!,
      args: [this.config.entry!, "app-server", "--stdio"],
      cwd: workspaceDir,
      env: buildZCodeEnv({
        entry: this.config.entry!,
        builtinConfigPath: this.config.builtinConfigPath,
        homeDir: this.config.homeDir,
      }),
    };
  }

  spawnImplForMode(): SpawnImpl | undefined {
    if (this.opts.spawnImpl) return this.opts.spawnImpl;
    if (
      this.config.mode === "real" &&
      this.config.treeCapability.supported &&
      this.config.treeCapability.helperPath
    ) {
      return makeJobHelperSpawnImpl(this.config.treeCapability.helperPath);
    }
    return undefined;
  }

  start(context: TurnContext, callbacks: ProviderCallbacks): ProviderTurnHandle {
    if (this.disposed) {
      throw new ZCodeProviderError("ZCODE_BUSY: provider is disposed", "ZCODE_BUSY");
    }
    if (this.config.mode === "unconfigured") {
      throw new ZCodeProviderError(
        this.config.unavailableReason ??
          "ZCode is not installed. Install the ZCode app, then refresh in Settings › Providers.",
        "ZCODE_NOT_INSTALLED",
      );
    }
    if (!context.workspace) {
      throw new ZCodeProviderError(
        "ZCODE_WORKSPACE_REQUIRED: ZCode requires an authorized workspace",
        "ZCODE_WORKSPACE_REQUIRED",
      );
    }
    let session = this.sessions.get(context.threadId);
    if (session && session.workspaceDirectory !== realpathSync(context.workspace.directory)) {
      throw new ZCodeProviderError(
        "ZCODE_WORKSPACE_REQUIRED: this thread's session is bound to a different workspace",
        "ZCODE_WORKSPACE_REQUIRED",
      );
    }
    if (!session) {
      session = new ZCodeSession(this, context.threadId, context.workspace);
      this.sessions.set(context.threadId, session);
    }
    session.beginTurn(context, callbacks);
    const threadId = context.threadId;
    const turnId = context.turnId;
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
    this.retired.add(s);
    void s.shutdown().then(() => {
      if (!s.hasUnconfirmedChild()) this.retired.delete(s);
    });
  }

  async modelCatalog(): Promise<CodexModelOption[] | null> {
    if (this.config.mode === "unconfigured") return null;
    const models = this.cachedModels();
    return models.length > 0 ? models : null;
  }

  async dispose(): Promise<AdapterDisposeResult> {
    this.disposed = true;
    const children: ChildCleanupResult[] = [];
    let orphaned = 0;
    for (const s of [...this.sessions.values(), ...this.retired]) {
      const r = await s.shutdown();
      children.push(...r.children);
      orphaned += r.orphaned;
      if (!s.hasUnconfirmedChild()) {
        this.retired.delete(s);
        for (const [tid, cur] of this.sessions) if (cur === s) this.sessions.delete(tid);
      }
    }
    return { children, orphanedPending: orphaned };
  }
}
