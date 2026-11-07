// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// harness-control — the platform-agnostic control machinery of
// helper-harness.mjs, factored out so the CONTROL semantics themselves
// are testable off Windows (a stub query impl exercises every branch):
//
//   · process identity: a pid is alive only when the OS query returns a
//     creation stamp matching the one captured at registration. Query
//     outcomes are THREE states — alive / confirmed-not-found / unknown —
//     and "unknown" NEVER counts as dead. An identity that could not be
//     captured at registration stays unknown FOREVER: we never adopt a
//     later (possibly reused-pid) identity.
//   · teardown kills via the retained ChildProcess handle — never a raw
//     stale pid — only after re-verifying the identity is still ours,
//     and then AWAITS the observed exit. Unknown stays reported, never
//     silently dropped.
//   · runCaseIsolated runs ONE case in a child runner under a hard outer
//     watchdog and settles on `close` (stdio drained): a pass requires
//     exit 0 AND exactly one RESULT{pass:true} line. A timeout kills the
//     runner and then waits for its OBSERVED termination under a bounded
//     secondary deadline — never resolves on the kill request itself.
//
// Nothing in this file knows about Windows, Job objects or pass/fail
// policy — it is honest plumbing, unit-tested on every platform.

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------- identity queries ------------------------------------------------
// queryImpl(pid) must resolve to one of:
//   { status: "alive", ticks: "…" }   process exists, identity stamp
//   { status: "not-found" }           OS says no such process
//   { status: "unknown", why: "…" }   query failed/denied/timed out —
//                                     treated as NEITHER dead nor alive.
export class IdentityTracker {
  constructor(queryImpl) {
    this.query = queryImpl;
    /** @type {Map<number, {pid:number, cp:object|null, ticks:string|null}>} */
    this.entries = new Map();
  }

  // Register a spawned child. The exit listener is attached BEFORE the
  // identity query — a child that dies mid-query is removed and can never
  // acquire a later (possibly reused-pid) identity. The ChildProcess
  // handle is retained so kills go through .kill(), not a stale pid.
  async track(childProcess) {
    const pid = childProcess?.pid;
    if (pid == null) return;
    const entry = { pid, cp: childProcess, ticks: null, exited: false };
    this.entries.set(pid, entry);
    childProcess.once?.("exit", () => {
      // Observed exit proves THIS child's death — nothing more. The pid
      // may be reused at any moment; remove it so nothing acts on a
      // stale identity afterward.
      entry.exited = true;
      this.entries.delete(pid);
    });
    const r = await this.query(pid).catch(() => ({ status: "unknown" }));
    // Store the stamp ONLY if the entry still exists (child still
    // registered). A never-captured identity is unknown PERMANENTLY —
    // later queries are not allowed to adopt one.
    if (this.entries.get(pid) === entry && r.status === "alive")
      entry.ticks = r.ticks;
  }

  // "alive" | "dead" | "unknown" — unknown on ANY query failure or on an
  // identity we could never capture at registration.
  async state(pid) {
    const e = this.entries.get(pid);
    if (!e) return "dead"; // untracked = not ours to worry about
    const r = await this.query(pid).catch(() => ({ status: "unknown" }));
    if (r.status === "not-found") {
      this.entries.delete(pid);
      return "dead";
    }
    if (r.status !== "alive") return "unknown";
    if (e.ticks === null) return "unknown"; // never captured — stays so
    return r.ticks === e.ticks ? "alive" : "dead"; // reused pid = dead
  }

  // Verify a batch of identities ([{pid,ticks}] — e.g. marker captures).
  // An EMPTY list or a null stamp is NOT proof — verdict "unknown".
  async checkIdents(idents) {
    if (!idents || idents.length === 0)
      return { verdict: "unknown", living: [], unknown: -1 };
    const living = [];
    let unknown = 0;
    for (const id of idents) {
      if (!Number.isSafeInteger(id.pid) || id.pid <= 0 || typeof id.ticks !== "string" || !id.ticks) { unknown++; continue; }
      const r = await this.query(id.pid).catch(() => ({ status: "unknown" }));
      if (r.status === "alive" && r.ticks === id.ticks) {
        living.push(id.pid);
      } else if (r.status !== "not-found" && !(r.status === "alive" && typeof r.ticks === "string" && r.ticks !== id.ticks)) {
        unknown++;
      }
      // not-found, or alive-with-different-ticks (reused) → dead
    }
    if (living.length) return { verdict: "living", living, unknown };
    if (unknown) return { verdict: "unknown", living, unknown };
    return { verdict: "all-dead", living, unknown };
  }

