// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-53 E2E checks: floating tray sidebar geometry + collapse/reopen,
// lean top bar + overflow menu, changes popover anchored below top-bar
// +/− numbers via click / Ctrl+D / Command Palette "Toggle changes",
// 8 consolidated Settings pages (no search, keyboard nav, scroll reset,
// HydraMark -> Hydra page), 28px/24px button sizing, and zh-Hans copy.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

function resolveWinGit() {
  const isRealFile = (p) => {
    try {
      const st = lstatSync(p);
      return st.isFile() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const explicit = process.env.TIVANO_GIT_EXECUTABLE?.trim();
  if (explicit && isAbsolute(explicit) && isRealFile(explicit)) return realpathSync(explicit);
  for (const [k, suffix] of [
    ["ProgramFiles", "\\Git\\cmd\\git.exe"],
    ["ProgramFiles(x86)", "\\Git\\cmd\\git.exe"],
    ["ProgramW6432", "\\Git\\cmd\\git.exe"],
    ["LOCALAPPDATA", "\\Programs\\Git\\cmd\\git.exe"],
  ]) {
    const base = process.env[k];
    if (base) {
      const cand = `${base.replace(/[\\/]+$/, "")}${suffix}`;
      if (isRealFile(cand)) return realpathSync(cand);
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const cand = join(dir, "git.exe");
    if (isRealFile(cand)) return realpathSync(cand);
  }
  return "git.exe";
}

const GIT = process.platform === "win32" ? resolveWinGit() : "/usr/bin/git";

function runGit(cwd, args, globalCfg) {
  return execFileSync(GIT, args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalCfg,
    },
    encoding: "utf8",
  });
}

export async function runP253ChromeChecks({
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
  const waitSnapshot = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // --- Session 1: tray sidebar, lean top bar, empty-state popover, Settings ---
  const s1 = await launch({}, "p253-chrome");
  instances.push(s1);
  const page = await s1.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      sidebarWidth: 268,
      hasSeenHydraIntro: true,
      hydraEnabled: true,
      hydraPairs: [
        {
          id: "p253-pair",
          provider: "mock",
          headProfiles: [{ id: "p253-prof", name: "quick", provider: "mock" }],
        },
      ],
    }),
  );

  // Ensure sidebar is visible in its default 268px tray state.
  if ((await page.locator(".sidebar").count()) === 0) {
    await page.locator(".sidebar-reopen").click();
    await page.waitForSelector(".sidebar.sidebar-tray", { timeout: 8000 });
  }

  // P253-E2E-01: Floating tray sidebar geometry, edge offset, collapse & reopen.
  const trayGeom = await page.evaluate(() => {
    const nav = document.querySelector(".sidebar.sidebar-tray");
    const edge = document.querySelector('.sidebar-edge[data-open="true"]');
    if (!nav || !edge) return null;
    const cs = getComputedStyle(nav);
    return {
      marginTop: cs.marginTop,
      marginLeft: cs.marginLeft,
      marginBottom: cs.marginBottom,
      borderRadius: cs.borderRadius,
      borderTopWidth: cs.borderTopWidth,
      boxShadow: cs.boxShadow,
      edgeLeft: edge.getBoundingClientRect().left,
      sidebarWidth: nav.getBoundingClientRect().width,
    };
  });
  verify(
    "P253-E2E-01a sidebar tray has 8px inset, 16px radius, border, shadow, and +5px edge",
    Boolean(
      trayGeom &&
        trayGeom.marginTop === "8px" &&
        trayGeom.marginLeft === "8px" &&
        trayGeom.marginBottom === "8px" &&
        trayGeom.borderRadius === "16px" &&
        trayGeom.borderTopWidth === "1px" &&
        trayGeom.boxShadow !== "none" &&
        Math.abs(trayGeom.edgeLeft - (trayGeom.sidebarWidth + 5)) <= 2,
    ),
    trayGeom,
  );

  // Ensure a project-backed thread exists so Scripts appears in the overflow menu.
  const projName = "P253 Chrome Project";
  await page.locator('button[title="New project"]').click();
  await page.getByLabel("Project name").fill(projName);
  await page.keyboard.press("Enter");
  await waitSnapshot(page, (s) => s.projects.some((p) => p.name === projName));
  await page.locator(`button[title="New thread in ${projName}"]`).click();
  await page.waitForSelector(".chat-top-controls", { timeout: 10000 });

  await page.keyboard.press(`${mod}+b`);
  await page.waitForSelector(".sidebar", { state: "detached", timeout: 8000 });
  await page.waitForSelector(".sidebar-reopen", { timeout: 8000 });
  await page.locator(".sidebar-reopen").click();
  await page.waitForSelector(".sidebar.sidebar-tray", { timeout: 8000 });
  verify(
    "P253-E2E-01b sidebar collapses via shortcut and reopens via .sidebar-reopen",
    (await page.locator(".sidebar.sidebar-tray").count()) === 1 &&
      (await page.locator(".sidebar-reopen").count()) === 0,
  );

  // P253-E2E-02: Lean top bar & overflow menu (⋯).
  const topBarCounts = await page.evaluate(() => ({
    controls: document.querySelectorAll(".chat-top-controls").length,
    hydra: document.querySelectorAll(".chat-top-controls .hydra-mark").length,
    capsule: document.querySelectorAll(".chat-top-controls .chrome-capsule").length,
    capsuleBtns: document.querySelectorAll(".chat-top-controls .chrome-capsule .term-toggle").length,
    moreBtn: document.querySelectorAll(".chat-top-controls .more-controls-btn").length,
    composerAnchor: document.querySelectorAll(".composer-changes-anchor").length,
    standaloneForward: document.querySelectorAll('.chat-top-controls > button[title="Forward to new thread"]').length,
    standaloneOpenIn: document.querySelectorAll('.chat-top-controls > .openin:not(.more-controls)').length,
  }));
  verify(
    "P253-E2E-02a top bar keeps only daily controls and removes standalone secondary buttons",
    topBarCounts.controls === 1 &&
      topBarCounts.hydra === 1 &&
      topBarCounts.capsule === 1 &&
      topBarCounts.capsuleBtns === 2 &&
      topBarCounts.moreBtn === 1 &&
      topBarCounts.composerAnchor === 0 &&
      topBarCounts.standaloneForward === 0 &&
        topBarCounts.standaloneOpenIn === 0,
    topBarCounts,
  );

  await page.locator(".more-controls-btn").click();
  await page.waitForSelector(".more-controls-menu", { timeout: 5000 });
  const menuText = await page.locator(".more-controls-menu").innerText();
  const openInCount = await page.locator(".more-controls-menu [data-openin-item]").count();
  verify(
    "P253-E2E-02b overflow menu holds Forward, Thread worktree, Scripts, and Open in items",
    menuText.includes("Forward to new thread") &&
      menuText.includes("Thread worktree") &&
      menuText.includes("Scripts") &&
      openInCount >= 2,
    { menuText, openInCount },
  );
  // Exercise Scripts menu action and close the dialog cleanly.
  await page.locator('.more-controls-menu [role="menuitem"]', { hasText: "Scripts" }).click();
  await page.waitForSelector(".scripts-dialog", { timeout: 5000 });
  await page.locator('.scripts-dialog .modal-actions button', { hasText: "Close" }).click();
  await page.waitForSelector(".scripts-dialog", { state: "detached", timeout: 5000 });

  // P253-E2E-03 (empty state): Ctrl+D and Command Palette "Toggle changes".
  await page.keyboard.press(`${mod}+d`);
  await page.waitForSelector('.thread-changes-pop[data-anchor="topbar"]', { timeout: 5000 });
  const emptyTitle = await page.locator(".thread-changes-pop .tc-empty-title").innerText();
  const headBox1 = await page.locator(".chat-head").boundingBox();
  const popBox1 = await page.locator(".thread-changes-pop").boundingBox();
  const compBox1 = await page.locator(".composer").boundingBox();
  verify(
    "P253-E2E-03a Cmd/Ctrl+D opens topbar-anchored empty changes popover above the composer",
    emptyTitle.includes("No changes yet") &&
      Boolean(
        headBox1 &&
          popBox1 &&
          compBox1 &&
          popBox1.y >= headBox1.y &&
          popBox1.y <= headBox1.y + headBox1.height + 24 &&
          popBox1.y < compBox1.y - 40,
      ),
    { emptyTitle, headBox1, popBox1, compBox1 },
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".thread-changes-pop", { state: "detached", timeout: 5000 });

  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector(".palette-input input", { timeout: 5000 });
  await page.locator(".palette-input input").fill("Toggle changes");
  await page.locator(".palette-item", { hasText: "Toggle changes" }).first().click();
  await page.waitForSelector('.thread-changes-pop[data-anchor="topbar"]', { timeout: 5000 });
  verify(
    "P253-E2E-03b Command Palette Toggle changes opens topbar-anchored popover",
    (await page.locator('.thread-changes-pop[data-anchor="topbar"] .tc-empty-title').count()) === 1,
  );
  await page.locator(".tc-pop-close").click();
  await page.waitForSelector(".thread-changes-pop", { state: "detached", timeout: 5000 });

  // P253-E2E-04: Consolidated Settings (8 pages, no search, keyboard nav, scroll reset, HydraMark -> hydra).
  await page.evaluate(() => window.tivano.invoke("settings:set", { hasSeenHydraIntro: false }));
  await waitSnapshot(page, (s) => s.settings.hasSeenHydraIntro === false);
  await page.locator(".hydra-mark").click();
  await page.waitForSelector(".hydra-intro-pop", { timeout: 5000 });
  await page.locator(".hydra-intro-pop button", { hasText: "Set up in Settings" }).click();
  await page.waitForSelector('.settings-pane[data-page="hydra"]', { timeout: 5000 });
  verify(
    "P253-E2E-04a HydraMark Set up in Settings opens Settings directly on the Hydra page",
    (await page.locator('[data-settings-page="hydra"][aria-selected="true"]').count()) === 1,
  );

  const settingsInfo = await page.evaluate(() => ({
    pages: [...document.querySelectorAll("[data-settings-page]")].map((el) =>
      el.getAttribute("data-settings-page"),
    ),
    searchInputs: document.querySelectorAll('.settings-modal input[type="search"], .settings-modal .settings-search').length,
  }));
  verify(
    "P253-E2E-04b Settings has 8 pages in order and no search field",
    settingsInfo.pages.join(",") ===
      "appearance,conversation,models,hydra,connections,shortcuts,storage,about" &&
      settingsInfo.searchInputs === 0,
    settingsInfo,
  );

  // Scroll reset check on a scrollable Settings page (Conversation).
  await page.locator('[data-settings-page="appearance"]').focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector('.settings-pane[data-page="conversation"]', { timeout: 5000 });
  const scrolledBefore = await page.evaluate(() => {
    const pane = document.querySelector(".settings-pane");
    if (!pane) return null;
    if (pane.scrollHeight <= pane.clientHeight) {
      pane.style.maxHeight = "220px";
    }
    pane.scrollTop = 120;
    return {
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      scrollTop: pane.scrollTop,
    };
  });
  await page.locator('[data-settings-page="models"]').click();
  await page.waitForSelector('.settings-pane[data-page="models"]', { timeout: 5000 });
  const scrollAfter = await page.evaluate(() => {
    const pane = document.querySelector(".settings-pane");
    if (!pane) return null;
    pane.style.maxHeight = "";
    return pane.scrollTop;
  });
  verify(
    "P253-E2E-04c ArrowDown moves to Conversation and page switch resets scrollTop to 0",
    Boolean(scrolledBefore && scrolledBefore.scrollTop > 0 && scrollAfter === 0),
    { scrolledBefore, scrollAfter },
  );

  // P253-E2E-05: Button sizing (28px regular, 24px compact) + zh-Hans localization.
  const modelsBtnHeight = await page.evaluate(() => {
    const btn =
      document.querySelector(".settings-modal .ml-newgroup") ??
      document.querySelector(".settings-modal .choice");
    return btn ? getComputedStyle(btn).height : null;
  });
  await page.locator('[data-settings-page="appearance"]').click();
  await page.waitForSelector('.settings-pane[data-page="appearance"]', { timeout: 5000 });
  const regularHeights = await page.evaluate(() => {
    const closeBtn = document.querySelector(".settings-modal .modal-actions button");
    const choiceBtn = document.querySelector(".settings-modal .choice:not(.fs-step):not(.hydra-remove):not(.settings-btn-compact)");
    return {
      close: closeBtn ? getComputedStyle(closeBtn).height : null,
      choice: choiceBtn ? getComputedStyle(choiceBtn).height : null,
    };
  });
  await page.locator('[data-settings-page="hydra"]').click();
  await page.waitForSelector('.settings-pane[data-page="hydra"]', { timeout: 5000 });
  const hydraRemoveBox = await page.evaluate(() => {
    const btn = document.querySelector(".settings-modal .choice.hydra-remove");
    if (!btn) return null;
    const cs = getComputedStyle(btn);
    return { width: cs.width, height: cs.height, paddingLeft: cs.paddingLeft };
  });
  await page.locator('[data-settings-page="connections"]').click();
  await page.waitForSelector('.settings-pane[data-page="connections"]', { timeout: 5000 });
  const compactHeight = await page.evaluate(() => {
    const btn = document.querySelector(".settings-modal .settings-btn-compact");
    return btn ? getComputedStyle(btn).height : null;
  });
  verify(
    "P253-E2E-05a Settings buttons use 28px regular and 24px compact/hydra-remove sizing",
    regularHeights.close === "28px" &&
      regularHeights.choice === "28px" &&
      modelsBtnHeight === "28px" &&
      compactHeight === "24px" &&
      Boolean(
        hydraRemoveBox &&
          hydraRemoveBox.width === "24px" &&
          hydraRemoveBox.height === "24px" &&
          hydraRemoveBox.paddingLeft === "0px",
      ),
    { regularHeights, modelsBtnHeight, compactHeight, hydraRemoveBox },
  );

  // Verify zh-Hans translations in Settings and top-bar chrome.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForFunction(
    () =>
      document.querySelector('[data-settings-page="appearance"]')?.textContent?.includes("外观") &&
      document.querySelector('[data-settings-page="connections"]')?.textContent?.includes("连接") &&
      document.querySelector('[data-settings-page="about"]')?.textContent?.includes("版本与关于"),
    null,
    { timeout: 8000 },
  );
  await page.locator(".settings-modal .modal-actions button").click();
  await page.waitForSelector(".settings-modal", { state: "detached", timeout: 5000 });
  await page.keyboard.press(`${mod}+d`);
  await page.waitForSelector(".thread-changes-pop .tc-empty-title", { timeout: 5000 });
  const zhEmpty = await page.locator(".thread-changes-pop .tc-empty-title").innerText();
  const zhMoreAria = await page.locator(".more-controls-btn").getAttribute("aria-label");
  verify(
    "P253-E2E-05b zh-Hans renders consolidated Settings tabs, top-bar label, and empty changes state",
    zhEmpty.includes("暂无改动") && zhMoreAria === "更多控件",
    { zhEmpty, zhMoreAria },
  );
  await page.locator(".tc-pop-close").click();
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const isPackaged = await s1.app.evaluate(({ app }) => app.isPackaged);
  if (process.platform === "win32" && !isPackaged) {
    // Unpackaged Windows dev builds disable Git/checkpoints via git-containment
    // (src/main/index.ts); never fake IPC handlers here. The real populated
    // P253-E2E-03c flow runs on packaged Windows via scripts/windows/packaged-p253-test.mjs.
    const activeTid = (await snap(page)).selectedThreadId;
    const unpackagedChanges = await page.evaluate(
      (tid) => window.tivano.invoke("checkpoints:changes", { threadId: tid }),
      activeTid,
    );
    verify(
      "P253-E2E-03c-containment unpackaged win32 returns null checkpoints:changes honestly",
      unpackagedChanges === null && (await page.locator(".thread-changes-tab").count()) === 0,
      unpackagedChanges,
    );
  }

  const c1 = await boundedClose(s1.app, s1.proc);
  s1.ledger.exited = c1.exited;
  s1.ledger.outcome = c1.outcome;

  if (process.platform === "win32" && !isPackaged) return;

  // --- Session 2 (POSIX or packaged win32): populated +/- numbers from real git checkpoints ---
  if (!existsSync(join(dataRoot, "store.json"))) {
    throw new Error("Expected store.json in dataRoot before P253 populated-changes check");
  }
  const repoParent = mkdtempSync(join(tmpdir(), "tivano-e2e-p253-"));
  const repoDir = join(repoParent, "repo");
  const globalCfg = join(repoParent, "empty-gitconfig");
  writeFileSync(globalCfg, "");
  let s2 = null;
  try {
    execFileSync(GIT, ["init", "-b", "main", repoDir], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalCfg },
      encoding: "utf8",
    });
    runGit(repoDir, ["config", "user.email", "e2e@example.com"], globalCfg);
    runGit(repoDir, ["config", "user.name", "e2e"], globalCfg);
    writeFileSync(join(repoDir, "tracked.txt"), "base line\n");
    runGit(repoDir, ["add", "-A"], globalCfg);
    runGit(repoDir, ["commit", "-m", "base"], globalCfg);

    const projId = randomUUID();
    const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
    doc.projects.push({
      id: projId,
      name: "p253-ckpt-proj",
      createdAt: Date.now(),
      expanded: true,
      directory: realpathSync(repoDir),
    });
    writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
    const grantsPath = join(dataRoot, "workspace-grants.json");
    const gdoc = existsSync(grantsPath)
      ? JSON.parse(readFileSync(grantsPath, "utf8"))
      : { version: 1, grants: {}, userGrants: {} };
    gdoc.version = 1;
    gdoc.grants = gdoc.grants ?? {};
    gdoc.userGrants = gdoc.userGrants ?? {};
    gdoc.userGrants[projId] = realpathSync(repoDir);
    writeFileSync(grantsPath, JSON.stringify(gdoc));

    s2 = await launch(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
        ...(process.platform === "win32" ? { TIVANO_GIT_EXECUTABLE: GIT } : {}),
      },
      "p253-changes",
    );
    instances.push(s2);
    const page2 = await s2.app.firstWindow();
    await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
    await page2.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

    const created = await page2.evaluate(
      (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
      projId,
    );
    await page2.evaluate(
      (tid) => window.tivano.invoke("threads:select", { id: tid }),
      created.id,
    );
    const turn = await page2.evaluate(
      (tid) => window.tivano.invoke("turns:send", { threadId: tid, text: "ckptfile please" }),
      created.id,
    );
    let lastTh = null;
    await waitSnapshot(
      page2,
      (s) => {
        const th = s.threads.find((t) => t.id === created.id);
        lastTh = th ?? null;
        if (!th) return false;
        if (th.turn?.status === "error" || th.turn?.status === "cancelled") {
          throw new Error(`s2 turn ended with ${th.turn.status}: ${JSON.stringify(th.turn)}`);
        }
        if (th.turn?.status === "done") return true;
        return th.turn == null && th.messages.some((m) => m.turnId === turn.id && m.status === "done");
      },
      20000,
    ).catch((e) => {
      throw new Error(`${e.message}; lastTh=${JSON.stringify(lastTh)}`);
    });
    await page2.waitForSelector(".chat-top-controls .thread-changes-tab", { timeout: 20000 });
    const tabBox = await page2.locator(".chat-top-controls .thread-changes-tab").boundingBox();
    const composerTabCount = await page2.locator(".composer .thread-changes-tab").count();
    await page2.locator(".chat-top-controls .thread-changes-tab").click();
    await page2.waitForSelector('.thread-changes-pop[data-anchor="topbar"]', { timeout: 5000 });
    const popBox = await page2.locator('.thread-changes-pop[data-anchor="topbar"]').boundingBox();
    const compBox2 = await page2.locator(".composer").boundingBox();
    const popText = await page2.locator(".thread-changes-pop").innerText();
    await page2.locator(".tc-file-row", { hasText: "tracked.txt" }).click();
    await page2.waitForSelector(".thread-changes-pop .git-patch", { timeout: 5000 });
    const patchText = await page2.locator(".thread-changes-pop .git-patch").innerText();
    verify(
      "P253-E2E-03c clicking top-bar +/- numbers opens popover directly below them with file count",
      composerTabCount === 0 &&
        popText.includes("2 files") &&
        popText.includes("tracked.txt") &&
        patchText.includes("+checkpoint line") &&
        Boolean(
          tabBox &&
            popBox &&
            compBox2 &&
            popBox.y >= tabBox.y + tabBox.height - 2 &&
            popBox.y <= tabBox.y + tabBox.height + 20 &&
            Math.abs(popBox.x + popBox.width - (tabBox.x + tabBox.width)) <= 40 &&
            popBox.y < compBox2.y,
        ),
      { composerTabCount, tabBox, popBox, compBox2, popText: popText.slice(0, 120) },
    );
    await page2.screenshot({ path: join(outDir, "p253-changes-popover.png") });
    await page2.locator(".chat-top-controls .thread-changes-tab").click();
    await page2.waitForSelector(".thread-changes-pop", { state: "detached", timeout: 5000 });
  } finally {
    if (s2 && s2.proc && s2.proc.exitCode === null && s2.proc.signalCode === null) {
      const c2 = await boundedClose(s2.app, s2.proc);
      s2.ledger.exited = c2.exited;
      s2.ledger.outcome = c2.outcome;
    }
    try {
      rmSync(repoParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best-effort temp cleanup on Windows */
    }
  }
}
