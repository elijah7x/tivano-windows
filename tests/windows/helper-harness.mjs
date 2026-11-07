// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// helper-harness — WINDOWS-ONLY integration harness for tivano-job-helper.
// It REFUSES to run off Windows (exit 4 — never a pass), records the exact
// build/architecture/Node/commit evidence, runs every case in an ISOLATED
// child runner under a hard outer watchdog (a timeout KILLS the runner and
// waits for the observed death — nothing keeps spawning into the next
// case), and kills only identities it verified still-ours via the retained
// ChildProcess handles. Liveness is a real OS identity query
// (Get-Process StartTime.ToFileTime()): confirmed-not-found is dead, a
// QUERY FAILURE is "unknown" and never counts as proof — and "unknown"
// cleanup stops the remaining suite.
//
// Descendant identities come from marker files: every fixture process
// writes "PID:<pid>:<FILETIME-quadpart>" at start; the harness compares
// the STAMP it recorded — not a fresh pid lookup — so a reused pid can
// never masquerade as one of ours.
//
// Usage:
//   node tests\windows\helper-harness.mjs --helper D:\bin\tivano-job-helper.exe `
//     --fixture D:\bin\job-fixture.exe --out D:\evidence\helper-run [--commit <sha>]
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
  sleep,
  queryWindowsProcess,
} from "./harness-control.mjs";

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
  console.error(`helper-harness: WINDOWS-ONLY — refusing to run on ${process.platform}`);
  process.exit(4);
}
if (!HELPER || !FIXTURE || (CASE ? !CASE_DIR : !OUT)) {
  console.error(
    "usage: helper-harness.mjs --helper <exe> --fixture <exe> --out <dir> " +
      "| --case <name> --dir <dir> --helper <exe> --fixture <exe>",
  );
  process.exit(4);
}
for (const [label, p] of [["helper", HELPER], ["fixture", FIXTURE]]) {
  if (!existsSync(p)) {
    console.error(`helper-harness: ${label} not found: ${p}`);
    process.exit(4);
  }
}

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const b64spec = (spec) => Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");

// ---------------- process identity / liveness ----------------
// THREE states: {alive,ticks} | {not-found} | {unknown}. The stamp is the
// process's OWN creation FILETIME (StartTime.ToFileTime) — identical
// representation to what fixture markers record (GetProcessTimes), so a
// marker line and a live query compare 1:1, including pid-reuse.
const winQueryImpl = queryWindowsProcess;

// ============================ case runner ============================
// Inside a --case invocation we ARE the isolated runner: run one case,
// emit exactly one RESULT line, tear down our own tracked processes.
const tracker = new IdentityTracker(winQueryImpl);
const markerFiles = new Set();
const launchedEvidence = []; // every helper child + its launch-time stamp

function launchHelper(specB64, mode = "--serve") {
  const cp = spawn(HELPER, [mode, specB64], {
    env: { ...process.env, TIVANO_LEAK_SENTINEL: "must-not-reach-payload" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const h = {
    cp,
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    overflowed: false,
    spawnError: null,
    stdinError: null,
    exit: null,
    done: null,
  };
  // Track BEFORE attaching output plumbing: the exit listener lands
  // before the identity query resolves — no mid-query identity adoption.
  const tracked = tracker.track(cp);
  const evidence = { pid: cp.pid, argsSpecBytes: specB64.length, ticks: null, observedExit: false };
  launchedEvidence.push(evidence);
  const persist = () => writeFileSync(join(CASE_DIR, "launched.json"), JSON.stringify({ case: CASE, helpers: launchedEvidence }, null, 2));
  persist();
  cp.once("exit", () => { evidence.observedExit = true; persist(); });
  tracked.then(() => { evidence.ticks = tracker.entries.get(cp.pid)?.ticks ?? null; persist(); });
  void tracked;
  cp.stdout.on("data", (d) => {
    if (h.stdoutBytes > 16 * 1024 * 1024) { h.overflowed = true; return; }
    h.stdoutBytes += d.length;
    h.stdout.push(d);
  });
  cp.stderr.on("data", (d) => {
    if (h.stderrBytes > 16 * 1024 * 1024) { h.overflowed = true; return; }
    h.stderrBytes += d.length;
    h.stderr.push(d);
  });
  cp.on("error", (e) => { h.spawnError = e; });
  // EPIPE writing to a dying helper is expected — record it, never crash.
  cp.stdin.on("error", (e) => { h.stdinError = e; });
  let codeRes;
  h.exit = new Promise((res) => { codeRes = res; });
  cp.once("exit", (code) => codeRes(code));
  // "done" = stdio fully closed too — drain proof, not just exit.
  h.done = new Promise((res) => {
    let code = null;
    cp.once("exit", (c) => { code = c; });
    cp.once("close", () => res(code));
  });
  return h;
}

// Await a promise under a bound. On timeout we do NOT pretend a result —
// the caller decides the failure semantics.
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true, label }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

const stdoutBuf = (h) => Buffer.concat(h.stdout);
const stderrText = (h) => Buffer.concat(h.stderr).toString("utf8");

// Marker files ARE the readiness AND identity signal: each fixture
// process writes "PID:<pid>:<filetime-quadpart>" at start. Parse to
// verified {pid,ticks} idents — duplicates, partial lines or malformed
// content is NOT readiness, it is a hard failure signal.
function markerIdents(file) {
  markerFiles.add(file);
  if (!existsSync(file)) return { idents: [], malformed: false };
  const idents = [];
  const seenPids = new Set();
  let malformed = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line === "") continue;
    const m = line.match(/^PID:(\d+):(\d+)$/);
    if (!m) { malformed = true; continue; }
    const pid = Number(m[1]);
    if (seenPids.has(pid)) { malformed = true; continue; }
    seenPids.add(pid);
    idents.push({ pid, ticks: m[2] });
  }
  return { idents, malformed };
}

