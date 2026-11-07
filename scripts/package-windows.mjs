#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Internal, unsigned Windows x64 development packaging pipeline.
//
//   node scripts/package-windows.mjs --plan  --evidence <dir>
//   node scripts/package-windows.mjs --build --output <fresh external dir>
//        [--source-manifest <frozen-manifest.json>] [--terminal-candidate]
//   node scripts/package-windows.mjs --freeze-source-manifest --output <file>
//
// --plan  : validate config (REAL schema + policy), dist payload,
//           win32-x64 node-pty runtime, dependency presence, source
//           state → build-plan.json. Safe on ANY host. NEVER implies a
//           Windows build or Windows validation.
// --build : real package build. Refuses outright unless running on a
//           win32/x64 host — checked before any output mutation.
//           electron-builder runs as a bounded CHILD process (env
//           sanitized, timeout enforced — an in-process await cannot
//           enforce either). Source input is hashed BEFORE the build
//           and verified unchanged afterwards; with no .git a frozen
//           --source-manifest is required, otherwise the build refuses
//           an unverifiable identity. Two targets: unpacked dir + a
//           per-user NSIS installer, both unsigned. Post-build the
//           unpacked tree + ASAR are inspected for required/forbidden
//           content and hashed into the manifest.
//           --terminal-candidate bakes the Windows terminal VALIDATION
//           CANDIDATE flag into the main bundle (compile-time only —
//           recorded in the build manifest; ordinary builds stay off).
// --freeze-source-manifest: record the CURRENT source set
//           (commit + per-file sha256) as the manifest a .git-less
//           source archive must carry into a Cloud/host build.
//
// Never uses --publish, never discovers certificates, never installs
// or launches the produced package.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PackagingError,
  JOB_HELPER_MANIFEST_SCHEMA,
  REQUIRED_ASAR_ENTRIES,
  REQUIRED_WIN_PTY_FILES,
  assertWindowsX64Host,
  enumerateSourceInput,
  hashArtifacts,
  hashTree,
  inspectBuiltOutput,
  planChecks,
  resolveOutputDir,
  runBounded,
  readGeneratedJson,
  sha256File,
  verifySourceUnchanged,
} from "./lib/package-plan.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = join(ROOT, "config", "windows-dev-builder.cjs");
const BUILDER_CLI = join(ROOT, "node_modules", "electron-builder", "cli.js");
const DIST_BUILD_MS = 10 * 60_000;
const BUILDER_MS = 30 * 60_000;
const HELPER_BUILD_MS = 10 * 60_000;
const HELPER_BUILD_SCRIPT = join(ROOT, "scripts", "build-job-helper.ps1");
const HELPER_STAGE_DIR = join(ROOT, "dist", "job-helper");

// Env vars the builder child must NOT see: any cert material (no signing
// autodiscovery), publish tokens, provider/credential settings.
const STRIP_ENV = [
  /^CSC_/i, /^WIN_CSC_/i, /^APPLE_/i, /^GH_TOKEN/i, /^GITHUB_TOKEN/i,
  /^PUBLISH/i, /^TIVANO_PROVIDER/i, /^TIVANO_CODEX/i, /^TIVANO_SYNTHETIC/i,
  /^CODEX/i, /^SYNTHETIC/i, /^OPENAI/i, /^ANTHROPIC/i, /^GOOGLE_/i,
  /^AWS_/i, /^AZURE_/i,
];

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP_ENV.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  // Hard-off certificate autodiscovery AND any inherited sign overrides —
  // this package is unsigned by design.
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  env.ELECTRON_BUILDER_CACHE = join(
    process.env.TMPDIR ?? process.env.TMP ?? "/tmp",
    "tivano-electron-builder-cache",
  );
  return env;
}

function git(args) {
  const r = (() => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return null;
    }
  })();
  return r;
}

