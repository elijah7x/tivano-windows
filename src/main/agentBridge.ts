// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-45 agent bridge — bounded port of the frozen EphemeralAgentRunner +
// the agentModels/agentRun control commands (macOS 3.0.15) for reader apps:
//   - own endpoint (<dataRoot>/control/agent.sock or \\.\pipe\tivano-agent-
//     <hash>) that listens whenever the app runs, independent of the Local
//     control switch; it answers only agentModels and agentRun
//   - agentRun streams one turn as JSON-line events (session, text,
//     thinking, tool_start, tool_end, file, done | error); a client
//     disconnect cancels the turn
//   - turns go straight to the provider adapter: no ChatThread is created,
//     inserted or persisted, so nothing appears in the sidebar
//   - file edits are approved automatically; command, plan and permission
//     approvals are declined (Codex may still run commands inside its own
//     sandbox under autoAcceptEdits) and questions get empty answers
// Bounded honestly: only the app's bound provider is listed; an idle
// session's provider state is released after 30 minutes.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, posix, win32 } from "node:path";
import type { Engine } from "./engine";
import type { ProviderAdapter, ProviderTurnHandle, ToolActivity } from "./provider";
import type { ApprovalRequest } from "../shared/types";

export const AGENT_PROTOCOL_VERSION = 1;
export const MAX_AGENT_PROMPT = 900_000;
const MAX_FRAME = 1_048_576;
const MAX_CONNECTIONS = 8;
const MAX_DELTA = 16_384;
const MAX_ERROR = 300;
const MAX_FILES = 1_000;
const IDLE_TTL_MS = 30 * 60_000;

