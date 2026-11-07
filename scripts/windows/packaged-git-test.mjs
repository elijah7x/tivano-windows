#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// OFFLINE application-layer acceptance of the PACKAGED Windows Git path.
//
//   node scripts/windows/packaged-git-test.mjs
//     --exe <packaged "Tivano Windows Dev.exe">
//     --git <absolute real git.exe>
//     --launcher <absolute test-only codex-launcher.exe>
//     --evidence <fresh dir>
//     [--deadline-ms <ms>]           (default 8 min, hard cap 10 min)
//
// Runs ONLY on a real win32/x64 host — refuses before touching anything
// else. This exercises the REAL packaged chain end to end:
//
//   Electron main → GitService → tivano-job-helper.exe --run
//     → Windows Job Object → real Git for Windows git.exe
//       → read-only probe/status/diff on private metadata views
//
// against four fixture repositories built by the SAME real git.exe under
// the test's own bounded env (Unicode + spaces everywhere):
//
//   A "mixed 工作 dir": branch + staged add + staged rename + unstaged
//     modify + untracked + binary modify — full status surface + diffs.
//   B "unborn 空 repo": HEAD unborn — ready with untracked only.
//   C "detached 头": detached HEAD — ready, branch.name null.
//   D "hostile 仓库": filter/fsmonitor/hook/credential-helper configured
//     to write markers — NOTHING in the source config may ever execute.
//
// Proofs: snapshot semantics, diff sides, source .git bytes unchanged
// (index/HEAD/config/packed-refs/refs/objects hashed before+after),
// hostile helper markers absent, a poisoned user-level %HOME%/.gitconfig
// never read (sentinel helpers never run), all spawned identities owned
// (pid+creation) and observed dead — no cleanup claim without proof.
//
// NOT covered (recorded honestly): remote ops, auth, credentials,
// install/uninstall, signing, standard-user Windows.

import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { boundedClose } from "../closeBound.mjs";
import { resolveOutputDir, sha256File } from "../lib/package-plan.mjs";
import { IdentityTracker, queryWindowsProcess, sleep } from "../../tests/windows/harness-control.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const HELPER_REL = join("resources", "job-helper", "tivano-job-helper.exe");
const ASAR_REL = join("resources", "app.asar");
const ASAR_MANIFEST = "dist/job-helper-manifest.json";
const DEFAULT_DEADLINE_MS = 8 * 60_000;
const HARD_CAP_MS = 10 * 60_000;

// ---- hard gate FIRST — refuse non-Windows before ANY mutation ---------
if (process.platform !== "win32" || process.arch !== "x64") {
  console.error(
    `packaged-git-test: NOT RUN — requires a Windows x64 host ` +
      `(got ${process.platform}/${process.arch}); no state was touched`,
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const exe = flag("--exe");
const gitArg = flag("--git");
const launcherArg = flag("--launcher");
const evidence = flag("--evidence");
const deadlineMs = Number(flag("--deadline-ms") ?? DEFAULT_DEADLINE_MS);
if (
  !exe || !gitArg || !launcherArg || !evidence ||
  !isAbsolute(exe) || !isAbsolute(gitArg) || !isAbsolute(launcherArg) ||
  !Number.isSafeInteger(deadlineMs) || deadlineMs < 60_000 || deadlineMs > HARD_CAP_MS
) {
  console.error(
    "usage: packaged-git-test.mjs --exe <packaged exe> --git <absolute git.exe> --launcher <absolute codex-launcher.exe> --evidence <fresh dir> [--deadline-ms N<=600000]",
  );
  process.exit(2);
}
const exeAbs = resolve(exe);
const gitAbs = resolve(gitArg);
const launcherAbs = resolve(launcherArg);
if (basename(gitAbs).toLowerCase() !== "git.exe") {
  console.error(`packaged-git-test: --git must be an absolute .exe path: ${gitAbs}`);
  process.exit(2);
}
for (const [n, p] of [["--exe", exeAbs], ["--git", gitAbs], ["--launcher", launcherAbs]]) {
  if (!existsSync(p) || !statSync(p).isFile()) {
    console.error(`packaged-git-test: ${n} is not a real file: ${p}`);
    process.exit(2);
  }
}
const installDir = dirname(exeAbs);
let outDir;
try {
  outDir = resolveOutputDir(evidence, ROOT);
} catch (e) {
  console.error(`packaged-git-test: ${e.message ?? e}`);
  process.exit(2);
}

// ---- reporting --------------------------------------------------------
const results = [];
const pageErrors = [];
const owned = []; // app ChildProcess handles — teardown via these ONLY
const known = new Map(); // recorded pid:ticks identities
const remember = (id) => {
  if (id && Number.isSafeInteger(id.pid) && /^[1-9]\d*$/.test(id.ticks ?? ""))
    known.set(`${id.pid}:${id.ticks}`, id);
  return id;
};
const deadline = Date.now() + deadlineMs;
const left = () => Math.max(0, deadline - Date.now());
const check = (name, ok, detail = "") => {
  results.push({ name, ok: ok === true, detail: String(detail).slice(0, 600) });
  console.log(`${ok === true ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`);
};
const bounded = async (p, what) => {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`bounded wait expired: ${what}`)), Math.max(1, left()));
      }),
    ]);
  } finally { clearTimeout(timer); }
};

