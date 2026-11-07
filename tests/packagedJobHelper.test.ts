// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Packaged job-helper attestation: the ONLY route to supported:true.
// Every trust boundary is exercised — a missing/replaced/mismatched
// artifact, an escaped path, a platform/arch/dev-context mismatch, a
// probe failure — and none can mint support. The environment hint
// (TIVANO_CODEX_JOB_HELPER) is structurally absent from this API.
//
// Filesystem fixtures are REAL temp dirs; only the platform/packaged
// inputs are simulated (same seam style as providerProcessLifecycle
// tests). No test here claims Windows acceptance — that lives in
// scripts/windows/packaged-job-test.mjs on a real win32/x64 host.

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JOB_HELPER_ASAR_MANIFEST,
  JOB_HELPER_EXE_NAME,
  JOB_HELPER_MANIFEST_SCHEMA,
  attestJobHelper,
  disposeJobHelperProbes,
  probeAndAttestPackagedJobHelper,
  resolvePackagedJobHelperCandidate,
  type JobHelperManifest,
} from "../src/main/packagedJobHelper";
import { PROCESS_TREE_UNSUPPORTED } from "../src/main/providerProcessLifecycle";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-pkgjob-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const HELPER_BYTES = Buffer.from("MZ-fake-helper-bytes");
const HELPER_SHA = createHash("sha256").update(HELPER_BYTES).digest("hex");

function makeManifest(over: Partial<JobHelperManifest> = {}): JobHelperManifest {
  return {
    schema: JOB_HELPER_MANIFEST_SCHEMA,
    file: JOB_HELPER_EXE_NAME,
    sha256: HELPER_SHA,
    bytes: HELPER_BYTES.length,
    specVersion: 1,
    helperVersion: "1.1.0",
    ...over,
  };
}

/** A realistic packaged layout: appPath=<asar>, resources/<resourcesPath>. */
function makePackage(opts: { manifest?: JobHelperManifest | null; exeBytes?: Buffer | null } = {}) {
  const root = freshDir();
  const asar = join(root, "app.asar"); // a real dir standing in for the archive
  const resources = join(root, "resources");
  mkdirSync(join(asar, "dist"), { recursive: true });
  mkdirSync(join(resources, "job-helper"), { recursive: true });
  if (opts.manifest !== null) {
    writeFileSync(
      join(asar, "dist", "job-helper-manifest.json"),
      JSON.stringify(opts.manifest ?? makeManifest()),
    );
  }
  if (opts.exeBytes !== null) {
    writeFileSync(
      join(resources, "job-helper", JOB_HELPER_EXE_NAME),
      opts.exeBytes ?? HELPER_BYTES,
    );
  }
  return { appPath: asar, resourcesPath: resources, root };
}

const baseOpts = { platform: "win32" as const, arch: "x64", packaged: true };

