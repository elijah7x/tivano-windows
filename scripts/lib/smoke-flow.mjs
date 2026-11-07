// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shared packaged/dev smoke flow. Driven by two launchers:
//   scripts/windows/packaged-smoke.mjs  — real packaged exe, win32/x64
//   scripts/dev-smoke-harness.mjs       — macOS dev Electron, HARNESS ONLY
// The flow exercises only existing UI/IPC with the in-process mock
// provider. Platform gate assertions are parameterized — never faked.

import { _electron as electron } from "playwright-core";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { awaitExit, boundedClose } from "../closeBound.mjs";

/** Component-aware path containment — a prefix check on raw strings
 *  would pass `C:\foo` for `C:\foobar`. */
export function pathInside(base, p) {
  const norm = (s) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rel = relative(norm(base), norm(p));
  return rel === "" || (rel !== ".." && rel.split(/[\\/]/)[0] !== ".." && !isAbsolute(rel));
}

export function expectedWindowsGitGate(snapshot, panelText) {
  const text = snapshot?.kind === "not-repository" ? "Not a Git repository" :
    snapshot?.kind === "unavailable" && snapshot.reason === "no-git" ? "Git executable not found" : null;
  return text !== null && String(panelText).split(/\r?\n/).some((line) => line.trim() === text);
}

/**
 * opts:
 *   executablePath  — exe/electron binary
 *   args            — launch args ([] for packaged exe, [root] for dev)
 *   env             — fully-controlled child env
 *   dataRoot, workspaceRoot, projectDir, outDir
 *   expectPackaged  — assert isPackaged + data outside installDir
 *   installDir      — required when expectPackaged
 *   platformExpectation — "win-gated" | "posix-open"
 *   deadlineMs      — TOTAL watchdog for the whole flow
 *   label           — report label
 */