// ---- package/helper attestation (the SAME bytes the app trusts) --------
const helperAbs = join(installDir, HELPER_REL);
const asarAbs = join(installDir, ASAR_REL);
let pinnedManifest = null;
try {
  const req = createRequire(join(ROOT, "package.json"));
  const asar = req("@electron/asar");
  pinnedManifest = JSON.parse(
    Buffer.from(asar.extractFile(asarAbs, ASAR_MANIFEST)).toString("utf8"),
  );
} catch (e) {
  console.error(`packaged-git-test: cannot read ${ASAR_MANIFEST}: ${e.message}`);
  process.exit(2);
}
if (
  pinnedManifest?.schema !== "tivano-windows-job-helper-manifest/1" ||
  pinnedManifest.file !== "tivano-job-helper.exe" ||
  !/^[0-9a-f]{64}$/.test(pinnedManifest.sha256 ?? "")
) {
  console.error("packaged-git-test: job-helper manifest failed contract validation");
  process.exit(2);
}
if (!existsSync(helperAbs) || sha256File(helperAbs) !== pinnedManifest.sha256) {
  console.error("packaged-git-test: packaged helper missing or hash-mismatched — refusing");
  process.exit(2);
}
// The helper MUST advertise the --run exit-code channel — Git cannot run
// without it. Bounded direct call; the helper only prints diagnostics.
let versionDoc;
try {
  versionDoc = JSON.parse(
    execFileSync(helperAbs, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true }),
  );
} catch (e) {
  console.error(`packaged-git-test: helper --version failed: ${e.message}`);
  process.exit(2);
}
if (versionDoc?.runExitBase !== 1024 || versionDoc?.runExitMax !== 255) {
  console.error(
    `packaged-git-test: helper lacks the --run capability ` +
      `(${JSON.stringify(versionDoc).slice(0, 200)}) — Git cannot be exercised`,
  );
  process.exit(2);
}
console.log(`helper attested: sha256=${pinnedManifest.sha256.slice(0, 16)}… version=${pinnedManifest.helperVersion} runCapable`);

// ---- isolated task dirs — Unicode + spaces are PART of the test --------
const taskRoot = mkdtempSync(join(tmpdir(), "tivano-pkggit 测试 "));
const dataRoot = join(taskRoot, "data root");
const workRoot = join(taskRoot, "repo 根 目录");
const fakeHome = join(taskRoot, "fake home");
mkdirSync(workRoot, { recursive: true });
mkdirSync(fakeHome, { recursive: true });
const markerDir = join(taskRoot, "markers");
mkdirSync(markerDir, { recursive: true });
console.log(`taskRoot  : ${taskRoot}`);
console.log(`git exe   : ${gitAbs}`);
console.log(`dataRoot  : ${dataRoot}`);
console.log(`evidence  : ${outDir}`);

// ---- fixture construction through the REAL git.exe ---------------------
const fixtureEnv = {};
for (const k of ["SystemRoot", "windir", "TEMP", "TMP", "COMSPEC", "PATHEXT"])
  if (process.env[k] !== undefined) fixtureEnv[k] = process.env[k];
