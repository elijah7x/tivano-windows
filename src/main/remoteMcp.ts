// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-25: Remote MCP — Streamable HTTP MCP + OAuth 2.1 authorization server
// listening strictly on 127.0.0.1 outside Alpha, placed under Connections.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Engine } from "./engine";
import { ControlFailure, type LocalControlService } from "./localControl";
import { mainT } from "./mainStrings";
import type {
  LanguageId,
  RemoteMcpApprovalRequest,
  RemoteMcpGrantView,
  RemoteMcpScope,
  RemoteMcpStatus,
} from "../shared/types";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const SERVER_NAME = "tivano";
const MCP_PATH = "/mcp";
const MAX_HEAD = 32_768;
const MAX_BODY = 262_144;
const MAX_METADATA_BYTES = 65_536;
const MAX_TEXT = 65_536;
const MAX_CONNECTIONS = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const AUTH_CODE_TTL_MS = 60_000;
const APPROVAL_TTL_MS = 300_000;
const MAX_CLIENTS = 64;
const MAX_PENDING_APPROVALS = 4;
const MAX_SESSIONS = 64;
const ALL_SCOPES: readonly RemoteMcpScope[] = ["tivano.read", "tivano.write"];
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

/** HTTPS with a host and no query/fragment/credentials; HTTP allowed for loopback only. */
export function normalizedPublicUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (!u.hostname || u.search || u.hash || u.username || u.password) return null;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname)))
    return null;
  return trimmed.replace(/\/+$/, "");
}

export function remoteMcpBaseUrl(publicUrl: string | undefined, port: number): string {
  return (publicUrl ? normalizedPublicUrl(publicUrl) : null) ?? `http://127.0.0.1:${port}`;
}

function parseScopes(text: string | undefined): Set<RemoteMcpScope> {
  const out = new Set<RemoteMcpScope>();
  for (const part of (text ?? "").split(/\s+/)) {
    if (part === "tivano.read" || part === "tivano.write") out.add(part);
  }
  return out;
}

function formatScopes(scopes: Iterable<RemoteMcpScope>): string {
  const set = new Set(scopes);
  return ALL_SCOPES.filter((s) => set.has(s)).join(" ");
}

