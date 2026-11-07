// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// terminal-harness — WINDOWS-ONLY integration harness for
// `tivano-job-helper --terminal` (ConPTY session). It REFUSES to run off
// Windows (exit 4 — never a pass). Every case drives the helper's NDJSON
// control protocol exactly like the packaged app does
// (windowsTerminalHost.ts): a TerminalSpec arrives base64url-encoded on
// argv, control messages are JSON lines on stdin, session frames are JSON
// lines on stdout, and unacknowledged data pauses output at the helper's
// 128 KiB credit bound until acks bring the debt under 32 KiB.
//
// Identity/liveness rules mirror helper-harness.mjs: real OS identity
// queries (Get-Process StartTime.ToFileTime), marker-file identities, a
// confirmed-not-found is dead, a query failure is "unknown" and never
// counts as proof, and "unknown" cleanup stops the suite.
//
// Usage:
//   node tests\windows\terminal-harness.mjs --helper D:\bin\tivano-job-helper.exe `
//     --fixture D:\bin\terminal-fixture.exe --out D:\evidence\terminal-run [--commit <sha>]
//
// Exit: 0 = every case passed; 3 = at least one failed; 4 = refused.
// "Skipped" is not a result — a case that cannot run is a FAILED case.

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IdentityTracker,
  runCaseIsolated,
  selectCases,
  sleep,
  queryWindowsProcess,
} from "./harness-control.mjs";
import {
  DIAG_ENV,
  SessionDiagnostics,
  applyDiagnosticVerdict,
  attachStdoutIngest,
  sessionReady as sessionReadyShared,
} from "./terminal-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------- arg parsing ----------------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
const CASE = args["--case"] ?? null;
const CASE_DIR = args["--dir"] ?? null;
const HELPER = args["--helper"];
const FIXTURE = args["--fixture"];
const OUT = args["--out"];
const COMMIT = args["--commit"] ?? process.env.TIVANO_SOURCE_COMMIT ?? "unknown";

if (process.platform !== "win32") {
  console.error(`terminal-harness: WINDOWS-ONLY — refusing to run on ${process.platform}`);
  process.exit(4);
}
if (!HELPER || !FIXTURE || (CASE ? !CASE_DIR : !OUT)) {
  console.error(
    "usage: terminal-harness.mjs --helper <exe> --fixture <exe> --out <dir> " +
      "[--cases <csv>] | --case <name> --dir <dir> --helper <exe> --fixture <exe>",
  );
  process.exit(4);
}
for (const [label, p] of [["helper", HELPER], ["fixture", FIXTURE]]) {
  if (!existsSync(p)) {
    console.error(`terminal-harness: ${label} not found: ${p}`);
    process.exit(4);
  }
}

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const b64spec = (spec) => Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");

// Opt-in session diagnostics — EXPLICIT, default off:
//   TIVANO_TERMINAL_DIAGNOSTICS=1
// Only then does the harness append --startup-trace to the existing
// helper invocation and create bounded evidence (raw stdout ≤256KiB,
// stderr ≤64KiB, ≤5 bounded snapshots). Protocol, assertions and every
// timeout/poll cadence are byte-identical either way.
const DIAG = process.env[DIAG_ENV] === "1";
const diagnostics = [];   // SessionDiagnostics instances, this case only
const diagErrors = [];    // bounded list applied to the verdict AFTER cleanup
let diagSeq = 0;

const winQueryImpl = queryWindowsProcess;

// The exact sterile environment the packaged product sends
// (terminalService.ts spawnMessage, win32 branch). The harness must use
// the same contract — a wider env would validate a different session.
function terminalEnv(dir) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const home = join(dir, "term-home");
  const tmp = join(home, "tmp");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  for (const path of [tmp, appData, localAppData]) mkdirSync(path, { recursive: true });
  return {
    SystemRoot: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    windir: systemRoot,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp,
    APPDATA: appData, LOCALAPPDATA: localAppData,
    TERM_PROGRAM: "Tivano", TERM: "xterm-256color", COLORTERM: "truecolor",
  };
}

function terminalSpec(dir, { cols = 80, rows = 25, ownerPid = process.pid, env, cwd } = {}) {
  return { v: 1, ownerPid, cols, rows, cwd: cwd ?? dir, env: env ?? terminalEnv(dir) };
}

// ============================ case runner ============================
const tracker = new IdentityTracker(winQueryImpl);
const markerFiles = new Set();
const launchedEvidence = [];
const sessionCaptures = [];

// Snapshot console-host identities so a teardown can prove no conhost
// remained owned by a dead session. A count is not evidence — identities
// are.
async function conhostPids() {
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'conhost.exe' -or $_.Name -eq 'OpenConsole.exe' } | ForEach-Object { @{pid=$_.ProcessId;ppid=$_.ParentProcessId;ticks=$_.CreationDate.ToFileTimeUtc().ToString();name=$_.Name -replace '\\.exe$',''} }); ConvertTo-Json -InputObject $rows -Compress",
    ], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const v = JSON.parse(out.trim() || "[]");
    const arr = Array.isArray(v) ? v : v == null ? [] : [v];
    if (arr.some((id) => !Number.isSafeInteger(id?.pid) || !/^[1-9]\d*$/.test(id?.ticks ?? ""))) return null;
    return arr;
  } catch { return null; }
}

// Spawn `helper --terminal <b64>` and expose the NDJSON session:
//   send(obj)            — one control line
//   msgs                 — every parsed frame, in order
//   output()             — concatenated decoded data payload text
//   waitType(type, ms)   — bounded wait for a frame type
//   waitData(re, ms)     — bounded wait for decoded output content
//   exit / done          — helper exit code / stdio-close promise
// Data frames are acknowledged automatically unless autoAck is false —
// without acks the helper pauses output once ~128 KiB is unacked and
// holds the session alive (the no-ACK teardown bound lives in the main
// service watchdog, not the helper); the credit case proves pause →
// stay-alive → resume-below-32KiB → completion.
function launchTerminal(spec, { autoAck = true } = {}) {
  const argv = ["--terminal", b64spec(spec)];
  if (DIAG) argv.push("--startup-trace");
  const cp = spawn(HELPER, argv, {
    env: { ...process.env, TIVANO_LEAK_SENTINEL: "must-not-reach-payload" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const h = {
    cp, autoAck,
    msgs: [], stderr: [], line: "",
    dataBytes: 0, dataText: [],
    overflowed: false, spawnError: null, malformed: [],
    exit: null, done: null, diag: null,
    send(obj) { try { cp.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* recorded via stdin error */ } },
    output() { return h.dataText.join(""); },
  };
  if (DIAG) {
    // Constructor is I/O-free by design — open failures become recorded
    // errors inside, never exceptions on the launch path.
    h.diag = new SessionDiagnostics({
      dir: CASE_DIR, pid: cp.pid, seq: ++diagSeq, caseName: CASE,
      tailsSource: () => ({ pendingLine: h.line, output: h.output() }),
    });
    diagnostics.push(h.diag);
  }
  sessionCaptures.push(h);
  const tracked = tracker.track(cp);
  const evidence = { pid: cp.pid, ticks: null, observedExit: false };
  launchedEvidence.push(evidence);
  const persist = () => writeFileSync(join(CASE_DIR, "launched.json"), JSON.stringify({ case: CASE, helpers: launchedEvidence }, null, 2));
  persist();
  cp.once("exit", () => { evidence.observedExit = true; persist(); });
  tracked.then(() => { evidence.ticks = tracker.entries.get(cp.pid)?.ticks ?? null; persist(); });
  void tracked;
  // Shared ingestion: raw Buffer chunks → persistent StringDecoder →
  // the same line/frame/data bookkeeping as before.
  attachStdoutIngest(cp, h, { send: h.send, kill: () => cp.kill("SIGKILL") });
  let stderrBytes = 0;
  cp.stderr.on("data", (d) => {
    h.diag?.feedStderr(d);
    stderrBytes += d.length;
    if (stderrBytes <= 64 * 1024) h.stderr.push(d);
    else if (!h.overflowed) { h.overflowed = true; cp.kill("SIGKILL"); }
  });
  cp.on("error", (e) => { h.spawnError = e; });
  cp.stdin.on("error", () => {});
  let codeRes;
  h.exit = new Promise((res) => { codeRes = res; });
  cp.once("exit", (code) => codeRes(code));
  h.done = new Promise((res) => {
    let code = null;
    cp.once("exit", (c) => { code = c; });
    cp.once("close", () => res(code));
  });
  return h;
}

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true, label }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

const stderrText = (h) => Buffer.concat(h.stderr).toString("utf8");

async function waitType(h, type, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = h.msgs.find((x) => x.type === type);
    if (m) return m;
    await sleep(50);
  }
  return null;
}

async function waitMsg(h, pred, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = h.msgs.find(pred);
    if (m) return m;
    await sleep(50);
  }
  return null;
}

