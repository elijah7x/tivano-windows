// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F20 usage-limit e2e — opt-in setting off→plain failure, on→honest
// notice + real auto-resume (margin env-shrunk, frozen 5s floor kept),
// no-reset warning, cancel, and a handoff draft landing in a new chat.

export async function runLimitChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (label) => launchApp({ TIVANO_LIMIT_MARGIN_MS: "0" }, label);
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
  const send = (page, threadId, text) =>
    page.evaluate((a) => window.tivano.invoke("turns:send", a), {
      threadId,
      text,
    });
  const threadOf = (s, id) => s.threads.find((t) => t.id === id);
  const messages = (s, id) => threadOf(s, id).messages.map((m) => m.content);
  const CONTINUE =
    "The usage limit has reset. Continue exactly where you left off and finish the task.";
  const mkThread = async (title) => {
    const r = await page.evaluate(
      (p) => window.tivano.invoke("threads:create", p),
      { projectId: null, title },
    );
    return r.id;
  };

  let s = await launch("s-limit-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // Setting OFF: a limit-worded failure is an ordinary failed turn.
  const offThread = await mkThread("Limit off");
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), offThread);
  await send(page, offThread, "[mock:limit:2] work");
  let st = await waitSnap(page, (x) => threadOf(x, offThread)?.turn?.status === "error");
  verify(
    "LIMIT-01 setting off — limit failure is a plain failed turn",
    !(st.limitResumesAt ?? {})[offThread] &&
      !messages(st, offThread).some((m) => m.includes("Continuing automatically")),
    messages(st, offThread).at(-1),
  );

  // Setting ON: notice + wait row + real auto-resume after the 5s floor.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { autoContinueAfterLimit: true }),
  );
  const onThread = await mkThread("Limit on");
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), onThread);
  await send(page, onThread, "[mock:limit:1] work");
  st = await waitSnap(page, (x) => (x.limitResumesAt ?? {})[onThread] !== undefined);
  verify(
    "LIMIT-02 wait scheduled with honest notice",
    messages(st, onThread).some((m) => m.includes("Continuing automatically")),
    messages(st, onThread).at(-1),
  );
  const row = page.locator(".limit-wait");
  await row.waitFor({ timeout: 10000 });
  verify(
    "LIMIT-03 wait row renders the resume target",
    ((await row.textContent()) ?? "").includes("continuing at"),
    await row.textContent(),
  );
  // The resume REALLY sends the frozen continue message (~5s floor).
  st = await waitSnap(
    page,
    (x) =>
      threadOf(x, onThread)
        .messages.filter((m) => m.role === "user")
        .some((m) => m.content === CONTINUE) &&
      threadOf(x, onThread).turn?.status === "done",
    20000,
  );
  verify("LIMIT-04 auto-resume sent the frozen continue message", true);

  // No reset time → the honest warning, never a fabricated schedule.
  const noTime = await mkThread("Limit no time");
  await send(page, noTime, "[mock:limit-notime] work");
  st = await waitSnap(page, (x) => threadOf(x, noTime)?.turn?.status === "error");
  await waitSnap(page, (x) =>
    messages(x, noTime).some((m) => m.includes("did not say when it resets")),
  );
  st = await snap(page);
  verify(
    "LIMIT-05 missing reset warns honestly and never waits",
    !(st.limitResumesAt ?? {})[noTime],
    messages(st, noTime).at(-1),
  );

  // Cancel ends the wait; nothing sends afterwards.
  const cancelT = await mkThread("Limit cancel");
  await send(page, cancelT, "[mock:limit:30] work");
  await waitSnap(page, (x) => (x.limitResumesAt ?? {})[cancelT] !== undefined);
  await page.evaluate(
    (id) => window.tivano.invoke("limit:cancel", { threadId: id }),
    cancelT,
  );
  st = await waitSnap(page, (x) =>
    messages(x, cancelT).some((m) => m.includes("will not continue on its own")),
  );
  verify(
    "LIMIT-06 cancel ends the wait honestly",
    !(st.limitResumesAt ?? {})[cancelT],
  );

  // Handoff: new thread, frozen hand-off text as the composer draft.
  const handoffT = await mkThread("Limit handoff");
  await send(page, handoffT, "summarize the spec [mock:limit:30]");
  await waitSnap(page, (x) => (x.limitResumesAt ?? {})[handoffT] !== undefined);
  const before = (await snap(page)).threads.length;
  const made = await page.evaluate(
    (id) => window.tivano.invoke("limit:handoff", { threadId: id }),
    handoffT,
  );
  verify(
    "LIMIT-07 handoff builds the frozen draft",
    made.text.includes('Continue the work from the chat "Limit handoff"') &&
      made.text.includes("summarize the spec [mock:limit:30]"),
    made.text.slice(0, 120),
  );

  // A SECOND waiting thread exercises the REAL button path: clicking
  // "Hand off to a new chat" must run the renderer flow — handoff IPC,
  // draft into the new chat's composer, then select it.
  const handoff2 = await mkThread("Limit handoff two");
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), handoff2);
  await send(page, handoff2, "summarize the spec [mock:limit:30]");
  await waitSnap(page, (x) => (x.limitResumesAt ?? {})[handoff2] !== undefined);
  await page.getByRole("button", { name: "Hand off to a new chat" }).click();
  st = await waitSnap(
    page,
    (x) =>
      x.threads.length === before + 3 &&
      x.selectedThreadId !== handoff2 &&
      !(x.limitResumesAt ?? {})[handoff2],
  );
  await page.waitForSelector(".composer textarea", { timeout: 10000 });
  const draft = await page.locator(".composer textarea").inputValue();
  verify(
    "LIMIT-08 handoff draft sits in the new chat's composer",
    draft.includes("Continue the work from the chat"),
    draft.slice(0, 80),
  );
  const { join } = await import("node:path");
  await page.screenshot({ path: join(outDir, "64-limit-handoff-en.png") });

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("limit-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // zh-Hans: the wait row localizes.
  s = await launch("s-limit-b-zh");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "zh-Hans",
      autoContinueAfterLimit: true,
    }),
  );
  const zhT = await mkThread("限额");
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), zhT);
  await send(page, zhT, "[mock:limit:30] work");
  await waitSnap(page, (x) => (x.limitResumesAt ?? {})[zhT] !== undefined);
  const zhRow = page.locator(".limit-wait");
  await zhRow.waitFor({ timeout: 10000 });
  const zhText = (await zhRow.textContent()) ?? "";
  verify(
    "LIMIT-09 zh-Hans wait row renders",
    zhText.includes("已达用量限额") && zhText.includes("将于"),
    zhText,
  );
  await page.screenshot({ path: join(outDir, "65-limit-wait-zh.png") });

  const c2 = await boundedClose(app, proc);
  ledger.exited = c2.exited;
  ledger.outcome = c2.outcome;
  verify("limit-b exited cleanly", c2.exited && c2.outcome === "resolved", c2.outcome);
}