// Wait for >= n VALID marker entries, bounded — never a fixed sleep,
// never a pass on empty or malformed content.
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

// Bounded polling: wait until every ident is provably dead, or fail with
// the last verdict. A reused pid (ticks mismatch) counts as dead — it is
// a DIFFERENT process. "unknown" is retried until the bound; the final
// unknown is reported, never converted to dead.
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

async function waitStdout(h, pred, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(stdoutBuf(h).toString("utf8"))) return true;
    await sleep(50);
  }
  return false;
}

function specFor(fixtureArgs, { env = {}, cwd, ownerPid = process.pid } = {}) {
  return {
    v: 1,
    ownerPid,
    executable: FIXTURE,
    args: fixtureArgs,
    cwd: cwd ?? process.cwd(),
    env,
  };
}

// ---------------- cases (runner-side) ----------------
const cases = {};

cases["roundtrip-echo"] = async () => {
  const h = launchHelper(b64spec(specFor(["echo"], { env: { ONLY_MINE: "1" } })));
  h.cp.stdin.write("ping-12345\n");
  const seen = await waitStdout(h, (s) => s.includes("ping-12345"));
  if (!seen) return { pass: false, detail: "echo bytes never returned" };
  h.cp.stdin.end();
  const code = await h.done;
  if (h.overflowed) return { pass: false, detail: "output overflowed capture" };
  return code === 0
    ? { pass: true, detail: "echo roundtrip + drained + job-empty exit 0" }
    : { pass: false, detail: `helper exit ${code}` };
};

cases["quoting-args"] = async () => {
  const tricky = ["", "a b", 'a"b', "trail\\", "\\\\", "&|%<>^", "参数-ü", "two  spaces"];
  const h = launchHelper(b64spec(specFor(["args", ...tricky])));
  const code = await h.done;
  const lines = stdoutBuf(h).toString("utf8").trim().split(/\r?\n/);
  const ok =
    code === 0 &&
    lines.length === tricky.length &&
    tricky.every((a, i) => lines[i] === `ARG${i}=${a}`);
  return ok
    ? { pass: true, detail: `${tricky.length} args round-tripped exactly` }
    : { pass: false, detail: `exit=${code} lines=${JSON.stringify(lines).slice(0, 200)}` };
};

cases["unicode-cwd-and-path"] = async ({ dir }) => {
  const uniDir = join(dir, "工作 目录 ü");
  mkdirSync(uniDir, { recursive: true });
  const uniExe = join(uniDir, "job fixture ü.exe");
  writeFileSync(uniExe, readFileSync(FIXTURE));
  const h = launchHelper(b64spec({
    ...specFor(["cwd"]),
    executable: uniExe,
    cwd: uniDir,
  }));
  const code = await h.done;
  const printed = stdoutBuf(h).toString("utf8").trim();
  const same =
    printed.localeCompare(uniDir, undefined, { sensitivity: "accent" }) === 0 ||
    printed.toLowerCase() === uniDir.toLowerCase();
  return code === 0 && same
    ? { pass: true, detail: "unicode exe path + actual unicode cwd verified" }
    : { pass: false, detail: `exit=${code} cwd=${JSON.stringify(printed)}` };
};

cases["env-isolation-utf8-exact"] = async () => {
  const env = { AAAA_ONLY: "1", UNICODE_VAL: "值-测试" };
  const h = launchHelper(b64spec(specFor(["getenv", "UNICODE_VAL"], { env })));
  const code = await h.done;
  const got = stdoutBuf(h);
  const expect = Buffer.from("值-测试\n", "utf8");
  return code === 0 && got.equals(expect)
    ? { pass: true, detail: "UTF-8 env value byte-exact" }
    : { pass: false, detail: `exit=${code} got=${JSON.stringify(got.toString("utf8"))}` };
};

