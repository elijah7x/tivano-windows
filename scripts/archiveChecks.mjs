// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F02 archive management e2e — frozen ArchiveSettingsPage port: grouped
// rows, search/project/chat-type filters, per-row Restore/Delete with
// the confirmBeforeDeleting gate, filtered Delete-all, and the IPC
// boundary that refuses to delete non-archived threads.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function runArchiveChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  boundedClose,
  dataRoot,
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
  const waitStore = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 40));
    }
    return last;
  };
  const openSettings = async (page) => {
    await page.locator(".sidebar-foot button.row").click();
    await page.waitForSelector(".archive-section", { timeout: 10000 });
    await page.waitForSelector(".archive-picker", { timeout: 10000 });
  };

  // Seed two projects and archived/live threads exactly as the store
  // persists them (archive state is a persisted flag, no UI needed).
  const pidA = randomUUID();
  const pidB = randomUUID();
  const mk = (title, projectId, isArchived) => ({
    id: randomUUID(),
    projectId,
    title,
    isArchived,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    turn: null,
    sessionGrants: [],
  });
  const t1 = mk("archived alpha notes", pidA, true);
  const t2 = mk("archived beta plan", pidA, true);
  const t3 = mk("archived gamma stray", null, true);
  const live = mk("live thread", pidB, false);
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.projects.push(
    { id: pidA, name: "proj-a", createdAt: Date.now(), expanded: true },
    { id: pidB, name: "proj-b", createdAt: Date.now(), expanded: true },
  );
  doc.threads.push(t1, t2, t3, live);
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));

  const s1 = await launch("archive-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await openSettings(page);

  // ARCH-01: section chrome — search field, both pickers, delete-all.
  verify("ARCH-01", (await page.locator(".archive-search").count()) === 1
    && (await page.locator(".archive-picker").count()) === 2
    && (await page.locator(".archive-delete-all").count()) === 1);

  // ARCH-02: three archived threads grouped — proj-a(2) + no-project(1);
  // the live thread never appears.
  const rowCount = () => page.locator(".archive-row").count();
  const titles = () => page.locator(".archive-row-title").allTextContents();
  verify("ARCH-02", (await rowCount()) === 3
    && !(await titles()).includes("live thread")
    && (await page.locator(".archive-group").count()) === 2);

  // ARCH-03: group counts + delete-all label carries the visible total.
  const counts = await page.locator(".archive-group-count").allTextContents();
  const delLabel = (await page.locator(".archive-delete-all").innerText()).trim();
  verify("ARCH-03", counts.sort().join(",") === "1 chats,2 chats"
    && delLabel === "Delete all archived chats (3)", { counts, delLabel });

  // ARCH-04: search narrows the visible set and the delete-all label.
  await page.locator(".archive-search").fill("alpha");
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 1,
    { timeout: 5000 },
  );
  const narrowed = (await page.locator(".archive-delete-all").innerText()).trim();
  verify("ARCH-04", (await titles()).join("|") === "archived alpha notes"
    && narrowed === "Delete matching chats (1)", { narrowed });
  await page.locator(".archive-search").fill("");

  // ARCH-05: project picker filters to the no-project scope.
  await page.locator('.archive-picker[aria-label="Project"]').selectOption("none");
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 1,
    { timeout: 5000 },
  );
  verify("ARCH-05", (await titles()).join("|") === "archived gamma stray");
  await page.locator('.archive-picker[aria-label="Project"]').selectOption("all");

  // ARCH-06: the Heads type honestly matches nothing — head threads do
  // not exist in this port (A41 is configuration only).
  await page.locator('.archive-picker[aria-label="Chat type"]').selectOption("heads");
  await page.waitForSelector(".archive-empty", { timeout: 5000 });
  verify("ARCH-06", (await page.locator(".archive-empty").innerText()).trim() === "No matching chats"
    && (await rowCount()) === 0);
  await page.locator('.archive-picker[aria-label="Chat type"]').selectOption("all");
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 3,
    { timeout: 5000 },
  );

  // ARCH-07: Restore unarchives — the row leaves the list and the
  // snapshot reports isArchived false. Rows sort by updatedAt, so target
  // by title for determinism.
  const rowByTitle = (title) => page.locator(".archive-row", { hasText: title });
  await rowByTitle("archived alpha notes")
    .locator('button[title="Restore thread"]')
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 2,
    { timeout: 5000 },
  );
  await waitSnap(page, (s) => s.threads.find((t) => t.id === t1.id)?.isArchived === false);
  verify("ARCH-07", (await rowCount()) === 2);

  // ARCH-08: confirmBeforeDeleting defaults on — first × arms, second
  // tap deletes (sidebar two-tap pattern as the dialog equivalent).
  await rowByTitle("archived beta plan")
    .locator('button[title="Delete thread"]')
    .click();
  verify("ARCH-08a", (await page.locator(".archive-row .danger-arm").count()) === 1);
  await page.locator(".archive-row .danger-arm").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 1,
    { timeout: 5000 },
  );
  verify("ARCH-08b", (await rowCount()) === 1
    && !(await snap(page)).threads.some((t) => t.id === t2.id));

  // ARCH-09: setting off → × deletes on the first tap with no arm step.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { confirmBeforeDeleting: false }),
  );
  await waitSnap(page, (s) => s.settings.confirmBeforeDeleting === false);
  await rowByTitle("archived gamma stray")
    .locator('button[title="Delete thread"]')
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 0,
    { timeout: 5000 },
  );
  verify("ARCH-09", (await page.locator(".archive-empty").innerText()).trim() === "No matching chats"
    && !(await snap(page)).threads.some((t) => t.id === t3.id));

  // ARCH-10: create two more threads over IPC, archive them, then a
  // filtered delete-all removes only matching ids — the live thread is
  // never touched. (The engine owns the store in memory; new threads
  // must come through IPC, not a file write.)
  const extra = [];
  for (const title of ["archived delta x", "archived epsilon y"]) {
    const th = await page.evaluate(
      ({ pid, title }) =>
        window.tivano.invoke("threads:create", { projectId: pid, title }),
      { pid: pidA, title },
    );
    await page.evaluate((id) => window.tivano.invoke("threads:archive", { id }), th.id);
    extra.push({ id: th.id });
  }
  await waitSnap(page, (s) => s.threads.filter((t) => t.isArchived).length >= 2);
  await page.locator(".archive-search").fill("delta");
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 1,
    { timeout: 5000 },
  );
  await page.locator(".archive-delete-all").click(); // arm
  const armed = (await page.locator(".archive-delete-all").innerText()).trim();
  await page.locator(".archive-delete-all").click(); // execute
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-empty").length === 1,
    { timeout: 5000 },
  );
  const after = await snap(page);
  verify("ARCH-10", armed === "Delete matching archived chats?"
    && !after.threads.some((t) => t.id === extra[0].id)
    && after.threads.some((t) => t.id === extra[1].id)
    && after.threads.some((t) => t.id === live.id),
    { armed });

  // ARCH-11: IPC boundary — a non-archived id in the set is refused.
  const res = await page.evaluate((id) =>
    window.tivano.invoke("threads:delete-archived", { ids: [id] }), live.id);
  verify("ARCH-11", res?.deleted?.length === 0
    && (await snap(page)).threads.some((t) => t.id === live.id), res);

  // ARCH-12: delete-all removes segment files with the threads.
  await page.locator(".archive-search").fill("");
  await page.waitForFunction(
    () => document.querySelectorAll(".archive-row").length === 1,
    { timeout: 5000 },
  );
  await page.locator(".archive-delete-all").click();
  await page.locator(".archive-delete-all").click();
  const store = await waitStore(
    (d) => !d.threads.some((t) => t.isArchived),
  );
  verify("ARCH-12", !store.threads.some((t) => t.isArchived)
    && !existsSync(join(dataRoot, "turns", `${extra[1].id}.json`))
    && store.threads.some((t) => t.id === live.id));

  // ---- sidebar-level archive/pin (restores the previous module's
  // ARCHIVE-*/PIN-* coverage on top of the new settings page) ----------
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });
  const liveRow = page.locator(".row", { hasText: "live thread" }).first();

  // ARCH-14: pin persists and the pinned row leads its project group.
  // A sibling thread in the same project makes the ordering meaningful.
  await page.evaluate(
    ({ pid, title }) =>
      window.tivano.invoke("threads:create", { projectId: pid, title }),
    { pid: pidB, title: "sibling thread" },
  );
  await waitSnap(page, (s) => s.threads.some((t) => t.title === "sibling thread"));
  await liveRow.hover();
  await liveRow.locator('button[title="Pin thread"]').click();
  await waitSnap(page, (s) => s.threads.find((t) => t.id === live.id)?.isPinned === true);
  const groupRows = await page
    .locator('div:has(> .group-row:has-text("proj-b")) > .row .title')
    .allTextContents();
  verify("ARCH-14", groupRows[0] === "live thread" && groupRows.length === 2, groupRows);

  // ARCH-15: archiving the selected thread clears its pin AND the
  // selection, and the row leaves the main list (frozen archive
  // semantics — an archived thread loses its pin with its row).
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), live.id);
  await waitSnap(page, (s) => s.selectedThreadId === live.id);
  await liveRow.hover();
  await liveRow.locator('button[title="Archive thread"]').click();
  const afterArch = await waitSnap(
    page,
    (s) => s.threads.find((t) => t.id === live.id)?.isArchived === true,
  );
  verify("ARCH-15", afterArch.threads.find((t) => t.id === live.id)?.isPinned === false
    && afterArch.selectedThreadId !== live.id
    && (await page.locator(".row:not(.archived)", { hasText: "live thread" }).count()) === 0);

  // ARCH-16: expanding the Archived block renders the row.
  await page.locator(".archived-toggle").click();
  verify("ARCH-16",
    (await page.locator(".row.archived", { hasText: "live thread" }).count()) === 1);

  // ARCH-17: Restore returns the row to the main list, still unpinned.
  const archRow = page.locator(".row.archived", { hasText: "live thread" });
  await archRow.hover();
  await archRow.locator('button[title="Restore thread"]').click();
  await waitSnap(page, (s) => s.threads.find((t) => t.id === live.id)?.isArchived === false);
  verify("ARCH-17",
    (await page.locator(".row:not(.archived)", { hasText: "live thread" }).count()) === 1
    && (await snap(page)).threads.find((t) => t.id === live.id)?.isPinned === false);

  // ARCH-18: archived state + hidden row survive a restart.
  await page.evaluate((id) => window.tivano.invoke("threads:archive", { id }), live.id);
  await waitSnap(page, (s) => s.threads.find((t) => t.id === live.id)?.isArchived === true);
  await waitStore((d) => d.threads.find((t) => t.id === live.id)?.isArchived === true);
  await boundedClose(app, proc);
  const s2 = await launch("archive-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s2snap = await snap(page2);
  verify("ARCH-18",
    s2snap.threads.find((t) => t.id === live.id)?.isArchived === true
    && (await page2.locator(".row:not(.archived)", { hasText: "live thread" }).count()) === 0);

  // ARCH-19: zh chrome — the archived group and its restore action are
  // localized; the row still restores after restart.
  await page2.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page2.locator(".archived-toggle").click();
  const toggleText = (await page2.locator(".archived-toggle").innerText()).trim();
  const zhRow = page2.locator(".row.archived", { hasText: "live thread" });
  const zhRestore = await zhRow.locator("button").first().getAttribute("title");
  await zhRow.hover();
  await zhRow.locator("button").first().click();
  await waitSnap(page2, (s) => s.threads.find((t) => t.id === live.id)?.isArchived === false);
  verify("ARCH-19", toggleText.includes("已归档") && zhRestore === "恢复对话"
    && (await page2.locator(".row", { hasText: "live thread" }).count()) === 1,
    { toggleText, zhRestore });

  await boundedClose(s2.app, s2.proc);
  check("ARCH-20", true, "restart instance closed cleanly");
}
