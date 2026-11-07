#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// DEV/HARNESS SELF-TEST for the shared smoke flow — runs the same
// selectors, real IPC, approval, persistence and timeout handling
// against the macOS development Electron build.
//
//   node scripts/dev-smoke-harness.mjs --evidence <fresh dir>
//
// THIS IS NOT WINDOWS VALIDATION. The app runs unbundled
// (isPackaged=false), on darwin, with POSIX gates open — terminal/git
// assertions expect the POSIX-open outcome. It exists to prove the
// shared flow works before spending Windows/Cloud time, and it never
// bypasses the packaged smoke's win32/x64 host guard.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveOutputDir } from "./lib/package-plan.mjs";
import { runSmokeFlow } from "./lib/smoke-flow.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DEADLINE_MS = 4 * 60_000;

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const evidence = flag("--evidence");
if (!evidence) {
  console.error("usage: dev-smoke-harness.mjs --evidence <fresh dir>");
  process.exit(2);
}
let outDir;
try {
  outDir = resolveOutputDir(evidence, ROOT);
} catch (e) {
  console.error(`dev-smoke-harness: ${e.message ?? e}`);
  process.exit(2);
}

const require = createRequire(join(ROOT, "package.json"));
const electronBin = require("electron"); // dev electron binary
if (typeof electronBin !== "string" || !existsSync(electronBin)) {
  console.error("dev-smoke-harness: electron binary not resolvable — npm install first");
  process.exit(2);
}
const distOk = ["dist/main/index.cjs", "dist/preload/index.cjs", "dist/renderer/index.html"].every((f) =>
  existsSync(join(ROOT, f)),
);
if (!distOk) {
  console.error("dev-smoke-harness: dist/ missing — run `node scripts/build.mjs` first");
  process.exit(2);
}

const dataRoot = mkdtempSync(join(tmpdir(), "tivano-devharness-data-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "tivano-devharness-ws-"));
const projectDir = join(workspaceRoot, "proj");
mkdirSync(projectDir);
// Seed a real git repo in the project dir — the darwin gate is OPEN, so
// the harness must observe kind=ready (not merely "some unavailable").
try {
  const { execFileSync } = await import("node:child_process");
  const g = (a) => execFileSync("/usr/bin/git", a, { cwd: projectDir, stdio: "pipe" });
  g(["init", "-q", "-b", "main"]);
  g(["-c", "user.email=harness@local", "-c", "user.name=harness", "commit", "-qm", "init", "--allow-empty"]);
  writeFileSync(join(projectDir, "a.txt"), "harness\n");
  g(["add", "a.txt"]);
} catch (e) {
  console.error(`dev-smoke-harness: cannot seed git repo: ${e}`);
  process.exit(2);
}
console.log(`dev electron : ${electronBin}`);
console.log(`data root    : ${dataRoot}`);
console.log(`workspace    : ${workspaceRoot}`);
console.log(`evidence     : ${outDir}`);

// Inherit the host env minus anything that could switch providers or
// point the app at real credentials — same discipline as packaged smoke.
const STRIP = [
  /^TIVANO_PROVIDER/i, /^TIVANO_CODEX/i, /^TIVANO_SYNTHETIC/i,
  /^CODEX/i, /^SYNTHETIC/i, /^OPENAI/i, /^ANTHROPIC/i, /^GOOGLE_/i,
  /^AWS_/i, /^AZURE_/i, /^ELECTRON_RUN_AS_NODE/i,
];
const childEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (STRIP.some((re) => re.test(k))) continue;
  childEnv[k] = v;
}
childEnv.TIVANO_WORKSPACE_ROOT = workspaceRoot;
childEnv.TIVANO_MOCK_TICK_MS = "3";

const startedAt = new Date().toISOString();
const flow = await runSmokeFlow({
  label: "dev-harness",
  executablePath: electronBin,
  args: [ROOT, `--data-root=${dataRoot}`],
  env: childEnv,
  dataRoot,
  workspaceRoot,
  projectDir,
  outDir,
  expectPackaged: false,
  installDir: null,
  platformExpectation: "posix-open",
  expectGitReady: true,
  deadlineMs: DEADLINE_MS,
});

const ok = flow.ok;
const report = {
  schema: "tivano-dev-smoke-harness/1",
  DEV_HARNESS_ONLY: true,
  NOT_WINDOWS_VALIDATION:
    "unbundled dev Electron on " +
    `${process.platform}/${process.arch} — packaged, appData-default, install-dir and Windows gate checks are NOT exercised here`,
  startedAt,
  finishedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch },
  executablePath: electronBin,
  dataRoot,
  workspaceRoot,
  results: flow.results,
  exits: flow.exits,
  pageErrors: flow.pageErrors,
  screenshots: flow.screenshots,
  allExited: flow.allExited,
  ok,
};
writeFileSync(join(outDir, "dev-harness-smoke.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `\n${flow.results.filter((r) => r.ok).length}/${flow.results.length} checks passed — report: ${join(outDir, "dev-harness-smoke.json")}`,
);
if (ok && flow.allExited) {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
