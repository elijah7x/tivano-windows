// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F13 detection slice: probeForgeClis reports which forge CLIs are on
// PATH — presence + --version first line only, bounded spawns, honest
// not-found for missing binaries.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeForgeClis } from "../src/main/forgeProbe";

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "tivano-forge-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function stubBin(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

describe("forge CLI detection (F13 bounded slice)", () => {
  it("reports found + version for a CLI on PATH", async () => {
    const dir = root();
    stubBin(dir, "gh", 'echo "gh version 9.9.9-synthetic (2026-10-31)"');
    stubBin(dir, "tea", 'echo "Tea Version: 0.0.1"');
    stubBin(dir, "origin", 'echo "origin version 1.0.0-synthetic"');
    const rows = await probeForgeClis({ path: dir });
    const gh = rows.find((r) => r.id === "gh")!;
    const glab = rows.find((r) => r.id === "glab")!;
    const tea = rows.find((r) => r.id === "tea")!;
    const origin = rows.find((r) => r.id === "origin")!;
    expect(gh.found).toBe(true);
    expect(gh.version).toContain("9.9.9-synthetic");
    expect(glab.found).toBe(false);
    expect(tea.found).toBe(true);
    expect(tea.version).toContain("0.0.1");
    // A75: the frozen PR-opening list includes the Cursor Origin CLI —
    // presence + version only, `origin auth status` stays unprobed.
    expect(origin.found).toBe(true);
    expect(origin.version).toContain("1.0.0-synthetic");
    expect(origin.forge).toBe("origin");
    // Honest labels — the row names its forge for the UI.
    expect(gh.forge).toBe("github");
    expect(glab.forge).toBe("gitlab");
  });

  it("an empty PATH reports every CLI as not found, never throws", async () => {
    const dir = root(); // exists but holds no binaries
    const rows = await probeForgeClis({ path: dir });
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.found).toBe(false);
  });

  it("a CLI answering with a non-zero exit still counts as present", async () => {
    const dir = root();
    // gh --version that exits 1 but exists (e.g. a wrapper) — the binary
    // is on PATH, so found:true with no fabricated version.
    stubBin(dir, "gh", "exit 1");
    const rows = await probeForgeClis({ path: dir });
    const gh = rows.find((r) => r.id === "gh")!;
    expect(gh.found).toBe(true);
    expect(gh.version).toBeUndefined();
  });

  it("a hanging CLI is bounded by the probe timeout", async () => {
    const dir = root();
    // /bin/sleep is absolute: the probe env gives the child only the
    // stub dir on PATH, so a bare `sleep` would fail instead of hanging.
    stubBin(dir, "glab", "/bin/sleep 30");
    const start = Date.now();
    const rows = await probeForgeClis({ path: dir });
    const glab = rows.find((r) => r.id === "glab")!;
    // Ran (spawned) but killed by the bound — counts as found since the
    // binary answered with a non-zero/killed result, never a hang.
    expect(Date.now() - start).toBeLessThan(15000);
    expect(glab.found).toBe(true);
    expect(glab.version).toBeUndefined();
  }, 20000);
});
