#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// OFFLINE application-layer acceptance of the PACKAGED Windows terminal
// path — the VALIDATION-CANDIDATE build only.
//
//   node scripts/windows/packaged-terminal-test.mjs
//     --exe <packaged "Tivano Windows Dev.exe">   (a --terminal-candidate build)
//     --fixture <absolute terminal-fixture.exe>
//     --launcher <absolute codex-launcher.exe>
//     --evidence <fresh dir>
//     [--deadline-ms <ms>]           (default 8 min, hard cap 10 min)
//
// Runs ONLY on a real win32/x64 host — refuses before touching anything
// else. This exercises the REAL packaged chain end to end:
//
//   Electron main → TerminalService (candidate gate + shared packaged
//     helper attestation) → windowsTerminalHost →
//     tivano-job-helper.exe --terminal → ConPTY + Windows Job Object →
//     fixed system powershell.exe
//
// Proofs — through the SAME IPC surface the renderer uses, nothing else:
//   · state:get reports info.terminalCandidate === true (the bundle was
//     compiled with --terminal-candidate; a non-candidate package is
//     REFUSED here, never probed into a "maybe").
//   · terminals:create yields a real session: terminal-state events
//     running→exited, a provable shell pid, output arriving as
//     seq-ordered terminal-data events the test acknowledges like the
//     renderer does.
//   · A fixture descendant run inside the session proves Job membership
//     (INJOB:1) and PARENT == the reported shell pid.
//   · UTF-8 CJK text round-trips without replacement characters.
//   · resize takes effect on the real console.
//   · terminals:close tears down the whole Job — shell, helper and
//     descendants provably dead by creation-stamp identity.
//   · Killing the app mid-session reaps the Job (kill-on-close) — every
//     recorded identity gone.
//   · No new console-host identity survives session teardown.
//
// NOT covered (recorded honestly): provider auth, install/uninstall,
// signing, standard-user Windows, remote ops.
//
// Exit: 0 every check passed · 2 refused (bad args / not a candidate /
// attestation failed) · 3 NOT RUN (not win32/x64) · 4 a check failed or
// cleanup could not be proven.

import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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
    `packaged-terminal-test: NOT RUN — requires a Windows x64 host ` +
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
const fixtureArg = flag("--fixture");
const launcherArg = flag("--launcher");
const evidence = flag("--evidence");
const deadlineMs = Number(flag("--deadline-ms") ?? DEFAULT_DEADLINE_MS);
if (
  !exe || !fixtureArg || !launcherArg || !evidence ||
  !isAbsolute(exe) || !isAbsolute(fixtureArg) || !isAbsolute(launcherArg) ||
  !Number.isSafeInteger(deadlineMs) || deadlineMs < 60_000 || deadlineMs > HARD_CAP_MS
) {
  console.error(
    "usage: packaged-terminal-test.mjs --exe <candidate packaged exe> --fixture <terminal-fixture.exe> --launcher <codex-launcher.exe> --evidence <fresh dir> [--deadline-ms N<=600000]",
  );
  process.exit(2);
}
const exeAbs = resolve(exe);
const fixtureAbs = resolve(fixtureArg);
const launcherAbs = resolve(launcherArg);
for (const [n, p] of [["--exe", exeAbs], ["--fixture", fixtureAbs], ["--launcher", launcherAbs]]) {
  if (!existsSync(p) || !statSync(p).isFile()) {
    console.error(`packaged-terminal-test: ${n} is not a real file: ${p}`);
    process.exit(2);
  }
}
const installDir = dirname(exeAbs);
let outDir;
try {
  outDir = resolveOutputDir(evidence, ROOT);
} catch (e) {
  console.error(`packaged-terminal-test: ${e.message ?? e}`);
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
  console.error(`packaged-terminal-test: cannot read ${ASAR_MANIFEST}: ${e.message}`);
  process.exit(2);
}
if (
  pinnedManifest?.schema !== "tivano-windows-job-helper-manifest/1" ||
  pinnedManifest.file !== "tivano-job-helper.exe" ||
  !/^[0-9a-f]{64}$/.test(pinnedManifest.sha256 ?? "")
) {
  console.error("packaged-terminal-test: job-helper manifest failed contract validation");
  process.exit(2);
}
if (!existsSync(helperAbs) || sha256File(helperAbs) !== pinnedManifest.sha256) {
  console.error("packaged-terminal-test: packaged helper missing or hash-mismatched — refusing");
  process.exit(2);
}
// The helper MUST advertise the ConPTY terminal contract — the packaged
// terminal cannot run without it. Bounded direct call; diagnostics only.
let versionDoc;
try {
  versionDoc = JSON.parse(
    execFileSync(helperAbs, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true }),
  );
} catch (e) {
  console.error(`packaged-terminal-test: helper --version failed: ${e.message}`);
  process.exit(2);
}
if (
  versionDoc?.terminalSpec !== 1 ||
  !Array.isArray(versionDoc?.mechanisms) ||
  !versionDoc.mechanisms.includes("conpty-terminal") ||
  !versionDoc.mechanisms.includes("proc-thread-attr-job-list")
) {
  console.error(
    `packaged-terminal-test: helper lacks the ConPTY terminal contract ` +
      `(${JSON.stringify(versionDoc).slice(0, 200)}) — refusing`,
  );
  process.exit(2);
}
console.log(`helper attested: sha256=${pinnedManifest.sha256.slice(0, 16)}… version=${pinnedManifest.helperVersion} conpty-terminal`);

