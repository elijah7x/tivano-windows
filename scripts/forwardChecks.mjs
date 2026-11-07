// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F09 continuation e2e — Mock Provider only: forward captures a budgeted
// snapshot into a NEW thread; the frozen prompt scaffold prefixes the
// first send exactly once (mock echo shows the wire text); `sent` and
// unsent deliveries persist across restart correctly.

import { join } from "node:path";

export async function runForwardChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) => launchApp(overrides, label);
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
  const send = async (page, threadId, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
    const s = await waitSnapshot(page, (x) => {
      const t = x.threads.find((y) => y.id === threadId)?.turn;
      return t?.status === "done" || t?.status === "error";
    });
    return s.threads.find((x) => x.id === threadId);
  };
  const rowFor = (page, title) =>
    page.locator(".thread-list .row", { hasText: title }).first();

  // --- session F1: forward, one-shot delivery, restart honesty ----------
  let s = await launch({}, "s-fwd-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const src = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  const srcId = src.id;
  await send(page, srcId, "FWD-SOURCE unique question text");

  await page.locator('button[title="Forward to new thread"]').click();
  const s1 = await waitSnapshot(
    page,
    (x) => x.threads.some((t) => t.title.startsWith("Continued: ")),
  );
  const dest = s1.threads.find((t) => t.title.startsWith("Continued: "));
  verify(
    "FWD-01 forward created a selected Continued: thread",
    dest && s1.selectedThreadId === dest.id && dest.messages.length === 0,
    dest?.title,
  );
  verify(
    "FWD-02 snapshot captured source history unsent",
    dest.continuation?.sent === false &&
      dest.continuation?.context.includes("FWD-SOURCE unique question"),
    dest.continuation?.context?.slice(0, 120),
  );

  const t1 = await send(page, dest.id, "FWD-FOLLOWUP please continue");
  const reply1 = t1.messages.filter((m) => m.role === "assistant").at(-1);
  verify(
    "FWD-03 first send carried the frozen scaffold on the wire",
    reply1?.content.includes("BEGIN FORWARDED CONTEXT") &&
      reply1?.content.includes("FWD-SOURCE unique question") &&
      reply1?.content.includes("FWD-FOLLOWUP please continue"),
    reply1?.content.slice(0, 160),
  );
  const userMsg = t1.messages.find((m) => m.role === "user");
  verify(
    "FWD-04 user bubble shows only the user's own text",
    userMsg?.content === "FWD-FOLLOWUP please continue",
    userMsg?.content,
  );
  verify(
    "FWD-05 delivery marked sent",
    t1.continuation?.sent === true,
    t1.continuation?.sent,
  );

  const t2 = await send(page, dest.id, "FWD-SECOND turn");
  const reply2 = t2.messages.filter((m) => m.role === "assistant").at(-1);
  verify(
    "FWD-06 second send does not re-inject the snapshot",
    !reply2?.content.includes("BEGIN FORWARDED CONTEXT"),
    reply2?.content.slice(0, 120),
  );
  await page.screenshot({ path: join(outDir, "85-forward.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("fwd-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session F2: restart keeps sent=true; unsent survives -------------
  s = await launch({}, "s-fwd-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s2 = await waitSnapshot(
    page,
    (x) => x.threads.find((t) => t.id === dest.id)?.continuation?.sent === true,
  );
  verify("FWD-07 sent flag persisted across restart", true);

  // A fresh forward made pre-close in the same store carries an unsent
  // snapshot; it must still deliver once after the restart.
  await page.evaluate((id) => window.tivano.invoke("threads:forward", { threadId: id }), srcId);
  const s3 = await waitSnapshot(
    page,
    (x) => x.threads.filter((t) => t.title.startsWith("Continued: ")).length >= 2,
  );
  const dest2 = s3.threads
    .filter((t) => t.title.startsWith("Continued: "))
    .find((t) => t.id !== dest.id);
  verify("FWD-08 second forward is a distinct unsent thread", !!dest2, dest2?.id);
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), dest2.id);
  const t3 = await send(page, dest2.id, "FWD-AFTER-RESTART go");
  const reply3 = t3.messages.filter((m) => m.role === "assistant").at(-1);
  verify(
    "FWD-09 post-restart first send still delivers once",
    reply3?.content.includes("BEGIN FORWARDED CONTEXT") && t3.continuation?.sent === true,
    reply3?.content.slice(0, 120),
  );

  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  verify(
    "FWD-10 zh-Hans forward title renders",
    (await page.locator('button[title="转发到新对话"]').count()) === 1,
  );
  await page.screenshot({ path: join(outDir, "86-forward-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("fwd-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
