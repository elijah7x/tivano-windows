#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Offline smoke test for the PACKAGED Windows x64 dev build.
//
//   node scripts/windows/packaged-smoke.mjs --exe <packaged exe> --evidence <fresh dir>
//
// Runs ONLY on a real win32/x64 host — it refuses before touching the
// filesystem anywhere else. It never installs or uninstalls anything:
// the caller points at the unpacked "dir" target's .exe (or an
// already-installed copy) and this harness launches it with
// test-owned, isolated data/workspace roots and the in-process mock
// provider only. No real provider is ever started. Platform gates are
// asserted on the REAL panels, not only through IPC.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOutputDir } from "../lib/package-plan.mjs";
import { runSmokeFlow } from "../lib/smoke-flow.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", ".."); // scripts/windows → repo root
const DEADLINE_MS = 4 * 60_000;

// ---------------------------------------------------------------------------
// Hard gate FIRST — refuse wrong platform/arch before ANY mutation.
// ---------------------------------------------------------------------------
if (process.platform !== "win32" || process.arch !== "x64") {
  console.error(
    `packaged-smoke: NOT RUN — requires a Windows x64 host (got ${process.platform}/${process.arch}); ` +
      `running it elsewhere would be meaningless, no filesystem state was touched`,
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const exe = flag("--exe");
const evidence = flag("--evidence");
if (!exe || !evidence) {
  console.error("usage: packaged-smoke.mjs --exe <packaged exe> --evidence <fresh external dir>");
  process.exit(2);
}
const exeAbs = resolve(exe);
if (!existsSync(exeAbs) || !lstatSync(exeAbs).isFile() || !/\.exe$/i.test(basename(exeAbs))) {
  console.error(`packaged-smoke: --exe must be an existing .exe file: ${exeAbs}`);
  process.exit(2);
}
const installDir = dirname(exeAbs);
let outDir;
try {
  outDir = resolveOutputDir(evidence, ROOT);
} catch (e) {
  console.error(`packaged-smoke: ${e.message ?? e}`);
  process.exit(2);
}

// Test-owned, isolated roots — NEVER inside the install dir.
const dataRoot = mkdtempSync(join(tmpdir(), "tivano-pkg-smoke-data-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "tivano-pkg-smoke-ws-"));
const projectDir = join(workspaceRoot, "proj");
mkdirSync(projectDir);
console.log(`packaged exe: ${exeAbs}`);
console.log(`install dir : ${installDir}`);
console.log(`data root   : ${dataRoot}`);
console.log(`workspace   : ${workspaceRoot}`);
console.log(`evidence    : ${outDir}`);

// Environment: retain only what a Windows Electron child needs. Every
// provider/credential/codex/synthetic variable is dropped so nothing
// inherited can switch the app off its in-process mock provider.
const KEEP_ENV = [
  "SystemRoot", "SystemDrive", "windir", "WINDIR", "COMSPEC", "PATHEXT",
  "PATH", "Path", "TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE", "COMPUTERNAME", "OS", "NUMBER_OF_PROCESSORS",
  "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PUBLIC",
  "ProgramData", "ALLUSERSPROFILE", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "CommonProgramW6432", "PSModulePath", "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
  "LOGONSERVER", "SESSIONNAME",
];
const childEnv = {};
for (const k of KEEP_ENV) if (process.env[k] !== undefined) childEnv[k] = process.env[k];
childEnv.TIVANO_WORKSPACE_ROOT = workspaceRoot;
childEnv.TIVANO_MOCK_TICK_MS = "3";

const startedAt = new Date().toISOString();
const flow = await runSmokeFlow({
  label: "packaged",
  executablePath: exeAbs,
  args: [`--data-root=${dataRoot}`],
  env: childEnv,
  dataRoot,
  workspaceRoot,
  projectDir,
  outDir,
  expectPackaged: true,
  installDir,
  platformExpectation: "win-gated",
  deadlineMs: DEADLINE_MS,
});

const ok = flow.ok;
const report = {
  schema: "tivano-windows-packaged-smoke/2",
  startedAt,
  finishedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch },
  exe: exeAbs,
  installDir,
  dataRoot,
  workspaceRoot,
  results: flow.results,
  exits: flow.exits,
  pageErrors: flow.pageErrors,
  screenshots: flow.screenshots,
  allExited: flow.allExited,
  ok,
  note: "offline packaged smoke — in-process mock provider only; real providers, terminal, git and checkpoint apply stay gated",
};
writeFileSync(join(outDir, "packaged-smoke.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `\n${flow.results.filter((r) => r.ok).length}/${flow.results.length} checks passed — report: ${join(outDir, "packaged-smoke.json")}`,
);
// Keep test data unless EVERY owned process verifiably exited and all
// checks passed — a failure or an unconfirmed exit preserves it.
if (ok && flow.allExited) {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