async function waitData(h, needle, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (h.output().includes(needle)) return true;
    await sleep(60);
  }
  return false;
}

// Wait until the session is ready for input: "spawned" (the shell
// process exists inside the Job) followed by the shell prompt having
// written something — a prompt means ConPTY + the shell are genuinely
// up, not merely spawned. Same 30s/15s waits and poll cadence; stage
// boundaries are recorded when diagnostics are on.
async function sessionReady(h, ms = 30000) {
  return sessionReadyShared(h, {
    waitSpawned: (hh) => waitType(hh, "spawned", ms),
    waitPrompt: (hh) => waitData(hh, ">", 15000),
  });
}

// PowerShell line submission through ConPTY is a carriage return — the
// Enter key. Send a command and wait for a unique sentinel it prints.
async function runCommand(h, command, sentinel, ms = 30000) {
  // Split the sentinel: ConPTY echoes the typed INPUT line back to the
  // output stream, so a literal `echo TIVANO_X_DONE` would match its own
  // echo before the command ever ran. Concatenated PowerShell strings
  // keep the needle out of the echoed text while printing it verbatim.
  const half = Math.ceil(sentinel.length / 2);
  const echoExpr = `("${sentinel.slice(0, half)}" + "${sentinel.slice(half)}")`;
  h.send({ type: "input", data: Buffer.from(`${command}; echo ${echoExpr}\r`, "utf8").toString("base64") });
  return waitData(h, sentinel, ms);
}

// Marker files — the terminal fixture writes the EXTENDED identity line
// "PID:<pid>:<ticks>:INJOB:<0|1>:PARENT:<ppid>": the same pid-reuse-safe
// identity stamp as job-fixture PLUS the controlled membership query,
// atomic in one write.
function markerRecords(file) {
  markerFiles.add(file);
  if (!existsSync(file)) return { records: [], malformed: false };
  const records = [];
  const seenPids = new Set();
  let malformed = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line === "") continue;
    const m = line.match(/^PID:(\d+):(\d+):INJOB:([01]):PARENT:(\d+)$/);
    if (!m) { malformed = true; continue; }
    const pid = Number(m[1]);
    if (seenPids.has(pid)) { malformed = true; continue; }
    seenPids.add(pid);
    records.push({ pid, ticks: m[2], inJob: m[3] === "1", parent: Number(m[4]) });
  }
  return { records, malformed };
}

function markerIdents(file) {
  const r = markerRecords(file);
  return { idents: r.records.map(({ pid, ticks }) => ({ pid, ticks })), malformed: r.malformed };
}

async function waitMarkerIdents(file, n, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = markerIdents(file);
    if (r.malformed) return { idents: null, malformed: true, count: r.idents.length };
    if (r.idents.length >= n) return { idents: r.idents, malformed: false, count: r.idents.length };
    await sleep(50);
  }
  const r = markerIdents(file);
  return { idents: null, malformed: r.malformed, count: r.idents.length };
}

async function waitAllDead(idents, ms = 15000) {
  const t0 = Date.now();
  let last = { verdict: "unknown" };
  while (Date.now() - t0 < ms) {
    last = await tracker.checkIdents(idents);
    if (last.verdict === "all-dead") return last;
    await sleep(150);
  }
  return last;
}

// Fixture marker fields beyond the pid:ticks identity — INJOB and
// PARENT are what prove Job membership inside the terminal session.
function markerFields(file) {
  const r = markerRecords(file);
  if (!r.records.length || r.malformed) return null;
  const last = r.records[r.records.length - 1];
  return { INJOB: last.inJob ? "1" : "0", PARENT: String(last.parent) };
}

// Single-quoted PowerShell literal — the only unsafe char is ' itself.
const ps = (s) => `'${s.replace(/'/g, "''")}'`;

// Assert the honest end-state of a session: an exit frame, a cleanup
// frame with both independent claims, and the helper's exit class.
function endState(h) {
  return {
    exit: h.msgs.find((m) => m.type === "exit") ?? null,
    cleanup: h.msgs.find((m) => m.type === "cleanup") ?? null,
    error: h.msgs.find((m) => m.type === "error") ?? null,
    malformed: h.malformed,
  };
}

// ---------------- cases (runner-side) ----------------
const cases = {};

cases["terminal-capability-advertised"] = async () => {
  const v = JSON.parse(execFileSync(HELPER, ["--version"], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  }));
  const ok =
    Array.isArray(v.mechanisms) &&
    v.mechanisms.includes("conpty-terminal") &&
    v.mechanisms.includes("proc-thread-attr-job-list") &&
    v.terminalSpec === 1;
  return ok
    ? { pass: true, detail: `--version advertises conpty-terminal + terminalSpec=${v.terminalSpec}` }
    : { pass: false, detail: `missing terminal capability: ${JSON.stringify(v).slice(0, 240)}` };
};

cases["spawn-and-natural-shell-exit"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: `session never ready: ${JSON.stringify(endState(h)).slice(0, 240)}` };
  const spawned = h.msgs.find((m) => m.type === "spawned");
  if (!spawned || !Number.isSafeInteger(spawned.pid) || spawned.pid <= 0)
    return { pass: false, detail: "no spawned frame with a provable shell pid" };
  const shellQuery = await winQueryImpl(spawned.pid);
  if (shellQuery.status !== "alive")
    return { pass: false, detail: `spawned shell pid ${spawned.pid} not provably alive (${shellQuery.status})` };
  // Natural shell exit: `exit 7` → the shell's own code rides the exit
  // frame, cleanup claims are both true, helper exits 0.
  h.send({ type: "input", data: Buffer.from("exit 7\r", "utf8").toString("base64") });
  const ex = await waitType(h, "exit", 30000);
  const cl = await waitType(h, "cleanup", 30000);
  const code = await h.done;
  const es = endState(h);
  const ok =
    ex && ex.exitCode === 7 && ex.forced === false &&
    cl && cl.jobEmpty === true && cl.outputComplete === true &&
    code === 0 && es.malformed.length === 0;
  return ok
    ? { pass: true, detail: `shell exit 7 → exit frame (forced=false), jobEmpty+outputComplete, helper exit 0` }
    : { pass: false, detail: `exit=${JSON.stringify(ex)} cleanup=${JSON.stringify(cl)} helper=${code} malformed=${es.malformed.length}` };
};

