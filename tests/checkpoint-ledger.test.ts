// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2L-REPAIR-01 ledger durability regressions. Covers the three lead
// probes (symlink root escapes, unknown-version overwrite, phantom
// complete after failed persist) plus the strict-document semantics:
// preserved bytes on any corruption, duplicate-identity refusal,
// bounded reads, abandoned-capture recovery and candidate-only publish.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointLedger,
  LedgerUnavailableError,
  LEDGER_MAX_RECORDS,
  LEDGER_VERSION,
} from "../src/main/checkpointLedger";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ckpt-ledger-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LEDGER_FILE = "ledger.v1.json";
const seed = (dir: string, doc: unknown) =>
  writeFileSync(join(dir, LEDGER_FILE), JSON.stringify(doc));
const seedRaw = (dir: string, text: string) =>
  writeFileSync(join(dir, LEDGER_FILE), text);
const baseRec = (over: Record<string, unknown> = {}) => ({
  recordId: "r1",
  projectId: "p1",
  threadId: "t1",
  turnId: "u1",
  grantDir: "/w",
  createdAt: 1,
  updatedAt: 1,
  status: "unavailable",
  touchedPaths: [],
  ...over,
});
const reserveArgs = (turnId = "tu-1") => ({
  projectId: "pr-1",
  threadId: "th-1",
  turnId,
  grantDir: "/tmp/ws",
  touchedPaths: [] as string[],
});

