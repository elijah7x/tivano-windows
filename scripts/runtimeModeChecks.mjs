// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F06 runtime-mode e2e — OFFLINE Codex fixture only: the mode picker is
// per-thread, maps to the frozen policy table on turn/start (fixture
// echoes ap/rev/sb), persists across restart, never retargets the past.
// Nothing here proves enforcement by a real provider.

import { join } from "node:path";

export async function runRuntimeModeChecks({
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
  const sendAndCollect = async (page, threadId, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
    const s = await waitSnapshot(page, (x) => {
      const t = x.threads.find((y) => y.id === threadId)?.turn;
      return t?.status === "done" || t?.status === "error";
    });
    const th = s.threads.find((x) => x.id === threadId);
    return th?.messages.at(-1)?.content ?? "";
  };

  // --- session R1: default, each mode on the wire, persist -----------------
  let s = await launch({}, "s-mode-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid = await newCodexThread(page, "Mode Proj");

  await page.waitForSelector("select.runtime-mode", { timeout: 10000 });
  // F01: frozen AppSettings defaultRuntimeMode — absent setting seeds
  // fullAccess at creation (AppModel.swift:987 @ d31e093b).
  verify(
    "mode picker defaults to fullAccess (frozen absent default)",
    (await page.locator("select.runtime-mode").inputValue()) === "fullAccess",
  );
  const echo1 = await sendAndCollect(page, tid, "default mode");
  verify(
    "default fullAccess policy reached turn/start verbatim",
    echo1.includes("[ap=never rev=user sb=dangerFullAccess]"),
    echo1,
  );

  // F01: the settings-level default seeds the NEXT created thread —
  // pinning supervised yields a supervised thread.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { defaultRuntimeMode: "supervised" }),
  );
  await page.locator('button[title="New thread in Mode Proj"]').click();
  const sNew = await waitSnapshot(
    page,
    (x) =>
      x.selectedThreadId !== tid &&
      x.threads.some((y) => y.id === x.selectedThreadId),
  );
  const tidSup = sNew.selectedThreadId;
  verify(
    "defaultRuntimeMode seeds the new thread",
    sNew.threads.find((y) => y.id === tidSup)?.runtimeMode === "supervised",
    sNew.threads.find((y) => y.id === tidSup)?.runtimeMode,
  );
  await page.evaluate(
    (id) => window.tivano.invoke("threads:select", { id }),
    tid,
  );
  await waitSnapshot(page, (x) => x.selectedThreadId === tid);

  for (const [mode, tag] of [
    ["autoAcceptEdits", "[ap=on-request rev=user sb=workspaceWrite]"],
    ["auto", "[ap=on-request rev=auto_review sb=workspaceWrite]"],
    ["fullAccess", "[ap=never rev=user sb=dangerFullAccess]"],
    ["supervised", "[ap=untrusted rev=user sb=readOnly]"],
  ]) {
    await page.locator("select.runtime-mode").selectOption(mode);
    await waitSnapshot(
      page,
      (x) => x.threads.find((y) => y.id === tid)?.runtimeMode === mode,
    );
    const echo = await sendAndCollect(page, tid, `mode ${mode}`);
    verify(`mode ${mode} reached turn/start verbatim`, echo.includes(tag), echo);
  }

  await page.locator("select.runtime-mode").selectOption("fullAccess");
  await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.runtimeMode === "fullAccess",
  );
  await page.screenshot({ path: join(outDir, "81-runtime-mode.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("mode-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session R2: restart keeps the mode; zh labels -----------------------
  s = await launch({}, "s-mode-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s2 = await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.runtimeMode === "fullAccess",
  );
  verify("runtime mode persisted across restart", true);
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector("select.runtime-mode", { timeout: 10000 });
  verify(
    "picker reflects the persisted mode",
    (await page.locator("select.runtime-mode").inputValue()) === "fullAccess",
  );
  // A mid-flight thread bound under the old bind still applies the NEW
  // mode on its NEXT turn — per-turn params, never a retarget.
  const echo2 = await sendAndCollect(page, tid, "after restart");
  verify(
    "resumed thread turn carries the persisted mode",
    echo2.includes("[ap=never rev=user sb=dangerFullAccess]"),
    echo2,
  );

  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector("select.runtime-mode", { timeout: 10000 });
  const zhValue = await page.locator("select.runtime-mode option:checked").innerText();
  verify("zh-Hans mode label renders", zhValue.trim() === "完全访问", zhValue);
  await page.screenshot({ path: join(outDir, "82-runtime-mode-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("mode-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
