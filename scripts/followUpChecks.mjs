// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F08 follow-up queue e2e checks — against the MOCK provider only:
// queue-behind-running, ordered drain on completion, bundle merge into
// one message, send-now (stop→send), Enter-while-running interrupt-send,
// stopped turn never drains, restart persistence, zh-Hans bar. Nothing
// here proves a real provider.

import { join } from "node:path";

export async function runFollowUpChecks({
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
  const newThread = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".group-name");
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };
  const threadOf = async (page, id) => (await snap(page)).threads.find((x) => x.id === id);
  const userTexts = async (page, id) =>
    (await threadOf(page, id)).messages.filter((m) => m.role === "user").map((m) => m.content);
  const sendText = async (page, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
  };
  const queueDraft = async (page, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.locator(".queue-btn").click();
  };

  // --- session F1: queue behind running, bundle, ordered drain ------------
  let s = await launch("s-followups-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const threadId = await newThread(page, "Queue Proj");

  await sendText(page, "please [mock:approval] hold the line");
  await page.waitForSelector(".approval", { timeout: 10000 });

  // Queue two drafts behind the running turn via the real Queue button.
  await queueDraft(page, "first queued");
  await queueDraft(page, "second queued");
  await page.waitForSelector(".followup-row", { timeout: 10000 });
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return (t?.followUps?.length ?? 0) === 2;
  });
  verify(
    "queue bar shows both queued rows while the turn waits",
    (await page.locator(".followup-row").count()) === 2,
  );

  // Bundle the second onto the first via the row's bundle button.
  await page.locator('.followup-row button[title="Bundle with the previous item"]').nth(1).click();
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    const items = t?.followUps ?? [];
    return items.length === 2 && items[0].bundleId && items[0].bundleId === items[1].bundleId;
  });
  verify("bundled pair shares one bundle id", true);
  await page.screenshot({ path: join(outDir, "70-followup-queue.png") });

  // Resolve the approval → turn completes → the bundle goes out as ONE
  // merged user message, in order.
  await page.getByRole("button", { name: "Allow once" }).click();
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return t?.turn?.status === "done" && (t.followUps ?? []).length === 0;
  });
  const texts1 = await userTexts(page, threadId);
  verify(
    "bundle merged into ONE message after completion, in order",
    texts1.length === 2 && texts1[1] === "first queued\n\nsecond queued",
    texts1,
  );

  // --- send-now: stops the running turn, queued text goes out -------------
  await sendText(page, "again [mock:approval] hold");
  await page.waitForSelector(".approval", { timeout: 10000 });
  await queueDraft(page, "fire me now");
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return (t?.followUps?.length ?? 0) === 1;
  });
  const queuedId = (await threadOf(page, threadId)).followUps[0].id;
  await page.locator('.followup-row button[title="Send now — stops the running turn first"]').click();
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return t?.turn?.status === "done" && t.messages.some((m) => m.role === "user" && m.content === "fire me now");
  });
  verify(
    "send-now: stop landed then the queued item became a turn",
    (await threadOf(page, threadId)).followUps.every((i) => i.id !== queuedId),
  );

  // --- Enter while running → interrupt-send -------------------------------
  await sendText(page, "third [mock:approval] hold");
  await page.waitForSelector(".approval", { timeout: 10000 });
  await page.locator(".composer textarea").fill("interrupt and send this");
  await page.locator(".composer textarea").press("Enter");
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return (
      t?.turn?.status === "done" &&
      t.messages.some((m) => m.role === "user" && m.content === "interrupt and send this")
    );
  });
  verify("Enter-while-running interrupt-send fired on the stop", true);

  // --- stopped turn: queued items WAIT (frozen: no drain) -----------------
  await sendText(page, "fourth [mock:approval] hold");
  await page.waitForSelector(".approval", { timeout: 10000 });
  await queueDraft(page, "stays queued");
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return (t?.followUps?.length ?? 0) === 1;
  });
  await page.getByRole("button", { name: "Stop" }).click();
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return t?.turn?.status === "cancelled";
  });
  await page.waitForTimeout(300);
  const afterStop = await threadOf(page, threadId);
  verify(
    "stopped turn never drains the queue",
    (afterStop.followUps ?? []).length === 1 &&
      (await userTexts(page, threadId)).every((m) => m !== "stays queued"),
    { followUps: afterStop.followUps?.length, users: await userTexts(page, threadId) },
  );
  // The bar stays visible so the user can send/remove explicitly.
  verify(
    "queue bar remains after stop for explicit action",
    (await page.locator(".followup-row").count()) === 1,
  );
  // Remove it via the row button — queue empties.
  await page.locator('.followup-row button[title="Remove"]').click();
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId);
    return (t?.followUps ?? []).length === 0;
  });
  verify("remove drops the queued item", true);
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("followups-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }

  // --- session F2: restart persists the queue, never auto-sends -----------
  s = await launch("s-followups-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const threadId2 = await newThread(page, "Restart Proj");
  await sendText(page, "fifth [mock:approval] hold");
  await page.waitForSelector(".approval", { timeout: 10000 });
  await queueDraft(page, "survives restart");
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId2);
    return (t?.followUps?.length ?? 0) === 1;
  });
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("followups-b pre-restart exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }

  s = await launch("s-followups-c-restart");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), threadId2);
  const restored = await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId2);
    return (t?.followUps?.length ?? 0) === 1 && t.turn?.status === "interrupted";
  });
  verify(
    "queue persisted across restart; in-flight turn honestly interrupted",
    restored.threads.find((x) => x.id === threadId2)?.followUps?.[0]?.text === "survives restart",
  );
  await page.waitForTimeout(400);
  const stillQueued = await threadOf(page, threadId2);
  verify(
    "restart never auto-sends the queue",
    (stillQueued.followUps ?? []).length === 1 &&
      !(await userTexts(page, threadId2)).includes("survives restart"),
  );
  // Explicit send-now while idle still works after restart.
  await page.locator('.followup-row button[title="Send now — stops the running turn first"]').click();
  await waitSnap(page, (s2) => {
    const t = s2.threads.find((x) => x.id === threadId2);
    return t?.turn?.status === "done";
  });
  verify(
    "explicit send-now after restart sends the persisted item",
    (await userTexts(page, threadId2)).includes("survives restart"),
  );
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("followups-c exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }

  // --- session F3: zh-Hans queue bar --------------------------------------
  s = await launch("s-followups-zh");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  // Build the project/thread over IPC — sidebar titles are localized.
  const proj = await page.evaluate(() =>
    window.tivano.invoke("projects:create", { name: "队列项目" }),
  );
  const th = await page.evaluate((pid) =>
    window.tivano.invoke("threads:create", { projectId: pid }), proj.id ?? proj,
  );
  const zhThreadId = th.id ?? th;
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), zhThreadId);
  await sendText(page, "sixth [mock:approval] hold");
  await page.waitForSelector(".approval", { timeout: 10000 });
  await queueDraft(page, "排队一条");
  await page.waitForSelector(".followup-row", { timeout: 10000 });
  const zhBar = await page.locator(".followup-queue").innerText();
  verify(
    "zh-Hans queue bar renders localized",
    zhBar.includes("排队") && (await page.locator(".queue-btn").innerText()) === "排队",
    zhBar.slice(0, 80),
  );
  await page.screenshot({ path: join(outDir, "71-followup-queue-zh.png") });
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("followups-zh exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }
}