cases["env-sentinel-absent"] = async () => {
  // The runner environment carries the sentinel; the spec env does NOT.
  // The payload environment is built from the spec ONLY — an inherited
  // sentinel would prove env leakage from the helper process.
  const env = { SOMETHING_ELSE: "1" };
  const h = launchHelper(b64spec(specFor(["getenv", "TIVANO_LEAK_SENTINEL"], { env })));
  const code = await h.done;
  const got = stdoutBuf(h).toString("utf8");
  return code === 0 && got === "<absent>\n"
    ? { pass: true, detail: "sentinel absent — no env inheritance" }
    : { pass: false, detail: `exit=${code} got=${JSON.stringify(got)}` };
};

cases["env-order-block"] = async () => {
  // Windows ordinal-ignore-case env ordering — the tricky corner is "_"
  // (0x5F) sorting AFTER letters. envraw prints the delivered block order;
  // the expected order is ALPHA < BETA < _Z (uppercase ordinal).
  const env = { _Z: "z", BETA: "b", alpha: "a" };
  const h = launchHelper(b64spec(specFor(["envraw"], { env })));
  const code = await h.done;
  const lines = stdoutBuf(h).toString("utf8").split(/\r?\n/).filter((l) => l !== "");
  const keys = lines.map((l) => l.split("=")[0].toUpperCase());
  const idx = { A: keys.indexOf("ALPHA"), B: keys.indexOf("BETA"), Z: keys.indexOf("_Z") };
  const ordered = idx.A !== -1 && idx.B !== -1 && idx.Z !== -1 && idx.A < idx.B && idx.B < idx.Z;
  return code === 0 && ordered
    ? { pass: true, detail: `delivered env order ${keys.join(",")} — _Z after letters` }
    : { pass: false, detail: `exit=${code} order=${keys.join(",")}` };
};

cases["exact-output-tails"] = async () => {
  // Byte-exact tail checks on BOTH streams: the last bytes must arrive
  // unmodified — a truncation or a pump-swap would corrupt the tail.
  const N = 256 * 1024;
  const h = launchHelper(b64spec(specFor(["flood", String(N)])));
  const code = await h.done;
  const out = stdoutBuf(h);
  const err = Buffer.concat(h.stderr);
  const tailOk =
    out.length === N &&
    err.length === N &&
    out.subarray(out.length - 256).equals(Buffer.alloc(256, "x")) &&
    err.subarray(err.length - 256).equals(Buffer.alloc(256, "x"));
  return code === 0 && tailOk
    ? { pass: true, detail: "stdout+stderr tails byte-exact (256B each)" }
    : { pass: false, detail: `exit=${code} out=${out.length} err=${err.length} tailOk=${tailOk}` };
};

cases["spec-rejections-no-marker"] = async ({ dir }) => {
  const marker = join(dir, "never-ran.txt");
  const payloads = [
    ["garbage-not-b64!!!", "non-base64url", 2],
    [b64spec({ hello: 1 }), "wrong shape", 2],
    [b64spec({ ...specFor(["args"]), v: 2 }), "wrong version", 2],
    [b64spec({ ...specFor(["args"]), ownerPid: 0 }), "ownerPid zero", 2],
    [b64spec((() => { const { ownerPid, ...rest } = specFor(["args"]); return rest; })()), "no ownerPid", 2],
    [b64spec({ ...specFor(["marker", marker]), executable: "D:\\x.bat" }), ".bat refused", 2],
    [b64spec({ ...specFor(["marker", marker]), executable: "payload.exe" }), "relative exe", 2],
    [b64spec({ ...specFor(["marker", marker]), cwd: "rel\\dir" }), "relative cwd", 2],
    [b64spec({ ...specFor(["marker", marker, "a\u0000b"]) }), "arg with NUL", 2],
    [b64spec({ ...specFor(["args"]), args: ["x".repeat(9000)] }), "oversized arg", 2],
    [b64spec({ ...specFor(["args"]), env: { "BAD=KEY": "v" } }), "env key with =", 2],
    [b64spec({ ...specFor(["args"]), env: { A: "1", a: "2" } }), "env case-dup", 2],
    [b64spec({ ...specFor(["args"]), extra: 1 }), "unknown field", 2],
    // Owner-identity rejections are exit 3 — verified before any payload.
    [b64spec({ ...specFor(["marker", marker]), ownerPid: 999999 }), "dead owner pid", 3],
  ];
  const fails = [];
  for (const [b64, label, want] of payloads) {
    const h = launchHelper(b64);
    const code = await h.done;
    if (code !== want) fails.push(`${label}: exit=${code} want=${want}`);
    if (stdoutBuf(h).length > 0) fails.push(`${label}: stdout polluted`);
    if (h.spawnError) fails.push(`${label}: spawn error ${h.spawnError.message}`);
  }
  if (fails.length) return { pass: false, detail: fails.join("; ").slice(0, 300) };
  if (existsSync(marker))
    return { pass: false, detail: "a rejected spec still produced the marker" };
  return { pass: true, detail: `${payloads.length} bad specs refused, zero payload runs` };
};

