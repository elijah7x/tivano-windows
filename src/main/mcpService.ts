// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18 bounded slice: frozen MCPProbe stdio path. Spawns the configured
// command for real, runs newline-framed JSON-RPC initialize +
// notifications/initialized + tools/list paging, and kills the child
// when done. No shell — argv passes verbatim; a missing executable
// reports "missing", a dead server reports its exit + stderr tail,
// silence reports timedOut. HTTP/OAuth transports are out of slice.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  MCP_CLIENT_INFO,
  MCP_LIST_TOOLS_MAX_PAGES,
  MCP_PROBE_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  type McpProbeResult,
  type McpServerConfig,
  type McpToolInfo,
} from "../shared/mcp";

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  [k: string]: unknown;
}

/**
 * Probe one server: initialize → initialized → tools/list pages.
 * stdio spawns the REAL command (killed before return); HTTP POSTs real
 * JSON-RPC to the configured URL (session DELETE attempted on the way
 * out). Neither path invents a result.
 */
export async function probeMcpServer(
  server: Pick<
    McpServerConfig,
    "command" | "args" | "env" | "transport" | "url" | "headers"
  >,
  timeoutMs: number =
    Number(process.env.TIVANO_MCP_PROBE_TIMEOUT_MS) || MCP_PROBE_TIMEOUT_MS,
): Promise<McpProbeResult> {
  if (server.transport === "http") return probeHttpServer(server, timeoutMs);
  if (!server.command.trim())
    return { status: "missing", reason: "No command configured." };
  return probeStdioServer(server, timeoutMs);
}

/**
 * v2.0.22 (frozen parity): MCP servers are spawned with the command's
 * FULL resolved path — ACP-style agents validate the command path and a
 * bare `npx` gets the whole session refused. A command already carrying
 * a separator passes through; anything else resolves against the
 * effective PATH (server env may override it). Unresolved commands keep
 * the bare name so the spawn ENOENT still reports "isn't installed".
 */
function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string {
  if (/[/\\]/.test(command)) return command;
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return command;
}

async function probeStdioServer(
  server: Pick<McpServerConfig, "command" | "args" | "env">,
  timeoutMs: number,
): Promise<McpProbeResult> {
  const env = { ...process.env, ...(server.env ?? {}) };
  let child;
  try {
    child = spawn(resolveOnPath(server.command, env), server.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return { status: "error", reason: (err as Error)?.message ?? String(err) };
  }

  let stderrTail = "";
  child.stderr?.on("data", (d) => {
    stderrTail = (stderrTail + String(d)).slice(-2000);
  });

  let spawnErr: Error | null = null;
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", (err) => {
      spawnErr = err;
      resolve({ code: null });
    });
  });
  let exited: number | null | "alive" = "alive";

  let buffer = "";
  interface Pending {
    resolve: (m: RpcMessage) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<number, Pending>();
  const failAll = (err: { kind: string; code: number | null }) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  };
  void done.then((d) => {
    exited = d.code;
    failAll({ kind: "exited", code: d.code });
  });
  child.stdout?.on("data", (d) => {
    buffer += String(d);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // non-RPC chatter on stdout is not a reply
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    }
  });

  let nextId = 1;
  const send = (msg: RpcMessage) => {
    try {
      child.stdin?.write(JSON.stringify(msg) + "\n");
    } catch {
      /* dead stdin surfaces via the exit path */
    }
  };
  const request = (method: string, params: object | undefined, ms: number): Promise<RpcMessage> =>
    new Promise((resolve, reject) => {
      if (exited !== "alive") {
        reject({ kind: "exited", code: exited });
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject({ kind: "timedOut" });
      }, ms);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const init = await request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      remaining(),
    );
    if (init.error) throw { kind: "malformed", reason: init.error.message ?? "initialize failed" };
    const result = init.result as { serverInfo?: { name?: string; version?: string } } | undefined;
    if (typeof result !== "object" || result === null)
      throw { kind: "malformed", reason: "missing result" };

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // Frozen listTools: ≤10 pages, each cursor fed back until the server
    // stops handing one out; a malformed page fails the probe.
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIST_TOOLS_MAX_PAGES; page++) {
      const reply = await request("tools/list", cursor ? { cursor } : {}, remaining());
      if (reply.error) throw { kind: "malformed", reason: reply.error.message ?? "tools/list failed" };
      const list = (reply.result as { tools?: unknown; nextCursor?: unknown } | undefined)?.tools;
      if (!Array.isArray(list)) throw { kind: "malformed", reason: "invalid tool list" };
      for (const item of list) {
        if (
          typeof item !== "object" || item === null ||
          typeof (item as { name?: unknown }).name !== "string" ||
          typeof (item as { inputSchema?: unknown }).inputSchema !== "object" ||
          ((item as { description?: unknown }).description !== undefined &&
            typeof (item as { description?: unknown }).description !== "string")
        ) {
          throw { kind: "malformed", reason: "invalid tool list" };
        }
        const t = item as { name: string; description?: string };
        tools.push(t.description !== undefined ? { name: t.name, description: t.description } : { name: t.name });
      }
      const next = (reply.result as { nextCursor?: unknown } | undefined)?.nextCursor;
      // Frozen: absent or empty stops paging; a present non-string
      // cursor is a malformed reply.
      if (next === undefined || next === null || next === "") break;
      if (typeof next !== "string") throw { kind: "malformed", reason: "invalid tool list" };
      cursor = next;
    }

    return {
      status: "connected",
      ...(result.serverInfo?.name !== undefined ? { serverName: result.serverInfo.name } : {}),
      ...(result.serverInfo?.version !== undefined
        ? { serverVersion: result.serverInfo.version }
        : {}),
      tools,
    };
  } catch (err) {
    const e = err as { kind?: string; code?: number | null; reason?: string };
    if (e?.kind === "timedOut")
      return { status: "timedOut", reason: "The server didn't answer in time." };
    if (e?.kind === "malformed") return { status: "malformed", reason: e.reason ?? "bad reply" };
    if (spawnErr && /ENOENT/.test(spawnErr.message))
      return { status: "missing", reason: `${server.command} isn't installed.` };
    if (exited !== "alive" || e?.kind === "exited") {
      const code = e?.kind === "exited" ? (e.code ?? null) : exited === "alive" ? null : exited;
      return { status: "exited", code, stderr: stderrTail };
    }
    return { status: "error", reason: (err as Error)?.message ?? String(err) };
  } finally {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ error: { message: "probe finished" } });
    }
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ---------------------------------------------------------------------------
// F18 second slice: streamable-HTTP transport (spec 2025-06-18 POST path).
// Each RPC is a POST carrying Accept: application/json + text/event-stream;
// the reply may be a bare JSON body, an SSE frame set, or 202 for a
// notification. Mcp-Session-Id rides subsequent POSTs and a best-effort
// DELETE closes the session. No OAuth, no GET stream, no resumability —
// a probe is a bounded handshake, never a kept connection.

