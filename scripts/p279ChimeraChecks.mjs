// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-79 Chimera mark, live working count, sub-agent panel toggle, panel
// focus, Escape return focus, auto-open focus safety, and adaptive-off
// desktop interaction checks. Exported for the full e2e run and runnable
// alone via `npm run test:e2e -- --only=p279` on Windows.

import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveEvidenceDir } from "./evidenceDir.mjs";
import { boundedClose } from "./closeBound.mjs";

export async function runP279ChimeraChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  closeInstance,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitIdle = (page) =>
    page.evaluate(
      () =>
        new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(r));
        }),
    );

  const s = await launchApp({ TIVANO_MOCK_TICK_MS: "120" }, "p279-chimera");
  instances.push(s);
  const page = await s.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const priorSettings = (await snap(page)).settings ?? {};
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      hasSeenHydraIntro: false,
      hydraEnabled: true,
      hydraDefaultEnabled: true,
      hydraAutoOpensPanels: true,
    }),
  );

  const waitSnap = async (predicate, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await snap(page);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 80));
    }
    return last;
  };
  const teamOf = (st, leadId) =>
    st.threads.filter((t) => t.hydraHead?.leadId === leadId && !t.isArchived);
  const waitLeadSettled = (leadId, minReports) =>
    waitSnap((st) => {
      const lead = st.threads.find((t) => t.id === leadId);
      const busy =
        lead?.turn?.status === "running" ||
        lead?.turn?.status === "waiting-approval" ||
        lead?.turn?.status === "stopping";
      const reports =
        lead?.messages.filter((m) => m.content.includes("Hydra reports:")).length ?? 0;
      return (
        !busy &&
        teamOf(st, leadId).every(
          (t) => t.hydraHead.status !== "running" && t.hydraHead.landingPending !== true,
        ) &&
        reports >= minReports
      );
    });

  try {
  await page.locator('button[title="New thread"]').click();
  await page.waitForSelector(".chat-head h1", { timeout: 8000 });
  const leadId = (await snap(page)).selectedThreadId;

  await page.evaluate(
    (id) =>
      window.tivano.invoke("threads:set-subagent-mode", {
        threadId: id,
        mode: "adaptive",
      }),
    leadId,
  );
  await page.waitForSelector(".hydra-mark.chimera .chimera-mark-icon", {
    timeout: 8000,
  });
  await waitIdle(page);
  verify(
    "P279-E2E-01 adaptive mode shows Chimera mark without dots, badge, or auto-intro",
    (await page.locator(".hydra-mark.chimera .chimera-mark-icon").count()) === 1 &&
      (await page.locator(".hydra-mark .hydra-mark-dots").count()) === 0 &&
      (await page.locator(".hydra-mark .hydra-mark-badge").count()) === 0 &&
      (await page.locator(".hydra-intro-pop").count()) === 0,
  );

  await page.locator(".hydra-mark.chimera").click();
  await page.waitForSelector(".hydra-idle-pop", { timeout: 5000 });
  const idleText = await page.locator(".hydra-idle-pop").innerText();
  verify(
    "P279-E2E-02 zero-head adaptive click opens adaptive idle note (never Hydra intro)",
    idleText.includes("Sub-agents are on") &&
      idleText.includes("Adaptive sub-agents") &&
      (await page.locator(".hydra-intro-pop").count()) === 0,
    idleText.slice(0, 160),
  );
  await page.locator(".chat-head h1").click();
  await page.waitForSelector(".hydra-idle-pop", { state: "detached", timeout: 5000 });

  await page.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadId, text: "adaptive [mock:hydra-wait]" },
  );
  const sRun1 = await waitSnap(
    (st) =>
      teamOf(st, leadId).length === 1 &&
      teamOf(st, leadId)[0].hydraHead.status === "running",
  );
  const head1Id = teamOf(sRun1, leadId)[0].id;
  await page.waitForSelector(".hydra-mark.chimera .hydra-mark-badge", {
    timeout: 8000,
  });
  verify(
    "P279-E2E-03 running adaptive head updates Chimera badge count live",
    (await page.locator(".hydra-mark.chimera .hydra-mark-badge").innerText()) === "1" &&
      sRun1.threads.find((t) => t.id === leadId)?.subagentMode === "adaptive",
  );

  await page.locator(".hydra-mark.chimera").click();
  await page.waitForSelector(".hydra-panel", { state: "detached", timeout: 8000 });
  const afterHideSnap = await snap(page);
  verify(
    "P279-E2E-04 clicking Chimera mark hides sub-agent panel without switching mode back to Hydra",
    (await page.locator(".hydra-panel").count()) === 0 &&
      (await page.locator(".hydra-intro-pop").count()) === 0 &&
      afterHideSnap.threads.find((t) => t.id === leadId)?.subagentMode === "adaptive",
  );

  await page.locator(".hydra-mark.chimera").click();
  await page.waitForSelector(".hydra-panel", { timeout: 8000 });
  await waitIdle(page);
  const panelFocused = await page.evaluate(
    () => document.activeElement?.classList.contains("hydra-panel") === true,
  );
  verify("P279-E2E-05 clicking Chimera mark re-shows and focuses the sub-agent panel", panelFocused);

  await page.keyboard.press("Escape");
  await page.waitForSelector(".hydra-panel", { state: "detached", timeout: 5000 });
  await waitIdle(page);
  const focusReturned = await page.evaluate(
    () => document.activeElement?.classList.contains("hydra-mark") === true,
  );
  verify(
    "P279-E2E-06 Escape on focused panel dismisses it and returns focus to the button",
    focusReturned,
  );

  // Stop the first head and wait for the lead's report turn to finish, then
  // verify toggling open + hiding does NOT leave a stale focusSeq that
  // steals composer focus when a later head auto-opens.
  await page.evaluate(
    (id) => window.tivano.invoke("hydra:stop", { threadId: id }),
    head1Id,
  );
  await waitLeadSettled(leadId, 1);
  await page.locator(".composer textarea").focus();
  await page.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadId, text: "second adaptive [mock:hydra-wait]" },
  );
  await page.waitForSelector(".hydra-panel", { timeout: 12000 });
  const sRun2 = await waitSnap(
    (st) => teamOf(st, leadId).filter((t) => t.hydraHead.status === "running").length >= 1,
  );
  const head2Id = teamOf(sRun2, leadId).find((t) => t.hydraHead.status === "running")?.id;
  await waitIdle(page);
  const composerKeptFocus = await page.evaluate(
    () => document.activeElement?.matches(".composer textarea") === true,
  );
  verify(
    "P279-E2E-07 auto-open after prior toggle/dismiss does not steal focus from the composer",
    composerKeptFocus,
  );

  // Disabled-with-heads and unread intro still toggles the panel without opening Meet Hydra.
  await page.evaluate(
    (id) => window.tivano.invoke("threads:set-hydra", { threadId: id, enabled: false }),
    leadId,
  );
  await page.waitForSelector(".hydra-mark.off", { timeout: 5000 });
  await page.locator(".hydra-mark.off").click();
  await page.waitForSelector(".hydra-panel", { state: "detached", timeout: 5000 });
  verify(
    "P279-E2E-08 disabled-with-heads and unseen intro toggles the panel instead of opening Meet Hydra",
    (await page.locator(".hydra-panel").count()) === 0 &&
      (await page.locator(".hydra-intro-pop").count()) === 0,
  );
  await page.locator(".hydra-mark.off").click();
  await page.waitForSelector(".hydra-panel", { timeout: 5000 });

  await page.evaluate(
    (id) => window.tivano.invoke("threads:set-hydra", { threadId: id, enabled: true }),
    leadId,
  );
  await page.waitForSelector(".hydra-mark.chimera", { timeout: 5000 });
  if (head2Id) {
    await page.evaluate(
      (id) => window.tivano.invoke("hydra:stop", { threadId: id }),
      head2Id,
    );
    await waitSnap((st) => teamOf(st, leadId).every((t) => t.hydraHead.status !== "running"));
    await page.waitForSelector(".hydra-mark .hydra-mark-badge", {
      state: "detached",
      timeout: 5000,
    });
  }
  verify(
    "P279-E2E-09 stopping running head clears badge to zero while keeping Chimera mark",
    (await page.locator(".hydra-mark.chimera").count()) === 1 &&
      (await page.locator(".hydra-mark .hydra-mark-badge").count()) === 0,
  );

  // Switching out of adaptive mode requires the lead's pending head report to settle first.
  if (head2Id) await waitLeadSettled(leadId, 2);

  await page.evaluate(
    (id) =>
      Promise.all([
        window.tivano.invoke("threads:set-subagent-mode", {
          threadId: id,
          mode: "same",
        }),
        window.tivano.invoke("settings:set", { hasSeenHydraIntro: true }),
      ]),
    leadId,
  );
  await page.waitForSelector(".hydra-mark:not(.off):not(.chimera) .hydra-mark-dots", {
    timeout: 5000,
  });
  verify(
    "P279-E2E-09b leaving adaptive restores Hydra dots",
    (await page.locator(".hydra-mark .hydra-mark-dots").count()) === 1 &&
      (await page.locator(".hydra-mark.chimera").count()) === 0,
  );
  } finally {
    try {
      await page.evaluate(
        (prev) => window.tivano.invoke("settings:set", prev),
        {
          language: priorSettings.language ?? "en",
          hasSeenHydraIntro: priorSettings.hasSeenHydraIntro === true,
          hydraEnabled: priorSettings.hydraEnabled !== false,
          hydraDefaultEnabled: priorSettings.hydraDefaultEnabled !== false,
          hydraAutoOpensPanels: priorSettings.hydraAutoOpensPanels !== false,
        },
      );
    } catch {
      // Best-effort restore when closing after an earlier failure.
    }
  }

  await closeInstance(s.app, s.proc);
}

