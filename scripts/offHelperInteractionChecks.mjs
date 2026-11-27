// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-40 Off/auto-pop desktop interaction checks. The suite is exported for
// the full e2e run and can also run alone through `npm run test:e2e --
// --only=offhelper`, keeping this acceptance coverage executable while the
// broader POSIX-bound harness is repaired for Windows.

import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveEvidenceDir } from "./evidenceDir.mjs";
import { boundedClose } from "./closeBound.mjs";

/**
 * Real Electron interaction coverage for the two P2-40 follow-up paths:
 * the Off capsule opens the plain helper's panel, and dismissing the team
 * panel releases individual automatic-pop holds.
 */
export async function runOffHelperInteractionChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  closeInstance,
  outDir,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const newThread = async (page) => {
    await page.locator('button[title="New thread"]').click();
    return (await snap(page)).selectedThreadId;
  };

  const s = await launchApp({ TIVANO_MOCK_TICK_MS: "1000" }, "offhelper-interactions");
  instances.push(s);
  const page = await s.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      hasSeenHydraIntro: true,
      hydraEnabled: true,
      hydraDefaultEnabled: true,
      hydraMaxHeads: null,
      lastHydraPairId: null,
      hydraAutoOpensPanels: false,
      hydraAutoPopsHeads: true,
    }),
  );
  const waitSnap = async (predicate, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await snap(page);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 60));
    }
    return last;
  };

  const leadOff = await newThread(page);
  const spawned = await page.evaluate(
    (a) => window.tivano.invoke("threads:spawn-helper", a),
    { parentId: leadOff, title: "Capsule helper", prompt: "hold [mock:approval]" },
  );
  await page.waitForSelector(".helper-working-btn", { timeout: 12000 });
  const capsuleAttrs = await page.locator(".helper-working-btn").evaluate((el) => ({
    valueText: el.getAttribute("aria-valuetext"),
    disabled: el.disabled,
    capsuleClass: el.parentElement?.className ?? "",
  }));
  verify(
    "P40-E2E-01 Off capsule carries the frozen working value",
    capsuleAttrs.valueText === "Sub-agent working" &&
      capsuleAttrs.disabled === false &&
      capsuleAttrs.capsuleClass === "chrome-capsule",
    capsuleAttrs,
  );
  await page.screenshot({ path: join(outDir, "off-helper-capsule.png") });

  await page.locator(".helper-working-btn").click();
  const sShown = await waitSnap(
    (state) =>
      state.threads.find((t) => t.id === spawned.id)?.isInPanel === true &&
      state.selectedThreadId === leadOff,
    10000,
  );
  await page.waitForSelector(
    `.chat-stack > .helper-panel .helper-timeline[data-chat-id="${spawned.id}"]`,
    { timeout: 10000 },
  );
  verify(
    "P40-E2E-02 capsule click invokes show-helper and mounts the helper panel",
    sShown.threads.find((t) => t.id === spawned.id)?.isInPanel === true,
    spawned.id,
  );
  await page.evaluate(
    (id) => window.tivano.invoke("threads:close-helper", { id }),
    spawned.id,
  );

  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraAutoOpensPanels: true }),
  );
  const leadPop = await newThread(page);
  await page.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadPop, text: "split it up [mock:hydra-waitmany]" },
  );
  await page.waitForSelector(".helper-pop-layer .helper-panel", { timeout: 25000 });
  const popped = page.locator(".helper-pop-layer .helper-panel").first();
  const poppedId = await popped.locator(".helper-timeline").getAttribute("data-chat-id");
  verify(
    "P40-E2E-03 independent layout auto-pops a later running head",
    typeof poppedId === "string" && poppedId.length > 0,
    poppedId,
  );
  await popped.locator(".helper-close").click();
  await page.waitForSelector(
    `.helper-pop-layer .helper-panel .helper-timeline[data-chat-id="${poppedId}"]`,
    { state: "detached", timeout: 5000 },
  );
  const stillRunning = await waitSnap(
    (state) => state.threads.find((t) => t.id === poppedId)?.hydraHead?.status === "running",
    5000,
  );
  verify(
    "P40-E2E-04 dismissing one pop holds only that panel closed",
    stillRunning.threads.find((t) => t.id === poppedId)?.hydraHead?.status === "running",
    poppedId,
  );

  await page.locator(".hydra-panel .hydra-title").first().click({ button: "right" });
  await page.waitForSelector(".hydra-menu", { timeout: 5000 });
  await page.locator('.hydra-menu .suggest-row:has-text("Dismiss the panel")').click();
  await page.waitForSelector(".hydra-panel", { state: "detached", timeout: 8000 });
  verify(
    "P40-E2E-05 team panel dismisses while sub-agents keep working",
    (await page.locator(".hydra-panel").count()) === 0,
  );

  await page.locator(".hydra-mark").click();
  await page.waitForSelector(".hydra-panel", { timeout: 8000 });
  await page.waitForSelector(
    `.helper-pop-layer .helper-panel .helper-timeline[data-chat-id="${poppedId}"]`,
    { timeout: 10000 },
  );
  verify(
    "P40-E2E-06 re-shown team panel pops the previously held head again",
    (await page.locator(`.helper-pop-layer .helper-panel .helper-timeline[data-chat-id="${poppedId}"]`).count()) === 1,
    poppedId,
  );
  await page.screenshot({ path: join(outDir, "hydra-pop-reopened.png") });
  await closeInstance(s.app, s.proc);
}

/** Standalone runner used by `npm run test:e2e -- --only=offhelper`. */
export async function runOffHelperInteractionStandalone() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const require = createRequire(join(root, "package.json"));
  const electronBin = require("electron");
  const outDir = resolveEvidenceDir({ explicit: process.env.E2E_EVIDENCE_DIR, sourceDir: root });
  const dataRoot = mkdtempSync(join(tmpdir(), "tivano-e2e-offhelper-data-"));
  const results = [];
  const instances = [];
  const pageErrors = [];
  const env = { ...process.env, TIVANO_MOCK_TICK_MS: "1000" };
  delete env.ELECTRON_RUN_AS_NODE;

  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  };
  const launch = async (envOverrides = {}, label = "offhelper") => {
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
    await runOffHelperInteractionChecks({
      launch,
      instances,
      snap,
      check,
      closeInstance: boundedClose,
      outDir,
    });
  } catch (err) {
    runError = err;
    console.error("offhelper e2e failure:", err);
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
    join(outDir, "offhelper-e2e-results.json"),
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
  console.log(`\n${results.length - failed.length}/${results.length} offhelper e2e checks passed`);
  return success ? 0 : 1;
}