cases["unrelated-owner-rejected"] = async ({ dir }) => {
  const marker = join(dir, "owner-fake.txt");
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  tracker.track(unrelated);
  const h = launchHelper(b64spec(
    specFor(["marker", marker], { ownerPid: unrelated.pid }),
  ));
  const code = await h.done;
  unrelated.kill();
  if (code !== 3)
    return { pass: false, detail: `unrelated owner accepted: exit=${code}` };
  if (existsSync(marker))
    return { pass: false, detail: "payload ran despite wrong owner" };
  return { pass: true, detail: "live but unrelated ownerPid refused pre-launch" };
};

cases["dead-owner-id-rejected"] = async ({ dir }) => {
  // A real child has been observed closed before its pid is supplied.
  // This proves rejection of a dead owner id, not an unobservable race
  // between the actual parent's exit and CreateProcess.
  const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const ownerPid = deadOwner.pid;
  await new Promise((resolve, reject) => { deadOwner.once("close", resolve); deadOwner.once("error", reject); });
  const marker = join(dir, "dead-owner-marker.txt");
  const h = launchHelper(b64spec(specFor(["marker", marker], { ownerPid })));
  const code = await h.done;
  return { pass: code === 3 && !existsSync(marker), detail: `dead owner id rejected before payload: exit=${code}, marker=${existsSync(marker)}` };
};

cases["duplicate-field-rejection"] = async () => {
  const raw = `{"v":1,"v":1,"ownerPid":${process.pid},"executable":"${FIXTURE.replace(/\\/g, "\\\\")}","args":[],"cwd":"${process.cwd().replace(/\\/g, "\\\\")}","env":{}}`;
  const h = launchHelper(Buffer.from(raw, "utf8").toString("base64url"));
  const code = await h.done;
  return code === 2
    ? { pass: true, detail: "duplicate top-level field refused before any child" }
    : { pass: false, detail: `exit=${code}` };
};

cases["payload-nonzero"] = async () => {
  const h = launchHelper(b64spec(specFor(["exit", "42"])));
  const code = await h.done;
  const ok = code === 6 && stderrText(h).includes("payload-exit=42");
  return ok
    ? { pass: true, detail: "payload exit 42 surfaced unambiguously (helper exit 6)" }
    : { pass: false, detail: `exit=${code} stderr=${stderrText(h).slice(0, 120)}` };
};

cases["spawn-failure"] = async () => {
  const h = launchHelper(b64spec({
    ...specFor(["x"]),
    executable: "D:\\definitely\\missing\\nope.exe",
  }));
  const code = await h.done;
  return code === 5
    ? { pass: true, detail: "missing executable → exit 5, payload never ran" }
    : { pass: false, detail: `exit=${code}` };
};

cases["concurrent-stdio-backpressure"] = async () => {
  const N = 1024 * 1024;
  const h = launchHelper(b64spec(specFor(["flood", String(N)])));
  const code = await h.done;
  const outBytes = stdoutBuf(h).length;
  const errDigest = createHash("sha256").update(Buffer.concat(h.stderr)).digest("hex");
  const expectDigest = createHash("sha256").update(Buffer.alloc(N, "x")).digest("hex");
  const ok = code === 0 && outBytes === N && errDigest === expectDigest;
  return ok
    ? { pass: true, detail: "1MiB stdout + 1MiB stderr, stderr hash-exact" }
    : { pass: false, detail: `exit=${code} out=${outBytes} errDigestMatch=${errDigest === expectDigest}` };
};

cases["reader-pause-resume"] = async () => {
  const N = 512 * 1024;
  const h = launchHelper(b64spec(specFor(["flood", String(N)])));
  h.cp.stdout.pause();
  await sleep(2500);
  h.cp.stdout.resume();
  const code = await h.done;
  const got = stdoutBuf(h);
  const digest = createHash("sha256").update(got).digest("hex");
  const expectDigest = createHash("sha256").update(Buffer.alloc(N, "x")).digest("hex");
  return code === 0 && got.length === N && digest === expectDigest
    ? { pass: true, detail: "2.5s reader pause → exact bytes after resume" }
    : { pass: false, detail: `exit=${code} bytes=${got.length} hashMatch=${digest === expectDigest}` };
};

cases["reader-never-resumes"] = async ({ dir }) => {
  // Reader stalls forever. We await ONLY the helper's exit under a
  // bounded watchdog — awaiting `close` while stdout stays paused would
  // deadlock (close needs the stream drained). After the helper exits we
  // resume/destroy the reader, then await close boundedly.
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["flood", String(4 * 1024 * 1024), marker])));
  h.cp.stdout.pause();
  const wm = await waitMarkerIdents(marker, 1);
  if (!wm.idents) return { pass: false, detail: "stalled-reader payload identity missing" };
  const t0 = Date.now();
  const ex = await bounded(h.exit, 60000, "helper exit");
  const boundedMs = Date.now() - t0;
  // Whatever happened, release the reader and await the real close —
  // bounded, never an infinite hang.
  h.cp.stdout.resume();
  const close = await bounded(h.done, 15000, "close after resume");
  if (ex.timeout)
    return { pass: false, detail: `helper still alive at ${boundedMs}ms with dead reader — no bounded kill` };
  const code = ex.value;
  if (close.timeout)
    return { pass: false, detail: `helper exited ${code} but stdio never drained` };
  return code === 4 && boundedMs < 60000
    ? { pass: true, detail: `stalled reader → bounded exit 4 at ${boundedMs}ms` }
    : { pass: false, detail: `exit=${code} after ${boundedMs}ms` };
};

