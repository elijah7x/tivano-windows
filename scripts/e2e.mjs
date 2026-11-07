// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// E2E on an isolated dev instance: real Electron process, temporary data
// root, synthetic provider only. Assertions bind to real object identity —
// thread/turn/approval ids and persisted states from state:get and the
// store file itself — never to "some row exists" or "some text matches".
// A process is exited only when its ChildProcess reports exitCode or
// signalCode (or fires 'exit'); a dead handle is uncertainty, not proof.
// Synthetic data is deleted only when every instance provably exited;
// any failure or doubt preserves it and fails the run.

import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolveEvidenceDir } from "./evidenceDir.mjs";
import { awaitExit, boundedClose } from "./closeBound.mjs";
import { runGitPanelChecks } from "./gitPanelChecks.mjs";
import { runCheckpointChecks } from "./checkpointPreviewChecks.mjs";
import { runWorktreeChecks } from "./worktreeChecks.mjs";
import { runScriptsChecks } from "./scriptsChecks.mjs";
import { runGitCommitChecks } from "./gitCommitChecks.mjs";
import { runShortcutChecks } from "./shortcutChecks.mjs";
import { runCodexSetupChecks } from "./codexSetupChecks.mjs";
import { runCodexModelChecks } from "./codexModelChecks.mjs";
import { runCodexQuestionChecks } from "./codexQuestionChecks.mjs";
import { runFollowUpChecks } from "./followUpChecks.mjs";
import { runArchiveChecks } from "./archiveChecks.mjs";
import { runMinimapChecks } from "./minimapChecks.mjs";
import { runThemeChecks } from "./themeChecks.mjs";
import { runTokenChecks } from "./tokenChecks.mjs";
import { runRuntimeModeChecks } from "./runtimeModeChecks.mjs";
import { runInteractionModeChecks } from "./interactionModeChecks.mjs";
import { runForwardChecks } from "./forwardChecks.mjs";
import { runReasoningChecks } from "./reasoningChecks.mjs";
import { runPlanToolChecks } from "./planToolChecks.mjs";
import { runUsageChecks } from "./usageChecks.mjs";
import { runMarkdownChecks } from "./markdownChecks.mjs";
import { runNotifyChecks } from "./notifyChecks.mjs";
import { runLimitChecks } from "./limitChecks.mjs";
import { runFolderChecks } from "./folderChecks.mjs";
import { runUnreadChecks } from "./unreadChecks.mjs";
import { runPaletteChecks } from "./paletteChecks.mjs";
import { runSleepChecks } from "./sleepChecks.mjs";
import { runAntiSlopChecks } from "./antiSlopChecks.mjs";
import { runFontSizeChecks } from "./fontSizeChecks.mjs";
import { runLocalControlChecks } from "./localControlChecks.mjs";
import { runHydraChecks } from "./hydraChecks.mjs";
import { runTurnGroupChecks } from "./turnGroupChecks.mjs";
import { runMoveChecks } from "./moveChecks.mjs";
import { runCodexApprovalChecks } from "./codexApprovalChecks.mjs";
import { runCodexMcpChecks } from "./codexMcpChecks.mjs";
import { runNoticeChecks } from "./noticeChecks.mjs";
import { runTitleChecks } from "./titleChecks.mjs";
import { runCompactChecks } from "./compactChecks.mjs";
import { runSlashChecks } from "./slashChecks.mjs";
import { runAttachChecks } from "./attachChecks.mjs";
import { runFileMentionChecks } from "./fileMentionChecks.mjs";
import { runAppearanceChecks } from "./appearanceChecks.mjs";
import { runHelperChecks } from "./helperChecks.mjs";
import { runRevertChecks } from "./revertChecks.mjs";
import { runFinishSignalChecks } from "./finishSignalChecks.mjs";
import { runMessageMenuChecks } from "./messageMenuChecks.mjs";
import { runProjectIconChecks } from "./projectIconChecks.mjs";
import { runBranchMenuChecks } from "./branchMenuChecks.mjs";
import { runModelListChecks } from "./modelListChecks.mjs";
import { runMcpChecks } from "./mcpChecks.mjs";
import { runWallpaperChecks } from "./wallpaperChecks.mjs";
import { runForgeChecks } from "./forgeChecks.mjs";
import { runNewThreadPromptChecks } from "./newThreadPromptChecks.mjs";
import { runGeneralSettingsChecks } from "./generalSettingsChecks.mjs";
import { runWorkingIndicatorChecks } from "./workingIndicatorChecks.mjs";
import { runLayoutChecks, runShelfChecks, runQuickChecks } from "./layoutChecks.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "package.json"));
const electronBin = require("electron");

const outDir = resolveEvidenceDir({ explicit: process.env.E2E_EVIDENCE_DIR, sourceDir: root });
console.log(`evidence dir: ${outDir}`);

const runId = `r1-${new Date().toISOString().replace(/[:.T]/g, "-").slice(0, 19)}`;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
// Every instance this run owns is registered with its real process identity
// — no process-name sweep, no historical PIDs, nothing external is touched.
const instanceLedger = [];