// ---- isolated task dirs — Unicode + spaces are PART of the test --------
const taskRoot = mkdtempSync(join(tmpdir(), "tivano-pkgterm 测试 "));
const dataRoot = join(taskRoot, "data root");
const workDir = join(taskRoot, "工作 目录 project");
const fakeHome = join(taskRoot, "fake home");
mkdirSync(workDir, { recursive: true });
mkdirSync(fakeHome, { recursive: true });
mkdirSync(dataRoot, { recursive: true });
const markerDir = join(taskRoot, "markers");
mkdirSync(markerDir, { recursive: true });
console.log(`taskRoot  : ${taskRoot}`);
console.log(`workDir   : ${workDir}`);
console.log(`evidence  : ${outDir}`);

// ---- seed store + grant BEFORE first launch ---------------------------
const projectId = randomUUID();
const workCanon = realpathSync(workDir);
writeFileSync(
  join(dataRoot, "store.json"),
  JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: projectId, name: "term-工作", createdAt: Date.now(), expanded: true, directory: workCanon }],
    threads: [],
    settings: { theme: "breeze", language: "en", alwaysAllow: [] },
    ui: { selectedThreadId: null },
  }),
);
writeFileSync(
  join(dataRoot, "workspace-grants.json"),
  JSON.stringify({ version: 1, grants: {}, userGrants: { [projectId]: workCanon } }),
);

// ---- controlled child env ----------------------------------------------
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
childEnv.HOME = fakeHome;
childEnv.USERPROFILE = fakeHome;
childEnv.TIVANO_DATA_ROOT = dataRoot;
// Deliberately ABSENT: any TIVANO_* terminal switch. The candidate gate
// is compile-time only — nothing in the environment may mint it.

// ---- Windows process-identity helpers (same discipline as git-test) ----
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
const conhostPids = () => {
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $rows=@(Get-Process -Name conhost,OpenConsole -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id;ticks=$_.StartTime.ToFileTimeUtc().ToString()} }); ConvertTo-Json -InputObject $rows -Compress",
    ], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const v = JSON.parse(out.trim() || "[]");
    const arr = Array.isArray(v) ? v : v == null ? [] : [v];
    if (arr.some((id) => !Number.isSafeInteger(id?.pid) || !/^[1-9]\d*$/.test(id?.ticks ?? ""))) return null;
    return arr;
  } catch { return null; }
};

// Fixture marker records: "PID:<pid>:<ticks>:INJOB:<0|1>:PARENT:<ppid>".
const markerRecords = (file) => {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^PID:(\d+):(\d+):INJOB:([01]):PARENT:(\d+)$/);
    if (!line.trim()) continue;
    if (!m) throw new Error("malformed fixture identity marker");
    out.push({ pid: Number(m[1]), ticks: m[2], inJob: m[3] === "1", parent: Number(m[4]) });
  }
  return out;
};

