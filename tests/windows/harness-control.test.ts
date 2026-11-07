// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// Harness-CONTROL tests: the watchdog/identity semantics of the Windows
// helper harness, proven on any host WITHOUT faking Job results. The
// query impl is a stub — these tests verify that unknown-vs-dead
// identity states, empty captures and per-case hard timeouts behave
// correctly; they make no claim about Windows Job behavior.

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  IdentityTracker,
  parseProcessQuery,
  runCaseIsolated,
  selectCases,
  sleep,
} from "./harness-control.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "test-runner.mjs");

// runCaseIsolated persists evidence with flag "wx" — every test needs a
// FRESH directory; shared dirs would collide and that collision is itself
// a (correctly) failing outcome.
const caseDirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "hc-case-"));
  caseDirs.push(d);
  return d;
};
const readOutcome = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8"));
afterEach(() => {
  while (caseDirs.length) rmSync(caseDirs.pop()!, { recursive: true, force: true });
});

describe("IdentityTracker", () => {
  it("distinguishes alive / confirmed-not-found / unknown", async () => {
    let answer: any = { status: "alive", ticks: "111" };
    const t = new IdentityTracker(async () => answer);
    const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      stdio: "ignore",
    });
    await t.track(p); // capture happens AT registration
    expect(await t.state(p.pid!)).toBe("alive");
    answer = { status: "not-found" };
    expect(await t.state(p.pid!)).toBe("dead");
    answer = { status: "unknown", why: "timeout" };
    const p2 = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      stdio: "ignore",
    });
    await t.track(p2);
    expect(await t.state(p2.pid!)).toBe("unknown");
    p.kill();
    p2.kill();
  });

  it("teardown kills only verified-still-ours and reports unknowns", async () => {
    const states = new Map<number, any>();
    const t = new IdentityTracker(async (pid: number) =>
      states.get(pid) ?? { status: "not-found" },
    );
    const ok = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      stdio: "ignore",
    });
    const unk = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      stdio: "ignore",
    });
    // Identity must be verifiable AT registration to ever be killable.
    states.set(ok.pid!, { status: "alive", ticks: "1" });
    states.set(unk.pid!, { status: "unknown", why: "denied" });
    await t.track(ok);
    await t.track(unk);
    const r = await t.teardown();
    expect(r.killed).toContain(ok.pid);
    expect(r.unknown.join()).toContain(String(unk.pid));
    unk.kill();
  });

  it("checkIdents never calls an unknown proof of cleanup", async () => {
    const t = new IdentityTracker(async () => ({ status: "unknown" }));
    const r = await t.checkIdents([{ pid: 1234, ticks: "9" }]);
    expect(r.verdict).toBe("unknown");
  });

  it("empty identity capture is UNKNOWN, never all-dead", async () => {
    const t = new IdentityTracker(async () => ({ status: "alive", ticks: "x" }));
    expect((await t.checkIdents([])).verdict).toBe("unknown");
  });

  it("a null creation stamp is UNKNOWN — it proves nothing", async () => {
    const t = new IdentityTracker(async () => ({ status: "alive", ticks: "x" }));
    const r = await t.checkIdents([{ pid: 1, ticks: null }]);
    expect(r.verdict).toBe("unknown");
  });

  it("a pid reused by a different identity counts as dead", async () => {
    const t = new IdentityTracker(async () => ({ status: "alive", ticks: "NEW" }));
    const r = await t.checkIdents([{ pid: 1234, ticks: "OLD" }]);
    expect(r.verdict).toBe("all-dead");
  });

  it("a child exiting mid-query never adopts a later identity", async () => {
    // The query resolves AFTER the child exits: a reuse of its pid by a
    // different process must not mint an identity for our entry.
    let resolveQuery: ((v: any) => void) | null = null;
    const t = new IdentityTracker(
      () => new Promise((res) => { resolveQuery = res; }),
    );
    const p = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const tracking = t.track(p);
    p.kill("SIGKILL");
    await new Promise((r) => p.once("exit", r));
    // Now the query resolves "alive" — the pid may already be reused;
    // the entry was removed on exit and must not come back.
    resolveQuery!({ status: "alive", ticks: "999" });
    await tracking;
    expect(await t.state(p.pid!)).toBe("dead");
  });

  it("an identity unverifiable at registration stays unknown forever", async () => {
    let step = 0;
    const t = new IdentityTracker(async () =>
      step++ === 0 ? { status: "unknown", why: "timeout" }
                   : { status: "alive", ticks: "LATER" },
    );
    const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      stdio: "ignore",
    });
    await t.track(p);
    // Later queries DO see the process — but adoption is forbidden:
    // the stamp captured later could belong to a reused pid.
    expect(await t.state(p.pid!)).toBe("unknown");
    p.kill();
  });
});