describe("lead probes: root and leaf confinement", () => {
  it("refuses a symlinked ledger root — nothing is written outside it", () => {
    const outside = tmp();
    const link = join(tmp(), "linked-root");
    symlinkSync(outside, link, "dir");
    const l = new CheckpointLedger(link, dirname(link));
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
    expect(l.availability()).toMatchObject({ ok: false });
    // NOTHING followed the link: no ledger file, no tmp leftovers.
    expect(readdirSync(outside)).toEqual([]);
    expect(readlinkSync(link)).toBe(outside); // link itself untouched
  });

  it("refuses a non-directory root (regular file at root path)", () => {
    const dir = tmp();
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const l = new CheckpointLedger(file, dir);
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  it("refuses a root REPLACED after its identity was pinned", () => {
    const dir = tmp();
    const root = join(dir, "checkpoints");
    const l = new CheckpointLedger(root, dir);
    l.reserve(reserveArgs()); // pins dev/ino
    const before = lstatSync(root);
    rmSync(root, { recursive: true });
    mkdirSync(root);
    const after = lstatSync(root);
    if (after.ino === before.ino && after.dev === before.dev) {
      // The fs recycled the identity — a replaced-root proof is
      // impossible on this host; still prove a symlink swap refuses.
      rmSync(root);
      symlinkSync(tmp(), root, "dir");
    }
    expect(() => l.reserve(reserveArgs("tu-2"))).toThrowError(LedgerUnavailableError);
  });

  it("refuses a symlinked ledger FILE", () => {
    const dir = tmp();
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, LEDGER_FILE));
    const l = new CheckpointLedger(dir, dir);
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
    expect(readFileSync(target, "utf8")).toBe("{}"); // never touched
  });

  it("refuses a directory at the ledger file path", () => {
    const dir = tmp();
    mkdirSync(join(dir, LEDGER_FILE));
    const l = new CheckpointLedger(dir, dir);
    expect(l.all()).toEqual([]);
    expect(l.availability()).toMatchObject({ ok: false });
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
  });

  it("refuses a symlinked ANCESTOR between anchor and root — nothing written outside", () => {
    // Lead R2 probe: root = fixture/link/store, link → outside.
    const fixture = tmp();
    const outside = tmp();
    symlinkSync(outside, join(fixture, "link"), "dir");
    const l = new CheckpointLedger(join(fixture, "link", "store"), fixture);
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("a ledger outside its declared anchor refuses", () => {
    const anchor = tmp();
    const elsewhere = tmp();
    const l = new CheckpointLedger(elsewhere, anchor);
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
  });

  it("an ancestor REPLACED after pinning refuses", () => {
    const dir = tmp();
    const l = new CheckpointLedger(join(dir, "checkpoints"), dir);
    l.reserve(reserveArgs());
    // Swap the anchor directory: rename it aside, symlink its place.
    const aside = `${dir}-aside`;
    renameSync(dir, aside);
    symlinkSync(aside, dir, "dir");
    dirs.push(aside); // afterEach cleanup covers the renamed real dir
    expect(() => l.reserve(reserveArgs("tu-2"))).toThrowError(LedgerUnavailableError);
  });
});

describe("lead probes: foreign documents are preserved, never adopted", () => {
  it("an unknown-version document keeps its bytes and refuses mutation", () => {
    const dir = tmp();
    const original = JSON.stringify({
      version: 999,
      sentinel: "LEAD_SENTINEL",
      records: [baseRec()],
    });
    seedRaw(dir, original);
    const l = new CheckpointLedger(dir, dir);
    expect(l.all()).toEqual([]);
    expect(l.availability().ok).toBe(false);
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
    // Byte-for-byte preservation — no empty-valid overwrite.
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toBe(original);
  });

  it("corrupt JSON is preserved and refuses mutation", () => {
    const dir = tmp();
    seedRaw(dir, "{not json at all");
    const l = new CheckpointLedger(dir, dir);
    expect(l.availability().ok).toBe(false);
    expect(() => l.update("x", {})).toThrowError(LedgerUnavailableError);
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toBe("{not json at all");
  });

  it("a doc with ONE malformed record is rejected wholesale, not truncated", () => {
    const dir = tmp();
    const original = JSON.stringify({
      version: LEDGER_VERSION,
      records: [baseRec(), { recordId: 42 }],
    });
    seedRaw(dir, original);
    const l = new CheckpointLedger(dir, dir);
    expect(l.all()).toEqual([]); // NO partial adoption
    expect(l.availability().ok).toBe(false);
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toBe(original);
  });

  it("duplicate recordIds and duplicate turn identities refuse", () => {
    for (const records of [
      [baseRec({ recordId: "dup" }), baseRec({ recordId: "dup", turnId: "u2" })],
      [baseRec(), baseRec({ recordId: "r2" })], // same threadId+turnId
    ]) {
      const dir = tmp();
      seed(dir, { version: LEDGER_VERSION, records });
      const l = new CheckpointLedger(dir, dir);
      expect(l.availability().ok).toBe(false);
      expect(() => l.reserve(reserveArgs("tu-new"))).toThrowError(LedgerUnavailableError);
    }
  });

  it("an over-bound document refuses; a missing file stays a valid empty ledger", () => {
    const dir = tmp();
    seed(dir, {
      version: LEDGER_VERSION,
      records: Array.from({ length: LEDGER_MAX_RECORDS + 1 }, (_, i) =>
        baseRec({ recordId: `r${i}`, turnId: `u${i}` }),
      ),
    });
    const l = new CheckpointLedger(dir, dir);
    expect(l.availability().ok).toBe(false);
    const emptyRoot = tmp();
    const empty = new CheckpointLedger(join(emptyRoot, "checkpoints"), emptyRoot);
    expect(empty.all()).toEqual([]);
    expect(empty.availability().ok).toBe(true);
  });
});

describe("lead probes: candidate publish — failed persists never mint", () => {
  it("a failed update keeps the pre-mutation record, not a phantom complete", () => {
    const dir = tmp();
    const root = join(dir, "checkpoints");
    const l = new CheckpointLedger(root, dir);
    const rec = l.reserve(reserveArgs());
    // Move the file aside and plant a directory at the ledger path.
    renameSync(join(root, LEDGER_FILE), join(root, "ledger-aside.json"));
    mkdirSync(join(root, LEDGER_FILE));
    expect(() =>
      l.update(rec.recordId, {
        status: "complete",
        baseCheckpointId: "b",
        endCheckpointId: "e",
      }),
    ).toThrow();
    // The cached record is UNCHANGED — no phantom complete.
    expect(l.get(rec.recordId)!.status).toBe("capturing");
    expect(l.get(rec.recordId)!.endCheckpointId).toBeUndefined();
    // The ledger marked itself unavailable — no failing write loop.
    expect(l.availability().ok).toBe(false);
    expect(() => l.reserve(reserveArgs("tu-2"))).toThrowError(LedgerUnavailableError);
    // Only our own tmp could remain — none does; the planted dir stays.
    expect(
      readdirSync(root).filter((f) => f.includes(".tmp-")).length,
    ).toBe(0);
  });

  it("a failed reserve leaves no cached record at all", () => {
    const dir = tmp();
    mkdirSync(join(dir, LEDGER_FILE)); // leaf already unsafe
    const l = new CheckpointLedger(dir, dir);
    expect(() => l.reserve(reserveArgs())).toThrow();
    expect(l.all()).toEqual([]);
  });

  it("a failed invalidateWhere keeps the original statuses", () => {
    const dir = tmp();
    const root = join(dir, "checkpoints");
    const l = new CheckpointLedger(root, dir);
    const rec = l.reserve(reserveArgs());
    renameSync(join(root, LEDGER_FILE), join(root, "ledger-aside.json"));
    mkdirSync(join(root, LEDGER_FILE));
    expect(() =>
      l.invalidateWhere((r) => r.status === "capturing", "closing"),
    ).toThrow();
    expect(l.get(rec.recordId)!.status).toBe("capturing");
  });
});

describe("lead probes R2: leaf identity and input ownership", () => {
  it("a foreign regular file replacing the pinned leaf is preserved, never overwritten", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    l.reserve(reserveArgs());
    // Swap the ledger file for a different regular file (new inode).
    const foreign = JSON.stringify({ version: 999, records: [], sentinel: "PRESERVE" });
    writeFileSync(join(dir, "foreign.json"), foreign);
    renameSync(join(dir, "foreign.json"), join(dir, LEDGER_FILE));
    expect(() => l.reserve(reserveArgs("tu-2"))).toThrowError(LedgerUnavailableError);
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toBe(foreign);
    expect(l.availability().ok).toBe(false);
  });

  it("unexpected creation after absent was pinned refuses — foreign bytes kept", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    expect(l.all()).toEqual([]); // pins leaf as absent
    const foreign = JSON.stringify({ version: 999, sentinel: "PRESERVE" });
    writeFileSync(join(dir, LEDGER_FILE), foreign);
    expect(() => l.reserve(reserveArgs())).toThrowError(LedgerUnavailableError);
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toBe(foreign);
  });

  it("leaf deletion after pinning refuses mutation", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    const rec = l.reserve(reserveArgs());
    rmSync(join(dir, LEDGER_FILE));
    expect(() => l.update(rec.recordId, { status: "unavailable" })).toThrowError(
      LedgerUnavailableError,
    );
  });

  it("reserve owns its inputs — mutating the caller's array changes nothing", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    const input: { projectId: string; threadId: string; turnId: string; grantDir: string; touchedPaths: string[] } = {
      projectId: "pr-1", threadId: "th-1", turnId: "tu-1", grantDir: "/tmp/ws",
      touchedPaths: ["kept.txt"],
    };
    const rec = l.reserve(input);
    input.touchedPaths.push("not-persisted.txt");
    // Cache view is unchanged…
    expect(l.get(rec.recordId)!.touchedPaths).toEqual(["kept.txt"]);
    // …and so is the disk truth.
    const disk = JSON.parse(readFileSync(join(dir, LEDGER_FILE), "utf8"));
    expect(disk.records[0].touchedPaths).toEqual(["kept.txt"]);
    // The returned record is also a copy — mutating it can't reach cache.
    rec.touchedPaths.push("forged.txt");
    expect(l.get(rec.recordId)!.touchedPaths).toEqual(["kept.txt"]);
  });

  it("reserve rejects malformed input (empty identity) before writing", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    expect(() => l.reserve({ ...reserveArgs(), turnId: "" })).toThrowError(
      LedgerUnavailableError,
    );
    expect(l.all()).toEqual([]);
  });

  it("update refuses identity-field and unknown-field patches", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    const rec = l.reserve(reserveArgs());
    expect(() => l.update(rec.recordId, { turnId: "hijack" })).toThrowError(
      LedgerUnavailableError,
    );
    expect(() => l.update(rec.recordId, { createdAt: 0 })).toThrowError(
      LedgerUnavailableError,
    );
    expect(() =>
      l.update(rec.recordId, { bogus: true } as never),
    ).toThrowError(LedgerUnavailableError);
    // Identity intact, ledger still healthy.
    expect(l.get(rec.recordId)!.turnId).toBe("tu-1");
    expect(l.availability().ok).toBe(true);
  });

  it("an update that would violate record invariants refuses before write", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    const rec = l.reserve(reserveArgs());
    // "complete" without both manifest ids is schema-invalid.
    expect(() =>
      l.update(rec.recordId, { status: "complete" }),
    ).toThrowError(LedgerUnavailableError);
    const disk = JSON.parse(readFileSync(join(dir, LEDGER_FILE), "utf8"));
    expect(disk.records[0].status).toBe("capturing");
  });
});

