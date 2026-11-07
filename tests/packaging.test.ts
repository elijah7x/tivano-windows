// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Packaging pipeline utilities: host guards, output-dir safety, required
// runtime content, allowlist coverage, REAL schema validation, bounded
// subprocess, hashing, and the committed builder config itself.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  PackagingError,
  REQUIRED_DIST_FILES,
  REQUIRED_WIN_PTY_FILES,
  assertWindowsX64Host,
  coveredByAllowlist,
  enumerateSourceInput,
  hashArtifacts,
  hashTree,
  missingRequired,
  planChecks,
  resolveOutputDir,
  runBounded,
  sha256File,
  validateBuilderConfig,
  validateBuilderSchema,
  verifySourceUnchanged,
  loadBuilderConfig,
  // @ts-expect-error plain-JS module — exercised through its public surface
} from "../scripts/lib/package-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "windows-dev-builder.cjs");
const scratchDirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "tivano-pkg-test-"));
  scratchDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

describe("assertWindowsX64Host", () => {
  it("accepts only win32/x64", () => {
    expect(() => assertWindowsX64Host("win32", "x64")).not.toThrow();
    for (const [p, a] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "x64"],
      ["win32", "arm64"],
      ["win32", "ia32"],
    ] as const) {
      expect(() => assertWindowsX64Host(p, a)).toThrowError(/win32\/x64/);
    }
  });
});

describe("resolveOutputDir", () => {
  it("ALLOWS a fresh sibling that shares the source's parent (lead probe)", () => {
    const d = scratch();
    const source = join(d, "source");
    mkdirSync(source);
    const out = join(d, "output");
    const resolved = resolveOutputDir(out, source);
    expect(existsSync(resolved)).toBe(true);
  });

  it("refuses the source directory itself and paths inside it", () => {
    expect(() => resolveOutputDir(ROOT, ROOT)).toThrowError(/source tree/);
    expect(() => resolveOutputDir(join(ROOT, "out"), ROOT)).toThrowError(/source tree/);
    expect(() => resolveOutputDir(join(ROOT, "dist", "pkg"), ROOT)).toThrowError(/source tree/);
  });

  it("refuses a symlink that points into the source tree", () => {
    const outside = scratch();
    const link = join(outside, "link-in");
    symlinkSync(ROOT, link, "dir");
    expect(() => resolveOutputDir(link, ROOT)).toThrowError(/symlink|source tree/);
  });

  it("refuses a candidate that CONTAINS the source (ancestor)", () => {
    const parent = dirname(ROOT); // physical candidate is the parent — source lives inside it
    expect(() => resolveOutputDir(parent, ROOT)).toThrowError(/source tree/);
  });

  it("refuses a nested missing-descendant candidate inside the source", () => {
    // deepest existing ancestor is the source itself → physical
    // candidate lands INSIDE the source even though the leaf is absent.
    expect(() => resolveOutputDir(join(ROOT, "a", "b", "c"), ROOT)).toThrowError(
      /source tree/,
    );
  });

  it("creates a fresh external directory and accepts an existing empty one", () => {
    const base = scratch();
    const fresh = join(base, "new-out");
    const r1 = resolveOutputDir(fresh, ROOT);
    expect(existsSync(r1)).toBe(true);
    const r2 = resolveOutputDir(fresh, ROOT); // now exists, still empty → ok
    expect(r2).toBe(r1);
  });

  it("refuses an existing non-empty directory", () => {
    const base = scratch();
    writeFileSync(join(base, "leftover.txt"), "x");
    expect(() => resolveOutputDir(base, ROOT)).toThrowError(/not empty/);
  });

  it("refuses an existing non-directory path; deep-missing external path is created", () => {
    const base = scratch();
    const f = join(base, "file.txt");
    writeFileSync(f, "x");
    expect(() => resolveOutputDir(f, ROOT)).toThrowError(/not a directory/);
    // Deep-missing descendants under an existing external ancestor are
    // physically outside the source → created (same rule as fresh sibling).
    const deep = resolveOutputDir(join(base, "no", "such", "ancestor", "out"), ROOT);
    expect(existsSync(deep)).toBe(true);
  });

  it("refuses a blank/undefined candidate", () => {
    expect(() => resolveOutputDir("", ROOT)).toThrowError(/required/);
    expect(() =>
      resolveOutputDir(undefined as unknown as string, ROOT),
    ).toThrowError(/required/);
  });
});