const sha256Hex = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const isUuid = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(title: string, content: string, refresh = false, lang: LanguageId = "en"): HttpReply {
  const body =
    `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    (refresh ? `<meta http-equiv="refresh" content="2">` : "") +
    `<title>${escapeHtml(title)}</title><style>` +
    `:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#202020}main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.6rem}p{line-height:1.6}strong{display:block;font-size:2.4rem;letter-spacing:.15em;margin:1.5rem 0}@media(prefers-color-scheme:dark){body{background:#181818;color:#eee}}` +
    `</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
    body,
  };
}

interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

interface HttpReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const jsonReply = (data: unknown, status = 200, headers: Record<string, string> = {}): HttpReply => ({
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  body: JSON.stringify(data),
});

const oauthErr = (code: string, desc?: string, status = 400): HttpReply =>
  jsonReply(desc ? { error: code, error_description: desc } : { error: code }, status);

interface StoredClient {
  id: string;
  name: string;
  redirectURIs: string[];
  source: "registered" | "metadataDocument";
  createdAt: number;
}

interface StoredGrant {
  id: string;
  clientId: string;
  clientName: string;
  scopes: RemoteMcpScope[];
  createdAt: number;
  lastUsedAt?: number;
  refreshTokenHash: string;
  refreshExpiresAt: number;
}

interface PersistedState {
  clients: StoredClient[];
  grants: StoredGrant[];
}

interface PendingEntry {
  approval: RemoteMcpApprovalRequest;
  client: StoredClient;
  redirect: string;
  state: string | null;
  challenge: string;
  resource: string;
  issuer: string;
  decision?: { kind: "full" | "read" | "deny" };
}

interface CodeEntry {
  pending: PendingEntry;
  scopes: RemoteMcpScope[];
  expiresAt: number;
}

interface AccessEntry {
  grantId: string;
  scopes: Set<RemoteMcpScope>;
  resource: string;
  expiresAt: number;
}

export interface RemoteMcpAccess {
  grantId: string;
  clientName: string;
  scopes: Set<RemoteMcpScope>;
}

function isPublicAddress(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    isLoopbackHost(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".")
  )
    return false;
  const ver = isIP(host);
  if (ver === 4) {
    const parts = host.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (ver === 6) {
    const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
    if (v4Mapped?.[1]) return isPublicAddress(v4Mapped[1]);
    // Global unicast IPv6 is 2000::/3 (first hex digit 2 or 3).
    return /^[23][0-9a-f]{0,3}:/i.test(host);
  }
  return !host.includes(":") && !host.includes("%");
}

async function resolvesOnlyPublic(host: string): Promise<boolean> {
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

function isValidRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return isLoopbackHost(u.hostname);
  const scheme = u.protocol.replace(/:$/, "");
  return !["javascript", "data", "file"].includes(scheme);
}

/** OAuth 2.1 authorization authority + persisted grant store (`remote-mcp.json`). */
export class RemoteMcpAuthority {
  private readonly statePath: string;
  private state: PersistedState = { clients: [], grants: [] };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private base = "";
  private pending = new Map<string, PendingEntry>();
  private codes = new Map<string, CodeEntry>();
  private accessTokens = new Map<string, AccessEntry>();
  private metadataCache = new Map<string, { client: StoredClient; expiresAt: number }>();
  private lastUsagePersisted = 0;

  constructor(
    dataRoot: string,
    private readonly onChanged: () => void,
    private readonly getLanguage: () => LanguageId = () => "en",
    opts?: { deferLoad?: boolean },
  ) {
    this.statePath = join(dataRoot, "remote-mcp.json");
    if (!opts?.deferLoad) {
      this.state = this.loadState();
      this.loaded = true;
    }
  }

  /** P2-74: load persisted OAuth grants/clients off the critical startup path. */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadStateAsync().then((loaded) => {
      if (!this.loaded) {
        this.state = loaded;
        this.loaded = true;
      }
    });
    return this.loadPromise;
  }

  private get resourceUrl(): string {
    return this.base + MCP_PATH;
  }

  setBaseUrl(base: string): void {
    this.base = base;
  }

  pendingApprovals(): RemoteMcpApprovalRequest[] {
    this.expirePending();
    return [...this.pending.values()]
      .filter((p) => !p.decision)
      .map((p) => p.approval)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  grants(): RemoteMcpGrantView[] {
    return this.state.grants.map((g) => ({
      id: g.id,
      clientId: g.clientId,
      clientName: g.clientName,
      scopes: [...g.scopes],
      createdAt: g.createdAt,
      ...(g.lastUsedAt !== undefined ? { lastUsedAt: g.lastUsedAt } : {}),
    }));
  }

  decide(id: string, decision: "full" | "read" | "deny"): void {
    this.expirePending();
    const entry = this.pending.get(id);
    if (!entry || entry.decision) return;
    entry.decision = { kind: decision };
    this.onChanged();
  }

  revoke(grantId: string): void {
    this.state.grants = this.state.grants.filter((g) => g.id !== grantId);
    for (const [k, v] of this.accessTokens) {
      if (v.grantId === grantId) this.accessTokens.delete(k);
    }
    this.persist();
    this.onChanged();
  }

  revokeAll(): void {
    this.state.grants = [];
    this.accessTokens.clear();
    this.codes.clear();
    this.cancelPending();
    this.persist();
    this.onChanged();
  }

  cancelPending(): void {
    let changed = false;
    for (const entry of this.pending.values()) {
      if (!entry.decision) {
        entry.decision = { kind: "deny" };
        changed = true;
      }
    }
    if (changed) this.onChanged();
  }

  authenticate(req: HttpRequest): RemoteMcpAccess | null {
    const auth = req.headers["authorization"];
    if (!auth) return null;
    const m = /^Bearer[ \t]+(\S+)$/i.exec(auth.trim());
    if (!m?.[1]) return null;
    const tok = this.accessTokens.get(sha256Hex(m[1]));
    const now = Date.now();
    if (!tok || tok.expiresAt <= now || tok.resource !== this.resourceUrl) return null;
    const grant = this.state.grants.find((g) => g.id === tok.grantId);
    if (!grant) return null;
    grant.lastUsedAt = now;
    if (now - this.lastUsagePersisted >= 60_000) {
      this.persist();
      this.lastUsagePersisted = now;
      this.onChanged();
    }
    return { grantId: tok.grantId, clientName: grant.clientName, scopes: tok.scopes };
  }

  unauthorized(): HttpReply {
    return jsonReply({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp", scope="tivano.read tivano.write"`,
    });
  }

  async handle(req: HttpRequest): Promise<HttpReply | null> {
    switch (req.path) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        if (req.method !== "GET") return { status: 405, headers: { Allow: "GET" } };
        return jsonReply({
          resource: this.resourceUrl,
          authorization_servers: [this.base],
          scopes_supported: [...ALL_SCOPES],
          bearer_methods_supported: ["header"],
          resource_name: "Tivano",
        });
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/oauth-authorization-server/mcp":
      case "/.well-known/openid-configuration":
        if (req.method !== "GET") return { status: 405, headers: { Allow: "GET" } };
        return jsonReply({
          issuer: this.base,
          authorization_endpoint: `${this.base}/oauth/authorize`,
          token_endpoint: `${this.base}/oauth/token`,
          registration_endpoint: `${this.base}/oauth/register`,
          revocation_endpoint: `${this.base}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: [...ALL_SCOPES],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      case "/oauth/register":
        if (req.method !== "POST") return { status: 405, headers: { Allow: "POST" } };
        return this.register(req);
      case "/oauth/authorize":
        if (req.method !== "GET") return { status: 405, headers: { Allow: "GET" } };
        return this.authorize(req);
      case "/oauth/authorize/pending":
        if (req.method !== "GET") return { status: 405, headers: { Allow: "GET" } };
        return this.poll(req);
      case "/oauth/token":
        if (req.method !== "POST") return { status: 405, headers: { Allow: "POST" } };
        return this.token(new URLSearchParams(req.body.toString("utf8")));
      case "/oauth/revoke": {
        if (req.method !== "POST") return { status: 405, headers: { Allow: "POST" } };
        const form = new URLSearchParams(req.body.toString("utf8"));
        const tok = form.get("token");
        if (tok) {
          const hash = sha256Hex(tok);
          const grant = this.state.grants.find((g) => g.refreshTokenHash === hash);
          if (grant) this.revoke(grant.id);
          else this.accessTokens.delete(hash);
        }
        return { status: 200 };
      }
      default:
        return null;
    }
  }

  private register(req: HttpRequest): HttpReply {
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(req.body.toString("utf8"));
      if (typeof obj !== "object" || obj === null || Array.isArray(obj))
        return oauthErr("invalid_client_metadata");
      parsed = obj as Record<string, unknown>;
    } catch {
      return oauthErr("invalid_client_metadata");
    }
    const redirects = parsed["redirect_uris"];
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      !redirects.every((r): r is string => typeof r === "string" && isValidRedirect(r))
    ) {
      return oauthErr("invalid_client_metadata");
    }
    if (this.state.clients.length >= MAX_CLIENTS) {
      const ungranted = this.state.clients
        .filter((c) => !this.state.grants.some((g) => g.clientId === c.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!ungranted[0]) return oauthErr("invalid_client_metadata");
      this.state.clients = this.state.clients.filter((c) => c.id !== ungranted[0]!.id);
    }
    const client: StoredClient = {
      id: "tvn_" + randomBytes(16).toString("hex"),
      name: clientName(parsed["client_name"]),
      redirectURIs: redirects,
      source: "registered",
      createdAt: Date.now(),
    };
    this.state.clients.push(client);
    this.persist();
    return jsonReply(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectURIs,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  private async authorize(req: HttpRequest): Promise<HttpReply> {
    const q = req.query;
    const id = q.get("client_id");
    const redirect = q.get("redirect_uri");
    const client = id ? await this.resolveClient(id) : null;
    if (!client || !redirect || !client.redirectURIs.includes(redirect))
      return this.invalidPage();
    const state = q.get("state");
    const errRedir = (code: string) => this.redirectWith(redirect, { error: code }, state, this.base);
    const challenge = q.get("code_challenge");
    if (
      q.get("response_type") !== "code" ||
      !challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      q.get("code_challenge_method") !== "S256"
    ) {
      return errRedir("invalid_request");
    }
    const target = q.get("resource");
    if (target !== null && target !== this.resourceUrl) return errRedir("invalid_target");
    this.expirePending();
    if ([...this.pending.values()].filter((p) => !p.decision).length >= MAX_PENDING_APPROVALS) {
      const lang = this.getLanguage();
      return {
        ...htmlPage(
          mainT(lang, "Too many requests waiting"),
          `<p>${escapeHtml(mainT(lang, "Approve or deny the requests already waiting in Tivano, then try again."))}</p>`,
          false,
          lang,
        ),
        status: 429,
      };
    }
    const bytes = randomBytes(6);
    const rawCode = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const code = `${rawCode.slice(0, 3)}-${rawCode.slice(3)}`;
    const requested = q.has("scope") ? parseScopes(q.get("scope") ?? "") : new Set(ALL_SCOPES);
    requested.add("tivano.read");
    let redirectHost = "";
    try {
      const u = new URL(redirect);
      redirectHost = u.hostname || u.protocol.replace(/:$/, "");
    } catch {
      redirectHost = "";
    }
    const approval: RemoteMcpApprovalRequest = {
      id: randomUUID(),
      clientName: client.name,
      clientId: client.id,
      redirectHost,
      requestedScopes: ALL_SCOPES.filter((s) => requested.has(s)),
      code,
      createdAt: Date.now(),
    };
    this.pending.set(approval.id, {
      approval,
      client,
      redirect,
      state,
      challenge,
      resource: this.resourceUrl,
      issuer: this.base,
    });
    this.onChanged();
    return {
      status: 302,
      headers: {
        Location: `${this.base}/oauth/authorize/pending?request=${approval.id}`,
        "Cache-Control": "no-store",
      },
    };
  }

  private poll(req: HttpRequest): HttpReply {
    this.expirePending();
    const id = req.query.get("request");
    const entry = id ? this.pending.get(id) : undefined;
    const lang = this.getLanguage();
    if (!entry) {
      return {
        ...htmlPage(
          mainT(lang, "Request expired"),
          `<p>${escapeHtml(mainT(lang, "Start the connection again from your agent."))}</p>`,
          false,
          lang,
        ),
        status: 404,
      };
    }
    if (!entry.decision) {
      const title = mainT(lang, "Approve on your computer");
      const msg = mainT(
        lang,
        "Tivano is waiting for you to approve %@ on your computer. Check that Tivano shows this code:",
        [entry.client.name],
      );
      const footer = mainT(
        lang,
        "This page refreshes by itself. You can close it after your agent says it is connected.",
      );
      return htmlPage(
        title,
        `<p>${escapeHtml(msg)}</p><strong>${escapeHtml(entry.approval.code)}</strong><p>${escapeHtml(footer)}</p>`,
        true,
        lang,
      );
    }
    this.pending.delete(id!);
    if (entry.decision.kind === "deny") {
      this.onChanged();
      return this.redirectWith(entry.redirect, { error: "access_denied" }, entry.state, entry.issuer);
    }
    const allowed: RemoteMcpScope[] =
      entry.decision.kind === "full" ? [...entry.approval.requestedScopes] : ["tivano.read"];
    if (!allowed.includes("tivano.read")) allowed.unshift("tivano.read");
    const authCode = base64Url(randomBytes(32));
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    this.codes.set(sha256Hex(authCode), {
      pending: entry,
      scopes: allowed,
      expiresAt: now + AUTH_CODE_TTL_MS,
    });
    this.onChanged();
    return this.redirectWith(entry.redirect, { code: authCode }, entry.state, entry.issuer);
  }

  private token(form: URLSearchParams): HttpReply {
    const grantType = form.get("grant_type");
    const now = Date.now();
    if (grantType === "authorization_code") {
      const rawCode = form.get("code");
      const consumed = rawCode ? this.codes.get(sha256Hex(rawCode)) : undefined;
      if (rawCode) this.codes.delete(sha256Hex(rawCode));
      const clientId = form.get("client_id");
      const redirect = form.get("redirect_uri");
      const verifier = form.get("code_verifier");
      if (!rawCode || !clientId || !redirect || !verifier) return oauthErr("invalid_request");
      const target = form.get("resource");
      if (
        !consumed ||
        consumed.expiresAt <= now ||
        consumed.pending.client.id !== clientId ||
        consumed.pending.redirect !== redirect ||
        consumed.pending.resource !== this.resourceUrl ||
        (target !== null && target !== consumed.pending.resource) ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        base64Url(createHash("sha256").update(verifier, "utf8").digest()) !==
          consumed.pending.challenge
      ) {
        return oauthErr("invalid_grant");
      }
      const refreshText = base64Url(randomBytes(32));
      const grant: StoredGrant = {
        id: randomUUID(),
        clientId,
        clientName: consumed.pending.client.name,
        scopes: consumed.scopes,
        createdAt: now,
        refreshTokenHash: sha256Hex(refreshText),
        refreshExpiresAt: now + REFRESH_TTL_MS,
      };
      this.state.grants.push(grant);
      this.persist();
      this.onChanged();
      return this.issueToken(refreshText, grant);
    }
    if (grantType === "refresh_token") {
      const refresh = form.get("refresh_token");
      const clientId = form.get("client_id");
      if (!refresh || !clientId) return oauthErr("invalid_request");
      const hash = sha256Hex(refresh);
      const grant = this.state.grants.find(
        (g) => g.refreshTokenHash === hash && g.clientId === clientId,
      );
      if (!grant) return oauthErr("invalid_grant");
      if (grant.refreshExpiresAt <= now) {
        this.revoke(grant.id);
        return oauthErr("invalid_grant");
      }
      const target = form.get("resource");
      if (target !== null && target !== this.resourceUrl) return oauthErr("invalid_grant");
      if (form.has("scope")) {
        const rawScope = form.get("scope") ?? "";
        const parts = rawScope.split(/\s+/).filter(Boolean);
        const granted = new Set<string>(grant.scopes);
        if (parts.length === 0 || !parts.every((p) => granted.has(p)))
          return oauthErr("invalid_request");
        const scoped = ALL_SCOPES.filter((s) => parts.includes(s));
        const nextRefresh = base64Url(randomBytes(32));
        grant.refreshTokenHash = sha256Hex(nextRefresh);
        grant.refreshExpiresAt = now + REFRESH_TTL_MS;
        grant.lastUsedAt = now;
        this.persist();
        this.onChanged();
        return this.issueToken(nextRefresh, grant, scoped);
      }
      const nextRefresh = base64Url(randomBytes(32));
      grant.refreshTokenHash = sha256Hex(nextRefresh);
      grant.refreshExpiresAt = now + REFRESH_TTL_MS;
      grant.lastUsedAt = now;
      this.persist();
      this.onChanged();
      return this.issueToken(nextRefresh, grant);
    }
    return grantType === null ? oauthErr("invalid_request") : oauthErr("unsupported_grant_type");
  }

  private issueToken(
    refreshText: string,
    grant: StoredGrant,
    scopes: RemoteMcpScope[] = grant.scopes,
  ): HttpReply {
    const now = Date.now();
    for (const [k, v] of this.accessTokens) if (v.expiresAt <= now) this.accessTokens.delete(k);
    const accessText = base64Url(randomBytes(32));
    this.accessTokens.set(sha256Hex(accessText), {
      grantId: grant.id,
      scopes: new Set(scopes),
      resource: this.resourceUrl,
      expiresAt: now + ACCESS_TTL_MS,
    });
    return jsonReply({
      access_token: accessText,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshText,
      scope: formatScopes(scopes),
    });
  }

  private async resolveClient(id: string): Promise<StoredClient | null> {
    const reg = this.state.clients.find((c) => c.id === id);
    if (reg) return reg;
    const cached = this.metadataCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.client;
    let u: URL;
    try {
      u = new URL(id);
    } catch {
      return null;
    }
    if (
      u.protocol !== "https:" ||
      !u.hostname ||
      !u.pathname ||
      u.hash ||
      u.username ||
      u.password ||
      !isPublicAddress(u.hostname)
    )
      return null;
    if (!(await resolvesOnlyPublic(u.hostname))) return null;
    try {
      const res = await fetch(u, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (res.status !== 200) return null;
      const buf = await readBoundedBody(res, MAX_METADATA_BYTES);
      if (!buf) return null;
      const obj = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
      const redirects = obj["redirect_uris"];
      if (
        obj["client_id"] !== id ||
        !Array.isArray(redirects) ||
        redirects.length === 0 ||
        !redirects.every((r): r is string => typeof r === "string" && isValidRedirect(r))
      )
        return null;
      const now = Date.now();
      for (const [k, v] of this.metadataCache) {
        if (v.expiresAt <= now) this.metadataCache.delete(k);
      }
      while (this.metadataCache.size >= MAX_CLIENTS) {
        const oldest = this.metadataCache.keys().next().value;
        if (!oldest) break;
        this.metadataCache.delete(oldest);
      }
      const client: StoredClient = {
        id,
        name: clientName(obj["client_name"]),
        redirectURIs: redirects,
        source: "metadataDocument",
        createdAt: now,
      };
      this.metadataCache.set(id, { client, expiresAt: now + 600_000 });
      return client;
    } catch {
      return null;
    }
  }

  private redirectWith(
    uri: string,
    params: Record<string, string>,
    state: string | null,
    issuer: string,
  ): HttpReply {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return this.invalidPage();
    }
    for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
    if (state !== null) u.searchParams.append("state", state);
    u.searchParams.append("iss", issuer);
    return { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } };
  }

  private invalidPage(): HttpReply {
    const lang = this.getLanguage();
    return {
      ...htmlPage(
        mainT(lang, "Connection request not valid"),
        `<p>${escapeHtml(mainT(lang, "This client or its return address is not registered with Tivano."))}</p>`,
        false,
        lang,
      ),
      status: 400,
    };
  }

  private expirePending(): void {
    const now = Date.now();
    let dropped = false;
    for (const [k, v] of this.pending) {
      if (now - v.approval.createdAt > APPROVAL_TTL_MS) {
        this.pending.delete(k);
        dropped = true;
      }
    }
    if (dropped) this.onChanged();
  }

  private parseStateText(raw: string): PersistedState | null {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray(parsed.clients) &&
        Array.isArray(parsed.grants)
      ) {
        return { clients: parsed.clients, grants: parsed.grants };
      }
    } catch {
      /* invalid JSON */
    }
    return null;
  }

  private loadState(): PersistedState {
    try {
      const parsed = this.parseStateText(readFileSync(this.statePath, "utf8"));
      if (parsed) return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { clients: [], grants: [] };
    }
    try {
      renameSync(this.statePath, `${this.statePath}.${randomUUID()}.corrupt`);
    } catch {
      /* leave untouched if quarantine rename fails */
    }
    return { clients: [], grants: [] };
  }

  private async loadStateAsync(): Promise<PersistedState> {
    try {
      const parsed = this.parseStateText(await readFile(this.statePath, "utf8"));
      if (parsed) return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { clients: [], grants: [] };
    }
    try {
      await rename(this.statePath, `${this.statePath}.${randomUUID()}.corrupt`);
    } catch {
      /* leave untouched if quarantine rename fails */
    }
    return { clients: [], grants: [] };
  }

  private persist(): void {
    const tmp = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}

function clientName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 100) : "MCP client";
}

const INSTRUCTIONS =
  "Approvals and questions wait in the Tivano app; the owner may let threads created here run in Full access without approvals. When get_thread shows waitingForUI, the owner must act in Tivano. Writes return an operation ticket to poll with get_operation and get_history. 'completed' means the provider reported completion, not that the task is correct. Standalone means no project. Do not blindly retry writes after a disconnect.";

interface ToolDef {
  name: string;
  description: string;
  scope: RemoteMcpScope;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: "tivano_info",
    description: "Read Tivano instance and control limits. " + INSTRUCTIONS,
    scope: "tivano.read",
    properties: {},
    required: [],
  },
  {
    name: "list_providers",
    description:
      "List cached provider availability and supported models; does not refresh or log in.",
    scope: "tivano.read",
    properties: {},
    required: [],
  },
  {
    name: "list_projects",
    description: "List projects with cursor pagination.",
    scope: "tivano.read",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      cursor: { type: "string" },
    },
    required: [],
  },
  {
    name: "list_threads",
    description: "List thread metadata. Search matches titles only. Standalone means no project.",
    scope: "tivano.read",
    properties: {
      archive: { type: "string", enum: ["active", "archived", "all"], default: "active" },
      role: { type: "string", enum: ["normal", "helper", "head", "all"], default: "normal" },
      affiliation: {
        type: "string",
        enum: ["all", "standalone", "project", "missing_project"],
        default: "all",
      },
      project_id: { type: "string", format: "uuid" },
      search: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      cursor: { type: "string" },
    },
    required: [],
  },
  {
    name: "get_thread",
    description: "Read a thread's metadata, workspace and current status.",
    scope: "tivano.read",
    properties: { thread_id: { type: "string", format: "uuid" } },
    required: ["thread_id"],
  },
  {
    name: "get_history",
    description:
      "Read persisted history excerpts. 'completed' means the provider reported completion, not that the task is correct.",
    scope: "tivano.read",
    properties: {
      thread_id: { type: "string", format: "uuid" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
      cursor: { type: "string" },
    },
    required: ["thread_id"],
  },
  {
    name: "get_operation",
    description:
      "Poll a write's operation ticket. Approvals and questions wait in the Tivano app. 'completed' means the provider reported completion, not that the task is correct.",
    scope: "tivano.read",
    properties: { ticket: { type: "string" } },
    required: ["ticket"],
  },
  {
    name: "create_thread",
    description: "Create a supervised thread. Omit project_id for standalone (no project). " + INSTRUCTIONS,
    scope: "tivano.write",
    properties: {
      project_id: { type: "string", format: "uuid" },
      workspace: { type: "string", enum: ["local", "worktree"] },
      provider: { type: "string" },
      model: { type: "string" },
      hydra: { type: "boolean" },
    },
    required: ["workspace", "provider"],
  },
  {
    name: "send_message",
    description: "Send text to an eligible idle thread; no attachments or slash commands. " + INSTRUCTIONS,
    scope: "tivano.write",
    properties: {
      thread_id: { type: "string", format: "uuid" },
      text: { type: "string", description: `At most ${MAX_TEXT} UTF-8 bytes.` },
      continuation: {
        type: "string",
        enum: ["automatic", "fresh", "providerSession", "transcript"],
        default: "automatic",
      },
    },
    required: ["thread_id", "text"],
  },
  {
    name: "interrupt_turn",
    description:
      "Request interruption of the exact turn. Acceptance does not mean the provider stopped. " +
      INSTRUCTIONS,
    scope: "tivano.write",
    properties: {
      thread_id: { type: "string", format: "uuid" },
      turn_id: { type: "string", format: "uuid" },
    },
    required: ["thread_id", "turn_id"],
  },
];

function validateArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of tool.required) {
    if (args[key] === undefined) return `Missing ${key}`;
  }
  for (const [key, val] of Object.entries(args)) {
    const schema = tool.properties[key];
    if (!schema) return `Unknown argument: ${key}`;
    if (schema["type"] === "integer") {
      const min = (schema["minimum"] as number | undefined) ?? 1;
      const max = (schema["maximum"] as number | undefined) ?? 100;
      if (typeof val !== "number" || !Number.isInteger(val) || val < min || val > max)
        return `${key} must be an integer in the allowed range`;
    } else if (schema["type"] === "boolean") {
      if (typeof val !== "boolean") return `${key} must be a boolean`;
    } else {
      if (typeof val !== "string") return `${key} must be a string`;
      const enums = schema["enum"] as string[] | undefined;
      if (enums && !enums.includes(val)) return `Invalid ${key}`;
      if (schema["format"] === "uuid" && !isUuid(val)) return `${key} must be a UUID`;
    }
  }
  return null;
}

const toolErr = (code: string, detail: string, prefix = true) => ({
  content: [{ type: "text", text: prefix ? `${code}: ${detail}` : detail }],
  structuredContent: { error: code, detail },
  isError: true,
});

const rpcReply = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
  jsonReply({ jsonrpc: "2.0", id, result }, 200, headers);

const rpcErr = (code: number, message: string, id: unknown = null) =>
  jsonReply({ jsonrpc: "2.0", id, error: { code, message } });

/** Streamable HTTP MCP endpoint (`/mcp`). */
export class RemoteMcpEndpoint {
  private sessions = new Map<string, string>();

  constructor(
    private readonly localControl: LocalControlService,
    private readonly appVersion: string,
  ) {}

  async handle(req: HttpRequest, access: RemoteMcpAccess): Promise<HttpReply> {
    if (req.method !== "POST" && req.method !== "DELETE")
      return { status: 405, headers: { Allow: "POST, DELETE" } };
    const sid = req.headers["mcp-session-id"];
    if (sid !== undefined && this.sessions.get(sid) !== access.grantId) return { status: 404 };
    if (req.method === "DELETE") {
      if (sid) this.sessions.delete(sid);
      return { status: 204 };
    }
    let msg: unknown;
    try {
      msg = JSON.parse(req.body.toString("utf8"));
    } catch {
      return rpcErr(-32700, "Parse error");
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg))
      return rpcErr(-32600, "Invalid Request; batching is unsupported");
    const obj = msg as Record<string, unknown>;
    if (obj["jsonrpc"] !== "2.0" || typeof obj["method"] !== "string")
      return rpcErr(-32600, "Invalid Request; batching is unsupported");
    const id = obj["id"];
    if (
      id !== undefined &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number"
    ) {
      return rpcErr(-32600, "Invalid request id");
    }
    if (id === undefined) return { status: 202 };
    const rawParams = obj["params"];
    if (
      rawParams !== undefined &&
      (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams))
    ) {
      return rpcErr(-32602, "Expected object params", id);
    }
    const params = (rawParams ?? {}) as Record<string, unknown>;
    switch (obj["method"]) {
      case "initialize": {
        const session = randomUUID();
        this.sessions.set(session, access.grantId);
        if (this.sessions.size > MAX_SESSIONS) {
          const oldest = this.sessions.keys().next().value;
          if (oldest) this.sessions.delete(oldest);
        }
        const reqVer = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
        const version = (PROTOCOL_VERSIONS as readonly string[]).includes(reqVer)
          ? reqVer
          : PROTOCOL_VERSIONS[0];
        return rpcReply(
          id,
          {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: "Tivano", version: this.appVersion },
            instructions: INSTRUCTIONS,
          },
          { "Mcp-Session-Id": session },
        );
      }
      case "ping":
        return rpcReply(id, {});
      case "tools/list":
        return rpcReply(id, {
          tools: TOOLS.filter((t) => access.scopes.has(t.scope)).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: {
              type: "object",
              properties: t.properties,
              required: t.required,
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: t.scope === "tivano.read",
              destructiveHint: false,
              idempotentHint: t.scope === "tivano.read",
              openWorldHint: false,
            },
          })),
        });
      case "tools/call":
        return this.callTool(id, params, access);
      default:
        return rpcErr(-32601, "Method not found", id);
    }
  }

  private async callTool(
    id: unknown,
    params: Record<string, unknown>,
    access: RemoteMcpAccess,
  ): Promise<HttpReply> {
    const name = params["name"];
    const tool = typeof name === "string" ? TOOLS.find((t) => t.name === name) : undefined;
    if (!tool) return rpcErr(-32602, "Unknown tool name", id);
    if (!access.scopes.has(tool.scope)) {
      return rpcReply(
        id,
        toolErr("permission", "This connection was approved read-only.", false),
      );
    }
    const rawArgs = params["arguments"];
    if (
      rawArgs !== undefined &&
      (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))
    ) {
      return rpcReply(id, toolErr("invalidRequest", "arguments must be an object"));
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const argErr = validateArgs(tool, args);
    if (argErr) return rpcReply(id, toolErr("invalidRequest", argErr));

    const { method, mapped } = this.mapCommand(tool.name, args);
    if (
      tool.name === "send_message" &&
      typeof mapped["text"] === "string" &&
      Buffer.byteLength(mapped["text"], "utf8") > MAX_TEXT
    ) {
      return rpcReply(
        id,
        toolErr("invalidRequest", `text exceeds ${MAX_TEXT} UTF-8 bytes`),
      );
    }
    try {
      const result = await this.localControl.handleExternal(method, mapped, "remote");
      const payload = sanitizePayload(tool.name, result);
      return rpcReply(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      });
    } catch (e) {
      if (e instanceof ControlFailure) {
        return rpcReply(id, toolErr(e.code, e.detail ?? e.code));
      }
      return rpcReply(
        id,
        toolErr("internalError", e instanceof Error ? e.message : "Local control failed."),
      );
    }
  }

  private mapCommand(
    name: string,
    args: Record<string, unknown>,
  ): { method: string; mapped: Record<string, unknown> } {
    const ticket = () => `${this.localControl.instance}/${randomUUID()}/${Date.now()}`;
    switch (name) {
      case "tivano_info":
        return { method: "info", mapped: {} };
      case "list_providers":
        return { method: "providers", mapped: {} };
      case "list_projects":
        return {
          method: "projects",
          mapped: { limit: args["limit"] ?? 50, ...(args["cursor"] ? { cursor: args["cursor"] } : {}) },
        };
      case "list_threads":
        return {
          method: "threads",
          mapped: {
            archive: args["archive"] ?? "active",
            role: args["role"] ?? "normal",
            affiliation: args["affiliation"] ?? "all",
            ...(args["project_id"] ? { project: args["project_id"] } : {}),
            ...(args["search"] ? { search: args["search"] } : {}),
            limit: args["limit"] ?? 50,
            ...(args["cursor"] ? { cursor: args["cursor"] } : {}),
          },
        };
      case "get_thread":
        return { method: "thread", mapped: { threadId: args["thread_id"] } };
      case "get_history":
        return {
          method: "history",
          mapped: {
            threadId: args["thread_id"],
            limit: args["limit"] ?? 25,
            ...(args["cursor"] ? { cursor: args["cursor"] } : {}),
          },
        };
      case "get_operation":
        return { method: "operation", mapped: { ticket: args["ticket"] } };
      case "create_thread":
        return {
          method: "create",
          mapped: {
            ticket: ticket(),
            workspace: args["workspace"],
            provider: args["provider"],
            ...(args["project_id"] ? { project: args["project_id"] } : {}),
            ...(args["model"] ? { model: args["model"] } : {}),
            ...(args["hydra"] !== undefined ? { hydra: args["hydra"] } : {}),
          },
        };
      case "send_message":
        return {
          method: "submit",
          mapped: {
            ticket: ticket(),
            threadId: args["thread_id"],
            text: args["text"],
            continuation: args["continuation"] ?? "automatic",
          },
        };
      case "interrupt_turn":
        return {
          method: "interrupt",
          mapped: {
            ticket: ticket(),
            threadId: args["thread_id"],
            turnId: args["turn_id"],
          },
        };
      default:
        return { method: name, mapped: args };
    }
  }
}

function sanitizePayload(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "tivano_info" && result["info"] && typeof result["info"] === "object") {
    const info = { ...(result["info"] as Record<string, unknown>) };
    delete info["settings"];
    if (Array.isArray(info["methods"])) {
      info["methods"] = info["methods"].filter(
        (m) => m !== "settingsGet" && m !== "settingsSet",
      );
    }
    return { ...result, info };
  }
  if (toolName === "get_operation" && result["operation"] && typeof result["operation"] === "object") {
    const op = { ...(result["operation"] as Record<string, unknown>) };
    delete op["setting"];
    return { ...result, operation: op };
  }
  return result;
}

/** Hosts Remote MCP on 127.0.0.1 outside Alpha, tracking lifecycle and settings. */
export class RemoteMcpService {
  private readonly authority: RemoteMcpAuthority;
  private readonly endpoint: RemoteMcpEndpoint;
  private server: Server | undefined;
  private listeningBaseUrl: string | null = null;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  listening = false;
  failure: string | null = null;

  constructor(
    private readonly opts: {
      engine: Engine;
      localControl: LocalControlService;
      dataRoot: string;
      appVersion: string;
      onChanged?: (status: RemoteMcpStatus) => void;
      deferLoad?: boolean;
    },
  ) {
    this.authority = new RemoteMcpAuthority(
      opts.dataRoot,
      () => this.notify(),
      () => this.opts.engine.snapshot().settings.language ?? "en",
      { deferLoad: opts.deferLoad === true },
    );
    this.endpoint = new RemoteMcpEndpoint(opts.localControl, opts.appVersion);
  }

  whenSettled(): Promise<void> {
    return this.queue.then(
      () => {},
      () => {},
    );
  }

  get port(): number {
    return this.opts.engine.snapshot().settings.remoteMCPPort ?? 0;
  }

  get baseUrl(): string {
    const s = this.opts.engine.snapshot().settings;
    return remoteMcpBaseUrl(s.remoteMCPPublicURL, this.port);
  }

  status(): RemoteMcpStatus {
    const s = this.opts.engine.snapshot().settings;
    const rawPublic = s.remoteMCPPublicURL ?? "";
    const publicUrlValid = !rawPublic.trim() || normalizedPublicUrl(rawPublic) !== null;
    return {
      enabled: s.remoteMCPEnabled === true,
      listening: this.listening,
      port: this.port,
      mcpUrl: this.baseUrl + MCP_PATH,
      publicUrl: rawPublic,
      publicUrlValid,
      failure: this.failure,
      pendingApprovals: this.authority.pendingApprovals(),
      grants: this.authority.grants(),
    };
  }

  private notify(): void {
    this.opts.onChanged?.(this.status());
  }

  decide(id: string, decision: "full" | "read" | "deny"): RemoteMcpStatus {
    this.authority.decide(id, decision);
    return this.status();
  }

  revoke(id: string): RemoteMcpStatus {
    this.authority.revoke(id);
    return this.status();
  }

  revokeAll(): RemoteMcpStatus {
    this.authority.revokeAll();
    return this.status();
  }

  async retry(): Promise<RemoteMcpStatus> {
    await this.refresh(true);
    return this.status();
  }

  async refresh(forceRestart = false): Promise<void> {
    const run = async () => {
      try {
        await this.authority.ensureLoaded();
        const s = this.opts.engine.snapshot().settings;
        if ((s.remoteMCPPort ?? 0) === 0 && !this.disposed && !this.opts.engine.readOnly) {
          const picked = await pickFreePort();
          if (picked > 0 && !this.opts.engine.readOnly) {
            try {
              this.opts.engine.setSettings({ remoteMCPPort: picked });
            } catch {
              /* engine entered read-only or closed mid-refresh */
            }
          }
        }
        const enabled =
          this.opts.engine.snapshot().settings.remoteMCPEnabled === true && !this.disposed;
        const targetBase = this.baseUrl;
        if (!enabled) {
          await this.closeServer();
          this.failure = null;
          this.authority.cancelPending();
          this.notify();
          return;
        }
        if (!forceRestart && this.server && this.listening && this.listeningBaseUrl === targetBase) {
          return;
        }
        await this.closeServer();
        for (let attempt = 0; attempt < 2; attempt++) {
          if (this.disposed || this.opts.engine.snapshot().settings.remoteMCPEnabled !== true)
            return;
          const port = this.port;
          const base = this.baseUrl;
          this.authority.setBaseUrl(base);
          const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
          const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
          try {
            const u = new URL(base);
            hosts.add(u.hostname.toLowerCase());
            hosts.add(u.host.toLowerCase());
            origins.add(`${u.protocol}//${u.host}`);
          } catch {
            /* loopback defaults already present */
          }
          try {
            const srv = await this.listenOn(port, hosts, origins);
            if (this.disposed || this.opts.engine.snapshot().settings.remoteMCPEnabled !== true) {
              srv.closeAllConnections?.();
              srv.close();
              return;
            }
            this.server = srv;
            this.listening = true;
            this.listeningBaseUrl = base;
            this.failure = null;
            this.notify();
            return;
          } catch {
            if (attempt === 0 && !this.opts.engine.readOnly) {
              const next = await pickFreePort();
              if (next > 0 && !this.opts.engine.readOnly) {
                try {
                  this.opts.engine.setSettings({ remoteMCPPort: next });
                } catch {
                  /* engine entered read-only or closed */
                }
              }
            } else {
              this.listening = false;
              this.listeningBaseUrl = null;
              this.failure = "Remote MCP could not start. Retry after freeing the port.";
              this.notify();
              return;
            }
          }
        }
      } catch {
        this.listening = false;
        this.listeningBaseUrl = null;
        this.failure = "Remote MCP could not start. Retry after freeing the port.";
        this.notify();
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private listenOn(
    port: number,
    allowedHosts: Set<string>,
    allowedOrigins: Set<string>,
  ): Promise<Server> {
    if (port <= 0) return Promise.reject(new Error("invalid port"));
    return new Promise((resolve, reject) => {
      let active = 0;
      const srv = createServer({ maxHeaderSize: MAX_HEAD, requestTimeout: REQUEST_TIMEOUT_MS }, (req, res) => {
        if (active >= MAX_CONNECTIONS) {
          res.writeHead(503);
          res.end();
          return;
        }
        active++;
        void this.handleHttp(req, res, allowedHosts, allowedOrigins)
          .catch(() => {
            if (!res.writableEnded) {
              res.writeHead(500);
              res.end();
            }
          })
          .finally(() => {
            active--;
          });
      });
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        srv.removeListener("error", reject);
        srv.on("error", () => {
          if (this.server === srv) {
            this.stopServer();
            this.failure = "Remote MCP could not start. Retry after freeing the port.";
            this.notify();
          }
        });
        resolve(srv);
      });
    });
  }

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    allowedHosts: Set<string>,
    allowedOrigins: Set<string>,
  ): Promise<void> {
    const send = (reply: HttpReply) => {
      if (res.writableEnded) return;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body ?? "");
    };
    try {
      const host = req.headers.host?.toLowerCase();
      if (!host || !allowedHosts.has(host)) return send({ status: 421 });
      const origin = req.headers.origin;
      if (typeof origin === "string" && !allowedOrigins.has(origin)) return send({ status: 403 });
      if (req.method === "OPTIONS") return send({ status: 204 });

      let parsedUrl: URL;
      let path: string;
      try {
        parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        path = decodeURIComponent(parsedUrl.pathname);
      } catch {
        return send({ status: 400 });
      }

      let body: Buffer;
      try {
        body = await readBody(req, MAX_BODY);
      } catch (err) {
        if ((err as Error)?.message === "body too large") return send({ status: 413 });
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
        else if (Array.isArray(v) && v.length > 0) headers[k.toLowerCase()] = v[v.length - 1]!;
      }
      const httpReq: HttpRequest = {
        method: (req.method ?? "GET").toUpperCase(),
        path,
        query: parsedUrl.searchParams,
        headers,
        body,
      };
      const authRes = await this.authority.handle(httpReq);
      if (authRes) return send(authRes);
      if (httpReq.path !== MCP_PATH) return send({ status: 404 });
      const access = this.authority.authenticate(httpReq);
      if (!access) return send(this.authority.unauthorized());
      return send(await this.endpoint.handle(httpReq, access));
    } catch {
      return send({ status: 500 });
    }
  }

  private closeServer(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    this.listening = false;
    this.listeningBaseUrl = null;
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    });
  }

  private stopServer(): void {
    if (this.server) {
      this.server.closeAllConnections?.();
      this.server.close();
      this.server = undefined;
    }
    this.listening = false;
    this.listeningBaseUrl = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stopServer();
    this.authority.cancelPending();
  }
}

/** Stream a Fetch response up to `maxBytes`, cancelling the reader early once exceeded. */
export async function readBoundedBody(
  res: Response,
  maxBytes = MAX_METADATA_BYTES,
): Promise<Buffer | null> {
  const headerLen = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(headerLen) && headerLen > maxBytes) return null;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks);
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onErr);
      req.removeListener("aborted", onAbort);
      req.removeListener("close", onClose);
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        finish(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onErr = (err: Error) => finish(err);
    const onAbort = () => finish(new Error("aborted"));
    const onClose = () => {
      if (!req.complete) finish(new Error("aborted"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
    req.on("aborted", onAbort);
    req.on("close", onClose);
  });
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(0));
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}
