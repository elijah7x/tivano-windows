// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 slash suggestions e2e — the composer command menu (built-ins
// only), chip picking, keyboard handling, recency ordering and the
// frozen honest subset (mock offers /plan only).

import { join } from "node:path";

export async function runSlashChecks({
  launch,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const launchCodex = (label) =>
    launch(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
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
  const names = async (page) =>
    page.$$eval(".suggest-row .suggest-name", (els) => els.map((e) => e.textContent));
  const type = async (page, text) => {
    await page.locator(".composer textarea").fill(text);
    // .fill() does not move React-tracked caret state for suggestions —
    // emit a select by clicking then typing is not needed: fill sets the
    // value and our onChange captures selectionStart synchronously.
  };

  // --- codex session: menu, chip, recency, compact flow ------------------
  let s = await launchCodex("s-slash-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Slash Proj");
  await page.keyboard.press("Enter");
  await page.waitForSelector('button[title="New thread in Slash Proj"]');
  await page.locator('button[title="New thread in Slash Proj"]').click();
  await page.waitForSelector(".chat-head h1");
  const tid = (await snap(page)).selectedThreadId;
  // A bound session is required before /compact does anything.
  await page.locator(".composer textarea").fill("hi");
  await page.keyboard.press("Enter");
  await waitSnap(page, (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done");

  await type(page, "/");
  await page.waitForSelector(".suggest-menu", { timeout: 5000 });
  // Prior sessions in this run already used plan+compact — the frozen
  // recency ordering persisted across launches puts "plan" first.
  verify(
    "SL-01 empty query lists builtins, persisted recency first",
    (await names(page)).join(",") === "/plan,/compact",
    await names(page),
  );
  verify(
    "SL-02 header labels the menu",
    (await page.locator(".suggest-head").innerText()) === "Commands · Recently used first",
  );

  // Type narrows to a single match.
  await type(page, "/comp");
  await page.waitForFunction(
    () => document.querySelector(".suggest-row .suggest-name")?.textContent === "/compact" &&
      document.querySelectorAll(".suggest-row").length === 1,
    { timeout: 5000 },
  );
  verify("SL-03 query narrows to the matching row", (await names(page)).join(",") === "/compact");
  // Pick via keyboard: Enter turns the row into a chip, nothing is sent.
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cmd-chip", { timeout: 5000 });
  verify(
    "SL-04 pick drops a chip and clears the typed query",
    (await page.locator(".cmd-chip-name").innerText()) === "/compact" &&
      (await page.locator(".composer textarea").inputValue()) === "",
  );
  verify("SL-05 menu closed after pick", (await page.$$(".suggest-menu")).length === 0);
  // Backspace on the empty draft removes the chip (frozen deleteAtStart).
  await page.keyboard.press("Backspace");
  verify("SL-06 backspace clears the chip", (await page.$$(".cmd-chip")).length === 0);

  // Escape hides the menu until the text changes.
  await type(page, "/");
  await page.waitForSelector(".suggest-menu", { timeout: 5000 });
  await page.keyboard.press("Escape");
  verify("SL-07 Escape dismisses the menu", (await page.$$(".suggest-menu")).length === 0);
  await type(page, "/p");
  await page.waitForSelector(".suggest-menu", { timeout: 5000 });
  // "/p" contains-matches compact too; the prefix match still leads.
  verify(
    "SL-08 typing again reopens with the match",
    (await names(page)).join(",") === "/plan,/compact",
    await names(page),
  );

  // Mouse pick → chip, Enter sends the command: /plan toggles the mode.
  await page.locator(".suggest-row").first().dispatchEvent("mousedown");
  await page.waitForSelector(".cmd-chip");
  await page.keyboard.press("Enter");
  const s1 = await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.interactionMode === "plan",
  );
  verify("SL-09 picked /plan chip sends and toggles plan mode", true);
  verify(
    "SL-10 the use was recorded under the provider key",
    s1.recentCommands?.codex?.[0] === "plan",
    s1.recentCommands,
  );

  // Recency now leads the empty-query ordering.
  await type(page, "/");
  await page.waitForSelector(".suggest-menu", { timeout: 5000 });
  verify(
    "SL-11 recently used commands lead the menu",
    (await names(page)).join(",") === "/plan,/compact",
    await names(page),
  );
  await page.screenshot({ path: join(outDir, "93-slash-menu.png") });

  // Compact through the chip flow — notices land as before.
  await type(page, "/comp");
  await page.locator(".suggest-row").first().dispatchEvent("mousedown");
  await page.waitForSelector(".cmd-chip");
  await page.keyboard.press("Enter");
  const s2 = await waitSnap(page, (x) =>
    x.threads
      .find((y) => y.id === tid)
      ?.messages.some((m) => m.kind === "notice" && m.content === "Context compacted."),
  );
  verify(
    "SL-12 picked /compact chip runs compaction",
    s2.recentCommands?.codex?.[0] === "compact",
    s2.recentCommands,
  );
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("slash-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- mock session: honest builtin subset + zh header -------------------
  s = await launch({}, "s-slash-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "SlashMock" }),
  );
  await type(page, "/");
  await page.waitForSelector(".suggest-menu", { timeout: 5000 });
  verify(
    "SL-13 mock offers /plan only (no compact — provider cannot)",
    (await names(page)).join(",") === "/plan",
  );
  verify(
    "SL-14 zh header + detail are localized",
    (await page.locator(".suggest-menu").innerText()).includes("命令 · 最近使用的在前") &&
      (await page.locator(".suggest-row").innerText()).includes("开启或关闭计划模式"),
    await page.locator(".suggest-menu").innerText(),
  );
  await page.screenshot({ path: join(outDir, "94-slash-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("slash-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
