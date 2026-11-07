// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F28 completion notifications e2e — opt-in setting, an UNSEEN result
// posts a notification, a watched completion stays silent, zh-Hans body.
// The Notification API is stubbed in the page — no real OS interaction.

export async function runNotifyChecks({
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
  const stubNotifications = (page) =>
    page.evaluate(() => {
      const notes = [];
      function FakeNotification(title, opts) {
        notes.push({ title, body: opts?.body, tag: opts?.tag });
        this.title = title;
      }
      FakeNotification.permission = "granted";
      FakeNotification.requestPermission = () => Promise.resolve("granted");
      window.Notification = FakeNotification;
      window.__notes = notes;
    });
  const notes = (page) => page.evaluate(() => window.__notes ?? []);
  const sendAndWait = async (page, threadId) => {
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId, text: "finish quietly" },
    );
    await waitSnap(
      page,
      (x) => x.threads.find((y) => y.id === threadId)?.turn?.status === "done",
    );
  };

  let s = await launch("s-notify-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await stubNotifications(page);

  const mkThread = async (title) => {
    const r = await page.evaluate(
      (p) => window.tivano.invoke("threads:create", p),
      { projectId: null, title },
    );
    return r.id;
  };
  const select = (id) =>
    page.evaluate((i) => window.tivano.invoke("threads:select", { id: i }), id);

  const tidA = await mkThread("Watch thread");
  const tidB = await mkThread("Background thread");

  // Setting OFF: an unseen completion still posts nothing.
  await select(tidA);
  await sendAndWait(page, tidB);
  verify("NOTIFY-01 setting off — unseen completion stays silent", (await notes(page)).length === 0);

  // Enable the setting, then B finishing while A is on screen notifies.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { notifyOnDone: true }),
  );
  await sendAndWait(page, tidB);
  const n1 = await notes(page);
  verify(
    "NOTIFY-02 unseen completion posts one notification",
    n1.length === 1 && n1[0].title === "Background thread" && n1[0].body === "Turn finished",
    n1,
  );

  // A watched completion stays silent.
  await sendAndWait(page, tidA);
  verify("NOTIFY-03 watched completion posts nothing", (await notes(page)).length === 1);

  // zh-Hans localizes the body.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await sendAndWait(page, tidB);
  const n3 = await notes(page);
  verify(
    "NOTIFY-04 zh-Hans notification body",
    n3.length === 2 && n3[1].body === "轮次完成",
    n3[1],
  );

  // Setting persists for the snapshot consumers.
  const snapNow = await snap(page);
  verify("NOTIFY-05 setting persisted in the snapshot", snapNow.settings.notifyOnDone === true);

  // The settings switch renders checked under zh-Hans (still set above).
  const { join } = await import("node:path");
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  const sw = page.getByRole("switch", { name: "轮次完成时通知我" });
  verify(
    "NOTIFY-06 settings switch renders checked",
    (await sw.getAttribute("aria-checked")) === "true" &&
      (await sw.textContent())?.includes("轮次完成时通知我"),
    await sw.textContent(),
  );
  await page.screenshot({ path: join(outDir, "63-notify-setting-zh.png") });
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("notify-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
