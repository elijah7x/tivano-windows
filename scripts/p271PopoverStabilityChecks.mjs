// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-71 e2e checks: thread overflow, header More controls, and model/effort
// + combo lists capture a stable anchored layout on first open after idle,
// settle without jumping during async font/data loads or background snapshot
// ticks, and stay clamped inside constrained windows.

export async function runP271PopoverStabilityChecks({
  launch: launchApp,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  const s = await launchApp(
    {
      TIVANO_PROVIDER: "codex",
      TIVANO_CODEX_FIXTURE: codexFixture,
      TIVANO_CODEX_NODE: process.execPath,
      TIVANO_WORKSPACE_ROOT: workspaceRoot,
    },
    "p271-popover-stability",
  );
  instances.push(s);
  const { app, proc, ledger } = s;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });

  const pairAlpha = {
    id: "p271-pair-alpha",
    provider: "codex",
    orchestratorModel: "fixture-max",
    workerModel: "fixture-model",
    name: "Alpha Combo",
    headProfiles: [],
  };
  const pairBeta = {
    id: "p271-pair-beta",
    provider: "codex",
    orchestratorModel: "fixture-model",
    workerModel: "fixture-max",
    name: "Beta Combo",
    headProfiles: [],
  };
  const extraPairs = Array.from({ length: 6 }, (_, i) => ({
    id: `p271-pair-extra-${i + 1}`,
    provider: "codex",
    orchestratorModel: "fixture-model",
    workerModel: "fixture-max",
    name: `Combo ${i + 1}`,
    headProfiles: [],
  }));

  const threadIds = await page.evaluate(
    async ({ pairs }) => {
      await window.tivano.invoke("settings:set", {
        language: "en",
        hydraEnabled: true,
        hydraPairs: pairs,
      });
      const ids = [];
      for (let i = 1; i <= 14; i++) {
        const th = await window.tivano.invoke("threads:create", {
          projectId: null,
          title: `P271 Thread ${String(i).padStart(2, "0")}`,
        });
        ids.push(th.id);
      }
      const activeId = ids[0];
      await window.tivano.invoke("threads:select", { id: activeId });
      await window.tivano.invoke("threads:set-model", {
        threadId: activeId,
        model: "fixture-max",
        effort: "high",
        fastTier: null,
      });
      return ids;
    },
    { pairs: [pairAlpha, pairBeta, ...extraPairs] },
  );

  await page.waitForSelector(".effort-picker-btn", { timeout: 10000 });
  // Simulate idle dwell + font settling before first popover open.
  await page.evaluate(() => document.fonts?.ready);
  await new Promise((r) => setTimeout(r, 150));

  const readRect = async (selector) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    }, selector);

  // PS-01: Thread overflow menu stays anchored across background updates and unhover.
  const firstRow = page.locator(`.row[data-thread-id="${threadIds[0]}"]`);
  await firstRow.hover();
  await firstRow.locator('button[title="Thread actions"]').click();
  await page.waitForSelector(".row-menu", { timeout: 5000 });
  const rowMenuInitial = await readRect(".row-menu");
  // Move pointer off the row so .row-actions hides (display: none) and trigger a snapshot tick.
  await page.mouse.move(700, 300);
  await page.evaluate(async () => {
    await window.tivano.invoke("settings:set", { showReasoning: true });
    await window.tivano.invoke("settings:set", { showReasoning: false });
    await document.fonts?.ready;
  });
  await new Promise((r) => setTimeout(r, 250));
  const rowMenuSettled = await readRect(".row-menu");
  verify(
    "PS-01 thread overflow menu stays anchored after idle, unhover, and background snapshot updates",
    Boolean(
      rowMenuInitial &&
        rowMenuSettled &&
        Math.abs(rowMenuSettled.left - rowMenuInitial.left) <= 1 &&
        Math.abs(rowMenuSettled.top - rowMenuInitial.top) <= 1 &&
        rowMenuSettled.left >= 8 &&
        rowMenuSettled.right <= rowMenuSettled.innerWidth - 8 &&
        rowMenuSettled.top >= 8 &&
        rowMenuSettled.bottom <= rowMenuSettled.innerHeight - 8,
    ),
    { rowMenuInitial, rowMenuSettled },
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".row-menu", { state: "detached", timeout: 5000 });

  // PS-02: Header More controls overflow keeps top-right pinned while async editors load.
  await page.locator(".more-controls-btn").click();
  await page.waitForSelector(".more-controls-menu", { timeout: 5000 });
  const moreBtnBox = await readRect(".more-controls-btn");
  const moreInitial = await readRect(".more-controls-menu");
  await new Promise((r) => setTimeout(r, 250));
  const moreSettled = await readRect(".more-controls-menu");
  verify(
    "PS-02 More controls overflow keeps top-right pinned during async Open-in settling",
    Boolean(
      moreBtnBox &&
        moreInitial &&
        moreSettled &&
        Math.abs(moreSettled.right - moreInitial.right) <= 1 &&
        Math.abs(moreSettled.top - moreInitial.top) <= 1 &&
        Math.abs(moreSettled.right - moreBtnBox.right) <= 2 &&
        moreSettled.top >= moreBtnBox.bottom &&
        moreSettled.bottom <= moreSettled.innerHeight - 8,
    ),
    { moreBtnBox, moreInitial, moreSettled },
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".more-controls-menu", { state: "detached", timeout: 5000 });

  // PS-03: Effort popover + expanded two-column model/combo list stay anchored without post-open jump.
  await page.locator(".effort-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.effort-only", { timeout: 5000 });
  const effortBtnBox = await readRect(".effort-picker-btn");
  const effortInitial = await readRect(".model-picker-pop.effort-only");
  await page.evaluate(async () => {
    await window.tivano.invoke("settings:set", { showReasoning: true });
    await window.tivano.invoke("settings:set", { showReasoning: false });
    await document.fonts?.ready;
  });
  await new Promise((r) => setTimeout(r, 250));
  const effortSettled = await readRect(".model-picker-pop.effort-only");
  verify(
    "PS-03a effort popover anchors above its button and does not jump after opening",
    Boolean(
      effortBtnBox &&
        effortInitial &&
        effortSettled &&
        Math.abs(effortSettled.left - effortInitial.left) <= 1 &&
        Math.abs(effortSettled.top - effortInitial.top) <= 1 &&
        Math.abs(effortSettled.bottom - (effortBtnBox.top - 6)) <= 2,
    ),
    { effortBtnBox, effortInitial, effortSettled },
  );

  // Expand to the two-column model + combo list and confirm bottom edge stays pinned above trigger.
  await page.locator(".effort-model-btn").click();
  await page.waitForSelector(".model-picker-pop.two-col", { timeout: 5000 });
  const twoColInitial = await readRect(".model-picker-pop.two-col");
  await new Promise((r) => setTimeout(r, 250));
  const twoColSettled = await readRect(".model-picker-pop.two-col");
  verify(
    "PS-03b expanded model/combo list stays pinned above trigger without jumping or horizontal overflow",
    Boolean(
      effortBtnBox &&
        twoColInitial &&
        twoColSettled &&
        Math.abs(twoColSettled.left - twoColInitial.left) <= 1 &&
        Math.abs(twoColSettled.top - twoColInitial.top) <= 1 &&
        Math.abs(twoColSettled.bottom - (effortBtnBox.top - 6)) <= 2 &&
        twoColSettled.scrollWidth <= twoColSettled.clientWidth + 1 &&
        twoColSettled.left >= 8 &&
        twoColSettled.right <= twoColSettled.innerWidth - 8 &&
        twoColSettled.top >= 8,
    ),
    { effortBtnBox, twoColInitial, twoColSettled },
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-picker-pop", { state: "detached", timeout: 5000 });

  // PS-04: Constrained-window placement (860x560 minimum window size) clamps model/combo,
  // bottom-row thread overflow, and More controls cleanly inside the viewport.
  const priorBounds = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const prev = win.getBounds();
    win.setBounds({ x: prev.x, y: prev.y, width: 860, height: 560 });
    return prev;
  });
  await page.waitForFunction(
    () => window.innerWidth <= 860 && window.innerHeight <= 560,
    null,
    { timeout: 5000 },
  );

  await page.locator(".model-picker-btn").click();
  await page.waitForSelector(".model-picker-pop.two-col", { timeout: 5000 });
  const constrainedModelBtn = await readRect(".model-picker-btn");
  const constrainedPicker = await readRect(".model-picker-pop.two-col");
  verify(
    "PS-04a constrained window keeps two-column model/combo popover inside viewport and above trigger",
    Boolean(
      constrainedModelBtn &&
        constrainedPicker &&
        constrainedPicker.left >= 8 &&
        constrainedPicker.right <= constrainedPicker.innerWidth - 8 &&
        constrainedPicker.top >= 8 &&
        constrainedPicker.bottom <= constrainedModelBtn.top &&
        constrainedPicker.scrollWidth <= constrainedPicker.clientWidth + 1,
    ),
    { constrainedModelBtn, constrainedPicker },
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-picker-pop", { state: "detached", timeout: 5000 });

  const lastRow = page.locator(`.row[data-thread-id="${threadIds[threadIds.length - 1]}"]`);
  await lastRow.scrollIntoViewIfNeeded();
  await lastRow.hover();
  await lastRow.locator('button[title="Thread actions"]').click();
  await page.waitForSelector(".row-menu", { timeout: 5000 });
  const constrainedRowMenu = await readRect(".row-menu");
  verify(
    "PS-04b constrained window keeps bottom-row thread overflow menu completely inside viewport",
    Boolean(
      constrainedRowMenu &&
        constrainedRowMenu.left >= 8 &&
        constrainedRowMenu.right <= constrainedRowMenu.innerWidth - 8 &&
        constrainedRowMenu.top >= 8 &&
        constrainedRowMenu.bottom <= constrainedRowMenu.innerHeight - 8,
    ),
    constrainedRowMenu,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".row-menu", { state: "detached", timeout: 5000 });

  await page.locator(".more-controls-btn").click();
  await page.waitForSelector(".more-controls-menu", { timeout: 5000 });
  const constrainedMoreMenu = await readRect(".more-controls-menu");
  verify(
    "PS-04c constrained window keeps More controls menu inside viewport",
    Boolean(
      constrainedMoreMenu &&
        constrainedMoreMenu.left >= 8 &&
        constrainedMoreMenu.right <= constrainedMoreMenu.innerWidth - 8 &&
        constrainedMoreMenu.top >= 8 &&
        constrainedMoreMenu.bottom <= constrainedMoreMenu.innerHeight - 8,
    ),
    constrainedMoreMenu,
  );

  if (priorBounds) {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
    }, priorBounds);
  }

  const closed = await boundedClose(app, proc);
  ledger.exited = closed.exited;
  ledger.outcome = `p271:${closed.outcome}`;
  verify("PS-05 P2-71 instance exited cleanly", closed.exited, closed);
}