  // Kill ONLY entries currently verified alive with OUR identity stamp —
  // via the retained ChildProcess handle, never a raw pid — then AWAIT
  // the observed exit. An unverifiable entry is reported unknown and
  // kept, never "forgotten" on a requested kill.
  async teardown(killWaitMs = 4000) {
    const killed = [];
    const unknown = [];
    for (const [, e] of [...this.entries]) {
      const s = await this.state(e.pid);
      if (s === "alive") {
        let killErr = null;
        try {
          if (e.cp) e.cp.kill("SIGKILL");
          else killErr = "no ChildProcess handle — refusing raw-pid kill";
        } catch (err) {
          killErr = String(err?.message ?? err);
        }
        if (killErr) {
          unknown.push(`${e.pid}:${killErr}`);
          continue;
        }
        // Wait for the OBSERVED exit — a kill request is not a kill.
        const gone = await new Promise((res) => {
          if (e.exited) return res(true);
          const t = setTimeout(() => res(false), killWaitMs);
          e.cp?.once?.("exit", () => { clearTimeout(t); res(true); });
        });
        if (gone) {
          killed.push(e.pid);
          this.entries.delete(e.pid);
        } else {
          unknown.push(`${e.pid}:kill-not-observed`);
        }
      } else if (s === "unknown") {
        unknown.push(`${e.pid}:query-unknown`);
      } else {
        this.entries.delete(e.pid);
      }
    }
    return { killed, unknown };
  }
}

// -------- isolated per-case runner ---------------------------------------
// The parent spawns `node <harness> --case <name> --dir <d> <extra…>` and
// settles on `close` — exit code AND drained stdio. A pass requires:
//   · exit code 0, no spawn error, no timeout, no output overflow, AND
//   · EXACTLY ONE RESULT line that parses to {pass:true}.
// A pass:true RESULT followed by a nonzero exit is a FAIL; zero or two+
// RESULT lines are malformed; a deadline SIGKILLs the runner and then
// waits for its observed termination under a secondary bound.
//
// Diagnostic retention: EVERY settled case persists bounded evidence into
// its fresh per-case directory —
//   runner.stdout.txt / runner.stderr.txt — the captured (bounded) streams
//   outcome.json — exit code/signal, timeout/overflow/spawn observations
//                  and up to 8 RESULT-line observations. Parsed RESULT
//                  fields are diagnostic evidence ONLY — never pass
//                  authority. Environment is never logged.
// Writes use flag "wx" against fixed basenames (no overwrite, no traversal)
// and a persistence failure can NEVER mint a passing case.
const STDOUT_BOUND = 4 * 1024 * 1024;
const STDERR_BOUND = 1024 * 1024;
const RESULT_OBS_MAX = 8;
const RESULT_RAW_MAX = 2048;
const DETAIL_MAX = 2000;

