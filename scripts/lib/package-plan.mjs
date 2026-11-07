// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Packaging utility functions shared by scripts/package-windows.mjs,
// scripts/windows/packaged-smoke.mjs and the unit tests. Pure Node —
// no electron-builder import here so tests run anywhere.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export class PackagingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PackagingError";
    this.code = code;
  }
}

// ---- host / platform guards -------------------------------------------------

/** Build may ONLY run on the real target host. Dry-run/plan validation
 *  is deliberately separate and safe anywhere. */
export function assertWindowsX64Host(platform = process.platform, arch = process.arch) {
  if (platform !== "win32" || arch !== "x64")
    throw new PackagingError(
      "host-guard",
      `Windows packaging requires a win32/x64 host (got ${platform}/${arch}) — refusing before any build or output mutation`,
    );
}

// ---- output directory rules -------------------------------------------------

function realOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function insideDir(base, p) {
  const rel = relative(base, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Physical location of `abs` once created: the realpath of the
 *  deepest EXISTING ancestor plus the not-yet-existing tail. This is
 *  what must be compared against the source root — NOT the ancestor
 *  itself (a fresh sibling of the source shares the ancestor without
 *  being inside the source). */
function physicalCandidate(abs) {
  let probe = abs;
  const tail = [];
  while (!existsSync(probe)) {
    tail.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) return null; // no existing ancestor at all
    probe = parent;
  }
  const realProbe = realOrNull(probe);
  if (realProbe === null) return null;
  return join(realProbe, ...tail);
}

/**
 * Validate a caller-supplied output directory: physically outside the
 * source tree (a fresh SIBLING is fine), not a symlink/junction, not an
 * ancestor of the source, and either absent (we create it) or an
 * existing EMPTY real directory. Never deletes or reuses content.
 * Returns the resolved absolute path.
 */
export function resolveOutputDir(candidate, sourceRoot) {
  if (typeof candidate !== "string" || candidate.trim() === "")
    throw new PackagingError("output-required", "an explicit output directory is required");
  const realSource = realpathSync(sourceRoot);
  const abs = resolve(candidate);

  const lst = lstatSync(abs, { throwIfNoEntry: false });
  if (lst && lst.isSymbolicLink())
    throw new PackagingError("output-symlink", `output path is a symlink: ${abs}`);
  if (lst && !lst.isDirectory())
    throw new PackagingError("output-not-dir", `output path exists and is not a directory: ${abs}`);

  const physical = physicalCandidate(abs);
  if (physical === null)
    throw new PackagingError("output-parent-missing", `no existing ancestor for: ${abs}`);
  if (insideDir(realSource, physical))
    throw new PackagingError(
      "output-inside-source",
      `output directory must be outside the source tree: ${abs}`,
    );
  if (insideDir(physical, realSource))
    throw new PackagingError(
      "output-inside-source",
      `output directory must not contain the source tree: ${abs}`,
    );

  if (lst) {
    const entries = readdirSync(abs);
    if (entries.length > 0)
      throw new PackagingError("output-not-empty", `output directory is not empty: ${abs}`);
    return realOrNull(abs) ?? abs;
  }
  mkdirSync(abs, { recursive: true });
  return realOrNull(abs) ?? abs;
}

// ---- required runtime content -----------------------------------------------

/** Native + script files node-pty needs at RUNTIME on Windows. A target
 *  build fails hard when any of these is missing rather than emitting a
 *  knowingly broken artifact. */
export const REQUIRED_WIN_PTY_FILES = [
  "node_modules/node-pty/package.json",
  "node_modules/node-pty/lib/index.js",
  "node_modules/node-pty/lib/utils.js",
  "node_modules/node-pty/lib/windowsTerminal.js",
  "node_modules/node-pty/lib/windowsPtyAgent.js",
  "node_modules/node-pty/lib/windowsConoutConnection.js",
  "node_modules/node-pty/lib/conpty_console_list_agent.js",
  "node_modules/node-pty/lib/worker/conoutSocketWorker.js",
  "node_modules/node-pty/lib/shared/conout.js",
  "node_modules/node-pty/lib/eventEmitter2.js",
  "node_modules/node-pty/lib/terminal.js",
  "node_modules/node-pty/lib/interfaces.js",
  "node_modules/node-pty/lib/types.js",
  "node_modules/node-pty/prebuilds/win32-x64/pty.node",
  "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
  "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node",
  "node_modules/node-pty/prebuilds/win32-x64/winpty.dll",
  "node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe",
];

/** Dist payloads the ASAR must contain — the EXACT six files; a broad
 *  `dist/**` would also ship stray build leftovers. */
export const REQUIRED_DIST_FILES = [
  "dist/main/index.cjs",
  "dist/main/ptyHost.cjs",
  "dist/preload/index.cjs",
  "dist/renderer/index.html",
  "dist/renderer/renderer.js",
  "dist/renderer/styles.css",
];

/** Files that must exist INSIDE the packaged app.asar. */
export const REQUIRED_ASAR_ENTRIES = [
  "package.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARK.md",
  "dist/main/index.cjs",
  "dist/main/ptyHost.cjs",
  "dist/preload/index.cjs",
  "dist/renderer/index.html",
  "dist/renderer/renderer.js",
  "dist/renderer/styles.css",
  // Build-pinned job-helper identity — the runtime verifier reads it
  // from inside the ASAR (same trust domain as the code).
  "dist/job-helper-manifest.json",
  // node-pty is fully asarUnpack'ed — only its package metadata may
  // appear inside the ASAR at most; the unpacked tree check below is
  // the authoritative gate for native files.
];

/** Job-helper packaging contract — shared by config validation, output
 *  inspection and the packaging script. The exe lives OUTSIDE the ASAR
 *  at a fixed resources location; its identity is pinned inside. */
export const JOB_HELPER_ASAR_MANIFEST = "dist/job-helper-manifest.json";
export const JOB_HELPER_UNPACKED_EXE = "resources/job-helper/tivano-job-helper.exe";
export const JOB_HELPER_EXTRA_FROM = "dist/job-helper/tivano-job-helper.exe";
export const JOB_HELPER_EXTRA_TO = "job-helper/tivano-job-helper.exe";
export const JOB_HELPER_MANIFEST_SCHEMA = "tivano-windows-job-helper-manifest/1";

export function missingRequired(root, rels) {
  return rels.filter((r) => {
    try {
      return !statSync(join(root, r)).isFile();
    } catch {
      return true;
    }
  });
}

/** Does the electron-builder `files` allowlist cover a repo-relative
 *  path? Positive patterns only; a `dir/**` prefix or exact match
 *  counts. Negated patterns (`!x`) do not grant coverage. */
export function coveredByAllowlist(relPath, patterns) {
  const rel = relPath.split("\\").join("/");
  return patterns.some((p) => {
    if (p.startsWith("!")) return false;
    const pat = p.split("\\").join("/");
    if (pat.endsWith("/**")) return rel === pat.slice(0, -3) || rel.startsWith(pat.slice(0, -2));
    if (pat.endsWith("/*")) return rel.startsWith(pat.slice(0, -1));
    return rel === pat;
  });
}

// ---- builder config validation ------------------------------------------------

/**
 * Structural validation of the committed builder config — the policy
 * we REQUIRE for an internal unsigned dev package on top of schema
 * validity. Returns a list of problems; empty means compatible.
 */
export function validateBuilderConfig(cfg) {
  const problems = [];
  const need = (cond, code, msg) => {
    if (!cond) problems.push({ code, message: msg });
  };
  need(cfg && typeof cfg === "object", "config", "builder config must export an object");
  if (!cfg || typeof cfg !== "object") return problems;
  need(cfg.appId === "com.tivano.windows.dev", "appId", "appId must be com.tivano.windows.dev");
  need(cfg.productName === "Tivano Windows Dev", "productName", "productName must be 'Tivano Windows Dev'");
  need(cfg.publish === null || cfg.publish === undefined, "publish", "publish config must be absent/null");
  need(Array.isArray(cfg.files) && cfg.files.length > 0, "files", "positive files allowlist required");
  need(JSON.stringify((cfg.win?.target ?? []).map(t => t.target).sort()) === JSON.stringify(["dir", "nsis"]), "targets", "expected exactly dir + nsis targets");
  need(
    (cfg.win?.target ?? []).every((t) => (t.arch ?? []).join(",") === "x64"),
    "target-arch",
    "every target must be pinned to x64",
  );
  need(
    cfg.nsis?.oneClick === false && cfg.nsis?.perMachine === false,
    "nsis-scope",
    "assisted per-user NSIS required",
  );
  need(cfg.nsis?.allowElevation === false, "nsis-elevation", "elevation must not be requested");
  need(cfg.nsis?.deleteAppDataOnUninstall === false, "nsis-data", "app data must be preserved on uninstall");
  need(cfg.nsis?.runAfterFinish === false, "nsis-launch", "installer must not auto-launch");
  need(cfg.npmRebuild === false, "rebuild", "npm rebuild must stay off (prebuilds only)");
  need(
    Array.isArray(cfg.asarUnpack) && cfg.asarUnpack.some((p) => String(p).includes("node-pty")),
    "asar-unpack",
    "node-pty must be fully unpacked from the ASAR",
  );
  for (const rel of [...REQUIRED_DIST_FILES, ...REQUIRED_WIN_PTY_FILES, JOB_HELPER_ASAR_MANIFEST]) {
    if (!coveredByAllowlist(rel, cfg.files ?? []))
      problems.push({ code: "allowlist-gap", message: `required path not covered by files allowlist: ${rel}` });
  }
  // Job-helper extraResources contract: the freshly built exe stages to
  // its fixed resources location (plus the pinned local-control CLI
  // client — a real file its installed shim execs, never an ASAR
  // member) — and the staged exe must NOT also be a `files:` entry (it
  // would double-ship in the ASAR, from which it can never execute).
  {
    const er = Array.isArray(cfg.extraResources) ? cfg.extraResources : [];
    const allowed = new Set([
      `${JOB_HELPER_EXTRA_FROM}→${JOB_HELPER_EXTRA_TO}`,
      "cli/tivano.mjs→cli/tivano.mjs",
    ]);
    need(
      er.length === allowed.size &&
        er.every((e) => allowed.has(`${e?.from}→${e?.to}`)),
      "extraResources",
      `expected exactly these extraResources entries: ${[...allowed].join(", ")}`,
    );
    if (coveredByAllowlist("dist/job-helper/tivano-job-helper.exe", cfg.files ?? []))
      problems.push({ code: "files-forbidden", message: "staged job-helper exe must not be a files: entry (extraResources only)" });
    for (const p of cfg.files ?? []) {
      const s = String(p);
      if (/job-fixture|codex-launcher|codex-app-server|helpers\//.test(s))
        problems.push({ code: "files-forbidden", message: `test/helper source or fixture must not ship: ${s}` });
    }
  }
  // No signing material anywhere — the whole point is unsigned.
  const json = JSON.stringify(cfg);
  for (const re of [/certificate/i, /signtool/i, /csc_/i]) {
    if (re.test(json)) problems.push({ code: "signing-config", message: `config must not reference signing material: ${re}` });
  }
  // Real schema validation against the INSTALLED electron-builder
  // scheme — arbitrary unknown/typo'd properties are rejected here, not
  // silently accepted.
  try {
    for (const e of validateBuilderSchema(cfg))
      problems.push({ code: "schema", message: e.message });
  } catch (e) {
    problems.push({ code: "schema-unavailable", message: `schema validation could not run: ${e.message}` });
  }
  return problems;
}

/**
 * REAL schema validation against the installed electron-builder
 * scheme.json, using app-builder-lib's own bundled ajv — catches
 * arbitrary unknown/typo'd properties the policy check above does not
 * enumerate. Returns [{instancePath,message}]; empty means schema-valid.
 */
export function validateBuilderSchema(cfg) {
  const ablRequire = createRequire(createRequire(import.meta.url).resolve("app-builder-lib/package.json"));
  const Ajv = ablRequire("ajv");
  const schema = ablRequire("app-builder-lib/scheme.json");
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(cfg)) return [];
  return (validate.errors ?? []).map((e) => ({
    instancePath: e.instancePath,
    message: `${e.instancePath || "configuration"} ${e.message}`,
  }));
}

function requireResolve(spec) {
  const req = createRequire(join(process.cwd(), "package.json"));
  return req.resolve(spec);
}

/** A declared runtime dependency that packaging cannot survive without
 *  must actually resolve — missing install is fatal, not a warning. */
export function assertDependencyInstalled(name, root) {
  const req = createRequire(join(root, "package.json"));
  try {
    const resolved = req.resolve(`${name}/package.json`);
    if (!resolved) throw new Error("empty resolution");
    return resolved;
  } catch {
    throw new PackagingError("dependency-missing", `required dependency not installed/resolvable: ${name}`);
  }
}

/** Load the committed CJS builder config and validate it. */
export function loadBuilderConfig(configPath) {
  if (!existsSync(configPath))
    throw new PackagingError("config-missing", `missing ${configPath}`);
  const req = createRequire(import.meta.url);
  delete req.cache[configPath];
  return req(configPath);
}

/** All plan-time checks in one place: dist payload (optional),
 *  win32-x64 node-pty runtime, committed config policy + REAL schema
 *  validation, declared-dependency presence. */
export function planChecks(root, configPath, { distPresent = true } = {}) {
  const done = [];
  if (distPresent) {
    const missing = missingRequired(root, REQUIRED_DIST_FILES);
    done.push({ name: "dist-payload", ok: missing.length === 0, missing });
  }
  const missingPty = missingRequired(root, REQUIRED_WIN_PTY_FILES);
  done.push({ name: "win32-x64-node-pty-runtime", ok: missingPty.length === 0, missing: missingPty });
  const cfg = loadBuilderConfig(configPath);
  const problems = validateBuilderConfig(cfg);
  const schemaErrors = validateBuilderSchema(cfg);
  done.push({
    name: "builder-config",
    ok: problems.length === 0 && schemaErrors.length === 0,
    problems,
    schemaErrors,
  });
  let depOk = true;
  const depErrors = [];
  for (const dep of ["node-pty", "react", "electron-builder"]) {
    try {
      assertDependencyInstalled(dep, root);
    } catch (e) {
      depOk = false;
      depErrors.push(`${dep}: ${e.message}`);
    }
  }
  done.push({ name: "dependencies-resolvable", ok: depOk, errors: depErrors });
  return { cfg, checks: done };
}

// ---- hashing / manifest ------------------------------------------------------

/** Windows PowerShell 5.1 Set-Content -Encoding UTF8 emits a BOM. */
export function readGeneratedJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

export function sha256File(p, capBytes = 512 * 1024 * 1024) {
  const st = statSync(p);
  if (st.size > capBytes)
    throw new PackagingError("artifact-oversize", `artifact exceeds hash bound: ${p}`);
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Bounded top-level artifact enumeration — never walks arbitrarily
 *  deep, never follows symlinks. Directories are reported as
 *  `kind:"directory"` with a null hash; callers needing content proof
 *  must use hashTree on the unpacked runtime instead. */
export function hashArtifacts(outDir, { maxEntries = 64, maxBytes = 512 * 1024 * 1024 } = {}) {
  const names = readdirSync(outDir).sort();
  const out = [];
  for (const n of names) {
    if (out.length >= maxEntries) break;
    const p = join(outDir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) continue;
    if (st.isDirectory()) {
      out.push({ path: n, kind: "directory", bytes: null, sha256: null });
      continue;
    }
    if (st.size > maxBytes)
      throw new PackagingError("artifact-oversize", `artifact exceeds hash bound: ${p}`);
    out.push({ path: n, kind: "file", bytes: st.size, sha256: sha256File(p, maxBytes) });
  }
  return out;
}

/**
 * Deterministic recursive file manifest under `dir`: every regular
 * file's relative posix path + size + sha256, sorted; symlinks and
 * anything non-file is recorded as an entry with kind marker so a
 * planted symlink can never silently pass. Bounded by
 * maxFiles/maxTotalBytes.
 */
export function hashTree(dir, { maxFiles = 20000, maxTotalBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  const entries = [];
  let total = 0;
  const walk = (rel) => {
    const abs = join(dir, rel);
    let names;
    try {
      names = readdirSync(abs).sort();
    } catch (e) {
      throw new PackagingError("tree-unreadable", `cannot enumerate ${abs}: ${e.message}`);
    }
    for (const n of names) {
      if (entries.length >= maxFiles)
        throw new PackagingError("tree-oversize", `more than ${maxFiles} files under ${dir}`);
      const child = rel === "" ? n : `${rel}/${n}`;
      const st = lstatSync(join(dir, child));
      if (st.isDirectory()) {
        walk(child);
        continue;
      }
      if (st.isSymbolicLink()) {
        entries.push({ path: child, kind: "symlink", bytes: 0, sha256: null });
        continue;
      }
      if (!st.isFile()) continue;
      total += st.size;
      if (total > maxTotalBytes)
        throw new PackagingError("tree-oversize", `unpacked tree exceeds ${maxTotalBytes} bytes`);
      entries.push({ path: child, kind: "file", bytes: st.size, sha256: sha256File(join(dir, child)) });
    }
  };
  walk("");
  const treeDigest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return { root: dir, fileCount: entries.length, totalBytes: total, treeDigest, entries };
}

// ---- source binding -----------------------------------------------------------

/**
 * Enumerate the actual build input set and hash every file. With .git
 * present uses `git ls-files -c -o --exclude-standard -z` (tracked +
 * untracked-nonignored — honest about dirty trees); without .git a
 * supplied frozen manifest ({files:[{path,sha256}]}) is REQUIRED —
 * refuse to bind a build to an unverifiable source set.
 * Returns {mode:"git"|"manifest", commit, fileCount, sourceDigest, files}.
 */
function safeSourcePath(root, rel) {
  if (typeof rel !== "string" || rel.length === 0 || /[\\:\0]/.test(rel) || rel.startsWith("/") || rel.split("/").some(x => !x || x === "." || x === ".."))
    throw new PackagingError("source-path", `unsafe source path: ${rel}`);
  let p = root;
  for (const part of rel.split("/")) {
    p = join(p, part);
    if (lstatSync(p).isSymbolicLink()) throw new PackagingError("source-symlink", `source symlink: ${rel}`);
  }
  return p;
}

function sourcePaths(root, inventory) {
  const spec = JSON.parse(readFileSync(join(root, "config/cloud-source-manifest.json"), "utf8"));
  const matches = (path, pat) => pat.endsWith("/**") ? path.startsWith(pat.slice(0, -2)) : path === pat;
  // An EXACT include entry wins over exclude globs — `tests/**` must not
  // swallow the deliberately listed tests/windows build inputs.
  const paths = [...new Set(inventory)].filter(p =>
    spec.include.some(x => matches(p, x)) &&
    (spec.include.includes(p) || !spec.exclude.some(x => matches(p, x)))).sort();
  for (const p of spec.include.filter(x => !x.endsWith("/**"))) {
    if (!paths.includes(p)) throw new PackagingError("source-input-missing", `missing build input: ${p}`);
  }
  return paths;
}

export function enumerateSourceInput(root, { manifestPath = null, maxFiles = 20000 } = {}) {
  let paths, mode, commit, expected, dirty = null;
  const gitRun = args => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (existsSync(join(root, ".git"))) {
    mode = "git";
    commit = gitRun(["rev-parse", "HEAD"]).trim();
    paths = sourcePaths(root, gitRun(["ls-files", "-c", "-o", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
    dirty = Boolean(gitRun(["ls-files", "-m", "-d", "-z"]) || gitRun(["ls-files", "--others", "--exclude-standard", "-z"]));
  } else if (manifestPath) {
    mode = "manifest";
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (doc?.schema !== "tivano-windows-source-manifest/1" || !Array.isArray(doc.files) || !/^[a-f0-9]{40,64}$/.test(doc.commit ?? ""))
      throw new PackagingError("source-manifest-invalid", "manifest needs source commit and file hashes");
    commit = doc.commit; dirty = doc.dirty ?? null; expected = doc;
    paths = doc.files.map(f => f.path);
    if (new Set(paths).size !== paths.length) throw new PackagingError("source-manifest-invalid", "duplicate source paths");
    for (const f of doc.files) {
      safeSourcePath(root, f.path);
      if (!/^[a-f0-9]{64}$/.test(f.sha256 ?? "") || !Number.isSafeInteger(f.bytes) || f.bytes < 0)
        throw new PackagingError("source-manifest-invalid", `missing hash/size: ${f.path}`);
    }
    // Every actual selected build input must be present in the frozen inventory.
    const actual = [];
    const walk = rel => {
      for (const name of readdirSync(join(root, rel))) {
        if (!rel && ["node_modules", "dist", ".git"].includes(name)) continue;
        const path = rel ? `${rel}/${name}` : name;
        const st = lstatSync(join(root, path));
        if (st.isDirectory()) walk(path); else actual.push(path);
        if (actual.length > maxFiles) throw new PackagingError("source-oversize", "source inventory too large");
      }
    };
    walk("");
    if (JSON.stringify(sourcePaths(root, actual)) !== JSON.stringify([...paths].sort()))
      throw new PackagingError("source-manifest-invalid", "manifest does not match build input inventory");
  } else {
    throw new PackagingError("source-identity-unknown", "no .git and no --source-manifest: input unverifiable");
  }
  if (!paths.length || paths.length > maxFiles) throw new PackagingError("source-oversize", "invalid source inventory size");
  const files = paths.sort().map(path => {
    const p = safeSourcePath(root, path), st = lstatSync(p);
    if (!st.isFile()) throw new PackagingError("source-missing", `not a source file: ${path}`);
    return { path, bytes: st.size, sha256: sha256File(p) };
  });
  const sourceDigest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  if (expected && (expected.sourceDigest !== sourceDigest || expected.fileCount !== files.length || JSON.stringify([...expected.files].sort((a,b) => a.path.localeCompare(b.path))) !== JSON.stringify([...files].sort((a,b) => a.path.localeCompare(b.path)))))
    throw new PackagingError("source-manifest-mismatch", "source files differ from frozen hashes");
  return { mode, commit, dirty, fileCount: files.length, sourceDigest, files, manifestPath };
}

/** Re-enumerate the same input set and verify it is byte-identical.
 *  Throws on any drift — the manifest can never silently bind an
 *  artifact to a source state it did not actually come from. */
export function verifySourceUnchanged(root, before) {
  const after = enumerateSourceInput(root, {
    manifestPath: before.mode === "manifest" ? before.manifestPath : null,
  });
  if (after.sourceDigest !== before.sourceDigest || after.fileCount !== before.fileCount)
    throw new PackagingError(
      "source-drifted",
      `source input changed during build: ${before.sourceDigest.slice(0, 12)}→${after.sourceDigest.slice(0, 12)}`,
    );
  return after;
}

// ---- bounded subprocess ------------------------------------------------------

/**
 * Spawn with bounded wall-time and bounded captured output.
 *
 * POSIX children run in their OWN process group (detached) so a
 * descendant that inherited our pipes can never keep us waiting: we
 * resolve on the child's `exit` (authoritative) with a bounded settle
 * for `close`, and timeout/overflow kills the whole group via
 * `kill(-pid)`. Windows cleanup uses `taskkill /PID <pid> /T /F` — an
 * explicit pid tree kill, never an image-name sweep — itself spawned
 * with an error handler so a failed taskkill can never hang us.
 *
 * Output cap is enforced by KILLING the producer, not by silently
 * truncating while it runs forever.
 *
 * Result: {code, signal, timedOut, outputOverflow, spawnError,
 *          exitObserved, closeObserved, cleanup, stdoutTail, stderrTail}
 * exitObserved=false means the child's exit was never confirmed —
 * honest uncertainty, never painted green.
 */
export function runBounded(
  cmd,
  args,
  { cwd, env, timeoutMs = 10 * 60_000, capBytes = 512 * 1024, killSettleMs = 5000, closeSettleMs = 400 } = {},
) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let code = null;
    let signal = null;
    let timedOut = false;
    let outputOverflow = false;
    let spawnError = null;
    let exitObserved = false;
    let closeObserved = false;
    let cleanup = "none";
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);

    const child = spawn(cmd, args, {
      cwd,
      env,
      windowsHide: true,
      // own process group on POSIX → group kill reaches descendants
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const keep = (buf, chunk) => {
      if (buf.length >= capBytes) return buf;
      const room = capBytes - buf.length;
      const next = Buffer.concat([buf, chunk.subarray(0, room)]);
      if (next.length >= capBytes && !outputOverflow) {
        outputOverflow = true;
        killTree(); // cap enforcement — stop the producer
      }
      return next;
    };

    const killTree = () => {
      if (process.platform === "win32") {
        if (!child.pid) return;
        try {
          const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          tk.on("error", () => {
            /* bounded: a failed taskkill spawn is reported via exitObserved */
          });
          const tkTimer = setTimeout(() => { try { tk.kill(); } catch {} }, 5000);
          tk.once("close", () => clearTimeout(tkTimer));
          tk.once("error", () => clearTimeout(tkTimer));
          tkTimer.unref();
          tk.unref();
        } catch {
          /* nothing else can kill by pid — exit observation decides */
        }
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL"); // the whole group incl. pipe-holding descendants
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    };

    const settleTimer = { id: null };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (settleTimer.id) clearTimeout(settleTimer.id);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* pipes already gone */
      }
      resolvePromise({
        code,
        signal,
        timedOut,
        outputOverflow,
        spawnError,
        exitObserved,
        closeObserved,
        cleanup,
        stdoutTail: out.toString(),
        stderrTail: err.toString(),
      });
    };

    child.stdout?.on("data", (c) => (out = keep(out, c)));
    child.stderr?.on("data", (c) => (err = keep(err, c)));

    child.on("error", (e) => {
      spawnError = String(e?.message ?? e);
      finish(); // never wait indefinitely on a failed spawn
    });
    child.on("exit", (c, s) => {
      exitObserved = true;
      code = c;
      signal = s;
      // `exit` is authoritative — `close` waits for stdio, which an
      // inherited-pipe descendant can hold open forever. Bounded settle.
      settleTimer.id = setTimeout(() => {
        cleanup = cleanup === "none" ? "exit-observed-close-not" : cleanup;
        if (process.platform !== "win32") killTree();
        finish();
      }, closeSettleMs);
    });
    child.on("close", (c, s) => {
      closeObserved = true;
      if (code === null) {
        code = c;
        signal = s;
      }
      finish();
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (exitObserved) {
        // Child already exited — nothing left to kill; an inherited-pipe
        // descendant may legitimately still hold `close` open and is the
        // CALLER's owned process to clean up, not ours to sweep.
        cleanup = "timeout-after-exit";
        if (process.platform !== "win32") killTree();
        finish();
        return;
      }
      cleanup = "kill-dispatched";
      killTree();
      // If exit never arrives after the kill, report it honestly —
      // still bounded, never wait on a dead pipe.
      settleTimer.id = setTimeout(() => {
        cleanup = exitObserved ? "killed" : "kill-unconfirmed";
        finish();
      }, killSettleMs);
    }, timeoutMs);
  });
}

export function inspectBuiltOutput(outDir, ROOT) {
  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };

  const top = hashArtifacts(outDir);
  const unpackedDirName = top.find((a) => a.kind === "directory" && a.path === "win-unpacked")?.path;
  const installer = top.find((a) => a.kind === "file" && /-setup\.exe$/i.test(a.path));
  need(unpackedDirName, "no unpacked (dir-target) directory produced");
  need(installer, "no NSIS installer (*-setup.exe) produced");

  let unpackedManifest = null;
  let asarEntries = [];
  if (unpackedDirName) {
    const unpacked = join(outDir, unpackedDirName);
    unpackedManifest = hashTree(unpacked);
    const rels = new Set(unpackedManifest.entries.map((e) => e.path.replace(/\\/g, "/")));
    // Required runtime files inside the unpacked tree.
    need(rels.has("Tivano Windows Dev.exe"), "packaged executable missing");
    need(rels.has("resources/app.asar"), "resources/app.asar missing from unpacked tree");
    for (const rel of ["resources/app.asar.unpacked/node_modules/node-pty/package.json"]) {
      need(rels.has(rel), `required unpacked payload missing: ${rel}`);
    }
    // Windows node-pty natives must be physically unpacked.
    for (const rel of REQUIRED_WIN_PTY_FILES) {
      const under = `resources/app.asar.unpacked/${rel}`;
      need(rels.has(under), `required Windows node-pty file missing: ${under}`);
    }
    // Packaged job-helper: real exe at the fixed resources location,
    // bytes identical to the manifest pinned inside the ASAR.
    const asarPath = join(unpacked, "resources", "app.asar");
    need(rels.has(JOB_HELPER_UNPACKED_EXE), `packaged job-helper missing: ${JOB_HELPER_UNPACKED_EXE}`);
    let helperManifest = null;
    if (existsSync(asarPath)) {
      try {
        const req = createRequire(join(ROOT, "package.json"));
        const asar = req("@electron/asar");
        const raw = asar.extractFile(asarPath, JOB_HELPER_ASAR_MANIFEST);
        helperManifest = JSON.parse(Buffer.from(raw).toString("utf8"));
      } catch (e) {
        problems.push(`job-helper manifest unreadable in asar: ${e.message}`);
      }
      need(helperManifest && typeof helperManifest === "object", "job-helper manifest is not an object");
      if (helperManifest) {
        need(
          helperManifest.schema === JOB_HELPER_MANIFEST_SCHEMA &&
            helperManifest.file === "tivano-job-helper.exe" &&
            helperManifest.specVersion === 1 &&
            /^[0-9a-f]{64}$/.test(helperManifest.sha256 ?? "") &&
            Number.isSafeInteger(helperManifest.bytes) &&
            typeof helperManifest.helperVersion === "string" &&
            helperManifest.helperVersion.length > 0,
          "job-helper manifest failed contract validation",
        );
        const entry = unpackedManifest.entries.find(
          (e) => e.path.replace(/\\/g, "/") === JOB_HELPER_UNPACKED_EXE,
        );
        if (entry) {
          need(
            entry.sha256 === helperManifest.sha256 && entry.bytes === helperManifest.bytes,
            `packaged job-helper does not match its pinned identity ` +
              `(file ${entry.sha256?.slice(0, 12)}… vs manifest ${String(helperManifest.sha256).slice(0, 12)}…)`,
          );
        }
      }
    }
    // Forbidden content anywhere in the runtime.
    for (const e of unpackedManifest.entries) {
      const p = e.path.replace(/\\/g, "/");
      if (/\.map$/.test(p)) problems.push(`source map shipped: ${p}`);
      if (/(^|\/)tests?\//.test(p) && !p.includes("node_modules/")) problems.push(`test tree shipped: ${p}`);
      if (/\.devdata\//.test(p)) problems.push(`dev data shipped: ${p}`);
      if (e.kind === "symlink") problems.push(`symlink shipped: ${p}`);
      if (p.includes("fixtures/") && !p.includes("node_modules/")) problems.push(`fixture shipped: ${p}`);
      if (/job-fixture|codex-launcher|codex-app-server\.mjs/.test(p))
        problems.push(`test fixture shipped: ${p}`);
      // The staged helper exe may live ONLY at its fixed location —
      // a second copy anywhere else is a supply-chain smell.
      if (/tivano-job-helper\.exe$/i.test(p) && p !== JOB_HELPER_UNPACKED_EXE)
        problems.push(`job-helper exe outside its fixed location: ${p}`);
    }
    // ASAR inspection — required entries present, no forbidden payloads.
    if (existsSync(asarPath)) {
      try {
        const req = createRequire(join(ROOT, "package.json"));
        const asar = req("@electron/asar");
        asarEntries = asar.listPackage(asarPath).map(p => String(p).replace(/\\/g, "/").replace(/^\/+/, ""));
      } catch (e) {
        problems.push(`app.asar could not be listed: ${e.message}`);
      }
      for (const rel of REQUIRED_ASAR_ENTRIES)
        need(asarEntries.includes(rel), `app.asar missing required entry: ${rel}`);
      for (const rel of asarEntries) {
        if (/tivano-job-helper\.exe$/i.test(rel) || /job-fixture|codex-launcher/.test(rel)) problems.push(`helper or fixture executable in asar: ${rel}`);
        if (/\.map$/.test(rel)) problems.push(`source map in asar: ${rel}`);
        if (/^(tests?|src|fixtures|\.devdata|\.git|evidence)(\/|$)/.test(rel)) problems.push(`forbidden payload in asar: ${rel}`);
      }
    }
  }
  return { problems, topArtifacts: top, unpackedManifest, asarEntryCount: asarEntries.length };
}