// ---- playwright driving -------------------------------------------------
const invoke = (page, channel, payload) =>
  bounded(page.evaluate(
    ({ c, p }) => window.tivano.invoke(c, p),
    { c: channel, p: payload },
  ), channel);

// In-page event collector: every AppEvent lands on window.__tivanoEvents;
// terminal-data events are ACKED by the page immediately, exactly like
// the renderer (the helper's credit bound hard-fails an unacked session).
const installCollector = (page) =>
  page.evaluate(() => {
    window.__tivanoEvents = [];
    window.__tivanoEventsDropped = 0;
    window.__tivanoEventBytes = 0;
    window.tivano.onEvent((e) => {
      const bytes = JSON.stringify(e).length;
      if (window.__tivanoEvents.length >= 2048 || window.__tivanoEventBytes + bytes > 1024 * 1024) {
        window.__tivanoEventsDropped += 1;
        return;
      }
      window.__tivanoEventBytes += bytes;
      window.__tivanoEvents.push(e);
      if (e?.type === "terminal-data" && window.__tivanoTermAck) {
        window.tivano.invoke("terminals:ack", {
          terminalId: e.terminalId, incarnation: e.incarnation, seq: e.seq,
        }).catch(() => { window.__tivanoEventsDropped += 1; });
      }
    });
  });
const drainEvents = (page) =>
  page.evaluate(() => {
    const out = window.__tivanoEvents ?? [];
    window.__tivanoEvents = [];
    window.__tivanoEventBytes = 0;
    return out;
  });
const enableAck = (page, on) =>
  page.evaluate((v) => { window.__tivanoTermAck = v; }, on);

// Collected terminal view accumulated from drained events.
const termView = { state: null, pid: null, exitCode: null, text: "", seq: 0, incarnation: null };
const feed = (events, terminalId) => {
  for (const e of events) {
    if (e?.type === "terminal-state" && e.terminal?.id === terminalId) {
      termView.state = e.terminal.state;
      if (Number.isSafeInteger(e.terminal.pid)) termView.pid = e.terminal.pid;
      if (Number.isSafeInteger(e.terminal.exitCode)) termView.exitCode = e.terminal.exitCode;
      termView.incarnation = e.terminal.incarnation ?? termView.incarnation;
    }
    if (e?.type === "terminal-data" && e.terminalId === terminalId) {
      if (!Number.isSafeInteger(e.seq) || e.seq !== termView.seq + 1)
        throw new Error("terminal output sequence gap or duplicate");
      termView.seq = e.seq;
      termView.text = (termView.text + String(e.data ?? "")).slice(-65536);
    }
  }
};
const pumpUntil = async (page, terminalId, pred, ms, label) => {
  const end = Date.now() + Math.min(ms, left());
  while (Date.now() < end) {
    feed(await drainEvents(page), terminalId);
    if (pred(termView)) return true;
    await sleep(120);
  }
  return false;
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
  await installCollector(page);
  return { inst, proc, page, owner };
};

// PowerShell line submission through ConPTY is a carriage return.
const typeCommand = (page, terminalId, incarnation, command) =>
  invoke(page, "terminals:input", {
    terminalId, incarnation, data: `${command}\r`,
  });

const psq = (s) => `'${s.replace(/'/g, "''")}'`;
const outputToken = (token) => `Write-Output (${psq(token.slice(0, 5))} + ${psq(token.slice(5))})`;