describe("runCaseIsolated", () => {
  it("returns the runner's RESULT line on clean exit 0", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "ok",
      dir: freshDir(),
      timeoutMs: 5000,
    });
    expect(r.pass).toBe(true);
    expect(r.timedOut).toBeFalsy();
  });

  it("hard timeout kills the runner and waits for observed death", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "sleep",
      dir: freshDir(),
      timeoutMs: 400,
    });
    expect(r.pass).toBe(false);
    expect(r.timedOut).toBe(true);
    // Direct-child termination does not prove descendant cleanup.
    expect(r.cleanup).toBe("unknown");
  });

  it("RESULT pass:true + nonzero exit is a FAIL, not a pass", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "exit17",
      dir: freshDir(),
      timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("exit=17");
  });

  it("duplicate RESULT lines are malformed — a fail, not a pass", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "two-results",
      dir: freshDir(),
      timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
  });

  it("a non-JSON RESULT line is malformed — a fail", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "bad-result",
      dir: freshDir(),
      timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
  });

  it("a runner that dies by signal before any RESULT fails", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "die-signal",
      dir: freshDir(),
      timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
  });

  it("a runner that exits silently is a failed case, not a pass", async () => {
    const r = await runCaseIsolated({
      nodeExe: process.execPath,
      harnessPath: RUNNER,
      name: "silent",
      dir: freshDir(),
      timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("RESULT");
  });
});


describe("lead regressions: result and deadline evidence", () => {
  it.each(["unknown-cleanup", "bad-plus-good"])("refuses %s", async (name) => {
    const r = await runCaseIsolated({ nodeExe: process.execPath, harnessPath: RUNNER, name, dir: freshDir(), timeoutMs: 2000 });
    expect(r.pass).toBe(false);
    expect(r.cleanup).toBe("unknown");
  });
  it("cannot pass after its deadline when exit preceded stdio close", async () => {
    const r = await runCaseIsolated({ nodeExe: process.execPath, harnessPath: RUNNER, name: "late-close", dir: freshDir(), timeoutMs: 100, cleanupWaitMs: 1500 });
    expect(r.pass).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.cleanup).toBe("unknown");
  });
  it("preserves process FILETIME precision and refuses malformed query evidence", () => {
    expect(parseProcessQuery('{"status":"alive","ticks":"134000000000000001"}')).toEqual({status:"alive",ticks:"134000000000000001"});
    expect(parseProcessQuery('{"status":"not-found"}')).toEqual({status:"not-found"});
    for (const text of ["access denied", '{"status":"alive","ticks":134000000000000001}', '{"status":"unknown"}', '{}', '{"status":"alive","ticks":""}'])
      expect(parseProcessQuery(text).status).toBe("unknown");
  });
});

