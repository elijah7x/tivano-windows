// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Evidence-directory governance: explicit paths must exist and never live
// inside the source tree; derived paths land beside the common git dir;
// an empty override is a hard error, not a silent fallback.

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename as basenameOf, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module — tested source of truth for e2e.
import { resolveEvidenceDir } from "../scripts/evidenceDir.mjs";

const dirs: string[] = [];
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-ev-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// The module takes { explicit, sourceDir }; the env var is read by the
// caller (e2e.mjs), which keeps the module deterministic under test.
describe("resolveEvidenceDir", () => {
  it("rejects an empty explicit override", () => {
    const source = fresh();
    expect(() => resolveEvidenceDir({ explicit: "", sourceDir: source })).toThrow(/empty/i);
    expect(() => resolveEvidenceDir({ explicit: "   ", sourceDir: source })).toThrow(/empty/i);
  });

  it("mints a fresh subdirectory inside an explicit directory", () => {
    const source = fresh();
    const ev = fresh();
    const out = resolveEvidenceDir({ explicit: ev, sourceDir: source });
    // Compared physically: the module reports realpaths and /var is a
    // symlink to /private/var on macOS.
    expect(dirname(out)).toBe(realpathSync(ev));
    expect(basenameOf(out).startsWith("e2e-")).toBe(true);
    expect(realpathSync(out)).toBeTruthy(); // exists on disk, unique
  });

  it("rejects an explicit directory inside the source tree", () => {
    const source = fresh();
    const inside = join(source, "evidence");
    mkdirSync(inside);
    expect(() => resolveEvidenceDir({ explicit: inside, sourceDir: source })).toThrow(
      /inside the source/i,
    );
  });

  it("rejects a symlinked explicit directory that resolves into the source", () => {
    const source = fresh();
    const inside = join(source, "real-evidence");
    mkdirSync(inside);
    const link = join(fresh(), "link");
    symlinkSync(inside, link, "dir");
    expect(() => resolveEvidenceDir({ explicit: link, sourceDir: source })).toThrow(
      /inside the source/i,
    );
  });

  it("derives a fresh directory beside the common git dir when unset", () => {
    const source = fresh();
    mkdirSync(join(source, ".git"));
    const ev = resolveEvidenceDir({ explicit: undefined, sourceDir: source });
    expect(basenameOf(ev).startsWith("tivano-win-e2e-")).toBe(true);
    expect(dirname(ev)).toBe(dirname(realpathSync(source)));
    expect(realpathSync(ev)).toBeTruthy();
  });

  it("follows a gitfile to the real common dir", () => {
    const source = fresh();
    const realGit = join(fresh(), "repo.git");
    mkdirSync(realGit);
    writeFileSync(join(source, ".git"), `gitdir: ${realGit}\n`);
    const ev = resolveEvidenceDir({ explicit: undefined, sourceDir: source });
    // commonDir's parent is the checkout root; the artifacts root is one
    // level above that — the same place a real worktree resolves to.
    expect(dirname(ev)).toBe(realpathSync(dirname(dirname(realGit))));
  });

  it("throws without an override or a git dir", () => {
    const source = fresh();
    expect(() => resolveEvidenceDir({ explicit: undefined, sourceDir: source })).toThrow(
      /E2E_EVIDENCE_DIR/,
    );
  });
});
