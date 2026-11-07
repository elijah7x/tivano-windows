#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// OFFLINE application-layer validation of the PACKAGED job-helper path.
//
//   node scripts/windows/packaged-job-test.mjs
//     --exe <packaged "Tivano Windows Dev.exe">
//     --launcher <fresh codex-launcher.exe>
//     --evidence <fresh dir>
//     [--deadline-ms <ms>]
//
// Runs ONLY on a real win32/x64 host — refuses before touching anything
// else. This exercises the REAL packaged chain end to end:
//
//   Electron main → CodexAppServerProvider → tivano-job-helper.exe
//     → Windows Job Object → codex.exe (test launcher)
//       → grandchildren (Job members) → Job teardown on helper/owner death
//
// The launcher (tests/windows/codex-launcher.cpp, built by
// build-job-helper.ps1, NEVER shipped) speaks the pinned Codex
// app-server JSONL protocol offline — no model, no credentials, no
// network. Environment is whitelisted like packaged-smoke; provider
// variables are set DELIBERATELY (TIVANO_PROVIDER=codex +
// TIVANO_CODEX_EXECUTABLE=staged codex.exe) — this is the first real-mode
// launch, still offline because the executable IS the fixture.
//
// Covered: byte-level protocol session, approval resolve, interrupt,
// descendant liveness + Job teardown on helper kill, owner (app) death
// reaping the whole tree, resume across app restart, Unicode/space paths
// (exe path, workspace root, data root), cleanup evidence per identity.
// A case whose cleanup evidence cannot be proven STOPS the suite —
// never reported as pass.
//
// NOT covered here (recorded honestly): real Codex CLI, authentication,
// model inference, install/uninstall, signing, standard-user Windows 10/11.

import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { awaitExit, boundedClose } from "../closeBound.mjs";
import { resolveOutputDir, sha256File } from "../lib/package-plan.mjs";
import { IdentityTracker, queryWindowsProcess, sleep } from "../../tests/windows/harness-control.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const APP_EXE_NAME = "Tivano Windows Dev.exe";
const HELPER_REL = join("resources", "job-helper", "tivano-job-helper.exe");
const ASAR_REL = join("resources", "app.asar");
const ASAR_MANIFEST = "dist/job-helper-manifest.json";
const DEFAULT_DEADLINE_MS = 8 * 60_000;