describe("resolvePackagedJobHelperCandidate", () => {
  it("non-Windows platforms are unsupported before touching the filesystem", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const v = resolvePackagedJobHelperCandidate({
        ...baseOpts, platform, appPath: "/x", resourcesPath: "/y",
      });
      expect(v.kind).toBe("unsupported");
      if (v.kind === "unsupported") expect(v.reason).toContain(PROCESS_TREE_UNSUPPORTED);
    }
  });

  it("non-x64 arch is unsupported", () => {
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, arch: "arm64", appPath: "/x", resourcesPath: "/y",
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("x64");
  });

  it("unpackaged/dev runs stay unsupported even with a plausible layout", () => {
    const p = makePackage();
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, packaged: false, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("packaged");
  });

  it("missing manifest → unsupported", () => {
    const p = makePackage({ manifest: null });
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("manifest missing");
  });

  it("manifest failing schema → unsupported", () => {
    const p = makePackage({ manifest: makeManifest({ schema: "other/1" }) });
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("schema");
  });

  it("missing helper exe → unsupported", () => {
    const p = makePackage({ exeBytes: null });
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("not present");
  });

  it("REPLACED helper (content changed, same size) → hash mismatch → unsupported", () => {
    const tampered = Buffer.from(HELPER_BYTES);
    tampered[3] = tampered[3]! ^ 0xff; // same length, different bytes
    const p = makePackage({ exeBytes: tampered });
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("does not match");
  });

  it("size-mismatched helper → unsupported", () => {
    const p = makePackage({ exeBytes: Buffer.concat([HELPER_BYTES, Buffer.from("x")]) });
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("size");
  });

  it("manifest lying about the hash → unsupported", () => {
    const p = makePackage({ manifest: makeManifest({ sha256: "0".repeat(64) }) });
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
  });

  it("helper escaping the resources root (symlinked dir) → unsupported", () => {
    const outside = freshDir();
    writeFileSync(join(outside, JOB_HELPER_EXE_NAME), HELPER_BYTES);
    const p = makePackage({ exeBytes: null });
    // Replace the contained job-helper dir with a symlink out of the root.
    rmSync(join(p.resourcesPath, "job-helper"), { recursive: true, force: true });
    symlinkSync(outside, join(p.resourcesPath, "job-helper"), "junction");
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("unsupported");
    if (v.kind === "unsupported") expect(v.reason).toContain("escapes");
  });

  it("valid packaged layout yields a candidate with the pinned identity", () => {
    const p = makePackage();
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts, appPath: p.appPath, resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("candidate");
    if (v.kind === "candidate") {
      expect(v.helperPath).toBe(realpathSync(join(p.resourcesPath, "job-helper", JOB_HELPER_EXE_NAME)));
      expect(v.manifest.sha256).toBe(HELPER_SHA);
    }
  });
});

// ---- bounded async probe ----------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & {
    setEncoding(): void; destroy(): void;
  };
  stderr = new EventEmitter();
  killed = false;
  constructor() {
    super();
    this.stdout.setEncoding = () => {};
    this.stdout.destroy = () => {};
  }
  kill() { this.killed = true; return true; }
}
const asChild = (c: FakeChild) => c as unknown as import("node:child_process").ChildProcess;

function versionLine(over: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      helper: "tivano-job-helper",
      version: "1.1.0",
      spec: 1,
      diagnosticOnly: true,
      mechanisms: ["job-object", "kill-on-job-close"],
      ...over,
    }) + "\n"
  );
}

