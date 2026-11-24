// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-25 Remote MCP: real loopback HTTP server + OAuth 2.1 + PKCE +
// Streamable HTTP MCP endpoint + full-access gate for Hydra-led chats.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { LocalControlService } from "../src/main/localControl";
import {
  RemoteMcpService,
  normalizedPublicUrl,
  remoteMcpBaseUrl,
} from "../src/main/remoteMcp";

const dirs: string[] = [];
const services: { lc: LocalControlService; rm: RemoteMcpService }[] = [];

const loopbackBindable = await new Promise<boolean>((resolve) => {
  const s = createServer();
  s.once("error", () => resolve(false));
  s.listen(0, "127.0.0.1", () => s.close(() => resolve(true)));
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "tivano-rmcp-"));
  dirs.push(root);
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 2 }), root, "1.0.0-test");
  const lc = new LocalControlService(engine, root, "dev");
  const rm = new RemoteMcpService({
    engine,
    localControl: lc,
    dataRoot: root,
    appVersion: "1.0.0-test",
  });
  lc.setRemoteListeningCheck(() => rm.listening);
  services.push({ lc, rm });
  return { root, store, engine, lc, rm };
}

afterEach(() => {
  for (const s of services) {
    s.rm.dispose();
    s.lc.dispose();
  }
  services.length = 0;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const base64Url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function authorizeGrant(
  rm: RemoteMcpService,
  base: string,
  decision: "full" | "read" | "deny",
  scope = "tivano.read tivano.write",
) {
  const regRes = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic Cloud Agent",
      redirect_uris: ["http://127.0.0.1:49999/cb"],
    }),
  });
  expect(regRes.status).toBe(201);
  const reg = (await regRes.json()) as { client_id: string };
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(`${base}/oauth/authorize`);
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", "http://127.0.0.1:49999/cb");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", "st1");
  authUrl.searchParams.set("scope", scope);

  const authRes = await fetch(authUrl, { redirect: "manual" });
  expect(authRes.status).toBe(302);
  const pendingLoc = authRes.headers.get("location")!;
  expect(pendingLoc).toContain("/oauth/authorize/pending?request=");

  const pendingWait = await fetch(pendingLoc);
  expect(pendingWait.status).toBe(200);
  const approval = rm.status().pendingApprovals[0]!;
  expect(approval.clientName).toBe("Synthetic Cloud Agent");
  expect(await pendingWait.text()).toContain(approval.code);

  rm.decide(approval.id, decision);
  const redirRes = await fetch(pendingLoc, { redirect: "manual" });
  expect(redirRes.status).toBe(302);
  const cbUrl = new URL(redirRes.headers.get("location")!);
  expect(cbUrl.searchParams.get("state")).toBe("st1");
  expect(cbUrl.searchParams.get("iss")).toBe(base);
  if (decision === "deny") {
    expect(cbUrl.searchParams.get("error")).toBe("access_denied");
    return null;
  }
  const code = cbUrl.searchParams.get("code")!;
  const tokRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: reg.client_id,
      redirect_uri: "http://127.0.0.1:49999/cb",
      code_verifier: verifier,
    }),
  });
  expect(tokRes.status).toBe(200);
  const tok = (await tokRes.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  return { clientId: reg.client_id, ...tok };
}

