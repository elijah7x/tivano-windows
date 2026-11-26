// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F02 archive management e2e — frozen ArchiveSettingsPage port: grouped
// rows, search/project/chat-type filters, per-row Restore/Delete with
// the confirmBeforeDeleting gate, filtered Delete-all, and the IPC
// boundary that refuses to delete non-archived threads.

import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
    await page.waitForSelector(".modal", { timeout: 10000 });
    await page.locator('[data-settings-page="storage"]').click();
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

  // P1-03: seed two store recovery backups (240 B older, 120 B newest).
  const olderRecovery = join(dataRoot, "store.corrupt-2026-11-20T00-00-00-000Z.json");
  const newestRecovery = join(dataRoot, "store.corrupt-2026-11-21T00-00-00-000Z.json");
  writeFileSync(olderRecovery, "a".repeat(240));
  writeFileSync(newestRecovery, "b".repeat(120));
  const nowSec = Math.floor(Date.now() / 1000);
  utimesSync(olderRecovery, nowSec - 60, nowSec - 60);
  utimesSync(newestRecovery, nowSec - 10, nowSec - 10);

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

  // DIAG-01: P1-03 Storage › Diagnostics displays total + cleanable sizes.
  await page.waitForSelector('[data-testid="diagnostics-row-recovery"]', { timeout: 10000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="diagnostics-status-recovery"]');
      return el && el.textContent && el.textContent.includes("Total: 360 B");
    },
    { timeout: 5000 },
  );
  const diagStatus1 = (await page.locator('[data-testid="diagnostics-status-recovery"]').innerText()).trim();
  const diagBtnEnabled = !(await page.locator('[data-testid="diagnostics-clean-recovery"]').isDisabled());
  verify("DIAG-01", diagStatus1.includes("Total: 360 B · Cleanable: 240 B") && diagBtnEnabled, {
    diagStatus1,
    diagBtnEnabled,
  });

  // DIAG-02: separate confirmation per category — Cancel keeps both files.
  await page.locator('[data-testid="diagnostics-clean-recovery"]').click();
  await page.waitForSelector('[data-testid="diagnostics-confirm-recovery"]', { timeout: 5000 });
  const confirmText = (await page.locator('[data-testid="diagnostics-confirm-recovery"]').innerText()).trim();
  await page.locator('[data-testid="diagnostics-cancel-recovery"]').click();
  await page.waitForSelector('[data-testid="diagnostics-confirm-recovery"]', {
    state: "detached",
    timeout: 5000,
  });
  verify("DIAG-02", confirmText.includes("Clean up recovery files?")
    && existsSync(olderRecovery)
    && existsSync(newestRecovery), { confirmText });

  // DIAG-03: confirming cleanup removes older recovery file, keeps newest + live store.
  await page.locator('[data-testid="diagnostics-clean-recovery"]').click();
  await page.waitForSelector('[data-testid="diagnostics-confirm-btn-recovery"]', { timeout: 5000 });
  await page.locator('[data-testid="diagnostics-confirm-btn-recovery"]').click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="diagnostics-status-recovery"]');
      return el && el.textContent && el.textContent.includes("Nothing to clean up.");
    },
    { timeout: 5000 },
  );
  const diagStatus2 = (await page.locator('[data-testid="diagnostics-status-recovery"]').innerText()).trim();
  const diagBtnDisabled = await page.locator('[data-testid="diagnostics-clean-recovery"]').isDisabled();
  verify("DIAG-03", diagStatus2.includes("Total: 120 B · Cleanable: 0 B · Nothing to clean up.")
    && diagBtnDisabled
    && !existsSync(olderRecovery)
    && existsSync(newestRecovery)
    && existsSync(join(dataRoot, "store.json")), { diagStatus2, diagBtnDisabled });

  // DIAG-04: zh-Hans localization for diagnostics section.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="diagnostics-section"]');
      return el && el.textContent && el.textContent.includes("恢复文件");
    },
    { timeout: 5000 },
  );
  const zhDiagText = (await page.locator('[data-testid="diagnostics-section"]').innerText()).trim();
  verify("DIAG-04", zhDiagText.includes("诊断")
    && zhDiagText.includes("恢复文件")
    && zhDiagText.includes("总量：120 B · 可清理：0 B · 没有可清理的文件。"), { zhDiagText });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="diagnostics-section"]');
      return el && el.textContent && el.textContent.includes("Recovery files");
    },
    { timeout: 5000 },
  );

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
  // P2-34: archiving lives in the ⋯/context menu now — a hovered row
  // must NOT grow back a dedicated Archive button (frozen parity).
  verify("ARCH-15-menu",
    (await liveRow.locator('button[title="Archive thread"]').count()) === 0);
  await liveRow.locator('button[title="Thread actions"]').click();
  await page
    .locator('.row-menu button[role="menuitem"]', { hasText: "Archive" })
    .click();
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

  // DIAG-05: failed measurement surfaces error instead of 0 B and disables cleanup.
  const s3 = await launchApp(
    { TIVANO_TEST_DIAGNOSTICS_MEASURE_ERROR: "Simulated disk error" },
    "archive-diag-error",
  );
  instances.push(s3);
  const page3 = await s3.app.firstWindow();
  await page3.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page3.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await openSettings(page3);
  await page3.waitForSelector('[data-testid="diagnostics-status-recovery"]', { timeout: 10000 });
  await page3.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="diagnostics-status-recovery"]');
      return el && el.textContent && el.textContent.includes("Simulated disk error");
    },
    { timeout: 5000 },
  );
  const diagErrText = (await page3.locator('[data-testid="diagnostics-status-recovery"]').innerText()).trim();
  const diagErrBtnDisabled = await page3.locator('[data-testid="diagnostics-clean-recovery"]').isDisabled();
  verify(
    "DIAG-05",
    diagErrText.includes("Could not measure these files. Not included in the measured total. Simulated disk error")
      && !diagErrText.includes("0 B")
      && diagErrBtnDisabled,
    { diagErrText, diagErrBtnDisabled },
  );
  await boundedClose(s3.app, s3.proc);
}