interface RpcEnvelope {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
}

/** First JSON-RPC reply found in an SSE body — data: lines only. */
function sseFirstMessage(body: string): RpcEnvelope | null {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const m = JSON.parse(line.slice(5).trim()) as RpcEnvelope;
      if (m && (m.id !== undefined || m.method !== undefined)) return m;
    } catch {
      /* partial frame — keep scanning */
    }
  }
  return null;
}

async function probeHttpServer(
  server: Pick<McpServerConfig, "url" | "headers">,
  timeoutMs: number,
): Promise<McpProbeResult> {
  const raw = (server.url ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  } catch {
    return { status: "missing", reason: "A streamable-HTTP server needs an http(s) URL." };
  }
  const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
  let sessionId: string | null = null;
  const post = async (msg: object): Promise<{ reply: RpcEnvelope | null; http: number }> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        // Catalog-configured headers first, like the frozen MCPWire.post:
        // the protocol's own fields always win over a stored override.
        ...(server.headers ?? {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(msg),
      signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!res.ok) {
      // Drain so keep-alive sockets don't pin the loop; the status is
      // the answer.
      await res.arrayBuffer().catch(() => {});
      return { reply: null, http: res.status };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const body = await res.text();
      return { reply: sseFirstMessage(body), http: res.status };
    }
    if (ct.includes("application/json")) {
      try {
        return { reply: (await res.json()) as RpcEnvelope, http: res.status };
      } catch {
        throw { kind: "malformed", reason: "invalid JSON body" };
      }
    }
    // 202/204 — notifications and servers that answer "nothing to say".
    return { reply: null, http: res.status };
  };
  const request = async (method: string, params?: object): Promise<RpcEnvelope> => {
    const { reply, http } = await post({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    });
    if (!reply) {
      throw {
        kind: http >= 400 ? "http" : "malformed",
        http,
        reason: `HTTP ${http} — no JSON-RPC reply`,
      };
    }
    return reply;
  };
  try {
    const init = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    });
    if (init.error)
      throw { kind: "malformed", reason: init.error.message ?? "initialize failed" };
    const result = init.result as
      | { serverInfo?: { name?: string; version?: string } }
      | undefined;
    if (typeof result !== "object" || result === null)
      throw { kind: "malformed", reason: "missing result" };

    await post({ jsonrpc: "2.0", method: "notifications/initialized" });

    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIST_TOOLS_MAX_PAGES; page++) {
      const reply = await request("tools/list", cursor ? { cursor } : {});
      if (reply.error)
        throw { kind: "malformed", reason: reply.error.message ?? "tools/list failed" };
      const list = (reply.result as { tools?: unknown } | undefined)?.tools;
      if (!Array.isArray(list)) throw { kind: "malformed", reason: "invalid tool list" };
      for (const item of list) {
        if (
          typeof item !== "object" ||
          item === null ||
          typeof (item as { name?: unknown }).name !== "string" ||
          typeof (item as { inputSchema?: unknown }).inputSchema !== "object" ||
          ((item as { description?: unknown }).description !== undefined &&
            typeof (item as { description?: unknown }).description !== "string")
        ) {
          throw { kind: "malformed", reason: "invalid tool list" };
        }
        const t = item as { name: string; description?: string };
        tools.push(
          t.description !== undefined ? { name: t.name, description: t.description } : { name: t.name },
        );
      }
      const next = (reply.result as { nextCursor?: unknown } | undefined)?.nextCursor;
      if (next === undefined || next === null || next === "") break;
      if (typeof next !== "string") throw { kind: "malformed", reason: "invalid tool list" };
      cursor = next;
    }
    return {
      status: "connected",
      ...(result.serverInfo?.name !== undefined ? { serverName: result.serverInfo.name } : {}),
      ...(result.serverInfo?.version !== undefined
        ? { serverVersion: result.serverInfo.version }
        : {}),
      tools,
    };
  } catch (err) {
    const e = err as { kind?: string; http?: number; reason?: string };
    if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
      return { status: "timedOut", reason: "The server didn't answer in time." };
    }
    if (e?.kind === "malformed") return { status: "malformed", reason: e.reason ?? "bad reply" };
    if (e?.kind === "http")
      return { status: "error", reason: `The endpoint answered HTTP ${e.http}.` };
    return { status: "error", reason: (err as Error)?.message ?? String(err) };
  } finally {
    if (sessionId) {
      try {
        await fetch(url, {
          method: "DELETE",
          headers: { "mcp-session-id": sessionId },
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        /* session cleanup is best-effort */
      }
    }
  }
}
