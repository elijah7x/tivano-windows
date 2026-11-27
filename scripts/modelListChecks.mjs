// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
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

  // Exercise a bound Codex session as well; the lightweight one-shot path keeps models:list available even before binding.
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
  await page.locator(".model-pop-row", { hasText: "Fixture Model" }).first().click();
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

  // ML-13b (P2-33): rename a group inline, then immediately remove a pin /
  // reorder a group while editing — both the rename and mutation persist.
  // Note: ML-13 removed secondSectionId's pin (since Move Up placed it first),
  // so firstSectionId still holds its pin for blur-commit + immediate remove.
  await page.locator(`.ml-rail-card[data-rail-target="${firstSectionId}"]`).click();
  await page.waitForSelector('.ml-icobtn[aria-label="Rename group"]', { timeout: 5000 });
  await page.locator('.ml-icobtn[aria-label="Rename group"]').click();
  await page.waitForSelector(".ml-rename", { timeout: 5000 });
  await page.locator(".ml-rename").fill("Fast lane v2");
  verify(
    "ML-13b-pre target group holds a removable pin",
    (await page.locator(".ml-pin:not(.static) .ml-remove").count()) === 1,
  );
  // Click remove directly without pressing Enter first (blur + remove in one click).
  await page.locator(".ml-pin:not(.static) .ml-remove").first().click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return (
      st.modelSections?.some((x) => x.id === firstSectionId && x.name === "Fast lane v2") &&
      (st.modelList ?? []).length === before - 2
    );
  });
  verify(
    "ML-13b blur-commit rename + immediate pin remove both landed",
    (await settingsOf(page)).modelSections.some(
      (x) => x.id === firstSectionId && x.name === "Fast lane v2",
    ) && ((await settingsOf(page)).modelList ?? []).length === before - 2,
  );

  // ML-13c (P2-33): select secondSectionId (at index 0, not in edit mode),
  // start inline rename, then reorder via rail context menu without pressing Enter.
  await page.locator(`.ml-rail-card[data-rail-target="${secondSectionId}"]`).click();
  await page.waitForSelector('.ml-icobtn[aria-label="Rename group"]', { timeout: 5000 });
  await page.locator('.ml-icobtn[aria-label="Rename group"]').click();
  await page.waitForSelector(".ml-rename", { timeout: 5000 });
  await page.locator(".ml-rename").fill("Pit lane v3");
  await page
    .locator(`.ml-rail-card[data-rail-target="${secondSectionId}"]`)
    .click({ button: "right" });
  await page.locator(".msg-menu .msg-row", { hasText: "Move Down" }).click();
  await waitSnapshot(page, async () => {
    const st = await settingsOf(page);
    return (
      st.modelSections?.at(-1)?.id === secondSectionId &&
      st.modelSections?.at(-1)?.name === "Pit lane v3"
    );
  });
  verify(
    "ML-13c reorder-while-editing preserves rename and moves group",
    (await settingsOf(page)).modelSections.at(-1)?.name === "Pit lane v3",
  );
  const afterRemoveCount = ((await settingsOf(page)).modelList ?? []).length;

  // ML-14: Ungroup keeps the models (they join the top).
  await page.locator(".ml-rail-card", { hasText: "All" }).first().click();
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
    ((await settingsOf(page)).modelList ?? []).length === afterRemoveCount &&
      (await page.locator(".ml-chip").count()) === afterRemoveCount,
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
    (afterRestart.modelList ?? []).length === afterRemoveCount &&
      afterRestart.modelSections?.length === sectionsBefore - 1 &&
      Object.keys(afterRestart.modelPreferences ?? {}).length === 1,
    {
      pins: (afterRestart.modelList ?? []).length,
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
      lastHydraPairId: null,
      lastNewChatModel: null,
    }),
  );

  // ML-17: Hide outdated models (P1-25) — default ON. The unpinned
  // picker and the Settings catalog keep the three newest fixture
  // versions; versionless rows always stay, "… High" folds behind its
  // base, search still lists the full catalog, off restores it.
  // The restarted app has no bound session yet; the lightweight one-shot
  // catalog path should still recover readiness. This turn additionally
  // exercises the normal post-bind path.
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

  // ML-17f..i (P1-24): Composer model picker search finds hidden outdated
  // models, clearing search restores the trimmed list, and picking an
  // outdated model keeps it visible in the trimmed list.
  await page.locator(".model-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.single-col", { timeout: 5000 });
  const popTrimmedNames = await page.locator(".model-pop-row .model-pop-name").allInnerTexts();
  verify(
    "ML-17f composer picker opens with trimmed list (omitting Fixture 1.0)",
    popTrimmedNames.some((n) => n.includes("Fixture 3.0")) &&
      !popTrimmedNames.some((n) => n.includes("Fixture 1.0")),
    popTrimmedNames,
  );
  await page.locator(".model-pop-search").fill("1.0");
  await page.waitForTimeout(150);
  const popSearchedNames = await page.locator(".model-pop-row .model-pop-name").allInnerTexts();
  verify(
    "ML-17g composer picker search finds hidden outdated model",
    popSearchedNames.length === 1 && popSearchedNames[0].includes("Fixture 1.0"),
    popSearchedNames,
  );
  await page.locator(".model-pop-clear").click();
  await page.waitForTimeout(150);
  const popClearedNames = await page.locator(".model-pop-row .model-pop-name").allInnerTexts();
  verify(
    "ML-17h clearing composer picker search returns to trimmed list",
    popClearedNames.some((n) => n.includes("Fixture 3.0")) &&
      !popClearedNames.some((n) => n.includes("Fixture 1.0")),
    popClearedNames,
  );
  await page.locator(".model-pop-search").fill("1.0");
  await page.waitForTimeout(150);
  await page.locator(".model-pop-row", { hasText: "Fixture 1.0" }).click();
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId);
    return t?.codexModel === "fixture-v1";
  });
  await page.locator(".model-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.single-col", { timeout: 5000 });
  const popWithChosenNames = await page.locator(".model-pop-row .model-pop-name").allInnerTexts();
  const selectWithChosenVals = await optionValues(page);
  verify(
    "ML-17i chosen outdated model remains visible in picker after clearing search",
    popWithChosenNames.some((n) => n.includes("Fixture 1.0")) &&
      !popWithChosenNames.some((n) => n.includes("Fixture 2.0")) &&
      selectWithChosenVals.includes("fixture-v1"),
    { popWithChosenNames, selectWithChosenVals },
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-picker-pop", { state: "detached", timeout: 5000 });
  await page.evaluate(
    (tid) => window.tivano.invoke("threads:set-model", { threadId: tid, model: null, effort: null, fastTier: null }),
    threadId,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { lastNewChatModel: null }),
  );

  // ML-18 (P2-03): two-column composer picker (Pairs + Models) with recents,
  // search across pair names, single-column fallback without pairs, and keyboard nav.
  // First verify single-column when no pairs exist.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraPairs: [], hydraEnabled: true }),
  );
  await page.locator(".model-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.single-col", { timeout: 5000 });
  verify(
    "ML-18a single-column picker without pairs",
    (await page.locator(".model-pop-pairs-col").count()) === 0 &&
      (await page.locator(".model-pop-list .model-pop-row").count()) >= 2,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-picker-pop", { state: "detached", timeout: 5000 });

  // Add pairs (enough to overflow and test independent scrolling) and seed recents.
  const pairAlpha = {
    id: "p203-pair-alpha",
    provider: "codex",
    orchestratorModel: "fixture-model",
    workerModel: "fixture-max",
    name: "Alpha Pair",
    headProfiles: [],
  };
  const pairBeta = {
    id: "p203-pair-beta",
    provider: "codex",
    orchestratorModel: "fixture-max",
    workerModel: "fixture-model",
    name: "Beta Pair",
    headProfiles: [],
  };
  const extraPairs = Array.from({ length: 7 }, (_, i) => ({
    id: `p203-pair-extra-${i + 1}`,
    provider: "codex",
    orchestratorModel: "fixture-model",
    workerModel: "fixture-max",
    name: `Extra Pair ${i + 1}`,
    headProfiles: [],
  }));
  await page.evaluate(
    ({ allPairs, recentPairId }) =>
      window.tivano.invoke("settings:set", {
        hydraEnabled: true,
        hydraPairs: allPairs,
        lastHydraPairId: recentPairId,
        lastNewChatPairId: recentPairId,
        lastNewChatModel: { provider: "codex", modelID: "fixture-max" },
      }),
    { allPairs: [pairAlpha, pairBeta, ...extraPairs], recentPairId: pairBeta.id },
  );
  await page.locator(".model-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.two-col", { timeout: 5000 });
  await page.screenshot({ path: join(outDir, "68-modellist-two-col.png") });
  const twoColMetrics = await page.evaluate(() => {
    const pairsCol = document.querySelector(".model-pop-pairs-col");
    const modelsCol = document.querySelector(".model-pop-list");
    const pairItems = [...(pairsCol?.querySelectorAll("[data-pop-item]") ?? [])].map((el) =>
      el.getAttribute("data-pop-item"),
    );
    const modelItems = [...(modelsCol?.querySelectorAll("[data-pop-item]") ?? [])].map((el) =>
      el.getAttribute("data-pop-item"),
    );
    const pairsScrollable = pairsCol ? pairsCol.scrollHeight > pairsCol.clientHeight : false;
    if (pairsCol) pairsCol.scrollTop = 60;
    const pairsScrolled = pairsCol ? pairsCol.scrollTop : 0;
    const modelsScrollAfterPairScroll = modelsCol ? modelsCol.scrollTop : -1;
    if (pairsCol) pairsCol.scrollTop = 0;
    return {
      pairsOverflow: pairsCol ? getComputedStyle(pairsCol).overflowY : "",
      modelsOverflow: modelsCol ? getComputedStyle(modelsCol).overflowY : "",
      pairsScrollable,
      pairsScrolled,
      modelsScrollAfterPairScroll,
      pairItems,
      modelItems,
      pairsHead: pairsCol?.querySelector(".model-pop-head")?.textContent ?? "",
      modelsHead: modelsCol?.querySelector(".model-pop-head")?.textContent ?? "",
    };
  });
  verify(
    "ML-18b two-column picker shows independent scroll columns with recent pair & model on top",
    twoColMetrics.pairsOverflow === "auto" &&
      twoColMetrics.modelsOverflow === "auto" &&
      twoColMetrics.pairsScrollable &&
      twoColMetrics.pairsScrolled > 0 &&
      twoColMetrics.modelsScrollAfterPairScroll === 0 &&
      twoColMetrics.pairsHead === "Recent" &&
      twoColMetrics.modelsHead === "Recent" &&
      twoColMetrics.pairItems[0] === "recent-pair:p203-pair-beta" &&
      twoColMetrics.modelItems[0] === "recent-model:fixture-max",
    twoColMetrics,
  );

  // Search filters both columns including pair names.
  await page.locator(".model-pop-search").fill("Alpha");
  await page.waitForTimeout(80);
  const alphaSearch = await page.evaluate(() => ({
    pairs: [...document.querySelectorAll(".model-pop-pairs-col .model-pop-name")].map(
      (n) => n.textContent,
    ),
    modelsEmpty: document.querySelector(".model-pop-list .model-pop-empty")?.textContent ?? "",
  }));
  verify(
    "ML-18c search filters pairs by name and narrows models column",
    alphaSearch.pairs.length === 1 &&
      alphaSearch.pairs[0] === "Alpha Pair" &&
      alphaSearch.modelsEmpty === "No models match",
    alphaSearch,
  );
  await page.locator(".model-pop-search").fill("");
  await page.waitForTimeout(80);

  // Keyboard navigation: ArrowDown into Pairs column, Tab & ArrowRight to Models column,
  // ArrowLeft back to Pairs column, Enter selects the focused pair.
  await page.keyboard.press("ArrowDown");
  const focusInPairs = await page.evaluate(
    () => document.activeElement?.closest(".model-pop-pairs-col") !== null,
  );
  await page.keyboard.press("Tab");
  const focusInModelsAfterTab = await page.evaluate(
    () => document.activeElement?.closest(".model-pop-list") !== null,
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  const focusInModels = await page.evaluate(
    () => document.activeElement?.closest(".model-pop-list") !== null,
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".model-picker-pop", { state: "detached", timeout: 5000 });
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId);
    return (
      t?.hydraPairId === "p203-pair-alpha" &&
      t?.subagentMode === "preset" &&
      st.settings.lastHydraPairId === "p203-pair-alpha" &&
      st.settings.lastNewChatPairId === "p203-pair-alpha"
    );
  });
  const afterPairPick = await snap(page);
  const pickedThread = afterPairPick.threads.find((x) => x.id === threadId);
  verify(
    "ML-18d keyboard navigation + Enter chooses pair and applies threads:set-model / lastHydraPairId",
    focusInPairs &&
      focusInModelsAfterTab &&
      focusInModels &&
      pickedThread?.hydraPairId === "p203-pair-alpha" &&
      pickedThread?.codexModel === "fixture-model" &&
      pickedThread?.subagentMode === "preset" &&
      afterPairPick.settings.lastHydraPairId === "p203-pair-alpha" &&
      afterPairPick.settings.lastNewChatPairId === "p203-pair-alpha",
    {
      focusInPairs,
      focusInModelsAfterTab,
      focusInModels,
      hydraPairId: pickedThread?.hydraPairId,
      codexModel: pickedThread?.codexModel,
      lastHydraPairId: afterPairPick.settings.lastHydraPairId,
      lastNewChatPairId: afterPairPick.settings.lastNewChatPairId,
    },
  );

  // Choosing a model from the picker leaves the pair, clears lastHydraPairId (so new chats
  // do not inherit the left pair), and keeps lastNewChatPairId + lastNewChatModel for Recent.
  await page.locator(".model-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.two-col", { timeout: 5000 });
  await page.locator('.model-pop-list [data-pop-item="model:fixture-max"]').click();
  const afterLeave = await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId);
    return (
      t?.codexModel === "fixture-max" &&
      t?.hydraPairId === undefined &&
      st.settings.lastHydraPairId === undefined &&
      st.settings.lastNewChatPairId === "p203-pair-alpha" &&
      st.settings.lastNewChatModel?.modelID === "fixture-max"
    );
  });
  const createdAfterLeave = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "after-leave-pair" }),
  );
  verify(
    "ML-18e choosing a model leaves the pair, clears lastHydraPairId, and keeps recent pair",
    afterLeave.settings.lastHydraPairId === undefined &&
      afterLeave.settings.lastNewChatPairId === "p203-pair-alpha" &&
      createdAfterLeave?.hydraPairId === undefined,
    {
      lastHydraPairId: afterLeave.settings.lastHydraPairId,
      lastNewChatPairId: afterLeave.settings.lastNewChatPairId,
      newThreadPairId: createdAfterLeave?.hydraPairId,
    },
  );

  // Clean up test pairs and recents before close.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      hydraPairs: [],
      lastHydraPairId: null,
      lastNewChatPairId: null,
      lastNewChatModel: null,
    }),
  );

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