const dataRoot = mkdtempSync(join(tmpdir(), "tivano-e2e-data-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "tivano-e2e-ws-"));
console.log(`isolated data root: ${dataRoot}`);
console.log(`isolated workspace root: ${workspaceRoot}`);

const env = { ...process.env, TIVANO_MOCK_TICK_MS: "3" };
delete env.ELECTRON_RUN_AS_NODE; // would degrade Electron to plain Node

const pageErrors = [];

/** Launch and immediately pin the ChildProcess identity for this run. */
async function launch(envOverrides = {}, label = "instance") {
  const app = await electron.launch({
    executablePath: electronBin,
    args: [root, `--data-root=${dataRoot}`],
    env: { ...env, ...envOverrides },
    timeout: 30000,
  });
  let proc = null;
  try {
    proc = app.process();
  } catch {
    proc = null; // handle may be lost on early disconnect — uncertainty, not exit
  }
  const entry = { label, pid: proc?.pid ?? null, exited: false, outcome: "pending" };
  instanceLedger.push(entry);
  const attach = (page) => page.on("pageerror", (e) => pageErrors.push(String(e)));
  app.on("window", attach);
  for (const page of app.windows()) attach(page);
  return { app, proc, ledger: entry };
}

/** state:get via the page bridge — real ids and states, not DOM guesses. */
async function snap(page) {
  return page.evaluate(() => window.tivano.invoke("state:get", {}));
}

// This Playwright build treats a Promise predicate as truthy in
// waitForFunction. Await IPC on the Node side before testing its result.
async function waitSnapshot(page, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await snap(page);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the expected application state");
}

/** Wait until the persisted store shows the crashed-turn approval pending.
 * F30: turn bodies live in turns/<thread-id>.json segments, not the head. */
function approvalPersisted(turnId) {
  try {
    const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
    for (const t of doc.threads) {
      const turn =
        t.turn ??
        (() => {
          try {
            return JSON.parse(
              readFileSync(join(dataRoot, "turns", `${t.id}.json`), "utf8"),
            ).turn;
          } catch {
            return undefined;
          }
        })();
      if (turn?.id === turnId) return turn.approval?.status === "pending";
    }
  } catch {
    /* file mid-write or missing */
  }
  return false;
}

const instances = [];
let runError = null;

try {
  // ---- session 1: create, send, approval, streaming ----------------------
  const s1 = await launch({}, "s1-crash-recovery");
  instances.push(s1);
  let { app, proc, ledger } = s1;
  let page = await app.firstWindow();

  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  check("app boots into the product shell", true);
  await page.screenshot({ path: join(outDir, "01-empty-state.png") });

  // create a project via the inline field
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Demo Project");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".group-name");
  const afterProject = await snap(page);
  const project = afterProject.projects.find((p) => p.name === "Demo Project");
  check("project created and listed", Boolean(project));

  // a thread scoped inside that project via its group "+" affordance
  await page.locator(`button[title="New thread in Demo Project"]`).click();
  await page.waitForSelector(".chat-head h1");
  const afterScoped = await snap(page);
  const scoped = afterScoped.threads.find((t) => t.id === afterScoped.selectedThreadId);
  check(
    "project-scoped thread entry creates a grouped thread",
    Boolean(scoped && project && scoped.projectId === project.id),
  );

  // an ungrouped one through the header button — proven by identity:
  // exactly one NEW thread, selected, with projectId === null
  const beforeIds = new Set(afterScoped.threads.map((t) => t.id));
  await page.locator('button[title="New thread"]').click();
  const afterUngrouped = await waitSnapshot(page, (s) => {
    const t = s.threads.find((item) => item.id === s.selectedThreadId);
    return t && !beforeIds.has(t.id) && t.projectId === null;
  });
  const fresh = afterUngrouped.threads.filter((t) => !beforeIds.has(t.id));
  const selected = afterUngrouped.threads.find((t) => t.id === afterUngrouped.selectedThreadId);
  check(
    "ungrouped thread created and selected (by id)",
    fresh.length === 1 && selected === fresh[0] && selected.projectId === null,
  );

  const badge = page.locator(".chat-head .badge.mock");
  check(
    "mock provider badge is visibly labelled",
    (await badge.count()) === 1 &&
      (await badge.isVisible()) &&
      /Mock Provider|模拟提供方/.test(await badge.innerText()),
  );

  // send a prompt that triggers the scripted approval — bind the turn id
  const threadId = selected.id;
  await page.locator(".composer textarea").fill("please [mock:approval] run the sync");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".approval", { timeout: 10000 });
  const withTurn = await snap(page);
  const turnThread = withTurn.threads.find((t) => t.id === threadId);
  const pendingApproval = turnThread?.turn?.approval;
  check(
    "approval request is pending on THIS turn",
    turnThread?.turn?.status === "waiting-approval" && pendingApproval?.status === "pending",
  );
  await page.screenshot({ path: join(outDir, "02-approval-card.png") });
  const turnId = turnThread.turn.id;
  const approvalId = pendingApproval.id;

  await page.getByRole("button", { name: "Allow once" }).click();
  await page.waitForFunction(
    (aid) => {
      const el = [...document.querySelectorAll(".approval")].pop();
      return el && !el.querySelector(".actions");
    },
    approvalId,
    { timeout: 10000 },
  );
  await waitSnapshot(page, (s) => {
    const turn = s.threads.find((t) => t.id === threadId)?.turn;
    return turn?.id === turnId && turn.status === "done" &&
      turn.approval?.id === approvalId && turn.approval.status === "resolved";
  });
  check("turn streamed and completed after approval", true);
  await page.screenshot({ path: join(outDir, "03-turn-done.png") });

  // settings: theme + About attribution
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".modal");
  const about = await page.locator(".modal .about").last().innerText();
  check(
    "About carries upstream attribution",
    about.includes("Droppy Code by Jordy Spruit") &&
      about.includes("getdroppycode.app") &&
      about.includes("AGPL"),
  );
  check(
    "About is honest about the mock provider",
    /Mock Provider|模拟提供方/.test(about) && /synthetic|合成/.test(about),
  );
  await page.screenshot({ path: join(outDir, "04-settings-about.png") });

  // switch to zh-Hans and confirm localization lands
  await page.getByRole("radio", { name: "简体中文" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("对话列表"), null, {
    timeout: 5000,
  });
  check("zh-Hans applies to the chrome", true);
  await page.screenshot({ path: join(outDir, "05-zh-hans.png") });
  await page.getByRole("button", { name: "关闭" }).click();

  // park a SECOND turn at a pending approval — then require the pending
  // state to be durable on disk before killing, not merely "300ms later"
  await page.locator(".composer textarea").fill("crash [mock:approval] here");
  await page.keyboard.press("Enter");
  const crashSnap = await waitSnapshot(page, (s) => {
    const turn = s.threads.find((t) => t.id === threadId)?.turn;
    return turn && turn.id !== turnId && turn.status === "waiting-approval" &&
      turn.approval?.status === "pending";
  });
  const crashTurn = crashSnap.threads.find((t) => t.id === threadId)?.turn;
  const crashPending =
    crashTurn?.status === "waiting-approval" && crashTurn?.approval?.status === "pending";
  check("second approval request is pending", Boolean(crashPending));
  const crashTurnId = crashTurn.id;
  // Poll the store file itself until the pending approval is durable —
  // a fixed sleep can race the 80ms debounce and crash before the write.
  for (let i = 0; i < 50 && !approvalPersisted(crashTurnId); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check("pending approval persisted to disk before crash", approvalPersisted(crashTurnId));

  proc.kill("SIGKILL");
  const exited = await awaitExit(proc, 5000);
  ledger.exited = exited;
  ledger.outcome = "sigkill";
  check(
    "simulated crash mid-turn (real exit observed)",
    exited && (proc.exitCode !== null || proc.signalCode !== null),
    `exitCode=${proc.exitCode} signalCode=${proc.signalCode}`,
  );

  // ---- session 2: recovery ----------------------------------------------
  const s2 = await launch({}, "s2-recovery");
  instances.push(s2);
  ({ app, proc, ledger } = s2);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await waitSnapshot(page, (s) => {
    const th = s.threads.find((t) => t.id === threadId);
    const msg = th?.messages.find((m) => m.id === th.turn?.assistantMessageId);
    return th?.turn?.id === crashTurnId && th.turn.status === "interrupted" &&
      th.turn.approval?.status === "expired" && msg?.status === "interrupted";
  });
  check(
    "restart marks the in-flight turn interrupted (not resumed)",
    true,
  );
  await page.screenshot({ path: join(outDir, "06-recovery-interrupted.png") });

  // the thread is still usable afterwards — assert on THIS turn's identity
  const marker = `fresh-${Date.now()}`;
  await page.locator(".composer textarea").fill(marker);
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => {
    const th = s.threads.find((t) => t.id === threadId);
    const last = th?.messages.find((m) => m.id === th.turn?.assistantMessageId);
    return th?.turn?.id !== crashTurnId && th?.turn?.status === "done" &&
      last?.role === "assistant" && last.status === "done" && last.content.includes(marker);
  });
  check("thread accepts a new turn after recovery", true);
  await page.screenshot({ path: join(outDir, "07-post-recovery.png") });

  check("no renderer page errors", pageErrors.length === 0, pageErrors.join("; "));

  const s2close = await boundedClose(app, proc);
  ledger.exited = s2close.exited;
  ledger.outcome = s2close.outcome;
  check(
    "second instance exited cleanly",
    s2close.outcome === "resolved" && s2close.exited && s2close.exitCode === 0,
    `outcome=${s2close.outcome} exitCode=${s2close.exitCode} killed=${s2close.killed}`,
  );

  // ---- session 3: synthetic-stdio mode — real controlled child ---------
  const s3 = await launch(
    {
      TIVANO_PROVIDER: "synthetic-stdio",
      TIVANO_SYNTHETIC_NODE: process.execPath,
      TIVANO_WORKSPACE_ROOT: workspaceRoot,
    },
    "s3-synthetic-stdio",
  );
  instances.push(s3);
  ({ app, proc, ledger } = s3);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  // Language persisted from session 2 — return to English for selectors.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.waitForSelector('button[title="New project"]', { timeout: 10000 });
  const s3state = await snap(page);
  check(
    "synthetic-stdio mode reports itself accurately",
    s3state.info.mode === "synthetic-stdio" &&
      s3state.info.realCli.status === "not-configured" &&
      Boolean(s3state.info.syntheticRuntime?.executable),
    `runtime=${s3state.info.syntheticRuntime?.executable ?? "?"} ${s3state.info.syntheticRuntime?.version ?? ""}`,
  );

  // R1-08: Chromium/browser state must live INSIDE this run's data root —
  // two different roots can never share userData/sessionData.
  const paths3 = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath("userData"),
    sessionData: electronApp.getPath("sessionData"),
  }));
  check(
    "userData/sessionData are isolated inside the run data root",
    paths3.userData.startsWith(dataRoot) && paths3.sessionData.startsWith(dataRoot) &&
      paths3.userData !== paths3.sessionData,
    `${paths3.userData} | ${paths3.sessionData}`,
  );

  // project → auto-registered workspace → turn over the real child
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Synthetic Project");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".group-name");
  await page.locator('button[title="New thread in Synthetic Project"]').click();
  await page.waitForSelector(".chat-head h1");
  const s3thread = (await snap(page)).selectedThreadId;
  const synBadge = page.locator(".chat-head .badge.mock");
  check(
    "synthetic child badge labels the controlled local process",
    (await synBadge.isVisible()) &&
      /Synthetic stdio|合成子进程/.test(await synBadge.innerText()),
  );
  await page.screenshot({ path: join(outDir, "08-synthetic-stdio-badge.png") });

  await page.locator(".composer textarea").fill("[syn:approval] controlled step");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".approval", { timeout: 10000 });
  // Capture the NOT-YET-DECIDED once/deny card — a resolved card can never
  // prove the pending state.
  await page.screenshot({ path: join(outDir, "09-synthetic-approval-pending.png") });
  const optionLabels = await page.locator(".approval .actions button").allInnerTexts();
  check(
    "synthetic approval offers only once/deny",
    optionLabels.length === 2 &&
      optionLabels.some((t) => /Allow once|允许一次/.test(t)) &&
      optionLabels.some((t) => /Deny|拒绝/.test(t)),
    optionLabels.join(","),
  );
  await page.getByRole("button", { name: "Allow once" }).click();
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s3thread)?.turn;
    return t?.status === "done";
  });
  check("synthetic turn completed through the child process", true);
  await page.screenshot({ path: join(outDir, "10-synthetic-turn-done.png") });

  // zh-Hans synthetic state — real localized copy on screen, not key checks
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".chat-head .badge.mock", { timeout: 5000 });
  const zhBadgeText = await page.locator(".chat-head .badge.mock").innerText();
  check("zh-Hans synthetic badge is rendered", /合成子进程/.test(zhBadgeText), zhBadgeText);
  await page.screenshot({ path: join(outDir, "11-synthetic-zh-hans.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const s3close = await boundedClose(app, proc);
  ledger.exited = s3close.exited;
  ledger.outcome = s3close.outcome;
  check(
    "synthetic-stdio instance closed with children confirmed",
    s3close.outcome === "resolved" && s3close.exited && s3close.exitCode === 0,
    `outcome=${s3close.outcome} exitCode=${s3close.exitCode}`,
  );

  // ---- session 4: no workspace root → WORKSPACE_NOT_CONFIGURED ---------
  const s4 = await launch(
    {
      TIVANO_PROVIDER: "synthetic-stdio",
      TIVANO_SYNTHETIC_NODE: process.execPath,
    },
    "s4-no-workspace",
  );
  instances.push(s4);
  ({ app, proc, ledger } = s4);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("No Workspace");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".group-name");
  await page.locator('button[title="New thread in No Workspace"]').click();
  await page.waitForSelector(".chat-head h1");
  const s4thread = (await snap(page)).selectedThreadId;
  await page.locator(".composer textarea").fill("will not run");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s4thread)?.turn;
    return t?.status === "error" && t.error?.includes("WORKSPACE_NOT_CONFIGURED");
  });
  check("missing workspace surfaces WORKSPACE_NOT_CONFIGURED", true);
  await page.screenshot({ path: join(outDir, "12-workspace-not-configured.png") });
  // zh-Hans error banner — localized chrome over the real error state
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".chat-head h1", { timeout: 5000 });
  await page.screenshot({ path: join(outDir, "13-workspace-zh-hans.png") });
  const s4close = await boundedClose(app, proc);
  ledger.exited = s4close.exited;
  ledger.outcome = s4close.outcome;
  check(
    "workspace-error instance exited cleanly",
    s4close.outcome === "resolved" && s4close.exited && s4close.exitCode === 0,
    `outcome=${s4close.outcome} exitCode=${s4close.exitCode}`,
  );

  // ---- session 5: close failure → keep-open read-only state ------------
  const s5 = await launch(
    {
      TIVANO_TEST_DISPOSE_FAIL: "1",
      TIVANO_TEST_ASK: "keep",
    },
    "s5-close-fail-keep",
  );
  instances.push(s5);
  ({ app, proc, ledger } = s5);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  // request a real window close from the main side — cleanup fails, the
  // harness answers "keep open", and the app must stay read-only
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await waitSnapshot(page, (s) => s.readOnly === true, 15000);
  // Language persists from earlier sessions — match the readonly banner in
  // either English or zh-Hans.
  const roBanner = page.locator(".banner.error", { hasText: /read-only|只读/ });
  check(
    "failed close keeps the app open in a visible read-only state",
    await roBanner.isVisible(),
  );
  // read-only is enforced at engine level, not just the composer —
  // every persisted mutation must be refused through the real IPC path.
  const roMutation = await page.evaluate(() =>
    window.tivano.invoke("projects:create", { name: "blocked" }).then(
      () => "accepted",
      (e) => String(e?.message ?? e),
    ),
  );
  check(
    "read-only refuses persisted mutations via IPC",
    /read-only|closing/i.test(roMutation),
    roMutation.slice(0, 120),
  );
  check(
    "composer visibly disabled while read-only",
    await page.locator(".composer textarea").isDisabled(),
  );
  await page.screenshot({ path: join(outDir, "14-close-failed-readonly.png") });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }).catch(() => {}),
  );
  await page.screenshot({ path: join(outDir, "15-readonly-zh-hans.png") });
  // still alive — tear it down hard (its own lifecycle already refused)
  proc.kill("SIGKILL");
  ledger.exited = await awaitExit(proc, 5000);
  ledger.outcome = "sigkill";

  // ---- session 6: close failure → RETRY → confirmed clean exit ---------
  const s6 = await launch(
    {
      TIVANO_TEST_DISPOSE_FAIL: "1", // first dispose pass fails, retry succeeds
      TIVANO_TEST_ASK: "retry",
    },
    "s6-close-fail-retry",
  );
  instances.push(s6);
  ({ app, proc, ledger } = s6);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  // First dispose pass fails → harness answers "retry" → the retried pass
  // is confirmed → save → quit → the process REALLY exits on its own.
  const s6exited = await awaitExit(proc, 20000);
  ledger.exited = s6exited;
  ledger.outcome = s6exited ? "retry-clean-exit" : "still-running";
  check(
    "close failure → retry → real clean exit",
    s6exited && proc.exitCode === 0,
    `exitCode=${proc.exitCode} signalCode=${proc.signalCode}`,
  );
  await page.screenshot({ path: join(outDir, "16-retry-exited.png") }).catch(() => {});

  // ---- session 7: codex fixture — real app-server child, approvals, binding ----
  const codexFixture = join(root, "tests", "fixtures", "codex-app-server.mjs");
  const s7 = await launch(
    {
      TIVANO_PROVIDER: "codex",
      TIVANO_CODEX_FIXTURE: codexFixture,
      TIVANO_CODEX_NODE: process.execPath,
      TIVANO_WORKSPACE_ROOT: workspaceRoot,
    },
    "s7-codex-fixture",
  );
  instances.push(s7);
  ({ app, proc, ledger } = s7);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.waitForSelector('button[title="New project"]', { timeout: 10000 });
  const s7state = await snap(page);
  check(
    "codex mode reports the offline fixture honestly",
    s7state.info.mode === "codex" &&
      s7state.info.codex?.state === "fixture" &&
      s7state.info.codex.protocolPin === "0.164.0+6aaac694",
    `mode=${s7state.info.mode} state=${s7state.info.codex?.state}`,
  );

  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Codex Project");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".group-name");
  await page.locator('button[title="New thread in Codex Project"]').click();
  await page.waitForSelector(".chat-head h1");
  const s7thread = (await snap(page)).selectedThreadId;
  const codexBadge = page.locator(".chat-head .badge.mock");
  check(
    "codex fixture badge is labelled (not mock, not real-CLI)",
    (await codexBadge.isVisible()) &&
      /Codex fixture|Codex 夹具/.test(await codexBadge.innerText()),
    await codexBadge.innerText(),
  );
  await page.screenshot({ path: join(outDir, "17-codex-fixture-badge.png") });

  // approval scenario → the frozen decision card (server-offered
  // availableDecisions, not a synthetic once/deny)
  await page.locator(".composer textarea").fill("approval before the step");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".approval", { timeout: 15000 });
  await page.screenshot({ path: join(outDir, "18-codex-approval-pending.png") });
  const codexOptions = await page.locator(".approval .actions button").allInnerTexts();
  check(
    "codex command approval offers the frozen decision set",
    codexOptions.length === 4 &&
      codexOptions.some((t) => /^Approve$|^批准$/.test(t)) &&
      codexOptions.some((t) => /Approve for session|本次会话批准/.test(t)) &&
      codexOptions.some((t) => /Decline|拒绝/.test(t)) &&
      codexOptions.some((t) => /Stop turn|停止本轮/.test(t)),
    codexOptions.join(","),
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s7thread)?.turn;
    return t?.status === "done";
  });
  const doneMsg = (await snap(page))
    .threads.find((x) => x.id === s7thread)
    ?.messages.find((m) => m.role === "assistant" && m.status === "done");
  check(
    "codex fixture turn completed through the JSON-RPC child",
    Boolean(doneMsg && doneMsg.content.length > 0),
    (doneMsg?.content ?? "").slice(0, 80),
  );
  await page.screenshot({ path: join(outDir, "19-codex-turn-done.png") });

  // The provider-thread binding must be durable on disk BEFORE any resume —
  // poll the real store file, not a fixed sleep.
  let boundRow = null;
  for (let i = 0; i < 50 && !boundRow; i++) {
    try {
      const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
      boundRow = doc.threads.find((t) => t.id === s7thread)?.providerThread ?? null;
    } catch {
      /* mid-write */
    }
    if (!boundRow) await new Promise((r) => setTimeout(r, 100));
  }
  check(
    "codex thread binding persisted to the store (resume seam)",
    Boolean(
      boundRow &&
        boundRow.providerId === "codex" &&
        /^thread-\d+-[0-9a-f]+-\d+$/.test(boundRow.codexThreadId) &&
        boundRow.schemaPin === "0.164.0+6aaac694" &&
        boundRow.codexHomeId.includes("codex-home"),
    ),
    boundRow ? `${boundRow.codexThreadId}@${boundRow.codexHomeId}` : "missing",
  );

  // zh-Hans codex state
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".chat-head .badge.mock", { timeout: 5000 });
  const zhCodexBadge = await page.locator(".chat-head .badge.mock").innerText();
  check("zh-Hans codex badge is rendered", /Codex/.test(zhCodexBadge), zhCodexBadge);
  await page.screenshot({ path: join(outDir, "20-codex-zh-hans.png") });

  // zh-Hans permission card: the frozen turn-scoped option "Allow once"
  // must be localized ("允许一次") and the card must carry the provider's
  // visible text.
  await page.locator(".composer textarea").fill("perm please");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".approval .actions", { timeout: 10000 });
  const zhPermText = await page.locator(".approval").last().innerText();
  check(
    "zh-Hans permission card localizes the turn-scoped option",
    zhPermText.includes("允许一次") && zhPermText.includes("fixture"),
    zhPermText.slice(0, 160).replace(/\n/g, " | "),
  );
  await page.screenshot({ path: join(outDir, "20b-codex-zh-perm-card.png") });
  await page.getByRole("button", { name: "允许一次" }).click();
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s7thread)?.turn;
    return t?.status === "done";
  });
  check("zh permission answer writes through and completes the turn", true);
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // Dead session → next turn respawns and runs thread/resume on the wire.
  // The fixture persists its synthetic thread table inside CODEX_HOME
  // (same data root), so a NEW fixture process knows the old thread —
  // resume succeeds and the turn completes on the SAME codex thread.
  // (The server-refusal path is covered by scripted -32000 unit tests.)
  await page.locator(".composer textarea").fill("die");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s7thread)?.turn;
    return t?.status === "error" && /CODEX_CONNECTION_CLOSED/.test(t.error ?? "");
  });
  check("mid-turn fixture death surfaces CODEX_CONNECTION_CLOSED", true);
  await page.locator(".composer textarea").fill("resume attempt");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s7thread)?.turn;
    return t?.status === "done";
  });
  check(
    "dead session → respawn + thread/resume → turn completes on same thread",
    true,
  );
  await page.screenshot({ path: join(outDir, "21-codex-resume-refused.png") });

  const s7close = await boundedClose(app, proc);
  ledger.exited = s7close.exited;
  ledger.outcome = s7close.outcome;
  check(
    "codex fixture instance closed with child confirmed",
    s7close.outcome === "resolved" && s7close.exited && s7close.exitCode === 0,
    `outcome=${s7close.outcome} exitCode=${s7close.exitCode}`,
  );

  // ---- session 8: codex restart → binding survives; workspace gate honest ----
  const s8 = await launch(
    {
      TIVANO_PROVIDER: "codex",
      TIVANO_CODEX_FIXTURE: codexFixture,
      TIVANO_CODEX_NODE: process.execPath,
      TIVANO_WORKSPACE_ROOT: workspaceRoot,
    },
    "s8-codex-restart",
  );
  instances.push(s8);
  ({ app, proc, ledger } = s8);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s8snap = await snap(page);
  const s8bound = s8snap.threads.find((t) => t.id === s7thread)?.providerThread;
  check(
    "binding survives the app restart (same data root)",
    boundRow && s8bound && s8bound.codexThreadId === boundRow.codexThreadId,
    s8bound?.codexThreadId ?? "missing",
  );
  // THE recovery proof: workspace grants persisted by main are revalidated
  // at bootstrap, the stored binding drives thread/resume against the same
  // fixture state in CODEX_HOME, and the turn completes on the SAME codex
  // thread — the same providerThread id, never a substituted new one.
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), s7thread);
  await page.waitForSelector(".composer textarea", { timeout: 10000 });
  await page.locator(".composer textarea").fill("resume me after restart");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s7thread)?.turn;
    return t?.status === "done";
  });
  check("post-restart turn completed via thread/resume (full recovery)", true);
  const s8snap2 = await snap(page);
  const s8msgs = s8snap2.threads.find((x) => x.id === s7thread)?.messages ?? [];
  const lastAssistant = [...s8msgs].reverse().find((m) => m.role === "assistant");
  check(
    "resumed turn produced assistant output on the same thread",
    /fixture response/.test(lastAssistant?.content ?? ""),
    (lastAssistant?.content ?? "").slice(0, 80),
  );
  const s8bound2 = s8snap2.threads.find((t) => t.id === s7thread)?.providerThread;
  check(
    "binding still points at the SAME codex thread (no substitution)",
    boundRow && s8bound2?.codexThreadId === boundRow.codexThreadId,
    s8bound2?.codexThreadId ?? "missing",
  );
  await page.screenshot({ path: join(outDir, "22-codex-resume-after-restart.png") });
  const s8close = await boundedClose(app, proc);
  ledger.exited = s8close.exited;
  ledger.outcome = s8close.outcome;
  check(
    "codex restart instance exited cleanly",
    s8close.outcome === "resolved" && s8close.exited && s8close.exitCode === 0,
    `outcome=${s8close.outcome} exitCode=${s8close.exitCode}`,
  );

  // ---- session 9: codex unconfigured → honest not-configured error ----
  // Needs a workspace-bound project thread so the send reaches provider.start
  // — the workspace gate correctly intercepts projectless threads first.
  const s9 = await launch(
    { TIVANO_PROVIDER: "codex", TIVANO_WORKSPACE_ROOT: workspaceRoot },
    "s9-codex-unconfigured",
  );
  instances.push(s9);
  ({ app, proc, ledger } = s9);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s9state = await snap(page);
  check(
    "codex unconfigured state is reported",
    s9state.info.mode === "codex" && s9state.info.codex?.state === "unconfigured",
    `state=${s9state.info.codex?.state}`,
  );
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill("Codex Empty");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".group-name");
  await page.locator('button[title="New thread in Codex Empty"]').click();
  await page.waitForSelector(".composer textarea", { timeout: 10000 });
  const s9thread = (await snap(page)).selectedThreadId;
  await page.locator(".composer textarea").fill("nothing is configured");
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => {
    const t = s.threads.find((x) => x.id === s9thread)?.turn;
    return t?.status === "error" && /CODEX_NOT_CONFIGURED/.test(t.error ?? "");
  });
  check("unconfigured codex surfaces CODEX_NOT_CONFIGURED", true);
  await page.screenshot({ path: join(outDir, "22-codex-unconfigured.png") });
  const s9close = await boundedClose(app, proc);
  ledger.exited = s9close.exited;
  ledger.outcome = s9close.outcome;
  check(
    "codex unconfigured instance exited cleanly",
    s9close.outcome === "resolved" && s9close.exited && s9close.exitCode === 0,
    `outcome=${s9close.outcome} exitCode=${s9close.exitCode}`,
  );

  // ---- session 10: user-selected directory bindings (phase-2d) --------
  // The native chooser cannot be driven headlessly, so this exercises the
  // REAL restore path: project records + workspace-grants.json written
  // exactly as a previous session's chooser would have persisted them.
  // One binding is live (fixture dir + sentinel file), one is missing.
  const userDir = mkdtempSync(join(tmpdir(), "tivano-e2e-userdir-"));
  writeFileSync(join(userDir, "sentinel.txt"), "user content — never touched");
  const goneDir = join(tmpdir(), `tivano-e2e-gone-${runId}`); // never created
  const pidOpened = randomUUID();
  const pidMissing = randomUUID();
  const doc10 = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc10.projects.push(
    {
      id: pidOpened,
      name: basename(realpathSync(userDir)),
      createdAt: Date.now(),
      expanded: true,
      directory: realpathSync(userDir),
    },
    {
      id: pidMissing,
      name: "gone-folder",
      createdAt: Date.now(),
      expanded: true,
      directory: goneDir,
    },
  );
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc10));
  writeFileSync(
    join(dataRoot, "workspace-grants.json"),
    JSON.stringify({
      version: 1,
      grants: {},
      userGrants: {
        [pidOpened]: realpathSync(userDir),
        [pidMissing]: goneDir,
      },
    }),
  );

  const s10 = await launch({}, "s10-open-directory");
  instances.push(s10);
  ({ app, proc, ledger } = s10);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s10snap = await snap(page);
  const pOpened = s10snap.projects.find((p) => p.id === pidOpened);
  const pMissing = s10snap.projects.find((p) => p.id === pidMissing);
  check(
    "user-selected directory binding restored (project + grant)",
    pOpened?.directory === realpathSync(userDir) &&
      pOpened.directoryStatus === "available",
    `directoryStatus=${pOpened?.directoryStatus}`,
  );
  check(
    "missing folder binding preserved and reported unavailable",
    pMissing?.directory === goneDir && pMissing.directoryStatus === "unavailable",
    `directoryStatus=${pMissing?.directoryStatus}`,
  );
  // The unavailable grant must be PRESERVED in the file, not dropped.
  const grantsDoc = JSON.parse(readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"));
  check(
    "unavailable grant entry preserved in workspace-grants.json",
    grantsDoc.userGrants?.[pidMissing] === goneDir,
  );
  // The chooser affordance exists (its native dialog is not driven here).
  check(
    "Open folder action is present and enabled",
    await page.locator('button[title="Open folder"]').isEnabled(),
  );
  await page.screenshot({ path: join(outDir, "23-opendir-available-unavailable.png") });

  // Deleting the bound project revokes the grant but keeps user files.
  const deleteProject = page.getByRole("button", { name: `Delete project: ${pOpened.name}`, exact: true });
  await deleteProject.click();
  check("project delete requires confirmation", (await snap(page)).projects.some((p) => p.id === pidOpened));
  await deleteProject.click();
  await waitSnapshot(page, (s) => !s.projects.some((p) => p.id === pidOpened));
  check(
    "delete revokes grant but preserves the user directory",
    readFileSync(join(userDir, "sentinel.txt"), "utf8") === "user content — never touched",
  );
  const grantsAfterDelete = JSON.parse(
    readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
  );
  check(
    "deleted project's user grant is revoked",
    grantsAfterDelete.userGrants?.[pidOpened] === undefined &&
      grantsAfterDelete.userGrants?.[pidMissing] === goneDir,
  );

  // zh-Hans evidence: localized unavailable badge.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".dir-badge").filter({ hasText: "文件夹不可用" }).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(outDir, "24-opendir-zh-hans.png") });
  check("zh-Hans unavailable badge renders", (await page.locator(".dir-badge").allTextContents()).includes("文件夹不可用"));
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const s10close = await boundedClose(app, proc);
  ledger.exited = s10close.exited;
  ledger.outcome = s10close.outcome;
  check(
    "open-directory instance exited cleanly",
    s10close.outcome === "resolved" && s10close.exited && s10close.exitCode === 0,
    `outcome=${s10close.outcome} exitCode=${s10close.exitCode}`,
  );
  rmSync(userDir, { recursive: true, force: true });

  // ---- session 11: embedded terminal — REAL PTY (phase-2e) ----------
  // Everything below goes through the real bridge into the real Electron
  // utility-process PTY host: spawn in the authorized directory, keyboard
  // input, Unicode/ANSI output, resize, Ctrl-C under flood output, two
  // independent terminals, thread-switch screen preservation, close,
  // restart, an unavailable-state surface, and the quit-time background
  // child cleanup proof.
  const termDir = mkdtempSync(join(tmpdir(), "tivano-e2e-termws-"));
  const termProj = randomUUID();
  const doc11 = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc11.projects.push({
    id: termProj,
    name: "term-proj",
    createdAt: Date.now(),
    expanded: true,
    directory: realpathSync(termDir),
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc11));
  const gdoc11 = JSON.parse(readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"));
  gdoc11.userGrants[termProj] = realpathSync(termDir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(gdoc11));

  const s11 = await launch({}, "s11-terminal");
  instances.push(s11);
  ({ app, proc, ledger } = s11);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const thread11 = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    termProj,
  );
  const tid11 = thread11.id;
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid11);

  const tList = () =>
    page.evaluate((t) => window.tivano.invoke("terminals:list", { threadId: t }), tid11);
  const tAttach = (id) =>
    page.evaluate((i) => window.tivano.invoke("terminals:select", { terminalId: i }), id);
  const waitTermState = async (id, want, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const t = (await tList()).find((x) => x.id === id);
      if (t?.state === want) return t;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error(`terminal ${id} never reached ${want}`);
  };
  const waitTail = async (id, needle, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const a = await tAttach(id);
      if (a.tail.includes(needle)) return a;
      await new Promise((r) => setTimeout(r, 80));
    }
    const diagnostics = {
      terminalId: id,
      needle,
      terminals: await tList().catch((error) => ({ error: String(error) })),
      attachment: await tAttach(id).catch((error) => ({ error: String(error) })),
      rendererFocus: await page.evaluate(() => ({
        documentFocused: document.hasFocus(), visibility: document.visibilityState,
        activeClass: document.activeElement?.className,
      })).catch((error) => ({ error: String(error) })),
      nativeFocusedWindow: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)
        .catch((error) => ({ error: String(error) })),
    };
    writeFileSync(join(outDir, "terminal-tail-timeout.json"), JSON.stringify(diagnostics, null, 2));
    await page.screenshot({ path: join(outDir, "terminal-tail-timeout.png") }).catch(() => {});
    console.error("terminal wait diagnostics", JSON.stringify(diagnostics));
    throw new Error(`terminal tail never contained ${needle}`);
  };
  const tInput = (id, inc, data) =>
    page.evaluate(
      ([i, n, d]) => window.tivano.invoke("terminals:input", { terminalId: i, incarnation: n, data: d }),
      [id, inc, data],
    );

  // Create is explicit — no shell exists until this call.
  check("no terminal exists before the explicit create", (await tList()).length === 0);
  const tmk1 = await page.evaluate(
    (t) => window.tivano.invoke("terminals:create", { threadId: t, cols: 90, rows: 28 }),
    tid11,
  );
  check("terminal create accepted", Boolean(tmk1.terminal), JSON.stringify(tmk1));
  const term1 = tmk1.terminal.id;
  const t1info = await waitTermState(term1, "running");
  check(
    "shell spawned inside the authorized directory",
    t1info.cwd === realpathSync(termDir),
    `cwd=${t1info.cwd}`,
  );

  // Open the panel — the real xterm mounts.
  await page.click(".term-toggle");
  await page.waitForSelector(".term-panel .xterm", { timeout: 10000 });
  check("xterm instance mounted in the panel", true);
  const terminalStyle = await page.evaluate(() => {
    const rows = document.querySelector(".term-slot .xterm-rows");
    const fg = getComputedStyle(rows).color;
    let el = rows, bg = "rgba(0, 0, 0, 0)";
    while (el && bg === "rgba(0, 0, 0, 0)") { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
    const luminance = c => c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
      v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(fg), b = luminance(bg);
    return { fg, bg, contrast: (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05), family: getComputedStyle(rows).fontFamily };
  });
  check("terminal generated styles yield readable monospace text", terminalStyle.contrast >= 4.5 && /Mono|monospace/i.test(terminalStyle.family), JSON.stringify(terminalStyle));
  const inlineScriptRan = await page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.__terminalInlineProbe = true";
    document.body.appendChild(script);
    await new Promise(resolve => setTimeout(resolve, 0));
    script.remove();
    return window.__terminalInlineProbe === true;
  });
  check("terminal style support does not permit inline scripts", !inlineScriptRan);

  check(
    "cwd hint shows the project directory",
    (await page.locator(".term-cwd").textContent()) === realpathSync(termDir),
  );

  // Keyboard input → real PTY → Unicode + ANSI back.
  await page.click(".term-slot");
  await page.keyboard.type("printf '\\033[36mMK-ANSI-\\342\\234\\223\\033[0m\\n'\n");
  await waitTail(term1, "MK-ANSI-✓");
  check("keyboard input + unicode/ANSI output round-tripped through the real PTY", true);

  // Resize is accepted by the live session.
  await page.evaluate(
    (i) => window.tivano.invoke("terminals:resize", { terminalId: i, incarnation: 1, cols: 97, rows: 31 }),
    term1,
  );
  await tInput(term1, 1, "printf 'SIZE'; stty size\n");
  const resized = await waitTail(term1, "SIZE31 97");
  check("PTY actually resized to 31 rows and 97 columns", resized.tail.includes("SIZE31 97"));

  // Ctrl-C under output-heavy load, then a marker proves the prompt is back.
  await page.keyboard.type("seq 1 300000\n");
  await page.waitForTimeout(500);
  await tInput(term1, 1, "\x03");
  await page.waitForTimeout(300);
  await page.keyboard.type("printf 'AFTER-%s-MARK\\n' CC\n");
  await waitTail(term1, "AFTER-CC-MARK", 20000);
  check("Ctrl-C interrupted flooding output and the shell stayed alive", true);

  // Second independent terminal on the same thread.
  const tmk2 = await page.evaluate(
    (t) => window.tivano.invoke("terminals:create", { threadId: t, cols: 80, rows: 24 }),
    tid11,
  );
  const term2 = tmk2.terminal.id;
  await waitTermState(term2, "running");
  check(
    "second independent terminal on the same thread",
    (await page.locator(".term-tab").count()) === 2,
  );
  await page.screenshot({ path: join(outDir, "24-terminal-en-two-tabs.png") });

  // Select terminal 1 so its preserved screen is the visible one on return.
  // AFTER-CC-MARK is the latest output — earlier markers have legitimately
  // scrolled past both the 64KB tail and the xterm scrollback caps.
  await page.locator(".term-tab").first().click();
  await waitTail(term1, "AFTER-CC-MARK");

  // Thread switch preserves the hidden terminal's screen state.
  const thread12 = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    termProj,
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), thread12.id);
  await page.waitForSelector(".term-empty", { timeout: 10000 });
  check("switched-to thread shows its own empty terminal state", true);
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid11);
  await page.waitForSelector(".term-panel .xterm", { timeout: 10000 });
  const screenText = await page.locator(".term-slot .xterm-rows").innerText();
  check(
    "hidden terminal kept its screen across the thread switch",
    screenText.includes("AFTER-CC-MARK"),
    screenText.slice(-200),
  );

  // Close terminal 1 — terminal 2 is unaffected.
  await page.evaluate(
    (i) => window.tivano.invoke("terminals:close", { terminalId: i }),
    term1,
  );
  const deadline11 = Date.now() + 10000;
  while ((await tList()).some((t) => t.id === term1) && Date.now() < deadline11)
    await new Promise((r) => setTimeout(r, 60));
  check(
    "closing one terminal removes it without touching the other",
    !(await tList()).some((t) => t.id === term1) &&
      (await tList()).some((t) => t.id === term2),
  );

  // Restart terminal 2 → new incarnation, still running.
  await page.evaluate(
    (i) => window.tivano.invoke("terminals:restart", { terminalId: i }),
    term2,
  );
  const t2r = await waitTermState(term2, "running");
  check("restart produced a fresh running incarnation", t2r.incarnation === 2);

  // Ordinary background child → the quit cleanup must kill the session.
  // The marker is quote-split so the echoed command line cannot self-match.
  const t2inc = (await tList()).find((t) => t.id === term2).incarnation;
  await tInput(term2, t2inc, 'sleep 300 & echo "BG""KID"$!\n');
  let bgKid = NaN;
  {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const m = (await tAttach(term2)).tail.match(/BGKID(\d+)/);
      if (m) {
        bgKid = Number(m[1]);
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  check("background child pid captured from real PTY output", bgKid > 100, `pid=${bgKid}`);
  let bgAliveBefore = false;
  try {
    process.kill(bgKid, 0);
    bgAliveBefore = true;
  } catch {}
  check("background child confirmed alive before quit", bgAliveBefore);

  // zh-Hans chrome + EN/UNAVAILABLE evidence before quitting.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".term-toggle").filter({ hasText: "终端" }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(outDir, "25-terminal-zh.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // Unavailable state — an unbound thread can never spawn a shell.
  const looseThread = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), looseThread.id);
  const unav = await page.evaluate(
    (t) => window.tivano.invoke("terminals:create", { threadId: t, cols: 80, rows: 24 }),
    looseThread.id,
  );
  check("unbound thread create returns an honest unavailable", unav.unavailable === "unbound");
  // Same state through the real UI button → localized notice.
  await page.locator(".term-btn").filter({ hasText: "New terminal" }).first().click();
  await page.locator(".term-panel .banner").waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(outDir, "26-terminal-unavailable.png") });
  check("unavailable notice rendered in the panel", (await page.locator(".term-panel .banner").innerText()).includes("isn\'t bound to a project"));

  const s11close = await boundedClose(app, proc);
  ledger.exited = s11close.exited;
  ledger.outcome = s11close.outcome;
  check(
    "terminal instance exited cleanly",
    s11close.outcome === "resolved" && s11close.exited && s11close.exitCode === 0,
    `outcome=${s11close.outcome} exitCode=${s11close.exitCode}`,
  );
  // The background child belonged to the terminal's own session — after a
  // clean close it must be gone (ESRCH), never orphaned to launchd.
  let bgAliveAfter = true;
  try {
    process.kill(bgKid, 0);
  } catch {
    bgAliveAfter = false;
  }
  check("quit-time cleanup killed the terminal's background child", !bgAliveAfter, `pid=${bgKid}`);
  rmSync(termDir, { recursive: true, force: true });

  // ---- session 12: read-only Git panel — REAL git fixture (phase-2f) ----
  // A real on-disk repository exercises the whole path: controlled-view
  // status, branch badge, staged/worktree diffs, binary + filtered +
  // untracked states, the not-repository state, and proof on the host that
  // a configured helper never ran and the original index never changed.
  const git = (cwd, args) =>
    execFileSync("/usr/bin/git", args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
    });
  const gitDir = mkdtempSync(join(tmpdir(), "tivano-e2e-git-"));
  git(gitDir, ["init", "-b", "main"]);
  git(gitDir, ["config", "user.email", "e2e@example.com"]);
  git(gitDir, ["config", "user.name", "e2e"]);
  writeFileSync(join(gitDir, "a.txt"), "one\n");
  writeFileSync(join(gitDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 4]));
  writeFileSync(join(gitDir, "f.log"), "l0\n");
  writeFileSync(join(gitDir, ".gitattributes"), "*.log filter=e2e\n");
  git(gitDir, ["add", "-A"]);
  git(gitDir, ["commit", "-m", "base"]);
  // Staged + unstaged on one file, an untracked file, a binary change, and
  // a filtered worktree change.
  writeFileSync(join(gitDir, "a.txt"), "one\ntwo\n");
  git(gitDir, ["add", "a.txt"]);
  writeFileSync(join(gitDir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(gitDir, "untracked.txt"), "u\n");
  writeFileSync(join(gitDir, "bin.dat"), Buffer.from([0, 9, 2, 3, 0, 4]));
  writeFileSync(join(gitDir, "f.log"), "l0\nl1\n");
  // A helper that MUST never run — its only side effect is a marker file.
  const helperMarker = join(gitDir, "HELPER-RAN");
  writeFileSync(join(gitDir, "helper.sh"), `#!/bin/sh\ntouch "${helperMarker}"\ncat\n`);
  execFileSync("/bin/chmod", ["+x", join(gitDir, "helper.sh")]);
  git(gitDir, ["config", "filter.e2e.clean", `sh "${join(gitDir, "helper.sh")}"`]);
  git(gitDir, ["config", "filter.e2e.required", "true"]);
  const indexHashBefore = createHash("sha256")
    .update(readFileSync(join(gitDir, ".git", "index")))
    .digest("hex");
  const headBefore = readFileSync(join(gitDir, ".git", "HEAD"), "utf8");

  const plainDir = mkdtempSync(join(tmpdir(), "tivano-e2e-plain-"));
  const gitProj = randomUUID();
  const plainProj = randomUUID();
  const doc12 = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc12.projects.push(
    {
      id: gitProj,
      name: "git-proj",
      createdAt: Date.now(),
      expanded: true,
      directory: realpathSync(gitDir),
    },
    {
      id: plainProj,
      name: "plain-proj",
      createdAt: Date.now(),
      expanded: true,
      directory: realpathSync(plainDir),
    },
  );
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc12));
  const gdoc12 = JSON.parse(readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"));
  gdoc12.userGrants[gitProj] = realpathSync(gitDir);
  gdoc12.userGrants[plainProj] = realpathSync(plainDir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(gdoc12));

  const s12 = await launch({}, "s12-git");
  instances.push(s12);
  ({ app, proc, ledger } = s12);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const gthread = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    gitProj,
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), gthread.id);

  // Open the shared dock on the Git side — no snapshot exists until the
  // explicit refresh.
  await page.locator(".term-toggle").filter({ hasText: "Git" }).click();
  await page.locator(".git-panel").waitFor({ timeout: 10000 });
  const ov0 = await page.evaluate(
    (pid) => window.tivano.invoke("git:overview", { projectId: pid }),
    gitProj,
  );
  check("git overview before refresh is an honest empty state", ov0.kind === "unavailable");
  await page.locator(".git-refresh").click();
  await page.locator(".git-row").first().waitFor({ timeout: 15000 });
  const snap12 = await page.evaluate(
    (pid) => window.tivano.invoke("git:overview", { projectId: pid }),
    gitProj,
  );
  check(
    "refresh produced a ready snapshot with branch and grouped entries",
    snap12.kind === "ready" &&
      snap12.branch?.name === "main" &&
      snap12.entries.length >= 4 &&
      snap12.limitations.includes("filters"),
    `kind=${snap12.kind} entries=${snap12.entries?.length}`,
  );
  check(
    "branch badge renders in the panel",
    (await page.locator(".git-branch").innerText()).includes("main"),
  );

  // The same file appears once per side — staged row → staged diff,
  // unstaged row → worktree diff.
  await page.locator('.git-row[title="a.txt"]').first().click();
  await page.locator(".git-patch").waitFor({ timeout: 10000 });
  const stagedText = await page.locator(".git-patch").innerText();
  check(
    "staged diff shows the staged hunk only",
    stagedText.includes("+two") && !stagedText.includes("+three"),
  );
  await page.locator('.git-row[title="a.txt"]').nth(1).click();
  await page.waitForFunction(
    () => document.querySelector(".git-patch")?.textContent?.includes("+three"),
    null,
     { timeout: 10000 },
  );
  check("worktree diff shows the unstaged hunk", true);
  // The side tabs inside the diff header switch views too.
  await page.locator('.git-sides button').filter({ hasText: "Staged" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".git-patch")?.textContent?.includes("+two") &&
      !document.querySelector(".git-patch")?.textContent?.includes("+three"),
    null,
     { timeout: 10000 },
  );
  check("diff side tabs switch staged/worktree views", true);
  await page.screenshot({ path: join(outDir, "30-git-diff-en.png") });

  // Binary, filtered and untracked states are honest — no bytes leaked.
  await page.locator('.git-row[title="bin.dat"]').click();
  await page.waitForFunction(
    () => document.querySelector(".git-diff")?.textContent?.includes("Binary file — no text diff"),
    null,
    { timeout: 10000 },
  );
  check("binary file state is explicit", true);
  await page.locator('.git-row[title="f.log"]').click();
  await page.waitForFunction(
    () => document.querySelector(".git-diff")?.textContent?.includes("Filtered file"),
    null,
     { timeout: 10000 },
  );
  check("filtered worktree diff is refused", true);
  await page.locator('.git-row[title="untracked.txt"]').click();
  await page.waitForFunction(
    () => document.querySelector(".git-diff")?.textContent?.includes("No diff for this entry"),
    null,
     { timeout: 10000 },
  );
  check("untracked entry has no diff", true);

  // Host-side proof: the configured helper never ran and the original
  // index/HEAD bytes are identical after two refreshes.
  const beforeSecondRefresh = await page.evaluate((pid) => window.tivano.invoke("git:overview", { projectId: pid }), gitProj);
  await page.locator(".git-refresh").click();
  {
    const deadline = Date.now() + 15000;
    let readyAgain = false;
    while (Date.now() < deadline) {
      const ov = await page.evaluate(
        (pid) => window.tivano.invoke("git:overview", { projectId: pid }),
        gitProj,
      );
      if (ov.kind === "ready" && ov.snapshotId !== beforeSecondRefresh.snapshotId) {
        readyAgain = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    check("second refresh also lands a ready snapshot", readyAgain);
  }
  check("configured filter helper never executed", !existsSync(helperMarker));
  check(
    "original index and HEAD are byte-identical after refreshes",
    createHash("sha256").update(readFileSync(join(gitDir, ".git", "index"))).digest("hex") ===
      indexHashBefore && readFileSync(join(gitDir, ".git", "HEAD"), "utf8") === headBefore,
  );
  await page.screenshot({ path: join(outDir, "27-git-panel-en.png") });

  // A second project bound to a plain directory → not-repository state.
  const pthread = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    plainProj,
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), pthread.id);
  await page.locator(".git-refresh").click();
  await page.waitForFunction(
    () => document.querySelector(".git-panel")?.textContent?.includes("Not a Git repository"),
    null,
     { timeout: 15000 },
  );
  check("non-repository directory reports its honest state", true);
  await page.screenshot({ path: join(outDir, "28-git-not-repo.png") });

  // zh-Hans chrome for the whole panel.
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), gthread.id);
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForFunction(
    () =>
      document.querySelector(".git-panel")?.textContent?.includes("已暂存") &&
      document.querySelector(".git-panel")?.textContent?.includes("刷新"),
    null,
     { timeout: 10000 },
  );
  await page.screenshot({ path: join(outDir, "29-git-panel-zh.png") });
  check("zh-Hans git panel renders localized groups", true);
  await page.locator('.git-row[title="a.txt"]').first().click();
  await page.waitForFunction(() => document.querySelector(".git-patch")?.textContent?.includes("+two"), null, { timeout: 10000 });
  await page.screenshot({ path: join(outDir, "31-git-diff-zh.png") });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  await runGitPanelChecks({ app, page, projectId: gitProj, outDir, check });

  const s12close = await boundedClose(app, proc);
  ledger.exited = s12close.exited;
  ledger.outcome = s12close.outcome;
  check(
    "git instance exited cleanly",
    s12close.outcome === "resolved" && s12close.exited && s12close.exitCode === 0,
    `outcome=${s12close.outcome} exitCode=${s12close.exitCode}`,
  );
  // Every ephemeral view must be gone once the service is disposed.
  const viewRoot12 = join(dataRoot, "git-views");
  check(
    "ephemeral git views removed on close",
    !existsSync(viewRoot12) || readdirSync(viewRoot12).length === 0,
  );
  rmSync(gitDir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });

  // ---- session 13+: checkpoint turn lifecycle — real repo, real writes ----
  await runCheckpointChecks({
    launch,
    instances,
    snap,
    dataRoot,
    workspaceRoot,
    codexFixture,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 14a: thread worktrees — real git worktree add/remove ------
  await runWorktreeChecks({
    launch,
    instances,
    snap,
    dataRoot,
    workspaceRoot,
    codexFixture,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 13d: F13 commit flow — commit + push via real git -------
  await runGitCommitChecks({
    launch,
    instances,
    dataRoot,
    workspaceRoot,
    codexFixture,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 13b: F12 project scripts — list/edit/run + worktree setup --
  await runScriptsChecks({
    launch,
    instances,
    snap,
    dataRoot,
    workspaceRoot,
    codexFixture,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 13c: F27 configurable shortcuts — record/dispatch/refuse ---
  await runShortcutChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 14+: Codex CLI setup — choose/save/clear + precedence ------
  await runCodexSetupChecks({
    launch,
    instances,
    snap,
    dataRoot,
    codexFixture,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 15+: F17 model/effort picker — catalog + wire params ------
  await runCodexModelChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19+: F06 runtime modes (codex fixture) -------------------
  await runRuntimeModeChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19b+: F06 build/plan interaction mode (Codex fixture) ---
  await runInteractionModeChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19c+: F09 continuation / forward-to-new-thread ----------
  await runForwardChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19d+: F03 reasoning blocks (Codex fixture) --------------
  await runReasoningChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19f+: F03 plan/todos/tool items (Codex fixture) ---------
  await runPlanToolChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19g+: F19 context usage (Codex fixture) ------------------
  await runUsageChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19h+: F04 markdown blocks (Codex fixture) ---------------
  await runMarkdownChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19i+: F28 completion notifications (stubbed API) --------
  await runNotifyChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 19j+: F20 usage-limit auto-continue (mock limit) --------
  await runLimitChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 20+: F15 folder actions (local, no provider) ------------
  await runFolderChecks({
    launch,
    instances,
    snap,
    outDir,
    dataRoot,
    check,
    boundedClose,
  });

  // ---- session 21+: F28 unread marks (local, no provider) --------------
  await runUnreadChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 24+: F03 turn-group fold (codex fixture) ----------------
  await runTurnGroupChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 23+: F29 task sleep prevention (real OS blocker) --------
  await runSleepChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 24+: F31 anti-slop guidance (frozen AntiSlopPolicy) ----
  await runAntiSlopChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- session 25+: F26 font-size stepping (frozen TypeScale) ---------
  await runFontSizeChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- session 21b: F33 local control (real Unix socket + ticket ledger)
  await runLocalControlChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- session 21b: F21 Hydra configuration (local state, honest catalog)
  await runHydraChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
    dataRoot,
    outDir,
  });

  // ---- A44: F03 conversation-outline minimap (local state) --------------
  await runMinimapChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
    dataRoot,
  });

  // ---- A45: F26 full frozen theme catalog (local state) -----------------
  await runThemeChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- A46: F19 token activity ledger + heatmap (local state) ------
  await runTokenChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- session 22+: F27 command palette (local state, no provider) ------
  await runPaletteChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 18+: F02 archive (local state, no provider) -------------
  await runArchiveChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
    dataRoot,
  });

  // ---- session 17+: F08 follow-up queue (mock provider) -----------------
  await runFollowUpChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 16+: Codex requestUserInput — question cards --------------
  await runCodexQuestionChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 24+: F07 Codex decision approvals (offline fixture) ----
  await runCodexApprovalChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 25b+: F18 — MCP registry → codex config.mcp_servers ---
  await runCodexMcpChecks({
    launch,
    instances,
    snap,
    dataRoot,
    codexFixture,
    workspaceRoot,
    check,
    boundedClose,
  });

  // ---- session 26+: F03 structured notices (mock provider) -------------
  await runNoticeChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 27+: F31 generated thread titles (mock provider) --------
  await runTitleChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 28+: F09 /compact + /plan local commands ----------------
  await runCompactChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 29+: F05 slash-command suggestions -----------------------
  await runSlashChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 30+: F05 draft attachments (mock path) -------------------
  await runAttachChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- A47: F05 @-mentions + downloads popover (local state) -------------
  await runFileMentionChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
    dataRoot,
  });

  // ---- A48: F04 link popover + F26 performanceMode (local state) --------
  await runAppearanceChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- A62: F25 helper chat — merge/PR link → panel helper -----------
  await runHelperChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- A63: F09 conversation rewind — Edit from here / Rewind ---------
  await runRevertChecks({
    launch,
    instances,
    snap,
    check,
    boundedClose,
  });

  // ---- A49: F28 finish chime + completion notification signal ---------
  await runFinishSignalChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- A50: F04 message popover + reply quotes (local state) ----------
  await runMessageMenuChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 50+: F01 project icon picker (local) --------------------
  await runProjectIconChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 51+: F11 branch menu (real git, synthetic repo) ---------
  await runBranchMenuChecks({
    launch,
    instances,
    snap,
    dataRoot,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 53: F17 model pins/sections (Codex fixture) -------------
  await runModelListChecks({
    launch,
    instances,
    snap,
    codexFixture,
    workspaceRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 26: F18 MCP stdio servers + real probe -----------------
  await runMcpChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 27: F26 wallpaper + transparency (opaque window) -------
  await runWallpaperChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 28: F13 detection slice — forge CLI presence probe ----
  await runForgeChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 25+: F01/F02 move & reorder (local state, no provider) ---
  await runMoveChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 26: frozen NewThreadPrompt — question + affiliation ----
  await runNewThreadPromptChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 27: frozen General settings — location/workspace/working -
  await runGeneralSettingsChecks({
    launch,
    instances,
    snap,
    dataRoot,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 28: working indicator / stream-mend / quiet watchdog ----
  await runWorkingIndicatorChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 29: frozen layout drags — sidebar edge + terminal top ---
  await runLayoutChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 30: v2.2.x shelved projects — row, popover, rename -----
  await runShelfChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });

  // ---- session 31: v2.2.34 quick chat — panel, send, expand, hide ----
  await runQuickChecks({
    launch,
    instances,
    snap,
    outDir,
    check,
    boundedClose,
  });
} catch (err) {
  runError = err;
  console.error("E2E failure:", err);
}

// Clean up only what this run started and only once it has truly exited;
// on failure or uncertainty the data root stays for post-mortem evidence.
let allExited = true;
for (const { app, proc, ledger } of instances) {
  if (!proc) {
    allExited = false; // lost handle: cannot prove exit — preserve evidence
    ledger.exited = false;
    ledger.outcome = "handle-lost";
    continue;
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    const r = await boundedClose(app, proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
    ledger.exited = r.exited;
    ledger.outcome = `cleanup:${r.outcome}${r.killed ? "+killed" : ""}`;
    if (!r.exited) allExited = false;
  }
}

const failed = results.filter((r) => !r.ok);
const success = failed.length === 0 && !runError && allExited;

writeFileSync(
  join(outDir, "e2e-results.json"),
  JSON.stringify(
    {
      runId,
      dataRoot,
      results,
      allExited,
      instances: instanceLedger,
      error: runError ? String(runError) : null,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);

if (success) {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
} else {
  console.log(`failure evidence kept: data root ${dataRoot}, workspace root ${workspaceRoot}`);
}

console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
if (!success) process.exit(1);