const startedAt = new Date().toISOString();
let fatal = null;
try {
  const r1 = await launch("terminal-run");
  const { page } = r1;
  check("packaged window launched",
    await page.waitForSelector(".sidebar-head", { timeout: Math.min(20000, left()) }).then(() => true).catch(() => false));

  // -- candidate identity ------------------------------------------------
  const snap0 = await invoke(page, "state:get", {});
  const isCandidate = snap0?.info?.terminalCandidate === true;
  check("AppInfo reports terminalCandidate", isCandidate,
    isCandidate ? "info.terminalCandidate === true" : `info=${JSON.stringify(snap0?.info).slice(0, 200)}`);
  if (!isCandidate) throw new Error("packaged build is NOT a terminal candidate — refusing (build with --terminal-candidate)");

  // -- bind a thread inside the granted project --------------------------
  const thread = await invoke(page, "threads:create", { projectId });
  if (!thread?.id) throw new Error("threads:create failed");
  check("thread bound", true, thread.id.slice(0, 8));
  await invoke(page, "threads:select", { id: thread.id });

  // -- session 1: create → running → typed commands -----------------------
  const conBefore1 = await conhostPids();
  const created = await invoke(page, "terminals:create", { threadId: thread.id, cols: 80, rows: 25 });
  const term = created?.terminal;
  check("terminals:create yields session", !!term && !created?.unavailable,
    term ? `id=${term.id.slice(0, 8)} state=${term.state}` : `unavailable=${created?.unavailable}`);
  if (!term) throw new Error("terminals:create returned no session");
  await enableAck(page, true);

  const running = await pumpUntil(page, term.id, (v) => v.state === "running", 30000, "running");
  check("session reaches running with shell pid", running && Number.isSafeInteger(termView.pid),
    `state=${termView.state} pid=${termView.pid}`);
  if (!running) throw new Error("session never reached running");
  const shellIdent = { pid: termView.pid, ticks: (await queryWindowsProcess(termView.pid)).ticks };
  check("shell pid provably alive", /^[1-9]\d*$/.test(shellIdent.ticks ?? ""), `pid=${shellIdent.pid}`);
  remember(shellIdent);

  // Prompt evidence: PowerShell writes a prompt once ConPTY+shell are up.
  const promptSeen = await pumpUntil(page, term.id, (v) => v.text.includes(">"), 20000, "prompt");
  check("shell prompt observed", promptSeen, `seq=${termView.seq}`);

  // Marker descendant — INJOB:1 + PARENT == the reported shell pid.
  const marker1 = join(markerDir, "term1.txt");
  await typeCommand(page, term.id, termView.incarnation,
    `& ${psq(fixtureAbs)} marker ${psq(marker1)}; ${outputToken("TERM_M_DONE")}`);
  const markerSeen = await pumpUntil(page, term.id, (v) => v.text.includes("TERM_M_DONE"), 30000, "marker");
  const recs = markerRecords(marker1);
  const inJob = recs.length > 0 && recs[recs.length - 1].inJob === true;
  const parentOk = recs.length > 0 && recs[recs.length - 1].parent === termView.pid;
  check("descendant marker proves Job membership", markerSeen && inJob && parentOk,
    `INJOB=${recs.at(-1)?.inJob} PARENT=${recs.at(-1)?.parent} shell=${termView.pid}`);

  // UTF-8 CJK round-trip.
  await typeCommand(page, term.id, termView.incarnation,
    `& ${psq(fixtureAbs)} unicode; ${outputToken("TERM_U_DONE")}`);
  const uDone = await pumpUntil(page, term.id, (v) => v.text.includes("TERM_U_DONE"), 30000, "unicode");
  const cjk = termView.text.includes("中文") && !termView.text.includes("�");
  check("UTF-8 CJK round-trip", uDone && cjk, `cjk=${cjk}`);

  // resize → console width follows.
  await invoke(page, "terminals:resize", {
    terminalId: term.id, incarnation: termView.incarnation, cols: 120, rows: 40,
  });
  await typeCommand(page, term.id, termView.incarnation,
    `echo "W:$([Console]::WindowWidth):E"; ${outputToken("TERM_R_DONE")}`);
  const rDone = await pumpUntil(page, term.id, (v) => v.text.includes("TERM_R_DONE"), 30000, "resize");
  const wOk = termView.text.includes("W:120:E");
  check("resize reflected in console", rDone && wOk, wOk ? "W:120:E" : "width not 120");

  captureAppChildren(r1.owner.mainIdentity);
  await page.locator('button.term-toggle[title="Terminal"]').click();
  await page.waitForSelector(".term-panel .xterm-screen");
  await bounded(page.screenshot({ path: join(outDir, "windows-terminal.png") }), "terminal screenshot");
  await page.locator('button.term-toggle[title="Terminal"]').click();

  // Natural shell exit → exitCode surfaces, state exited.
  await typeCommand(page, term.id, termView.incarnation, "exit 7");
  const exited = await pumpUntil(page, term.id, (v) => v.state === "exited", 30000, "exited");
  check("shell exit reported", exited && termView.exitCode === 7,
    `state=${termView.state} exitCode=${termView.exitCode}`);
  const dead1 = await waitAllDead([shellIdent], 15000);
  check("shell identity gone after exit", dead1.ok,
    dead1.ok ? "all-dead" : `verdict=${dead1.last.verdict}`);
  const conAfter1 = await conhostPids();
  const conLeak1 = conBefore1 && conAfter1 ? conAfter1.filter((id) => !conBefore1.some((old) => old.pid === id.pid && old.ticks === id.ticks)) : [];
  check("no console-host leak", conBefore1 !== null && conAfter1 !== null && conLeak1.length === 0,
    conBefore1 === null || conAfter1 === null ? "query unknown" : `delta=${conLeak1.length}`);

  // -- session 2: restart path on the same thread -------------------------
  const created2 = await invoke(page, "terminals:create", { threadId: thread.id, cols: 90, rows: 30 });
  const term2 = created2?.terminal;
  check("second session created", !!term2, term2 ? `id=${term2.id.slice(0, 8)}` : `unavailable=${created2?.unavailable}`);
  if (term2) {
    termView.state = null; termView.pid = null; termView.exitCode = null;
    termView.text = ""; termView.seq = 0; termView.incarnation = null;
    const running2 = await pumpUntil(page, term2.id, (v) => v.state === "running", 30000, "running-2");
    check("second session running", running2, `state=${termView.state}`);
    const shell2 = running2 ? { pid: termView.pid, ticks: (await queryWindowsProcess(termView.pid)).ticks } : null;
    if (shell2) remember(shell2);
    captureAppChildren(r1.owner.mainIdentity);
    // Close via the real close path — the Job must be proven empty.
    await invoke(page, "terminals:close", { terminalId: term2.id });
    const closed2 = await pumpUntil(page, term2.id, (v) => v.state === "exited" || v.state === "closing", 20000, "closed-2");
    const dead2 = shell2 ? await waitAllDead([shell2], 20000) : { ok: false, last: { verdict: "no-ident" } };
    check("terminals:close reaps session Job", closed2 && dead2.ok,
      `closed=${closed2} liveness=${dead2.last.verdict}`);
  }

  // -- kill the app mid-session: kill-on-close reaps everything -----------
  const created3 = await invoke(page, "terminals:create", { threadId: thread.id, cols: 80, rows: 25 });
  const term3 = created3?.terminal;
  let shell3 = null;
  if (term3) {
    termView.state = null; termView.pid = null; termView.exitCode = null;
    termView.text = ""; termView.seq = 0; termView.incarnation = null;
    if (await pumpUntil(page, term3.id, (v) => v.state === "running", 30000, "running-3")) {
      const q = await queryWindowsProcess(termView.pid);
      shell3 = { pid: termView.pid, ticks: q.ticks };
      remember(shell3);
      // A lingering descendant inside the Job — its marker file is the
      // identity record; wait for it BEFORE the kill or the descendant
      // can never be accounted for.
      const marker3 = join(markerDir, "term3.txt");
      await typeCommand(page, term3.id, termView.incarnation,
        `Start-Process -FilePath ${psq(fixtureAbs)} -ArgumentList 'marker-linger "${marker3}" 60000' -WindowStyle Hidden; ${outputToken("TERM_K_DONE")}`);
      await pumpUntil(page, term3.id, (v) => v.text.includes("TERM_K_DONE"), 30000, "linger");
      const markerEnd = Date.now() + Math.min(15000, left());
      while (markerRecords(marker3).length === 0 && Date.now() < markerEnd) await sleep(150);
    }
  }
  const childrenBeforeKill = await captureAppChildren(r1.owner.mainIdentity);
  const identSet = [shell3, ...childrenBeforeKill].filter(Boolean);
  const lingerRecs = markerRecords(join(markerDir, "term3.txt"));
  const linger = lingerRecs.at(-1);
  if (!term3 || !shell3 || !linger || !linger.inJob || linger.parent !== shell3.pid)
    throw new Error("crash test did not establish the active terminal and descendant");
  const lingerId = remember({ pid: linger.pid, ticks: linger.ticks });
  const liveCrashTargets = await identities.checkIdents([shell3, lingerId]);
  if (liveCrashTargets.verdict !== "living" || liveCrashTargets.unknown !== 0 || liveCrashTargets.living.length !== 2)
    throw new Error("both crash targets must be observed alive with matching identities");
  identSet.push(lingerId);
  check("session-3 tree identified", true, `idents=${identSet.length}`);
  check("event capture remained bounded without errors", await page.evaluate(() => window.__tivanoEventsDropped === 0));
  // Killing the MAIN process must orphan nothing: the helper watches its
  // owner (the actual parent) and force-tears-down the session Job.
  const mainId = r1.owner.mainIdentity;
  const mainNow = await queryWindowsProcess(mainId.pid);
  if (mainNow.status !== "alive" || mainNow.ticks !== mainId.ticks)
    throw new Error("actual Electron main identity changed before crash test");
  execFileSync(launcherAbs, ["--kill-known", String(mainId.pid), mainId.ticks], {
    timeout: 8000, windowsHide: true, stdio: "pipe",
  });
  await sleep(1000);
  const dead3 = await waitAllDead(identSet, 30000);
  check("app kill → Job reaps shell+helper+descendant", dead3.ok,
    dead3.ok ? `all-dead (${identSet.length} identities)` : `verdict=${dead3.last.verdict} living=${dead3.last.living ?? []}`);
} catch (e) {
  fatal = e;
  check("suite", false, `fatal: ${e?.message ?? e}`);
}