cases["input-write-blocked"] = async ({ dir }) => {
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["ignore-stdin", "60000", marker])));
  const wm = await waitMarkerIdents(marker, 1);
  if (!wm.idents) return { pass: false, detail: "blocked-input payload identity missing" };
  const seen = await waitStdout(h, (s) => s.includes("tick"), 10000);
  if (!seen) return { pass: false, detail: "payload never ticked" };
  const chunk = Buffer.alloc(64 * 1024, "y");
  for (let i = 0; i < 24; i++) h.cp.stdin.write(chunk); // ~1.5MiB, unawaited
  const t0 = Date.now();
  const code = await h.done;
  const boundedMs = Date.now() - t0;
  h.cp.stdin.end();
  return code === 4 && boundedMs < 60000
    ? { pass: true, detail: `blocked input write → bounded exit 4 at ${boundedMs}ms` }
    : { pass: false, detail: `exit=${code} after ${boundedMs}ms` };
};

cases["child-ignoring-stdin"] = async ({ dir }) => {
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["marker", marker, "60000"])));
  const wm = await waitMarkerIdents(marker, 1, 10000);
  if (!wm.idents) return { pass: false, detail: `marker not ready (${wm.count} lines${wm.malformed ? ", malformed" : ""})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.verdict !== "living")
    return { pass: false, detail: `payload identity not provably live (${live.verdict})` };
  h.cp.stdin.end();
  const code = await h.done;
  const dead = await waitAllDead(wm.idents);
  return code === 6 && dead.verdict === "all-dead"
    ? { pass: true, detail: "stdin EOF → bounded grace → tree reaped, exit 6" }
    : { pass: false, detail: `exit=${code} liveness=${dead.verdict}` };
};

cases["payload-exits-descendants-live"] = async ({ dir }) => {
  // Deterministic readiness-and-release: spawn-gate records EVERY
  // descendant's marker AND keeps the root alive until we touch the
  // release file — so all identities are verified LIVE before the
  // requested root exit. Then the Job must actively reap the tree →
  // helper exit 6, never a pass on timing luck.
  const marker = join(dir, "marker.txt");
  const release = join(dir, "release.flg");
  const h = launchHelper(b64spec(specFor(["spawn-gate", "3", marker, release])));
  const wm = await waitMarkerIdents(marker, 4, 20000);
  if (!wm.idents)
    return { pass: false, detail: `readiness never reached (${wm.count} markers${wm.malformed ? ", malformed" : ""})` };
  // Every ident — including the ROOT — must be provably live NOW.
  const live = await tracker.checkIdents(wm.idents);
  if (live.verdict !== "living" || live.living.length !== wm.idents.length)
    return { pass: false, detail: `not all ${wm.idents.length} procs verified live (${live.verdict}:${live.living.length})` };
  // Explicit release: the test, not luck, requests the root's exit.
  writeFileSync(release, "go");
  const code = await h.done;
  const dead = await waitAllDead(wm.idents);
  return code === 6 && dead.verdict === "all-dead"
    ? { pass: true, detail: `released root → ${wm.idents.length} descendants actively reaped (exit 6)` }
    : { pass: false, detail: `exit=${code} liveness=${dead.verdict} living=${dead.living ?? []}` };
};

cases["eof-terminates-full-tree"] = async ({ dir }) => {
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["spawn", "3", marker])));
  const wm = await waitMarkerIdents(marker, 4, 20000);
  if (!wm.idents)
    return { pass: false, detail: `tree readiness never reached (${wm.count}${wm.malformed ? ", malformed" : ""})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.living.length !== wm.idents.length)
    return { pass: false, detail: `only ${live.living.length}/${wm.idents.length} verified live` };
  h.cp.stdin.end();
  const code = await h.done;
  const dead = await waitAllDead(wm.idents);
  return code === 6 && dead.verdict === "all-dead"
    ? { pass: true, detail: `stdin EOF → ${wm.idents.length}-proc tree reaped, exit 6` }
    : { pass: false, detail: `exit=${code} liveness=${dead.verdict}` };
};