describe("required runtime content", () => {
  it("all REQUIRED_WIN_PTY_FILES exist in this checkout (list cannot drift)", () => {
    expect(missingRequired(ROOT, REQUIRED_WIN_PTY_FILES)).toEqual([]);
  });

  it("missingRequired reports absent files", () => {
    const base = scratch();
    mkdirSync(join(base, "a"), { recursive: true });
    writeFileSync(join(base, "a", "x.txt"), "1");
    expect(missingRequired(base, ["a/x.txt", "a/y.txt", "b/z.txt"])).toEqual([
      "a/y.txt",
      "b/z.txt",
    ]);
    expect(missingRequired(base, ["a"])).toEqual(["a"]); // a dir is not a file
  });

  it("every required path is covered by the committed allowlist", () => {
    const cfg = loadBuilderConfig(CONFIG);
    for (const rel of [...REQUIRED_DIST_FILES, ...REQUIRED_WIN_PTY_FILES])
      expect(coveredByAllowlist(rel, cfg.files), rel).toBe(true);
  });

  it("allowlist does not cover forbidden or stray content", () => {
    const cfg = loadBuilderConfig(CONFIG);
    for (const rel of [
      "dist/other-leftover.js", // exact dist list — stray payload not covered
      "dist/main/sourcemap.js.map",
      "src/main/index.ts",
      "tests/packaging.test.ts",
      ".devdata/store.json",
      "scripts/e2e.mjs",
      "node_modules/node-pty/src/win/pty.cc",
      "node_modules/node-pty/build/Release/pty.node",
      "evidence/secret.env",
    ])
      expect(coveredByAllowlist(rel, cfg.files), rel).toBe(false);
  });
});

describe("builder config validation", () => {
  it("committed config passes policy + REAL schema validation", () => {
    const cfg = loadBuilderConfig(CONFIG);
    expect(validateBuilderConfig(cfg)).toEqual([]);
    expect(validateBuilderSchema(cfg)).toEqual([]);
    expect(cfg.productName).toBe("Tivano Windows Dev");
    expect(cfg.nsis.perMachine).toBe(false);
    expect(cfg.publish).toBeNull();
  });

  it("schema validation rejects unknown properties (lead probe)", () => {
    const cfg = loadBuilderConfig(CONFIG);
    for (const bad of [
      { ...cfg, definitelyInvalidOption: true },
      { ...cfg, win: { ...cfg.win, bogusWin: 1 } },
      { ...cfg, nsis: { ...cfg.nsis, bogusNsis: 1 } },
      { ...cfg, nsis: { ...cfg.nsis, perMachine: "yes" } },
    ]) {
      const errs = validateBuilderSchema(bad);
      expect(errs.length, JSON.stringify(errs)).toBeGreaterThan(0);
    }
  });

  it("planChecks reports config + runtime + dependencies", () => {
    const { checks } = planChecks(ROOT, CONFIG, {
      distPresent: existsSync(join(ROOT, "dist")),
    }) as { checks: { name: string; ok: boolean }[] };
    for (const name of ["win32-x64-node-pty-runtime", "builder-config", "dependencies-resolvable"]) {
      const c = checks.find((x: { name: string }) => x.name === name);
      expect(c?.ok, name).toBe(true);
    }
  });

  it("catches tampered identity / publishing / elevation", () => {
    const good = loadBuilderConfig(CONFIG);
    for (const bad of [
      { ...good, appId: "com.evil.x" },
      { ...good, publish: { provider: "github" } },
      { ...good, nsis: { ...good.nsis, perMachine: true } },
      { ...good, nsis: { ...good.nsis, deleteAppDataOnUninstall: true } },
      { ...good, nsis: { ...good.nsis, runAfterFinish: true } },
      { ...good, nsis: { ...good.nsis, allowElevation: true } },
      { ...good, asarUnpack: [] },
      { ...good, npmRebuild: true },
      { ...good, files: ["dist/**"] },
      { ...good, win: { ...good.win, certificateFile: "x.pfx" } },
    ]) {
      expect(validateBuilderConfig(bad).length).toBeGreaterThan(0);
    }
  });
});

