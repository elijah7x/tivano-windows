// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18 bounded slice: local MCP servers over stdio. Config shape +
// probe wire constants mirror the frozen MCPStore/MCPProbe; streamable
// HTTP and OAuth are OUT of this slice (marked unavailable, never
// fabricated). Probing spawns the REAL command and runs real JSON-RPC —
// a checked server lists the tools it actually reported.

/** Frozen server entry — stdio + streamable-HTTP transports in this
 *  slice (OAuth/session resumption still out, marked honestly). */
export interface McpServerConfig {
  id: string;
  name: string;
  /** Absent = "stdio" — the frozen default. */
  transport?: "stdio" | "http" | undefined;
  /** Executable resolved against the login environment at probe time.
   *  Empty for HTTP entries. */
  command: string;
  args: string[];
  /** Extra environment merged over the inherited process env. Values
   *  persist PLAINTEXT in the local store — the frozen build splits
   *  secrets into Keychain; that layer is out of this slice. */
  env?: Record<string, string> | undefined;
  /** HTTP transport endpoint — http(s) POST URL. */
  url?: string | undefined;
  /** A73 catalog: extra request headers for an HTTP server (e.g. an
   *  Authorization bearer resolved from a catalog field). Plaintext in
   *  the local store, same caveat as `env`. */
  headers?: Record<string, string> | undefined;
}

/** Frozen MCPProbeResult — what a live probe reported. */
export interface McpToolInfo {
  name: string;
  description?: string | undefined;
}
export interface McpProbeOk {
  status: "connected";
  serverName?: string | undefined;
  serverVersion?: string | undefined;
  tools: McpToolInfo[];
}
export type McpProbeResult =
  | McpProbeOk
  | { status: "missing"; reason: string }
  | { status: "exited"; code: number | null; stderr: string }
  | { status: "timedOut"; reason: string }
  | { status: "malformed"; reason: string }
  | { status: "error"; reason: string };

/** Frozen MCPWire constants — newline-framed JSON-RPC 2.0 over stdio. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_CLIENT_INFO = { name: "Tivano", version: "1.0" };
export const MCP_LIST_TOOLS_MAX_PAGES = 10;
export const MCP_PROBE_TIMEOUT_MS = 90_000;

export const MCP_MAX_SERVERS = 32;
export const MCP_MAX_ARGS = 64;
export const MCP_MAX_ENV = 64;

/** Frozen MCPProviderConfig.codex: the Settings-connected servers as a
 *  codex `config.mcp_servers` object, keyed by server name. A name the
 *  provider could not read as a plain key — whitespace or config-syntax
 *  characters — skips the entry entirely rather than minting a broken
 *  patch that makes codex reject its whole configuration. HTTP entries
 *  emit `http_headers` (frozen MCPProviderConfig.codex) when headers are
 *  configured — an all-empty header map is dropped like an empty env. */
export function codexMcpServers(
  servers: readonly McpServerConfig[],
): Record<string, Record<string, unknown>> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    const key = s.name.trim();
    if (!key || /[\s\[\]'",.]/.test(key) || out[key] !== undefined) continue;
    if (s.transport === "http") {
      const url = s.url?.trim();
      if (!url) continue;
      const entry: Record<string, unknown> = { url };
      const headers = Object.entries(s.headers ?? {}).filter(([, v]) => v !== "");
      if (headers.length) entry.http_headers = Object.fromEntries(headers);
      out[key] = entry;
    } else {
      const command = s.command.trim();
      if (!command) continue;
      const entry: Record<string, unknown> = {
        command,
        args: s.args.filter((a) => typeof a === "string"),
      };
      const env = s.env ?? {};
      const envEntries = Object.entries(env).filter(([, v]) => v !== "");
      if (envEntries.length) entry.env = Object.fromEntries(envEntries);
      out[key] = entry;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