cases["owner-death-terminates-job"] = async ({ dir }) => {
  // owner-runner.mjs IS the launcher: it stamps its own pid into the spec
  // and the helper verifies it as its ACTUAL PARENT. Killing it must
  // make the helper terminate the whole Job — with helper exit evidence.
  const marker = join(dir, "marker.txt");
  const specFile = join(dir, "spec.json");
  writeFileSync(specFile, JSON.stringify({
    executable: FIXTURE,
    args: ["spawn", "3", marker],
    cwd: dir,
    env: {},
  }));
  const owner = spawn(
    process.execPath,
    [join(HERE, "owner-runner.mjs"), HELPER, specFile],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  tracker.track(owner);
  const ob = { stdout: [], stderr: [] };
  owner.stdout.on("data", (d) => ob.stdout.push(d));
  owner.stderr.on("data", (d) => ob.stderr.push(d));
  const ownerExit = new Promise((r) =>
    owner.on("exit", (code, signal) => r({ code, signal })),
  );

  const t0 = Date.now();
  let helperPid = null;
  let treeReady = false;
  while (Date.now() - t0 < 20000) {
    const m = Buffer.concat(ob.stdout).toString("utf8").match(/HELPERPID:(\d+)/);
    if (m) helperPid = Number(m[1]);
    const wm = markerIdents(marker);
    if (helperPid && !wm.malformed && wm.idents.length >= 4) { treeReady = true; break; }
    await sleep(60);
  }
  if (!treeReady)
    return { pass: false, detail: `tree/helper evidence never ready (helperPid=${helperPid})` };
  const wm = markerIdents(marker);
  const live = await tracker.checkIdents(wm.idents);
  if (live.living.length !== wm.idents.length)
    return { pass: false, detail: `only ${live.living.length}/${wm.idents.length} verified live` };
  const helperQuery = await winQueryImpl(helperPid);
  if (helperQuery.status !== "alive") return { pass: false, detail: "helper identity unverifiable before kill" };
  const helperTicks = helperQuery.ticks;

  owner.kill();
  const ownerExitInfo = await ownerExit;
  // Bounded wait for EVERY verified identity — helper AND descendants.
  const dead = await waitAllDead(
    [...wm.idents, { pid: helperPid, ticks: helperTicks }],
    20000,
  );
  // Observed owner termination: the 'exit' event must carry a real exit
  // code OR the terminating signal. A TerminateProcess'd owner on win32
  // reports {code:null, signal:'SIGTERM'} — still observed termination.
  const ownerExited = ownerExitInfo.code !== null || ownerExitInfo.signal != null;
  return ownerExited && dead.verdict === "all-dead"
    ? { pass: true, detail: `owner exit=${JSON.stringify(ownerExitInfo)} → helper + ${wm.idents.length} descendants reaped` }
    : { pass: false, detail: `ownerExit=${JSON.stringify(ownerExitInfo)} liveness=${dead.verdict}` };
};

cases["forced-helper-termination"] = async ({ dir }) => {
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["spawn", "3", marker])));
  const wm = await waitMarkerIdents(marker, 4, 20000);
  if (!wm.idents)
    return { pass: false, detail: `tree readiness never reached (${wm.count}${wm.malformed ? ", malformed" : ""})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.living.length !== wm.idents.length)
    return { pass: false, detail: `only ${live.living.length}/${wm.idents.length} verified live` };
  // Our DIRECT child: kill via the retained ChildProcess handle — a
  // TerminateProcess on THIS identity, not a raw-pid taskkill.
  h.cp.kill("SIGKILL");
  await h.done;
  const dead = await waitAllDead(wm.idents, 20000);
  return dead.verdict === "all-dead"
    ? { pass: true, detail: `helper killed → ${wm.idents.length} descendants reaped by Job` }
    : { pass: false, detail: `living after helper kill: ${dead.verdict}` };
};

cases["breakaway-attempt-contained"] = async ({ dir }) => {
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["spawn-breakaway", "3", marker])));
  const seen = await waitStdout(h, (s) => s.includes("REFUSED") || s.includes("SPAWNED"), 15000);
  if (!seen) return { pass: false, detail: "no REFUSED/SPAWNED evidence — empty capture is not containment" };
  const out = stdoutBuf(h).toString("utf8");
  // Expected: CreateProcessWithLogonW breakaway denied — ERROR_ACCESS_DENIED (5).
  const refusedDenied = /REFUSED:5\b/.test(out);
  const spawned = /SPAWNED/.test(out);
  h.cp.stdin.end();
  const code = await h.done;
  const wm = markerIdents(marker);
  const dead = wm.idents.length ? await waitAllDead(wm.idents) : { verdict: "unknown" };
  // Any successful breakaway (SPAWNED) or an unexplained REFUSED code is a
  // FAIL — the Job must contain. Root cleanup must be PROVEN.
  if (spawned)
    return { pass: false, detail: "breakaway SPAWNED — job containment broken" };
  return refusedDenied && code === 6 && dead.verdict === "all-dead"
    ? { pass: true, detail: `breakaway refused (access denied) → tree reaped, exit ${code}` }
    : { pass: false, detail: `refused5=${refusedDenied} exit=${code} liveness=${dead.verdict}` };
};

cases["repeated-start-stop"] = async () => {
  for (let i = 0; i < 5; i++) {
    const h = launchHelper(b64spec(specFor(["echo"])));
    h.cp.stdin.write(`cycle-${i}\n`);
    const ok = await waitStdout(h, (s) => s.includes(`cycle-${i}`));
    h.cp.stdin.end();
    const code = await h.done;
    if (!ok || code !== 0)
      return { pass: false, detail: `cycle ${i}: echoed=${ok} exit=${code}` };
  }
  return { pass: true, detail: "5 start/stop cycles, all exit 0" };
};

// ---------------- --run mode (exit-code channel, helper 1.2.0+) ----------------
// A NATURAL payload exit 0..255 maps to 1024+code — the code travels in
// the helper's own exit code so a caller never parses stderr. Every
// forced/failed/unprovable class keeps the helper's 2..6 codes and can
// NEVER land inside 1024..1279.

cases["run-version-capability"] = async () => {
  const helperVersion = JSON.parse(execFileSync(HELPER, ["--version"], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  }));
  const ok = helperVersion.runExitBase === 1024 && helperVersion.runExitMax === 255;
  return ok
    ? { pass: true, detail: `--version advertises runExitBase=${helperVersion.runExitBase} runExitMax=${helperVersion.runExitMax}` }
    : { pass: false, detail: `missing run capability: ${JSON.stringify(helperVersion).slice(0, 160)}` };
};

cases["run-exit-codes"] = async () => {
  for (const [arg, want] of [["0", 1024], ["42", 1066], ["255", 1279]]) {
    const h = launchHelper(b64spec(specFor(["exit", arg])), "--run");
    const code = await h.done;
    if (code !== want)
      return { pass: false, detail: `payload exit ${arg} → helper exit ${code}, want ${want}` };
    if (/payload-exit=/.test(stderrText(h)))
      return { pass: false, detail: `payload exit ${arg}: helper emitted payload-exit= on stderr in --run` };
  }
  return { pass: true, detail: "payload exits 0/42/255 mapped to 1024/1066/1279" };
};

cases["run-exit-overflow-fails-closed"] = async () => {
  // A payload code outside 0..255 cannot ride the exit channel — the
  // helper must fail closed (6), never emit a mappable code or exit 0.
  const h = launchHelper(b64spec(specFor(["exit", "256"])), "--run");
  const code = await h.done;
  return code === 6
    ? { pass: true, detail: "payload exit 256 → helper fails closed (6), no mappable code" }
    : { pass: false, detail: `exit=${code}` };
};

cases["run-streams-never-carry-status"] = async () => {
  // The payload's OWN output may contain text that looks like a status
  // line — it passes through verbatim and cannot influence the mapping.
  const h = launchHelper(
    b64spec(specFor(["args", "payload-exit=99", "payload exited 7"])),
    "--run",
  );
  const code = await h.done;
  const out = stdoutBuf(h).toString("utf8");
  const verbatim = out.includes("ARG0=payload-exit=99") && out.includes("ARG1=payload exited 7");
  return code === 1024 && verbatim
    ? { pass: true, detail: "fake status text preserved verbatim, real exit 0 → 1024" }
    : { pass: false, detail: `exit=${code} out=${JSON.stringify(out).slice(0, 160)}` };
};

cases["run-rejections"] = async () => {
  // The same spec/owner/spawn classes refuse identically in --run —
  // nothing about the exit channel relaxes validation.
  const bad = launchHelper("garbage-not-b64!!!", "--run");
  const badCode = await bad.done;
  const miss = launchHelper(b64spec({ ...specFor(["x"]), executable: "D:\\definitely\\missing\\nope.exe" }), "--run");
  const missCode = await miss.done;
  const fails = [];
  if (badCode !== 2) fails.push(`bad spec → ${badCode} want 2`);
  if (missCode !== 5) fails.push(`missing exe → ${missCode} want 5`);
  return fails.length
    ? { pass: false, detail: fails.join("; ") }
    : { pass: true, detail: "spec rejection (2) and spawn failure (5) identical under --run" };
};

cases["run-eof-forced-tree"] = async ({ dir }) => {
  // stdin-EOF grace expiry is a FORCED termination — it stays exit 6 and
  // the tree is proven dead, never a mapped code.
  const marker = join(dir, "marker.txt");
  const h = launchHelper(b64spec(specFor(["ignore-stdin", "60000", marker])), "--run");
  const wm = await waitMarkerIdents(marker, 1, 10000);
  if (!wm.idents) return { pass: false, detail: `marker not ready (${wm.count}${wm.malformed ? ", malformed" : ""})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.verdict !== "living")
    return { pass: false, detail: `payload identity not provably live (${live.verdict})` };
  h.cp.stdin.end();
  const code = await h.done;
  const dead = await waitAllDead(wm.idents);
  return code === 6 && dead.verdict === "all-dead"
    ? { pass: true, detail: "--run stdin EOF → bounded grace → forced reap exit 6, tree proven dead" }
    : { pass: false, detail: `exit=${code} liveness=${dead.verdict}` };
};