// ---------------------------------------------------------------------------
// Hard gate FIRST — refuse wrong platform/arch before ANY mutation.
// ---------------------------------------------------------------------------
if (process.platform !== "win32" || process.arch !== "x64") {
  console.error(
    `packaged-job-test: NOT RUN — requires a Windows x64 host ` +
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
const launcher = flag("--launcher");
const evidence = flag("--evidence");
const deadlineMs = Number(flag("--deadline-ms") ?? DEFAULT_DEADLINE_MS);
if (!exe || !launcher || !evidence || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 10 * 60_000) {
  console.error(
    "usage: packaged-job-test.mjs --exe <packaged exe> --launcher <codex-launcher.exe> --evidence <fresh dir> [--deadline-ms N]",
  );
  process.exit(2);
}
const exeAbs = resolve(exe);
const launcherAbs = resolve(launcher);
for (const [n, p] of [["--exe", exeAbs], ["--launcher", launcherAbs]]) {
  if (!existsSync(p)) {
    console.error(`packaged-job-test: ${n} does not exist: ${p}`);
    process.exit(2);
  }
}
const installDir = dirname(exeAbs);
let outDir;
try {
  outDir = resolveOutputDir(evidence, ROOT);
} catch (e) {
  console.error(`packaged-job-test: ${e.message ?? e}`);
  process.exit(2);
}

// ---- reporting ------------------------------------------------------------
const results = [];
const pageErrors = [];
const exits = [];
const known = new Map();
const remember = (id) => {
  if (id && Number.isSafeInteger(id.pid) && /^[1-9]\d*$/.test(id.ticks ?? "")) known.set(`${id.pid}:${id.ticks}`, id);
  return id;
};
const owned = []; // app ChildProcess handles — teardown only through these
let abortSuite = false; // a cleanup-evidence failure stops everything later
const deadline = Date.now() + deadlineMs;
const left = () => Math.max(0, deadline - Date.now());
const check = (name, ok, detail = "") => {
  results.push({ name, ok: ok === true, detail: String(detail).slice(0, 600) });
  console.log(`${ok === true ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
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

// ---- helper/package attestation (same bytes the build pinned) --------------
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
  console.error(`packaged-job-test: cannot read ${ASAR_MANIFEST} inside app.asar: ${e.message}`);
  process.exit(2);
}
if (
  pinnedManifest?.schema !== "tivano-windows-job-helper-manifest/1" ||
  pinnedManifest.file !== "tivano-job-helper.exe" ||
  !/^[0-9a-f]{64}$/.test(pinnedManifest.sha256 ?? "")
) {
  console.error("packaged-job-test: job-helper manifest inside the package failed contract validation");
  process.exit(2);
}
if (!existsSync(helperAbs)) {
  console.error(`packaged-job-test: packaged job-helper missing: ${helperAbs}`);
  process.exit(2);
}
const helperSha = sha256File(helperAbs);
if (helperSha !== pinnedManifest.sha256) {
  console.error(
    `packaged-job-test: packaged helper hash ${helperSha} != manifest ${pinnedManifest.sha256} — refusing to test an unattested helper`,
  );
  process.exit(2);
}
console.log(`helper attested: sha256=${helperSha.slice(0, 16)}… version=${pinnedManifest.helperVersion}`);

// ---- isolated task dirs — Unicode + spaces are PART of the test ------------
const taskRoot = mkdtempSync(join(tmpdir(), "tivano-pkgjob 测试 "));
const stageDir = join(taskRoot, "bin dir 目录");
const stagedCodex = join(stageDir, "codex.exe"); // basename pinned by validateCodexExecutable
const dataRoot = join(taskRoot, "data root");
const workspaceRoot = join(taskRoot, "工作 space root");
mkdirSync(stageDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
copyFileSync(launcherAbs, stagedCodex);
const codexHome = join(dataRoot, "codex-home");
const markerDir = join(codexHome, "fixture-state", "markers");
const launcherMarker = join(markerDir, "launcher.json");
const descendantsMarker = join(markerDir, "descendants.txt");
console.log(`staged codex : ${stagedCodex}`);
console.log(`data root    : ${dataRoot}`);
console.log(`workspace    : ${workspaceRoot}`);
console.log(`evidence     : ${outDir}`);

// Environment: same whitelist as packaged-smoke, plus the DELIBERATE
// provider configuration this test exists to exercise.
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
childEnv.TIVANO_PROVIDER = "codex";
childEnv.TIVANO_CODEX_EXECUTABLE = stagedCodex;
childEnv.TIVANO_WORKSPACE_ROOT = workspaceRoot;
// Intentionally absent: TIVANO_CODEX_JOB_HELPER — an env file must never
// mint support; the packaged attestation path is the only route.

// ---- Windows process-identity helpers --------------------------------------
const identities = new IdentityTracker(queryWindowsProcess);
const identsAlive = (idents) => identities.checkIdents(idents);
/** Bounded wait until EVERY recorded identity is confirmed gone. */
const waitAllDead = async (idents, ms, label, cleanup = false) => {
  const end = Date.now() + (cleanup ? ms : Math.min(ms, left()));
  let last = { verdict: "unknown" };
  while (Date.now() < end) {
    last = await identsAlive(idents);
    if (last.verdict === "all-dead") return { ok: true, last };
    await sleep(150);
  }
  return { ok: false, last };
};
const parentPidOf = (pid) => {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ],
      { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ).trim();
    const n = Number(out);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};
const readIdents = (file) => {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("PID:"))
      .map((l) => {
        const [, pid, ticks] = l.split(":");
        return { pid: Number(pid), ticks };
      })
      .filter((x) => Number.isSafeInteger(x.pid) && x.pid > 0 && x.ticks);
  } catch {
    return [];
  }
};
const readLauncherMarker = () => {
  try {
    const m = JSON.parse(readFileSync(launcherMarker, "utf8").trim());
    if (Number.isSafeInteger(m?.pid) && m.creationTimeQuad != null)
      return { pid: m.pid, ticks: String(m.creationTimeQuad), exe: m.exe, cwd: m.cwd };
  } catch { /* not materialized yet */ }
  return null;
};
const waitFile = async (file, pred, ms, what) => {
  const end = Date.now() + Math.min(ms, left());
  let last = null;
  while (Date.now() < end) {
    last = file === launcherMarker ? readLauncherMarker() : readIdents(file);
    if (pred(last)) return last;
    await sleep(120);
  }
  return null;
};
const killKnown = (id) => {
  if (!id || !Number.isSafeInteger(id.pid) || !/^[1-9]\d*$/.test(id.ticks)) return false;
  try {
    execFileSync(launcherAbs, ["--kill-known", String(id.pid), id.ticks], {
      timeout: 8000, stdio: "ignore", windowsHide: true,
    });
    return true;
  } catch { return false; }
};
const helperIdentity = async (launcherId) => {
  const pid = launcherId ? parentPidOf(launcherId.pid) : null;
  if (!pid) return null;
  const q = await queryWindowsProcess(pid);
  return q.status === "alive" ? remember({ pid, ticks: q.ticks }) : null;
};

// Capture Chromium descendants while the owned main process is still alive.
// Creation identities are retained before abnormal owner termination; later
// cleanup never discovers/adopts a new identity for a historical PID.
const captureAppChildren = (proc) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return [];
  const script = `$ErrorActionPreference='Stop'; $root=Get-Process -Id ${proc.pid};
    $born=$root.StartTime.ToFileTimeUtc(); $all=@(Get-CimInstance Win32_Process);
    $ids=@(${proc.pid}); $out=@();
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

// ---- playwright driving -----------------------------------------------------
const snap = (page) => bounded(page.evaluate(() => window.tivano.invoke("state:get", {})), "state:get");
const waitSnap = async (page, pred, ms) => {
  const end = Date.now() + Math.min(ms, left());
  let last;
  while (Date.now() < end) {
    last = await snap(page);
    if (pred(last)) return last;
    await sleep(120);
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
  owned.push({ label, proc, inst });
  // Playwright 1.64 uses shell:true on Windows: inst.process() owns cmd.exe,
  // not necessarily Electron. Capture the actual main identity while alive.
  const main = await bounded(inst.evaluate(() => ({ pid: process.pid, exe: process.execPath })), `${label} main identity`);
  if (!Number.isSafeInteger(main?.pid) || main.pid <= 0 ||
      typeof main.exe !== "string" || resolve(main.exe).toLowerCase() !== exeAbs.toLowerCase())
    throw new Error("Electron main identity did not match the launched executable");
  const mainQuery = await queryWindowsProcess(main.pid);
  if (mainQuery.status !== "alive") throw new Error("Electron main creation identity unavailable");
  const mainIdentity = remember({ pid: main.pid, ticks: mainQuery.ticks });
  owned[owned.length - 1].mainIdentity = mainIdentity;
  check(`${label} actual Electron main identity captured`, true,
    `mainPid=${main.pid} launcherPid=${proc.pid} ticks=${mainIdentity.ticks}`);
  const page = await bounded(inst.firstWindow(), `${label} firstWindow`);
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.setDefaultTimeout(Math.max(1, Math.min(15000, left())));
  return { inst, proc, page, mainIdentity };
};
const turnOf = (s, tid) => s.threads.find((t) => t.id === tid)?.turn;
const sendTurn = (page, tid, text) =>
  bounded(page.evaluate(
    ({ threadId, text }) => window.tivano.invoke("turns:send", { threadId, text }),
    { threadId: tid, text },
  ), "turns:send");

const startedAt = new Date().toISOString();
try {
  // ============================== RUN 1 =====================================
  const r1 = await launch("run-1");
  const { page } = r1;
  check("packaged window launched",
    await page.waitForSelector(".sidebar-head", { timeout: Math.min(20000, left()) }).then(() => true).catch(() => false));
  const project = await bounded(
    page.evaluate(() => window.tivano.invoke("projects:create", { name: "packaged-job" })),
    "projects:create",
  );
  const projectId = project?.id ?? null;
  check("project created", Boolean(projectId), `id=${projectId}`);
  const thread = await bounded(
    page.evaluate((pid) => window.tivano.invoke("threads:create", { projectId: pid }), projectId),
    "threads:create",
  );
  const threadId = thread?.id ?? null;
  check("thread created", Boolean(threadId), `id=${threadId}`);
  await bounded(page.evaluate((id) => window.tivano.invoke("threads:select", { id }), threadId), "threads:select");

  // -- scenario 1: byte-level protocol session through the helper ----------
  await sendTurn(page, threadId, "hello through the packaged job helper");
  const s1 = await waitSnap(page, (s) => {
    const st = turnOf(s, threadId)?.status;
    return ["done", "failed", "cancelled", "interrupted"].includes(st);
  }, 30000);
  check("normal turn completes through job-helper (JSONL protocol)",
    turnOf(s1, threadId)?.status === "done",
    `status=${turnOf(s1, threadId)?.status}`);

  const originalBinding = s1.threads.find((t) => t.id === threadId)?.providerThread?.codexThreadId;
  check("provider thread binding persisted", typeof originalBinding === "string" && originalBinding.length > 0);

  // Launcher + helper identities — recorded BEFORE any teardown act.
  const lm = await waitFile(launcherMarker, (m) => m !== null, 10000, "launcher marker");
  const hasUnicodeSpace = (s) =>
    typeof s === "string" && /[⺀-鿿]/.test(s) && s.includes(" ");
  check("launcher identity marker: pid+creation stamp AND unicode/space exe+cwd paths",
    lm !== null && hasUnicodeSpace(lm.exe) && hasUnicodeSpace(lm.cwd),
    lm ? `pid=${lm.pid} exe=${lm.exe} cwd=${lm.cwd}` : "marker missing");
  const launcherId = remember(lm ? { pid: lm.pid, ticks: lm.ticks } : null);
  const helperId = await helperIdentity(launcherId);
  const helperPid = helperId?.pid;
  check("job-helper identity discovered and verified alive",
    helperId !== null, `helperPid=${helperPid}`);
  if (launcherId) {
    const live = await identsAlive([launcherId]);
    check("launcher alive under the Job before teardown",
      live.verdict === "living", `verdict=${live.verdict}`);
  }

  await sendTurn(page, threadId, "slow streaming content through the packaged helper");
  const streaming = await waitSnap(page, (s) => {
    const t = s.threads.find((t) => t.id === threadId);
    return t?.turn?.status === "running" && t.messages.some((m) =>
      m.id === t.turn.assistantMessageId && m.content.length > 0);
  }, 15000);
  const st = streaming.threads.find((t) => t.id === threadId);
  check("streamed content visible before completion", st?.turn?.status === "running" &&
    st.messages.some((m) => m.id === st.turn.assistantMessageId && m.content.length > 0));
  const streamedDone = await waitSnap(page, (s) => turnOf(s, threadId)?.status === "done", 15000);
  check("streamed turn completes", turnOf(streamedDone, threadId)?.status === "done");
  await bounded(page.screenshot({ path: join(outDir, "job-01-streamed.png") }), "stream screenshot");

  // -- scenario 2: approval round-trip -------------------------------------
  if (!abortSuite) {
    await sendTurn(page, threadId, "please approval this command");
    const s2 = await waitSnap(page, (s) => {
      const t = turnOf(s, threadId);
      return t?.status === "waiting-approval" && t.approval?.status === "pending";
    }, 20000);
    const approval = turnOf(s2, threadId)?.approval;
    check("approval request surfaced from helper-proxied protocol",
      approval?.status === "pending", `status=${approval?.status}`);
    await bounded(page.screenshot({ path: join(outDir, "job-02-approval.png") }), "approval screenshot");
    if (approval?.id) {
      await bounded(
        page.evaluate(
          (a) => window.tivano.invoke("approvals:resolve", a),
          { threadId, approvalId: approval.id, optionId: "once" },
        ),
        "approvals:resolve",
      );
      const s2b = await waitSnap(page, (s) =>
        turnOf(s, threadId)?.status === "done" &&
          turnOf(s, threadId)?.approval?.status === "resolved",
        20000);
      check("approved turn completes after client decision",
        turnOf(s2b, threadId)?.status === "done");
    }
  }

  // -- scenario 3: interruption --------------------------------------------
  if (!abortSuite) {
    await sendTurn(page, threadId, "sleep until I interrupt you");
    const running = await waitSnap(page, (s) => {
      const st = turnOf(s, threadId)?.status;
      return st === "running" || ["done", "failed", "cancelled", "interrupted"].includes(st);
    }, 15000);
    check("sleep turn observed running", turnOf(running, threadId)?.status === "running",
      `status=${turnOf(running, threadId)?.status}`);
    await bounded(page.evaluate((t) => window.tivano.invoke("turns:cancel", { threadId: t }), threadId), "turns:cancel");
    const s3 = await waitSnap(page, (s) => {
      const st = turnOf(s, threadId)?.status;
      return ["done", "failed", "cancelled", "interrupted"].includes(st);
    }, 15000);
    check("interrupted turn settles honestly",
      ["cancelled", "interrupted"].includes(turnOf(s3, threadId)?.status),
      `status=${turnOf(s3, threadId)?.status}`);
  }

  // -- scenario 4: descendants + helper kill = Job teardown ----------------
  if (!abortSuite) {
    // Fresh descendants.txt baseline — this turn appends two new lines.
    const before = readIdents(descendantsMarker).length;
    await sendTurn(page, threadId, "descendant spawn please");
    const s4 = await waitSnap(page, (s) => {
      const st = turnOf(s, threadId)?.status;
      return ["done", "failed", "cancelled", "interrupted"].includes(st);
    }, 30000);
    check("descendant turn completes", turnOf(s4, threadId)?.status === "done",
      `status=${turnOf(s4, threadId)?.status}`);
    const idents = await waitFile(descendantsMarker, (l) => l.length >= before + 2, 10000, "descendant markers");
    const fresh = (idents ?? []).slice(before);
    fresh.forEach(remember);
    check("two grandchildren recorded with creation identities",
      fresh.length >= 2, `fresh=${fresh.length}`);
    const alive = await identsAlive(fresh);
    check("grandchildren provably ALIVE after turn completion (Job holds them, not the payload)",
      alive.verdict === "living" && alive.living.length === fresh.length,
      `verdict=${alive.verdict}`);

    // Kill ONLY the helper — Job handle close must reap launcher+tree.
    const killed = killKnown(helperId);
    check("helper kill requested", killed, `helperPid=${helperId?.pid}`);
    const tree = [helperId, launcherId, ...fresh].filter(Boolean);
    const gone = await waitAllDead(tree, 20000, "job teardown");
    check("helper death reaped the ENTIRE job tree (launcher + grandchildren)",
      gone.ok, `verdict=${gone.last.verdict} living=${(gone.last.living ?? []).join(",")}`);
    if (!gone.ok) { abortSuite = true; throw new Error("job cleanup unconfirmed"); }
    const s4b = await waitSnap(page, (s) => {
      const t = turnOf(s, threadId);
      return !t || ["done", "failed", "cancelled", "interrupted"].includes(t.status);
    }, 15000);
    check("app surfaces helper death honestly (no stuck turn)",
      !turnOf(s4b, threadId) || turnOf(s4b, threadId)?.status !== "running");
  }

  // -- scenario 5: fresh thread re-spawns the helper chain -----------------
  if (!abortSuite) {
    const t2 = await bounded(
      page.evaluate((pid) => window.tivano.invoke("threads:create", { projectId: pid }), projectId),
      "threads:create #2",
    );
    const thread2 = t2?.id ?? null;
    if (thread2) {
      await sendTurn(page, thread2, "hello again after helper death");
      const s5 = await waitSnap(page, (s) => {
        const st = turnOf(s, thread2)?.status;
        return ["done", "failed", "cancelled", "interrupted"].includes(st);
      }, 30000);
      check("new thread respawns helper+payload cleanly after teardown",
        turnOf(s5, thread2)?.status === "done",
        `status=${turnOf(s5, thread2)?.status}`);
    } else {
      check("second thread created", false, "threads:create returned no id");
    }
  }

  // -- clean close (shutdown path through the helper-backed transport) -----
  if (!abortSuite) {
    const run1Children = captureAppChildren(r1.proc);
    const res = await boundedClose(r1.inst, r1.proc, {
      closeMs: Math.min(25000, left()),
      exitMs: Math.min(20000, left()),
      killWaitMs: 8000,
    });
    exits.push({ label: "run-1", ...res });
    check("run-1 exits cleanly (provider disposal through helper transport)",
      res.exited === true && res.outcome === "resolved" && res.exitCode === 0 && !res.killed,
      `outcome=${res.outcome} code=${res.exitCode} killed=${res.killed}`);
    const cleanTree = await waitAllDead(run1Children, 10000, "clean-close tree");
    check("clean close reaped every captured app descendant", cleanTree.ok);
    if (!cleanTree.ok || !res.exited || res.killed || res.outcome !== "resolved") {
      abortSuite = true; throw new Error("clean close failed; no next launch");
    }
  }

  // ============================== RUN 2 =====================================
  if (!abortSuite) {
    const r2 = await launch("run-2");
    const { page: page2 } = r2;
    await page2.waitForSelector(".sidebar-head", { timeout: Math.min(20000, left()) });
    const snap2 = await waitSnap(page2, (s) => s.threads.some((t) => t.id === threadId), 15000);
    check("run-2 restores persisted thread", snap2.threads.some((t) => t.id === threadId));
    await bounded(page2.evaluate((id) => window.tivano.invoke("threads:select", { id }), threadId), "threads:select");
    await sendTurn(page2, threadId, "hello resumed thread");
    const s6 = await waitSnap(page2, (s) => {
      const st = turnOf(s, threadId)?.status;
      return ["done", "failed", "cancelled", "interrupted"].includes(st);
    }, 30000);
    check("resumed session completes a turn (fixture state survived restart)",
      turnOf(s6, threadId)?.status === "done",
      `status=${turnOf(s6, threadId)?.status}`);

    check("resume retained the original provider thread identity",
      s6.threads.find((t) => t.id === threadId)?.providerThread?.codexThreadId === originalBinding);

    // Owner (app) abnormal death — the whole Job tree must be reaped.
    const before2 = readIdents(descendantsMarker).length;
    await sendTurn(page2, threadId, "descendant spawn round two");
    const s7 = await waitSnap(page2, (s) => {
      const st = turnOf(s, threadId)?.status;
      return ["done", "failed", "cancelled", "interrupted"].includes(st);
    }, 30000);
    check("run-2 descendant turn completes", turnOf(s7, threadId)?.status === "done");
    const idents2 = (await waitFile(descendantsMarker, (l) => l.length >= before2 + 2, 10000, "descendant markers 2")) ?? [];
    const fresh2 = idents2.slice(before2);
    fresh2.forEach(remember);
    check("run-2 records both grandchildren", fresh2.length === 2);
    const lm2 = await waitFile(launcherMarker, (m) => m !== null && m.pid !== (launcherId?.pid ?? -1), 10000, "launcher marker 2");
    const launcher2 = remember(lm2 ? { pid: lm2.pid, ticks: lm2.ticks } : null);
    const helper2 = await helperIdentity(launcher2);
    check("run-2 records launcher and helper identities", !!launcher2 && !!helper2);
    const tree2 = [helper2, launcher2, ...fresh2].filter(Boolean);
    const live2 = await identsAlive(fresh2);
    check("run-2 grandchildren alive before owner death", live2.verdict === "living" && live2.living.length === 2);

    // Kill ONLY the app main process — owner death must trigger helper
    // exit → Job close → every member gone.
    captureAppChildren(r2.proc);
    const ownerMatches = helper2 && parentPidOf(helper2.pid) === r2.mainIdentity.pid;
    check("helper owner is the actual Electron main", ownerMatches === true,
      `mainPid=${r2.mainIdentity.pid} launcherPid=${r2.proc.pid}`);
    if (!ownerMatches) throw new Error("helper owner identity did not match Electron main");
    const appKilled = killKnown(r2.mainIdentity);
    check("app (owner) kill requested", appKilled, `pid=${r2.mainIdentity.pid} ticks=${r2.mainIdentity.ticks}`);
    if (!appKilled) throw new Error("actual Electron main termination unconfirmed");
    const gone2 = await waitAllDead([r2.mainIdentity, ...tree2], 25000, "owner-death teardown");
    check("owner death reaped the ENTIRE job tree (helper exit → job close)",
      gone2.ok, `verdict=${gone2.last.verdict}`);
    if (!gone2.ok) { abortSuite = true; throw new Error("owner-death job cleanup unconfirmed"); }
    const appGone = await awaitExit(r2.proc, 10000);
    exits.push({ label: "run-2-owner-kill", exited: appGone, pid: r2.proc.pid });
    check("run-2 app process observed exited", appGone === true);
    // Renderer/GPU children may outlive the killed browser process —
    // let playwright settle its tracked children, then the owned-handle
    // sweep in `finally` covers anything left.
    await bounded(r2.inst.close().catch(() => {}), "run-2 inst.close").catch(() => {});
  }
} catch (e) {
  check("suite completed without harness exception", false, String(e?.stack ?? e).slice(0, 500));
} finally {
  // Owned handles only — explicit pids we launched, never a name sweep.
  for (const { proc } of owned) {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try { captureAppChildren(proc); } catch (e) { check("cleanup child inventory", false, e.message); }
      try { proc.kill("SIGKILL"); } catch { /* observed exit below decides */ }
      const confirmed = await awaitExit(proc, 5000);
      exits.push({ label: "cleanup-kill", exited: confirmed, pid: proc.pid });
    }
  }
}

check("no renderer errors", pageErrors.length === 0, pageErrors.join("; "));
const cleanupIdentities = [...known.values()];
const natural = await waitAllDead(cleanupIdentities, 5000, "final descendants", true);
let forced = false;
if (!natural.ok) {
  for (const id of cleanupIdentities) {
    const q = await queryWindowsProcess(id.pid);
    if (q.status === "alive" && q.ticks === id.ticks) {
      forced = true; killKnown(id);
    }
  }
}
const finalTree = await waitAllDead(cleanupIdentities, 5000, "final cleanup", true);
check("all recorded descendants confirmed gone", finalTree.ok, `forcedCleanup=${forced}`);
// Chromium processes may need cleanup after intentionally killing their owner;
// Job tree cleanup was independently required BEFORE this fallback.
const allExited = finalTree.ok && (
  owned.length === 0 ||
  owned.every(({ proc }) => proc && (proc.exitCode !== null || proc.signalCode !== null)));
const ok = results.length > 0 && results.every((r) => r.ok) && allExited && !abortSuite;
const report = {
  schema: "tivano-windows-packaged-job/1",
  startedAt,
  finishedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch },
  exe: exeAbs,
  installDir,
  helper: { path: helperAbs, sha256: helperSha, pinned: pinnedManifest },
  stagedCodex,
  dataRoot,
  workspaceRoot,
  results,
  pageErrors,
  exits,
  allExited,
  appIdentities: owned.map(({ label, proc, mainIdentity }) => ({ label, launcherPid: proc.pid, mainIdentity })),
  processIdentities: cleanupIdentities,
  finalTree,
  forcedCleanup: forced,
  abortedOnCleanupEvidence: abortSuite,
  ok,
  note:
    "offline packaged application-layer test — Codex app-server protocol " +
    "fixture as payload through the REAL packaged job-helper. Real CLI, " +
    "authentication and inference remain NOT RUN.",
};
writeFileSync(join(outDir, "packaged-job.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} checks passed — report: ${join(outDir, "packaged-job.json")}`,
);
// Preserve the task dir on ANY failure or unproven exit — evidence stays.
if (ok) rmSync(taskRoot, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
