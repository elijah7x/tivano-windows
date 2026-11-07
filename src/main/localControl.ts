// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F33 local control — bounded port of the frozen AppControlService +
// ControlSocket contract (docs/local-control.md). This slice implements:
//   - same-account Unix socket under <dataRoot>/control/ (0700 dir,
//     0600 socket, stale-socket unlink, owned unlink on stop)
//   - 4-byte big-endian length-prefixed frames (maxFrame 1 MiB,
//     maxRequest 128 KiB — frozen LocalControl)
//   - hello → welcome handshake with version/edition/instance checks
//   - read commands: info providers projects threads thread history
//   - write commands: create submit interrupt settingsSet (+ operation
//     ticket query) with the frozen ticket ledger: SHA-256 dedupe,
//     same-ticket different-payload = conflict, first delivery older
//     than 30 s = unknown, ≤16 pending, ≤256 receipts (1 h retention)
//   - refusal surface: approval/question answers, login, permissions and
//     unknown commands are `invalidRequest`/`permission` — the command
//     set simply does not contain them (frozen: clients can observe
//     waiting but never approve/answer/login/grant)
// Bounded honestly: workspace=local only (worktree CLI needs the
// completion-observed path — interactive-terminal setup has no observed
// boundary, so worktree is `unsupported`); continuation accepts
// automatic|providerSession (fresh only on unsent threads; transcript
// needs a native-API provider we do not have); settings writable keys
// are the ones that exist in this build (textGeneration,
// antiSlopEnabled, performanceMode, showsSkylight).

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Engine } from "./engine";
import type { ChatThread } from "../shared/types";

const VERSION = 1;
const MAX_FRAME = 1_048_576;
const MAX_REQUEST = 131_072;
const MAX_TEXT = 65_536;
const MAX_CONNECTIONS = 8;
const MAX_PENDING_OPS = 16;
const MAX_RECEIPTS = 256;
const FIRST_DELIVERY_MS = 30_000;
const RETENTION_MS = 3_600_000;
const METHODS = [
  "info", "providers", "projects", "threads", "thread", "history",
  "create", "submit", "interrupt", "operation", "settingsGet", "settingsSet",
] as const;

type FailCode =
  | "disabled" | "unavailable" | "permission" | "protocolMismatch"
  | "editionMismatch" | "instanceMismatch" | "invalidRequest" | "bounds"
  | "busy" | "notFound" | "missingProject" | "unsupported" | "archived"
  | "workspacePreparing" | "workspaceFailed" | "directoryUnavailable"
  | "persistence" | "conflict" | "continuationUnavailable" | "shutdown"
  | "corruptHistory" | "cursorInvalid" | "providerFailure" | "internalError";

export class ControlFailure extends Error {
  constructor(
    readonly code: FailCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}
function fail(code: FailCode, detail?: string): never {
  throw new ControlFailure(code, detail);
}

interface Ticket {
  instance: string;
  id: string;
  issuedAtMs: number;
}
const ticketString = (t: Ticket) => `${t.instance}/${t.id}/${t.issuedAtMs}`;
function parseTicket(s: unknown): Ticket {
  if (typeof s !== "string") fail("invalidRequest");
  const parts = s.split("/");
  const ms = Number(parts[2]);
  if (parts.length !== 3 || !/^[0-9a-f-]{36}$/i.test(parts[0] ?? "") ||
      !/^[0-9a-f-]{36}$/i.test(parts[1] ?? "") || !Number.isInteger(ms) || ms <= 0)
    fail("invalidRequest");
  return { instance: parts[0]!, id: parts[1]!, issuedAtMs: ms };
}

type OpState =
  | "accepted" | "preparing" | "ready" | "started" | "waiting"
  | "ended" | "failed" | "unknown";

interface Operation {
  ticket: Ticket;
  state: OpState;
  payloadHash: string;
  threadId?: string;
  turnId?: string;
  turnStatus?: string;
  error?: { code: string; detail?: string };
  stopEvidence?: string;
  updatedAt: number;
  expiresAt?: number;
  unsubscribe?: () => void;
}

const hashPayload = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");

const isUuid = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** One app's local-control endpoint. The socket only exists while BOTH
 *  gates are on; closing either gate closes listener and connections
 *  (accepted turns keep running — the gate never cancels work). */
export class LocalControlService {
  readonly instance = randomUUID();
  private server: Server | undefined;
  private conns = new Set<Socket>();
  private active = 0;
  private ops = new Map<string, Operation>();
  private readonly dir: string;
  private readonly sockPath: string;
  listening = false;
  listenFailure: string | undefined;

