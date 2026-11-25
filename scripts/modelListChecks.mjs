// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17 model-list e2e — OFFLINE Codex fixture only. Pins/sections/prefs
// persist through settings:set; the picker restricts to the pinned set
// (frozen "the picker shows every model" until the user pins); prefs
// seed the next selection. Nothing here proves a real provider.

import { join } from "node:path";

export async function runModelListChecks({
  launch: launchApp,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) =>
    launchApp(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
        ...overrides,
      },
      label,
    );
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
  const settingsOf = async (page) => (await snap(page)).settings;
  const openSettings = async (page) => {
    if ((await page.locator(".modal").count()) === 0) {
      await page.locator(".sidebar-foot button.row").click();
      await page.waitForSelector(".modal", { timeout: 8000 });
    }
    await page.locator('[data-settings-page="models"]').click();
    await page.locator(".ml-settings").scrollIntoViewIfNeeded();
    await page.waitForSelector(".ml-head-title", { timeout: 8000 });
  };
  // The veil closes on a direct veil click — Escape only works with
  // focus inside the modal, which clicks outside it never give.
  const closeSettings = async (page) => {
    await page.locator(".modal-veil").click({ position: { x: 8, y: 8 } });
    await page.waitForSelector(".modal", { state: "detached", timeout: 8000 });
  };
  const optionValues = async (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".model-picker .model-select option")].map((o) => o.value),
    );

  let s = await launch({}, "s-modellist-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Pin Proj");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".group-name");
  await page.locator('button[title="New thread in Pin Proj"]').click();
  await page.waitForSelector(".chat-head h1");
  const threadId = (await snap(page)).selectedThreadId;

  // Bind a Codex session so models:list serves the fixture catalog.
  await page.locator(".composer textarea").fill("bind session");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  await page.waitForFunction(
    async () => (await window.tivano.invoke("models:list", {})).state === "ready",
    null,
    { timeout: 10000, polling: 200 },
  );

  // ML-01: empty state + catalog rows.
  await openSettings(page);
  verify(
    "ML-01 empty 'Your models' + catalog rows render",
    (await page.locator(".ml-row", { hasText: "No models chosen yet" }).count()) === 1 &&
      (await page.locator(".ml-pin.static").count()) >= 2 &&
      (await page.locator(".ml-head-count").innerText()).includes("0 / 30"),
  );

  // ML-02: pin two catalog models.
  const addButtons = page.locator(".ml-pin.static .ml-add");
  await addButtons.nth(0).click();
  await addButtons.nth(1).click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return st.modelList?.length === 2;
  });
  const firstTwo = (await settingsOf(page)).modelList.map((p) => p.modelID);
  verify(
    "ML-02 two pins persisted; add buttons flip to pinned check",
    firstTwo.length === 2 &&
      (await page.locator(".ml-add.pinned").count()) === 2 &&
      (await page.locator(".ml-head-count").innerText()).includes("2 / 30"),
    firstTwo,
  );

  // ML-03: the thread picker restricts to the pinned set (frozen parity).
  await closeSettings(page);
  await page.waitForSelector(".model-select", { timeout: 8000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".model-select option")].some((o) => o.value !== ""),
    null,
    { timeout: 8000 },
  );
  const vals = await optionValues(page);
  verify(
    "ML-03 picker lists only the pinned models (+default)",
    vals.filter((v) => v !== "").sort().join() === [...firstTwo].sort().join(),
    vals,
  );

  // ML-04: New group → rail + detail card appear, rename inline.
  await openSettings(page);
  await page.locator(".ml-newgroup-rail").click();
  await page.waitForSelector(".ml-rename", { timeout: 5000 });
  await page.locator(".ml-rename").fill("Fast lane");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return st.modelSections?.length === 1 && st.modelSections[0].name === "Fast lane";
  });
  verify(
    "ML-04 group created + renamed inline",
    (await page.locator(".ml-group-name").innerText()) === "Fast lane",
  );

  // ML-05: All chip wall → right-click a chip → Move to Group → Fast lane.
  await page.locator(".ml-rail-card", { hasText: "All" }).first().click();
  await page.waitForSelector(".ml-chip", { timeout: 5000 });
  await page.locator(".ml-chip").first().click({ button: "right" });
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.locator(".msg-menu .msg-row", { hasText: "Fast lane" }).click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return st.modelSections?.[0]?.position === 1 && st.modelList?.length === 2;
  });
  const layout = modelLayout(await settingsOf(page));
  verify(
    "ML-05 pin moved under the group",
    layout.join() === "pin,section,pin",
    layout,
  );

  // ML-06: switching rail group filters the detail card; All shows chip wall.
  const firstSectionId = (await settingsOf(page)).modelSections[0].id;
  await page.locator(`.ml-rail-card[data-rail-target="${firstSectionId}"]`).click();
  verify(
    "ML-06 selecting group in rail filters detail rows",
    (await page.locator(".ml-pin:not(.static)").count()) === 1,
  );
  await page.locator(".ml-rail-card", { hasText: "All" }).first().click();
  verify(
    "ML-06b All view renders chip wall",
    (await page.locator(".ml-chip").count()) === 2,
  );

  // ML-07: second group → drag ungrouped chip onto rail group card, then
  // Move Up swaps the two group blocks (with their models).
  await page.locator(".ml-newgroup-rail").click();
  await page.waitForSelector(".ml-rename");
  await page.locator(".ml-rename").fill("Pit stop");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const secondSectionId = (await settingsOf(page)).modelSections.at(-1).id;
  await page.locator(".ml-rail-card", { hasText: "All" }).first().click();
  await page
    .locator('[data-wall-group="ungrouped"] .ml-chip')
    .first()
    .dragTo(page.locator(`.ml-rail-card[data-rail-target="${secondSectionId}"]`));
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return modelLayout(st).join() === "section,pin,section,pin";
  });
  // Drag chip from first group onto second group's chip, then drag first chip of
  // second group onto empty group space in second group to move it to the end.
  const firstGroupChip = page.locator(`[data-wall-group="${firstSectionId}"] .ml-chip`).first();
  const secondGroupChip = page.locator(`[data-wall-group="${secondSectionId}"] .ml-chip`).first();
  await firstGroupChip.dragTo(secondGroupChip);
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return modelLayout(st).join() === "section,section,pin,pin";
  });
  const beforeEndDrag = (await settingsOf(page)).modelList.map((p) => p.modelID);
  const wallBox = await page.locator(`[data-wall-group="${secondSectionId}"]`).boundingBox();
  await page
    .locator(`[data-wall-group="${secondSectionId}"] .ml-chip`)
    .first()
    .dragTo(page.locator(`[data-wall-group="${secondSectionId}"]`), {
      targetPosition: { x: Math.max(20, (wallBox?.width ?? 200) - 16), y: 12 },
    });
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return st.modelList.map((p) => p.modelID).join() === [...beforeEndDrag].reverse().join();
  });
  await page
    .locator(`[data-wall-group="${secondSectionId}"] .ml-chip`)
    .first()
    .dragTo(page.locator(`.ml-rail-card[data-rail-target="${firstSectionId}"]`));
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return modelLayout(st).join() === "section,pin,section,pin";
  });
  await page.locator(`.ml-rail-card[data-rail-target="${secondSectionId}"]`).click({ button: "right" });
  await page.locator(".msg-menu .msg-row", { hasText: "Move Up" }).click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return st.modelSections?.[0]?.id === secondSectionId;
  });
  verify(
    "ML-07 drag chip + Move Up swaps the two groups",
    (await settingsOf(page)).modelSections[0].id === secondSectionId,
  );

  // ML-08/09: click fixture-model chip in All view to jump to its group,
  // then set effort + fast via effort popover.
  await page.locator(".ml-rail-card", { hasText: "All" }).first().click();
  await page.locator('.ml-chip[data-pin-id="codex/fixture-model"]').click();
  await page.waitForSelector(".ml-pin:not(.static)", { timeout: 5000 });
  await page.locator(".ml-pin:not(.static)").first().click();
  await page.waitForSelector(".effort-pop", { timeout: 5000 });
  await page.locator(".effort-pop .msg-row", { hasText: /^High/ }).click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return Object.values(st.modelPreferences ?? {}).some((p) => p.effort === "high");
  });
  const fastBox = page.locator(".effort-fast input");
  verify("ML-08b fast tier offered for fixture-model", (await fastBox.count()) === 1);
  await fastBox.check();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return Object.values(st.modelPreferences ?? {}).some(
      (p) => p.effort === "high" && p.fastMode === true,
    );
  });
  verify(
    "ML-08/09 effort+fast pref persisted",
    Object.values((await settingsOf(page)).modelPreferences ?? {}).length === 1,
    (await settingsOf(page)).modelPreferences,
  );
  await page.locator(".effort-actions button", { hasText: "Done" }).click();

  // ML-10: the pinned row's summary carries the stored defaults.
  verify(
    "ML-10 pin summary shows the stored defaults",
    (await page.locator(".ml-pin:not(.static) .ml-summary").first().innerText()).includes(
      "Fast",
    ),
  );

  // ML-11: group-aware model picker popover picks the pinned model + seeds defaults.
  await closeSettings(page);
  const pinnedWithPref = Object.entries(
    (await settingsOf(page)).modelPreferences,
  )[0][0].split("/")[1];
  await page.locator(".model-groups-btn").click();
  await page.waitForSelector(".model-picker-pop", { timeout: 5000 });
  await page.locator('.model-pop-cat[data-picker-cat="all"]').click();
  await page.locator(".model-pop-row", { hasText: "Fixture Model" }).click();
  await waitSnapshot(page, async () => {
    const st = await snap(page);
    const t = st.threads.find((x) => x.id === threadId);
    return (
      t?.codexModel === pinnedWithPref &&
      t?.codexEffort === "high" &&
      t?.codexServiceTier === "fast"
    );
  });
  verify(
    "ML-11 selecting a pinned model from group picker applies its stored effort+fast",
    true,
  );

  // ML-12: search filters the All chip wall (query hits the model id).
  await openSettings(page);
  await page.locator(".ml-rail-card", { hasText: "All" }).first().click();
  await page.locator(".ml-search").fill("fixture-mo");
  await page.waitForTimeout(150);
  const visibleNames = await page
    .locator(".ml-chip .ml-chip-name")
    .allInnerTexts();
  verify(
    "ML-12 search narrows pins",
    visibleNames.length === 1 && visibleNames[0] === "Fixture Model",
    visibleNames,
  );
  await page.locator(".ml-search").fill("");

  // ML-13: right-click chip → Remove from the picker drops the pin.
  const before = (await settingsOf(page)).modelList.length;
  await page.locator(".ml-chip").first().click({ button: "right" });
  await page
    .locator(".msg-menu .msg-row", { hasText: "Remove from the picker" })
    .click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return st.modelList?.length === before - 1;
  });
  verify("ML-13 pin removed", (await settingsOf(page)).modelList.length === before - 1);

  // ML-14: Ungroup keeps the models (they join the top).
  const sectionsBefore = (await settingsOf(page)).modelSections.length;
  await page
    .locator(`.ml-rail-card[data-rail-target="${secondSectionId}"]`)
    .click({ button: "right" });
  await page
    .locator(".msg-menu .msg-row", { hasText: "Ungroup" })
    .click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return (st.modelSections ?? []).length === sectionsBefore - 1;
  });
  verify(
    "ML-14 heading removed, models stay",
    (await settingsOf(page)).modelList.length === before - 1 &&
      (await page.locator(".ml-chip").count()) === before - 1,
  );

  // ML-15: zh-Hans labels + screenshot.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".ml-head-title", { timeout: 5000 });
  const zhHead = await page.locator(".ml-head-title").first().innerText();
  verify(
    "ML-15 zh-Hans section labels",
    zhHead === "你的模型" &&
      (await page.locator(".ml-newgroup-rail").innerText()).includes("新建分组"),
    zhHead,
  );
  await page.locator(".ml-settings").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, "67-modellist-zh.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await closeSettings(page);

  // ML-16: restart persists the layout.
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("ML-16a modellist-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }
  s = await launch({}, "s-modellist-b-restart");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), threadId);
  await page.waitForSelector(".model-select", { timeout: 8000 });
  const afterRestart = await settingsOf(page);
  verify(
    "ML-16b layout + prefs survive restart",
    afterRestart.modelList?.length === before - 1 &&
      afterRestart.modelSections?.length === sectionsBefore - 1 &&
      Object.keys(afterRestart.modelPreferences ?? {}).length === 1,
    {
      pins: afterRestart.modelList?.length,
      sections: afterRestart.modelSections?.length,
      prefs: Object.keys(afterRestart.modelPreferences ?? {}).length,
    },
  );

  // Cleanup: clear all four slices so later modules see a clean picker.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      modelList: [],
      modelSections: [],
      collapsedModelSections: [],
      modelPreferences: {},
    }),
  );

  // ML-17: Hide outdated models (P1-25) — default ON. The unpinned
  // picker and the Settings catalog keep the three newest fixture
  // versions; versionless rows always stay, "… High" folds behind its
  // base, search still lists the full catalog, off restores it.
  // The restarted app has no bound session yet, so models:list is still
  // pending — run a turn to bind one (same path as the first session).
  await page.locator(".composer textarea").fill("bind session again");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  await page.waitForFunction(
    async () => (await window.tivano.invoke("models:list", {})).state === "ready",
    null,
    { timeout: 10000, polling: 200 },
  );
  await page.locator(".model-select").focus(); // onFocus refetches the catalog
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { hideOutdatedModels: true }),
  );
  await page.waitForSelector(".model-select", { timeout: 8000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".model-select option")].some((o) => o.value !== ""),
    null,
    { timeout: 8000 },
  );
  const trimmedVals = (await optionValues(page)).sort();
  verify(
    "ML-17a picker keeps three newest versions + versionless rows",
    trimmedVals.join() ===
      ["", "fixture-model", "fixture-max", "fixture-v3", "fixture-v4", "fixture-v5"]
        .sort()
        .join(),
    trimmedVals,
  );
  await openSettings(page);
  const shownNames = await page.locator(".ml-pin.static .ml-name").allInnerTexts();
  verify(
    "ML-17b Settings catalog trims the same way",
    shownNames.length === 5 && !shownNames.some((n) => n.includes("1.0")),
    shownNames,
  );
  await page.locator(".ml-search").fill("1.0");
  await page.waitForTimeout(150);
  const searched = await page.locator(".ml-pin.static .ml-name").allInnerTexts();
  verify(
    "ML-17c search still finds outdated rows",
    searched.some((n) => n.includes("1.0")),
    searched,
  );
  await page.locator(".ml-search").fill("");
  await page.locator('.ml-settings [role="switch"]').click();
  await waitSnapshot(page, async () => (await settingsOf(page)).hideOutdatedModels === false);
  const fullNames = await page.locator(".ml-pin.static .ml-name").allInnerTexts();
  verify(
    "ML-17d switch off lists the full catalog",
    fullNames.length === 8,
    fullNames,
  );
  const offVals = (await optionValues(page)).sort();
  verify(
    "ML-17e picker shows the full catalog when off",
    offVals.length === 9,
    offVals,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { hideOutdatedModels: true }),
  );
  await closeSettings(page);

  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("ML-16c modellist-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }

  function modelLayout(settings) {
    // Rebuild the unified layout the page renders: sections before the
    // pin at their position.
    const pins = settings.modelList ?? [];
    const secs = [...(settings.modelSections ?? [])].sort(
      (a, b) => a.position - b.position,
    );
    const out = [];
    let si = 0;
    for (let i = 0; i < pins.length; i++) {
      while (si < secs.length && secs[si].position <= i) out.push("section"), si++;
      out.push("pin");
    }
    while (si < secs.length) out.push("section"), si++;
    return out;
  }
}
