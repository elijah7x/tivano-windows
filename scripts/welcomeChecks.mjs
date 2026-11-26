// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-50 E2E checks: first-launch WelcomeView (Work in a project / Just chat,
// expandable ready-provider strip, Manage -> Settings Models & Providers,
// Start a chat creating a standalone thread, unconfigured Codex gating Start
// a chat + showing Install a coding agent first, project creation -> NoThreadView,
// and zh-Hans localization).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { boundedClose } from "./closeBound.mjs";

export async function runWelcomeChecks({
  launchFresh,
  instances,
  snap,
  codexFixture,
  outDir,
  check,
  boundedClose,
}) {
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

  // --- 1. Fresh mock launch: two cards + collapsed 1-provider strip --------
  const s1 = await launchFresh({}, "welcome-mock");
  instances.push(s1);
  const page1 = await s1.app.firstWindow();
  await page1.waitForSelector('[data-testid="welcome-view"]', { timeout: 15000 });
  await page1.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page1.waitForSelector('h1:has-text("Where shall we begin today?")', { timeout: 8000 });

  const text1 = await page1.locator('[data-testid="welcome-view"]').innerText();
  verify(
    "WEL-01 first-launch shows Work in a project, Just chat, and 1 provider ready",
    text1.includes("Work in a project") &&
      text1.includes("Add a project folder") &&
      text1.includes("Just chat") &&
      text1.includes("Start a chat") &&
      text1.includes("1 provider ready") &&
      !text1.includes("Install a coding agent first"),
    text1,
  );

  const startEnabled = await page1.locator('[data-testid="welcome-start-chat"]').isEnabled();
  verify("WEL-02 Start a chat is enabled when Mock Provider is ready", startEnabled);

  // Collapsed by default -> clicking expands the checklist.
  verify(
    "WEL-03 provider checklist is collapsed initially",
    (await page1.locator("#welcome-provider-checklist").count()) === 0,
  );
  await page1.locator('[data-testid="welcome-provider-toggle"]').click();
  await page1.waitForSelector("#welcome-provider-checklist", { timeout: 5000 });
  const checklistText = await page1.locator("#welcome-provider-checklist").innerText();
  verify(
    "WEL-04 expanding provider strip reveals Mock Provider and Codex",
    checklistText.includes("Mock Provider") && checklistText.includes("Codex"),
    checklistText,
  );

  // Manage opens Settings directly on Models & Providers.
  await page1.locator('[data-testid="welcome-manage-providers"]').click();
  await page1.waitForSelector(".settings-modal", { timeout: 8000 });
  const activeSettingsTab = await page1
    .locator('.settings-nav [aria-selected="true"]')
    .getAttribute("data-settings-page");
  verify(
    "WEL-05 Manage opens Settings on the Models & Providers page",
    activeSettingsTab === "models",
    activeSettingsTab,
  );
  await page1.locator(".modal-actions .primary").click();
  await page1.waitForSelector(".settings-modal", { state: "detached", timeout: 8000 });

  // zh-Hans check on WelcomeView before starting a chat.
  await page1.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page1.waitForSelector('h1:has-text("今天从哪里开始？")', { timeout: 8000 });
  const zhText = await page1.locator('[data-testid="welcome-view"]').innerText();
  verify(
    "WEL-06 zh-Hans translates WelcomeView headings and buttons",
    zhText.includes("在项目里工作") &&
      zhText.includes("直接对话") &&
      zhText.includes("开始对话") &&
      zhText.includes("1 个服务商可用"),
    zhText,
  );
  await page1.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page1.waitForSelector('h1:has-text("Where shall we begin today?")', { timeout: 8000 });

  // Start a chat creates a standalone thread and opens ChatView.
  await page1.locator('[data-testid="welcome-start-chat"]').click();
  const afterChat = await waitSnap(
    page1,
    (s) => s.threads.length === 1 && s.selectedThreadId === s.threads[0]?.id,
  );
  verify(
    "WEL-07 Start a chat creates a standalone thread and selects it",
    afterChat.threads[0]?.projectId === null &&
      (await page1.locator('[data-testid="welcome-view"]').count()) === 0,
    afterChat.threads[0],
  );
  await page1.screenshot({ path: join(outDir, "65-welcome-mock-started.png") });

  const c1 = await boundedClose(s1.app, s1.proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
  s1.ledger.exited = c1.exited;
  s1.ledger.outcome = c1.killed ? `${c1.outcome}+killed` : c1.outcome;
  if (c1.exited && s1.freshDataRoot) {
    rmSync(s1.freshDataRoot, { recursive: true, force: true });
  }

  // --- 2. Fresh unconfigured Codex launch: Start a chat disabled + checklist -
  const openLogDir = mkdtempSync(join(tmpdir(), "tivano-welcome-open-"));
  const openLog = join(openLogDir, "open.log");
  const s2 = await launchFresh(
    { TIVANO_PROVIDER: "codex", TIVANO_TEST_OPEN_LOG: openLog },
    "welcome-codex-unconfigured",
  );
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector('[data-testid="welcome-view"]', { timeout: 15000 });
  await page2.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page2.waitForSelector('h2:has-text("Install a coding agent first")', { timeout: 8000 });

  const startDisabled = await page2.locator('[data-testid="welcome-start-chat"]').isDisabled();
  const projectEnabled = await page2.locator('[data-testid="welcome-add-project"]').isEnabled();
  verify(
    "WEL-08 unconfigured Codex disables Start a chat while keeping Add a project folder enabled",
    startDisabled && projectEnabled,
    { startDisabled, projectEnabled },
  );

  await page2.locator('[data-testid="welcome-install-codex"]').click();
  let loggedUrl = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      loggedUrl = readFileSync(openLog, "utf8").trim();
      if (loggedUrl) break;
    } catch {
      /* wait for log flush */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  verify(
    "WEL-09 Install button opens Codex CLI docs via links:open-external",
    loggedUrl === "https://developers.openai.com/codex/cli",
    loggedUrl,
  );
  await page2.screenshot({ path: join(outDir, "66-welcome-codex-unconfigured.png") });

  // Adding a project transitions WelcomeView -> NoThreadView.
  await page2.evaluate(() => window.tivano.invoke("projects:create", { name: "First Proj" }));
  await page2.waitForSelector('[data-testid="no-thread-view"]', { timeout: 8000 });
  const noThreadText = await page2.locator('[data-testid="no-thread-view"]').innerText();
  verify(
    "WEL-10 adding a project transitions WelcomeView to NoThreadView",
    noThreadText.includes("Pick a thread or start a new one") &&
      noThreadText.includes("New thread") &&
      (await page2.locator('[data-testid="welcome-view"]').count()) === 0,
    noThreadText,
  );

  const c2 = await boundedClose(s2.app, s2.proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
  s2.ledger.exited = c2.exited;
  s2.ledger.outcome = c2.killed ? `${c2.outcome}+killed` : c2.outcome;
  if (c2.exited && s2.freshDataRoot) {
    rmSync(s2.freshDataRoot, { recursive: true, force: true });
  }
  rmSync(openLogDir, { recursive: true, force: true });

  // --- 3. Fresh Codex fixture launch: Start a chat sends via task-workspace -
  if (codexFixture) {
    const s3 = await launchFresh(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
      },
      "welcome-codex-fixture",
    );
    instances.push(s3);
    const page3 = await s3.app.firstWindow();
    await page3.waitForSelector('[data-testid="welcome-view"]', { timeout: 15000 });
    await page3.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
    await page3.waitForSelector('h1:has-text("Where shall we begin today?")', { timeout: 8000 });

    const codexReadyText = await page3.locator('[data-testid="welcome-view"]').innerText();
    const codexStartEnabled = await page3
      .locator('[data-testid="welcome-start-chat"]')
      .isEnabled();
    verify(
      "WEL-11 Codex fixture launch shows 1 provider ready and enables Start a chat",
      codexReadyText.includes("1 provider ready") && codexStartEnabled,
      codexReadyText,
    );

    await page3.locator('[data-testid="welcome-start-chat"]').click();
    const codexThreadState = await waitSnap(
      page3,
      (s) => s.threads.length === 1 && s.selectedThreadId === s.threads[0]?.id,
    );
    const codexThreadId = codexThreadState.threads[0].id;
    await page3.waitForSelector(".composer textarea", { timeout: 8000 });
    await page3.locator(".composer textarea").fill("just chat on codex");
    await page3.keyboard.press("Enter");
    const codexDone = await waitSnap(
      page3,
      (s) => {
        const t = s.threads.find((x) => x.id === codexThreadId);
        return t?.turn?.status === "done";
      },
      20000,
    );
    const doneThread = codexDone.threads.find((x) => x.id === codexThreadId);
    const lastAsst = doneThread?.messages?.filter((m) => m.role === "assistant").at(-1);
    const taskWsDir = join(s3.freshDataRoot, "task-workspaces", codexThreadId);
    verify(
      "WEL-12 Just chat standalone thread completes a Codex turn in its task-workspace",
      doneThread?.projectId === null &&
        /fixture response/.test(lastAsst?.content ?? "") &&
        existsSync(taskWsDir),
      {
        projectId: doneThread?.projectId,
        assistant: lastAsst?.content?.slice(0, 80),
        taskWsDirExists: existsSync(taskWsDir),
      },
    );
    await page3.screenshot({ path: join(outDir, "67-welcome-codex-just-chat.png") });

    const c3 = await boundedClose(s3.app, s3.proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
    s3.ledger.exited = c3.exited;
    s3.ledger.outcome = c3.killed ? `${c3.outcome}+killed` : c3.outcome;
    if (c3.exited && s3.freshDataRoot) {
      rmSync(s3.freshDataRoot, { recursive: true, force: true });
    }
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const require = createRequire(join(root, "package.json"));
  const electronBin = require("electron");
  const codexFixture = join(root, "tests", "fixtures", "codex-app-server.mjs");
  const outDir = mkdtempSync(join(tmpdir(), "tivano-welcome-e2e-"));
  const instances = [];
  const results = [];
  const env = { ...process.env, TIVANO_MOCK_TICK_MS: "3" };
  delete env.ELECTRON_RUN_AS_NODE;

  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  };
  const snap = (page) => page.evaluate(() => window.tivano.invoke("state:get", {}));
  const launchFresh = async (envOverrides = {}, label = "instance") => {
    const freshDataRoot = mkdtempSync(join(tmpdir(), "tivano-welcome-fresh-"));
    const app = await electron.launch({
      executablePath: electronBin,
      args: [root, `--data-root=${freshDataRoot}`],
      env: { ...env, ...envOverrides },
      timeout: 30000,
    });
    let proc = null;
    try {
      proc = app.process();
    } catch {
      proc = null;
    }
    const ledger = { label, pid: proc?.pid ?? null, exited: false, outcome: "pending" };
    return { app, proc, ledger, freshDataRoot };
  };

  let runErr = null;
  try {
    await runWelcomeChecks({
      launchFresh,
      instances,
      snap,
      codexFixture,
      outDir,
      check,
      boundedClose,
    });
  } catch (err) {
    runErr = err;
    console.error("Welcome E2E failure:", err);
  } finally {
    for (const inst of instances) {
      if (inst.proc && inst.proc.exitCode === null && inst.proc.signalCode === null) {
        const r = await boundedClose(inst.app, inst.proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
        inst.ledger.exited = r.exited;
      }
      if (inst.ledger.exited && inst.freshDataRoot && existsSync(inst.freshDataRoot)) {
        rmSync(inst.freshDataRoot, { recursive: true, force: true });
      }
    }
    if (!runErr && results.every((r) => r.ok)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} welcome checks passed`);
  if (runErr || passed !== results.length) process.exit(1);
}