export function runCaseIsolated({
  nodeExe, harnessPath, name, dir, timeoutMs, extraArgs = [], env = {},
  cleanupWaitMs = 5000,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child, deadline, cleanupDeadline;
    let finished = false, timedOut = false, exited = false;
    let stdout = "", stderr = "", spawnError = null;
    let stdoutBytes = 0, stderrBytes = 0;
    let stdoutOverflow = false, stderrOverflow = false;
    const persistEvidence = (outcome) => {
      const dirPath = resolvePath(dir);
      const files = {
        stdout: join(dirPath, "runner.stdout.txt"),
        stderr: join(dirPath, "runner.stderr.txt"),
        outcome: join(dirPath, "outcome.json"),
      };
      writeFileSync(files.stdout, stdout, { flag: "wx" });
      writeFileSync(files.stderr, stderr, { flag: "wx" });
      writeFileSync(files.outcome, `${JSON.stringify(outcome, null, 2)}\n`, { flag: "wx" });
      return { dir: dirPath, persisted: true, files };
    };
    const resultObservations = () => {
      const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith("RESULT:"));
      const results = [];
      for (const line of lines.slice(0, RESULT_OBS_MAX)) {
        let value = null, valid = false;
        try { value = JSON.parse(line.slice(7)); valid = true; } catch { /* retained as raw */ }
        results.push({
          valid,
          raw: line.slice(0, RESULT_RAW_MAX),
          pass: value?.pass === true ? true : value?.pass === false ? false : null,
          cleanup: typeof value?.cleanup === "string" ? value.cleanup : null,
          detail: typeof value?.detail === "string" ? value.detail.slice(0, RESULT_RAW_MAX) : null,
        });
      }
      return { resultLineCount: lines.length, results };
    };
    const finish = (result, observation = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      const final = { ...result, timedOut, ms: Date.now() - started };
      try {
        final.evidence = persistEvidence({
          case: name,
          pass: final.pass,
          cleanup: final.cleanup ?? "unknown",
          detail: final.detail ?? "",
          timedOut,
          ms: final.ms,
          finishedAtUtc: new Date().toISOString(),
          exitCode: observation.code ?? null,
          signal: observation.signal ?? null,
          spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
          exited,
          overflowed: stdoutOverflow || stderrOverflow,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated: stdoutOverflow,
          stderrTruncated: stderrOverflow,
          stderrTail: stderr.slice(-RESULT_RAW_MAX),
          ...resultObservations(),
        });
      } catch (error) {
        // Evidence that could not be retained is a failed case — never
        // let a persistence problem masquerade as a pass.
        const msg = String(error?.message ?? error);
        final.evidence = { dir: resolvePath(dir), persisted: false, error: msg };
        final.pass = false;
        final.detail = `${final.detail ?? "failed"} — evidence persistence failed: ${msg}`.slice(0, DETAIL_MAX);
      }
      resolve(final);
    };
    try {
      child = spawn(nodeExe, [harnessPath, "--case", name, "--dir", dir, ...extraArgs], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
      });
    } catch (error) {
      spawnError = error;
      finish({ pass: false, cleanup: "unknown", detail: `runner spawn throw: ${error.message}` });
      return;
    }
    child.once("exit", () => { exited = true; });
    child.once("error", (error) => { spawnError = error; });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdoutOverflow) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes + bytes > STDOUT_BOUND) { stdoutOverflow = true; return; }
      stdoutBytes += bytes;
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderrOverflow) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stderrBytes + bytes > STDERR_BOUND) { stderrOverflow = true; return; }
      stderrBytes += bytes;
      stderr += chunk;
    });
    child.once("close", (code, signal) => {
      const obs = { code, signal };
      const fail = (detail) => finish({ pass: false, cleanup: "unknown", detail }, obs);
      if (timedOut) return fail(`hard timeout ${timeoutMs}ms — runner termination and stdio close observed; descendant cleanup unverified`);
      if (spawnError) return fail(`runner spawn error: ${spawnError.message}`);
      if (stdoutOverflow || stderrOverflow) return fail("runner output overflowed capture bound");
      const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("RESULT:"));
      if (lines.length !== 1) return fail(`expected exactly one RESULT line, got ${lines.length} (exit=${code})`);
      let result;
      try { result = JSON.parse(lines[0].slice(7)); }
      catch { return fail("RESULT line is not valid JSON"); }
      if (!result || typeof result !== "object") return fail("RESULT is not an object");
      if (code !== 0 || signal) {
        const diag = typeof result.detail === "string" && result.detail
          ? `; RESULT detail: ${result.detail.slice(0, 500)}` : "";
        return fail(`runner exit=${code}, signal=${signal ?? "none"} — refusing its RESULT${diag}`);
      }
      if (result.pass !== true) return fail(String(result.detail ?? "RESULT pass!==true").slice(0, DETAIL_MAX));
      if (result.cleanup !== "clean") return fail("runner did not prove clean teardown");
      finish({ pass: true, cleanup: "clean", detail: String(result.detail ?? "").slice(0, DETAIL_MAX) }, obs);
    });
    deadline = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* secondary deadline reports failure */ }
      cleanupDeadline = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({ pass: false, cleanup: "unknown", detail: `hard timeout ${timeoutMs}ms — runner exited=${exited}, stdio close not observed within cleanup deadline` });
      }, cleanupWaitMs);
    }, timeoutMs);
  });
}

export function parseProcessQuery(text) {
  try {
    const value = JSON.parse(text.trim());
    if (value?.status === "not-found") return { status: "not-found" };
    if (value?.status === "alive" && typeof value.ticks === "string" && /^[1-9]\d*$/.test(value.ticks))
      return { status: "alive", ticks: value.ticks };
  } catch { /* malformed evidence is unknown */ }
  return { status: "unknown" };
}

export async function queryWindowsProcess(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0)
    return { status: "unknown" };
  // Only this specific OS lookup error proves absence. All other errors,
  // including access denied and PowerShell failure, remain unknown.
  const script = `$ErrorActionPreference='Stop'; try {
    $p=Get-Process -Id ${pid} -ErrorAction Stop;
    @{status='alive';ticks=$p.StartTime.ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') {
      @{status='not-found'} | ConvertTo-Json -Compress
    } else { @{status='unknown'} | ConvertTo-Json -Compress }
  }`;
  try {
    return parseProcessQuery(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }));
  } catch { return { status: "unknown" }; }
}

// ---------------- parent-side case selection ----------------
// --cases <csv> picks an EXACT subset of a harness CASE_LIST for a
// diagnostic run (e.g. --cases input-echo-and-ctrl-c). Absent = the full
// list, unchanged. An empty or unknown name is a refusal, never a silent
// skip — the caller maps the throw to the harness's refuse exit. Selected
// cases keep CASE_LIST order and their original timeouts; runCaseIsolated
// is untouched.

/**
 * @param {Array<[string, number]>} caseList
 * @param {string|null|undefined} raw null/undefined = no selection
 * @returns {Array<[string, number]>}
 */
export function selectCases(caseList, raw) {
  if (raw === null || raw === undefined) return caseList;
  const names = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length)
    throw new Error("case selection is empty — refusing silent no-op");
  const known = new Set(caseList.map(([n]) => n));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length)
    throw new Error(
      `unknown case name(s): ${unknown.join(", ")} — valid: ${[...known].join(", ")}`,
    );
  const wanted = new Set(names);
  return caseList.filter(([n]) => wanted.has(n));
}