cases["unicode-roundtrip"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // The fixture prints one deterministic UTF-8 line through the console.
  // ConPTY RE-SERIALIZES rendered cells — byte-exactness is not the
  // contract. The honest checks: the CJK BMP substring must arrive
  // intact through the UTF-8 frame path, and no U+FFFD replacement or
  // mojibake marker may appear.
  // Native status must be captured before echo overwrites $?. Split the
  // status label as well as the completion marker to exclude command echo.
  const command = `$global:LASTEXITCODE = $null; & ${ps(FIXTURE)} unicode; $uOK = $?; $uExit = $LASTEXITCODE; echo (("TIVANO_U_" + "STATUS:") + $uOK + ":" + $uExit)`;
  const completed = await runCommand(h, command, "TIVANO_U_DONE");
  h.send({ type: "input", data: Buffer.from("exit 0\r", "utf8").toString("base64") });
  const ex = await waitType(h, "exit", 30000);
  const cl = await waitType(h, "cleanup", 30000);
  const helperExit = await h.done;
  const out = h.output();
  const cjk = out.includes("中文");
  const ascii = out.includes("ascii-ok");
  const noReplacement = !out.includes("�") && !out.includes("??");
  const status = out.match(/TIVANO_U_STATUS:(True|False):(-?\d+)(?=\r?\n)/g) ?? [];
  const nativeOK = status.length === 1 && status[0] === "TIVANO_U_STATUS:True:0";
  const pass = completed && nativeOK && cjk && ascii && noReplacement &&
    ex?.exitCode === 0 && ex?.forced === false &&
    cl?.jobEmpty === true && cl?.outputComplete === true &&
    helperExit === 0 && h.malformed.length === 0;
  return { pass, detail: JSON.stringify({ completed, status, cjk, ascii, noReplacement, shellExit: ex, cleanupFrame: cl, helperExit }), cleanup: pass ? "clean" : "unknown" };
};

cases["input-echo-and-ctrl-c"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // Unique echo text proves typed input reached the shell and output
  // came back through ConPTY.
  const token = `TKN-${randomUUID().slice(0, 8)}`;
  if (!(await runCommand(h, `echo ${token}`, "TIVANO_E_DONE")))
    return { pass: false, detail: "echo command output never returned" };
  // ConPTY echoes the typed line itself — one token occurrence is just
  // the input echo; the SECOND occurrence is the command's real output.
  if (h.output().split(token).length - 1 < 2)
    return { pass: false, detail: "echoed token missing from decoded output (input echo only)" };
  // Ctrl-C (ETX) must interrupt, not kill: send a sleeping command,
  // interrupt it, then prove the SAME shell still answers.
  const before = h.output().length;
  h.send({ type: "input", data: Buffer.from("Start-Sleep -Seconds 600\r", "utf8").toString("base64") });
  await sleep(1500);
  h.send({ type: "input", data: Buffer.from("\x03", "utf8").toString("base64") });
  const token2 = `AFTER-${randomUUID().slice(0, 8)}`;
  if (!(await runCommand(h, `echo ${token2}`, "TIVANO_C_DONE", 20000)))
    return { pass: false, detail: "shell did not answer after Ctrl-C — interrupt killed the session" };
  if (h.output().slice(before).split(token2).length - 1 < 2)
    return { pass: false, detail: "post-Ctrl-C token missing" };
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const ex = await waitType(h, "exit", 30000);
  const code = await h.done;
  return ex && ex.forced === false && code === 0
    ? { pass: true, detail: "echo roundtrip + Ctrl-C interrupt, same shell survived" }
    : { pass: false, detail: `exit=${JSON.stringify(ex)} helper=${code}` };
};

cases["resize-takes-effect"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir, { cols: 80, rows: 25 }));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  h.send({ type: "resize", cols: 120, rows: 40 });
  const got = await runCommand(
    h,
    `echo "W:$([Console]::WindowWidth):E"`,
    "TIVANO_R_DONE",
    20000,
  );
  if (!got) return { pass: false, detail: "post-resize probe output never returned" };
  if (!h.output().includes("W:120:E"))
    return { pass: false, detail: `console width not 120 after resize: output tail ${JSON.stringify(h.output().slice(-400))}` };
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const code = await h.done;
  return code === 0
    ? { pass: true, detail: "resize 80x25→120x40 reflected in [Console]::WindowWidth" }
    : { pass: false, detail: `helper exit ${code}` };
};

cases["sterile-env-no-leak"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // The runner's own environment carries TIVANO_LEAK_SENTINEL. The spec
  // env replaces it entirely — the shell must see the sentinel ABSENT
  // and the spec-supplied TERM_PROGRAM present. The "no-leak" marker is a
  // split string for the same reason runCommand splits sentinels: the
  // echoed command text never contains it contiguously, so a substring
  // hit proves real command output (an exact-line anchor fails on real
  // Windows — PSReadLine emits CSI prefixes like \x1b[?25h\x1b[m between
  // the command echo and output on the same decoded line).
  const ok = await runCommand(
    h,
    `if ($env:TIVANO_LEAK_SENTINEL) { echo "LEAKED:$env:TIVANO_LEAK_SENTINEL" } else { echo ("STERILE_" + "OK") }; echo "TP:$($env:TERM_PROGRAM):E"`,
    "TIVANO_N_DONE",
  );
  if (!ok) return { pass: false, detail: "env probe output never returned" };
  const out = h.output();
  const leaked = out.includes("LEAKED:must-not-reach-payload");
  const clean = out.includes("STERILE_OK");
  const termOk = out.includes("TP:Tivano:E");
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const code = await h.done;
  return clean && !leaked && termOk && code === 0
    ? { pass: true, detail: "sentinel absent + TERM_PROGRAM=Tivano — spec env is the whole env" }
    : { pass: false, detail: `clean=${clean} leaked=${leaked} term=${termOk} exit=${code}` };
};

cases["descendant-marker-in-job"] = async ({ dir }) => {
  const marker = join(dir, "marker.txt");
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  const spawned = h.msgs.find((m) => m.type === "spawned");
  if (!spawned) return { pass: false, detail: "no spawned frame" };
  // Run the fixture synchronously inside the shell: its marker file
  // must record INJOB:1 and PARENT:<the spawned shell pid> — proof the
  // descendant ran INSIDE the session's Job under the ConPTY shell.
  if (!(await runCommand(h, `& ${ps(FIXTURE)} marker ${ps(marker)}`, "TIVANO_M_DONE")))
    return { pass: false, detail: "fixture marker command never completed" };
  const wm = await waitMarkerIdents(marker, 1, 10000);
  if (!wm.idents) return { pass: false, detail: `marker identity missing (${wm.count})` };
  const f = markerFields(marker);
  const inJob = f?.INJOB === "1";
  const parentOk = f?.PARENT === String(spawned.pid);
  // The marker-writing process already exited — that's fine, its
  // identity fields are the evidence, not its liveness.
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const code = await h.done;
  return inJob && parentOk && code === 0
    ? { pass: true, detail: `descendant marker INJOB:1 PARENT=${f.PARENT} (shell pid ${spawned.pid})` }
    : { pass: false, detail: `INJOB=${f?.INJOB} PARENT=${f?.PARENT} shell=${spawned?.pid} exit=${code}` };
};

