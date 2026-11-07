// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Thread-worktree e2e checks (F11 bounded): a REAL synthetic repo bound
// as a user grant → dialog creates an app-owned `git worktree add -b`
// → the thread runs its turn in the worktree (fixture writes into the
// worktree cwd, NOT the repo) → plain `git worktree remove` refuses on
// the now-dirty checkout → clean → removed and unbound.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

export async function runWorktreeChecks({
  launch,
  instances,
  snap,
  dataRoot,
  workspaceRoot,
  codexFixture,
  outDir,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  // --- fresh synthetic repo bound as a USER grant -------------------------
  const repoDir = mkdtempSync(join(tmpdir(), "tivano-e2e-wt-"));
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
    name: "wt-proj",
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

  const env = {
    TIVANO_PROVIDER: "codex",
    TIVANO_CODEX_FIXTURE: codexFixture,
    TIVANO_CODEX_NODE: process.execPath,
    TIVANO_WORKSPACE_ROOT: workspaceRoot,
  };

  const sA = await launch(env, "s-wt-a");
  instances.push(sA);
  const { app, proc, ledger } = sA;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const threadId = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    projId,
  );
  await page.evaluate(
    (tid) => window.tivano.invoke("threads:select", { id: tid }),
    threadId.id,
  );

  // --- UI: open the worktree dialog, create with a named branch -----------
  await page.locator("button.head-action", { hasText: "Worktree" }).click();
  await page.locator(".wt-dialog").waitFor({ timeout: 10000 });
  await page.locator(".wt-dialog .wt-input").fill("feat-e2e");
  await page.locator(".wt-dialog .primary").click();
  await page.waitForFunction(
    () => document.querySelector(".wt-dialog") === null,
    null,
    { timeout: 20000 },
  );
  const boundDir = await page.evaluate(
    (tid) =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.threads.find((t) => t.id === tid)?.worktreeDir),
    threadId.id,
  );
  verify(
    "worktree created and bound — app-owned dir",
    typeof boundDir === "string" && boundDir.includes("worktrees") && existsSync(boundDir),
    boundDir,
  );
  verify(
    "the worktree is a real checkout on the named branch",
    existsSync(join(boundDir, "base.txt")) &&
      git(repoDir, ["-C", boundDir, "rev-parse", "--abbrev-ref", "HEAD"]) === "feat-e2e\n",
    boundDir,
  );

  // --- a turn executes in the worktree cwd, not the repo ------------------
  // NOTE: this Playwright build treats a Promise predicate as truthy in
  // waitForFunction — poll the snapshot on the Node side instead.
  await page.evaluate(
    (tid) =>
      window.tivano.invoke("turns:send", { threadId: tid, text: "ckptfile please" }),
    threadId.id,
  );
  const deadline = Date.now() + 25000;
  let finalStatus;
  for (;;) {
    const st = await snap(page);
    finalStatus = st.threads.find((t) => t.id === threadId.id)?.turn?.status;
    if (finalStatus !== "running" && finalStatus !== "waiting-approval") break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  verify(
    "worktree turn reached a terminal state honestly",
    finalStatus === "done",
    finalStatus,
  );
  verify(
    "fixture wrote inside the WORKTREE checkout, not the bound repo",
    existsSync(join(boundDir, "fixture-checkpoint.txt")) &&
      !existsSync(join(repoDir, "fixture-checkpoint.txt")),
    boundDir,
  );

  // --- dirty worktree refuses removal; clean removes + unbinds ------------
  await page.locator("button.head-action", { hasText: "Worktree" }).click();
  await page.locator(".wt-dialog").waitFor({ timeout: 10000 });
  await page.locator(".wt-dialog button.danger").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".wt-dialog .ckpt-note.error") !== null ||
      document.querySelector(".wt-dialog") === null,
    null,
    { timeout: 20000 },
  );
  const stillDialog = await page.locator(".wt-dialog .ckpt-note.error").count();
  verify(
    "dirty worktree refuses removal honestly",
    stillDialog > 0 && existsSync(boundDir),
    boundDir,
  );
  if (stillDialog > 0) await page.keyboard.press("Escape");
  // Clean the worktree state and remove again.
  git(boundDir, ["checkout", "--", "."]);
  rmSync(join(boundDir, "fixture-checkpoint.txt"), { force: true });
  const removed = await page.evaluate(
    (tid) => window.tivano.invoke("threads:remove-worktree", { threadId: tid }),
    threadId.id,
  );
  verify(
    "clean worktree removes and unbinds",
    removed.kind === "removed" && !existsSync(boundDir),
    removed,
  );
  const cleared = await page.evaluate(
    (tid) =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.threads.find((t) => t.id === tid)?.worktreeDir),
    threadId.id,
  );
  verify("binding cleared after removal", cleared === undefined, cleared);
  await page.screenshot({ path: join(outDir, "96-worktree-en.png") });

  const aClose = await boundedClose(app, proc);
  ledger.exited = aClose.exited;
  ledger.outcome = aClose.outcome;
  verify(
    "worktree instance closed cleanly",
    aClose.outcome === "resolved" && aClose.exited && aClose.exitCode === 0,
    aClose,
  );
}