/** Standalone runner used by `npm run test:e2e -- --only=p279`. */
export async function runP279ChimeraStandalone() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const require = createRequire(join(root, "package.json"));
  const electronBin = require("electron");
  const outDir = resolveEvidenceDir({ explicit: process.env.E2E_EVIDENCE_DIR, sourceDir: root });
  const dataRoot = mkdtempSync(join(tmpdir(), "tivano-e2e-p279-data-"));
  const results = [];
  const instances = [];
  const pageErrors = [];
  const env = { ...process.env, TIVANO_MOCK_TICK_MS: "120" };
  delete env.ELECTRON_RUN_AS_NODE;

  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  };
  const launch = async (envOverrides = {}, label = "p279") => {
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
      proc = null;
    }
    const entry = { label, pid: proc?.pid ?? null, exited: false, outcome: "pending" };
    const attach = (p) => p.on("pageerror", (e) => pageErrors.push(String(e)));
    app.on("window", attach);
    for (const p of app.windows()) attach(p);
    return { app, proc, ledger: entry };
  };
  const snap = (page) => page.evaluate(() => window.tivano.invoke("state:get", {}));

  let runError = null;
  try {
    await runP279ChimeraChecks({
      launch,
      instances,
      snap,
      check,
      closeInstance: boundedClose,
      outDir,
    });
  } catch (err) {
    runError = err;
    console.error("p279 e2e failure:", err);
  }

  let allExited = true;
  for (const { app, proc, ledger } of instances) {
    if (!proc) {
      allExited = false;
      ledger.exited = false;
      ledger.outcome = "handle-lost";
      continue;
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      const r = await boundedClose(app, proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
      ledger.exited = r.exited;
      ledger.outcome = `cleanup:${r.outcome}${r.killed ? "+killed" : ""}`;
      if (!r.exited) allExited = false;
    } else {
      ledger.exited = true;
      ledger.outcome = "exited";
    }
  }

  const failed = results.filter((r) => !r.ok);
  const success = failed.length === 0 && !runError && allExited && pageErrors.length === 0;
  writeFileSync(
    join(outDir, "p279-e2e-results.json"),
    JSON.stringify(
      {
        dataRoot,
        results,
        allExited,
        pageErrors,
        error: runError ? String(runError) : null,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (success) rmSync(dataRoot, { recursive: true, force: true });
  else console.log(`failure evidence kept: data root ${dataRoot}`);
  console.log(`\n${results.length - failed.length}/${results.length} p279 e2e checks passed`);
  return success ? 0 : 1;
}