cases["run-descendants-reaped"] = async ({ dir }) => {
  // Root exits naturally BUT leaves live descendants — a forced cleanup,
  // so the result is exit 6 and an actively reaped tree, not a mapped
  // "clean" exit code.
  const marker = join(dir, "marker.txt");
  const release = join(dir, "release.flg");
  const h = launchHelper(b64spec(specFor(["spawn-gate", "3", marker, release])), "--run");
  const wm = await waitMarkerIdents(marker, 4, 20000);
  if (!wm.idents)
    return { pass: false, detail: `readiness never reached (${wm.count} markers${wm.malformed ? ", malformed" : ""})` };
  const live = await tracker.checkIdents(wm.idents);
  if (live.verdict !== "living" || live.living.length !== wm.idents.length)
    return { pass: false, detail: `not all ${wm.idents.length} procs verified live` };
  writeFileSync(release, "go");
  const code = await h.done;
  const dead = await waitAllDead(wm.idents);
  return code === 6 && dead.verdict === "all-dead"
    ? { pass: true, detail: `natural root exit + ${wm.idents.length - 1} live descendants → forced reap exit 6` }
    : { pass: false, detail: `exit=${code} liveness=${dead.verdict}` };
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
    // Persist launched-helper identities as teardown evidence — the
    // orchestrator (and any human) can audit what this case spawned.
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
    if (td.unknown.length)
      res = { pass: false, detail: `${res?.detail ?? ""} + teardown unknown: ${td.unknown}`, cleanup: "unknown" };
    else if (!res)
      res = { pass: false, detail: "no result" };
  }
  if (!res.cleanup) res.cleanup = res.pass ? "clean" : "unknown";
  console.log(`RESULT:${JSON.stringify(res)}`);
  process.exit(res.pass ? 0 : 1);
}

