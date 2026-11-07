// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F13 commit-flow e2e (bounded): REAL synthetic repos bound as user
// grants → the Git panel's actions menu → CommitDialog → real
// `add -A`/`commit -F` → optional `push -u origin HEAD` against a LOCAL
// bare remote (no network, no credentials). Generation is proven through
// the mock adapter; the Codex fixture honestly reports no engine.
// Pull-request items stay disabled — forge integration is not this slice.

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

function mkRepo(tag, withRemote) {
  const dir = mkdtempSync(join(tmpdir(), `tivano-e2e-commit-${tag}-`));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  let remote = null;
  if (withRemote) {
    remote = mkdtempSync(join(tmpdir(), "tivano-e2e-remote-"));
    git(remote, ["init", "--bare", "-b", "main"]);
    git(dir, ["remote", "add", "origin", remote]);
  }
  return { dir, remote };
}

export async function runGitCommitChecks({
  launch,
  instances,
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

  const seedProject = (name, dir) => {
    const projId = randomUUID();
    const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
    doc.projects.push({
      id: projId,
      name,
      createdAt: Date.now(),
      expanded: true,
      directory: realpathSync(dir),
    });
    writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
    const gdoc = JSON.parse(
      readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
    );
    gdoc.userGrants[projId] = realpathSync(dir);
    writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(gdoc));
    return projId;
  };

  const openGitPanel = async (page, projId) => {
    const threadId = await page.evaluate(
      (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
      projId,
    );
    await page.evaluate(
      (tid) => window.tivano.invoke("threads:select", { id: tid }),
      threadId.id,
    );
    if ((await page.locator(".git-panel").count()) === 0)
      await page.locator(".term-toggle", { hasText: "Git" }).click();
    await page.locator(".git-panel").waitFor({ timeout: 10000 });
    await page.locator(".git-refresh").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".git-row").length > 0,
      null,
      { timeout: 15000 },
    );
    return threadId;
  };

  // ---------- sA: Codex fixture — manual message + push-after -------------
  const { dir: repoA, remote: remoteA } = mkRepo("a", true);
  writeFileSync(join(repoA, "a.txt"), "one\nchanged\n");
  writeFileSync(join(repoA, "new.txt"), "fresh\n");
  const projA = seedProject("commit-a", repoA);

  const sA = await launch(
    {
      TIVANO_PROVIDER: "codex",
      TIVANO_CODEX_FIXTURE: codexFixture,
      TIVANO_CODEX_NODE: process.execPath,
      TIVANO_WORKSPACE_ROOT: workspaceRoot,
    },
    "s-cm-a",
  );
  instances.push(sA);
  const { app, proc, ledger } = sA;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await openGitPanel(page, projA);

  // Menu items reflect live snapshot truth.
  await page.locator(".git-menu-btn").click();
  await page.locator(".git-menu").waitFor({ timeout: 5000 });
  const items = page.locator('.git-menu [role="menuitem"]');
  verify("git actions menu opens", (await items.count()) >= 3);
  verify(
    "Commit… enabled with changes present",
    await items.filter({ hasText: "Commit" }).first().isEnabled(),
  );
  verify(
    "Push enabled on a named branch",
    await items.filter({ hasText: "Push" }).first().isEnabled(),
  );
  verify(
    "Create pull request honestly disabled in this build",
    !(await items.filter({ hasText: "pull request" }).first().isEnabled()),
  );
  verify(
    "Open repository hidden for a non-URL (file-path) remote",
    (await items.filter({ hasText: "repository" }).count()) === 0,
  );

  // Commit… opens the sheet; Codex fixture has no text engine → the
  // generate control is disabled with the frozen hint, never faked.
  await items.filter({ hasText: "Commit" }).first().click();
  await page.locator(".commit-dialog").waitFor({ timeout: 10000 });
  await page.waitForFunction(
    () => (document.querySelector(".commit-summary")?.textContent ?? "").includes("a.txt"),
    null,
    { timeout: 15000 },
  );
  // The button is ALSO disabled while a generation request is in flight —
  // wait for the settled "no engine" state, told apart by its hint title.
  await page.waitForFunction(
    () =>
      document.querySelector(".commit-generate")?.disabled === true &&
      /text generation/i.test(
        document.querySelector(".commit-generate")?.getAttribute("title") ?? "",
      ),
    null,
    { timeout: 15000 },
  );
  verify(
    "generation unavailable under Codex fixture — disabled honestly",
    await page.locator(".commit-generate").isDisabled(),
  );
  const genTitle = await page.locator(".commit-generate").getAttribute("title");
  verify(
    "unavailable state points at the text-generation setting",
    typeof genTitle === "string" && /text generation/i.test(genTitle),
    genTitle,
  );

  // Empty message keeps Commit disabled (frozen rule).
  verify(
    "Commit disabled while the message is empty",
    await page.locator('.commit-dialog .primary').isDisabled(),
  );
  await page.locator(".commit-message").fill("e2e: first commit");
  verify(
    "Commit enabled once a message exists",
    await page.locator(".commit-dialog .primary").isEnabled(),
  );
  await page.locator(".commit-push input").check();
  await page.locator(".commit-dialog .primary").click();
  await page.waitForFunction(
    () => document.querySelector(".commit-dialog") === null,
    null,
    { timeout: 20000 },
  );

  const headA = git(repoA, ["rev-parse", "HEAD"]).trim();
  verify(
    "commit landed with the exact message",
    git(repoA, ["log", "-1", "--format=%s"]).trim() === "e2e: first commit",
  );
  verify(
    "push-after-committing reached the local bare remote",
    git(remoteA, ["rev-parse", "main"]).trim() === headA,
    headA,
  );
  verify(
    "working tree clean after add -A commit",
    git(repoA, ["status", "--short"]).trim() === "",
  );

  // Standalone Push — up-to-date push is still a real `push -u origin HEAD`.
  await page.locator(".git-menu-btn").click();
  await page.locator(".git-menu").waitFor({ timeout: 5000 });
  await page.locator('.git-menu [role="menuitem"]', { hasText: "Push" }).click();
  await page.waitForFunction(
    () => document.querySelector(".git-menu-note.ok") !== null,
    null,
    { timeout: 20000 },
  );
  verify("standalone push reports success honestly", true);

  // Now break the remote: an unreachable https URL makes Open repository
  // appear (real URL) and Push report its real stderr.
  git(repoA, ["remote", "set-url", "origin", "https://127.0.0.1:1/unreachable.git"]);
  await page.locator(".git-refresh").click();
  // Node-side snapshot poll for the refreshed remoteUrl (Promise-predicate
  // waitForFunction is unreliable on this build).
  {
    const deadline = Date.now() + 15000;
    let remoteUrl = null;
    while (Date.now() < deadline) {
      const s = await page.evaluate(
        (pid) => window.tivano.invoke("git:overview", { projectId: pid }),
        projA,
      );
      if (typeof s.remoteUrl === "string") {
        remoteUrl = s.remoteUrl;
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    verify(
      "snapshot carries the new remote URL after refresh",
      remoteUrl === "https://127.0.0.1:1/unreachable.git",
      remoteUrl,
    );
  }
  await page.locator(".git-menu-btn").click();
  await page.locator(".git-menu").waitFor({ timeout: 5000 });
  verify(
    "Open repository appears for an http(s) remote",
    (await page.locator('.git-menu [role="menuitem"]', { hasText: "repository" }).count()) === 1,
  );
  await page.locator('.git-menu [role="menuitem"]', { hasText: "Push" }).click();
  await page.waitForFunction(
    () => document.querySelector(".git-menu-note.err") !== null,
    null,
    { timeout: 30000 },
  );
  const pushErr = await page.locator(".git-menu-note.err").innerText();
  verify(
    "unreachable remote reports the push failure verbatim",
    /Push failed/.test(pushErr),
    pushErr,
  );
  await page.screenshot({ path: join(outDir, "97-commit-flow-en.png") });

  const aClose = await boundedClose(app, proc);
  ledger.exited = aClose.exited;
  ledger.outcome = aClose.outcome;
  verify(
    "commit instance A closed cleanly",
    aClose.outcome === "resolved" && aClose.exited && aClose.exitCode === 0,
    aClose,
  );

  // ---------- sB: mock provider — auto-drafted message --------------------
  const { dir: repoB } = mkRepo("b", false);
  writeFileSync(join(repoB, "a.txt"), "one\nchanged\n");
  const projB = seedProject("commit-b", repoB);
  const sB = await launch({ TIVANO_WORKSPACE_ROOT: workspaceRoot }, "s-cm-b");
  instances.push(sB);
  const pageB = await sB.app.firstWindow();
  await pageB.waitForSelector(".sidebar-head", { timeout: 15000 });
  await pageB.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await openGitPanel(pageB, projB);

  await pageB.locator(".git-menu-btn").click();
  await pageB.locator(".git-menu").waitFor({ timeout: 5000 });
  await pageB.locator('.git-menu [role="menuitem"]', { hasText: "Commit" }).click();
  await pageB.locator(".commit-dialog").waitFor({ timeout: 10000 });
  // Frozen .task auto-drafts when the box is empty — the mock adapter
  // produces its deterministic synthetic message.
  await pageB.waitForFunction(
    () => (document.querySelector(".commit-message")?.value ?? "").length > 0,
    null,
    { timeout: 15000 },
  );
  const drafted = await pageB.locator(".commit-message").inputValue();
  verify(
    "mock adapter drafted the deterministic synthetic message",
    drafted === "Update a.txt",
    drafted,
  );
  await pageB.locator(".commit-message").fill("");
  verify(
    "Commit disabled again once the draft is cleared",
    await pageB.locator(".commit-dialog .primary").isDisabled(),
  );
  await pageB.locator(".commit-message").fill("e2e: mock commit");
  await pageB.locator(".commit-dialog .primary").click();
  await pageB.waitForFunction(
    () => document.querySelector(".commit-dialog") === null,
    null,
    { timeout: 20000 },
  );
  verify(
    "mock-instance commit landed",
    git(repoB, ["log", "-1", "--format=%s"]).trim() === "e2e: mock commit",
  );

  const bClose = await boundedClose(sB.app, sB.proc);
  sB.ledger.exited = bClose.exited;
  sB.ledger.outcome = bClose.outcome;
  verify(
    "commit instance B closed cleanly",
    bClose.outcome === "resolved" && bClose.exited && bClose.exitCode === 0,
    bClose,
  );
}
