// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Process-tree capability probe + job-helper spawn encoding. The verdict is
// fail-closed: anything that is not a verified Windows Job helper reports
// unsupported, and unsupported means real launches are refused upstream.

import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_TREE_UNSUPPORTED,
  ProcessTreeError,
  makeJobHelperSpawnImpl,
  probeProcessTreeSupport,
} from "../src/main/providerProcessLifecycle";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-jobprobe-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("probeProcessTreeSupport", () => {
  it("non-Windows platforms are unsupported regardless of helper", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const c = probeProcessTreeSupport({ platform, helperPath: "/x/helper.exe" });
      expect(c.supported).toBe(false);
      expect(c.reason).toContain(PROCESS_TREE_UNSUPPORTED);
    }
  });

  it("win32 without a helper path is unsupported", () => {
    const c = probeProcessTreeSupport({ platform: "win32", helperPath: null });
    expect(c.supported).toBe(false);
    expect(c.reason).toContain("job-helper");
  });

  it("win32 with a relative helper path is unsupported", () => {
    const c = probeProcessTreeSupport({ platform: "win32", helperPath: "helpers\\job.exe" });
    expect(c.supported).toBe(false);
  });

  it("win32 with a missing helper file is unsupported", () => {
    const c = probeProcessTreeSupport({
      platform: "win32",
      helperPath: join(freshDir(), "nope.exe"),
    });
    expect(c.supported).toBe(false);
    expect(c.reason).toContain("not a real file");
  });

  it("win32 with a symlink helper is refused (physical file required)", () => {
    const d = freshDir();
    const real = join(d, "helper.exe");
    writeFileSync(real, "x");
    const link = join(d, "link.exe");
    symlinkSync(real, link);
    const c = probeProcessTreeSupport({ platform: "win32", helperPath: link });
    expect(c.supported).toBe(false);
  });

  it("a real file on disk is NEVER evidence — win32 stays unsupported", () => {
    // Native helper tests do not prove that an arbitrary configured file
    // is the tested helper or that application integration is complete.
    const d = freshDir();
    const helper = join(d, "helper.exe");
    writeFileSync(helper, "MZ");
    const c = probeProcessTreeSupport({ platform: "win32", helperPath: helper });
    expect(c.supported).toBe(false);
    expect(c.reason).toContain("no verified application integration");
    expect(c.helperPath).toBe(realpathSync(helper));
  });

  it("no seam, env, or existing file can mint Windows launch evidence", () => {
    const d = freshDir();
    const helper = join(d, "helper.exe");
    writeFileSync(helper, "MZ");
    for (const c of [
      probeProcessTreeSupport({ platform: "win32", helperPath: helper }),
      probeProcessTreeSupport({ platform: "win32", helperPath: helper, helperExists: () => true }),
      probeProcessTreeSupport({ platform: "win32", helperPath: null }),
    ]) {
      expect(c.supported).toBe(false);
      expect(c.reason).toContain("PROCESS_TREE_UNSUPPORTED");
    }
  });
});

describe("makeJobHelperSpawnImpl", () => {
  it("encodes the payload spec as one base64url --serve argument", () => {
    const impl = makeJobHelperSpawnImpl("D:\\th\\job-helper.exe");
    const spec = {
      executable: "D:\\codex\\codex.exe",
      args: ["app-server"],
      cwd: "D:\\w",
      env: { CODEX_HOME: "D:\\h" },
    };
    const cp = impl(spec);
    // The win32 path cannot spawn on this host — the argv is already built,
    // which is what this test asserts. Swallow the async ENOENT.
    cp.on("error", () => {});
    cp.unref();
    expect(cp.spawnargs[0]).toBe("D:\\th\\job-helper.exe");
    expect(cp.spawnargs[1]).toBe("--serve");
    const decoded = JSON.parse(
      Buffer.from(String(cp.spawnargs[2]), "base64url").toString("utf8"),
    );
    // spec v1 pins the schema version and supplies the owner pid the
    // helper must verify before any payload exists.
    expect(decoded).toEqual({ v: 1, ownerPid: process.pid, ...spec });
  });

  it("refuses an encoded spec that cannot fit the helper command line", () => {
    const impl = makeJobHelperSpawnImpl("D:\\th\\job-helper.exe");
    const spec = {
      executable: "D:\\codex\\codex.exe",
      args: ["app-server"],
      cwd: "D:\\w",
      // base64 expands ~4/3× — JSON above ~24 KB encodes past the
      // 32767-char lpCommandLine budget and must be refused up front.
      env: { PAD: "x".repeat(30000) },
    };
    expect(() => impl(spec)).toThrow(ProcessTreeError);
    expect(() => impl(spec)).toThrow(/command-line budget/);
  });

  it("accepts a spec whose encoded size fits the budget", () => {
    const impl = makeJobHelperSpawnImpl("D:\\th\\job-helper.exe");
    const spec = {
      executable: "D:\\codex\\codex.exe",
      args: [],
      cwd: "D:\\w",
      env: { PAD: "x".repeat(20000) },
    };
    const cp = impl(spec);
    cp.on("error", () => {});
    cp.unref();
    expect(cp.spawnargs[1]).toBe("--serve");
  });
});
