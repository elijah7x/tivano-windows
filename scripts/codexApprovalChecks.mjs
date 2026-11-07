// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex decision-approval e2e checks — against the OFFLINE fixture only:
// the server's availableDecisions become the card options in the frozen
// order; the picked option's payload is written back verbatim
// (acceptForSession / execpolicy amendment / cancel), permissions answer
// with scope:"session" or the empty turn-scoped grant, and zh-Hans shows
// the frozen localized labels. Nothing here proves a real provider.

import { join } from "node:path";

export async function runCodexApprovalChecks({
  launch: launchApp,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) =>
    launchApp(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
        ...overrides,
      },
      label,
    );
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitSnapshot = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };
  const newCodexThread = async (page, name) => {
    const proj = await page.evaluate((n) => window.tivano.invoke("projects:create", { name: n }), name);
    const th = await page.evaluate(
      (pid) => window.tivano.invoke("threads:create", { projectId: pid, title: "ap" }),
      proj.id,
    );
    await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), th.id);
    await page.waitForSelector(".chat-head h1");
    return th.id;
  };
  const send = async (page, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
  };
  const turnOf = (s, threadId) => s.threads.find((x) => x.id === threadId)?.turn;
  const lastText = (s, threadId) => {
    const th = s.threads.find((x) => x.id === threadId);
    return th?.messages.map((m) => m.content).join("\n") ?? "";
  };
  const approvalOf = (s, threadId) => turnOf(s, threadId)?.approval;

  // --- session A1: decision card options + Approve for session ---------
  let s = await launch({}, "s-codex-approval-en");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  let threadId = await newCodexThread(page, "Ap Proj");
  await send(page, "please approval now");
  await waitSnapshot(page, (st) => approvalOf(st, threadId)?.status === "pending");
  await page.waitForSelector(".approval", { timeout: 10000 });
  let options = approvalOf(await snap(page), threadId).options.map((o) => o.id);
  verify(
    "CDXAPR-01 card exposes the frozen decision set (deny-class first in array)",
    options.join(",") === "cancel,decline,acceptForSession,accept",
    options,
  );
  const cardText = await page.locator(".approval").last().innerText();
  verify(
    "CDXAPR-02 frozen labels render (Approve / Approve for session / Decline / Stop turn)",
    cardText.includes("Approve") && cardText.includes("Approve for session") &&
      cardText.includes("Decline") && cardText.includes("Stop turn"),
    cardText.slice(0, 200),
  );
  await page.screenshot({ path: join(outDir, "cdxapr-01-card.png") });
  await page.getByRole("button", { name: "Approve for session" }).click();
  await waitSnapshot(page, (st) => turnOf(st, threadId)?.status === "done");
  verify(
    "CDXAPR-03 acceptForSession payload reached the wire",
    lastText(await snap(page), threadId).includes("[d=acceptForSession]"),
    lastText(await snap(page), threadId).slice(-160),
  );

  // --- session A2 (same instance): permissions → Allow for session -----
  await send(page, "need perm here");
  await waitSnapshot(page, (st) => approvalOf(st, threadId)?.status === "pending");
  options = approvalOf(await snap(page), threadId).options.map((o) => o.id);
  verify(
    "CDXAPR-04 permissions card offers turn/session grants",
    options.join(",") === "decline,session,turn",
    options,
  );
  await page.getByRole("button", { name: "Allow for session" }).click();
  await waitSnapshot(page, (st) => turnOf(st, threadId)?.status === "done");
  verify(
    "CDXAPR-05 scope:session reached the wire",
    lastText(await snap(page), threadId).includes("[scope=session]"),
    lastText(await snap(page), threadId).slice(-160),
  );

  // --- session A3 (same instance): execpolicy amendment -----------------
  await send(page, "approval amend please");
  await waitSnapshot(page, (st) => approvalOf(st, threadId)?.status === "pending");
  const amendText = await page.locator(".approval").last().innerText();
  verify("CDXAPR-06 amendment offered as Always allow", amendText.includes("Always allow"), amendText.slice(0, 200));
  await page.getByRole("button", { name: "Always allow" }).click();
  await waitSnapshot(page, (st) => turnOf(st, threadId)?.status === "done");
  verify(
    "CDXAPR-07 amendment object written back verbatim",
    lastText(await snap(page), threadId).includes("[amend]"),
    lastText(await snap(page), threadId).slice(-160),
  );

  // --- session A4 (same instance): Decline writes the deny payload -----
  await send(page, "approval again");
  await waitSnapshot(page, (st) => approvalOf(st, threadId)?.status === "pending");
  await page.getByRole("button", { name: "Decline" }).click();
  await waitSnapshot(page, (st) => {
    const t = turnOf(st, threadId);
    return t && ["done", "interrupted", "error", "denied"].includes(t.status);
  });
  verify(
    "CDXAPR-08 decline settles the turn without granting",
    approvalOf(await snap(page), threadId)?.status === "resolved" &&
      turnOf(await snap(page), threadId)?.status === "denied",
    approvalOf(await snap(page), threadId),
  );

  // --- session A5 (same instance): Stop turn → cancel payload ----------
  await send(page, "approval once more");
  await waitSnapshot(page, (st) => approvalOf(st, threadId)?.status === "pending");
  await page.getByRole("button", { name: "Stop turn" }).click();
  await waitSnapshot(page, (st) => {
    const t = turnOf(st, threadId);
    return t && ["done", "interrupted", "error", "denied"].includes(t.status);
  });
  verify("CDXAPR-09 stop turn settled the turn", true);

  const enClose = await boundedClose(app, proc);
  ledger.exited = enClose.exited;
  ledger.outcome = enClose.outcome;
  check("CDXAPR-10 codex approval instance exited cleanly", enClose.exited && enClose.exitCode === 0, enClose.outcome);

  // --- session A6: zh-Hans labels --------------------------------------
  s = await launch({}, "s-codex-approval-zh");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  threadId = await newCodexThread(page, "批 Proj");
  await send(page, "please approval now");
  await waitSnapshot(page, (st) => approvalOf(st, threadId)?.status === "pending");
  await page.waitForSelector(".approval", { timeout: 10000 });
  const zhText = await page.locator(".approval").last().innerText();
  verify(
    "CDXAPR-11 zh-Hans decision labels render",
    zhText.includes("批准") && zhText.includes("本次会话批准") &&
      zhText.includes("拒绝") && zhText.includes("停止本轮"),
    zhText.slice(0, 200),
  );
  await page.screenshot({ path: join(outDir, "cdxapr-02-card-zh.png") });
  const zhClose = await boundedClose(app, proc);
  ledger.exited = zhClose.exited;
  ledger.outcome = zhClose.outcome;
  check("CDXAPR-12 zh approval instance exited cleanly", zhClose.exited && zhClose.exitCode === 0, zhClose.outcome);
}