fixtureEnv.PATH = dirname(gitAbs);
fixtureEnv.HOME = fakeHome;
fixtureEnv.USERPROFILE = fakeHome;
// Fixture construction must be deterministic too: no system/global config.
fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
fixtureEnv.GIT_CONFIG_GLOBAL = join(fakeHome, "fixture-gitconfig");
writeFileSync(fixtureEnv.GIT_CONFIG_GLOBAL, "");
const git = (cwd, ...a) => {
  if (left() <= 0) throw new Error("fixture deadline exceeded");
  return execFileSync(gitAbs, ["-c", "user.email=t@t", "-c", "user.name=t",
    "-c", `core.hooksPath=${join(fakeHome, "no-hooks")}`, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...a], {
    cwd, env: fixtureEnv, encoding: "utf8", timeout: Math.max(1, Math.min(30000, left())), windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
};
// The sentinel script is invoked as `sh <script>` — Git for Windows runs
// filter/fsmonitor/credential helpers through its bundled MSYS2 bash, so
// a POSIX script is the honest hostile payload (a .cmd/.bat would never
// be reached and would test nothing). UTF-8 CJK paths are legal inside
// it; the marker target uses drive-forward-slash form bash accepts.
const hostileScript = join(markerDir, "evil-helper.sh");
const markerFile = join(markerDir, "evil-ran.txt");
const posixPath = (p) => p.replace(/\\/g, "/");
writeFileSync(
  hostileScript,
  `#!/bin/sh\necho ran >> "${posixPath(markerFile)}"\ncat\n`,
);
const sc = `sh "${posixPath(hostileScript)}"`;
// A user-level config whose ONLY effect, if read, is to run the sentinel.
writeFileSync(
  join(fakeHome, ".gitconfig"),
  `[core]\n\tfsmonitor = ${sc}\n[credential]\n\thelper = ${sc}\n[user]\n\tname = SENTINEL\n`,
);

// Hash evidence over the parts of .git the app may NEVER touch.
const hashTree = (dirAbs) => {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      const rel = relative(dirAbs, p).replace(/\\/g, "/");
      if (e.isDirectory()) { h.update(JSON.stringify(["dir", rel]) + "\n"); walk(p); }
      else if (e.isFile()) {
        const bytes = readFileSync(p);
        h.update(JSON.stringify(["file", rel, bytes.length]) + "\n"); h.update(bytes);
      } else throw new Error(`unexpected metadata entry: ${rel}`);
    }
  };
  walk(dirAbs);
  return h.digest("hex");
};
const repoHash = (repoDir) => ({
  // The index may not exist yet (unborn repository) — null is the value.
  index: existsSync(join(repoDir, ".git", "index"))
    ? sha256File(join(repoDir, ".git", "index"))
    : null,
  head: sha256File(join(repoDir, ".git", "HEAD")),
  config: sha256File(join(repoDir, ".git", "config")),
  refs: (() => {
    const refsDir = join(repoDir, ".git", "refs");
    const packed = join(repoDir, ".git", "packed-refs");
    return {
      tree: existsSync(refsDir) ? hashTree(refsDir) : null,
      packed: existsSync(packed) ? sha256File(packed) : null,
    };
  })(),
  objects: hashTree(join(repoDir, ".git", "objects")),
});
const repos = {}, before = {}, projectIds = {};
const prepareFixtures = () => {

// A: mixed state
{
  const dir = join(workRoot, "mixed 工作 dir");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  writeFileSync(join(dir, "rename-me.txt"), "renamed\n");
  writeFileSync(join(dir, "binary.bin"), Buffer.concat([Buffer.alloc(64, 1), Buffer.from("\0\0binary\0")]));
  writeFileSync(join(dir, "staged-old.txt"), "old\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  writeFileSync(join(dir, "tracked.txt"), "base\nworktree-mod\n");
  writeFileSync(join(dir, "staged-new.txt"), "new\n");
  git(dir, "add", "staged-new.txt");
  git(dir, "mv", "rename-me.txt", "renamed ü.txt");
  writeFileSync(join(dir, "untracked 名.txt"), "untracked\n");
  writeFileSync(join(dir, "binary.bin"), Buffer.concat([Buffer.alloc(96, 2), Buffer.from("\0more-binary\0")]));
  repos.mixed = dir;
}
// B: unborn
{
  const dir = join(workRoot, "unborn 空 repo");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "new.txt"), "unborn\n");
  repos.unborn = dir;
}
// C: detached
{
  const dir = join(workRoot, "detached 头");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "one");
  const sha = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "two");
  git(dir, "checkout", sha);
  repos.detached = dir;
}
// D: hostile — filter/fsmonitor/hook/credential-helper configured to RUN
// our marker writer if the app ever let source config execute.
{
  const dir = join(workRoot, "hostile 仓库");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "f.txt"), "filtered\n");
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  git(dir, "config", "filter.evil.clean", sc);
  git(dir, "config", "filter.evil.smudge", sc);
  git(dir, "config", "filter.evil.required", "true");
  git(dir, "config", "core.fsmonitor", sc);
  git(dir, "config", "credential.helper", sc);
  git(dir, "config", "core.askpass", sc);
  writeFileSync(join(dir, "f.txt"), "filtered\nworktree-mod\n"); // forces a filterable comparison
  repos.hostile = dir;
}

