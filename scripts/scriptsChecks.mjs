// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Project-script e2e checks (F12 bounded): `projects:scripts:set` →
// durable project.scripts → the ScriptsDialog lists/edits them →
// `scripts:run` opens a REAL terminal session (title = script name) →
// `threads:create-worktree` runs runOnWorktreeCreate scripts inside the
// fresh worktree → scripts survive relaunch. A blank command refuses
// the whole save and an unknown script id reports unavailable honestly.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = "/usr/bin/git";
function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    encoding: "utf8",
  });
}

export async function runScriptsChecks({
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
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) return undefined;
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  // --- synthetic repo bound as a USER grant -------------------------------
  const repoDir = mkdtempSync(join(tmpdir(), "tivano-e2e-scr-"));
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
    name: "scr-proj",
    createdAt: Date.now(),
    expanded: true,
    directory: realpathSync(repoDir),
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
  const gdoc = JSON.parse(readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"));
  gdoc.userGrants[projId] = realpathSync(repoDir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(gdoc));

  const env = {
    TIVANO_PROVIDER: "codex",
    TIVANO_CODEX_FIXTURE: codexFixture,
    TIVANO_CODEX_NODE: process.execPath,
    TIVANO_WORKSPACE_ROOT: workspaceRoot,
  };

  const sA = await launch(env, "s-scr-a");
  instances.push(sA);
  const { app, proc, ledger } = sA;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const thread = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    projId,
  );
  const threadId = thread.id;
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), threadId);

  // --- set scripts over IPC; they land in the durable project record ------
  const setRes = await page.evaluate(
    (pid) =>
      window.tivano
        .invoke("projects:scripts:set", {
          projectId: pid,
          scripts: [
            { name: "Hello", command: "echo hello-script", icon: "play", runOnWorktreeCreate: false },
            { name: "Setup", command: "echo setup-script", icon: "wrench", runOnWorktreeCreate: true },
          ],
        })
        .then(
          () => ({ ok: true }),
          (e) => ({ ok: false, err: String(e) }),
        ),
    projId,
  );
  verify("SCR-01 projects:scripts:set accepted", setRes.ok === true, setRes);
  const scripts = await page.evaluate(
    (pid) =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.projects.find((p) => p.id === pid)?.scripts),
    projId,
  );
  verify(
    "SCR-02 scripts persisted with ids + normalized fields",
    Array.isArray(scripts) &&
      scripts.length === 2 &&
      scripts.every((s) => typeof s.id === "string" && s.id.length > 0) &&
      scripts[0].name === "Hello" &&
      scripts[1].runOnWorktreeCreate === true,
    scripts,
  );

  // --- blank command refuses the whole save --------------------------------
  const blank = await page.evaluate(
    (pid) =>
      window.tivano
        .invoke("projects:scripts:set", {
          projectId: pid,
          scripts: [
            { name: "Ok", command: "true" },
            { name: "Bad", command: "   " },
          ],
        })
        .then(
          () => ({ ok: true }),
          (e) => ({ ok: false, err: String(e) }),
        ),
    projId,
  );
  verify("SCR-03 a blank command refuses the whole save", blank.ok === false, blank);
  const afterBlank = await page.evaluate(
    (pid) =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.projects.find((p) => p.id === pid)?.scripts?.length),
    projId,
  );
  verify("SCR-03b refused save left the previous list intact", afterBlank === 2, afterBlank);

  // --- scripts:run opens a REAL terminal session ----------------------------
  const scriptId = scripts[0].id;
  const runRes = await page.evaluate(
    (args) => window.tivano.invoke("scripts:run", args),
    { threadId, scriptId },
  );
  verify("SCR-04 scripts:run returned a terminal", !!runRes.terminal, runRes);
  const running = await until(async () => {
    const list = await page.evaluate(
      (tid) => window.tivano.invoke("terminals:list", { threadId: tid }),
      threadId,
    );
    const t = list.find((x) => x.id === runRes.terminal.id);
    return t?.state === "running" ? t : undefined;
  }, 20000);
  verify(
    "SCR-05 script terminal is running with the script's title",
    running?.title === "Hello",
    running,
  );

  const unknown = await page.evaluate(
    (tid) =>
      window.tivano.invoke("scripts:run", { threadId: tid, scriptId: crypto.randomUUID() }),
    threadId,
  );
  verify("SCR-06 unknown script id reports unavailable", unknown.unavailable === "unknown-script", unknown);

  // --- dialog lists scripts and runs them -----------------------------------
  await page.locator("button.head-action", { hasText: "Scripts" }).click();
  await page.locator(".scripts-dialog").waitFor({ timeout: 10000 });
  const rows = await page.locator(".scripts-dialog .script-row").count();
  verify("SCR-07 dialog lists both scripts", rows === 2, rows);
  const badges = await page.locator(".scripts-dialog .script-badge").count();
  verify("SCR-08 runOnWorktreeCreate badge shown on Setup", badges === 1, badges);
  // Edit → rename the first script → save → state reflects.
  await page.locator(".scripts-dialog .primary", { hasText: "Edit scripts" }).click();
  await page.locator(".scripts-dialog .script-card .wt-input").first().fill("HelloRenamed");
  await page.locator(".scripts-dialog .primary", { hasText: "Save" }).click();
  const renamed = await until(async () => {
    const s = await page.evaluate(
      (pid) =>
        window.tivano
          .invoke("state:get", {})
          .then((st) => st.projects.find((p) => p.id === pid)?.scripts),
      projId,
    );
    return s?.[0]?.name === "HelloRenamed" ? s : undefined;
  });
  verify("SCR-09 edited script saved to the durable record", !!renamed, renamed);
  // Run a script straight from the dialog list.
  await page.locator(".scripts-dialog .script-run").first().click();
  const secondTerm = await until(async () => {
    const list = await page.evaluate(
      (tid) => window.tivano.invoke("terminals:list", { threadId: tid }),
      threadId,
    );
    return list.length >= 2 ? list : undefined;
  });
  verify("SCR-10 dialog Run opened a second terminal", !!secondTerm, secondTerm);
  await page.screenshot({ path: join(outDir, "97-scripts-en.png") });
  await page.keyboard.press("Escape");

  // --- worktree create runs the runOnWorktreeCreate script ------------------
  const wt = await page.evaluate(
    (tid) => window.tivano.invoke("threads:create-worktree", { threadId: tid, branch: "scr-wt" }),
    threadId,
  );
  verify(
    "SCR-11 worktree create ran the setup script once, skipping HelloRenamed",
    wt.kind === "created" && wt.setup?.ran === 1 && wt.setup?.failed?.length === 0,
    wt.setup,
  );
  const setupTerm = await until(async () => {
    const list = await page.evaluate(
      (tid) => window.tivano.invoke("terminals:list", { threadId: tid }),
      threadId,
    );
    const t = list.find((x) => x.title === "Setup" && x.state === "running");
    return t ?? undefined;
  }, 20000);
  verify("SCR-12 setup terminal running inside the worktree", !!setupTerm, setupTerm);
  verify(
    "SCR-13 setup terminal cwd is the worktree, not the repo",
    !!setupTerm && setupTerm.cwd === wt.directory,
    setupTerm?.cwd,
  );

  // --- scripts survive relaunch ----------------------------------------------
  const aClose = await boundedClose(app, proc);
  ledger.exited = aClose.exited;
  ledger.outcome = aClose.outcome;
  verify("SCR-14 instance closed cleanly", aClose.outcome === "resolved" && aClose.exited, aClose);

  const sB = await launch(env, "s-scr-b");
  instances.push(sB);
  const pageB = await sB.app.firstWindow();
  await pageB.waitForSelector(".sidebar-head", { timeout: 15000 });
  const persisted = await pageB.evaluate(
    (pid) =>
      window.tivano
        .invoke("state:get", {})
        .then((s) => s.projects.find((p) => p.id === pid)?.scripts),
    projId,
  );
  verify(
    "SCR-15 scripts survive relaunch with stable ids",
    Array.isArray(persisted) &&
      persisted.length === 2 &&
      persisted[0].name === "HelloRenamed" &&
      persisted[0].id === scriptId,
    persisted,
  );
  const bClose = await boundedClose(sB.app, sB.proc);
  sB.ledger.exited = bClose.exited;
  sB.ledger.outcome = bClose.outcome;
  verify("SCR-16 relaunch instance closed cleanly", bClose.outcome === "resolved" && bClose.exited, bClose);
}