cases["console-attachment"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  const spawned = h.msgs.find((m) => m.type === "spawned");
  if (!spawned) return { pass: false, detail: "no spawned frame" };
  // GetConsoleProcessList, run INSIDE the session: the attached set is
  // the shell + the fixture itself — the spawned shell pid MUST appear
  // and no foreign pid may share our pseudoconsole.
  if (!(await runCommand(h, `& ${ps(FIXTURE)} console`, "TIVANO_X_DONE")))
    return { pass: false, detail: "console listing never returned" };
  const pids = [...h.output().matchAll(/CONSOLE:(\d+)/g)].map((m) => Number(m[1]));
  const shellAttached = pids.includes(spawned.pid);
  const sizeOk = pids.length >= 1 && pids.length <= 8;
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const code = await h.done;
  return shellAttached && sizeOk && code === 0
    ? { pass: true, detail: `console attaches shell ${spawned.pid} (+${pids.length - 1} transient)` }
    : { pass: false, detail: `pids=${JSON.stringify(pids)} shell=${spawned.pid} exit=${code}` };
};

cases["shell-exit-with-live-descendant-forced"] = async ({ dir }) => {
  const marker = join(dir, "linger.txt");
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // Start a lingering descendant that outlives the shell, then exit the
  // shell naturally. Job non-empty at natural exit → FORCED class 6,
  // descendant actively reaped, jobEmpty proven after termination.
  // The ArgumentList string quotes the marker path itself — spaces in
  // the case dir must not split argv.
  const started = await runCommand(
    h,
    `Start-Process -FilePath ${ps(FIXTURE)} -ArgumentList 'marker-linger "${marker}" 60000' -WindowStyle Hidden`,
    "TIVANO_L_DONE",
    30000,
  );
  if (!started) return { pass: false, detail: "descendant launch command never completed" };
  const wm = await waitMarkerIdents(marker, 1, 15000);
  if (!wm.idents) return { pass: false, detail: `linger marker never appeared (${wm.count})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.verdict !== "living")
    return { pass: false, detail: `descendant not provably live (${live.verdict})` };
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const ex = await waitType(h, "exit", 30000);
  const cl = await waitType(h, "cleanup", 30000);
  const code = await h.done;
  const dead = await waitAllDead(wm.idents);
  const ok =
    ex && ex.forced === true &&
    cl && cl.jobEmpty === true &&
    code === 6 && dead.verdict === "all-dead";
  return ok
    ? { pass: true, detail: `natural shell exit + live descendant → forced reap exit 6, descendant dead` }
    : { pass: false, detail: `exit=${JSON.stringify(ex)} cleanup=${JSON.stringify(cl)} helper=${code} dead=${dead.verdict}` };
};

cases["stop-request-forces-teardown"] = async ({ dir }) => {
  const conBefore = await conhostPids();
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  const spawned = h.msgs.find((m) => m.type === "spawned");
  if (!spawned) return { pass: false, detail: "no spawned frame" };
  const shellQuery = await winQueryImpl(spawned.pid);
  if (shellQuery.status !== "alive")
    return { pass: false, detail: "shell not provably alive before stop" };
  const shellIdent = [{ pid: spawned.pid, ticks: shellQuery.ticks }];
  h.send({ type: "stop" });
  const ex = await waitType(h, "exit", 30000);
  const cl = await waitType(h, "cleanup", 30000);
  const code = await h.done;
  const dead = await waitAllDead(shellIdent, 15000);
  // Console-host observation: no NEW conhost/OpenConsole identity may
  // outlive the session teardown.
  const conAfter = await conhostPids();
  // On a busy box the system-wide snapshot catches unrelated console
  // processes the measurement itself (and other activity) spawns during
  // the window — r007/r010 leaked conhost.exe transients that died within
  // seconds. The session's console host is ConPTY's OpenConsole.exe, so
  // only NEW OpenConsole identities count as leaks; every new identity
  // is still logged for forensics.
  const conNew =
    conBefore && conAfter ? conAfter.filter((id) => !conBefore.some((old) => old.pid === id.pid && old.ticks === id.ticks)) : [];
  const conLeak = conNew.filter((id) => id.name === "OpenConsole");
  const ok =
    ex && ex.forced === true &&
    cl && cl.jobEmpty === true &&
    code === 6 && dead.verdict === "all-dead" && conBefore !== null && conAfter !== null && conLeak.length === 0;
  return ok
    ? { pass: true, detail: `stop → forced exit + jobEmpty + shell dead, conhost delta ${conLeak.length}` }
    : { pass: false, detail: `exit=${JSON.stringify(ex)} cleanup=${JSON.stringify(cl)} helper=${code} dead=${dead.verdict} conLeak=${conLeak.length} leakedIdents=${JSON.stringify(conLeak)} newIdents=${JSON.stringify(conNew)}` };
};

cases["helper-kill-reaps-session-tree"] = async ({ dir }) => {
  const marker = join(dir, "linger.txt");
  const conBefore = await conhostPids();
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  const spawned = h.msgs.find((m) => m.type === "spawned");
  const shellQuery = await winQueryImpl(spawned.pid);
  if (shellQuery.status !== "alive")
    return { pass: false, detail: "shell not provably alive before kill" };
  const started = await runCommand(
    h,
    `Start-Process -FilePath ${ps(FIXTURE)} -ArgumentList 'marker-linger "${marker}" 60000' -WindowStyle Hidden`,
    "TIVANO_K_DONE",
    30000,
  );
  if (!started) return { pass: false, detail: "descendant launch never completed" };
  const wm = await waitMarkerIdents(marker, 1, 15000);
  if (!wm.idents) return { pass: false, detail: `linger marker never appeared (${wm.count})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.verdict !== "living")
    return { pass: false, detail: "descendant not provably live" };
  // Kill OUR OWN helper child via the retained handle — TerminateProcess
  // on this identity. kill-on-close must reap shell + descendants + the
  // console host the Job held.
  h.cp.kill("SIGKILL");
  await h.done;
  const dead = await waitAllDead(
    [...wm.idents, { pid: spawned.pid, ticks: shellQuery.ticks }],
    20000,
  );
  const conAfter = await conhostPids();
  // Same attribution rule as stop-request: only NEW OpenConsole identities
  // (ConPTY hosts) count as leaks on a busy box; all new idents logged.
  const conNew = conBefore && conAfter ? conAfter.filter((id) => !conBefore.some((old) => old.pid === id.pid && old.ticks === id.ticks)) : [];
  const conLeak = conNew.filter((id) => id.name === "OpenConsole");
  return dead.verdict === "all-dead" && conBefore !== null && conAfter !== null && conLeak.length === 0
    ? { pass: true, detail: `helper killed → Job reaped shell + ${wm.idents.length} descendants + console host` }
    : { pass: false, detail: `liveness=${dead.verdict} living=${dead.living ?? []} conLeak=${conLeak.length} leakedIdents=${JSON.stringify(conLeak)} newIdents=${JSON.stringify(conNew)}` };
};