describe("hashing & source binding", () => {
  it("sha256File hashes file contents", () => {
    const f = join(scratch(), "h.bin");
    writeFileSync(f, "hello-hash");
    expect(sha256File(f)).toBe(
      createHash("sha256").update("hello-hash").digest("hex"),
    );
  });

  it("hashArtifacts marks dirs kind=directory, skips symlinks", () => {
    const d = scratch();
    writeFileSync(join(d, "a.exe"), "aaa");
    mkdirSync(join(d, "win-unpacked"));
    symlinkSync("a.exe", join(d, "link"));
    const arts = hashArtifacts(d) as { path: string; kind: string; sha256: string | null }[];
    const file = arts.find((a: { path: string }) => a.path === "a.exe");
    expect(file?.kind).toBe("file");
    expect(file?.sha256).toBe(createHash("sha256").update("aaa").digest("hex"));
    expect(arts.some((a: { path: string }) => a.path === "link")).toBe(false);
    expect(arts.find((a: { path: string }) => a.path === "win-unpacked")?.kind).toBe("directory");
  });

  it("hashTree enumerates a deterministic recursive manifest", () => {
    const d = scratch();
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "a.txt"), "A");
    writeFileSync(join(d, "sub", "b.txt"), "B");
    const t1 = hashTree(d) as { fileCount: number; treeDigest: string };
    const t2 = hashTree(d) as { treeDigest: string };
    expect(t1.fileCount).toBe(2);
    expect(t1.treeDigest).toBe(t2.treeDigest);
    writeFileSync(join(d, "c.txt"), "C");
    const t3 = hashTree(d) as { treeDigest: string };
    expect(t3.treeDigest).not.toBe(t1.treeDigest);
  });

  it("enumerateSourceInput binds this repo via git inventory", () => {
    const input = enumerateSourceInput(ROOT) as {
      mode: string; commit: string | null; fileCount: number; files: { path: string }[];
    };
    expect(input.mode).toBe("git");
    expect(input.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(input.fileCount).toBeGreaterThan(30);
    expect(input.files.some((f: { path: string }) => f.path === "package.json")).toBe(true);
    expect(input.files.some((f: { path: string }) => f.path === "node_modules/x")).toBe(false);
    // re-enumerating an unchanged tree verifies
    expect(() => verifySourceUnchanged(ROOT, input)).not.toThrow();
  });

  it("enumerateSourceInput refuses a .git-less root without a manifest", () => {
    const empty = scratch();
    expect(() => enumerateSourceInput(empty)).toThrowError(/unverifiable/);
  });

  it("frozen-manifest mode verifies hashes and refuses changed inputs", () => {
    const archive = scratch();
    const cfg = { include: ["a.txt", "config/cloud-source-manifest.json"], exclude: [] };
    mkdirSync(join(archive, "config"));
    writeFileSync(join(archive, "config/cloud-source-manifest.json"), JSON.stringify(cfg));
    writeFileSync(join(archive, "a.txt"), "A");
    const files = cfg.include.sort().map(path => { const body = readFileSync(join(archive,path)); return {path,bytes:body.length,sha256:createHash("sha256").update(body).digest("hex")}; });
    const manifest = { schema:"tivano-windows-source-manifest/1", commit:"a".repeat(40), fileCount:files.length, sourceDigest:createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
    const mf = join(scratch(), "m.json"); writeFileSync(mf,JSON.stringify(manifest));
    expect(enumerateSourceInput(archive,{manifestPath:mf}).fileCount).toBe(2);
    writeFileSync(join(archive,"a.txt"),"B");
    expect(()=>enumerateSourceInput(archive,{manifestPath:mf})).toThrow(/frozen hashes/);
    manifest.files[0]!.path="../outside.txt";writeFileSync(mf,JSON.stringify(manifest));
    expect(()=>enumerateSourceInput(archive,{manifestPath:mf})).toThrow(/unsafe source path/);
  });
});