export async function runSmokeFlow(opts) {
  const {
    executablePath, args, env, dataRoot, workspaceRoot, projectDir,
    outDir, expectPackaged, installDir, platformExpectation, deadlineMs, label,
  } = opts;

  const results = [];
  const pageErrors = [];
  const exits = [];
  const screenshots = [];
  const owned = [];
  const deadline = Date.now() + deadlineMs;
  const left = () => deadline - Date.now(); // REAL remaining — may go ≤0
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: ok === true, detail: String(detail).slice(0, 400) });
    console.log(`${ok === true ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
  };
  const shot = async (page, name) => {
    try {
      await page.screenshot({ path: join(outDir, name), timeout: Math.min(10000, left()) });
      screenshots.push(name);
    } catch (e) {
      check(`screenshot ${name}`, false, e);
    }
  };
  const ensureTime = () => {
    if (left() <= 0) throw new Error(`deadline exceeded (${deadlineMs}ms)`);
  };
  /** Every awaited call is bounded by the remaining deadline. */
  const bounded = async (p, what) => {
    let timer;
    try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`bounded wait expired: ${what}`)), Math.max(1, left())); })]); }
    finally { clearTimeout(timer); }
  };

  const snap = (page) =>
    bounded(page.evaluate(() => window.tivano.invoke("state:get", {})), "state:get");
  const waitSnapshot = async (page, pred, ms = 15000) => {
    const end = Date.now() + Math.min(ms, left());
    let last;
    while (Date.now() < end) {
      last = await snap(page);
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, 120));
    }
    return last;
  };

  const launch = async (runLabel) => {
    ensureTime();
    const inst = await bounded(
      electron.launch({
        executablePath,
        args,
        env,
        timeout: Math.min(30000, left()),
      }),
      `${runLabel} launch`,
    );
    const proc = inst.process();
    owned.push({ label: runLabel, proc });
    const page = await bounded(inst.firstWindow(), `${runLabel} firstWindow`);
    page.setDefaultTimeout(Math.max(1, Math.min(15000, left())));
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    return { inst, proc, page };
  };

  const closeAndRecord = async (inst, proc, runLabel) => {
    const res = await boundedClose(inst, proc, {
      closeMs: Math.min(20000, left()),
      exitMs: Math.min(15000, left()),
      killWaitMs: 5000,
    });
    exits.push({ label: runLabel, ...res });
    check(
      `${runLabel} exited cleanly`,
      res.exited === true && res.outcome === "resolved" && res.exitCode === 0 && res.signalCode === null && !res.killed,
      `outcome=${res.outcome} exitCode=${res.exitCode} signal=${res.signalCode} killed=${res.killed}`,
    );
    return res;
  };

  let threadId = null;
  let projectId = null;
  try {
    // ---------- run 1: boot, bridge, paths, mock turn ----------
    const r1 = await launch("run-1");
    const page = r1.page;
    check(
      "window launched and page loaded",
      await page.waitForSelector(".sidebar-head", { timeout: Math.min(20000, left()) }).then(() => true).catch(() => false),
    );
    check(
      "preload bridge exposed (window.tivano.invoke)",
      await bounded(page.evaluate(() => typeof window.tivano?.invoke === "function"), "bridge"),
    );

    const paths = await bounded(
      r1.inst.evaluate(({ app: a }) => ({
        userData: a.getPath("userData"),
        sessionData: a.getPath("sessionData"),
        appPath: a.getAppPath(),
        packaged: a.isPackaged,
      })),
      "paths",
    );
    check(
      "chromium userData/sessionData isolated under the test data root",
      pathInside(dataRoot, paths.userData) &&
        pathInside(dataRoot, paths.sessionData) &&
        paths.userData !== paths.sessionData,
      `${paths.userData} | ${paths.sessionData}`,
    );
    if (expectPackaged) {
      check("app reports packaged=true", paths.packaged === true, `appPath=${paths.appPath}`);
      check(
        "data root lives OUTSIDE the install directory",
        !pathInside(installDir, dataRoot) &&
          !pathInside(installDir, paths.userData) &&
          !pathInside(dataRoot, paths.appPath) &&
          pathInside(installDir, paths.appPath),
        `installDir=${installDir} dataRoot=${dataRoot} appPath=${paths.appPath}`,
      );
    } else {
      check("dev harness reports packaged=false", paths.packaged === false);
    }

    const project = await bounded(
      page.evaluate(() => window.tivano.invoke("projects:create", { name: "smoke" })),
      "projects:create",
    );
    projectId = project?.id ?? null;
    check("project created via IPC", Boolean(projectId), `id=${projectId}`);
    const thread = await bounded(
      page.evaluate((pid) => window.tivano.invoke("threads:create", { projectId: pid }), projectId),
      "threads:create",
    );
    threadId = thread?.id ?? null;
    check("thread created via IPC", Boolean(threadId), `id=${threadId}`);
    await bounded(page.evaluate((id) => window.tivano.invoke("threads:select", { id }), threadId), "threads:select");
    await waitSnapshot(page, (s) => s.selectedThreadId === threadId);

    const badge = page.locator(".chat-head .badge.mock");
    check(
      "mock provider badge visible",
      (await badge.count()) === 1 && (await badge.isVisible()) &&
        /Mock Provider|模拟服务商/.test(await badge.innerText()),
    );

    await page.locator(".composer textarea").fill("please [mock:approval] run the sync");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".approval", { timeout: Math.min(15000, left()) });
    const withTurn = await waitSnapshot(page, (s) => {
      const t = s.threads.find((x) => x.id === threadId);
      return t?.turn?.status === "waiting-approval" && t.turn.approval?.status === "pending";
    });
    const turn = withTurn.threads.find((t) => t.id === threadId)?.turn;
    check("mock approval pending on this turn",
      turn?.status === "waiting-approval" && turn?.approval?.status === "pending");
    await shot(page, `${label}-01-approval.png`);
    await page.getByRole("button", { name: "Allow once" }).click();
    const doneSnap = await waitSnapshot(page, (s) => {
      const t = s.threads.find((x) => x.id === threadId)?.turn;
      return t?.status === "done" && t?.approval?.status === "resolved";
    }, 20000);
    check("mock turn streamed and completed",
      doneSnap.threads.find((t) => t.id === threadId)?.turn?.status === "done");
    await shot(page, `${label}-02-turn-done.png`);

    const firstClose = await closeAndRecord(r1.inst, r1.proc, "run-1");
    if (!firstClose.exited || firstClose.outcome !== "resolved" || firstClose.killed || firstClose.exitCode !== 0)
      throw new Error("first instance did not exit cleanly; preserving test store");

    // ---------- bind the project dir via the REAL grants path ----------
    // Same on-disk shape the user-selected-directory flow produces: the
    // project record carries `directory` AND a userGrants entry exists.
    // Written after run-1 exits so nothing can clobber it; run-2 must
    // restore a bound project (directoryStatus=available) — otherwise a
    // "no-grant" unavailable could masquerade as a platform gate.
    const grantDir = realpathSync(projectDir);
    const storeFile = join(dataRoot, "store.json");
    if (!existsSync(storeFile))
      throw new Error("store.json missing after clean run-1 exit — cannot bind grant");
    const doc = JSON.parse(readFileSync(storeFile, "utf8"));
    const proj = (doc.projects ?? []).find((p) => p.id === projectId);
    if (!proj) throw new Error(`project ${projectId} missing from persisted store`);
    proj.directory = grantDir;
    writeFileSync(storeFile, JSON.stringify(doc));
    writeFileSync(
      join(dataRoot, "workspace-grants.json"),
      JSON.stringify({ version: 1, grants: {}, userGrants: { [projectId]: grantDir } }),
    );

    // ---------- run 2: persistence, gates, i18n ----------
    const r2 = await launch("run-2");
    const page2 = r2.page;
    await page2.waitForSelector(".sidebar-head", { timeout: Math.min(20000, left()) });
    const snap2 = await waitSnapshot(page2, (s) =>
      s.threads.some((t) => t.id === threadId) && s.projects.some((p) => p.id === projectId),
    );
    const persisted = snap2.threads.find((t) => t.id === threadId);
    const bound = snap2.projects.find((p) => p.id === projectId);
    check("saved thread persisted across clean restart",
      Boolean(persisted) && persisted.turn?.status === "done");
    check("project directory bound via restored grant",
      bound?.directoryStatus === "available" && bound?.directory === grantDir,
      `status=${bound?.directoryStatus} dir=${bound?.directory}`);

    // Open the real panels and observe the gate — IPC alone does not
    // prove the UI renders the closed capability honestly.
    await page2.locator('button.term-toggle[title="Terminal"]').click();
    await page2.waitForSelector(".term-panel", { timeout: Math.min(10000, left()) });
    await page2.locator(".term-panel .term-btn").first().click(); // "+ New terminal"
    const termNotice = await page2
      .locator(".term-panel .banner")
      .waitFor({ timeout: Math.min(10000, left()) })
      .then(() => page2.locator(".term-panel .banner").innerText())
      .catch(() => null);
    const termIpc = await bounded(
      page2.evaluate((t) => window.tivano.invoke("terminals:create", { threadId: t, cols: 80, rows: 24 }), threadId),
      "terminals:create",
    );
    if (platformExpectation === "win-gated") {
      check("terminal gate visibly closed (panel notice)",
        typeof termNotice === "string" && termNotice.length > 0, `notice=${termNotice}`);
      check("terminal gate closed at IPC",
        typeof termIpc?.unavailable === "string", JSON.stringify(termIpc).slice(0, 160));
    } else {
      // posix-open: either a real terminal or an honest reason —
      // the gate is NOT pretending to be Windows.
      check("terminal responds honestly on this host",
        Boolean(termIpc?.terminal) || typeof termIpc?.unavailable === "string",
        JSON.stringify(termIpc).slice(0, 160));
    }

    await page2.locator('button.term-toggle[title="Git"]').click();
    await page2.waitForSelector(".git-panel", { timeout: Math.min(10000, left()) });
    await page2.locator(".git-panel .git-refresh").click();
    // The refresh is async — poll the overview until a real snapshot
    // lands (or the deadline dies), never race the first response.
    let gitIpc = null;
    {
      const end = Date.now() + Math.min(12000, left());
      while (Date.now() < end) {
        gitIpc = await bounded(
          page2.evaluate((pid) => window.tivano.invoke("git:overview", { projectId: pid }), projectId),
          "git:overview",
        );
        if (gitIpc?.kind && gitIpc.reason !== "no-snapshot" && gitIpc.snapshotId !== "") break;
        if (gitIpc?.kind === "ready" || gitIpc?.kind === "not-repository" || gitIpc?.kind === "unsupported" || (gitIpc?.kind === "unavailable" && gitIpc?.reason && gitIpc.reason !== "no-snapshot")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const gitPanelText = await page2
      .locator(".git-panel .center-state")
      .first()
      .waitFor({ timeout: Math.min(12000, left()) })
      .then(() => page2.locator(".git-panel").innerText())
      .catch(() => page2.locator(".git-panel").innerText().catch(() => ""));
    if (platformExpectation === "win-gated") {
      // The granted fixture directory is deliberately NOT a repository.
      check("Windows Git matches the non-repository fixture or missing executable",
        gitIpc?.kind === "not-repository" || (gitIpc?.kind === "unavailable" && gitIpc.reason === "no-git"),
        `kind=${gitIpc?.kind} reason=${gitIpc?.reason}`);
      check("git panel matches the Windows Git result",
        expectedWindowsGitGate(gitIpc, gitPanelText), String(gitPanelText).slice(0, 200));
    } else {
      // darwin harness: real probe ran — ready/not-repository/unavailable
      // are all honest terminal states; silent missing panel is not.
      const okKinds = opts.expectGitReady ? ["ready"] : ["ready", "not-repository", "unavailable", "unsupported"];
      check("git responds honestly on this host",
        okKinds.includes(gitIpc?.kind),
        `kind=${gitIpc?.kind} reason=${gitIpc?.reason ?? ""}`);
      check("git panel rendered content",
        String(gitPanelText).length > 0, String(gitPanelText).slice(0, 120));
    }
    await shot(page2, `${label}-03-gates.png`);

    await bounded(page2.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" })), "settings zh");
    const zhOk = await page2
      .waitForFunction(() => document.body.innerText.includes("对话列表"), null, { timeout: Math.min(8000, left()) })
      .then(() => true).catch(() => false);
    check("zh-Hans UI applies", zhOk);
    await shot(page2, `${label}-04-zh-hans.png`);
    await bounded(page2.evaluate(() => window.tivano.invoke("settings:set", { language: "en" })), "settings en");
    const enOk = await page2
      .waitForFunction(() => document.body.innerText.includes("Thread list"), null, { timeout: Math.min(8000, left()) })
      .then(() => true).catch(() => false);
    check("English UI restored", enOk);

    check("no renderer page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await closeAndRecord(r2.inst, r2.proc, "run-2");
  } catch (e) {
    check("harness completed without exception", false, String(e?.stack ?? e).slice(0, 400));
  } finally {
    // Owned processes only — explicit handles, never a name sweep.
    for (const { proc } of owned) {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        if (process.platform === "win32") {
          const { spawnSync } = await import("node:child_process");
          spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10000, windowsHide: true });
        } else {
          try { proc.kill("SIGKILL"); } catch { /* gone */ }
        }
        const confirmed = await awaitExit(proc, 5000);
        exits.push({ label: "cleanup-kill", exited: confirmed, pid: proc.pid });
      }
    }
  }

  const allExited = owned.length > 0 && owned.every(({proc}) => proc && (proc.exitCode !== null || proc.signalCode !== null));
  check("no renderer errors across both lifecycles", pageErrors.length === 0);
  const ok = results.length > 0 && results.every((r) => r.ok) && allExited;
  return { results, pageErrors, exits, screenshots, allExited, ok, threadId, projectId };
}