export type AgentErrorCode = "app_unavailable" | "model_unavailable" | "bad_request" | "internal";
export type AgentEvent =
  | { type: "session"; session: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_end"; id: string; ok: boolean }
  | { type: "file"; path: string }
  | { type: "done" }
  | { type: "error"; code: AgentErrorCode; message: string };

export interface AgentModel {
  id: string;
  label: string;
  providerName: string;
  isDefault: boolean;
}
export interface AgentRunRequest {
  cwd: string;
  model?: string;
  session?: string;
  prompt: string;
}

export function agentBridgeEndpoint(
  dataRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const normalized = win32.resolve(dataRoot).replace(/[\\/]+$/, "").toLowerCase();
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\tivano-agent-${digest}`;
  }
  return platform === process.platform
    ? join(dataRoot, "control", "agent.sock")
    : posix.join(dataRoot, "control", "agent.sock");
}

export const encodeAgentModel = (provider: string, model?: string) =>
  model ? `${provider}/${model}` : provider;
export function decodeAgentModel(id: string): { provider: string; model?: string } {
  const slash = id.indexOf("/");
  if (slash < 0) return { provider: id };
  const model = id.slice(slash + 1);
  return model ? { provider: id.slice(0, slash), model } : { provider: id.slice(0, slash) };
}

/** Frozen sanitizeError: no ANSI, no secrets, one line, ≤300 chars. */
export function sanitizeAgentError(raw: string): string {
  let s = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  for (const re of [
    /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|authorization)\s*[:=]\s*['"]?[^\s'",;}{]{6,}['"]?/gi,
    /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
  ])
    s = s.replace(re, "[redacted]");
  s = s.split(/\s+/).filter(Boolean).join(" ");
  if (!s) return "Provider error.";
  return s.length > MAX_ERROR ? s.slice(0, MAX_ERROR - 1) + "…" : s;
}

/** Frozen approvalOptionID: file changes are approved, everything else
 *  (commands, plans, permission grants) is declined. */
export function agentApprovalDecision(
  req: Pick<ApprovalRequest, "kind" | "headline" | "options">,
): { approve: boolean; optionId: string } {
  const isFileChange = req.kind === "action" && !/permission/i.test(req.headline);
  const pick = (role: "approve" | "deny") =>
    req.options.find((o) => o.role === role && (o.scope === "once" || o.scope === "turn"))?.id ??
    req.options.find((o) => o.role === role)?.id;
  return isFileChange
    ? { approve: true, optionId: pick("approve") ?? "once" }
    : { approve: false, optionId: pick("deny") ?? "decline" };
}

function toolEventFields(a: ToolActivity): { name: string; input?: Record<string, unknown> } {
  const title = a.title?.trim();
  const name = a.kind === "mcp" || a.kind === "other" ? title || a.kind : a.kind;
  if (!title) return { name };
  const key = { read: "path", edit: "path", command: "command", search: "query", web: "target" }[
    a.kind as string
  ];
  return { name, input: { [key ?? "title"]: title } };
}

function isAbsoluteFor(p: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(p) && /^([a-z]:[\\/]|\\\\)/i.test(p) : posix.isAbsolute(p);
}

/** Resolve a provider-reported edit path against the run's cwd. */
export function resolveAgentFilePath(
  raw: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const p = raw.trim();
  if (!p || p === "/dev/null" || p.toUpperCase() === "NUL") return null;
  const path = platform === "win32" ? win32 : posix;
  return path.normalize(isAbsoluteFor(p, platform) ? p : path.join(cwd, p));
}

interface Entry {
  model: string;
  cwd: string;
  busy: boolean;
  lastUsed: number;
}

/** One-shot turns on behalf of external readers — never a ChatThread. */
export class EphemeralAgentRunner {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly engine: Pick<Engine, "providerDescriptor" | "codexModels">,
    private readonly adapter: () => ProviderAdapter | null,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = Date.now,
  ) {}

  async models(): Promise<{ version: 1; models: AgentModel[] }> {
    const d = this.engine.providerDescriptor;
    if (!this.adapter()) return { version: 1, models: [] };
    const models: AgentModel[] = [];
    if (d.mode === "codex") {
      const cat = await this.engine.codexModels();
      if (cat.state === "ready")
        for (const m of cat.models)
          models.push({
            id: encodeAgentModel(d.mode, m.id),
            label: m.name || m.id,
            providerName: d.label,
            isDefault: m.isDefault === true,
          });
    }
    if (models.length === 0)
      models.push({ id: d.mode, label: d.label, providerName: d.label, isDefault: true });
    if (!models.some((m) => m.isDefault)) models[0]!.isDefault = true;
    return { version: 1, models };
  }

  /** Release idle sessions' provider state (frozen 30-minute idle TTL). */
  sweep(): void {
    for (const [id, e] of this.entries)
      if (!e.busy && this.now() - e.lastUsed >= IDLE_TTL_MS) {
        this.entries.delete(id);
        this.adapter()?.endSession?.(id);
      }
  }

  shutdown(): void {
    for (const id of this.entries.keys()) this.adapter()?.endSession?.(id);
    this.entries.clear();
  }

  /** Streams one turn; resolves after the terminal event (or on abort). */
  async run(req: AgentRunRequest, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    this.sweep();
    const err = (code: AgentErrorCode, message: string) => emit({ type: "error", code, message });
    const adapter = this.adapter();
    if (!adapter) return err("app_unavailable", "Tivano is unavailable.");
    if (typeof req.prompt !== "string" || !req.prompt.trim())
      return err("bad_request", "Prompt must not be empty.");
    if (Buffer.byteLength(req.prompt, "utf8") > MAX_AGENT_PROMPT)
      return err("bad_request", "Prompt exceeds maximum size.");
    if (typeof req.cwd !== "string" || !isAbsoluteFor(req.cwd, this.platform))
      return err("bad_request", "Working directory must be an absolute path.");
    let cwd: string;
    try {
      cwd = realpathSync(req.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      return err("bad_request", "Working directory does not exist or is not a directory.");
    }
    const d = this.engine.providerDescriptor;
    const reused = req.session ? this.entries.get(req.session) : undefined;
    const requested = req.model ?? reused?.model;
    if (requested !== undefined) {
      const dec = decodeAgentModel(requested);
      if (dec.provider !== d.mode) return err("model_unavailable", "Unknown provider.");
      if (dec.model && d.mode !== "codex")
        return err("model_unavailable", `Requested model is unavailable for ${d.label}.`);
    }
    const model = requested ?? d.mode;
    let sessionId: string;
    if (reused && req.session && reused.model === model && reused.cwd === cwd) {
      if (reused.busy) return err("bad_request", "session_busy");
      sessionId = req.session;
    } else {
      if (reused && req.session) {
        this.entries.delete(req.session);
        adapter.endSession?.(req.session);
      }
      sessionId = randomUUID();
    }
    const entry: Entry = { model, cwd, busy: true, lastUsed: this.now() };
    this.entries.set(sessionId, entry);
    emit({ type: "session", session: sessionId });
    if (signal?.aborted) {
      entry.busy = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let finished = false;
      let streamed = "";
      const thinking = new Set<string>();
      const tools = new Map<string, boolean>();
      const files = new Set<string>();
      const send = (e: AgentEvent) => {
        if (!finished) emit(e);
      };
      const text = (type: "text" | "thinking", s: string) => {
        for (let i = 0; i < s.length; i += MAX_DELTA) send({ type, delta: s.slice(i, i + MAX_DELTA) });
      };
      const file = (raw: string) => {
        const p = resolveAgentFilePath(raw, cwd, this.platform);
        if (p && files.size < MAX_FILES && !files.has(p)) {
          files.add(p);
          send({ type: "file", path: p });
        }
      };
      const closeTools = (ok: boolean) => {
        for (const [id, ended] of tools) if (!ended) send({ type: "tool_end", id, ok });
        tools.clear();
      };
      const finish = (terminal: AgentEvent | null) => {
        if (finished) return;
        if (terminal) {
          closeTools(terminal.type === "done");
          send(terminal);
        }
        finished = true;
        entry.busy = false;
        entry.lastUsed = this.now();
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const fault = (m: string) => finish({ type: "error", code: "internal", message: sanitizeAgentError(m) });
      let handle: ProviderTurnHandle | undefined;
      const onAbort = () => {
        handle?.cancel();
        finish(null);
      };
      signal?.addEventListener("abort", onAbort);
      const dec = decodeAgentModel(model);
      try {
        handle = adapter.start(
          {
            prompt: req.prompt,
            threadId: sessionId,
            turnId: randomUUID(),
            workspace: { projectId: `agent:${sessionId}`, directory: cwd },
            runtimeMode: "autoAcceptEdits",
            interactionMode: "build",
            ...(dec.model ? { model: dec.model } : {}),
          },
          {
            onChunk: (_seq, delta) => {
              streamed += delta;
              text("text", delta);
            },
            onMessageText: (_seq, full) => {
              if (full.startsWith(streamed)) {
                text("text", full.slice(streamed.length));
                streamed = full;
              }
            },
            onReasoning: (a) => {
              if (a.delta) {
                thinking.add(a.itemId);
                text("thinking", a.delta);
              } else if (a.done && a.finalText && !thinking.has(a.itemId)) {
                thinking.add(a.itemId);
                text("thinking", a.finalText);
              }
            },
            onToolActivity: (a) => {
              if (!tools.has(a.itemId)) {
                tools.set(a.itemId, false);
                send({ type: "tool_start", id: a.itemId, ...toolEventFields(a) });
              }
              if (a.status !== "started" && tools.get(a.itemId) === false) {
                tools.set(a.itemId, true);
                send({ type: "tool_end", id: a.itemId, ok: a.status === "completed" });
              }
            },
            onFileChanges: (paths) => paths.forEach(file),
            onApproval: (r) => {
              const decision = agentApprovalDecision(r);
              queueMicrotask(() => {
                if (finished) return;
                if (decision.approve) handle?.resume(true, decision.optionId);
                else if (handle?.decline) handle.decline(decision.optionId);
                else handle?.resume(false, decision.optionId);
              });
            },
            onQuestion: (q) => queueMicrotask(() => !finished && handle?.answer?.(q.providerKey, {})),
            onDone: () => finish({ type: "done" }),
            onError: (m) => fault(m || "The provider failed to complete the turn."),
            onInterrupted: () => fault("The turn was interrupted."),
          },
        );
      } catch (e) {
        fault((e as Error)?.message ?? String(e));
      }
    });
  }
}

/** Agent-only endpoint: hello → welcome, then one agentModels or agentRun
 *  per connection. Listens while the app runs; Local control gates nothing. */
export class AgentBridgeService {
  readonly instance = randomUUID();
  readonly endpoint: string;
  private server: Server | undefined;
  private conns = new Set<Socket>();
  private readonly isPipe: boolean;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  listening = false;

  constructor(
    private readonly runner: EphemeralAgentRunner,
    private readonly dataRoot: string,
    private readonly edition: string = "dev",
  ) {
    this.endpoint = agentBridgeEndpoint(dataRoot);
    this.isPipe = this.endpoint.startsWith("\\\\.\\pipe\\");
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        if (!this.isPipe) {
          const dir = join(this.dataRoot, "control");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          chmodSync(dir, 0o700);
          if (existsSync(this.endpoint)) unlinkSync(this.endpoint);
        }
      } catch {
        resolve();
        return;
      }
      const server = createServer({ allowHalfOpen: false }, (c) => this.accept(c));
      this.server = server;
      server.on("error", () => {
        this.listening = false;
        if (this.server === server) this.server = undefined;
        resolve();
      });
      server.listen(this.isPipe ? { path: this.endpoint, exclusive: true } : { path: this.endpoint }, () => {
        if (!this.isPipe) {
          try {
            chmodSync(this.endpoint, 0o600);
          } catch {
            /* chmod may be a no-op */
          }
        }
        this.listening = true;
        this.sweepTimer = setInterval(() => this.runner.sweep(), 5 * 60_000);
        this.sweepTimer.unref?.();
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    this.server?.close();
    this.server = undefined;
    this.listening = false;
    this.runner.shutdown();
    if (!this.isPipe) {
      try {
        if (existsSync(this.endpoint) && lstatSync(this.endpoint).isSocket()) unlinkSync(this.endpoint);
      } catch {
        /* leave a foreign file alone */
      }
    }
  }

  private send(conn: Socket, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (payload.length > MAX_FRAME || conn.destroyed) return;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    conn.write(Buffer.concat([head, payload]));
  }

  private accept(conn: Socket): void {
    if (this.conns.size >= MAX_CONNECTIONS) {
      conn.destroy();
      return;
    }
    this.conns.add(conn);
    const abort = new AbortController();
    let buf = Buffer.alloc(0);
    let stage: "hello" | "request" | "busy" = "hello";
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (size <= 0 || size > MAX_FRAME) return void conn.destroy();
        if (buf.length < size + 4) return;
        const payload = buf.subarray(4, 4 + size);
        buf = buf.subarray(4 + size);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        } catch {
          return void conn.destroy();
        }
        if (stage === "hello") {
          if (msg.version !== AGENT_PROTOCOL_VERSION || msg.edition !== this.edition) {
            this.send(conn, { error: { code: msg.version !== AGENT_PROTOCOL_VERSION ? "protocolMismatch" : "editionMismatch" } });
            return void conn.end();
          }
          stage = "request";
          this.send(conn, {
            result: {
              welcome: {
                version: AGENT_PROTOCOL_VERSION,
                edition: this.edition,
                instance: this.instance,
                methods: ["agentModels", "agentRun"],
                maxFrame: MAX_FRAME,
                maxAgentPrompt: MAX_AGENT_PROMPT,
              },
            },
          });
        } else if (stage === "request") {
          stage = "busy";
          void this.handle(conn, msg, abort.signal);
        }
      }
    });
    const gone = () => {
      this.conns.delete(conn);
      abort.abort();
    };
    conn.on("close", gone);
    conn.on("error", gone);
  }

  private async handle(conn: Socket, msg: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    const cmd = (msg.command ?? {}) as { method?: unknown; params?: Record<string, unknown> };
    const p = cmd.params ?? {};
    if (msg.instance !== this.instance) {
      this.send(conn, { id, error: { code: "instanceMismatch" } });
    } else if (cmd.method === "agentModels") {
      this.send(conn, { id, result: { agentModels: await this.runner.models() } });
    } else if (cmd.method === "agentRun") {
      const opt = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
      await this.runner.run(
        { cwd: opt("cwd") ?? "", prompt: opt("prompt") ?? "", model: opt("model"), session: opt("session") } as AgentRunRequest,
        (e) => this.send(conn, { id, result: { agentEvent: { type: e.type, json: JSON.stringify(e) } } }),
        signal,
      );
    } else {
      this.send(conn, { id, error: { code: "invalidRequest", detail: "unknown-method" } });
    }
    if (!conn.destroyed) conn.end();
  }
}