  constructor(
    private readonly engine: Engine,
    dataRoot: string,
    private readonly edition: string = "dev",
  ) {
    this.dir = join(dataRoot, "control");
    this.sockPath = join(this.dir, "control.sock");
  }

  /** Frozen refreshListening — called on settings changes, library load
   *  and shutdown. Gates closed → full stop. */
  refreshListening(): void {
    const s = this.engine.snapshot().settings;
    const enabled = s.alphaEnabled === true && s.externalControlEnabled === true;
    if (!enabled) {
      this.stop();
      return;
    }
    if (this.server) return;
    try {
      this.start();
      this.listening = true;
      this.listenFailure = undefined;
    } catch (e) {
      this.listening = false;
      this.listenFailure = (e as Error).message;
    }
  }

  private start(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Stale socket from a dead instance is unlinked; a live one would
    // have refused the bind anyway.
    if (existsSync(this.sockPath)) unlinkSync(this.sockPath);
    const server = createServer({ allowHalfOpen: false }, (c) => this.accept(c));
    server.on("error", () => {});
    server.listen(this.sockPath, () => {
      try {
        chmodSync(this.sockPath, 0o600);
      } catch {
        /* keep the socket usable even where chmod is a no-op */
      }
    });
    this.server = server;
  }

  stop(): void {
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    this.server?.close();
    this.server = undefined;
    this.listening = false;
    // Only unlink the socket this instance created.
    try {
      const st = existsSync(this.sockPath) ? lstatSync(this.sockPath) : undefined;
      if (st?.isSocket()) unlinkSync(this.sockPath);
    } catch {
      /* leave a foreign file alone */
    }
  }

  /** Frozen suspendForShutdown — gates don't matter on quit. */
  dispose(): void {
    this.stop();
    for (const op of this.ops.values()) op.unsubscribe?.();
    this.ops.clear();
  }

