// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F19 context-usage e2e — OFFLINE Codex fixture only: the context ring
// appears once the provider reports, the popover shows honest numbers,
// the reading persists across restart and localizes. No ledger/credits.

import { join } from "node:path";

export async function runUsageChecks({
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

  // --- session U1: ring + popover ----------------------------------------
  let s = await launch({}, "s-usage-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const proj = await page.evaluate((n) =>
    window.tivano.invoke("projects:create", { name: n }), "Usage Proj");
  const th0 = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid, title: "usage" }),
    proj.id,
  );
  const tid = th0.id;
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);

  verify(
    "USAGE-01 no ring before any provider reading",
    (await page.locator(".ctx-ring").count()) === 0,
  );
  await page.locator(".composer textarea").fill("hello usage");
  await page.keyboard.press("Enter");
  const s1 = await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done",
  );
  const th = s1.threads.find((y) => y.id === tid);
  verify(
    "USAGE-02 reading landed on the thread",
    th.contextUsage?.usedTokens === 12800 && th.contextUsage?.windowTokens === 128000,
    th.contextUsage,
  );
  await page.waitForSelector(".ctx-ring", { timeout: 10000 });
  const tip = await page.locator(".ctx-ring").getAttribute("title");
  verify("USAGE-03 ring tooltip shows the fraction", tip === "10% of the context window used", tip);
  await page.locator(".ctx-ring").click();
  await page.waitForSelector(".ctx-pop", { timeout: 5000 });
  const pop = await page.locator(".ctx-pop").innerText();
  verify(
    "USAGE-04 popover shows honest numbers",
    pop.includes("12.8k / 128.0k tokens") && pop.includes("10%"),
    pop,
  );
  await page.screenshot({ path: join(outDir, "91-usage.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("usage-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session U2: restart persistence + zh ------------------------------
  s = await launch({}, "s-usage-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.contextUsage?.usedTokens === 12800,
  );
  verify("USAGE-05 reading persisted across restart", true);
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".ctx-ring", { timeout: 10000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".ctx-ring").click();
  await page.waitForSelector(".ctx-pop", { timeout: 5000 });
  const zhPop = await page.locator(".ctx-pop").innerText();
  verify(
    "USAGE-06 zh-Hans usage popover renders",
    zhPop.includes("用量") && zhPop.includes("12.8k / 128.0k tokens"),
    zhPop,
  );
  await page.screenshot({ path: join(outDir, "92-usage-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("usage-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
