// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex CLI setup e2e checks (P2N): the Settings choose/save/clear surface
// driven through the REAL bridge — TIVANO_TEST_CODEX_PICK bypasses only the
// native dialog itself (main-side env, still fully validated); every fake
// "codex.exe" is a temp text file that is never executed. Sessions prove:
// persisted save/clear, pending-restart vs active vs blocked precedence,
// restart effect, invalid/cancelled picks and the honest setup-state UI —
// with screenshots for both locales.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function runCodexSetupChecks({
  launch: launchApp,
  instances,
  snap,
  dataRoot,
  codexFixture,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) => launchApp({
    TIVANO_TEST_MODE: "codex-setup", TIVANO_TEST_CODEX_PICK: "", ...overrides,
  }, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const exeDir = mkdtempSync(join(tmpdir(), "tivano-e2e-codexexe-"));
  const fakeExe = join(exeDir, "codex.exe");
  writeFileSync(fakeExe, "MZ — fake, never executed");
  mkdirSync(join(exeDir, "b"));
  const fakeExeB = join(exeDir, "b", "codex.exe");
  writeFileSync(fakeExeB, "MZ - fake B, never executed");
  const missingExe = join(exeDir, "gone-codex.exe");

  const waitIdle = (page) => page.waitForFunction(
    () => document.querySelector(".codex-setup")?.getAttribute("aria-busy") === "false",
    null, { timeout: 10000 },
  );
  const waitField = (page, label, value) => page.waitForFunction(({ label, value }) => {
    const cells = [...document.querySelectorAll(".codex-setup .kv > span")];
    const i = cells.findIndex(cell => cell.textContent === label);
    return i >= 0 && cells[i + 1]?.textContent === value;
  }, { label, value }, { timeout: 10000 });
  const button = (page, name) => page.locator(".codex-setup").getByRole("button", { name, exact: true });
  const chooseAndSave = async (page, path) => {
    await button(page, "Choose program…").click();
    await waitField(page, "Selected, not saved", path);
    await waitIdle(page);
    await button(page, "Save").click();
    await waitField(page, "Saved program", path);
    await waitIdle(page);
  };
  const openSettings = async (page, { pinEn = true } = {}) => {
    // Localized buttons below assume en; pin it since the shared store may
    // carry a zh language left by an earlier check module.
    if (pinEn) await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
    await page.locator(".sidebar-foot button.row").click();
    await page.waitForSelector(".modal", { timeout: 10000 });
    await page.waitForSelector(".codex-setup", { timeout: 10000 });
    await waitIdle(page);
  };
  const closeSettings = async (page) => {
    await page.locator(".modal-actions .primary").click();
    await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });
  };
  const setupState = (page) => page.evaluate(() => window.tivano.invoke("codex:setup-state", {}));
  const storedSettings = () =>
    JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8")).settings;

  // --- session A: invalid pick, then cancel --------------------------------
  let s = await launch(
    { TIVANO_TEST_CODEX_PICK: missingExe },
    "s-codexsetup-a-invalid",
  );
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });

  let st = await setupState(page);
  verify(
    "cold launch is mock with nothing saved and no codex runtime",
    st.launchProvider === "mock" &&
      st.savedExecutable === null &&
      st.savedEffect === "none" &&
      st.effectiveSource === null &&
      st.runtime === null,
    st.savedEffect,
  );
  const badPick = await page.evaluate(() => window.tivano.invoke("codex:choose", {}));
  verify(
    "a pick failing validation reports invalid, nothing pending",
    badPick.status === "invalid" &&
      badPick.reason.includes("CODEX_EXECUTABLE_INVALID"),
    badPick.status,
  );
  st = await setupState(page);
  verify("invalid pick left no pending choice", st.pendingExecutable === null);
  // UI: trigger the same invalid choose through the real button so the
  // component-local error line renders — screenshot is the evidence.
  await openSettings(page);
  await page.locator(".codex-setup button", { hasText: "Choose program" }).click();
  await page.waitForSelector(".codex-setup-error", { timeout: 10000 });
  const errText = await page.locator(".codex-setup").innerText();
  verify(
    "settings shows the invalid-path reason, not a saved claim",
    errText.includes("CODEX_EXECUTABLE_INVALID") && errText.includes("None saved"),
    errText.slice(0, 160),
  );
  await page.screenshot({ path: join(outDir, "50-codexsetup-invalid-en.png") });
  await closeSettings(page);
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "invalid-pick session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );

  // --- session B: cancel keeps everything ----------------------------------
  s = await launch({ TIVANO_TEST_CODEX_PICK: "" }, "s-codexsetup-b-cancel");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const cancel = await page.evaluate(() => window.tivano.invoke("codex:choose", {}));
  st = await setupState(page);
  verify(
    "cancelling the chooser changes nothing",
    cancel.status === "canceled" &&
      st.savedExecutable === null &&
      st.pendingExecutable === null,
    cancel.status,
  );
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "cancel session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );

  // --- session C: choose → save → pending-restart → clear -------------------
  s = await launch({ TIVANO_TEST_CODEX_PICK: fakeExe }, "s-codexsetup-c-save");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });

  await openSettings(page);
  await button(page, "Choose program…").click();
  await waitField(page, "Selected, not saved", realpathSync(fakeExe));
  await waitIdle(page);
  st = await setupState(page);
  verify("pending choice visible before save, nothing persisted yet",
    st.pendingExecutable === realpathSync(fakeExe) && st.savedExecutable === null &&
    !("codexExecutable" in storedSettings()));
  await button(page, "Save").click();
  await waitField(page, "Saved program", realpathSync(fakeExe));
  await waitIdle(page);
  st = await setupState(page);
  verify(
    "saved path is persisted and reported pending-restart (launch is mock)",
    st.savedExecutable === realpathSync(fakeExe) &&
      st.savedEffect === "pending-restart" &&
      st.pendingExecutable === null,
    st.savedEffect,
  );
  verify(
    "store.json on disk carries the setting",
    storedSettings().codexExecutable === realpathSync(fakeExe),
    storedSettings().codexExecutable,
  );
  // Settings UI: saved path + next-launch wording (en), then zh-Hans.
  await page.waitForFunction(
    (p) => document.querySelector(".codex-setup")?.textContent?.includes(p),
    realpathSync(fakeExe),
    { timeout: 10000 },
  );
  const modalText = await page.locator(".codex-setup").innerText();
  verify(
    "settings shows saved path + takes-effect-next-launch",
    modalText.includes(realpathSync(fakeExe)) &&
      modalText.includes("Takes effect on next launch") &&
      modalText.includes("not installed or verified"),
    modalText.slice(0, 200),
  );
  await page.screenshot({ path: join(outDir, "51-codexsetup-saved-pending-en.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await closeSettings(page);
  await openSettings(page, { pinEn: false });
  await page.waitForFunction(
    (p) => document.querySelector(".codex-setup")?.textContent?.includes(p),
    realpathSync(fakeExe),
    { timeout: 10000 },
  );
  const zhText = await page.locator(".codex-setup").innerText();
  verify(
    "zh-Hans settings shows the same honest states",
    zhText.includes("下次启动生效") && zhText.includes("已保存的程序") &&
      zhText.includes("模拟服务商") && !zhText.includes("Mock Provider (synthetic"),
    zhText.slice(0, 160),
  );
  await page.screenshot({ path: join(outDir, "52-codexsetup-saved-pending-zh.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await closeSettings(page);
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "save session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );

  // --- session D: restart — the saved value selects Codex -------------------
  s = await launch({}, "s-codexsetup-d-restart");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  st = await setupState(page);
  verify(
    "restart routed to Codex FROM the saved value",
    st.launchProvider === "codex" &&
      st.effectiveSource === "saved" &&
      st.effectiveExecutable === realpathSync(fakeExe) &&
      st.savedEffect === "active",
    `launch=${st.launchProvider} src=${st.effectiveSource} effect=${st.savedEffect}`,
  );
  const snapD = await snap(page);
  verify(
    "codex info reports the saved executable honestly (unverified, not authenticated)",
    snapD.info.mode === "codex" &&
      snapD.info.codex?.executable === realpathSync(fakeExe) &&
      ["unsupported", "configured-unverified"].includes(snapD.info.codex?.state),
    snapD.info.codex?.state,
  );
  await openSettings(page);
  await page.waitForFunction(
    () =>
      document.querySelector(".codex-setup")?.textContent?.includes("In effect for this launch"),
    null,
    { timeout: 10000 },
  );
  await page.screenshot({ path: join(outDir, "53-codexsetup-active-en.png") });
  const pinned = await setupState(page);
  for (const [pick, effect] of [[fakeExeB, "pending-restart"], [fakeExe, "active"]]) {
    await app.evaluate((_electron, value) => { process.env.TIVANO_TEST_CODEX_PICK = value; }, pick);
    await chooseAndSave(page, realpathSync(pick));
    const next = await setupState(page);
    verify("saved " + effect + " leaves the pinned launch unchanged",
      next.savedExecutable === realpathSync(pick) && next.pendingExecutable === null &&
      next.savedEffect === effect && next.effectiveExecutable === pinned.effectiveExecutable &&
      next.effectiveSource === pinned.effectiveSource && next.launchProvider === pinned.launchProvider &&
      JSON.stringify(next.runtime) === JSON.stringify(pinned.runtime) &&
      storedSettings().codexExecutable === realpathSync(pick));
    await waitField(page, "Saved effect", effect === "active" ? "In effect for this launch" : "Takes effect on next launch");
  }
  await closeSettings(page);
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "restart session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );

  // --- session E: explicit provider override blocks the saved value --------
  s = await launch(
    {
      TIVANO_PROVIDER: "synthetic-stdio",
      TIVANO_SYNTHETIC_NODE: process.execPath,
    },
    "s-codexsetup-e-override",
  );
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  st = await setupState(page);
  verify(
    "explicit TIVANO_PROVIDER keeps routing and blocks the saved value",
    st.launchProvider === "synthetic-stdio" &&
      st.savedExecutable === realpathSync(fakeExe) &&
      st.savedEffect === "blocked" &&
      (st.savedBlockReason ?? "").includes("TIVANO_PROVIDER"),
    `${st.launchProvider}:${st.savedEffect}`,
  );
  await openSettings(page);
  await page.waitForFunction(
    () =>
      document.querySelector(".codex-setup")?.textContent?.includes("TIVANO_PROVIDER"),
    null,
    { timeout: 10000 },
  );
  const overrideText = await page.locator(".codex-setup").innerText();
  verify("override wording makes no unconditional restart promise",
    overrideText.includes("explicit provider and environment settings take priority") &&
    !overrideText.includes("Takes effect on next launch"));
  await page.screenshot({ path: join(outDir, "54-codexsetup-blocked-override-en.png") });
  await closeSettings(page);
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "override session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );

  // --- session F: env fixture outranks the saved value ----------------------
  s = await launch(
    {
      TIVANO_PROVIDER: "codex",
      TIVANO_CODEX_FIXTURE: codexFixture,
      TIVANO_CODEX_NODE: process.execPath,
    },
    "s-codexsetup-f-fixture",
  );
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  st = await setupState(page);
  verify(
    "env fixture wins: source fixture, saved blocked",
    st.launchProvider === "codex" &&
      st.effectiveSource === "fixture" &&
      st.savedEffect === "blocked" &&
      st.runtime?.state === "fixture",
    `${st.effectiveSource}:${st.savedEffect}`,
  );
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "fixture session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );

  for (const [label, overrides, provider, source] of [
    ["empty-provider", { TIVANO_PROVIDER: "" }, "mock", null],
    ["executable", { TIVANO_PROVIDER: "codex", TIVANO_CODEX_EXECUTABLE: fakeExeB }, "codex", "environment"],
  ]) {
    s = await launch(overrides, "s-codexsetup-" + label);
    instances.push(s); ({ app, proc, ledger } = s);
    page = await app.firstWindow();
    await page.waitForSelector(".sidebar-head", { timeout: 15000 });
    st = await setupState(page);
    verify(label + " keeps its routing and blocks the saved candidate",
      st.launchProvider === provider && st.effectiveSource === source &&
      st.savedEffect === "blocked" && st.savedExecutable === realpathSync(fakeExe) &&
      st.effectiveExecutable === (source ? realpathSync(fakeExeB) : null));
    await openSettings(page);
    const text = await page.locator(".codex-setup").innerText();
    verify(label + " UI does not promise next-launch activation", !text.includes("Takes effect on next launch"));
    await closeSettings(page);
    c = await boundedClose(app, proc);
    ledger.exited = c.exited; ledger.outcome = c.outcome;
    verify(label + " session closed cleanly", c.outcome === "resolved" && c.exited && c.exitCode === 0);
  }

  // --- session G: clear removes the persisted value; next launch is mock ----
  s = await launch({ TIVANO_TEST_CODEX_PICK: "" }, "s-codexsetup-g-clear");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await openSettings(page);
  await button(page, "Choose program…").click();
  await waitIdle(page);
  st = await setupState(page);
  verify("cancel with a saved path preserves memory and disk",
    st.savedExecutable === realpathSync(fakeExe) && st.pendingExecutable === null &&
    storedSettings().codexExecutable === realpathSync(fakeExe));
  const beforeClear = st;
  await button(page, "Clear").click();
  await waitField(page, "Saved program", "None saved");
  await waitIdle(page);
  st = await setupState(page);
  verify("clear removes saved path without hot-switching this launch",
    st.savedExecutable === null && st.savedEffect === "none" &&
    st.effectiveExecutable === beforeClear.effectiveExecutable &&
    st.launchProvider === beforeClear.launchProvider &&
    JSON.stringify(st.runtime) === JSON.stringify(beforeClear.runtime) &&
    !("codexExecutable" in storedSettings()));
  const clearText = await page.locator(".codex-setup").innerText();
  verify("clear explains the next launch and keeps this one unchanged",
    clearText.includes("After restart") && clearText.includes("This launch is unchanged"));
  await page.screenshot({ path: join(outDir, "55-codexsetup-cleared-en.png") });
  await closeSettings(page);
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "clear session closed cleanly",
    c.outcome === "resolved" && c.exited && c.exitCode === 0,
    `outcome=${c.outcome}`,
  );
  verify(
    "cleared setting persisted — the field is absent on disk",
    !("codexExecutable" in storedSettings()),
  );

  s = await launch({}, "s-codexsetup-h-cleared-restart");
  instances.push(s); ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  st = await setupState(page);
  verify("restart after clear uses the unchanged mock default",
    st.launchProvider === "mock" && st.effectiveSource === null &&
    st.effectiveExecutable === null && st.savedExecutable === null && st.runtime === null);
  c = await boundedClose(app, proc);
  ledger.exited = c.exited; ledger.outcome = c.outcome;
  verify("cleared restart closed cleanly", c.outcome === "resolved" && c.exited && c.exitCode === 0);

  // Controlled IPC replies exercise renderer ordering only, not persistence.
  s = await launch({}, "s-codexsetup-i-ui-ordering");
  instances.push(s); ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const uiBase = await setupState(page);
  await app.evaluate(({ ipcMain }, state) => {
    globalThis.__codexUi = { state: [], choose: [], save: [], value: state, failRead: true, holdRead: false };
    for (const [channel, key] of [["codex:setup-state", "state"], ["codex:choose", "choose"], ["codex:save", "save"]]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        const q = globalThis.__codexUi;
        if (key === "state") {
          if (q.failRead) throw new Error("injected initial read failure");
          if (!q.holdRead) return q.value;
        }
        return new Promise((resolve, reject) => q[key].push({ resolve, reject }));
      });
    }
  }, uiBase);
  const configure = (value) => app.evaluate((_electron, value) => { Object.assign(globalThis.__codexUi, value); }, value);
  const calls = (key) => app.evaluate((_electron, k) => globalThis.__codexUi[k].length, key);
  const waitCalls = async (key, n) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await calls(key) >= n) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(key + " did not receive request " + n);
  };
  const reply = (key, i, value, error = false) => app.evaluate((_electron, { key, i, value, error }) => {
    const q = globalThis.__codexUi[key][i];
    if (error) q.reject(new Error(value)); else q.resolve(value);
  }, { key, i, value, error });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const openPending = async () => {
    await page.locator(".sidebar-foot button.row").click();
    await page.waitForSelector(".codex-setup");
    await settle();
  };
  await openPending(); await button(page, "Retry").waitFor();
  verify("UI: initial read failure is recoverable and writes stay disabled", await button(page, "Choose program…").isDisabled());
  await page.screenshot({ path: join(outDir, "56-codexsetup-load-retry-en.png") });
  await configure({ failRead: false });
  await button(page, "Retry").click(); await waitIdle(page);
  verify("UI: retry loads state and re-enables actions", await button(page, "Choose program…").isEnabled());

  await configure({ holdRead: true });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".codex-setup button")].find(b => b.textContent === "Choose program…");
    b.click(); b.click();
  });
  await waitCalls("choose", 1); await settle();
  verify("UI: same-tick double click invokes choose once", await calls("choose") === 1);
  await reply("choose", 0, { status: "canceled" }); await waitCalls("state", 1);
  verify("UI: operation remains busy until its refresh completes",
    await page.locator(".codex-setup").getAttribute("aria-busy") === "true" &&
    await page.locator(".codex-setup button:enabled").count() === 0);
  const selectedUi = { ...uiBase, pendingExecutable: realpathSync(fakeExe) };
  await configure({ holdRead: false, value: selectedUi });
  await reply("state", 0, selectedUi); await waitIdle(page);
  await button(page, "Save").click(); await waitCalls("save", 1);
  await reply("save", 0, { status: "error", error: "ENOSPC injected UI failure" });
  await waitIdle(page);
  verify("UI: failed save keeps candidate retryable and shows the error",
    await button(page, "Save").isEnabled() &&
    (await page.locator(".codex-setup-error").innerText()).includes("ENOSPC"));
  await button(page, "Save").click(); await waitCalls("save", 2);
  await configure({ value: { ...uiBase, savedExecutable: realpathSync(fakeExe), savedEffect: "pending-restart" } });
  await reply("save", 1, { status: "saved", path: realpathSync(fakeExe), changed: true });
  await waitIdle(page);
  verify("UI: explicit retry clears the previous save error", await page.locator(".codex-setup-error").count() === 0);

  for (const rejected of [false, true]) {
    await configure({ holdRead: true });
    const oldIndex = await calls("state");
    await button(page, "Refresh status").click(); await waitCalls("state", oldIndex + 1);
    await closeSettings(page);
    const newStart = await calls("state");
    await openPending(); await waitCalls("state", newStart + 1); await settle();
    const newEnd = await calls("state");
    for (let i = newStart; i < newEnd; i++) await reply("state", i, { ...uiBase, chooserBusy: true });
    await waitIdle(page);
    await reply("state", oldIndex, rejected ? "late old read failure" : { ...uiBase, savedExecutable: "/stale/codex.exe" }, rejected);
    await settle();
    verify("UI: late " + (rejected ? "failure" : "success") + " cannot overwrite a reopened settings window",
      !(await page.locator(".codex-setup").innerText()).includes("/stale/") &&
      await page.locator(".codex-setup-error").count() === 0 &&
      await button(page, "Choosing…").isDisabled());
    await configure({ holdRead: false, value: uiBase });
    await button(page, "Refresh status").click(); await waitIdle(page);
    verify("UI: refreshing after the chooser closes restores actions " + rejected,
      await button(page, "Choose program…").isEnabled());
  }
  await closeSettings(page);
  c = await boundedClose(app, proc);
  ledger.exited = c.exited; ledger.outcome = c.outcome;
  verify("UI-ordering instance closed cleanly", c.outcome === "resolved" && c.exited && c.exitCode === 0);

  rmSync(exeDir, { recursive: true, force: true });
}
