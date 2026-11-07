// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 font-size stepping e2e — real computedStyle evidence that the three
// frozen categories move independently: interface chrome via --fs-ui-off,
// conversation text via --fs-content-off, code via --fs-code-off.

export async function runFontSizeChecks({ launch: launchApp, instances, snap, check, boundedClose }) {
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
  const px = async (page, sel) =>
    page.evaluate(
      (s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize),
      sel,
    );

  const s1 = await launch("fonts-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // A real assistant message gives us .msg (content) and .msg code (code)
  // elements to measure — the mock reply carries a fenced code block.
  await page.locator('button[title="New thread"]').click();
  const tid = (await snap(page)).selectedThreadId;
  await page.evaluate((id) => window.tivano.invoke("turns:send", { threadId: id, text: "measure me" }), tid);
  await waitSnap(page, (x) => x.threads.find((t) => t.id === tid)?.turn?.status === "done");
  await page.waitForSelector(".msg code", { timeout: 8000 });

  // FS-01: frozen defaults on screen — 14/15/13 pt, reset disabled.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  const rows = page.locator(".fs-row");
  verify("FS-01 three frozen rows render", (await rows.count()) === 3);
  const labels = await page.locator(".fs-value").allInnerTexts();
  verify(
    "FS-01b default values are 14/15/13 pt",
    labels.join("|") === "14 pt|15 pt|13 pt",
    labels,
  );
  verify(
    "FS-01c reset disabled at defaults",
    (await page.locator(".fs-reset").isDisabled()) === true,
  );

  // FS-02: interface +1 moves chrome text exactly one point.
  const bodyBefore = await px(page, "body");
  await page.locator('.fs-row[data-cat="ui"] .fs-step[aria-label="Increase font size"]').click();
  await waitSnap(page, (x) => x.settings.fontSizes?.ui === 15);
  const bodyAfter = await px(page, "body");
  verify(
    "FS-02 interface step adds one point to chrome text",
    Math.abs(bodyAfter - bodyBefore - 1) < 0.01,
    { bodyBefore, bodyAfter },
  );

  // FS-03: content +1 moves message text, not chrome.
  const msgBefore = await px(page, ".msg.assistant");
  await page.locator('.fs-row[data-cat="content"] .fs-step[aria-label="Increase font size"]').click();
  await waitSnap(page, (x) => x.settings.fontSizes?.content === 16);
  const msgAfter = await px(page, ".msg.assistant");
  const bodyAfterContent = await px(page, "body");
  verify(
    "FS-03 content step moves conversation text only",
    Math.abs(msgAfter - msgBefore - 1) < 0.01 && Math.abs(bodyAfterContent - bodyAfter) < 0.01,
    { msgBefore, msgAfter, bodyAfterContent },
  );

  // FS-04: code +1 moves chat code text only.
  const codeBefore = await px(page, ".msg code");
  await page.locator('.fs-row[data-cat="code"] .fs-step[aria-label="Increase font size"]').click();
  await waitSnap(page, (x) => x.settings.fontSizes?.code === 14);
  const codeAfter = await px(page, ".msg code");
  verify(
    "FS-04 code step moves code text only",
    Math.abs(codeAfter - codeBefore - 1) < 0.01,
    { codeBefore, codeAfter },
  );

  // FS-05: reset restores the frozen defaults and disables again.
  await page.locator(".fs-reset").click();
  await waitSnap(
    page,
    (x) =>
      x.settings.fontSizes?.ui === 14 &&
      x.settings.fontSizes?.content === 15 &&
      x.settings.fontSizes?.code === 13,
  );
  verify(
    "FS-05 reset restores 14/15/13 and disables",
    (await page.locator(".fs-reset").isDisabled()) === true &&
      Math.abs((await px(page, "body")) - 14.5) < 0.01,
  );

  // FS-06: frozen bounds — at 18 the plus step is disabled, at 12 minus
  // is. (Out-of-range payloads are refused by IPC validation; the
  // write-time clamp itself is covered by the unit suite.)
  await page.evaluate(() => window.tivano.invoke("settings:set", { fontSizes: { ui: 18 } }));
  await waitSnap(page, (x) => x.settings.fontSizes?.ui === 18);
  verify(
    "FS-06a at the top bound plus is disabled",
    (await page.locator('.fs-row[data-cat="ui"] .fs-step[aria-label="Increase font size"]').isDisabled()) === true,
  );
  await page.evaluate(() => window.tivano.invoke("settings:set", { fontSizes: { ui: 12 } }));
  await waitSnap(page, (x) => x.settings.fontSizes?.ui === 12);
  verify(
    "FS-06b at the bottom bound minus is disabled",
    (await page.locator('.fs-row[data-cat="ui"] .fs-step[aria-label="Decrease font size"]').isDisabled()) === true,
  );
  // FS-06c: an out-of-range payload is refused at the IPC boundary.
  const rejected = await page.evaluate(() =>
    window.tivano
      .invoke("settings:set", { fontSizes: { ui: 99 } })
      .then(() => "accepted")
      .catch((e) => String(e)),
  );
  verify("FS-06c out-of-range font size refused by IPC validation", rejected !== "accepted", rejected);
  await page.evaluate(() => window.tivano.invoke("settings:set", { fontSizes: { ui: 14 } }));
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 8000 });

  // FS-07: persisted across a real relaunch.
  const c = await boundedClose(app, proc);
  verify("FS-07a fonts instance closed cleanly", c.outcome === "resolved", c);
  const s2 = await launch("fonts-relaunch");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const st = await snap(page2);
  verify(
    "FS-07b settings persist across restart",
    st.settings.fontSizes?.ui === 14,
    st.settings.fontSizes,
  );

  // FS-08: zh labels render the frozen translations.
  await page2.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page2.locator(".sidebar-foot button.row").click();
  await page2.waitForSelector(".modal", { timeout: 8000 });
  const heads = await page2.locator(".fs-title").allInnerTexts();
  verify(
    "FS-08 zh row titles localized",
    heads.join("|") === "界面字号|内容字号|代码字号",
    heads,
  );
  await page2.locator(".modal-actions .primary").click();
  await page2.waitForSelector(".modal", { state: "detached", timeout: 8000 });
  await page2.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const c2 = await boundedClose(s2.app, s2.proc);
  verify("FS-09 relaunch instance closed cleanly", c2.outcome === "resolved", c2);
}
