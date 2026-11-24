// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-25 Remote MCP e2e: real Electron instance, Connections settings surface
// outside Alpha, in-app OAuth approval dialog, and Hydra full-access gate.

import { createHash, randomBytes, randomUUID } from "node:crypto";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base64Url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function runRemoteMcpChecks({ launch: launchApp, instances, snap, check, boundedClose }) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  const inst = await launchApp({}, "remote-mcp");
  instances.push(inst);
  const page = await inst.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      alphaEnabled: false,
      remoteMCPEnabled: false,
      remoteMCPFullAccess: false,
      hydraEnabled: true,
      hydraPairs: [{ id: "rmcp-pair", provider: "mock", headProfiles: [] }],
    }),
  );

  // Open Settings -> Connections -> Remote MCP (outside Alpha).
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.locator('[data-testid="remote-mcp-section"]').scrollIntoViewIfNeeded();

  const connBox = await page.locator('[data-testid="connections-section"]').count();
  verify("RM-01 Connections section wraps MCP + Remote MCP", connBox === 1);

  const stInit = await page.locator('[data-testid="remote-mcp-status"]').textContent();
  verify("RM-02 Remote MCP disabled by default", stInit?.includes("Disabled"), stInit);

  // Toggle Remote MCP ON while Alpha remains OFF.
  await page.locator('[data-testid="remote-mcp-toggle"]').click();
  await wait(250);
  const rmStatus = await page.evaluate(() => window.tivano.invoke("remoteMcp:status", {}));
  verify(
    "RM-03 Remote MCP listens outside Alpha",
    rmStatus?.enabled === true && rmStatus?.listening === true && rmStatus?.port > 0,
    rmStatus,
  );
  const stListening = await page.locator('[data-testid="remote-mcp-status"]').textContent();
  verify(
    "RM-04 UI displays listening port",
    stListening?.includes(`Listening on 127.0.0.1:${rmStatus.port}`),
    stListening,
  );

  // Public URL validation feedback.
  const urlInput = page.locator('[data-testid="remote-mcp-public-url"]');
  await urlInput.fill("http://example.com");
  await urlInput.blur();
  await wait(150);
  const badUrlHint = await page.locator('[data-testid="remote-mcp-address-detail"]').textContent();
  verify(
    "RM-05 invalid public URL flagged",
    badUrlHint?.includes("Enter an HTTPS address"),
    badUrlHint,
  );
  await urlInput.fill("");
  await urlInput.blur();
  await wait(150);

  // Close settings so approval dialog is cleanly visible.
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });

  // Perform OAuth DCR + authorize -> triggers in-app approval dialog.
  const base = `http://127.0.0.1:${rmStatus.port}`;
  const regRes = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E Cloud Client",
      redirect_uris: ["http://127.0.0.1:49998/cb"],
    }),
  });
  const reg = await regRes.json();
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(`${base}/oauth/authorize`);
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", "http://127.0.0.1:49998/cb");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const authRes = await fetch(authUrl, { redirect: "manual" });
  const pendingLoc = authRes.headers.get("location");
  await page.waitForSelector('[data-testid="remote-mcp-approval"]', { timeout: 10000 });
  const promptTitle = await page.locator('[data-testid="remote-mcp-approval"] h2').textContent();
  verify(
    "RM-06 in-app approval dialog rendered",
    promptTitle?.includes("E2E Cloud Client"),
    promptTitle,
  );
  await page.locator('[data-testid="remote-mcp-allow-full"]').click();
  await page.waitForSelector('[data-testid="remote-mcp-approval"]', {
    state: "detached",
    timeout: 10000,
  });

  const pendingRes = await fetch(pendingLoc, { redirect: "manual" });
  const code = new URL(pendingRes.headers.get("location")).searchParams.get("code");
  const tokRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: reg.client_id,
      redirect_uri: "http://127.0.0.1:49998/cb",
      code_verifier: verifier,
    }),
  });
  const tok = await tokRes.json();
  verify("RM-07 OAuth token issued", typeof tok.access_token === "string", tok);

  // Create Hydra-led chat via MCP and verify full-access gate.
  const callMcp = async (method, params = {}, sid) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok.access_token}`,
        ...(sid ? { "Mcp-Session-Id": sid } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    });
    return { r, body: await r.json() };
  };
  const init = await callMcp("initialize", { protocolVersion: "2025-11-25" });
  const sid = init.r.headers.get("mcp-session-id");
  const created = await callMcp(
    "tools/call",
    { name: "create_thread", arguments: { workspace: "local", provider: "mock", hydra: true } },
    sid,
  );
  const threadId = created.body.result?.structuredContent?.operation?.threadId;
  verify("RM-08 Hydra thread created via Remote MCP", typeof threadId === "string", created.body);

  const blocked = await callMcp(
    "tools/call",
    { name: "send_message", arguments: { thread_id: threadId, text: "hello hydra" } },
    sid,
  );
  verify(
    "RM-09 Hydra send refused without full-access setting",
    blocked.body.result?.isError === true &&
      blocked.body.result?.structuredContent?.detail === "hydra_requires_remote_full_access",
    blocked.body,
  );

  // Enable Run remote chats without approval in Settings UI and retry send.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.locator('[data-testid="remote-mcp-full-access-toggle"]').click();
  await wait(200);
  const allowed = await callMcp(
    "tools/call",
    { name: "send_message", arguments: { thread_id: threadId, text: "hello hydra" } },
    sid,
  );
  verify(
    "RM-10 Hydra send allowed with full-access setting",
    allowed.body.result?.isError === false,
    allowed.body,
  );

  // Check zh-Hans localization.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await wait(150);
  const connHeadingZh = await page.locator('[data-testid="connections-section"] h3').first().textContent();
  verify("RM-11 Connections localized in zh-Hans", connHeadingZh === "连接", connHeadingZh);

  // Grant appears and can be revoked from Settings.
  await page.locator("[data-grant] .remote-mcp-revoke").first().click();
  await wait(150);
  verify("RM-11b grant revoked from UI", (await page.locator("[data-grant]").count()) === 0);

  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      remoteMCPEnabled: false,
      remoteMCPFullAccess: false,
    }),
  );
  await page.locator(".modal-actions .primary").click();
  const c = await boundedClose(inst.app, inst.proc);
  verify("RM-12 clean shutdown", c.exited === true, c);
}
