// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F28 unread-mark e2e — an unseen finished turn marks its row + head
// count; selecting spends the mark; a user-cancelled turn never marks.

import { join } from "node:path";

export async function runUnreadChecks({ launch: launchApp, instances, snap, outDir, check, boundedClose }) {
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

  const s1 = await launch("unread-main");
  instances.push(s1);
  const { app, proc, ledger } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Unread Proj");
  await page.keyboard.press("Enter");
  await page.waitForSelector('button[title="New thread in Unread Proj"]');
  await page.locator('button[title="New thread in Unread Proj"]').click();
  const watching = (await snap(page)).selectedThreadId;
  await page.locator('button[title="New thread in Unread Proj"]').click();
  const worker = (await snap(page)).selectedThreadId;
  await page.evaluate(
    ([a, b]) => {
      window.tivano.invoke("threads:rename", { id: a, title: "UNREAD-WATCHING" });
      window.tivano.invoke("threads:rename", { id: b, title: "UNREAD-WORKER" });
    },
    [watching, worker],
  );

  // Send on the worker while LOOKING at it → no unread (witnessed).
  await page.locator(".composer textarea").fill("seen finish");
  await page.keyboard.press("Enter");
  await waitSnap(page, (x) => x.threads.find((y) => y.id === worker)?.turn?.status === "done");
  let s = await snap(page);
  verify(
    "UNREAD-01 witnessed completion leaves no mark",
    !s.threads.find((y) => y.id === worker)?.hasUnread,
    s.threads.find((y) => y.id === worker)?.unreadStatus,
  );

  // Switch to the other thread; send on the worker via IPC → unseen done.
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), watching);
  await page.evaluate(
    (id) => window.tivano.invoke("turns:send", { threadId: id, text: "unseen finish" }),
    worker,
  );
  s = await waitSnap(page, (x) => x.threads.find((y) => y.id === worker)?.turn?.status === "done");
  verify(
    "UNREAD-02 unseen completion marks the thread",
    s.threads.find((y) => y.id === worker)?.hasUnread === true &&
      s.threads.find((y) => y.id === worker)?.unreadStatus === "done",
  );
  await page.waitForSelector('.row:has-text("UNREAD-WORKER") .unread-mark', { timeout: 10000 });
  verify("UNREAD-03 row shows the unread mark", true);
  // The badge reflects the WHOLE unread set — earlier sessions in this
  // shared store may hold their own marks. Assert parity with the
  // snapshot-derived count, and that ours is among them.
  s = await snap(page);
  const expected = s.threads.filter((y) => y.hasUnread && !y.isArchived).length;
  const count = await page.locator(".unread-count").innerText().catch(() => "");
  verify(
    "UNREAD-04 head badge counts all unread marks",
    count.trim() === String(expected) && expected >= 1,
    `${count} vs ${expected}`,
  );
  await page.screenshot({ path: join(outDir, "85-unread-row.png") });

  // Selecting spends the mark exactly once — row and badge clear.
  await page.locator('.row:has-text("UNREAD-WORKER")').click();
  s = await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === worker)?.hasUnread === false,
  );
  verify("UNREAD-05 selecting spends the mark", true);
  s = await snap(page);
  const remaining = s.threads.filter((y) => y.hasUnread && !y.isArchived).length;
  verify(
    "UNREAD-06 badge dropped by exactly the spent mark",
    remaining === expected - 1,
    `${remaining} vs ${expected - 1}`,
  );

  // F28 dock badge — the real app.setBadgeCount value in main
  // (macOS dock on this host; a Windows no-op until taskbar overlay).
  const dockBadge = () =>
    app.evaluate(({ app: eapp }) => (eapp.dock ? eapp.dock.getBadge() : ""));
  const badgeNow = await dockBadge();
  verify(
    "UNREAD-09 dock badge matches live unread count",
    badgeNow === (remaining > 0 ? String(remaining) : ""),
    badgeNow,
  );

  // A user-cancelled turn is never unread — approval pause then stop.
  await page.evaluate(
    (id) => window.tivano.invoke("turns:send", { threadId: id, text: "[mock:approval] hold" }),
    worker,
  );
  await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === worker)?.turn?.status === "waiting-approval",
  );
  await page.evaluate(
    (id) => window.tivano.invoke("turns:cancel", { threadId: id }),
    worker,
  );
  s = await waitSnap(page, (x) => x.threads.find((y) => y.id === worker)?.turn?.status === "cancelled");
  verify(
    "UNREAD-07 user stop leaves no mark",
    !s.threads.find((y) => y.id === worker)?.hasUnread,
  );
  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("UNREAD-08 instance closed cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