cases["owner-death-tears-down-session"] = async ({ dir }) => {
  const marker = join(dir, "linger.txt");
  const specFile = join(dir, "tspec.json");
  writeFileSync(specFile, JSON.stringify(terminalSpec(dir, { ownerPid: 1 })));
  const owner = spawn(
    process.execPath,
    [join(HERE, "terminal-owner-runner.mjs"), HELPER, specFile],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  tracker.track(owner);
  const ob = { stdout: [], stderr: [] };
  owner.stdout.on("data", (d) => ob.stdout.push(d));
  owner.stderr.on("data", (d) => ob.stderr.push(d));
  const ownerExit = new Promise((r) => owner.on("exit", (code, signal) => r({ code, signal })));
  // The owner proxies the session — drive it through the owner pipes.
  const proxy = {
    line: "", msgs: [], dataText: [],
    send: (o) => owner.stdin.write(`${JSON.stringify(o)}\n`),
    output: () => proxy.dataText.join(""),
  };
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (chunk) => {
    proxy.line += chunk;
    for (;;) {
      const nl = proxy.line.indexOf("\n");
      if (nl < 0) break;
      const raw = proxy.line.slice(0, nl);
      proxy.line = proxy.line.slice(nl + 1);
      if (raw === "" || raw.startsWith("HELPERPID:")) continue;
      try {
        const m = JSON.parse(raw);
        proxy.msgs.push(m);
        if (m.type === "data" && typeof m.data === "string") {
          proxy.dataText.push(Buffer.from(m.data, "base64").toString("utf8"));
          if (Number.isSafeInteger(m.seq)) proxy.send({ type: "ack", seq: m.seq });
        }
      } catch { /* non-frame proxy text */ }
    }
  });
  const t0 = Date.now();
  let helperPid = null;
  while (Date.now() - t0 < 30000) {
    const m = Buffer.concat(ob.stdout.map((c) => Buffer.from(c, "utf8"))).toString("utf8").match(/HELPERPID:(\d+)/);
    if (m) helperPid = Number(m[1]);
    if (helperPid && proxy.msgs.some((x) => x.type === "spawned")) break;
    await sleep(60);
  }
  if (!helperPid || !proxy.msgs.some((x) => x.type === "spawned"))
    return { pass: false, detail: `session never spawned through owner (helperPid=${helperPid})` };
  const spawned = proxy.msgs.find((x) => x.type === "spawned");
  const helperQuery = await winQueryImpl(helperPid);
  if (helperQuery.status !== "alive")
    return { pass: false, detail: "helper identity unverifiable before owner kill" };
  const shellQuery = await winQueryImpl(spawned.pid);
  if (shellQuery.status !== "alive")
    return { pass: false, detail: "shell not provably alive before owner kill" };
  owner.kill();
  const ownerExitInfo = await ownerExit;
  const dead = await waitAllDead(
    [{ pid: helperPid, ticks: helperQuery.ticks }, { pid: spawned.pid, ticks: shellQuery.ticks }],
    30000,
  );
  const ownerExited = ownerExitInfo.code !== null || ownerExitInfo.signal != null;
  return ownerExited && dead.verdict === "all-dead"
    ? { pass: true, detail: `owner exit=${JSON.stringify(ownerExitInfo)} → helper + shell reaped` }
    : { pass: false, detail: `ownerExit=${JSON.stringify(ownerExitInfo)} liveness=${dead.verdict}` };
};

cases["credit-pause-resume"] = async ({ dir }) => {
  // The REAL reachable credit contract: withheld acks pause output once
  // ~128 KiB is unacked — the session stays ALIVE (a helper must not
  // hard-fail a paused session; the no-ACK teardown bound belongs to the
  // main-service watchdog). Acks below the 32 KiB resume threshold must
  // restart output and complete the stream byte-for-byte.
  const h = launchTerminal(terminalSpec(dir), { autoAck: false });
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // ~1 MiB of output: far beyond the 128 KiB pause bound.
  h.send({
    type: "input",
    data: Buffer.from(`[Console]::Out.Write(('x' * 1048576))\r`, "utf8").toString("base64"),
  });
  // Wait until output stalls: no new data for 4s after at least some
  // arrived. The stall must land near the 128 KiB bound — never past the
  // 512 KiB hard bound — and produce no error/exit frame.
  const t0 = Date.now();
  let lastBytes = -1, quietSince = Date.now();
  while (Date.now() - t0 < 90000) {
    if (h.dataBytes !== lastBytes) { lastBytes = h.dataBytes; quietSince = Date.now(); }
    if (lastBytes > 0 && Date.now() - quietSince > 4000) break;
    if (h.msgs.some((m) => m.type === "exit" || m.type === "error")) break;
    await sleep(120);
  }
  const stalledAt = h.dataBytes;
  const sawError = h.msgs.some((m) => m.type === "error");
  const sawExit = h.msgs.some((m) => m.type === "exit");
  const helperAlive = (await bounded(h.exit, 1, "exit")).timeout === true;
  if (!(lastBytes > 0 && Date.now() - quietSince > 4000))
    return { pass: false, detail: `output never stalled — pause bound not engaging (bytes=${stalledAt})` };
  if (stalledAt > 192 * 1024)
    return { pass: false, detail: `pause bound overshot: ${stalledAt} bytes unacked` };
  if (sawError || sawExit || !helperAlive)
    return { pass: false, detail: `paused session died instead of holding: error=${sawError} exit=${sawExit}` };
  // Resume: one ack of the highest seen seq clears the whole debt —
  // then keep acking so the remaining ~900 KiB can flow past the pause
  // bound again (this session's autoAck stays off by design).
  const ackAll = () => {
    const seqs = h.msgs.filter((m) => m.type === "data").map((m) => m.seq ?? 0);
    if (seqs.length) h.send({ type: "ack", seq: Math.max(...seqs) });
  };
  const maxSeq = Math.max(0, ...h.msgs.filter((m) => m.type === "data").map((m) => m.seq ?? 0));
  if (maxSeq === 0) return { pass: false, detail: "no data seqs to ack" };
  const ackTimer = setInterval(ackAll, 100);
  h.send({ type: "ack", seq: maxSeq });
  const resumed = await waitMsg(h, (m) => m.type === "data" && m.seq > maxSeq, 30000);
  if (!resumed) {
    clearInterval(ackTimer);
    return { pass: false, detail: `ack below resume bound did not restart output (stalledAt=${stalledAt})` };
  }
  const ok = await runCommand(
    h,
    `[Console]::Out.Write("CREDIT_DONE_${randomUUID().slice(0, 8)}")`,
    "CREDIT_DONE",
    60000,
  );
  clearInterval(ackTimer);
  const tail = h.output().includes("CREDIT_DONE");
  h.send({ type: "stop" });
  const ex = await waitType(h, "exit", 30000);
  const cl = await waitType(h, "cleanup", 30000);
  const code = await h.done;
  const complete = ok && tail && ex && ex.forced === true && cl?.jobEmpty === true && code === 6;
  return complete
    ? { pass: true, detail: `paused at ${stalledAt}B unacked → held alive → resumed on ack → completed (${h.dataBytes}B total)` }
    : { pass: false, detail: `resume/exit broken: ok=${ok} tail=${tail} exit=${JSON.stringify(ex)} cleanup=${JSON.stringify(cl)} helper=${code}` };
};

