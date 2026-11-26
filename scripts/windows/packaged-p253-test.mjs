#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Packaged Windows P2-53 chrome & real-checkpoint E2E acceptance runner:
// launches the packaged Windows x64 executable (with attested
// tivano-job-helper.exe --run) and runs runP253ChromeChecks end-to-end
// including Session 2 (real temporary Git repo + Codex fixture turn +
// CheckpointService + checkpoints:changes IPC + top-bar +/- popover).
//
//   node scripts/windows/packaged-p253-test.mjs --exe <packaged exe> --evidence <fresh external dir>

import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedClose } from "../closeBound.mjs";
import { resolveOutputDir, sha256File } from "../lib/package-plan.mjs";
import { runP253ChromeChecks } from "../p253ChromeChecks.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.error(
    `packaged-p253-test: NOT RUN — requires a Windows x64 host (got ${process.platform}/${process.arch})`,
  );
  process.exit(3);
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const exe = flag("--exe");
const evidence = flag("--evidence");
if (!exe || !evidence || !isAbsolute(exe)) {
  console.error(
    "usage: packaged-p253-test.mjs --exe <absolute packaged exe> --evidence <fresh external dir>",
  );
  process.exit(2);
}
const exeAbs = resolve(exe);
if (!existsSync(exeAbs) || !statSync(exeAbs).isFile() || !/\.exe$/i.test(basename(exeAbs))) {
  console.error(`packaged-p253-test: --exe must be an existing .exe file: ${exeAbs}`);
  process.exit(2);
}
const outDir = resolveOutputDir(evidence, ROOT);
const installDir = dirname(exeAbs);
const helperAbs = join(installDir, "resources", "job-helper", "tivano-job-helper.exe");
const asarAbs = join(installDir, "resources", "app.asar");
const req = createRequire(join(ROOT, "package.json"));
const asar = req("@electron/asar");
const manifest = JSON.parse(
  Buffer.from(asar.extractFile(asarAbs, "dist/job-helper-manifest.json")).toString("utf8"),
);
if (!existsSync(helperAbs) || sha256File(helperAbs) !== manifest.sha256) {
  console.error("packaged-p253-test: packaged job-helper missing or hash-mismatched");
  process.exit(2);
}
const versionDoc = JSON.parse(
  execFileSync(helperAbs, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true }),
);
if (versionDoc?.runExitBase !== 1024 || versionDoc?.runExitMax !== 255) {
  console.error("packaged-p253-test: helper lacks --run capability");
  process.exit(2);
}

const dataRoot = mkdtempSync(join(tmpdir(), "tivano-pkg-p253-data-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "tivano-pkg-p253-ws-"));
const codexFixture = join(ROOT, "tests", "fixtures", "codex-app-server.mjs");
const results = [];
const instances = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: ok === true, detail: String(detail) });
  console.log(`${ok === true ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const snap = (page) => page.evaluate(() => window.tivano.invoke("state:get", {}));
const launch = async (envOverrides = {}, label = "pkg-p253") => {
  const childEnv = { ...process.env, TIVANO_MOCK_TICK_MS: "3", ...envOverrides };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: exeAbs,
    args: [`--data-root=${dataRoot}`],
    env: childEnv,
    timeout: 30000,
  });
  const proc = app.process();
  const ledger = { label, exited: false, outcome: "running" };
  return { app, proc, ledger };
};

let runError = null;
try {
  await runP253ChromeChecks({
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
} catch (e) {
  runError = e;
  console.error("packaged-p253-test failed:", e);
}

let allExited = true;
for (const { app, proc, ledger } of instances) {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const r = await boundedClose(app, proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
    ledger.exited = r.exited;
    ledger.outcome = r.outcome;
    if (!r.exited) allExited = false;
  }
}

const failed = results.filter((r) => !r.ok);
const ok = failed.length === 0 && !runError && allExited;
writeFileSync(
  join(outDir, "packaged-p253-results.json"),
  JSON.stringify(
    {
      schema: "tivano-windows-packaged-p253/1",
      exe: exeAbs,
      passed: results.length - failed.length,
      total: results.length,
      allExited,
      error: runError ? String(runError) : null,
      results,
      at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
if (ok) {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log(`\n${results.length - failed.length}/${results.length} packaged P2-53 checks passed`);
process.exit(ok ? 0 : 1);
