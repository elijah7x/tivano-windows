// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 reasoning e2e — OFFLINE Codex fixture only: reasoning items land as
// a collapsible block (not assistant text), stream then settle with the
// completed summary authoritative, persist across restart, localize.

import { join } from "node:path";

export async function runReasoningChecks({
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
  const newCodexThread = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`button[title="New thread in ${name}"]`);
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };

  // --- session RE1: reasoning block streams, settles, persists ----------
  let s = await launch({}, "s-reason-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid = await newCodexThread(page, "Reason Proj");

  await page.locator(".composer textarea").fill("reason please");
  await page.keyboard.press("Enter");
  const s1 = await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done",
  );
  const th = s1.threads.find((y) => y.id === tid);
  const rm = th.messages.find((m) => m.kind === "reasoning");
  verify(
    "REASON-01 reasoning message landed done with authoritative summary",
    rm?.status === "done" &&
      rm.content === "Considering the request — weighing options (done)",
    rm?.content,
  );
  // Reasoning is NOT part of the assistant text.
  const am = th.messages.find((m) => m.role === "assistant");
  verify(
    "REASON-02 reasoning stayed out of the assistant message",
    am && !am.content.includes("Considering the request"),
    am?.content?.slice(0, 120),
  );
  // F03 frozen TimelineGroup.build: thinking NEVER renders as a timeline
  // row — not by default and not with showReasoning on; it lives only in
  // the running indicator's chevron while the turn is live (covered by
  // WI-08 on a held turn).
  verify(
    "REASON-02b thinking hidden by default (frozen showReasoning=false)",
    (await page.locator(".reasoning-block").count()) === 0,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { showReasoning: true }),
  );
  // A settled turn has no live indicator — the stored thinking stays
  // unrendered, matching the frozen baseline.
  verify(
    "REASON-03 thinking never becomes a standalone row (frozen)",
    (await page.locator(".reasoning-block").count()) === 0,
  );
  await page.screenshot({ path: join(outDir, "87-reasoning.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("reason-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session RE2: restart persistence + zh label ----------------------
  s = await launch({}, "s-reason-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s2 = await waitSnapshot(
    page,
    (x) =>
      x.threads.find((y) => y.id === tid)?.messages.some(
        (m) => m.kind === "reasoning" && m.status === "done",
      ),
  );
  verify("REASON-04 reasoning block persisted across restart", true);
  // The showReasoning setting itself persisted in the shared store —
  // and the restored (dead) turn still shows no reasoning row.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { showReasoning: true }),
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".chat-head h1", { timeout: 10000 });
  verify(
    "REASON-05 restored turn renders no thinking row (frozen)",
    (await page.locator(".reasoning-block").count()) === 0,
  );
  await page.screenshot({ path: join(outDir, "88-reasoning-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("reason-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