cases["breakaway-stays-contained"] = async ({ dir }) => {
  const marker = join(dir, "bk.txt");
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // The Job is created WITHOUT JOB_OBJECT_LIMIT_BREAKAWAY_OK: a real
  // CREATE_BREAKAWAY_FROM_JOB attempt must be DENIED at the API. If it
  // were honoured, the escaped child's own INJOB marker would read 0.
  if (!(await runCommand(h, `& ${ps(FIXTURE)} breakaway ${ps(marker)}`, "TIVANO_BK_DONE", 30000)))
    return { pass: false, detail: "breakaway probe never completed" };
  const out = h.output();
  const denied = out.includes("BREAKAWAY:DENIED:");
  const allowed = out.includes("BREAKAWAY:ALLOWED");
  if (!denied && !allowed)
    return { pass: false, detail: "breakaway attempt produced no verdict" };
  // If creation went through, the child's marker is the containment
  // verdict — INJOB must still be 1 (allowed-but-still-in-job is NOT a
  // containment failure; INJOB:0 would be an escape).
  if (allowed) {
    const wm = await waitMarkerIdents(marker, 1, 10000);
    const f = wm.idents ? markerFields(marker) : null;
    if (!f || f.INJOB !== "1")
      return { pass: false, detail: `breakaway child escaped: INJOB=${f?.INJOB}` };
  }
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const code = await h.done;
  return denied && code === 0
    ? { pass: true, detail: `CREATE_BREAKAWAY_FROM_JOB denied — containment intact` }
    : allowed && code === 0
      ? { pass: true, detail: "breakaway allowed but child remained in Job (INJOB:1)" }
      : { pass: false, detail: `denied=${denied} allowed=${allowed} exit=${code}` };
};

cases["explicit-pause-resume"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // A deliberate pause must stop data frames without ending the
  // session; resume must restart them and the stream completes.
  const pausedBefore = h.dataBytes;
  h.send({ type: "pause" });
  h.send({
    type: "input",
    data: Buffer.from(`[Console]::Out.Write(('p' * 262144))\r`, "utf8").toString("base64"),
  });
  // Observe 4 quiet seconds — output must not flow while paused (slack
  // covers only prompt/redraw frames already queued pre-pause).
  let grew = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (h.dataBytes > pausedBefore + 32768) { grew = true; break; }
    await sleep(120);
  }
  const err = h.msgs.some((m) => m.type === "error");
  const exd = h.msgs.some((m) => m.type === "exit");
  if (grew || err || exd)
    return { pass: false, detail: `pause leaked output or killed session: grew=${grew} err=${err} exit=${exd}` };
  h.send({ type: "resume" });
  const resumed = await waitMsg(h, (m) => m.type === "data" && h.dataBytes > pausedBefore, 30000);
  if (!resumed) return { pass: false, detail: "resume never restarted output" };
  const ok = await runCommand(h, `echo PAUSE-${randomUUID().slice(0, 6)}`, "TIVANO_P_DONE", 60000);
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const code = await h.done;
  return ok && code === 0
    ? { pass: true, detail: `explicit pause held 4s, resume completed stream (${h.dataBytes}B)` }
    : { pass: false, detail: `resume/exit broken: ok=${ok} helper=${code}` };
};

cases["stdout-stall-forces-teardown"] = async ({ dir }) => {
  // The OWNER stops reading the helper's stdout: the writer pump blocks
  // and the 15s stall watchdog must force the session down — class 6.
  // The frames the helper tried to send are never the assertion channel
  // here; the exit class and bounded death are.
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  const spawned = h.msgs.find((message) => message.type === "spawned");
  const shell = spawned ? await winQueryImpl(spawned.pid) : { status: "unknown" };
  if (shell.status !== "alive") return { pass: false, detail: "shell identity missing before stdout stall" };
  const shellId = { pid: spawned.pid, ticks: shell.ticks };
  h.cp.stdout.pause();  // stop consuming — OS pipe fills, writer blocks
  h.send({
    type: "input",
    data: Buffer.from(`[Console]::Out.Write(('s' * 1048576))\r`, "utf8").toString("base64"),
  });
  const t0 = Date.now();
  // 'exit' fires on process death regardless of the paused stdio pipe;
  // 'close' could wait for a pipe nobody reads.
  const code = await bounded(h.exit, 120000, "stall-teardown");
  h.cp.stdout.resume();  // drain residue for evidence collection
  if (code.timeout)
    return { pass: false, detail: `blocked stdout did NOT force teardown within 120s (${Date.now() - t0}ms)` };
  const dead = await waitAllDead([shellId], 15000);
  return [4, 6].includes(code.value) && dead.verdict === "all-dead"
    ? { pass: true, detail: `unread stdout → bounded failure class ${code.value}, shell identity dead; output/protocol completeness is not claimed (${Date.now() - t0}ms)` }
    : { pass: false, detail: `helper exit=${code.value}, shell=${dead.verdict} (want bounded failure 4/6 and proven death)` };
};

cases["input-overflow-fails-closed"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // Park the shell in a long sleep so ConPTY input backs up, then push
  // more input than the 256 KiB pending bound — input-overflow is a
  // protocol failure, forced teardown, class 6.
  h.send({ type: "input", data: Buffer.from("Start-Sleep -Seconds 300\r", "utf8").toString("base64") });
  await sleep(800);
  // ~1.1 MiB of input: beyond anything a console input queue absorbs —
  // either the pending bound trips (input-overflow) or the writer's
  // blocked WriteFile trips the 15s stall watchdog (input-stall).
  const blob = "i".repeat(48 * 1024);
  for (let i = 0; i < 24; i++)
    h.send({ type: "input", data: Buffer.from(blob, "utf8").toString("base64") });
  const err = await waitMsg(h, (m) => m.type === "error", 60000);
  const ex = await waitType(h, "exit", 30000);
  const code = await h.done;
  const ok = err && (err.code === "input-overflow" || err.code === "input-stall") && ex && ex.forced === true && code === 6;
  return ok
    ? { pass: true, detail: `input flood beyond bound → ${err.code} + forced exit 6` }
    : { pass: false, detail: `error=${JSON.stringify(err)} exit=${JSON.stringify(ex)} helper=${code}` };
};