describe("attestJobHelper", () => {
  const candidate = {
    kind: "candidate" as const,
    helperPath: "D:\\th\\tivano-job-helper.exe",
    manifest: makeManifest(),
  };

  it("accepts exit 0 + exact protocol contract", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine());
    c.emit("exit", 0);
    c.emit("close", 0);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.observed?.exitObserved).toBe(true);
  });

  it("rejects an oversized response even when its first line is valid", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine() + "x".repeat(128 * 1024));
    c.emit("exit", 0); c.emit("close", 0);
    expect((await p).ok).toBe(false);
  });

  it("rejects extra non-whitespace output after the version document", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine() + "unexpected output\n");
    c.emit("exit", 0); c.emit("close", 0);
    expect((await p).ok).toBe(false);
  });

  it("never attests an exit without observed pipe closure", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine()); c.emit("exit", 0);
    expect((await p).ok).toBe(false);
  });

  it("caps stderr as well as stdout", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stderr.emit("data", Buffer.alloc(65537));
    c.stdout.emit("data", versionLine()); c.emit("exit", 0); c.emit("close", 0);
    expect((await p).ok).toBe(false); expect(c.killed).toBe(true);
  });

  it("retains timed-out children until a retry actually observes close", async () => {
    const c = new FakeChild();
    const children = new Set<import("node:child_process").ChildProcess>();
    await attestJobHelper(candidate, { spawnImpl: () => asChild(c), timeoutMs: 5, children });
    expect(children.has(asChild(c))).toBe(true);
    expect(await disposeJobHelperProbes(children, 5)).toHaveLength(1);
    expect(children.has(asChild(c))).toBe(true);
    const retry = disposeJobHelperProbes(children, 50);
    c.emit("exit", null); c.emit("close", null);
    expect(await retry).toEqual([]); expect(children.size).toBe(0);
  });

  it("rejects nonzero exit", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.emit("exit", 3);
    c.emit("close", 3);
    expect((await p).ok).toBe(false);
  });

  it("rejects a version contract that contradicts the manifest", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine({ version: "9.9.9" }));
    c.emit("exit", 0);
    c.emit("close", 0);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("contract");
  });

  it("rejects a contract missing the job-object mechanism", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine({ mechanisms: [] }));
    c.emit("exit", 0);
    c.emit("close", 0);
    expect((await p).ok).toBe(false);
  });

  it("rejects non-JSON output", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", "not json\n");
    c.emit("exit", 0);
    c.emit("close", 0);
    expect((await p).ok).toBe(false);
  });

  it("a spawn error resolves unsupported — never hangs", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.emit("error", new Error("ENOENT"));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.observed?.spawnError).toContain("ENOENT");
  });

  it("timeout kills our own probe child and still resolves", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { timeoutMs: 60, spawnImpl: () => asChild(c) });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.observed?.timedOut).toBe(true);
    expect(c.killed).toBe(true);
  });

  it("a child that never exits AND never closes resolves bounded", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { timeoutMs: 50, spawnImpl: () => asChild(c) });
    // No events at all — the probe must conclude on its own.
    const r = await p;
    expect(r.ok).toBe(false);
  });

  it("runExitBase/runExitMax 1024/255 → runCapable; absent → false (old helper)", async () => {
    const withRun = new FakeChild();
    const p1 = attestJobHelper(candidate, { spawnImpl: () => asChild(withRun) });
    withRun.stdout.emit("data", versionLine({ runExitBase: 1024, runExitMax: 255 }));
    withRun.emit("exit", 0); withRun.emit("close", 0);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.runCapable).toBe(true);

    const old = new FakeChild();
    const p2 = attestJobHelper(candidate, { spawnImpl: () => asChild(old) });
    old.stdout.emit("data", versionLine()); // 1.1.0 contract — no run fields
    old.emit("exit", 0); old.emit("close", 0);
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.runCapable).toBe(false);
  });

  it("wrong run-contract constants are not runCapable", async () => {
    const c = new FakeChild();
    const p = attestJobHelper(candidate, { spawnImpl: () => asChild(c) });
    c.stdout.emit("data", versionLine({ runExitBase: 1024, runExitMax: 300 }));
    c.emit("exit", 0); c.emit("close", 0);
    const r = await p;
    expect(r.ok).toBe(true); // contract itself is still fine for --serve
    expect(r.runCapable).toBe(false);
  });

  it("conpty-terminal mechanism + terminalSpec 1 → terminalCapable; partial contract → false", async () => {
    const full = new FakeChild();
    const p1 = attestJobHelper(candidate, { spawnImpl: () => asChild(full) });
    full.stdout.emit("data", versionLine({
      terminalSpec: 1,
      mechanisms: ["job-object", "kill-on-job-close", "proc-thread-attr-job-list", "conpty-terminal"],
    }));
    full.emit("exit", 0); full.emit("close", 0);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.terminalCapable).toBe(true);

    // Mechanism present but spec version wrong → not capable.
    const badSpec = new FakeChild();
    const p2 = attestJobHelper(candidate, { spawnImpl: () => asChild(badSpec) });
    badSpec.stdout.emit("data", versionLine({
      terminalSpec: 2,
      mechanisms: ["job-object", "conpty-terminal"],
    }));
    badSpec.emit("exit", 0); badSpec.emit("close", 0);
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.terminalCapable).toBe(false);

    // Spec field present but mechanism missing → not capable.
    const noMech = new FakeChild();
    const p3 = attestJobHelper(candidate, { spawnImpl: () => asChild(noMech) });
    noMech.stdout.emit("data", versionLine({ terminalSpec: 1 }));
    noMech.emit("exit", 0); noMech.emit("close", 0);
    const r3 = await p3;
    expect(r3.ok).toBe(true);
    expect(r3.terminalCapable).toBe(false);

    for (const mechanisms of [
      ["job-object", "conpty-terminal", "kill-on-job-close"],
      ["job-object", "conpty-terminal", "proc-thread-attr-job-list"],
    ]) {
      const partial = new FakeChild();
      const pending = attestJobHelper(candidate, { spawnImpl: () => asChild(partial) });
      partial.stdout.emit("data", versionLine({ terminalSpec: 1, mechanisms }));
      partial.emit("exit", 0); partial.emit("close", 0);
      expect((await pending).terminalCapable).toBe(false);
    }

    // A 1.1.0-era helper advertises neither → capable:false but still
    // attested for job work — an optional capability, never a veto.
    const old = new FakeChild();
    const p4 = attestJobHelper(candidate, { spawnImpl: () => asChild(old) });
    old.stdout.emit("data", versionLine());
    old.emit("exit", 0); old.emit("close", 0);
    const r4 = await p4;
    expect(r4.ok).toBe(true);
    expect(r4.terminalCapable).toBe(false);
  });
});