async function mcpRpc(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  const text = await res.text();
  return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("remote MCP URL normalization", () => {
  it("accepts HTTPS and loopback HTTP only, rejecting query/fragment/plain remote HTTP", () => {
    expect(normalizedPublicUrl("https://agent.example.com/")).toBe("https://agent.example.com");
    expect(normalizedPublicUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    expect(normalizedPublicUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizedPublicUrl("http://example.com")).toBeNull();
    expect(normalizedPublicUrl("https://example.com/?a=1")).toBeNull();
    expect(normalizedPublicUrl("https://example.com/#frag")).toBeNull();
    expect(normalizedPublicUrl("https://user@example.com")).toBeNull();
    expect(remoteMcpBaseUrl("https://tunnel.example.com/", 4123)).toBe("https://tunnel.example.com");
    expect(remoteMcpBaseUrl("", 4123)).toBe("http://127.0.0.1:4123");
  });
});

describe.runIf(loopbackBindable)("remote MCP (P2-25)", () => {
  it("runs outside Alpha while LocalControl stays disabled", async () => {
    const { engine, lc, rm } = rig();
    engine.setSettings({ alphaEnabled: false, externalControlEnabled: true, remoteMCPEnabled: true });
    lc.refreshListening();
    await rm.refresh();
    expect(lc.listening).toBe(false);
    expect(rm.listening).toBe(true);
    expect(rm.port).toBeGreaterThan(0);

    const base = `http://127.0.0.1:${rm.port}`;
    const pr = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(pr.status).toBe(200);
    const prJson = (await pr.json()) as { resource: string; scopes_supported: string[] };
    expect(prJson.resource).toBe(`${base}/mcp`);
    expect(prJson.scopes_supported).toEqual(["tivano.read", "tivano.write"]);

    // Unauthorized request returns 401 + WWW-Authenticate.
    const unauth = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("oauth-protected-resource");

    // Unknown Host is rejected with 421; foreign Origin is rejected with 403.
    const badOrigin = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);

    await expect(lc.handleExternal("settingsGet", {}, "remote")).rejects.toMatchObject({
      code: "permission",
    });
  });

  it("supports OAuth 2.1 read-only vs full-control grants, refresh rotation, and revoke", async () => {
    const { root, engine, rm } = rig();
    engine.setSettings({ alphaEnabled: false, remoteMCPEnabled: true });
    await rm.refresh();
    const base = `http://127.0.0.1:${rm.port}`;

    // Denied request returns null and issues no grant.
    const denied = await authorizeGrant(rm, base, "deny");
    expect(denied).toBeNull();
    expect(rm.status().grants).toHaveLength(0);

    // Read-only grant restricts tools/list and blocks write calls.
    const ro = (await authorizeGrant(rm, base, "read"))!;
    expect(ro.scope).toBe("tivano.read");
    const init = await mcpRpc(base, ro.access_token, "initialize", {
      protocolVersion: "2025-11-25",
    });
    const sid = init.res.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();

    const listRo = await mcpRpc(base, ro.access_token, "tools/list", {}, sid);
    const roNames = ((listRo.body.result as { tools: { name: string }[] }).tools).map((t) => t.name);
    expect(roNames).toContain("tivano_info");
    expect(roNames).not.toContain("send_message");

    const writeDenied = await mcpRpc(
      base,
      ro.access_token,
      "tools/call",
      { name: "create_thread", arguments: { workspace: "local", provider: "mock" } },
      sid,
    );
    expect((writeDenied.body.result as { isError: boolean }).isError).toBe(true);
    expect((writeDenied.body.result as { structuredContent: { error: string } }).structuredContent.error).toBe(
      "permission",
    );

    // Info strips settings & settingsGet/settingsSet methods.
    const infoRes = await mcpRpc(base, ro.access_token, "tools/call", { name: "tivano_info" }, sid);
    const infoPayload = (infoRes.body.result as { structuredContent: { info: Record<string, unknown> } })
      .structuredContent.info;
    expect(infoPayload.settings).toBeUndefined();
    expect(infoPayload.methods).not.toContain("settingsGet");
    expect(infoPayload.methods).not.toContain("settingsSet");

    // Refresh token rotates and persists SHA-256 hash only.
    const refRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: ro.refresh_token,
        client_id: ro.clientId,
      }),
    });
    expect(refRes.status).toBe(200);
    const refTok = (await refRes.json()) as { access_token: string; refresh_token: string };
    expect(refTok.refresh_token).not.toBe(ro.refresh_token);
    expect(existsSync(join(root, "remote-mcp.json"))).toBe(true);
    const persisted = readFileSync(join(root, "remote-mcp.json"), "utf8");
    expect(persisted).not.toContain(refTok.refresh_token);
    expect(persisted).not.toContain(refTok.access_token);

    // Revoking invalidates future MCP calls.
    const grantId = rm.status().grants[0]!.id;
    rm.revoke(grantId);
    expect(rm.status().grants).toHaveLength(0);
    const afterRevoke = await mcpRpc(base, refTok.access_token, "ping", {}, sid);
    expect(afterRevoke.res.status).toBe(401);
  });

  it("enforces remoteMCPFullAccess for remote create runtimeMode and Hydra-led sends", async () => {
    const { engine, lc, rm } = rig();
    engine.setSettings({
      alphaEnabled: true,
      externalControlEnabled: true,
      remoteMCPEnabled: true,
      remoteMCPFullAccess: false,
      hydraEnabled: true,
      hydraPairs: [{ id: "pair-1", provider: "mock", headProfiles: [] }],
    });
    lc.refreshListening();
    await rm.refresh();
    const base = `http://127.0.0.1:${rm.port}`;
    const tok = (await authorizeGrant(rm, base, "full"))!;

    const init = await mcpRpc(base, tok.access_token, "initialize", {
      protocolVersion: "2025-11-25",
    });
    const sid = init.res.headers.get("mcp-session-id")!;

    // 1. Remote create with full-access OFF starts in supervised mode.
    const createdSup = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      {
        name: "create_thread",
        arguments: { workspace: "local", provider: "mock", hydra: false },
      },
      sid,
    );
    const supId = (
      createdSup.body.result as { structuredContent: { operation: { threadId: string } } }
    ).structuredContent.operation.threadId;
    expect(engine.snapshot().threads.find((t) => t.id === supId)?.runtimeMode).toBe("supervised");

    // Non-Hydra chat still accepts remote sends without remoteMCPFullAccess.
    const sendPlain = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      { name: "send_message", arguments: { thread_id: supId, text: "hello plain" } },
      sid,
    );
    expect((sendPlain.body.result as { isError: boolean }).isError).toBe(false);

    // 2. Hydra-led chat refuses remote send when remoteMCPFullAccess is OFF.
    const hydraLead = engine.createThread(null, "hydra-lead", {
      externalHydra: { enabled: true, pairId: "pair-1" },
    });
    const blockedEn = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      { name: "send_message", arguments: { thread_id: hydraLead.id, text: "delegate task" } },
      sid,
    );
    expect((blockedEn.body.result as { isError: boolean }).isError).toBe(true);
    expect(
      (blockedEn.body.result as { structuredContent: { error: string; detail: string } })
        .structuredContent,
    ).toEqual({
      error: "permission",
      detail: "hydra_requires_remote_full_access",
    });

    // Wire error codes/details stay identical under zh-Hans.
    engine.setSettings({ language: "zh-Hans" });
    const blockedZh = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      { name: "send_message", arguments: { thread_id: hydraLead.id, text: "delegate task" } },
      sid,
    );
    expect(
      (blockedZh.body.result as { structuredContent: { error: string; detail: string } })
        .structuredContent,
    ).toEqual({
      error: "permission",
      detail: "hydra_requires_remote_full_access",
    });
    engine.setSettings({ language: "en" });

    // Local control (owner CLI) is NOT gated by remoteMCPFullAccess on Hydra-led chats.
    const localSend = await lc.handleExternal(
      "submit",
      {
        ticket: `${lc.instance}/${randomUUID()}/${Date.now()}`,
        threadId: hydraLead.id,
        text: "local owner send",
      },
      "local",
    );
    expect((localSend.operation as { state: string }).state).toBe("started");

    // Wait for local mock turn to finish, then enable remoteMCPFullAccess.
    await new Promise((r) => setTimeout(r, 80));
    engine.setSettings({ remoteMCPFullAccess: true });

    // 3. Remote create with full-access ON starts in fullAccess mode.
    const unknownTool = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      { workspace: "local", provider: "mock", hydra: true },
      sid,
    );
    expect((unknownTool.body.error as { code: number }).code).toBe(-32602);
    const createdFullOk = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      {
        name: "create_thread",
        arguments: { workspace: "local", provider: "mock", hydra: true },
      },
      sid,
    );
    const fullId = (
      createdFullOk.body.result as { structuredContent: { operation: { threadId: string } } }
    ).structuredContent.operation.threadId;
    expect(engine.snapshot().threads.find((t) => t.id === fullId)?.runtimeMode).toBe("fullAccess");

    // Hydra-led chat now accepts remote sends.
    const sendHydraOk = await mcpRpc(
      base,
      tok.access_token,
      "tools/call",
      { name: "send_message", arguments: { thread_id: fullId, text: "remote hydra ok" } },
      sid,
    );
    expect((sendHydraOk.body.result as { isError: boolean }).isError).toBe(false);

    // DELETE /mcp tears down the session cleanly.
    const delRes = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok.access_token}`, "Mcp-Session-Id": sid },
    });
    expect(delRes.status).toBe(204);
    const staleSid = await mcpRpc(base, tok.access_token, "ping", {}, sid);
    expect(staleSid.res.status).toBe(404);
  });

  it("persists remoteMCP settings and port across store reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "tivano-rmcp-persist-"));
    dirs.push(root);
    const store1 = new Store(root);
    store1.open();
    const engine1 = new Engine(store1, new MockProvider({ tickMs: 2 }), root, "1.0.0-test");
    const lc1 = new LocalControlService(engine1, root, "dev");
    const rm1 = new RemoteMcpService({
      engine: engine1,
      localControl: lc1,
      dataRoot: root,
      appVersion: "1.0.0-test",
    });
    engine1.setSettings({
      remoteMCPEnabled: true,
      remoteMCPFullAccess: true,
      remoteMCPPublicURL: "https://tunnel.example.com",
    });
    await rm1.refresh();
    const savedPort = rm1.port;
    expect(savedPort).toBeGreaterThan(0);
    rm1.dispose();
    lc1.dispose();
    store1.close();

    const store2 = new Store(root);
    store2.open();
    const s2 = store2.state.settings;
    expect(s2.remoteMCPEnabled).toBe(true);
    expect(s2.remoteMCPFullAccess).toBe(true);
    expect(s2.remoteMCPPublicURL).toBe("https://tunnel.example.com");
    expect(s2.remoteMCPPort).toBe(savedPort);
    store2.close();
  });
});
