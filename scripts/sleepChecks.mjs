// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F29 task-sleep-prevention e2e — the real Electron powerSaveBlocker in
// the launched instance holds a token only while work runs; snapshot's
// sleepPreventionActive mirrors held state honestly.

import { join } from "node:path";

export async function runSleepChecks({ launch: launchApp, instances, snap, outDir, check, boundedClose }) {
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
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };

  const s1 = await launch("sleep-main");
  instances.push(s1);
  const { app, proc, ledger } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // SLP-01: the settings picker renders the three frozen modes.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector('.modal', { timeout: 8000 });
  const modes = await page
    .locator('.modal [role="radiogroup"][aria-label="Prevent sleep while tasks are running"] .choice')
    .allInnerTexts();
  verify(
    "SLP-01 sleep picker renders off/system/display",
    modes.join("|") === "Off|Keep computer awake|Keep computer and screen awake",
    modes,
  );

  // SLP-02: choosing system holds no token while nothing runs.
  await page
    .locator('.modal [role="radiogroup"][aria-label="Prevent sleep while tasks are running"] .choice', { hasText: "Keep computer awake" })
    .click();
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 8000 });
  let s = await waitSnap(page, (x) => x.settings.taskSleepMode === "system");
  verify(
    "SLP-02 system mode persists; idle holds no token",
    s.settings.taskSleepMode === "system" && !s.sleepPreventionActive,
    { mode: s.settings.taskSleepMode, active: s.sleepPreventionActive },
  );

  // SLP-03: a running turn holds the real token; cancel releases it.
  await page.locator('button[title="New thread"]').click();
  const tid = (await snap(page)).selectedThreadId;
  await page.evaluate(
    (id) => window.tivano.invoke("turns:send", { threadId: id, text: "[mock:approval] hold" }),
    tid,
  );
  s = await waitSnap(page, (x) => x.sleepPreventionActive === true);
  verify("SLP-03 running turn holds the prevention token", true);
  await page.evaluate(
    (id) => window.tivano.invoke("turns:cancel", { threadId: id }),
    tid,
  );
  s = await waitSnap(page, (x) => x.sleepPreventionActive === undefined || x.sleepPreventionActive === false);
  verify("SLP-04 token released when the turn stops", true);

  // SLP-05: display mode also activates on real work.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { taskSleepMode: "display" }),
  );
  await page.evaluate(
    (id) => window.tivano.invoke("turns:send", { threadId: id, text: "[mock:approval] hold" }),
    tid,
  );
  s = await waitSnap(page, (x) => x.sleepPreventionActive === true);
  verify("SLP-05 display mode holds a token during work", true);
  await page.evaluate(
    (id) => window.tivano.invoke("turns:cancel", { threadId: id }),
    tid,
  );
  await waitSnap(page, (x) => !x.sleepPreventionActive);

  // SLP-06: off holds nothing even while a turn runs.
  await page.evaluate(() => window.tivano.invoke("settings:set", { taskSleepMode: "off" }));
  await page.evaluate(
    (id) => window.tivano.invoke("turns:send", { threadId: id, text: "[mock:approval] hold" }),
    tid,
  );
  await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "waiting-approval",
  );
  s = await snap(page);
  verify("SLP-06 off mode never holds a token", !s.sleepPreventionActive);
  await page.evaluate(
    (id) => window.tivano.invoke("turns:cancel", { threadId: id }),
    tid,
  );

  // SLP-07: zh-Hans labels render on the picker.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector('.modal', { timeout: 8000 });
  const zhModes = await page
    .locator('.modal [role="radiogroup"][aria-label="任务运行时阻止睡眠"] .choice')
    .allInnerTexts();
  await page.screenshot({ path: join(outDir, "92-sleep-setting-zh.png") });
  verify(
    "SLP-07 zh-Hans sleep picker renders",
    zhModes.join("|") === "关闭|保持电脑唤醒|保持电脑与屏幕唤醒",
    zhModes,
  );
  await page.locator(".modal-actions .primary").click();
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("SLP-08 instance closed cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