for (const [k, d] of Object.entries(repos)) before[k] = repoHash(d);

// ---- seed store + grants BEFORE first launch ---------------------------
{
  const projects = [];
  const userGrants = {};
  for (const [k, dir] of Object.entries(repos)) {
    const id = randomUUID();
    projectIds[k] = id;
    const canon = realpathSync(dir);
    projects.push({ id, name: `git-${k}`, createdAt: Date.now(), expanded: true, directory: canon });
    userGrants[id] = canon;
  }
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    join(dataRoot, "store.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects,
      threads: [],
      settings: { theme: "breeze", language: "en", alwaysAllow: [] },
      ui: { selectedThreadId: null },
    }),
  );
  writeFileSync(
    join(dataRoot, "workspace-grants.json"),
    JSON.stringify({ version: 1, grants: {}, userGrants }),
  );
}

};

// ---- controlled child env — provider vars deliberately MOCK ------------
const KEEP_ENV = [
  "SystemRoot", "SystemDrive", "windir", "WINDIR", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN",
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
// Pin the same Git executable used to construct the fixtures. Standard
// installation discovery is separately exercised by packaged smoke.
childEnv.Path = [dirname(gitAbs), childEnv.PATH ?? process.env.PATH ?? ""]
  .filter(Boolean)
  .join(";");
delete childEnv.PATH;
childEnv.HOME = fakeHome; // poisoned: its .gitconfig may never be read
childEnv.USERPROFILE = fakeHome;
childEnv.TIVANO_DATA_ROOT = dataRoot;
childEnv.TIVANO_GIT_EXECUTABLE = gitAbs;
// Every inherited GIT_* variable and credential was dropped.

// ---- Windows process-identity helpers (same discipline as job-test) ----
const identities = new IdentityTracker(queryWindowsProcess);
const waitAllDead = async (idents, ms) => {
  const end = Date.now() + ms;
  let last = { verdict: "unknown" };
  while (Date.now() < end) {
    last = await identities.checkIdents(idents);
    if (last.verdict === "all-dead") return { ok: true, last };
    await sleep(150);
  }
  return { ok: false, last };
};
const captureAppChildren = (id) => {
  if (!id) throw new Error("missing root identity");
  const script = `$ErrorActionPreference='Stop'; $root=Get-Process -Id ${id.pid};
    $born=$root.StartTime.ToFileTimeUtc(); if($born.ToString() -ne '${id.ticks}') {throw 'root identity changed'};
    $all=@(Get-CimInstance Win32_Process);
    $ids=@(${id.pid}); $out=@();
    for($i=0;$i -lt $ids.Count;$i++) {
      foreach($p in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] }) {
        if($ids -contains [int]$p.ProcessId){continue}
        try { $c=Get-Process -Id $p.ProcessId -ErrorAction Stop; $t=$c.StartTime.ToFileTimeUtc();
          if($t -ge $born) { $ids += [int]$p.ProcessId; $out += @{pid=[int]$p.ProcessId;ticks=$t.ToString()} }
        } catch { if($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId,*'){throw} }
      }
    }; ConvertTo-Json -InputObject @($out) -Compress`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15000, windowsHide: true });
  const ids = JSON.parse(raw.trim());
  if (!Array.isArray(ids)) throw new Error("invalid owned-child inventory");
  ids.forEach(remember);
  return ids;
};

