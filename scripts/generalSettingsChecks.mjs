// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01 frozen General settings e2e — the "New threads" + "Conversation"
// rows: Default location lands ordinary threads in the current project or
// Tasks; defaultWorkspaceMode=worktree binds a REAL worktree at create;
// showsWorkingCard picks the working indicator's card/line surface.
// defaultRuntimeMode's wire coverage lives in runtimeModeChecks;
// showReasoning's gate lives in reasoningChecks. Every setting touched
// here is restored — the run shares one data root.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = "/usr/bin/git";
function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  });
}

export async function runGeneralSettingsChecks({
  launch,
  instances,
  snap,
  dataRoot,
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

  // --- real synthetic repo bound as a USER grant (worktreeChecks seeding) --
  const repoDir = mkdtempSync(join(tmpdir(), "tivano-e2e-gen-"));
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "e2e@example.com"]);
  git(repoDir, ["config", "user.name", "e2e"]);
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "base"]);
  const projId = randomUUID();
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.projects.push({
    id: projId,
    name: "gen-proj",
    createdAt: Date.now(),
    expanded: true,
    directory: realpathSync(repoDir),
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
  const gdoc = JSON.parse(
    readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
  );
  gdoc.userGrants[projId] = realpathSync(repoDir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(gdoc));

  const s1 = await launch({}, "gen-a");
  instances.push(s1);
  const { app, proc, ledger } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  // The run shares one data root — pin the frozen default so the
  // assertions below are deterministic regardless of earlier checks.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { defaultRuntimeMode: "fullAccess" }),
  );

  const openSettings = async () => {
    if ((await page.locator(".modal").count()) === 0) {
      await page.locator(".sidebar-foot button.row").click();
      await page.waitForSelector(".modal", { timeout: 8000 });
    }
  };

  // ---- GEN-01: the two frozen sections render with their controls -------
  await openSettings();
  // .modal h3 is text-transform:uppercase — innerText reports the
  // transformed text; compare on the source casing via textContent.
  const h3s = await page.locator(".modal h3").allTextContents();
  verify(
    "GEN-01 New threads + Conversation sections render",
    h3s.includes("New threads") && h3s.includes("Conversation"),
    h3s.slice(0, 6),
  );
  verify(
    "GEN-01b location/permissions/workspace pickers present",
    (await page.locator('div[aria-label="Default location"]').count()) === 1 &&
      (await page.locator('div[aria-label="Permissions"]').count()) === 1 &&
      (await page.locator('div[aria-label="Workspace"]').count()) === 1 &&
      (await page.locator('div[aria-label="Working line"]').count()) === 1,
  );
  const permActive = await page
    .locator('div[aria-label="Permissions"] .choice.active')
    .innerText();
  verify(
    "GEN-01c Permissions defaults to Full access (frozen)",
    permActive.trim() === "Full access",
    permActive,
  );
  const wlActive = await page
    .locator('div[aria-label="Working line"] .choice.active')
    .innerText();
  verify("GEN-01d Working line defaults to Card", wlActive.trim() === "Card", wlActive);
  await page.keyboard.press("Escape");

  // ---- GEN-02: working indicator card/line while a turn runs ------------
  const th0 = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    projId,
  );
  await page.evaluate((tid) =>
    window.tivano.invoke("threads:select", { id: tid }), th0.id);
  // A held turn, not a slow one — the card/line assertions are
  // race-free only while the turn is guaranteed to still be running.
  await page.evaluate((tid) =>
    window.tivano.invoke("turns:send", { threadId: tid, text: "hold [mock:quiet]" }),
    th0.id,
  );
  const s2 = await waitSnap(
    page,
    (s) => s.threads.find((x) => x.id === th0.id)?.turn?.status === "running",
  );
  verify(
    "GEN-02 mock turn running",
    s2.threads.find((x) => x.id === th0.id)?.turn?.status === "running",
  );
  const cardCount = await page.locator(".work-card").count();
  verify("GEN-02b working card renders by default", cardCount === 1, cardCount);
  const cardHasBar =
    (await page.locator(".work-card .stave-bar").count()) === 1;
  verify("GEN-02c the card carries the progress bar", cardHasBar);
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { showsWorkingCard: false }),
  );
  const dl2 = Date.now() + 8000;
  while (Date.now() < dl2) {
    if ((await page.locator(".work-line").count()) === 1) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  const lineCount = await page.locator(".work-line").count();
  const cardGone = (await page.locator(".work-card").count()) === 0;
  verify(
    "GEN-02d Line shows the plain badge, no card",
    lineCount === 1 && cardGone,
    `${lineCount}/${cardGone}`,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { showsWorkingCard: true }),
  );
  await page.evaluate((tid) =>
    window.tivano.invoke("turns:cancel", { threadId: tid }),
    th0.id,
  );

  // ---- GEN-03: Default location — ordinary new thread lands in Tasks ----
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { newThreadLocation: "standalone" }),
  );
  // A project thread is selected; the ordinary shortcut still lands standalone.
  await page.keyboard.press("Meta+n");
  const s3 = await waitSnap(
    page,
    (s) =>
      s.selectedThreadId !== th0.id &&
      s.threads.some((x) => x.id === s.selectedThreadId),
  );
  const sel3 = s3.threads.find((x) => x.id === s3.selectedThreadId);
  verify(
    "GEN-03 standalone default lands the new thread in Tasks",
    sel3.projectId === null,
    sel3.projectId,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { newThreadLocation: "recent" }),
  );

  // ---- GEN-04: Workspace=New worktree binds a real worktree at create ---
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { defaultWorkspaceMode: "worktree" }),
  );
  const thWt = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    projId,
  );
  const s4 = await waitSnap(
    page,
    (s) => typeof s.threads.find((x) => x.id === thWt.id)?.worktreeDir === "string",
    20000,
  );
  const wtDir = s4.threads.find((x) => x.id === thWt.id)?.worktreeDir;
  verify(
    "GEN-04 default worktree bound at create — app-owned dir",
    typeof wtDir === "string" && wtDir.includes("worktrees"),
    wtDir,
  );

  // ---- GEN-05: a standalone thread stays local under the same default ---
  const thSa = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page.evaluate((tid) =>
    window.tivano.invoke("threads:select", { id: tid }), thSa.id);
  await new Promise((r) => setTimeout(r, 400));
  const s5 = await snap(page);
  verify(
    "GEN-05 standalone thread gets no worktree (frozen silent-local)",
    s5.threads.find((x) => x.id === thSa.id)?.worktreeDir === undefined,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { defaultWorkspaceMode: "local" }),
  );

  await page.screenshot({ path: `${outDir}/general-settings.png` });
  const r = await boundedClose(app, proc, {
    closeMs: 8000,
    exitMs: 5000,
    killWaitMs: 3000,
  });
  ledger.exited = r.exited;
  ledger.outcome = r.killed ? `${r.outcome}+killed` : r.outcome;
  verify("GEN-06 instance closed cleanly", r.exited, r.outcome);
}
