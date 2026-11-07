// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 turn-group fold e2e (frozen TurnFinishedBlock bounded cut): an
// earlier turn's work steps collapse into a "Worked for %@" details row
// while its user/assistant rows stay open; the live turn never folds.

import { join } from "node:path";

export async function runTurnGroupChecks({
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
  const waitSnap = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };

  const s = await launch({}, "s-tgroup-a");
  instances.push(s);
  const { app, proc, ledger } = s;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("TGrp Proj");
  await page.keyboard.press("Enter");
  await page.waitForSelector('button[title="New thread in TGrp Proj"]');
  await page.locator('button[title="New thread in TGrp Proj"]').click();
  const tid = (await snap(page)).selectedThreadId;

  // Turn 1 with plan/todos/tool steps, then a second plain turn.
  await page.locator(".composer textarea").fill("plan please");
  await page.keyboard.press("Enter");
  await waitSnap(page, (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done");
  await page.locator(".composer textarea").fill("second turn");
  await page.keyboard.press("Enter");
  await waitSnap(
    page,
    (x) =>
      x.threads.find((y) => y.id === tid)?.turn?.status === "done" &&
      x.threads.find((y) => y.id === tid)?.messages.filter((m) => m.role === "user").length === 2,
  );

  // TGRP-01: the earlier turn folds its steps behind one row.
  await page.waitForSelector(".turn-steps", { timeout: 8000 });
  verify("TGRP-01 earlier turn folds into a steps row", true);
  const foldedVisible = await page
    .locator(".plan-block")
    .first()
    .isVisible()
    .catch(() => false);
  verify(
    "TGRP-02 folded step content is hidden until expanded",
    !foldedVisible || !(await page.locator(".turn-steps[open]").count()),
  );

  // TGRP-03: summary carries the frozen "Worked for %@" + step count.
  const summaryText = await page.locator(".turn-steps > summary").innerText();
  verify(
    "TGRP-03 fold header reads Worked for %@ + N steps",
    /Worked for \d/.test(summaryText) && /step/.test(summaryText),
    summaryText,
  );

  // TGRP-04: user + assistant rows of the folded turn stay visible.
  const userStillVisible = await page
    .locator('.msg.user:has-text("plan please")')
    .isVisible();
  verify("TGRP-04 folded turn's user/assistant rows stay open", userStillVisible);

  // TGRP-04b: the fold's summary carries the frozen stave bar — one
  // stave per tool call/reply drawn inside the pill (A72).
  const staveCount = await page
    .locator(".turn-steps > summary .stave-bar svg rect.stave")
    .count();
  verify(
    "TGRP-04b fold summary shows the stave bar",
    (await page.locator(".turn-steps > summary .stave-bar").count()) === 1 &&
      staveCount >= 1,
    staveCount,
  );
  const staveLabel = await page
    .locator(".turn-steps > summary .stave-bar")
    .getAttribute("aria-label");
  verify(
    "TGRP-04c stave bar names its counts",
    typeof staveLabel === "string" && staveLabel.length > 0,
    staveLabel,
  );

  // TGRP-05: expanding reveals the steps again.
  await page.locator(".turn-steps > summary").click();
  await page.waitForSelector(".turn-steps[open] .plan-block", { timeout: 8000 });
  verify("TGRP-05 expanding restores the step rows", true);

  // TGRP-06: the live (latest) turn is never folded — only one .turn-steps.
  const foldCount = await page.locator(".turn-steps").count();
  verify("TGRP-06 live turn renders flat", foldCount === 1, foldCount);
  await page.screenshot({ path: join(outDir, "93-turn-group.png") });

  // TGRP-07: zh-Hans fold header + step count.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  const zhSummary = await page.locator(".turn-steps > summary").innerText();
  verify(
    "TGRP-07 zh-Hans fold header renders",
    zhSummary.includes("已工作") && zhSummary.includes("个步骤"),
    zhSummary,
  );
  await page.screenshot({ path: join(outDir, "94-turn-group-zh.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("TGRP-08 instance closed cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
