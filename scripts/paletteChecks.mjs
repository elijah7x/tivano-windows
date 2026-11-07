// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F27 command-palette e2e — Ctrl+K/⌘ opens, search filters, arrows+Enter
// run, Esc/backdrop closes, context actions only apply with a selection.

import { join } from "node:path";

export async function runPaletteChecks({ launch: launchApp, instances, snap, outDir, check, boundedClose }) {
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

  const s1 = await launch("palette-main");
  instances.push(s1);
  const { app, proc, ledger } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // The palette's frozen chord is mod+K: ⌘K on this macOS host, Ctrl+K on
  // Windows/Linux (ctrl folds into the primary modifier there).
  const modK =
    (await page.evaluate(() => window.tivano.platform)) === "darwin"
      ? "Meta+k"
      : "Control+k";

  // Seed a uniquely-named thread so search assertions stay deterministic
  // inside the shared data root.
  await page.locator('button[title="New thread"]').click();
  const tid = (await snap(page)).selectedThreadId;
  await page.evaluate(
    (id) => window.tivano.invoke("threads:rename", { id, title: "PALETTE-SEEK" }),
    tid,
  );

  // PAL-01: Ctrl+K opens with the input focused.
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  const focused = await page.evaluate(
    () => document.activeElement?.closest(".palette-input") != null,
  );
  verify("PAL-01 Ctrl+K opens the palette with input focused", focused);

  // PAL-02: empty query shows recent threads plus actions.
  const firstRows = await page.locator(".palette-item").allInnerTexts();
  verify(
    "PAL-02 empty query lists a thread row and the New thread action",
    firstRows.some((x) => x.includes("PALETTE-SEEK")) &&
      firstRows.some((x) => x.includes("New thread")),
    firstRows.slice(0, 6),
  );

  // PAL-03: searching selects and Enter lands on the thread.
  await page.locator(".palette-input input").fill("PALETTE-SEEK");
  await page.waitForSelector('.palette-item:has-text("PALETTE-SEEK")', { timeout: 5000 });
  await page.keyboard.press("Enter");
  await page.waitForSelector(".palette", { state: "detached", timeout: 5000 });
  let s = await snap(page);
  verify("PAL-03 Enter on a thread row selects it", s.selectedThreadId === tid);

  // PAL-04: no-match empty state, then Escape closes.
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.locator(".palette-input input").fill("zz-no-such-thing");
  await page.waitForSelector(".palette-empty", { timeout: 5000 });
  verify("PAL-04 empty result renders the Nothing-matches state", true);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".palette", { state: "detached", timeout: 5000 });
  verify("PAL-05 Escape closes the palette", true);

  // PAL-06: "New thread" action creates + selects the new row. The data
  // root is shared, so diff the id sets rather than assuming ordering.
  const beforeIds = new Set((await snap(page)).threads.map((x) => x.id));
  const before = beforeIds.size;
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.locator(".palette-input input").fill("new thread");
  await page.waitForSelector('.palette-item:has-text("New thread")', { timeout: 5000 });
  const actionRow = page.locator('.palette-item:has-text("New thread")').first();
  await actionRow.click();
  s = await waitSnap(page, (x) => x.threads.length === before + 1);
  const made = s.threads.find((x) => !beforeIds.has(x.id));
  verify(
    "PAL-06 New thread action creates and selects",
    made != null && s.selectedThreadId === made.id,
    s.selectedThreadId,
  );

  // PAL-07: clicking the backdrop dismisses.
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.mouse.click(8, 8);
  await page.waitForSelector(".palette", { state: "detached", timeout: 5000 });
  verify("PAL-07 backdrop click closes", true);

  // PAL-08: Toggle terminal opens the dock.
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.locator(".palette-input input").fill("terminal");
  await page.locator('.palette-item:has-text("Toggle terminal")').click();
  await page.waitForSelector(".term-panel", { timeout: 8000 });
  verify("PAL-08 Toggle terminal opens the dock", true);

  // PAL-09: Archive thread applies to the selected thread only.
  const victim = (await snap(page)).selectedThreadId;
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.locator(".palette-input input").fill("archive");
  await page.locator('.palette-item:has-text("Archive thread")').click();
  s = await waitSnap(page, (x) => x.threads.find((y) => y.id === victim)?.isArchived === true);
  verify("PAL-09 Archive thread archives the selection", true);
  // Restore so later sessions are not surprised by extra archived rows.
  await page.evaluate(
    (id) => window.tivano.invoke("threads:unarchive", { id }),
    victim,
  );

  // PAL-10: the sidebar ⌘ button opens the palette too.
  await page.locator('button[title="Command palette"]').click();
  await page.waitForSelector(".palette", { timeout: 5000 });
  verify("PAL-10 sidebar button opens the palette", true);
  await page.screenshot({ path: join(outDir, "90-palette-en.png") });
  await page.keyboard.press("Escape");

  // PAL-11: zh-Hans localization of input + empty state + button title.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.keyboard.press(modK);
  await page.waitForSelector(".palette", { timeout: 5000 });
  const ph = await page.locator(".palette-input input").getAttribute("placeholder");
  const cmdTitle = await page.locator('button[title="命令面板"]').count();
  await page.locator(".palette-input input").fill("zz-不存在");
  await page.waitForSelector(".palette-empty", { timeout: 5000 });
  const emptyText = await page.locator(".palette-empty").innerText();
  await page.screenshot({ path: join(outDir, "91-palette-zh.png") });
  verify(
    "PAL-11 zh-Hans palette renders localized strings",
    ph === "搜索对话、项目与操作" && cmdTitle === 1 && emptyText.includes("没有匹配"),
    `${ph} | ${emptyText}`,
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("PAL-12 instance closed cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
