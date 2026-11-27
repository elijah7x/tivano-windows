// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-78 e2e checks: Remove-this-project confirmation popover opens adjacent
// to the selected sidebar project row (collapsed, expanded, scrolled, top/bottom
// edges, multi-project switching) with viewport clamping, keyboard focus and
// zh-Hans localization.

export async function runProjectDeleteChecks({
  launch,
  instances,
  snap,
  check,
  boundedClose,
}) {
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
    throw new Error("Timed out waiting for project deletion state");
  };

  const s = await launch({}, "proj-delete-main");
  instances.push(s);
  const { app, proc } = s;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // Create enough projects so the sidebar scrolls and exercises top, middle, and bottom edges.
  const projectIds = await page.evaluate(async () => {
    const ids = [];
    for (let i = 1; i <= 20; i++) {
      const p = await window.tivano.invoke("projects:create", {
        name: `P278 Proj ${String(i).padStart(2, "0")}`,
      });
      ids.push(p.id);
    }
    // Add 2 threads inside collapsed project #2 and 1 inside #3 so count accuracy is checked.
    await window.tivano.invoke("threads:create", { projectId: ids[1] });
    await window.tivano.invoke("threads:create", { projectId: ids[1] });
    await window.tivano.invoke("projects:toggle", { id: ids[1], expanded: false });
    await window.tivano.invoke("threads:create", { projectId: ids[2] });
    return ids;
  });

  await page.waitForSelector(`.group-row[data-project-id="${projectIds[0]}"]`, { timeout: 10000 });

  // PD-01: Collapsed project opens the confirmation popover adjacent to its row with accurate hidden chat count.
  const collapsedRow = page.locator(`.group-row[data-project-id="${projectIds[1]}"]`);
  await collapsedRow.scrollIntoViewIfNeeded();
  const collapsedTrigger = page.getByRole("button", { name: "Delete project: P278 Proj 02", exact: true });
  await collapsedTrigger.click();
  await page.waitForSelector("#project-delete-popover", { timeout: 8000 });
  const collapsedGeo = await page.evaluate((pid) => {
    const row = document.querySelector(`.group-row[data-project-id="${pid}"]`).getBoundingClientRect();
    const pop = document.querySelector("#project-delete-popover").getBoundingClientRect();
    const note = document.querySelector("#project-delete-popover .proj-delete-note")?.textContent ?? "";
    const active = document.activeElement?.textContent?.trim() ?? "";
    return { row, pop, note, active, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  }, projectIds[1]);
  verify(
    "PD-01 collapsed project anchors popover beside its row with exact hidden chat count and safe initial focus",
    collapsedGeo.pop.left >= collapsedGeo.row.right &&
      Math.abs(collapsedGeo.pop.top - collapsedGeo.row.top) <= 12 &&
      collapsedGeo.pop.right <= collapsedGeo.innerWidth - 8 &&
      collapsedGeo.pop.bottom <= collapsedGeo.innerHeight - 8 &&
      collapsedGeo.note.includes("2 chats") &&
      collapsedGeo.active === "Cancel",
    collapsedGeo,
  );

  // PD-02: Tab and Shift+Tab cycle inside the popover, Escape restores trigger focus, and outside click dismisses without deleting.
  await page.keyboard.press("Tab");
  const focusedRemove = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  await page.keyboard.press("Shift+Tab");
  const focusedCancelBack = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#project-delete-popover", { state: "detached", timeout: 8000 });
  const restoredFocus = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  await collapsedTrigger.click();
  await page.waitForSelector("#project-delete-popover", { timeout: 8000 });
  await page.mouse.click(700, 300);
  await page.waitForSelector("#project-delete-popover", { state: "detached", timeout: 8000 });
  verify(
    "PD-02 Tab/Shift+Tab cycle inside dialog, Escape restores trigger focus, and outside click dismisses",
    focusedRemove === "Remove project" &&
      focusedCancelBack === "Cancel" &&
      restoredFocus === "Delete project: P278 Proj 02" &&
      (await snap(page)).projects.some((p) => p.id === projectIds[1]),
    { focusedRemove, focusedCancelBack, restoredFocus },
  );

  // PD-03: Multi-project switching moves the popover to the newly selected project row.
  await page.getByRole("button", { name: "Delete project: P278 Proj 01", exact: true }).click();
  await page.waitForSelector(`#project-delete-popover[data-project-id="${projectIds[0]}"]`, { timeout: 8000 });
  await page.getByRole("button", { name: "Delete project: P278 Proj 03", exact: true }).click();
  await page.waitForSelector(`#project-delete-popover[data-project-id="${projectIds[2]}"]`, { timeout: 8000 });
  const switchedGeo = await page.evaluate((pid) => {
    const row = document.querySelector(`.group-row[data-project-id="${pid}"]`).getBoundingClientRect();
    const pop = document.querySelector("#project-delete-popover").getBoundingClientRect();
    return { rowTop: row.top, popTop: pop.top, popLeft: pop.left, rowRight: row.right };
  }, projectIds[2]);
  verify(
    "PD-03 switching between projects re-anchors popover to the newly selected row",
    switchedGeo.popLeft >= switchedGeo.rowRight &&
      Math.abs(switchedGeo.popTop - switchedGeo.rowTop) <= 12,
    switchedGeo,
  );

  // Confirming deletes only project #3, leaving #1 and #2 intact, and moves focus to adjacent project #4.
  await page.locator("#project-delete-popover").getByRole("button", { name: "Remove project", exact: true }).click();
  const afterDelete = await waitSnap(page, (st) => !st.projects.some((p) => p.id === projectIds[2]));
  const adjacentFocus = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  verify(
    "PD-04 confirming Remove project deletes only the targeted project and focuses adjacent row",
    afterDelete.projects.some((p) => p.id === projectIds[0]) &&
      afterDelete.projects.some((p) => p.id === projectIds[1]) &&
      adjacentFocus === "Delete project: P278 Proj 04",
    { adjacentFocus },
  );

  // PD-05: Scrolling to the bottom-most project clamps the popover inside the bottom viewport edge.
  const lastId = projectIds[projectIds.length - 1];
  const lastRow = page.locator(`.group-row[data-project-id="${lastId}"]`);
  await lastRow.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Delete project: P278 Proj 20", exact: true }).click();
  await page.waitForSelector(`#project-delete-popover[data-project-id="${lastId}"]`, { timeout: 8000 });
  const bottomGeo = await page.evaluate((pid) => {
    const row = document.querySelector(`.group-row[data-project-id="${pid}"]`).getBoundingClientRect();
    const pop = document.querySelector("#project-delete-popover").getBoundingClientRect();
    return { row, pop, innerHeight: window.innerHeight, innerWidth: window.innerWidth };
  }, lastId);
  verify(
    "PD-05 bottom-edge project row clamps popover inside the viewport",
    bottomGeo.pop.left >= bottomGeo.row.right &&
      bottomGeo.pop.bottom <= bottomGeo.innerHeight - 8 &&
      bottomGeo.pop.top >= 8 &&
      bottomGeo.pop.bottom >= bottomGeo.row.top,
    bottomGeo,
  );

  // Scrolling the anchored row completely out of the list closes the popover cleanly.
  await page.evaluate(() => {
    const list = document.querySelector(".thread-list");
    if (list) list.scrollTop = 0;
  });
  await page.waitForSelector("#project-delete-popover", { state: "detached", timeout: 8000 });
  verify("PD-06 scrolling anchored row out of view dismisses the popover", true);

  // PD-07: Top-edge row + zh-Hans localization renders translated title and action labels inside viewport.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(`.group-row[data-project-id="${projectIds[0]}"]`).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "删除项目: P278 Proj 01", exact: true }).click();
  await page.waitForSelector("#project-delete-popover", { timeout: 8000 });
  const zh = await page.evaluate(() => {
    const pop = document.querySelector("#project-delete-popover");
    const r = pop.getBoundingClientRect();
    return {
      title: pop.querySelector(".proj-delete-title")?.textContent ?? "",
      text: pop.textContent ?? "",
      top: r.top,
      left: r.left,
    };
  });
  verify(
    "PD-07 zh-Hans localized popover anchors cleanly near top edge",
    zh.title === "移除这个项目？" &&
      zh.text.includes("移除项目") &&
      zh.text.includes("取消") &&
      zh.top >= 8,
    zh,
  );

  await page.keyboard.press("Escape");
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const closeRes = await boundedClose(app, proc);
  verify("PD-08 clean close", closeRes.outcome === "resolved", closeRes);
}