function sourceState() {
  const commit = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const modified = git(["ls-files", "-m", "-d", "-z"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = modified === null || untracked === null ? null
    : [...new Set((modified + untracked).split("\0").filter(Boolean))];
  const dirty = paths === null ? null : paths.length > 0;
  const lockHash = existsSync(join(ROOT, "package-lock.json"))
    ? sha256File(join(ROOT, "package-lock.json"))
    : null;
  return {
    commit,
    dirty,
    // Uncommitted work is not a build refusal for an INTERNAL package —
    // it is recorded so the artifact can never be mistaken for a clean
    // baseline build. The authoritative binding is the input hash in the
    // build manifest, computed from the real file inventory.
    modifiedPaths: paths ?? [],
    lockfileSha256: lockHash,
  };
}

const require = createRequire(import.meta.url);
function runtimeVersions() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const dep = (n) => {
    try {
      return require(`${n}/package.json`).version;
    } catch {
      return pkg.dependencies?.[n] ?? pkg.devDependencies?.[n] ?? null;
    }
  };
  return {
    node: process.version,
    electron: dep("electron"),
    "electron-builder": dep("electron-builder"),
    "node-pty": dep("node-pty"),
    esbuild: dep("esbuild"),
    react: dep("react"),
    typescript: dep("typescript"),
    vitest: dep("vitest"),
  };
}

function writeJson(dir, name, obj) {
  writeFileSync(join(dir, name), JSON.stringify(obj, null, 2) + "\n");
}

// ---- modes ------------------------------------------------------------------

function modePlan(evidenceDir) {
  const outDir = resolveOutputDir(evidenceDir, ROOT);
  const { checks: done } = planChecks(ROOT, CONFIG_PATH, { distPresent: true });
  const failed = done.filter((c) => !c.ok);
  const plan = {
    schema: "tivano-windows-build-plan/1",
    generatedAt: new Date().toISOString(),
    mode: "plan-only",
    host: { platform: process.platform, arch: process.arch },
    target: { os: "windows", arch: "x64" },
    unsigned: true,
    internal: true,
    source: sourceState(),
    versions: runtimeVersions(),
    checks: done,
    ok: failed.length === 0,
    caveat:
      process.platform !== "win32"
        ? "plan validated on non-Windows host — this is NOT a Windows build and NOT Windows validation"
        : "plan only — no artifact produced",
  };
  writeJson(outDir, "build-plan.json", plan);
  for (const c of done) console.log(`[${c.ok ? "ok" : "FAIL"}] ${c.name}`);
  if (failed.length > 0) {
    console.error(`plan failed: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`plan ok — build-plan.json written to ${outDir}`);
}

function modeFreezeManifest(outFile) {
  const input = enumerateSourceInput(ROOT); // git mode on a real checkout
  const doc = {
    schema: "tivano-windows-source-manifest/1",
    generatedAt: new Date().toISOString(),
    commit: input.commit,
    dirty: input.dirty,
    fileCount: input.fileCount,
    sourceDigest: input.sourceDigest,
    files: input.files,
    note: "frozen source identity — carry this next to a .git-less archive; --build refuses when neither .git nor this manifest is supplied",
  };
  writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n", { flag: "wx" });
  console.log(`source manifest: ${input.fileCount} files → ${outFile}`);
}

/** Post-build inspection: the artifacts that MUST exist and the
 *  deterministic content manifest of the unpacked runtime. Fails the
 *  build (failure.json) on any violation — never reports success on a
 *  half-written output. */

async function modeBuild(outCandidate, sourceManifestPath, terminalCandidate = false) {
  // Guard FIRST — before output-dir creation or any build mutation.
  assertWindowsX64Host();
  const outDir = resolveOutputDir(outCandidate, ROOT);
  const startedAt = new Date().toISOString();
  const env = cleanEnv();
  const executedChecks = [];
  const failure = (stage, detail) => {
    try {
      writeJson(outDir, "failure.json", {
        schema: "tivano-windows-build-failure/1",
        stage,
        detail,
        at: new Date().toISOString(),
        host: { platform: process.platform, arch: process.arch },
        outputDir: outDir, // partial output preserved for diagnosis
        source: sourceState(),
      });
    } catch {
      /* even the failure record can fail — the exit code still refuses */
    }
    console.error(`packaging failed at ${stage}: ${JSON.stringify(detail).slice(0, 3000)}`);
    process.exit(1);
  };

  try {
    // Stage 0: bind the build to the REAL input set BEFORE anything runs.
    const before = enumerateSourceInput(ROOT, { manifestPath: sourceManifestPath });
    before.manifestPath = sourceManifestPath ?? null;
    executedChecks.push({
      name: "source-binding-before",
      mode: before.mode,
      commit: before.commit,
      fileCount: before.fileCount,
      sourceDigest: before.sourceDigest,
    });

    // Stage 1: bounded dist build (real child — env + timeout apply).
    // --terminal-candidate is the ONLY route to a bundle with the
    // terminal candidate literal baked in; it rides on the same real
    // build, never an environment toggle.
    const dist = await runBounded(
      process.execPath,
      [
        join(ROOT, "scripts", "build.mjs"),
        ...(terminalCandidate ? ["--terminal-candidate"] : []),
      ],
      { cwd: ROOT, env, timeoutMs: DIST_BUILD_MS },
    );
    executedChecks.push({ name: "esbuild-dist", exitCode: dist.code, timedOut: dist.timedOut, exitObserved: dist.exitObserved, terminalCandidate });
    if (dist.timedOut || dist.outputOverflow || dist.code !== 0 || !dist.exitObserved || !dist.closeObserved || dist.cleanup !== "none")
      failure("esbuild-dist", { stderrTail: dist.stderrTail.slice(-4000), ...dist });

    // Stage 1.5: the job helper is compiled FROM THIS SOURCE, on this
    // Windows host, by the pinned build script — a missing toolchain or
    // any build failure stops the build; no prebuilt/stale binary is
    // ever staged. The script requires a fresh EXTERNAL output dir, so
    // the exe is built under the OS temp root, proven by executing
    // `--version` (bounded), hashed, then staged into dist/ for
    // electron-builder's extraResources — with its identity pinned into
    // the ASAR via dist/job-helper-manifest.json.
    {
      const helperBuildDir = mkdtempSync(join(tmpdir(), "tivano-helper-build-"));
      // Windows PowerShell 5.1 is guaranteed present on the supported
      // hosts; the script carries a BOM for it.
      const ps = await runBounded(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", HELPER_BUILD_SCRIPT, "-OutDir", helperBuildDir,
        ],
        { cwd: ROOT, env, timeoutMs: HELPER_BUILD_MS, capBytes: 4 * 1024 * 1024 },
      );
      executedChecks.push({
        name: "job-helper-build",
        exitCode: ps.code,
        timedOut: ps.timedOut,
        outputOverflow: ps.outputOverflow,
        exitObserved: ps.exitObserved,
        stderrTail: ps.stderrTail.slice(-2000),
      });
      if (ps.timedOut || ps.outputOverflow || ps.code !== 0 || !ps.exitObserved || !ps.closeObserved || ps.cleanup !== "none")
        failure("job-helper-build", { stderrTail: ps.stderrTail.slice(-6000) });
      const builtExe = join(helperBuildDir, "tivano-job-helper.exe");
      const helperBuildManifest = join(helperBuildDir, "build-manifest.json");
      if (!existsSync(builtExe) || !existsSync(helperBuildManifest))
        failure("job-helper-build", { error: "expected outputs missing", dir: helperBuildDir });
      // Prove the artifact executes and reports the expected protocol
      // contract — BEFORE anything is staged.
      const ver = await runBounded(builtExe, ["--version"], {
        cwd: ROOT, env, timeoutMs: 15_000, capBytes: 64 * 1024,
      });
      let versionDoc = null;
      try {
        versionDoc = JSON.parse(String(ver.stdoutTail).trim());
      } catch { /* handled below */ }
      if (
        ver.code !== 0 || !ver.exitObserved || !ver.closeObserved ||
        ver.timedOut || ver.outputOverflow || ver.spawnError || ver.cleanup !== "none" || !versionDoc ||
        versionDoc.helper !== "tivano-job-helper" ||
        versionDoc.spec !== 1 ||
        versionDoc.diagnosticOnly !== true ||
        !Array.isArray(versionDoc.mechanisms) ||
        !versionDoc.mechanisms.includes("job-object") ||
        // The packaged helper MUST advertise the --run exit-code channel —
        // the Windows Git executor can never run against a helper that
        // lacks it, so packaging refuses to ship one.
        versionDoc.runExitBase !== 1024 ||
        versionDoc.runExitMax !== 255 ||
        // It MUST also advertise the ConPTY terminal contract — every
        // packaged helper carries --terminal; only the runtime candidate
        // gate decides whether the terminal may be exercised. A helper
        // without the contract is not this phase's binary at all.
        versionDoc.terminalSpec !== 1 ||
        !versionDoc.mechanisms.includes("conpty-terminal") ||
        !versionDoc.mechanisms.includes("proc-thread-attr-job-list") ||
        typeof versionDoc.version !== "string" || !versionDoc.version.length || versionDoc.version.length > 64
      )
        failure("job-helper-version", { stderrTail: ver.stderrTail.slice(-2000), stdoutTail: ver.stdoutTail.slice(-2000), code: ver.code });
      // Cross-check our hash against the build script's own evidence.
      const psManifest = readGeneratedJson(helperBuildManifest);
      const exeSha = sha256File(builtExe);
      const exeBytes = statSync(builtExe).size;
      if (psManifest?.outputs?.["tivano-job-helper.exe"] !== exeSha)
        failure("job-helper-identity", { ours: exeSha, script: psManifest?.outputs?.["tivano-job-helper.exe"] });
      // Stage into dist/ (extraResources source) + pin the identity into
      // the ASAR manifest the runtime verifier reads.
      mkdirSync(HELPER_STAGE_DIR, { recursive: true });
      copyFileSync(builtExe, join(HELPER_STAGE_DIR, "tivano-job-helper.exe"));
      writeJson(ROOT, join("dist", "job-helper-manifest.json"), {
        schema: JOB_HELPER_MANIFEST_SCHEMA,
        file: "tivano-job-helper.exe",
        sha256: exeSha,
        bytes: exeBytes,
        specVersion: 1,
        helperVersion: versionDoc.version,
        builtAtUtc: psManifest.builtAtUtc ?? new Date().toISOString(),
        toolchain: {
          vcToolsVersion: psManifest.vcToolsVersion ?? null,
          windowsSdkVersion: psManifest.windowsSdkVersion ?? null,
          flags: psManifest.flags ?? null,
        },
        source: { commit: before.commit, sourceDigest: before.sourceDigest },
      });
      executedChecks.push({
        name: "job-helper-identity",
        buildDir: helperBuildDir,
        buildManifest: helperBuildManifest,
        testLauncher: join(helperBuildDir, "codex-launcher.exe"),
        sha256: exeSha,
        bytes: exeBytes,
        helperVersion: versionDoc.version,
      });
    }

    // Stage 2: required payload + config + schema + dependency checks —
    // all BEFORE the builder child spawns.
    const { checks: preChecks } = planChecks(ROOT, CONFIG_PATH, { distPresent: true });
    for (const c of preChecks) executedChecks.push({ name: c.name, ok: c.ok });
    const preFail = preChecks.filter((c) => !c.ok);
    if (preFail.length > 0) failure("pre-build-validation", preFail);
    if (!existsSync(BUILDER_CLI))
      failure("builder-missing", { expected: BUILDER_CLI });
    const builderVersion = require("electron-builder/package.json").version;
    if (builderVersion !== "26.18.0")
      failure("builder-version", { expected: "26.18.0", actual: builderVersion });

    // Stage 3: electron-builder as a BOUNDED CHILD — sanitized env and
    // wall-time limits actually apply. dir + nsis x64 via committed
    // config; --publish never is hardcoded, not configurable.
    const builder = await runBounded(
      process.execPath,
      [
        BUILDER_CLI,
        "--win",
        "--x64",
        "--publish", "never",
        "--config", CONFIG_PATH,
        "-c.directories.output", outDir,
      ],
      { cwd: ROOT, env, timeoutMs: BUILDER_MS, capBytes: 4 * 1024 * 1024 },
    );
    executedChecks.push({
      name: "electron-builder",
      exitCode: builder.code,
      timedOut: builder.timedOut,
      outputOverflow: builder.outputOverflow,
      exitObserved: builder.exitObserved,
      stderrTail: builder.stderrTail.slice(-2000),
    });
    if (builder.timedOut || builder.outputOverflow || builder.code !== 0 || !builder.exitObserved || !builder.closeObserved || builder.cleanup !== "none")
      failure("electron-builder", { stderrTail: builder.stderrTail.slice(-6000), stdoutTail: builder.stdoutTail.slice(-2000) });

    // Stage 4: source unchanged since binding? Any drift → failure.
    try {
      verifySourceUnchanged(ROOT, before);
      executedChecks.push({ name: "source-binding-after", ok: true });
    } catch (e) {
      failure("source-binding-after", { error: String(e?.message ?? e) });
    }

    // Stage 5: inspect the REAL output — required artifacts, asar
    // contents, forbidden payloads, deterministic unpacked-tree hash.
    let inspected;
    try {
      inspected = inspectBuiltOutput(outDir, ROOT);
    } catch (e) {
      failure("output-inspection", { error: String(e?.message ?? e) });
    }
    executedChecks.push({
      name: "output-inspection",
      problems: inspected.problems,
      unpackedFiles: inspected.unpackedManifest?.fileCount,
      asarEntries: inspected.asarEntryCount,
    });
    if (inspected.problems.length > 0) failure("output-inspection", inspected.problems);

    // Stage 6: manifest + success marker LAST, only when everything
    // above is proven.
    const manifest = {
      schema: "tivano-windows-build-manifest/1",
      generatedAt: new Date().toISOString(),
      startedAt,
      host: { platform: process.platform, arch: process.arch },
      target: { os: "windows", arch: "x64" },
      product: { appId: "com.tivano.windows.dev", productName: "Tivano Windows Dev" },
      // Unmistakable candidate identity: this artifact was compiled with
      // the terminal validation flag. Only when true does the bundle
      // contain the TIVANO_TERMINAL_CANDIDATE literal — the packaged
      // helper must STILL attest terminalCapable at runtime.
      terminalCandidate,
      unsigned: true,
      internalDevelopmentOnly: true,
      noAutoUpdater: true,
      source: {
        commit: before.commit,
        mode: before.mode,
        fileCount: before.fileCount,
        sourceDigest: before.sourceDigest,
        files: before.files,
        lockfileSha256: sourceState().lockfileSha256,
      },
      versions: runtimeVersions(),
      artifacts: inspected.topArtifacts,
      unpackedTree: {
        fileCount: inspected.unpackedManifest.fileCount,
        totalBytes: inspected.unpackedManifest.totalBytes,
        treeDigest: inspected.unpackedManifest.treeDigest,
      },
      executedChecks,
    };
    writeJson(outDir, "build-manifest.json", manifest);
    writeFileSync(join(outDir, "BUILD-OK"), `ok ${manifest.generatedAt}\n`);
    console.log(`build ok — manifest at ${join(outDir, "build-manifest.json")}`);
  } catch (e) {
    // EVERY error after output claim produces failure.json — not only
    // PackagingError.
    failure("unhandled", { code: e?.code, message: String(e?.message ?? e) });
  }
}

// ---- entry -------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n) => args.includes(n);

try {
  if (has("--plan")) {
    const ev = flag("--evidence") ?? flag("--output");
    if (!ev) {
      console.error("usage: --plan requires --evidence <dir>");
      process.exit(2);
    }
    modePlan(ev);
  } else if (has("--freeze-source-manifest")) {
    const out = flag("--output");
    if (!out) {
      console.error("usage: --freeze-source-manifest --output <file>");
      process.exit(2);
    }
    modeFreezeManifest(out);
  } else if (has("--build")) {
    const out = flag("--output");
    if (!out) {
      console.error("usage: --build requires --output <fresh external dir>");
      process.exit(2);
    }
    await modeBuild(out, flag("--source-manifest") ?? null, has("--terminal-candidate"));
  } else {
    console.log(
      "usage: package-windows.mjs --plan --evidence <dir> | --build --output <dir> [--source-manifest <m>] [--terminal-candidate] | --freeze-source-manifest --output <file>",
    );
    process.exit(2);
  }
} catch (e) {
  if (e instanceof PackagingError) {
    console.error(`refused: [${e.code}] ${e.message}`);
    process.exit(1);
  }
  throw e;
}