cases["large-output-acked-flows-complete"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // Bulk output through the credit window WITH acks: every frame flows,
  // output lands byte-complete, natural exit stays clean. 256 KiB is 2×
  // the 128 KiB credit window. ConPTY serializes SCREEN DIFFS, not bytes —
  // a ~10-char raw Console.Write token adjacent to a flood can be lost or
  // split by diff coalescing (proven r013-r015: flood serialized complete,
  // tail/sentinel writes lost or non-contiguous). The tail marker goes
  // through echo line-output — line writes serialize reliably (the
  // TIVANO_B_DONE sentinel survives the same stream).
  const tailToken = `TAIL-${randomUUID().slice(0, 8)}`;
  const ok = await runCommand(
    h,
    `[Console]::Out.Write(('y' * 262144)); echo ("${tailToken.slice(0, 5)}" + "${tailToken.slice(5)}")`,
    "TIVANO_B_DONE",
    120000,
  );
  if (!ok) return { pass: false, detail: `bulk output stalled: ${h.dataBytes} bytes received` };
  // The echoed command text never contains the contiguous tail token —
  // only the real concatenated output does.
  if (!h.output().includes(tailToken))
    return { pass: false, detail: "bulk tail marker missing — output truncated" };
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const ex = await waitType(h, "exit", 30000);
  const cl = await waitType(h, "cleanup", 30000);
  const code = await h.done;
  return ex && ex.forced === false && cl?.outputComplete === true && code === 0 && h.dataBytes > 256 * 1024
    ? { pass: true, detail: `${h.dataBytes} bytes flowed under acks, outputComplete` }
    : { pass: false, detail: `exit=${JSON.stringify(ex)} cleanup=${JSON.stringify(cl)} helper=${code} bytes=${h.dataBytes}` };
};

cases["protocol-violation-fails-closed"] = async ({ dir }) => {
  const h = launchTerminal(terminalSpec(dir));
  if (!(await sessionReady(h)))
    return { pass: false, detail: "session never ready" };
  // An unknown control message type is a protocol violation: the helper
  // must fail closed, never guess.
  h.send({ type: "nonsense-frame" });
  const err = await waitType(h, "error", 15000);
  const ex = await waitType(h, "exit", 30000);
  const code = await h.done;
  return err && ex && code === 6
    ? { pass: true, detail: `unknown frame → error + forced exit 6` }
    : { pass: false, detail: `error=${JSON.stringify(err)} exit=${JSON.stringify(ex)} helper=${code}` };
};

cases["spec-rejections"] = async ({ dir }) => {
  const good = terminalSpec(dir);
  const trials = [
    ["bad-json", "not-json-at-all!!!", 2],
    ["wrong-version", { ...good, v: 99 }, 2],
    ["cols-low", { ...good, cols: 1 }, 2],
    ["cols-high", { ...good, cols: 501 }, 2],
    ["rows-high", { ...good, rows: 201 }, 2],
    ["relative-cwd", { ...good, cwd: "relative\\dir" }, 2],
    ["env-equals-key", { ...good, env: { "BAD=KEY": "1" } }, 2],
    ["owner-not-parent", { ...good, ownerPid: process.ppid }, null], // spawn-failed + class 3
    ["missing-cwd", { ...good, cwd: "D:\\definitely\\missing\\tivano-nope" }, null], // spawn failure → 5
  ];
  const fails = [];
  for (const [name, spec, want] of trials) {
    const b64 = typeof spec === "string" ? spec : b64spec(spec);
    const h = launchTerminalRaw(b64);
    const code = await bounded(h.done, 30000, name);
    const c = code.timeout ? "timeout" : code.value;
    if (want !== null && c !== want) fails.push(`${name}: exit=${c} want ${want}`);
    if (want === null && !(typeof c === "number" && c >= 2 && c <= 6))
      fails.push(`${name}: exit=${c} want helper class 2..6`);
    else if (want === null) {
      // The failure must be HONEST: a spawn-failed frame on stdout,
      // never a silent session.
      if (!h.msgs.some((m) => m.type === "spawn-failed") && name === "owner-not-parent")
        fails.push(`${name}: no spawn-failed evidence`);
    }
  }
  return fails.length
    ? { pass: false, detail: fails.join("; ") }
    : { pass: true, detail: `${trials.length} spec rejections all fail closed` };
};