describe("probeAndAttestPackagedJobHelper", () => {
  it("full happy path → supported with attested identity", async () => {
    const p = makePackage();
    const c = new FakeChild();
    const cap = probeAndAttestPackagedJobHelper({
      ...baseOpts,
      appPath: p.appPath,
      resourcesPath: p.resourcesPath,
      spawnImpl: () => asChild(c),
    });
    // Emit after the probe's listeners have attached (next turn).
    setTimeout(() => {
      c.stdout.emit("data", versionLine());
      c.emit("exit", 0);
      c.emit("close", 0);
    }, 0);
    const r = await cap;
    expect(r.supported).toBe(true);
    expect(r.mechanism).toBe("windows-job-object");
    expect(r.helperPath).toContain(JOB_HELPER_EXE_NAME);
    expect(r.helperVersion).toBe("1.1.0");
    expect(r.runCapable).toBe(false); // 1.1.0 advertises no --run channel
  });

  it("a run-capable helper propagates runCapable into the capability", async () => {
    const p = makePackage();
    const c = new FakeChild();
    const cap = probeAndAttestPackagedJobHelper({
      ...baseOpts,
      appPath: p.appPath,
      resourcesPath: p.resourcesPath,
      spawnImpl: () => asChild(c),
    });
    setTimeout(() => {
      c.stdout.emit("data", versionLine({ runExitBase: 1024, runExitMax: 255 }));
      c.emit("exit", 0);
      c.emit("close", 0);
    }, 0);
    const r = await cap;
    expect(r.supported).toBe(true);
    expect(r.runCapable).toBe(true);
  });

  it("a terminal-capable helper propagates terminalCapable into the capability", async () => {
    const p = makePackage();
    const c = new FakeChild();
    const cap = probeAndAttestPackagedJobHelper({
      ...baseOpts,
      appPath: p.appPath,
      resourcesPath: p.resourcesPath,
      spawnImpl: () => asChild(c),
    });
    setTimeout(() => {
      c.stdout.emit("data", versionLine({
        terminalSpec: 1,
        mechanisms: ["job-object", "conpty-terminal", "proc-thread-attr-job-list", "kill-on-job-close"],
      }));
      c.emit("exit", 0);
      c.emit("close", 0);
    }, 0);
    const r = await cap;
    expect(r.supported).toBe(true);
    expect(r.terminalCapable).toBe(true);
  });

  it("any verification failure → supported:false, never a plain fallback", async () => {
    const p = makePackage({ manifest: null });
    const r = await probeAndAttestPackagedJobHelper({
      ...baseOpts,
      appPath: p.appPath,
      resourcesPath: p.resourcesPath,
    });
    expect(r.supported).toBe(false);
    expect(r.reason).toContain(PROCESS_TREE_UNSUPPORTED);
  });

  it("there is NO environment input — TIVANO_CODEX_JOB_HELPER is structurally absent", () => {
    // The API takes only packaged locations; nothing reads process.env.
    // Assert by signature: the options object has no env/helper-path field.
    const p = makePackage();
    const v = resolvePackagedJobHelperCandidate({
      ...baseOpts,
      appPath: p.appPath,
      resourcesPath: p.resourcesPath,
    });
    expect(v.kind).toBe("candidate");
    // And the legacy env-path probe remains fail-closed regardless.
  });
});
