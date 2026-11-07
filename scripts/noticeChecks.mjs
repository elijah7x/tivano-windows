// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 notice e2e — Mock provider only: a provider notice lands as a
// structured `.notice-row` at the right severity, folds into the finished
// turn's steps, and persists across restart. Synthetic output only.

import { join } from "node:path";

export async function runNoticeChecks({
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

  // --- session NT1: warning notice renders live, folds, persists --------
  let s = await launch("s-notice-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid = await page.evaluate(
    (p) => window.tivano.invoke("threads:create", p).then((t) => t.id),
    { projectId: null, title: "Notice" },
  );

  await sendAndWait(page, tid, "[mock:notice:warning] hi");
  const s1 = await waitSnap(
    page,
    (x) =>
      x.threads.find((y) => y.id === tid)?.messages.some((m) => m.kind === "notice"),
  );
  const th = s1.threads.find((y) => y.id === tid);
  const nm = th.messages.find((m) => m.kind === "notice");
  verify(
    "NOTICE-01 notice persisted structured with level + turnId",
    nm?.role === "system" &&
      nm?.noticeLevel === "warning" &&
      nm?.turnId === th.turn?.id &&
      nm?.content.includes("warning notice"),
    nm,
  );
  await page.waitForSelector(".notice-row.lv-warning", { timeout: 10000 });
  const liveText = await page.locator(".notice-row.lv-warning .notice-text").innerText();
  verify("NOTICE-02 warning pill renders live with notice text", liveText.includes("warning notice"), liveText);

  // Second turn makes the first a finished group: notice folds into steps.
  await sendAndWait(page, tid, "plain follow-up");
  const steps = page.locator(".turn-steps").first();
  await steps.locator("summary").click();
  const folded = steps.locator(".notice-row.lv-warning");
  verify("NOTICE-03 notice folded into the finished turn's steps", (await folded.count()) === 1, await folded.count());
  await page.screenshot({ path: join(outDir, "89-notice.png") });

  // Error-level pill (zh locale — glyphs are locale-free).
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await sendAndWait(page, tid, "[mock:notice:error] again");
  await page.waitForSelector(".notice-row.lv-error", { timeout: 10000 });
  verify("NOTICE-04 error notice renders as danger pill", true);
  await page.screenshot({ path: join(outDir, "90-notice-error-zh.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("notice-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session NT2: restart keeps the structured notice ------------------
  s = await launch("s-notice-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s2 = await waitSnap(
    page,
    (x) =>
      (x.threads.find((y) => y.id === tid)?.messages.filter((m) => m.kind === "notice").length ?? 0) >= 2,
  );
  const th2 = s2.threads.find((y) => y.id === tid);
  const levels = th2.messages.filter((m) => m.kind === "notice").map((m) => m.noticeLevel);
  verify(
    "NOTICE-05 notices persisted across restart with levels",
    levels.includes("warning") && levels.includes("error"),
    levels,
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  const stepsB = page.locator(".turn-steps").first();
  await stepsB.locator("summary").click();
  verify(
    "NOTICE-06 persisted notice renders inside finished steps",
    (await stepsB.locator(".notice-row").count()) >= 1,
    await stepsB.locator(".notice-row").count(),
  );
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("notice-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