// ---- playwright driving -------------------------------------------------
const invoke = (page, channel, payload) =>
  bounded(page.evaluate(
    ({ c, p }) => window.tivano.invoke(c, p),
    { c: channel, p: payload },
  ), channel);
const waitOverview = async (page, projectId, wantKind, ms) => {
  const end = Date.now() + Math.min(ms, left());
  let last = null;
  while (Date.now() < end) {
    last = await invoke(page, "git:overview", { projectId });
    if (last?.kind === wantKind) return last;
    if (last?.kind === "unavailable" && last.reason !== "no-snapshot") return last;
    await sleep(150);
  }
  return last;
};
const launch = async (label) => {
  if (left() <= 0) throw new Error("suite deadline exceeded before launch");
  const inst = await bounded(
    electron.launch({
      executablePath: exeAbs,
      args: [`--data-root=${dataRoot}`],
      env: childEnv,
      timeout: Math.max(1, Math.min(30000, left())),
    }),
    `${label} launch`,
  );
  const proc = inst.process();
  const owner = { label, proc, inst, mainIdentity: null, launcherIdentity: null };
  owned.push(owner);
  const launcherQuery = await queryWindowsProcess(proc.pid);
  if (launcherQuery.status !== "alive") throw new Error("launcher identity unavailable");
  owner.launcherIdentity = remember({ pid: proc.pid, ticks: launcherQuery.ticks });
  captureAppChildren(owner.launcherIdentity);
  const main = await bounded(inst.evaluate(() => ({ pid: process.pid, exe: process.execPath })), "main identity");
  if (!Number.isSafeInteger(main?.pid) || typeof main.exe !== "string" ||
      resolve(main.exe).toLowerCase() !== exeAbs.toLowerCase()) throw new Error("main identity mismatch");
  const q = await queryWindowsProcess(main.pid);
  if (q.status !== "alive") throw new Error("main creation identity unavailable");
  owner.mainIdentity = remember({ pid: main.pid, ticks: q.ticks });
  captureAppChildren(owner.mainIdentity);
  const page = await bounded(inst.firstWindow(), `${label} firstWindow`);
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.setDefaultTimeout(Math.max(1, Math.min(15000, left())));
  return { inst, proc, page, owner };
};

