// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F04 markdown e2e — OFFLINE Codex fixture only: the "markdown" scenario
// returns a canned rich-markdown reply; asserts the extended blocks render
// as real elements (ol, task boxes, table, rule, del, img, link) and that
// unsafe image/link sources never become fetchable/navigable elements.

import { join } from "node:path";

export async function runMarkdownChecks({
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

  // --- session MD1: extended blocks render as real elements --------------
  let s = await launch({}, "s-md-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("MD Proj");
  await page.keyboard.press("Enter");
  await page.locator('button[title="New thread in MD Proj"]').click();
  await page.waitForSelector(".chat-head h1");
  const tid = (await snap(page)).selectedThreadId;

  await page.locator(".composer textarea").fill("markdown please");
  await page.keyboard.press("Enter");
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done",
  );
  const msg = page.locator(".msg").last();

  verify("MD-01 heading rendered", (await msg.locator("h1").count()) >= 1);
  verify(
    "MD-02 ordered list rendered",
    (await msg.locator("ol li").count()) === 2,
  );
  verify(
    "MD-03 task checkboxes rendered disabled",
    (await msg.locator("input.md-taskbox").count()) === 2 &&
      (await msg.locator("input.md-taskbox:checked").count()) === 1 &&
      (await msg.locator("input.md-taskbox:not([disabled])").count()) === 0,
  );
  verify(
    "MD-04 table with alignment rendered",
    (await msg.locator("table.md-table td").count()) === 3 &&
      (await msg.locator("td.md-al-center").count()) === 1,
  );
  verify("MD-05 rule rendered", (await msg.locator("hr.md-rule").count()) === 1);
  verify(
    "MD-06 del and link rendered",
    (await msg.locator("del").count()) === 1 &&
      (await msg.locator('a[href="https://example.com"]').count()) === 1,
  );
  verify(
    "MD-07 only the safe image became img; unsafe degraded",
    (await msg.locator('img[src="https://example.com/c.png"]').count()) === 1 &&
      (await msg.locator('img[src^="file:"]').count()) === 0 &&
      (await msg.locator('a[href^="file:"]').count()) === 0,
  );

  // Content ops: per-message copy + code-block copy button.
  verify(
    "MD-08 code block carries a pre head with lang + copy",
    (await msg.locator(".md-preblock .md-pre-head").count()) === 1 &&
      (await msg.locator(".md-pre-lang").innerText()) === "ts" &&
      (await msg.locator("button.md-copy").count()) === 1,
  );
  await msg.locator("button.md-copy").click();
  let clip = await page.evaluate(() => navigator.clipboard.readText());
  verify("MD-09 code copy wrote the plain code text", clip === "const answer = 42;", clip);
  await msg.locator(".msg-copy").click();
  clip = await page.evaluate(() => navigator.clipboard.readText());
  verify(
    "MD-10 message copy wrote the raw markdown source",
    clip.startsWith("# Heading") && clip.includes("```ts") && clip.includes("![cat]"),
    clip.slice(0, 80),
  );
  verify(
    "MD-11 copy button flips to the localized copied state",
    (await msg.locator(".msg-copy").innerText()) === "Copied",
  );
  await page.screenshot({ path: join(outDir, "88-markdown.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("md-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