describe("runCaseIsolated diagnostic retention", () => {
  it("retains runner stderr and parsed RESULT detail on nonzero-exit failure", async () => {
    // The exact lead reproduction: stderr sentinel + RESULT detail
    // sentinel + exit 1 — previously BOTH sentinels were lost.
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name: "diag-fail", dir, timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    expect(r.cleanup).toBe("unknown");
    expect(r.detail).toContain("exit=1");
    expect(r.detail).toContain("CASE_FAILURE_SENTINEL");
    expect(r.evidence?.persisted).toBe(true);
    expect(readFileSync(join(dir, "runner.stderr.txt"), "utf8")).toContain("RUNNER_DIAGNOSTIC_SENTINEL");
    const o = readOutcome(dir);
    expect(o.exitCode).toBe(1);
    expect(o.resultLineCount).toBe(1);
    expect(o.results[0]).toMatchObject({ valid: true, pass: false, cleanup: "unknown", detail: "CASE_FAILURE_SENTINEL" });
  });

  it("a forged pass with nonzero exit fails — retained RESULT is evidence, never authority", async () => {
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name: "exit17", dir, timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    const o = readOutcome(dir);
    expect(o.exitCode).toBe(17);
    // The parsed RESULT says pass:true — kept as diagnostic evidence
    // while the verdict remains a fail.
    expect(o.results[0].pass).toBe(true);
    expect(o.pass).toBe(false);
  });

  it("malformed + duplicate RESULT lines are recorded as bounded observations", async () => {
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name: "bad-plus-good", dir, timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    const o = readOutcome(dir);
    expect(o.resultLineCount).toBe(2);
    expect(o.results[0].valid).toBe(false);
    expect(o.results[1]).toMatchObject({ valid: true, pass: true });
  });

  it("a watchdog timeout persists partial evidence with its observations", async () => {
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name: "sleep", dir, timeoutMs: 400,
    });
    expect(r.pass).toBe(false);
    expect(r.timedOut).toBe(true);
    const o = readOutcome(dir);
    expect(o.timedOut).toBe(true);
    expect(o.pass).toBe(false);
    expect(o.cleanup).toBe("unknown");
  });

  it.each(["overflow", "unicode-overflow"])("%s is bounded by UTF-8 bytes with truncation flags", async (name) => {
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name, dir, timeoutMs: 15000,
    });
    expect(r.pass).toBe(false);
    const o = readOutcome(dir);
    expect(o.overflowed).toBe(true);
    expect(o.stdoutTruncated).toBe(true);
    expect(o.stdoutBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(readFileSync(join(dir, "runner.stdout.txt")).length).toBe(o.stdoutBytes);
  });

  it("an evidence persistence failure can never mint a pass", async () => {
    // A directory that does not exist: the runner would pass, but its
    // evidence cannot be retained — the case must fail.
    const missing = join(tmpdir(), `hc-missing-${Math.random().toString(36).slice(2)}`);
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name: "ok", dir: missing, timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("evidence persistence failed");
    expect(r.evidence?.persisted).toBe(false);
  });

  it("a spawn failure is recorded as structured evidence", async () => {
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: "/definitely/missing/node-binary", harnessPath: RUNNER, name: "ok", dir, timeoutMs: 5000,
    });
    expect(r.pass).toBe(false);
    const o = readOutcome(dir);
    expect(o.spawnError).toBeTruthy();
    expect(o.exitCode).not.toBe(0);
  });

  it("a passing case retains evidence too", async () => {
    const dir = freshDir();
    const r = await runCaseIsolated({
      nodeExe: process.execPath, harnessPath: RUNNER, name: "ok", dir, timeoutMs: 5000,
    });
    expect(r.pass).toBe(true);
    expect(r.evidence?.persisted).toBe(true);
    const o = readOutcome(dir);
    expect(o.pass).toBe(true);
    expect(o.exitCode).toBe(0);
    expect(readFileSync(join(dir, "runner.stdout.txt"), "utf8")).toContain("RESULT:");
  });
});

// selectCases: exact --cases <csv> selection for the parent harness —
// absent means the full list; empty or unknown names refuse loudly.
// Regressions pin the semantics without faking any Windows behavior.
describe("selectCases", () => {
  const LIST: Array<[string, number]> = [
    ["terminal-capability-advertised", 15000],
    ["input-echo-and-ctrl-c", 90000],
    ["stop-request-forces-teardown", 90000],
  ];

  it("absent selection returns the full list unchanged", () => {
    expect(selectCases(LIST, null)).toBe(LIST);
    expect(selectCases(LIST, undefined)).toBe(LIST);
  });

  it("exact Ctrl-C diagnostic selects exactly one case with its timeout", () => {
    const out = selectCases(LIST, "input-echo-and-ctrl-c");
    expect(out).toEqual([["input-echo-and-ctrl-c", 90000]]);
  });

  it("selection keeps CASE_LIST order, not argv order", () => {
    const out = selectCases(
      LIST,
      "stop-request-forces-teardown,input-echo-and-ctrl-c",
    );
    expect(out.map(([n]) => n)).toEqual([
      "input-echo-and-ctrl-c",
      "stop-request-forces-teardown",
    ]);
  });

  it("empty selection refuses", () => {
    expect(() => selectCases(LIST, "")).toThrow(/empty/);
    expect(() => selectCases(LIST, "  , ,")).toThrow(/empty/);
  });

  it("unknown names refuse and list the valid set", () => {
    expect(() => selectCases(LIST, "input-echo-and-ctrl-c,nope")).toThrow(
      /unknown case name\(s\): nope/,
    );
    expect(() => selectCases(LIST, "ctrl-c")).toThrow(/unknown/);
  });
});