  private accept(conn: Socket): void {
    if (this.conns.size >= MAX_CONNECTIONS) {
      conn.destroy();
      return;
    }
    this.conns.add(conn);
    let buf = Buffer.alloc(0);
    let welcomed = false;
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_REQUEST + 4) {
        conn.destroy();
        return;
      }
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (size <= 0 || size > MAX_FRAME || size > MAX_REQUEST) {
          conn.destroy();
          return;
        }
        if (buf.length < size + 4) return;
        const payload = buf.subarray(4, 4 + size);
        buf = buf.subarray(4 + size);
        if (!welcomed) {
          welcomed = true;
          this.handleHello(conn, payload);
        } else {
          void this.handleRequest(conn, payload);
        }
      }
    });
    conn.on("close", () => this.conns.delete(conn));
    conn.on("error", () => this.conns.delete(conn));
  }

  private send(conn: Socket, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (payload.length === 0 || payload.length > MAX_FRAME) {
      conn.destroy();
      return;
    }
    const out = Buffer.alloc(4 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    payload.copy(out, 4);
    conn.write(out);
  }

  private welcome() {
    const s = this.engine.snapshot().settings;
    return {
      version: VERSION,
      edition: this.edition,
      instance: this.instance,
      methods: [...METHODS],
      maxFrame: MAX_FRAME,
      maxRequest: MAX_REQUEST,
      maxText: MAX_TEXT,
      maxConnections: MAX_CONNECTIONS,
      maxPendingOperations: MAX_PENDING_OPS,
      maxListPage: 100,
      maxHistoryPage: 50,
      firstDeliverySeconds: 30,
      // Only keys that exist in this build are settable — all four listed
      // are real settings here.
      settings: ["textGeneration", "antiSlopEnabled", "performanceMode", "showsSkylight"],
      operationRetentionSeconds: 3600,
      maxOperations: 256,
      restartSemantics: "unknown_after_restart_no_replay",
      alphaEnabled: s.alphaEnabled === true,
    };
  }

  private handleHello(conn: Socket, payload: Buffer): void {
    try {
      const hello = JSON.parse(payload.toString("utf8")) as {
        version?: unknown;
        edition?: unknown;
        expectedInstance?: unknown;
      };
      if (hello.version !== VERSION) fail("protocolMismatch");
      if (hello.edition !== this.edition) fail("editionMismatch");
      if (hello.expectedInstance !== undefined && hello.expectedInstance !== this.instance)
        fail("instanceMismatch");
      this.send(conn, { result: { welcome: this.welcome() } });
    } catch (e) {
      const f = e instanceof ControlFailure ? e : new ControlFailure("invalidRequest");
      this.send(conn, { error: { code: f.code, detail: f.detail } });
      conn.destroy();
    }
  }

  private async handleRequest(conn: Socket, payload: Buffer): Promise<void> {
    let id: string | undefined;
    try {
      const req = JSON.parse(payload.toString("utf8")) as {
        id?: unknown;
        instance?: unknown;
        command?: unknown;
      };
      if (typeof req.id === "string") id = req.id;
      const s = this.engine.snapshot().settings;
      if (!(s.alphaEnabled === true && s.externalControlEnabled === true))
        fail("disabled");
      if (req.instance !== this.instance) fail("instanceMismatch");
      if (this.active >= MAX_CONNECTIONS) fail("busy");
      if (typeof req.command !== "object" || req.command === null)
        fail("invalidRequest");
      const cmd = req.command as { method?: unknown; params?: unknown };
      if (typeof cmd.method !== "string") fail("invalidRequest");
      if (!(METHODS as readonly string[]).includes(cmd.method))
        fail("invalidRequest", "unknown-method");
      if (
        cmd.params !== undefined &&
        (typeof cmd.params !== "object" || cmd.params === null || Array.isArray(cmd.params))
      )
        fail("invalidRequest");
      this.active++;
      try {
        const result = await this.dispatch(
          cmd.method,
          (cmd.params ?? {}) as Record<string, unknown>,
        );
        this.send(conn, { id, result });
      } finally {
        this.active--;
      }
    } catch (e) {
      const f = e instanceof ControlFailure ? e : new ControlFailure("internalError");
      this.send(conn, { id, error: { code: f.code, detail: f.detail } });
    }
  }

  /* -------------------------------------------------- queries ------ */

  private threadSummary(t: ChatThread) {
    return {
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      affiliation: t.projectId
        ? this.engine.snapshot().projects.some((p) => p.id === t.projectId)
          ? "project"
          : "missing_project"
        : "standalone",
      role: "normal",
      archived: t.isArchived === true,
      provider: this.engine.providerDescriptor.id,
      model: t.codexModel ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      lastStatus: t.turn?.status ?? null,
      activeTurnId:
        t.turn && (t.turn.status === "running" || t.turn.status === "waiting-approval")
          ? t.turn.id
          : null,
      waitingForUI: t.turn?.status === "waiting-approval",
      workspace: t.worktreeDir
        ? { mode: "worktree", phase: "ready", path: t.worktreeDir }
        : { mode: "local" },
      executionDirectory: this.engine.threadDirectory(t.id),
    };
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const engine = this.engine;
    const snap = engine.snapshot();
    switch (method) {
      case "info":
        return { info: this.welcome() };
      case "providers": {
        const d = engine.providerDescriptor;
        const catalog = d.mode === "codex" ? await engine.codexModels() : null;
        return {
          providers: [
            {
              id: d.id,
              enabled: true,
              installed: d.mode === "mock" ? false : true,
              // Authentication state is unknown by contract — never a
              // claim of sign-in (frozen wording).
              authentication: "unknown",
              models: catalog && catalog.state === "ready" ? catalog.models.map((m) => m.id) : [],
              freshSubmission: true,
              continuation: ["providerSession", "fresh"],
              interrupt: true,
              capabilityScope: "provider_model_session_rechecked_on_submission",
            },
          ],
        };
      }
      case "projects": {
        const limit = pageLimit(params);
        const items = [...snap.projects]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((p) => ({ id: p.id, name: p.name, path: p.directory ?? null }));
        return { projects: pageItems(items, params, (p) => p.id) };
      }
      case "threads": {
        const limit = pageLimit(params);
        const archive = str(params, "archive") ?? "active";
        if (!["active", "archived", "all"].includes(archive)) fail("invalidRequest");
        const role = str(params, "role") ?? "normal";
        if (!["normal", "helper", "head", "all"].includes(role)) fail("invalidRequest");
        if (role !== "normal" && role !== "all") fail("unsupported", "no helper/head threads");
        const affiliation = str(params, "affiliation") ?? "all";
        if (!["all", "standalone", "project", "missing_project"].includes(affiliation))
          fail("invalidRequest");
        const search = str(params, "search");
        if (search !== undefined && search.length > 256) fail("bounds");
        const projFilter = params["project"];
        if (projFilter !== undefined && !isUuid(projFilter)) fail("invalidRequest");
        let items = snap.threads.map((t) => this.threadSummary(t));
        if (archive === "active") items = items.filter((t) => !t.archived);
        else if (archive === "archived") items = items.filter((t) => t.archived);
        if (affiliation === "standalone") items = items.filter((t) => t.affiliation === "standalone");
        else if (affiliation === "project") {
          if (projFilter !== undefined) items = items.filter((t) => t.projectId === projFilter);
          else items = items.filter((t) => t.affiliation === "project");
        } else if (affiliation === "missing_project")
          items = items.filter((t) => t.affiliation === "missing_project");
        if (search) {
          const q = search.toLowerCase();
          items = items.filter((t) => t.title.toLowerCase().includes(q));
        }
        items.sort((a, b) => a.id.localeCompare(b.id));
        return { threads: pageItems(items, params, (t) => t.id) };
      }
      case "thread": {
        const id = params["id"] ?? params["threadId"];
        if (!isUuid(id)) fail("invalidRequest");
        const t = snap.threads.find((x) => x.id === id);
        if (!t) fail("notFound");
        return { thread: this.threadSummary(t) };
      }
      case "history": {
        const id = params["id"] ?? params["threadId"];
        if (!isUuid(id)) fail("invalidRequest");
        const t = snap.threads.find((x) => x.id === id);
        if (!t) fail("notFound");
        const limit = pageLimit(params);
        // Persisted-only projection: entries from the stored messages —
        // no runtime is created and no bytes are fabricated.
        const all = t.messages.map((m) => ({
          id: m.id,
          turnId: m.turnId ?? null,
          turnStatus: t.turn?.id === m.turnId ? (t.turn?.status ?? null) : null,
          date: m.ts,
          kind: m.role,
          text: m.content.length > MAX_TEXT ? m.content.slice(0, MAX_TEXT) : m.content,
          truncated: m.content.length > MAX_TEXT,
        }));
        return {
          history: {
            threadId: id,
            ...pageItems(all, params, (m) => m.id, limit),
            snapshot: "persisted",
            persistedOnly: true,
          },
        };
      }
      case "operation": {
        const t = parseTicket(params["ticket"]);
        const op = this.ops.get(t.id);
        if (!op || op.ticket.instance !== t.instance) return { operation: { ticket: t, state: "unknown" } };
        return { operation: outcomeOf(op) };
      }
      case "settingsGet":
        return { settings: this.settingsSnapshot() };
      case "settingsSet":
        return this.writeSettings(params);
      case "create":
        return this.createThreadOp(params);
      case "submit":
        return this.submitOp(params);
      case "interrupt":
        return this.interruptOp(params);
      default:
        fail("invalidRequest");
    }
  }

  /* ---------------------------------------------- write ledger ----- */

  /** Frozen ControlLedger.accept: same ticket + same payload → the
   *  stored receipt (never re-execute); same ticket + different payload
   *  → conflict; a ticket first delivered >30 s after issue → unknown
   *  (not executed). */
  private acceptWrite(ticket: Ticket, payload: unknown): { op: Operation; fresh: boolean } {
    if (ticket.instance !== this.instance) fail("instanceMismatch");
    const key = ticket.id;
    const existing = this.ops.get(key);
    const payloadHash = hashPayload(payload);
    if (existing) {
      if (existing.payloadHash !== payloadHash) fail("conflict");
      return { op: existing, fresh: false };
    }
    if (Date.now() - ticket.issuedAtMs > FIRST_DELIVERY_MS) fail("unknown" as FailCode, "stale-ticket");
    const pending = [...this.ops.values()].filter((o) => !isTerminal(o.state)).length;
    if (pending >= MAX_PENDING_OPS) fail("busy", "operation-capacity");
    // Receipts are retained an hour from issuance; capacity refuses new
    // writes rather than evicting an unexpired receipt.
    if (this.ops.size >= MAX_RECEIPTS) {
      const now = Date.now();
      for (const [k, o] of this.ops) {
        if (isTerminal(o.state) && (o.expiresAt ?? 0) < now) {
          o.unsubscribe?.();
          this.ops.delete(k);
        }
      }
      if (this.ops.size >= MAX_RECEIPTS) fail("busy", "receipt-capacity");
    }
    const op: Operation = {
      ticket,
      state: "accepted",
      payloadHash,
      updatedAt: Date.now(),
    };
    this.ops.set(key, op);
    return { op, fresh: true };
  }

  private trackTurn(op: Operation, threadId: string): void {
    op.unsubscribe?.();
    op.unsubscribe = this.engine.onEvent((e) => {
      if (e.type !== "turn-status" || e.threadId !== threadId) return;
      const st = e.status;
      if (st === "running") {
        if (op.state === "accepted" || op.state === "ready") op.state = "started";
      } else if (st === "waiting-approval") {
        op.state = "waiting";
      } else {
        op.state = st === "done" ? "ended" : st === "error" ? "failed" : "ended";
        op.turnStatus = st;
        op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
        op.unsubscribe?.();
      }
      op.updatedAt = Date.now();
    });
  }

  private createThreadOp(params: Record<string, unknown>) {
    const provider = str(params, "provider");
    const d = this.engine.providerDescriptor;
    if (provider !== undefined && provider !== d.id && provider !== d.mode)
      fail("unsupported", "provider-unavailable");
    const workspace = str(params, "workspace") ?? "local";
    if (workspace === "worktree")
      fail("unsupported", "worktree-create has no observed setup boundary");
    if (workspace !== "local") fail("invalidRequest");
    const projectId = params["project"];
    if (projectId !== undefined && !isUuid(projectId)) fail("invalidRequest");
    if (projectId !== undefined) {
      const p = this.engine.snapshot().projects.find((x) => x.id === projectId);
      if (!p) fail("missingProject");
      if (d.mode !== "mock" && !p.directory) fail("directoryUnavailable");
    }
    const ticket = this.ticketParam(params);
    const { op, fresh } = this.acceptWrite(ticket, { method: "create", params });
    if (!fresh) return { operation: outcomeOf(op) };
    try {
      const thread = this.engine.createThread(projectId ?? null);
      op.threadId = thread.id;
      const model = str(params, "model");
      if (model !== undefined) {
        if (model.length > 512) fail("unsupported", "model_unavailable");
        this.engine.setThreadModel(thread.id, model, str(params, "effort") ?? null);
      }
      op.state = "ready";
      op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
      op.updatedAt = Date.now();
      return { operation: outcomeOf(op) };
    } catch (e) {
      op.state = "failed";
      op.error = { code: "providerFailure", detail: (e as Error).message.slice(0, 400) };
      op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
      throw new ControlFailure("providerFailure", (e as Error).message.slice(0, 400));
    }
  }

  private submitOp(params: Record<string, unknown>) {
    const threadId = params["threadId"];
    if (!isUuid(threadId)) fail("invalidRequest");
    const text = params["text"];
    if (typeof text !== "string" || text.trim() === "") fail("invalidRequest");
    if (text.length > MAX_TEXT) fail("bounds");
    const continuation = str(params, "continuation") ?? "automatic";
    if (!["automatic", "fresh", "providerSession", "transcript"].includes(continuation))
      fail("invalidRequest");
    const t = this.engine.snapshot().threads.find((x) => x.id === threadId);
    if (!t) fail("notFound");
    if (t.isArchived) fail("archived");
    if (t.turn && (t.turn.status === "running" || t.turn.status === "waiting-approval"))
      fail("busy");
    // Frozen rejection surface: slash commands ride no ordinary prompt.
    if (text.trimStart().startsWith("/")) fail("invalidRequest", "slash-command");
    const hasStarted = t.messages.length > 0;
    if (continuation === "fresh" && hasStarted) fail("continuationUnavailable");
    if (continuation === "transcript") fail("continuationUnavailable", "no native-API provider");
    const ticket = this.ticketParam(params);
    const { op, fresh } = this.acceptWrite(ticket, { method: "submit", params });
    if (!fresh) return { operation: outcomeOf(op) };
    try {
      const turn = this.engine.sendTurn(threadId, text);
      op.threadId = threadId;
      op.turnId = turn.id;
      op.state = "started";
      this.trackTurn(op, threadId);
      return { operation: outcomeOf(op) };
    } catch (e) {
      op.state = "failed";
      op.error = { code: "providerFailure", detail: (e as Error).message.slice(0, 400) };
      op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
      return { operation: outcomeOf(op) };
    }
  }

  private interruptOp(params: Record<string, unknown>) {
    const threadId = params["threadId"];
    const turnId = params["turnId"];
    if (!isUuid(threadId) || !isUuid(turnId)) fail("invalidRequest");
    const t = this.engine.snapshot().threads.find((x) => x.id === threadId);
    if (!t) fail("notFound");
    const turn = t.turn;
    if (!turn || turn.id !== turnId) fail("notFound");
    if (turn.status !== "running" && turn.status !== "waiting-approval")
      fail("invalidRequest", "turn-not-running");
    const ticket = this.ticketParam(params);
    const { op, fresh } = this.acceptWrite(ticket, { method: "interrupt", params });
    if (!fresh) return { operation: outcomeOf(op) };
    op.threadId = threadId;
    op.turnId = turnId;
    // Interrupt ACCEPTANCE is not a stopped turn — the outcome waits for
    // runtime finalization (stopEvidence stays honest).
    this.engine.cancelTurn(threadId);
    op.state = "ended";
    op.turnStatus = "cancelled";
    op.stopEvidence = "runtime_ended_only";
    op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
    op.updatedAt = Date.now();
    return { operation: outcomeOf(op) };
  }

  private ticketParam(params: Record<string, unknown>): Ticket {
    const t = parseTicket(params["ticket"]);
    return t;
  }

  private settingsSnapshot() {
    const s = this.engine.snapshot().settings;
    return [
      {
        key: "textGeneration",
        preference: { textGeneration: s.textGeneration ?? "automatic" },
        effective: { textGeneration: s.textGeneration ?? "automatic" },
      },
      {
        key: "antiSlopEnabled",
        preference: { bool: s.antiSlopEnabled !== false },
        effective: { bool: s.antiSlopEnabled !== false },
      },
      {
        key: "performanceMode",
        preference: { bool: s.performanceMode === true },
        effective: { bool: s.performanceMode === true },
      },
      {
        key: "showsSkylight",
        preference: { bool: s.showsSkylight !== false },
        // Frozen showsSkylightNow: the hero rests under Performance Mode.
        effective: { bool: s.showsSkylight !== false && s.performanceMode !== true },
      },
    ];
  }

  private writeSettings(params: Record<string, unknown>) {
    const key = str(params, "key");
    if (!key || !["textGeneration", "antiSlopEnabled", "performanceMode", "showsSkylight"].includes(key))
      fail("invalidRequest");
    const ticket = this.ticketParam(params);
    const { op, fresh } = this.acceptWrite(ticket, { method: "settingsSet", params });
    if (!fresh) return { operation: outcomeOf(op) };
    try {
      if (key === "textGeneration") {
        const v = str(params, "textGeneration") ?? str(params, "value");
        if (v === "claude" || v === "codex")
          fail("unsupported", "provider-specific text engine needs a signed-in CLI");
        if (v !== "automatic" && v !== "off") fail("invalidRequest");
        this.engine.setSettings({ textGeneration: v });
      } else {
        const b = typeof params["bool"] === "boolean" ? params["bool"] : params["value"];
        if (typeof b !== "boolean") fail("invalidRequest");
        if (key === "antiSlopEnabled") this.engine.setSettings({ antiSlopEnabled: b });
        else if (key === "performanceMode") this.engine.setSettings({ performanceMode: b });
        else this.engine.setSettings({ showsSkylight: b });
      }
      op.state = "ended";
      op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
      op.updatedAt = Date.now();
      return { operation: outcomeOf(op) };
    } catch (e) {
      op.state = "failed";
      op.error = {
        code: e instanceof ControlFailure ? e.code : "internalError",
        detail: (e as Error).message.slice(0, 400),
      };
      op.expiresAt = op.ticket.issuedAtMs + RETENTION_MS;
      throw e;
    }
  }
}