const startedAt = new Date().toISOString();
let fatal = null;
try {
  prepareFixtures();
  const r1 = await launch("git-run");
  const { page, proc } = r1;
  check("packaged window launched",
    await page.waitForSelector(".sidebar-head", { timeout: Math.min(20000, left()) }).then(() => true).catch(() => false));
  const ownBefore = captureAppChildren(r1.owner.mainIdentity);

  for (const [key, dir] of Object.entries(repos)) {
    if (fatal) break;
    const projectId = projectIds[key];
    const thread = await invoke(page, "threads:create", { projectId });
    if (!thread?.id) throw new Error("thread creation failed");
    await invoke(page, "threads:select", { id: thread.id });
    await invoke(page, "git:refresh", { projectId });
    const snap = await waitOverview(page, projectId, "ready", 30000);
    if (key === "mixed") {
      check("mixed repo → ready snapshot", snap?.kind === "ready",
        `kind=${snap?.kind} reason=${snap?.reason ?? ""}`);
      if (snap?.kind !== "ready") { fatal = `mixed repo not ready: ${snap?.reason}`; break; }
      check("mixed repo on branch main", snap.branch?.name === "main" && !snap.branch.detached && !snap.branch.unborn,
        `branch=${JSON.stringify(snap.branch)}`);
      const byPath = new Map(snap.entries.map((e) => [e.path, e]));
      const t = byPath.get("tracked.txt");
      check("unstaged modify visible", t && t.unstaged === "M" && !t.untracked,
        `entry=${JSON.stringify(t ?? null)}`);
      const sn = byPath.get("staged-new.txt");
      check("staged add visible", sn && sn.staged === "A", `entry=${JSON.stringify(sn ?? null)}`);
      const rn = byPath.get("renamed ü.txt");
      check("staged rename visible (unicode)", rn && rn.staged === "R" && rn.origPath === "rename-me.txt",
        `entry=${JSON.stringify(rn ?? null)}`);
      const un = byPath.get("untracked 名.txt");
      check("untracked file visible (unicode)", un && un.untracked === true,
        `entry=${JSON.stringify(un ?? null)}`);
      const bin = byPath.get("binary.bin");
      check("binary modify listed", bin && bin.unstaged === "M", `entry=${JSON.stringify(bin ?? null)}`);
      // Real diff sides through the packaged chain.
      if (t) {
        const d = await invoke(page, "git:diff", { projectId, snapshotId: snap.snapshotId, entryId: t.id, side: "worktree" });
        check("worktree text diff returned", d?.kind === "text" && d.patch?.includes("worktree-mod"),
          `kind=${d?.kind} reason=${d?.reason ?? ""}`);
      }
      if (rn) {
        const d = await invoke(page, "git:diff", { projectId, snapshotId: snap.snapshotId, entryId: rn.id, side: "staged" });
        check("staged rename diff returned", ["text", "empty"].includes(d?.kind),
          `kind=${d?.kind} reason=${d?.reason ?? ""}`);
      }
      if (bin) {
        const d = await invoke(page, "git:diff", { projectId, snapshotId: snap.snapshotId, entryId: bin.id, side: "worktree" });
        check("binary diff reported as binary", d?.kind === "binary",
          `kind=${d?.kind} reason=${d?.reason ?? ""}`);
      }
      // The panel must really render — open it once for the run.
      await page.locator('button.term-toggle[title="Git"]').click();
      const panelShown = await page.waitForSelector(".git-panel", { timeout: 8000 })
        .then(() => page.locator(".git-panel").innerText().catch(() => ""))
        .catch(() => null);
      check("git panel renders real repository content",
        typeof panelShown === "string" && panelShown.includes("main") && panelShown.includes("tracked.txt"),
        String(panelShown).slice(0, 160));
      await bounded(page.screenshot({ path: join(outDir, "git-mixed.png") }), "Git screenshot");
      await page.locator('button.term-toggle[title="Git"]').click();
    } else if (key === "unborn") {
      check("unborn repo → ready with unborn HEAD",
        snap?.kind === "ready" && snap.branch?.unborn === true,
        `kind=${snap?.kind} branch=${JSON.stringify(snap?.branch)}`);
      check("unborn repo lists untracked", snap?.entries?.some((e) => e.path === "new.txt" && e.untracked),
        `entries=${snap?.entries?.length}`);
    } else if (key === "detached") {
      check("detached repo → ready, detached HEAD",
        snap?.kind === "ready" && snap.branch?.detached === true && snap.branch?.name === null,
        `kind=${snap?.kind} branch=${JSON.stringify(snap?.branch)}`);
      check("detached repo is clean", Array.isArray(snap?.entries) && snap.entries.length === 0,
        `entries=${snap?.entries?.length}`);
    } else if (key === "hostile") {
      check("hostile repo → ready (helpers refused, never executed)",
        snap?.kind === "ready" && Array.isArray(snap?.limitations),
        `kind=${snap?.kind} reason=${snap?.reason ?? ""}`);
      check("hostile repo reports the filters limitation",
        snap?.kind === "ready" && (snap.limitations ?? []).includes("filters"),
        `limitations=${JSON.stringify(snap?.limitations)} kind=${snap?.kind}`);
      check("hostile helper marker NEVER written",
        !existsSync(markerFile), markerFile);
    }
  }

  // ---- proof: source .git bytes untouched, user config unread ----------
  if (!fatal) {
    for (const [k, d] of Object.entries(repos)) {
      const after = repoHash(d);
      check(`${k}: source .git bytes unchanged (index/HEAD/config/refs/objects)`,
        after.index === before[k].index &&
        after.head === before[k].head &&
        after.config === before[k].config &&
        after.refs.tree === before[k].refs.tree &&
        after.refs.packed === before[k].refs.packed &&
        after.objects === before[k].objects,
        `index ${after.index === before[k].index} head ${after.head === before[k].head} config ${after.config === before[k].config} refs ${after.refs.tree === before[k].refs.tree} objects ${after.objects === before[k].objects}`);
    }
    check("poisoned user HOME never executed a helper",
      !existsSync(markerFile),
      `${markerFile} ${existsSync(markerFile) ? "EXISTS — user config WAS honored" : "absent"}`);
  }

  // ---- clean close + owned-identity teardown ----------------------------
  const ownAll = [...ownBefore, ...captureAppChildren(r1.owner.mainIdentity), r1.owner.mainIdentity, r1.owner.launcherIdentity];
  const closed = await boundedClose(r1.inst, proc, { closeMs: Math.min(15000, left()), exitMs: 5000, killWaitMs: 5000 });
  const exits = [{ label: "git-run", ...closed }];
  check("packaged app exits cleanly", closed.outcome === "resolved" && closed.exited && !closed.killed && closed.exitCode === 0,
    JSON.stringify(closed).slice(0, 200));
  const dead = await waitAllDead(ownAll, 20000);
  check("every owned child identity confirmed gone", dead.ok,
    `verdict=${dead.last.verdict} tracked=${ownAll.length}`);
  writeFileSync(join(outDir, "exits.json"), JSON.stringify(exits, null, 2));
} catch (e) {
  fatal = fatal ?? String(e?.message ?? e);
}