// ---- teardown: every owned app child must be provably gone ---------------
const cleanupErrors = [];
let forcedCleanup = false;
for (const o of owned) {
  try {
    if (o.mainIdentity) {
      const current = await identities.checkIdents([o.mainIdentity]);
      if (current.verdict === "living") captureAppChildren(o.mainIdentity);
      else if (current.verdict !== "all-dead") cleanupErrors.push("main identity unknown");
    } else cleanupErrors.push("main identity never captured");
    if (o.proc.exitCode === null && o.proc.signalCode === null) {
      const closed = await boundedClose(o.inst, o.proc, { closeMs: 10000, exitMs: 5000, killWaitMs: 5000 });
      forcedCleanup ||= closed.killed || closed.outcome !== "resolved";
      if (!closed.exited) cleanupErrors.push("launcher exit not observed");
    }
  } catch (error) { cleanupErrors.push(String(error)); }
}
for (const id of known.values()) {
  const current = await identities.checkIdents([id]);
  if (current.verdict === "living") {
    forcedCleanup = true;
    try {
      execFileSync(launcherAbs, ["--kill-known", String(id.pid), id.ticks], {
        timeout: 8000, windowsHide: true, stdio: "pipe",
      });
    } catch (error) { cleanupErrors.push(`identity rescue failed: ${String(error)}`); }
  } else if (current.verdict !== "all-dead") cleanupErrors.push(`identity unknown: ${id.pid}`);
}
const finalTree = await waitAllDead([...known.values()], 20000);
const allExited = finalTree.ok && cleanupErrors.length === 0;
check("all recorded app-owned identities dead", allExited, JSON.stringify({ finalTree, cleanupErrors }));
check("no unplanned rescue cleanup", !forcedCleanup);
check("no renderer errors", pageErrors.length === 0, pageErrors.join("; "));

const report = {
  windowsOnly: true,
  mode: "packaged-terminal",
  ranAtUtc: startedAt,
  finishedAtUtc: new Date().toISOString(),
  fatal: fatal ? String(fatal?.message ?? fatal) : null,
  helperExe: helperAbs,
  helperSha256: pinnedManifest.sha256,
  helperVersion: versionDoc,
  fixtureExe: fixtureAbs,
  launcherExe: launcherAbs,
  identities: [...known.values()],
  appIdentities: owned.map(({ label, proc, mainIdentity, launcherIdentity }) => ({ label, launcherPid: proc.pid, mainIdentity, launcherIdentity })),
  allExited,
  forcedCleanup,
  finalTree,
  cleanupErrors,
  checks: results,
  pageErrors,
  passed: results.filter((r) => r.ok).length,
  total: results.length,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "packaged-terminal-report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed}/${report.total} checks passed — ${join(outDir, "packaged-terminal-report.json")}`);
process.exit(report.passed === report.total && !fatal ? 0 : 4);