describe("runBounded (lead probes)", () => {
  it("captures exit code and output", async () => {
    const r = await runBounded(process.execPath, ["-e", "console.log('out');console.error('err')"], {
      timeoutMs: 10000,
    });
    expect(r.code).toBe(0);
    expect(r.exitObserved).toBe(true);
    expect(r.stdoutTail).toContain("out");
    expect(r.stderrTail).toContain("err");
  });

  it("returns after parent exit even when a descendant holds inherited pipes (lead probe)", async () => {
    const childCode =
      "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:['ignore',1,2]});process.exit(0)";
    const started = Date.now();
    const r = await runBounded(process.execPath, ["-e", childCode], { timeoutMs: 15000 });
    // 'exit' is authoritative; the grandchild's held pipe must not hang us.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code).toBe(0);
    expect(r.exitObserved).toBe(true);
    expect(r.closeObserved).toBe(false); // pipe still held by descendant — reported honestly
  });

  it("enforces the wall-time bound and reports exit observation", async () => {
    const r = await runBounded(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
      timeoutMs: 400,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.exitObserved).toBe(true);
  });

  it("output cap KILLS an excessive producer — not silent truncation", async () => {
    const r = await runBounded(
      process.execPath,
      ["-e", "setInterval(()=>process.stdout.write('x'.repeat(65536)),10);setTimeout(()=>{},60000)"],
      { timeoutMs: 15000, capBytes: 4096 },
    );
    expect(r.outputOverflow).toBe(true);
    expect(r.stdoutTail.length).toBeLessThanOrEqual(4096);
    expect(r.code).not.toBe(0); // producer was killed, not allowed to run on
  });

  it("spawn failure resolves promptly with spawnError — never hangs", async () => {
    const r = await runBounded(join(tmpdir(), "definitely-no-such-binary-xyz"), ["-e"], {
      timeoutMs: 15000,
    });
    expect(r.spawnError).toBeTruthy();
    expect(r.exitObserved).toBe(false);
    expect(r.code).toBeNull();
  });
});

describe("script repo-root resolution", () => {
  it("both entry scripts resolve the real repository root", () => {
    const pkg = JSON.parse(
      String(readFileSync(join(ROOT, "package.json"), "utf8")),
    );
    expect(pkg.name).toBe("tivano-windows");
    for (const rel of [
      "scripts/package-windows.mjs",
      "scripts/windows/packaged-smoke.mjs",
      "scripts/dev-smoke-harness.mjs",
    ]) {
      const scriptDir = dirname(join(ROOT, rel));
      const depth = rel.split("/").length - 1; // scripts/x →1, scripts/windows/x →2
      const root = resolve(scriptDir, ...Array(depth).fill(".."));
      expect(existsSync(join(root, "package.json")), rel).toBe(true);
      expect(existsSync(join(root, "config", "windows-dev-builder.cjs")), rel).toBe(true);
    }
  });
});

describe("packaged smoke host gate", () => {
  it("smoke script refuses non-Windows hosts before any mutation", async () => {
    const evidence = join(scratch(), "smoke-evidence");
    const r = await runBounded(
      process.execPath,
      [
        join(ROOT, "scripts", "windows", "packaged-smoke.mjs"),
        "--exe", process.execPath,
        "--evidence", evidence,
      ],
      { timeoutMs: 20000 },
    );
    if (process.platform === "win32" && process.arch === "x64") {
      expect(r.code).not.toBe(0);
    } else {
      expect(r.code).toBe(3);
      expect(r.stderrTail + r.stdoutTail).toMatch(/NOT RUN/);
      expect(existsSync(evidence)).toBe(false);
    }
  });
});