// Cleanup uses identities captured while owned processes were alive. Its
// independent bound still runs when the suite deadline has expired.
let forcedCleanup = false;
const cleanupErrors = [];
for (const o of owned) {
  try {
    if (o.mainIdentity) {
      const q = await identities.checkIdents([o.mainIdentity]);
      if (q.verdict === "living") captureAppChildren(o.mainIdentity);
      else if (q.verdict !== "all-dead") cleanupErrors.push("main identity unknown before cleanup");
    } else cleanupErrors.push("actual main identity was never captured");
    if (o.proc.exitCode === null && o.proc.signalCode === null) {
      const close = await boundedClose(o.inst, o.proc, { closeMs: 15000, exitMs: 5000, killWaitMs: 5000 });
      forcedCleanup ||= close.killed || close.outcome !== "resolved";
    }
  } catch (e) { cleanupErrors.push(String(e)); }
}
for (const id of known.values()) {
  const state = await identities.checkIdents([id]);
  if (state.verdict === "living") {
    forcedCleanup = true;
    try {
      execFileSync(launcherAbs, ["--kill-known", String(id.pid), id.ticks], {
        timeout: 8000, stdio: "ignore", windowsHide: true,
      });
    } catch (e) { cleanupErrors.push(`identity kill failed: ${id.pid}: ${e.message}`); }
  } else if (state.verdict !== "all-dead") cleanupErrors.push(`identity unknown: ${id.pid}`);
}
const finalTree = await waitAllDead([...known.values()], 20000);
const allExited = finalTree.ok && cleanupErrors.length === 0;
check("final owned identities observed dead", allExited, JSON.stringify({ finalTree, cleanupErrors }));
check("no renderer errors", pageErrors.length === 0, pageErrors.join("; "));
check("no forced cleanup needed", !forcedCleanup);
const report = {
  windowsOnly: true,
  ranAtUtc: startedAt,
  osRelease: (await import("node:os")).release(),
  arch: process.arch,
  node: process.version,
  packagedExe: exeAbs,
  gitExe: gitAbs,
  helperSha256: pinnedManifest.sha256,
  helperVersion: versionDoc,
  fatal,
  allExited,
  forcedCleanup,
  finalTree,
  cleanupErrors,
  appIdentities: owned.map(({ label, proc, mainIdentity, launcherIdentity }) => ({ label, launcherPid: proc.pid, mainIdentity, launcherIdentity })),
  pageErrors,
  checks: results,
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  identities: [...known.values()],
};
writeFileSync(join(outDir, "packaged-git-results.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed}/${report.total} checks passed${fatal ? ` — FATAL: ${fatal}` : ""} — ${join(outDir, "packaged-git-results.json")}`);
process.exit(fatal || report.passed !== report.total ? 1 : 0);
