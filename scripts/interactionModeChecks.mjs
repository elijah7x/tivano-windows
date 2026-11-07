// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F06 build/plan interaction-mode e2e — OFFLINE Codex fixture only: the
// Build/Plan toggle is per-thread, maps to frozen collaborationMode.mode
// ("default"/"plan") on turn/start (fixture echoes [cm=...]), persists
// across restart, and never implies real provider enforcement.

import { join } from "node:path";

export async function runInteractionModeChecks({
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
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`button[title="New thread in ${name}"]`);
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };
  const sendAndCollect = async (page, threadId, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
    const s = await waitSnapshot(page, (x) => {
      const t = x.threads.find((y) => y.id === threadId)?.turn;
      return t?.status === "done" || t?.status === "error";
    });
    const th = s.threads.find((x) => x.id === threadId);
    return th?.messages.at(-1)?.content ?? "";
  };
  const imode = (page, m) => page.locator(`.imode-toggle .imode:has-text("${m}")`);

  // --- session I1: default build, plan on the wire, toggle back ---------
  let s = await launch({}, "s-imode-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid = await newCodexThread(page, "IMode Proj");

  await page.waitForSelector(".imode-toggle", { timeout: 10000 });
  verify(
    "interaction toggle defaults to build",
    (await imode(page, "Build").getAttribute("aria-pressed")) === "true" &&
      (await imode(page, "Plan").getAttribute("aria-pressed")) === "false",
  );
  const echo1 = await sendAndCollect(page, tid, "default imode");
  verify(
    "build turn → collaborationMode.mode=default on the wire",
    echo1.includes("[cm=default]"),
    echo1,
  );

  await imode(page, "Plan").click();
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.interactionMode === "plan",
  );
  verify(
    "plan mode persisted in the snapshot",
    (await imode(page, "Plan").getAttribute("aria-pressed")) === "true",
  );
  verify(
    "placeholder switches to plan copy",
    (await page.locator(".composer textarea").getAttribute("placeholder")) ===
      "Describe what you want to plan",
  );
  const echo2 = await sendAndCollect(page, tid, "plan imode");
  verify(
    "plan turn → collaborationMode.mode=plan on the wire",
    echo2.includes("[cm=plan]"),
    echo2,
  );

  await imode(page, "Build").click();
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.interactionMode === "build",
  );
  const echo3 = await sendAndCollect(page, tid, "back to build");
  verify("build restores default on the wire", echo3.includes("[cm=default]"), echo3);

  await imode(page, "Plan").click();
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.interactionMode === "plan",
  );
  await page.screenshot({ path: join(outDir, "83-interaction-mode.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("imode-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session I2: restart keeps plan; zh labels -------------------------
  s = await launch({}, "s-imode-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.interactionMode === "plan",
  );
  verify("interaction mode persisted across restart", true);
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".imode-toggle", { timeout: 10000 });
  verify(
    "toggle reflects the persisted plan mode",
    (await imode(page, "Plan").getAttribute("aria-pressed")) === "true",
  );
  const echo4 = await sendAndCollect(page, tid, "after restart");
  verify(
    "resumed thread turn still carries plan mode",
    echo4.includes("[cm=plan]"),
    echo4,
  );

  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".imode-toggle", { timeout: 10000 });
  const zhPlan = await page.locator('.imode-toggle .imode.on').innerText();
  verify("zh-Hans interaction label renders", zhPlan.trim() === "计划", zhPlan);
  await page.screenshot({ path: join(outDir, "84-interaction-mode-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("imode-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
