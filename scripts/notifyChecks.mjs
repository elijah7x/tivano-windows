// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F28 / P2-62 completion notifications e2e — always notifies on an
// UNSEEN result, a watched completion stays silent, zh-Hans body, and
// retired Settings switches are gone.
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

  // B finishing while A is on screen notifies automatically (switch retired in v3.0.0).
  await select(tidA);
  await sendAndWait(page, tidB);
  const n1 = await notes(page);
  verify(
    "NOTIFY-01 unseen completion posts one notification by default",
    n1.length === 1 && n1[0].title === "Background thread" && n1[0].body === "Turn finished",
    n1,
  );

  // A watched completion stays silent.
  await sendAndWait(page, tidA);
  verify("NOTIFY-02 watched completion posts nothing", (await notes(page)).length === 1);

  // zh-Hans localizes the body.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await sendAndWait(page, tidB);
  const n3 = await notes(page);
  verify(
    "NOTIFY-03 zh-Hans notification body",
    n3.length === 2 && n3[1].body === "轮次完成",
    n3[1],
  );

  // Retired switches and commit-message instructions are absent under en
  // (using canonical English keys with a live switch anchor so the check
  // cannot pass vacuously), then capture the Settings modal under zh-Hans.
  const { join } = await import("node:path");
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  verify(
    "NOTIFY-04 retired switches absent in Settings",
    (await page.getByRole("switch", { name: "Chime when a turn finishes" }).count()) === 1 &&
      (await page.getByRole("switch", { name: "Notify when a turn finishes" }).count()) === 0 &&
      (await page.getByRole("switch", { name: "Concise AI replies" }).count()) === 0 &&
      (await page.locator(".modal", { hasText: "Commit-message instructions" }).count()) === 0,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page.screenshot({ path: join(outDir, "63-notify-setting-zh.png") });
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("notify-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