describe("reopen recovery and bounds", () => {
  it("abandoned capturing records recover to unavailable on reopen", () => {
    const dir = tmp();
    const l1 = new CheckpointLedger(dir, dir);
    const rec = l1.reserve(reserveArgs());
    expect(rec.status).toBe("capturing");
    // Simulate restart — a fresh instance must not see in-flight.
    const l2 = new CheckpointLedger(dir, dir);
    const again = l2.get(rec.recordId)!;
    expect(again.status).toBe("unavailable");
    expect(again.reason).toBe("interrupted-by-restart");
    // And it was persisted — a THIRD instance agrees.
    const l3 = new CheckpointLedger(dir, dir);
    expect(l3.get(rec.recordId)!.status).toBe("unavailable");
  });

  it("an all-capturing ledger refuses admission past the bound", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    for (let i = 0; i < LEDGER_MAX_RECORDS; i++) l.reserve(reserveArgs(`tu-${i}`));
    expect(() => l.reserve(reserveArgs("tu-overflow"))).toThrowError(
      LedgerUnavailableError,
    );
    // A completed record CAN be evicted for a new admission.
    const any = l.byTurn("th-1", "tu-0")!;
    l.update(any.recordId, {
      status: "complete",
      baseCheckpointId: "b",
      endCheckpointId: "e",
    });
    const admitted = l.reserve(reserveArgs("tu-new"));
    expect(admitted.status).toBe("capturing");
    expect(l.all().length).toBe(LEDGER_MAX_RECORDS);
  });

  it("a duplicate turn reserve refuses — no ambiguous ownership", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    l.reserve(reserveArgs("tu-1"));
    expect(() => l.reserve(reserveArgs("tu-1"))).toThrowError(
      LedgerUnavailableError,
    );
    expect(l.all().length).toBe(1);
  });
});

describe("accessor isolation", () => {
  it("returned records are copies — callers cannot mutate the cache", () => {
    const dir = tmp();
    const l = new CheckpointLedger(dir, dir);
    const rec = l.reserve(reserveArgs());
    const got = l.get(rec.recordId)!;
    got.status = "complete";
    got.touchedPaths.push("../evil");
    got.endCheckpointId = "forged";
    const again = l.get(rec.recordId)!;
    expect(again.status).toBe("capturing");
    expect(again.touchedPaths).toEqual([]);
    expect(again.endCheckpointId).toBeUndefined();
    const listed = l.list("th-1");
    listed[0]!.status = "complete";
    expect(l.get(rec.recordId)!.status).toBe("capturing");
  });
});
