// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F33 local control e2e — a real Electron instance and a real Node
// Unix-socket client: the double gate, hello/welcome handshake, read
// queries, create/submit/interrupt through the ticket ledger, and the
// refusal surface. No CLI helper is installed (frozen helper install is
// a signed-binary surface — out of this slice).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const frame = (obj) => {
  const p = Buffer.from(JSON.stringify(obj), "utf8");
  const f = Buffer.alloc(4 + p.length);
  f.writeUInt32BE(p.length, 0);
  p.copy(f, 4);
  return f;
};

function rpc(sock, helloBody, request) {
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = Buffer.alloc(0);
    const messages = [];
    const want = request ? 2 : 1; // hello response + request response
    conn.on("connect", () => {
      conn.write(frame(helloBody));
      if (request) conn.write(frame(request));
    });
    conn.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (buf.length < size + 4) break;
        messages.push(JSON.parse(buf.subarray(4, 4 + size).toString("utf8")));
        buf = buf.subarray(4 + size);
      }
      if (messages.length >= want) {
        conn.destroy();
        resolve(request ? { hello: messages[0], res: messages[1] } : { hello: messages[0] });
      }
    });
    conn.on("error", reject);
    conn.setTimeout(10000, () => reject(new Error("control socket timeout")));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runLocalControlChecks({ launch: launchApp, instances, snap, check, boundedClose }) {
  const launch = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitSnap = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await wait(60);
    }
    throw new Error("Timed out waiting for the expected application state");
  };

  // F33 CLI install surface: redirect the bin dir so the real installer
  // runs without ever touching the host's ~/.local/bin.
  const cliDir = mkdtempSync(join(tmpdir(), "tivano-e2e-cli-"));
  const inst = await launchApp({ TIVANO_TEST_CLI_DIR: cliDir }, "local-control");
  instances.push(inst);
  const page = await inst.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const info = (await snap(page)).info;
  const sock = join(info.dataRoot, "control", "control.sock");

  const status = () => page.evaluate(() => window.tivano.invoke("control:status", {}));

  // ---- gates ----------------------------------------------------------
  verify("LC-01 default gates off, no socket", !(await status()).enabled && !existsSync(sock));
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { alphaEnabled: true, externalControlEnabled: true }));
  await wait(150);
  const st1 = await status();
  verify("LC-02 both gates on -> listening", st1.enabled && st1.listening === true, st1);
  verify("LC-03 socket file exists", existsSync(sock));

  // ---- handshake -------------------------------------------------------
  const { hello: welcome } = await rpc(sock, { version: 1, edition: "dev" });
  verify("LC-04 welcome shape", welcome.result?.welcome?.version === 1 &&
    welcome.result.welcome.edition === "dev" &&
    typeof welcome.result.welcome.instance === "string", welcome.result?.welcome);
  const instance = welcome.result.welcome.instance;
  verify("LC-05 methods advertise write trio",
    ["create", "submit", "interrupt", "operation"].every((m) =>
      welcome.result.welcome.methods.includes(m)));
  const badV = await rpc(sock, { version: 2, edition: "dev" });
  verify("LC-06 protocol mismatch refused", badV.hello.error?.code === "protocolMismatch", badV.hello);

  const req = (method, params = {}) =>
    rpc(sock, { version: 1, edition: "dev" }, { id: randomUUID(), instance, command: { method, params } });

  // ---- reads ------------------------------------------------------------
  const { res: infoRes } = await req("info");
  verify("LC-07 info", infoRes.result?.info?.instance === instance, infoRes);
  const { res: projRes } = await req("projects", { limit: 25 });
  verify("LC-08 projects page", Array.isArray(projRes.result?.projects?.items), projRes.result);
  const { res: wrongInst } = await rpc(sock, { version: 1, edition: "dev" },
    { id: randomUUID(), instance: randomUUID(), command: { method: "info", params: {} } });
  verify("LC-09 instance mismatch refused", wrongInst.error?.code === "instanceMismatch", wrongInst);

  // ---- create + submit ---------------------------------------------------
  const createTicket = `${instance}/${randomUUID()}/${Date.now()}`;
  const { res: created } = await req("create", { ticket: createTicket, workspace: "local" });
  const createdOp = created.result?.operation;
  verify("LC-10 create local thread accepted", createdOp?.state === "ready" && createdOp.threadId, created);
  const threadId = createdOp.threadId;
  await waitSnap(page, (s) => s.threads.some((t) => t.id === threadId));

  const submitTicket = `${instance}/${randomUUID()}/${Date.now()}`;
  const { res: sent } = await req("submit", {
    ticket: submitTicket, threadId, text: "Investigate the failure.",
  });
  verify("LC-11 submit accepted", sent.result?.operation?.state === "started", sent);
  const turnId = sent.result.operation.turnId;
  await waitSnap(page, (s) =>
    s.threads.find((t) => t.id === threadId)?.turn?.status === "done");
  await wait(100);
  const { res: queried } = await req("operation", { ticket: submitTicket });
  verify("LC-12 operation ended", queried.result?.operation?.state === "ended" &&
    queried.result.operation.turnStatus === "done", queried.result);

  // Same ticket + same payload replays the receipt, never re-runs.
  const { res: replay } = await req("submit", {
    ticket: submitTicket, threadId, text: "Investigate the failure.",
  });
  verify("LC-13 ticket dedupe returns same receipt", replay.result?.operation?.turnId === turnId, replay);
  const { res: conflict } = await req("submit", {
    ticket: submitTicket, threadId, text: "a different write",
  });
  verify("LC-14 changed payload conflicts", conflict.error?.code === "conflict", conflict);

  // ---- refusal surface -----------------------------------------------------
  const { res: unknownMethod } = await req("approve");
  verify("LC-15 approve not a command", unknownMethod.error?.code === "invalidRequest", unknownMethod);
  const staleTicket = `${instance}/${randomUUID()}/${Date.now() - 60_000}`;
  const { res: stale } = await req("submit", {
    ticket: staleTicket, threadId, text: "stale write",
  });
  verify("LC-16 stale ticket is unknown", stale.error?.code === "unknown", stale);
  const { res: slashSend } = await req("submit", {
    ticket: `${instance}/${randomUUID()}/${Date.now()}`, threadId, text: "/plan x",
  });
  verify("LC-17 slash input refused", slashSend.error?.code === "invalidRequest", slashSend);

  // ---- interrupt -----------------------------------------------------------
  const runTicket = `${instance}/${randomUUID()}/${Date.now()}`;
  const { res: run2 } = await req("submit", {
    ticket: runTicket, threadId, text: "slow work",
  });
  const runTurn = run2.result?.operation?.turnId;
  const { res: intr } = await req("interrupt", {
    ticket: `${instance}/${randomUUID()}/${Date.now()}`,
    threadId, turnId: runTurn,
  });
  verify("LC-18 interrupt accepted + honest evidence",
    intr.result?.operation?.state === "ended" &&
    intr.result.operation.stopEvidence === "runtime_ended_only", intr);

  // ---- settings via control -------------------------------------------------
  const { res: setRes } = await req("settingsSet", {
    ticket: `${instance}/${randomUUID()}/${Date.now()}`,
    key: "antiSlopEnabled", bool: false,
  });
  verify("LC-19 settingsSet antiSlopEnabled", setRes.result?.operation?.state === "ended", setRes);
  await waitSnap(page, (s) => s.settings.antiSlopEnabled === false);
  const { res: sky } = await req("settingsSet", {
    ticket: `${instance}/${randomUUID()}/${Date.now()}`,
    key: "showsSkylight", bool: false,
  });
  verify("LC-20 settingsSet showsSkylight", sky.result?.operation?.state === "ended", sky);
  await waitSnap(page, (s) => s.settings.showsSkylight === false);
  const { res: sky2 } = await req("settingsSet", {
    ticket: `${instance}/${randomUUID()}/${Date.now()}`,
    key: "showsSkylight", bool: true,
  });
  verify("LC-20a showsSkylight restored", sky2.result?.operation?.state === "ended", sky2);
  await waitSnap(page, (s) => s.settings.showsSkylight === true);
  const { res: un } = await req("settingsSet", {
    ticket: `${instance}/${randomUUID()}/${Date.now()}`,
    key: "sidebarActivityView", bool: true,
  });
  verify("LC-20b absent key refused", un.error?.code === "invalidRequest", un);

  // ---- gate close kills the listener -----------------------------------------
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { externalControlEnabled: false }));
  await wait(200);
  const st2 = await status();
  verify("LC-21 gate close stops listening", !st2.enabled && st2.listening === false, st2);
  let connectFailed = false;
  try {
    await rpc(sock, { version: 1, edition: "dev" });
  } catch {
    connectFailed = true;
  }
  verify("LC-22 socket refuses new connects after close", connectFailed || !existsSync(sock));

  // ---- UI surface -----------------------------------------------------------
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { externalControlEnabled: true }));
  await wait(200);
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.waitForSelector(".control-status", { timeout: 10000 });
  const alphaSwitch = page.locator('.choice-row button[role="switch"]', { hasText: "Alpha" }).first();
  verify("LC-23 Alpha switch rendered", (await alphaSwitch.count()) === 1);
  const statusLine = await page.locator('[data-testid="local-control-status"]').textContent();
  verify("LC-24 status shows listening", statusLine?.includes("Listening for this account only"), statusLine);
  const localSwitch = page.locator('.choice-row button[role="switch"]', { hasText: "Local control" }).first();
  await localSwitch.click();
  await wait(200);
  const statusAfter = await page.locator('[data-testid="local-control-status"]').textContent();
  verify("LC-25 UI toggle off drops listener", statusAfter?.includes("Disabled"), statusAfter);

  // ---- CLI command install surface (frozen CLIInstallationSettings) ---
  // win32 installs write a `.cmd` sibling next to the sh shim; status
  // reads the `.cmd` first, so every scenario covers both names.
  const cliFile = join(cliDir, "tivano");
  const cliCmdFile = join(cliDir, "tivano.cmd");
  const cliStatusText = () =>
    page.locator('[data-testid="cli-status"]').textContent();
  const cliInstallLabel = async () =>
    (await page.locator('[data-testid="cli-install"]').textContent())?.trim();
  const waitCliText = (frag) => page.waitForFunction(
    (f) => document.querySelector('[data-testid="cli-status"]')?.textContent?.includes(f),
    frag, { timeout: 10000 });
  // "Installed" is also a prefix of the needs-repair sentence — a real
  // healthy state must wait for it without the repair wording.
  const waitCliInstalled = () => page.waitForFunction(
    () => {
      const s = document.querySelector('[data-testid="cli-status"]')?.textContent ?? "";
      return s.includes("Installed") && !s.includes("older copy");
    }, { timeout: 10000 });
  const overwriteCli = (text) => {
    writeFileSync(cliFile, text);
    if (existsSync(cliCmdFile)) writeFileSync(cliCmdFile, text);
  };
  const removeCli = () => {
    if (existsSync(cliFile)) unlinkSync(cliFile);
    if (existsSync(cliCmdFile)) unlinkSync(cliCmdFile);
  };
  verify("LC-27 CLI row shows not-installed + real bin dir + Install CLI",
    (await cliStatusText())?.includes("Not installed") &&
    (await cliStatusText())?.includes(cliDir) &&
    (await cliInstallLabel()) === "Install CLI", await cliStatusText());
  await page.locator('[data-testid="cli-install"]').click();
  await waitCliInstalled();
  verify("LC-28 install writes a real marked shim, reads Reinstall CLI",
    existsSync(cliFile) && readFileSync(cliFile, "utf8").includes("tivano-cli-shim:") &&
    (await cliInstallLabel()) === "Reinstall CLI", await cliInstallLabel());
  // needsRepair: our shim pointing at an older copy gets Repair CLI.
  // Settings re-reads the real file state on open — reopen the modal.
  const staleClient = join(cliDir, "older-tivano.mjs");
  overwriteCli(
    `#!/bin/sh\n# tivano-cli-shim: ${staleClient}\nexec node "${staleClient}" "$@"\n`);
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector('[data-testid="cli-status"]', { timeout: 10000 });
  await waitCliText("older copy");
  verify("LC-28a stale shim reports needs-repair, reads Repair CLI",
    (await cliStatusText())?.includes("older copy") &&
    (await cliInstallLabel()) === "Repair CLI", await cliStatusText());
  await page.locator('[data-testid="cli-install"]').click();
  await waitCliInstalled();
  verify("LC-28b repair repoints the shim at this client",
    readFileSync(cliFile, "utf8").includes("tivano-cli-shim:") &&
    !readFileSync(cliFile, "utf8").includes("older-tivano") &&
    (await cliInstallLabel()) === "Reinstall CLI", await cliInstallLabel());
  // Foreign command: installer must refuse, never replace.
  overwriteCli("#!/bin/sh\necho foreign\n");
  await page.locator('[data-testid="cli-install"]').click();
  await waitCliText("Another tivano");
  verify("LC-29 foreign command refused, file untouched, reads Install CLI",
    readFileSync(cliFile, "utf8").includes("foreign") &&
    (await cliStatusText())?.includes("Another tivano") &&
    (await cliInstallLabel()) === "Install CLI", await cliStatusText());
  // Remove the foreign files ourselves → install → uninstall round trip.
  removeCli();
  await page.locator('[data-testid="cli-install"]').click();
  await waitCliInstalled();
  await page.locator('[data-testid="cli-uninstall"]').click();
  await waitCliText("Not installed");
  verify("LC-30 uninstall removes only our shims",
    !existsSync(cliFile) && !existsSync(cliCmdFile) &&
    (await cliStatusText())?.includes("Not installed") &&
    (await cliInstallLabel()) === "Install CLI",
    [existsSync(cliFile), existsSync(cliCmdFile)]);
  // The real client binary answers against the live socket end to end —
  // re-open the gate LC-25 shut, wait for the listener, then call.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { externalControlEnabled: true }));
  await wait(300);
  const cliRun = await promisify(execFile)(
    "node", [join(process.cwd(), "cli", "tivano.mjs"), "info"],
    { env: { ...process.env, TIVANO_CONTROL_SOCKET: sock }, timeout: 15000 })
    .then((r) => JSON.parse(r.stdout))
    .catch((e) => ({ err: String(e) }));
  verify("LC-31 tivano.mjs info round trip",
    cliRun?.info?.edition === "dev" && cliRun?.info?.version === 1, cliRun);
  await page.locator(".modal-actions .primary").click();

  // restore the persisted gates so later suites inherit a clean default
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      alphaEnabled: false, externalControlEnabled: false, antiSlopEnabled: true,
    }));
  const c = await boundedClose(inst.app, inst.proc);
  verify("LC-26 clean shutdown", c.exited === true, c);
}
