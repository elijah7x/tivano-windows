// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A52 e2e — F11 branch menu (frozen ChatView.BranchMenu): button wears
// the current branch, ≤25 switch rows with the current one checked,
// `git switch`, `git switch -c` with the frozen name checks, worktree-
// bound rename with the pushed-upstream confirm — all against a real
// synthetic repo bound as a user grant. Never faked.

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

export async function runBranchMenuChecks({
  launch,
  instances,
  snap,
  dataRoot,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  // --- real synthetic repo bound as a USER grant ---------------------------
  const repoDir = mkdtempSync(join(tmpdir(), "tivano-e2e-bm-"));
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "e2e@example.com"]);
  git(repoDir, ["config", "user.name", "e2e"]);
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "base"]);
  git(repoDir, ["branch", "dev"]);
  // A real upstream for the pushed-rename gate.
  const remoteDir = mkdtempSync(join(tmpdir(), "tivano-e2e-bm-remote-"));
  git(remoteDir, ["init", "--bare", "-b", "main"]);
  git(repoDir, ["remote", "add", "origin", remoteDir]);
  git(repoDir, ["push", "-u", "origin", "main"]);

  const projId = randomUUID();
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.projects.push({
    id: projId,
    name: "bm-proj",
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

  const s1 = await launch({}, "branchmenu-main");
  instances.push(s1);
  const page = await s1.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  const threadId = (
    await page.evaluate((pid) =>
      window.tivano.invoke("threads:create", { projectId: pid }), projId)
  ).id;
  await page.evaluate((tid) =>
    window.tivano.invoke("threads:select", { id: tid }), threadId);

  // BM-01: the button wears the current branch; the menu lists both
  // branches (current checked) + New branch… — no Rename without worktree.
  await page.waitForSelector(".branch-btn");
  // The label fills after the async branches fetch — wait for it.
  await page.waitForFunction(
    () => !document.querySelector(".branch-btn")?.textContent?.includes("…"),
    null,
    { timeout: 10000 },
  );
  const label1 = await page.textContent(".branch-btn");
  verify("BM-01 button wears current branch", label1.includes("main"), label1);
  await page.click(".branch-btn");
  await page.waitForSelector(".openin-menu .branch-row");
  const menu1 = await page.evaluate(() => ({
    section: document.querySelector(".openin-menu .openin-section")?.textContent,
    rows: [...document.querySelectorAll(".branch-row")].map((r) => r.textContent.trim()),
    disabled: [...document.querySelectorAll(".branch-row")].map((r) => r.disabled),
    items: [...document.querySelectorAll('.openin-menu [role="menuitem"]')].map((b) => b.textContent.trim()),
  }));
  verify("BM-01 menu shape", menu1.section === "Switch branch"
    && menu1.rows.some((r) => r.includes("main")) && menu1.rows.some((r) => r.includes("dev"))
    && menu1.items.includes("New branch…") && !menu1.items.includes("Rename branch…"), menu1);

  // BM-02: switching checks out the branch for real; button re-wears it.
  await page.click('.branch-row:has-text("dev")');
  await page.waitForFunction(
    () => !document.querySelector(".openin-menu"),
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => document.querySelector(".branch-btn")?.textContent?.includes("dev"),
    null,
    { timeout: 8000 },
  );
  const label2 = await page.textContent(".branch-btn");
  verify("BM-02 switch for real", label2.includes("dev")
    && git(repoDir, ["branch", "--show-current"]).trim() === "dev", { label2, git: git(repoDir, ["branch", "--show-current"]).trim() });

  // BM-03: New branch… normalizes spaces to dashes and switches (switch -c).
  await page.click(".branch-btn");
  await page.waitForSelector('.openin-menu [role="menuitem"]:has-text("New branch…")');
  await page.click('.openin-menu [role="menuitem"]:has-text("New branch…")');
  await page.fill(".branch-input", "my feature branch");
  await page.click('.branch-naming-actions [role="menuitem"].primary');
  await page.waitForFunction(
    () => !document.querySelector(".openin-menu"),
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => document.querySelector(".branch-btn")?.textContent?.includes("my-feature-branch"),
    null,
    { timeout: 8000 },
  );
  const label3 = await page.textContent(".branch-btn");
  verify("BM-03 create normalizes + switches", label3.includes("my-feature-branch")
    && git(repoDir, ["branch", "--show-current"]).trim() === "my-feature-branch", label3);

  // BM-04/BM-05: frozen rejections show the frozen strings in place.
  await page.click(".branch-btn");
  await page.click('.openin-menu [role="menuitem"]:has-text("New branch…")');
  await page.fill(".branch-input", "has$money");
  await page.click('.branch-naming-actions [role="menuitem"].primary');
  await page.waitForSelector(".openin-note");
  const note4 = await page.textContent(".openin-note");
  verify("BM-04 charset rejection", note4.includes("letters, numbers"), note4);
  await page.fill(".branch-input", "main");
  await page.click('.branch-naming-actions [role="menuitem"].primary');
  await page.waitForFunction(
    (prev) => document.querySelector(".openin-note")?.textContent !== prev,
    note4,
    { timeout: 8000 },
  );
  const note5 = await page.textContent(".openin-note");
  verify("BM-05 exists rejection", note5.includes("already exists"), note5);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".openin-menu"), null, { timeout: 5000 });
  verify("BM-05b Escape closes", true);

  // BM-06: a worktree-bound thread gains the frozen Rename row; renaming
  // hits `git branch -m` in the worktree.
  const wtThread = (
    await page.evaluate((pid) =>
      window.tivano.invoke("threads:create", { projectId: pid }), projId)
  ).id;
  await page.evaluate((tid) =>
    window.tivano.invoke("threads:select", { id: tid }), wtThread);
  const wt = await page.evaluate((tid) =>
    window.tivano.invoke("threads:create-worktree", { threadId: tid, branch: "wt-base" }), wtThread);
  verify("BM-06a worktree created", wt.kind === "created", wt);
  const wtDir = wt.directory;
  await page.waitForSelector(".branch-btn");
  await page.click(".branch-btn");
  await page.waitForSelector(".openin-menu .branch-row");
  const hasRename = await page.evaluate(() =>
    [...document.querySelectorAll('.openin-menu [role="menuitem"]')].some((b) => b.textContent.trim() === "Rename branch…"));
  verify("BM-06b rename row on worktree", hasRename === true);
  await page.click('.openin-menu [role="menuitem"]:has-text("Rename branch…")');
  await page.fill(".branch-input", "wt-renamed");
  await page.click('.branch-naming-actions [role="menuitem"].primary');
  await page.waitForFunction(
    () => !document.querySelector(".openin-menu"),
    null,
    { timeout: 8000 },
  );
  verify("BM-06c renamed for real", git(wtDir, ["branch", "--show-current"]).trim() === "wt-renamed",
    git(wtDir, ["branch", "--show-current"]).trim());

  // BM-07: pushed branch → the frozen confirm row, then renames.
  git(wtDir, ["push", "-u", "origin", "wt-renamed"]);
  await page.click(".branch-btn");
  await page.click('.openin-menu [role="menuitem"]:has-text("Rename branch…")');
  await page.fill(".branch-input", "wt-final");
  await page.click('.branch-naming-actions [role="menuitem"].primary');
  await page.waitForSelector(".branch-pushed-detail");
  const pushed = await page.evaluate(() => ({
    title: document.querySelector(".branch-naming .openin-section")?.textContent,
    detail: document.querySelector(".branch-pushed-detail")?.textContent,
  }));
  verify("BM-07a pushed gate", pushed.title === "Rename a pushed branch?"
    && pushed.detail.includes("origin/wt-renamed"), pushed);
  await page.click('.branch-naming-actions [role="menuitem"].primary');
  await page.waitForFunction(
    () => !document.querySelector(".openin-menu"),
    null,
    { timeout: 8000 },
  );
  verify("BM-07b confirmed rename", git(wtDir, ["branch", "--show-current"]).trim() === "wt-final",
    git(wtDir, ["branch", "--show-current"]).trim());

  // BM-08: zh labels.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page.click(".branch-btn");
  await page.waitForSelector(".openin-menu .branch-row");
  const zh = await page.evaluate(() => ({
    section: document.querySelector(".openin-menu .openin-section")?.textContent,
    items: [...document.querySelectorAll('.openin-menu [role="menuitem"]')].map((b) => b.textContent.trim()),
  }));
  verify("BM-08 zh labels", zh.section === "切换分支"
    && zh.items.includes("新建分支…") && zh.items.includes("重命名分支…"), zh);
  await page.screenshot({ path: join(outDir, "branch-menu-zh.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // BM-09: mid-turn switch/create stay disabled (frozen !isRunning) —
  // the mock parks on an approval so the gate is observable.
  const t2 = (
    await page.evaluate((pid) =>
      window.tivano.invoke("threads:create", { projectId: pid }), projId)
  ).id;
  await page.evaluate((tid) =>
    window.tivano.invoke("threads:select", { id: tid }), t2);
  await page.evaluate((tid) =>
    window.tivano.invoke("turns:send", { threadId: tid, text: "[mock:approval] hold" }), t2);
  const deadline = Date.now() + 15000;
  for (;;) {
    const s = await snap(page);
    if (s.threads.find((x) => x.id === t2)?.turn?.status === "waiting-approval") break;
    if (Date.now() > deadline) throw new Error("BM-09 approval never parked");
    await new Promise((r) => setTimeout(r, 60));
  }
  await page.click(".branch-btn");
  await page.waitForSelector(".openin-menu .branch-row");
  const gates = await page.evaluate(() => ({
    rowsDisabled: [...document.querySelectorAll(".branch-row")].every((b) => b.disabled),
    createDisabled: [...document.querySelectorAll('.openin-menu [role="menuitem"]')]
      .find((b) => b.textContent.trim() === "New branch…")?.disabled,
  }));
  verify("BM-09 mid-turn gates", gates.rowsDisabled === true && gates.createDisabled === true, gates);
  await page.keyboard.press("Escape");
  const rc = await boundedClose(s1.app, s1.proc);
  verify("BM-10 clean close", rc.outcome === "resolved", rc);
}