/* ------------------------------------------------------- helpers --- */

const str = (p: Record<string, unknown>, k: string): string | undefined =>
  typeof p[k] === "string" ? (p[k] as string) : undefined;

function pageLimit(params: Record<string, unknown>): number {
  const l = params["limit"];
  if (l === undefined) return 50;
  if (typeof l !== "number" || !Number.isInteger(l) || l < 1 || l > 100)
    fail("bounds");
  return l;
}

/** Offset cursor `o:<n>` — bounded, invalid cursor is cursorInvalid. */
function pageItems<T>(
  items: T[],
  params: Record<string, unknown>,
  keyOf: (t: T) => string,
  limit?: number,
): { items: T[]; nextCursor?: string; snapshot: string } {
  const lim = limit ?? pageLimit(params);
  let off = 0;
  const cur = params["cursor"];
  if (cur !== undefined) {
    if (typeof cur !== "string" || !/^o:\d+$/.test(cur)) fail("cursorInvalid");
    off = Number(cur.slice(2));
  }
  const slice = items.slice(off, off + lim);
  const next = off + lim < items.length ? `o:${off + lim}` : undefined;
  return {
    items: slice,
    ...(next !== undefined ? { nextCursor: next } : {}),
    snapshot: `n=${items.length}`,
  };
}

const isTerminal = (s: OpState) =>
  s === "ready" || s === "ended" || s === "failed" || s === "unknown";

function outcomeOf(op: Operation) {
  return {
    ticket: ticketString(op.ticket),
    state: op.state,
    ...(op.threadId !== undefined ? { threadId: op.threadId } : {}),
    ...(op.turnId !== undefined ? { turnId: op.turnId } : {}),
    ...(op.turnStatus !== undefined ? { turnStatus: op.turnStatus } : {}),
    ...(op.error !== undefined ? { error: op.error } : {}),
    ...(op.stopEvidence !== undefined ? { stopEvidence: op.stopEvidence } : {}),
    updatedAt: op.updatedAt,
    ...(op.expiresAt !== undefined ? { expiresAt: op.expiresAt } : {}),
  };
}
