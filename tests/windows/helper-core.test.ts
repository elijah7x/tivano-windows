// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Portable helper-core selftest: compiles helpers/win32/helper_common.cpp +
// helper-selftest.cpp with a host C++17 compiler and runs it. This validates
// ONLY the portable layer (spec schema, base64url, quoting, env block) — it
// does NOT touch Win32 and does NOT count as Windows verification; the
// Windows-only harness lives in tests/windows/helper-harness.mjs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HELPER_DIR = fileURLToPath(new URL("../../helpers/win32", import.meta.url));

function findCompiler(): string | null {
  for (const cc of ["clang++", "g++", "c++"]) {
    try {
      execFileSync(cc, ["--version"], { stdio: "pipe" });
      return cc;
    } catch {
      /* next */
    }
  }
  return null;
}

// Module-level detection: a missing compiler marks the test SKIPPED in the
// report — it is never silently counted as a pass.
const compiler = findCompiler();

describe("helper portable core (C++ selftest)", () => {
  it.skipIf(compiler === null)(
    "compiles helper_common and passes its portable assertion suite",
    { timeout: 60_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tivano-helper-selftest-"));
      try {
        const bin = join(dir, "helper-selftest");
        execFileSync(
          compiler!,
          [
            "-std=c++17",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O1",
            "-I",
            HELPER_DIR,
            join(HELPER_DIR, "helper_common.cpp"),
            join(HELPER_DIR, "helper-selftest.cpp"),
            "-o",
            bin,
          ],
          { stdio: "pipe" },
        );
        const out = execFileSync(bin, [], { encoding: "utf8" });
        expect(out).toMatch(/HELPER-SELFTEST PASS \d+ checks/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
