// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17 model/effort picker e2e checks — against the OFFLINE Codex fixture
// only: catalog pending→ready, UI select persists on the thread, the
// override reaches turn/start verbatim (fixture echoes it into the
// assistant text), thread/start|resume binds with the model, and the
// selection survives a restart. Nothing here proves a real provider.

import { join } from "node:path";

export async function runCodexModelChecks({
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
  const modelsList = (page) => page.evaluate(() => window.tivano.invoke("models:list", {}));
  const waitSnapshot = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };
  const newCodexThread = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".group-name");
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };
  const sendAndWaitDone = async (page, threadId, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
    await waitSnapshot(page, (s) => {
      const t = s.threads.find((x) => x.id === threadId)?.turn;
      return t?.status === "done" || t?.status === "error";
    });
    const th = (await snap(page)).threads.find((x) => x.id === threadId);
    verify(
      `turn completed (${text.slice(0, 20)})`,
      th?.turn?.status === "done" ||
        th?.messages.some((m) => m.turnId === th?.turn?.id && m.status === "done"),
      th?.turn?.error,
    );
  };
  const threadOf = async (page, id) =>
    (await snap(page)).threads.find((x) => x.id === id);

  // --- session M1: picker, catalog, override on the wire -------------------
  let s = await launch({}, "s-models-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const threadId = await newCodexThread(page, "Model Proj");

  // The picker exists only for codex mode and the catalog is honestly
  // pending before any session binds — never a fabricated list.
  await page.waitForSelector(".model-picker", { timeout: 10000 });
  const pending = await modelsList(page);
  verify(
    "models:list pending before first turn (no fabricated catalog)",
    pending.state === "pending",
    pending,
  );

  // Turn 1 binds the session — the picker may now serve the real catalog.
  await sendAndWaitDone(page, threadId, "hello");
  let cat = await modelsList(page);
  verify(
    "models:list ready after session binds; hidden rows filtered",
    cat.state === "ready" &&
      cat.models.some((m) => m.id === "fixture-model") &&
      cat.models.some((m) => m.id === "fixture-max") &&
      !cat.models.some((m) => m.id === "fixture-hidden"),
    cat.state === "ready" ? cat.models.map((m) => m.id) : cat,
  );
  const fm = cat.models.find((m) => m.id === "fixture-model");
  verify(
    "catalog carries efforts/default/fastTier from the provider",
    fm.isDefault === true &&
      fm.defaultEffort === "medium" &&
      fm.fastTier === "fast" &&
      fm.efforts.includes("high"),
    fm,
  );

  // Pick model+effort through the REAL selects.
  await page.locator(".model-select").focus();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".model-select option")].some((o) => o.value === "fixture-max"),
    null,
    { timeout: 10000 },
  );
  await page.locator(".model-select").selectOption("fixture-max");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === threadId);
    return t?.codexModel === "fixture-max";
  });
  await page.locator(".effort-select").selectOption("high");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === threadId);
    return t?.codexEffort === "high";
  });
  await page.screenshot({ path: join(outDir, "60-modelpicker-selected.png") });

  // Turn 2: the override must reach turn/start verbatim — the fixture
  // echoes the client-sent values into the assistant text.
  await sendAndWaitDone(page, threadId, "pick this model");
  const msg = (await threadOf(page, threadId)).messages
    .filter((m) => m.role === "assistant")
    .at(-1);
  verify(
    "model+effort reached turn/start verbatim (fixture echo)",
    msg.content.includes("[m=fixture-max e=high]"),
    msg.content.slice(0, 140),
  );
  const t2 = await threadOf(page, threadId);
  verify(
    "provider-reported model persisted next to the selection",
    t2.codexModelReported === "fixture-model" || t2.codexModelReported === "fixture-max",
    { reported: t2.codexModelReported, selected: t2.codexModel },
  );

  // Fast tier (A3): only fixture-model advertises a fast service tier —
  // the toggle must NOT render while fixture-max is selected.
  verify(
    "no fast-tier toggle for a model without serviceTiers",
    (await page.locator(".fast-tier").count()) === 0,
  );
  await page.locator(".model-select").selectOption("fixture-model");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === threadId);
    return t?.codexModel === "fixture-model";
  });
  await page.waitForSelector(".fast-tier", { timeout: 10000 });
  verify(
    "fast-tier toggle appears for an advertising model, unchecked",
    (await page.locator(".fast-tier-check").isChecked()) === false,
  );
  await page.locator(".fast-tier-check").check();
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === threadId);
    return t?.codexServiceTier === "fast";
  });
  await sendAndWaitDone(page, threadId, "fast please");
  const msgTier = (await threadOf(page, threadId)).messages
    .filter((m) => m.role === "assistant")
    .at(-1);
  verify(
    "serviceTier reached turn/start verbatim as serviceTierForTurn",
    msgTier.content.includes("[m=fixture-model e=high t=fast]"),
    msgTier.content.slice(0, 140),
  );
  await page.screenshot({ path: join(outDir, "61-modelturn-echo.png") });
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("models-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }

  // --- session M2: restart keeps the selection; resume binds with it -------
  s = await launch({}, "s-models-b-restart");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  // Select the SAME thread deterministically — earlier e2e sessions share
  // this dataRoot, so a positional sidebar click can land on a foreign
  // thread with no model selection.
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), threadId);
  await page.waitForSelector(".model-picker", { timeout: 10000 });
  const restored = await threadOf(page, threadId);
  verify(
    "model+effort+tier selection survives restart",
    restored.codexModel === "fixture-model" &&
      restored.codexEffort === "high" &&
      restored.codexServiceTier === "fast",
    {
      model: restored.codexModel,
      effort: restored.codexEffort,
      tier: restored.codexServiceTier,
    },
  );
  // Give the picker a moment to fetch its (pending) catalog and settle.
  await page.waitForTimeout(300);
  const selDebug = await page.evaluate(() => {
    const el = document.querySelector(".model-select");
    return el
      ? {
          value: el.value,
          options: [...el.options].map((o) => `${o.value}:${o.textContent}`),
          picker: document.querySelector(".model-picker")?.getAttribute("data-cat"),
          note: document.querySelector(".model-note")?.textContent,
        }
      : null;
  });
  verify(
    "picker shows the persisted model after restart",
    selDebug?.value === "fixture-model",
    selDebug,
  );
  await page.waitForSelector(".fast-tier", { timeout: 10000 });
  verify(
    "fast-tier checkbox reflects the persisted tier after restart",
    (await page.locator(".fast-tier-check").isChecked()) === true,
  );

  // A fresh session resumes the codex thread — thread/resume must carry
  // the model, and its echo lands on codexModelReported.
  await sendAndWaitDone(page, threadId, "after restart");
  const t3 = await threadOf(page, threadId);
  verify(
    "resumed thread reports the selected model",
    t3.codexModelReported === "fixture-model",
    t3.codexModelReported,
  );
  const msg2 = t3.messages.filter((m) => m.role === "assistant").at(-1);
  verify(
    "post-restart turn still sends model+effort+tier",
    msg2.content.includes("[m=fixture-model e=high t=fast]"),
    msg2.content.slice(0, 140),
  );
  await page.screenshot({ path: join(outDir, "62-modelpicker-restart.png") });

  // Clear the model back to default — the picker returns to "" and the
  // next turn carries no override tag.
  await page.locator(".model-select").selectOption("");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === threadId);
    return t?.codexModel === undefined && t?.codexServiceTier === undefined;
  });
  await sendAndWaitDone(page, threadId, "back to default");
  const msg3 = (await threadOf(page, threadId)).messages
    .filter((m) => m.role === "assistant")
    .at(-1);
  verify(
    "cleared model → next turn sends no override and no tier",
    !msg3.content.includes("[m=fixture-model") && !msg3.content.includes("t=fast"),
    msg3.content.slice(0, 140),
  );
  {
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("models-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }
}
