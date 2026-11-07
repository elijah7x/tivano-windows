// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 thread titles e2e — Mock provider only: a generated title replaces
// the prompt fallback while the option is on, "off" keeps the fallback,
// and a user rename is never clobbered. Deterministic synthetic titles.

import { join } from "node:path";

export async function runTitleChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
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
  const mkThread = async (page) =>
    page.evaluate(
      (p) => window.tivano.invoke("threads:create", p).then((t) => t.id),
      { projectId: null, title: "New thread" },
    );
  const sendAndWait = async (page, threadId, text) => {
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId, text },
    );
    await waitSnap(
      page,
      (x) => x.threads.find((y) => y.id === threadId)?.turn?.status === "done",
    );
  };
  const titleOf = (s, id) => s.threads.find((y) => y.id === id)?.title;

  // --- session TT1: automatic generation + persistence ------------------
  let s = await launch("s-title-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid = await mkThread(page);
  await sendAndWait(page, tid, "fix the login flow");
  const s1 = await waitSnap(page, (x) => titleOf(x, tid) === "Fix the login flow");
  verify("TITLE-01 generated title replaced the prompt fallback", titleOf(s1, tid) === "Fix the login flow", titleOf(s1, tid));
  // Sidebar shows it too (not just the snapshot).
  const row = page.locator(".thread-list .row", { hasText: "Fix the login flow" });
  await row.first().waitFor({ timeout: 10000 });
  verify("TITLE-02 sidebar row shows the generated title", (await row.count()) >= 1, await row.count());

  // A user rename wins over nothing pending — and stays after later turns.
  await page.evaluate((id) => window.tivano.invoke("threads:rename", { id, title: "My own name" }), tid);
  await sendAndWait(page, tid, "another request");
  const s2 = await waitSnap(page, (x) => titleOf(x, tid) === "My own name" && x.threads.find((y) => y.id === tid)?.turn?.status === "done");
  verify("TITLE-03 user rename survived the second turn", titleOf(s2, tid) === "My own name", titleOf(s2, tid));

  // off → prompt-derived fallback stays.
  await page.evaluate(() => window.tivano.invoke("settings:set", { textGeneration: "off" }));
  const tid2 = await mkThread(page);
  await sendAndWait(page, tid2, "fix the crash on startup");
  const s3 = await waitSnap(page, (x) => x.threads.find((y) => y.id === tid2)?.turn?.status === "done");
  await new Promise((r) => setTimeout(r, 300)); // let any late generation land
  verify("TITLE-04 off keeps the prompt fallback", titleOf(s3, tid2) === "fix the crash on startup", titleOf(s3, tid2));
  await page.evaluate(() => window.tivano.invoke("settings:set", { textGeneration: "automatic" }));

  // zh settings section screenshot.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".sidebar-foot button.row").last().click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  const group = page.locator('.modal [role="radiogroup"][aria-label="对话标题"]');
  await group.waitFor({ timeout: 10000 });
  const heads = await page.locator(".modal h3").allInnerTexts();
  const groupText = await group.innerText();
  verify(
    "TITLE-05 zh text-generation section renders",
    heads.includes("文本生成") && groupText.includes("自动") && groupText.includes("关闭"),
    { heads, groupText },
  );
  await page.screenshot({ path: join(outDir, "91-title-gen-zh.png") });
  await page.locator(".modal-actions .primary").click();
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("title-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session TT2: restart keeps generated + fallback titles ------------
  s = await launch("s-title-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s4 = await waitSnap(page, (x) => titleOf(x, tid) === "My own name");
  verify(
    "TITLE-06 titles persisted across restart",
    titleOf(s4, tid) === "My own name" && titleOf(s4, tid2) === "fix the crash on startup",
    [titleOf(s4, tid), titleOf(s4, tid2)],
  );
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("title-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