// Minimal launcher for rejection cases (no session interaction needed).
function launchTerminalRaw(specB64) {
  const cp = spawn(HELPER, ["--terminal", specB64], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  tracker.track(cp);
  const h = { cp, msgs: [], line: "", done: null };
  cp.stdout.setEncoding("utf8");
  cp.stdout.on("data", (chunk) => {
    h.line += chunk;
    for (;;) {
      const nl = h.line.indexOf("\n");
      if (nl < 0) break;
      const raw = h.line.slice(0, nl);
      h.line = h.line.slice(nl + 1);
      if (!raw) continue;
      try { h.msgs.push(JSON.parse(raw)); } catch { /* ignore */ }
    }
  });
  cp.stderr.resume();
  h.done = new Promise((res) => {
    let code = null;
    cp.once("exit", (c) => { code = c; });
    cp.once("close", () => res(code));
  });
  return h;
}

cases["input-before-spawn-queued-bounded"] = async ({ dir }) => {
  // The control reader is up BEFORE the shell. Input arriving early is
  // queued (bounded by kInputPendingMax) and delivered once the ConPTY
  // input path exists — honest delivery, never silent loss, never a
  // violation. The product never sends this (the adapter drops it), but
  // the helper's contract is exercised end-to-end here.
  const h = launchTerminal(terminalSpec(dir));
  const token = `PRE-${randomUUID().slice(0, 8)}`;
  // Write input IMMEDIATELY — before "spawned" can arrive.
  h.send({ type: "input", data: Buffer.from(`echo ${token}\r`, "utf8").toString("base64") });
  const spawned = await waitType(h, "spawned", 30000);
  if (!spawned) return { pass: false, detail: "session never spawned" };
  // The queued echo must land after the shell comes up: one occurrence
  // is the input echo, the second is the command's real output — wait
  // specifically for TWO so echo-alone can't satisfy the check.
  const t1 = Date.now();
  let delivered = false;
  while (Date.now() - t1 < 45000) {
    if (h.output().split(token).length - 1 >= 2) { delivered = true; break; }
    await sleep(60);
  }
  if (!delivered)
    return { pass: false, detail: "pre-spawn input never executed by the shell — lost or echo-only" };
  h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
  const ex = await waitType(h, "exit", 30000);
  const code = await h.done;
  return ex && ex.forced === false && code === 0
    ? { pass: true, detail: "pre-spawn input queued bounded, delivered, clean exit" }
    : { pass: false, detail: `exit=${JSON.stringify(ex)} helper=${code}` };
};

cases["duplicate-ready-then-repeated-sessions"] = async ({ dir }) => {
  // Five independent sessions in a row: each spawns, echoes, exits
  // cleanly. Proves repeated create/teardown leaves nothing behind.
  for (let i = 0; i < 5; i++) {
    const h = launchTerminal(terminalSpec(dir));
    if (!(await sessionReady(h)))
      return { pass: false, detail: `cycle ${i}: session never ready` };
    const token = `CYC-${i}-${randomUUID().slice(0, 6)}`;
    if (!(await runCommand(h, `echo ${token}`, `TIVANO_DONE_${i}`, 30000)))
      return { pass: false, detail: `cycle ${i}: command never completed` };
    h.send({ type: "input", data: Buffer.from("exit\r", "utf8").toString("base64") });
    const ex = await waitType(h, "exit", 30000);
    const cl = await waitType(h, "cleanup", 30000);
    const code = await h.done;
    if (!(ex && ex.forced === false && cl?.jobEmpty === true && code === 0))
      return { pass: false, detail: `cycle ${i}: exit=${JSON.stringify(ex)} cleanup=${JSON.stringify(cl)} helper=${code}` };
  }
  return { pass: true, detail: "5 session cycles, all clean exit 0 with proven cleanup" };
};

// ---------------- runner entry ----------------
if (CASE) {
  const dir = CASE_DIR ?? join(process.cwd(), `case-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  let res;
  try {
    res = await cases[CASE]({ dir });
  } catch (e) {
    res = { pass: false, detail: `exception: ${e?.message ?? e}` };
  } finally {
    try {
      writeFileSync(
        join(dir, "launched.json"),
        JSON.stringify({ case: CASE, helpers: launchedEvidence }, null, 2),
      );
    } catch { res = { pass: false, detail: "launch evidence could not be saved", cleanup: "unknown" }; }
    const td = await tracker.teardown();
    for (const marker of markerFiles) {
      const recorded = markerIdents(marker);
      const gone = recorded.malformed ? { verdict: "unknown" } : await waitAllDead(recorded.idents, 10000);
      if (gone.verdict !== "all-dead")
        res = { pass: false, detail: `${res?.detail ?? ""}; marker tree cleanup ${gone.verdict}`, cleanup: "unknown" };
    }
    if (td.killed.length)
      res = { pass: false, detail: `${res?.detail ?? ""}; unexpected rescue of helpers: ${td.killed}`, cleanup: "unknown" };
    if (td.unknown.length)
      res = { pass: false, detail: `${res?.detail ?? ""} + teardown unknown: ${td.unknown}`, cleanup: "unknown" };
    else if (!res)
      res = { pass: false, detail: "no result" };
    // Diagnostics finish AFTER the original cleanup verdicts: the final
    // snapshot records post-cleanup state; write/close errors can never
    // escape before teardown or the RESULT line.
    for (const diag of diagnostics) {
      try {
        for (const e of await diag.finalize()) {
          if (diagErrors.length < 8) diagErrors.push(e);
        }
      } catch (e) {
        if (diagErrors.length < 8) diagErrors.push(`finalize:${e?.message ?? e}`);
      }
    }
  }
  if (sessionCaptures.some((session) => session.overflowed || session.malformed.length))
    res = { pass: false, detail: `${res?.detail ?? ""}; malformed or over-limit native capture`, cleanup: "unknown" };
  // Diagnostic failures force failure — appended to the ORIGINAL
  // detail, never an upgrade, never before teardown.
  if (diagErrors.length) res = applyDiagnosticVerdict(res, diagErrors.slice(0, 8));
  if (!res.cleanup) res.cleanup = res.pass ? "clean" : "unknown";
  console.log(`RESULT:${JSON.stringify(res)}`);
  process.exit(res.pass ? 0 : 1);
}

// ---------------- orchestrator ----------------
// Precondition: the helper must answer --version WITH the ConPTY
// terminal contract before ANY case runs — a missing capability is a
// failed precondition, not a skipped suite.
let helperVersion;
try {
  const out = execFileSync(HELPER, ["--version"], { encoding: "utf8", timeout: 10000 });
  helperVersion = JSON.parse(out);
  if (
    !helperVersion.helper ||
    helperVersion.terminalSpec !== 1 ||
    !Array.isArray(helperVersion.mechanisms) ||
    !helperVersion.mechanisms.includes("conpty-terminal")
  ) throw new Error("terminal capability not advertised");
} catch (e) {
  console.error(`terminal-harness: --version precondition failed: ${e?.message ?? e}`);
  process.exit(4);
}
mkdirSync(OUT, { recursive: true });

const CASE_LIST = [
  ["terminal-capability-advertised", 15000],
  ["spawn-and-natural-shell-exit", 90000],
  ["unicode-roundtrip", 90000],
  ["input-echo-and-ctrl-c", 90000],
  ["resize-takes-effect", 90000],
  ["sterile-env-no-leak", 90000],
  ["descendant-marker-in-job", 90000],
  ["console-attachment", 90000],
  ["shell-exit-with-live-descendant-forced", 120000],
  ["stop-request-forces-teardown", 90000],
  ["helper-kill-reaps-session-tree", 120000],
  ["owner-death-tears-down-session", 120000],
  ["credit-pause-resume", 180000],
  ["explicit-pause-resume", 120000],
  ["stdout-stall-forces-teardown", 150000],
  ["input-overflow-fails-closed", 120000],
  ["breakaway-stays-contained", 90000],
  ["large-output-acked-flows-complete", 180000],
  ["protocol-violation-fails-closed", 90000],
  ["spec-rejections", 180000],
  ["input-before-spawn-queued-bounded", 90000],
  ["duplicate-ready-then-repeated-sessions", 300000],
];

// Exact diagnostic selection: `--cases input-echo-and-ctrl-c[,name…]`
// runs ONLY the named cases through the same runCaseIsolated path and
// timeouts. Absent = full list. A flag with no value, an empty list or
// an unknown name refuses the run entirely (exit 4) — never a no-op
// pass. Selection order follows CASE_LIST, not argv.
const HAS_CASES = process.argv.includes("--cases");
let RUN_LIST;
try {
  RUN_LIST = selectCases(CASE_LIST, HAS_CASES ? (args["--cases"] ?? "") : null);
} catch (e) {
  console.error(`terminal-harness: ${e?.message ?? e}`);
  process.exit(4);
}

const results = [];
const suiteDeadline = Date.now() + 30 * 60 * 1000;
for (const [name, timeoutMs] of RUN_LIST) {
  if (suiteDeadline - Date.now() < timeoutMs + 5000) {
    results.push({ name, pass: false, detail: "not enough suite time for the complete case and cleanup bound" });
    break;
  }
  const dir = join(OUT, `case-${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const res = await runCaseIsolated({
    nodeExe: process.execPath,
    harnessPath: fileURLToPath(import.meta.url),
    name,
    dir,
    timeoutMs,
    extraArgs: ["--helper", HELPER, "--fixture", FIXTURE],
  });
  results.push({ name, pass: !!res.pass, detail: res.detail ?? "", cleanup: res.cleanup ?? "unknown", ms: res.ms, evidence: res.evidence ?? null });
  console.log(`${res.pass ? "PASS" : "FAIL"} ${name} — ${res.detail ?? ""}`.slice(0, 300));
  if (!res.pass || res.timedOut || res.cleanup !== "clean") {
    results.push({ name: "—", pass: false, detail: "suite stopped: prior case failed or cleanup unverified" });
    break;
  }
}

const report = {
  windowsOnly: true,
  mode: "terminal",
  ranAtUtc: new Date().toISOString(),
  osRelease: (await import("node:os")).release(),
  arch: process.arch,
  node: process.version,
  helperExe: HELPER,
  helperSha256: sha256(HELPER),
  helperVersion,
  fixtureExe: FIXTURE,
  fixtureSha256: sha256(FIXTURE),
  sourceCommit: COMMIT,
  selectedCases: HAS_CASES ? RUN_LIST.map(([n]) => n) : null,
  cases: results,
  passed: results.filter((r) => r.pass).length,
  total: results.length,
};
writeFileSync(join(OUT, "terminal-harness-results.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed}/${report.total} cases passed — ${join(OUT, "terminal-harness-results.json")}`);
process.exit(report.passed === report.total ? 0 : 3);