// ---------------- orchestrator ----------------
// Precondition: the helper must answer --version before ANY case runs —
// a failed diagnostic is a failed precondition, not a skipped case.
let helperVersion;
try {
  const out = execFileSync(HELPER, ["--version"], { encoding: "utf8", timeout: 10000 });
  helperVersion = JSON.parse(out);
  if (!helperVersion.helper || !helperVersion.spec) throw new Error("bad shape");
} catch (e) {
  console.error(`helper-harness: --version precondition failed: ${e?.message ?? e}`);
  process.exit(4);
}
mkdirSync(OUT, { recursive: true });

const CASE_LIST = [
  ["roundtrip-echo", 45000],
  ["quoting-args", 30000],
  ["unicode-cwd-and-path", 30000],
  ["env-isolation-utf8-exact", 30000],
  ["env-sentinel-absent", 30000],
  ["env-order-block", 30000],
  ["exact-output-tails", 60000],
  ["spec-rejections-no-marker", 90000],
  ["unrelated-owner-rejected", 40000],
  ["dead-owner-id-rejected", 40000],
  ["duplicate-field-rejection", 30000],
  ["payload-nonzero", 30000],
  ["spawn-failure", 30000],
  ["concurrent-stdio-backpressure", 90000],
  ["reader-pause-resume", 60000],
  ["reader-never-resumes", 90000],
  ["input-write-blocked", 90000],
  ["child-ignoring-stdin", 60000],
  ["payload-exits-descendants-live", 90000],
  ["eof-terminates-full-tree", 60000],
  ["owner-death-terminates-job", 90000],
  ["forced-helper-termination", 60000],
  ["breakaway-attempt-contained", 60000],
  ["repeated-start-stop", 120000],
  ["run-version-capability", 15000],
  ["run-exit-codes", 45000],
  ["run-exit-overflow-fails-closed", 30000],
  ["run-streams-never-carry-status", 30000],
  ["run-rejections", 45000],
  ["run-eof-forced-tree", 60000],
  ["run-descendants-reaped", 90000],
];

const results = [];
// Whole-suite bound: the orchestrator cannot outlive its own budget.
const suiteDeadline = Date.now() + 20 * 60 * 1000;
for (const [name, timeoutMs] of CASE_LIST) {
  if (Date.now() > suiteDeadline) {
    results.push({ name, pass: false, detail: "suite deadline exceeded before start" });
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
  // A case whose own cleanup state is UNKNOWN can have left verified-
  // live descendants. Do not trust the orchestrator tracker's emptiness —
  // STOP the suite: later cases may share the machine with leftovers.
  if (!res.pass || res.timedOut || res.cleanup !== "clean") {
    results.push({ name: "—", pass: false, detail: "suite stopped: prior case failed or cleanup unverified" });
    break;
  }
}

const report = {
  windowsOnly: true,
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
  cases: results,
  passed: results.filter((r) => r.pass).length,
  total: results.length,
};
writeFileSync(join(OUT, "harness-results.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed}/${report.total} cases passed — ${join(OUT, "harness-results.json")}`);
process.exit(report.passed === report.total ? 0 : 3);
