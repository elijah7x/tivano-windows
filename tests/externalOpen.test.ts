// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { externalOpenLogPath, recordExternalOpen } from "../src/main/externalOpen";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ext-open-test-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("externalOpenLogPath gating", () => {
  it("armed: unpackaged + explicit env + temp data root", () => {
    const log = join(tmp(), "log.jsonl");
    const p = externalOpenLogPath(
      { TIVANO_TEST_EXTERNAL_OPEN: log },
      { packaged: false, dataRoot: tmp() },
    );
    expect(p).toBe(log);
  });

  it("refuses packaged builds even with env set", () => {
    expect(
      externalOpenLogPath(
        { TIVANO_TEST_EXTERNAL_OPEN: join(tmp(), "l") },
        { packaged: true, dataRoot: tmp() },
      ),
    ).toBeNull();
  });

  it("refuses without the explicit env", () => {
    expect(externalOpenLogPath({}, { packaged: false, dataRoot: tmp() })).toBeNull();
  });

  it("refuses a non-temp data root identity", () => {
    expect(
      externalOpenLogPath(
        { TIVANO_TEST_EXTERNAL_OPEN: join(tmp(), "l") },
        { packaged: false, dataRoot: "/Users/someone/Library/Application Support/Tivano" },
      ),
    ).toBeNull();
  });

  it("refuses a relative or empty log path", () => {
    const dataRoot = tmp();
    for (const v of ["", "relative.jsonl", "  "])
      expect(
        externalOpenLogPath(
          { TIVANO_TEST_EXTERNAL_OPEN: v },
          { packaged: false, dataRoot },
        ),
      ).toBeNull();
  });
});

describe("recordExternalOpen", () => {
  it("appends one JSON line per intent with action/target/detail", () => {
    const log = join(tmp(), "opens.jsonl");
    recordExternalOpen(log, { action: "openPath", target: "/a/b" });
    recordExternalOpen(log, { action: "openWithEditor", target: "/c", detail: "terminal" });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { action: "openPath", target: "/a/b" },
      { action: "openWithEditor", target: "/c", detail: "terminal" },
    ]);
  });
});
