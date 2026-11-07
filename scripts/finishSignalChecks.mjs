// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A49 e2e — F28 finish signals (frozen turnFinished): the finish chime
// on real results only (never user stops, interruptions or continuing
// threads), the OS notification carrying silent=true when the chime
// already sounded, status-mapped bodies, the settings switch + preview,
// zh-Hans.

export async function runFinishSignalChecks({
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
        notes.push({ title, body: opts?.body, tag: opts?.tag, silent: opts?.silent });
        this.title = title;
      }
      FakeNotification.permission = "granted";
      FakeNotification.requestPermission = () => Promise.resolve("granted");
      window.Notification = FakeNotification;
      window.__notes = notes;
    });
  const notes = (page) => page.evaluate(() => window.__notes ?? []);
  const chimeCount = (page) =>
    page.evaluate(
      () => parseInt(document.documentElement.dataset.chimeCount ?? "0", 10),
    );
  const sendAndWait = async (page, threadId, text = "finish quietly") => {
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId, text },
    );
    await waitSnap(
      page,
      (x) => x.threads.find((y) => y.id === threadId)?.turn?.status === "done",
    );
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The snapshot reports "done" through state:get BEFORE the finish-signal
  // event lands renderer-side — always wait on the counter itself, never
  // assume ordering between the two channels.
  const waitChime = async (page, n, timeout = 8000) => {
    await page.waitForFunction(
      (want) =>
        parseInt(document.documentElement.dataset.chimeCount ?? "0", 10) === want,
      n,
      { timeout },
    );
  };

  const s = await launch("signal-a");
  instances.push(s);
  const { app, proc, ledger } = s;
  const page = await app.firstWindow();
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
  await select(tidA);

  // CH-01: default ON — a finished turn plays the chime even while watched.
  const c0 = await chimeCount(page);
  await sendAndWait(page, tidB);
  await waitChime(page, c0 + 1);
  verify("CH-01 done turn plays the finish chime", true, { c0 });
  const c1 = c0 + 1;

  // CH-02: chimeWhenFinished off → the next finish stays silent.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { chimeWhenFinished: false }),
  );
  await sleep(150); // snapshot hop
  await sendAndWait(page, tidB);
  await sleep(400); // a chime would have landed by now
  const c2 = await chimeCount(page);
  verify("CH-02 setting off suppresses the chime", c2 === c1, { c1, c2 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { chimeWhenFinished: true }),
  );

  // CH-03: a user stop never chimes — it was witnessed.
  await page.evaluate((id) =>
    window.tivano.invoke("turns:send", { threadId: id, text: "[mock:approval] hold" }),
    tidB,
  );
  await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tidB)?.turn?.status === "waiting-approval",
  );
  await page.evaluate((id) => window.tivano.invoke("turns:cancel", { threadId: id }), tidB);
  await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tidB)?.turn?.status === "cancelled",
  );
  await sleep(400);
  const c3 = await chimeCount(page);
  verify("CH-03 cancelled turn never chimes", c3 === c2, { c2, c3 });

  // CH-04: a queued follow-up keeps the thread working — no chime for the
  // first result, one chime when the successor actually lands. The first
  // turn parks on an approval so the enqueue order is deterministic.
  await page.evaluate((id) =>
    window.tivano.invoke("turns:send", { threadId: id, text: "[mock:approval] first leg" }),
    tidB,
  );
  await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tidB)?.turn?.status === "waiting-approval",
  );
  await page.evaluate((id) =>
    window.tivano.invoke("followUps:enqueue", { threadId: id, text: "second leg" }),
    tidB,
  );
  const c4 = await chimeCount(page);
  const apId = (await snap(page)).threads.find((y) => y.id === tidB)?.turn?.approval?.id;
  await page.evaluate(
    (a) => window.tivano.invoke("approvals:resolve", a),
    { threadId: tidB, approvalId: apId, optionId: "once" },
  );
  // First turn done → drained straight into the successor (no chime) →
  // the successor's real end chimes exactly once.
  await waitSnap(
    page,
    (x) => {
      const t = x.threads.find((y) => y.id === tidB);
      return (
        t?.turn?.status === "done" &&
        (t?.messages ?? []).filter((m) => m.role === "user").at(-1)?.content === "second leg"
      );
    },
  );
  await waitChime(page, c4 + 1);
  verify(
    "CH-04 continuing thread chimes once, for the real end",
    true,
    { c4 },
  );

  // CH-05: notification silent flag follows the chime. Unseen thread B.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { notifyOnDone: true }),
  );
  await sleep(150);
  const n0 = (await notes(page)).length;
  await sendAndWait(page, tidB);
  await page.waitForFunction(
    (want) => (window.__notes ?? []).length === want,
    n0 + 1,
    { timeout: 8000 },
  );
  const n1 = await notes(page);
  verify(
    "CH-05 chimed notification posts silent",
    n1.at(-1).silent === true && n1.at(-1).body === "Turn finished",
    n1.at(-1),
  );

  // CH-06: chime off → the notification carries its own sound again.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { chimeWhenFinished: false }),
  );
  await sleep(150);
  await sendAndWait(page, tidB);
  await page.waitForFunction(
    (want) => (window.__notes ?? []).length === want,
    n1.length + 1,
    { timeout: 8000 },
  );
  const n2 = await notes(page);
  verify(
    "CH-06 unchimed notification is not silent",
    n2.at(-1).silent === false,
    n2.at(-1),
  );

  // CH-07: a failed turn notifies with the failed body (and still chimes —
  // frozen: .failed is a real result).
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { chimeWhenFinished: true }),
  );
  await sleep(150);
  const c6 = await chimeCount(page);
  await page.evaluate((id) =>
    window.tivano.invoke("turns:send", { threadId: id, text: "[mock:fail] boom" }),
    tidB,
  );
  await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tidB)?.turn?.status === "error",
  );
  await page.waitForFunction(
    (want) => (window.__notes ?? []).length === want,
    n2.length + 1,
    { timeout: 8000 },
  );
  await waitChime(page, c6 + 1);
  const n3 = await notes(page);
  verify(
    "CH-07 failed turn → 'Stopped with an error.' + chime",
    n3.at(-1).body === "Stopped with an error." &&
      n3.at(-1).silent === true,
    n3.at(-1),
  );

  // CH-08: the settings switch renders ON by default, preview plays on ON.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  const sw = page.getByRole("switch", { name: "Chime when a turn finishes" });
  await sw.waitFor();
  verify(
    "CH-08 switch present, default on, frozen detail",
    (await sw.getAttribute("aria-checked")) === "true" &&
      (await sw.getAttribute("title")) ===
        "A soft chime, whether or not the thread is in view",
  );
  await sw.click(); // off
  await page.waitForFunction(
    () =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.settings.chimeWhenFinished === false),
    { timeout: 5000 },
  );
  const c8 = await chimeCount(page);
  // Frozen NSSound semantics: a chime in flight declines the next play —
  // leave the 0.7s window so the preview isn't honestly declined.
  await sleep(750);
  await sw.click(); // back on — the frozen preview chime plays once
  await page.waitForFunction(
    () =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.settings.chimeWhenFinished === true),
    { timeout: 5000 },
  );
  await waitChime(page, c8 + 1);
  verify("CH-09 enabling the switch previews the chime", true, { c8 });
  await page.keyboard.press("Escape");

  // CH-10: zh-Hans label + detail.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  const zhSw = page.getByRole("switch", { name: "本轮完成时播放提示音" });
  await zhSw.waitFor();
  verify(
    "CH-10 zh label + detail",
    (await zhSw.getAttribute("title")) ===
      "无论是否正在查看该对话，都会播放轻柔的提示音",
    await zhSw.getAttribute("title"),
  );
  await page.screenshot({ path: `${outDir}/chime-setting-zh.png` });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en", notifyOnDone: false }),
  );

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("signal-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
