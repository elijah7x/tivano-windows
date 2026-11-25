// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Injected-failure persistence tests: a corrupt file whose backup rename
// fails must fail CLOSED (original bytes untouched, no empty overwrite); a
// failed flush keeps the lock and the previous file contents.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/store";
import { emptyStore } from "../src/main/store";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    copyFileSync: vi.fn(real.copyFileSync),
    writeFileSync: vi.fn(real.writeFileSync),
    renameSync: vi.fn(real.renameSync),
  };
});

const dirs: string[] = [];
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-store-fail-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("injected failures", () => {
  it("backup rename failure fails closed — evidence bytes stay intact", () => {
    const root = fresh();
    const corrupt = "{ not json !!!";
    writeFileSync(join(root, "store.json"), corrupt);

    // The corrupt-file preservation rename is the FIRST renameSync the
    // store performs — inject the failure there only.
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EPERM injected");
    });

    const s = new Store(root);
    expect(() => s.open()).toThrow(/preserved aside|refusing/i);
    // Original evidence untouched, no empty store materialized, no lock held.
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(corrupt);
    expect(s.recoveredFrom).toBeUndefined();
    s.close();
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(corrupt);
    expect(existsSync(join(root, "store.lock"))).toBe(false);
  });

  it("a failed flush keeps the lock and the original file", () => {
    const root = fresh();
    const seed = emptyStore();
    writeFileSync(join(root, "store.json"), JSON.stringify(seed));

    const s = new Store(root);
    s.open();
    s.update((d) => {
      d.settings.theme = "nord";
    });
    // Next writeFileSync call is the temp-file write inside atomicWrite.
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC injected");
    });
    expect(() => s.flushNow()).toThrow(/ENOSPC/);
    expect(s.lastWriteError).toContain("ENOSPC");

    // Lock still held — a second opener still cannot write.
    const second = new Store(root);
    expect(() => second.open()).toThrow(/lock/i);
    second.close();
    // Original document untouched by the failed flush.
    const stored = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      settings: { theme: string };
    };
    expect(stored.settings.theme).toBe("breeze");

    // Once the fault clears the pending state flushes cleanly.
    s.flushNow();
    const after = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      settings: { theme: string };
    };
    expect(after.settings.theme).toBe("nord");
    s.close();
  });

  it("close() with a failing final flush throws, keeps ownership, and retries", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    s.update((d) => {
      d.settings.theme = "nord";
    });

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC injected");
    });
    expect(() => s.close()).toThrow(/ENOSPC/);
    // Ownership and the lock survive: nothing was dropped on the floor.
    expect(s.ownsWrites).toBe(true);
    expect(existsSync(join(root, "store.lock"))).toBe(true);

    const second = new Store(root);
    expect(() => second.open()).toThrow(/lock/i);
    second.close();

    // Fault cleared: the SAME pending state is now flushed, then closed.
    expect(() => s.close()).not.toThrow();
    const stored = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      settings: { theme: string };
    };
    expect(stored.settings.theme).toBe("nord");
    expect(s.ownsWrites).toBe(false);
    // Idempotent after success.
    expect(() => s.close()).not.toThrow();
  });

  it("a failed release keeps write ownership until a successful retry", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    const original = vi.mocked(writeFileSync).getMockImplementation()!;
    vi.mocked(writeFileSync).mockImplementation(((p: unknown, ...args: unknown[]) => {
      if (typeof p === "string" && p.endsWith(join("store.lock.guard", "owner")))
        throw new Error("ENOSPC releasing lock");
      return (original as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof writeFileSync);
    expect(() => s.close()).toThrow(/ENOSPC/);
    expect(s.ownsWrites).toBe(true);
    vi.mocked(writeFileSync).mockImplementation(original);
    s.update((d) => { d.settings.theme = "nord"; });
    s.close();
    expect(JSON.parse(readFileSync(join(root, "store.json"), "utf8")).settings.theme).toBe("nord");
    expect(existsSync(join(root, "store.lock"))).toBe(false);
  });

  it("a failed lock-init write leaves no lock file and surfaces the real error", () => {
    const root = fresh();
    const realWrite = vi.mocked(writeFileSync).getMockImplementation()!;
    // The fd-write of lock contents is the only writeFileSync call that
    // receives a numeric path.
    vi.mocked(writeFileSync).mockImplementation(((p: unknown, data: unknown, opts?: unknown) => {
      if (typeof p === "number") throw new Error("ENOSPC lock init");
      return (realWrite as (...a: unknown[]) => unknown)(p, data, opts);
    }) as typeof writeFileSync);

    const s = new Store(root);
    expect(() => s.open()).toThrow(/ENOSPC lock init/);
    expect(existsSync(join(root, "store.lock"))).toBe(false);
    s.close();
  });

  it("update() never surfaces a write failure — head start sees none (P1-19)", () => {
    // restoreAllMocks only restores vi.spyOn spies — the previous test's
    // standing mockImplementation on this module vi.fn leaks otherwise.
    vi.resetAllMocks();
    const root = fresh();
    const s = new Store(root);
    s.open();
    // Pins the invariant the Hydra spawn path relies on: store.update
    // only mutates and schedules; the deferred flush swallows a write
    // failure into lastWriteError, so no thrown store failure can occur
    // at head start by construction. The only throwing write path is
    // the explicit flushNow/close one.
    vi.useFakeTimers();
    try {
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw new Error("ENOSPC injected");
      });
      expect(() =>
        s.update((d) => {
          d.settings.theme = "nord";
        }),
      ).not.toThrow();
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    expect(s.lastWriteError).toContain("ENOSPC");
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC injected");
    });
    expect(() => s.flushNow()).toThrow(/ENOSPC/);
    s.close();
  });

  it("copies stubborn segments to durable turns.corrupt-* backup when renames fail", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(copyFileSync).mockImplementation(realFs.copyFileSync);
    vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
    vi.mocked(renameSync).mockImplementation(realFs.renameSync);

    const root = fresh();
    const tid = "11111111-1111-4111-8111-111111111111";
    const turnsDir = join(root, "turns");
    mkdirSync(turnsDir, { recursive: true });
    const segPayload = JSON.stringify({
      schemaVersion: 1,
      threadId: tid,
      messages: [{ id: "m1", role: "user", content: "preserve across restarts", status: "done", ts: 1 }],
      turn: null,
    });
    writeFileSync(join(turnsDir, `${tid}.json`), segPayload);
    writeFileSync(join(root, "store.json"), "{ corrupt json");

    // 1st renameSync: store.json -> store.corrupt-*.json (succeeds)
    // 2nd renameSync: turns -> turns.corrupt-* (fails)
    // 3rd renameSync: turns/<tid>.json -> turns/<tid>.corrupt-*.json (fails)
    let renameCalls = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      renameCalls++;
      if (renameCalls === 2 || renameCalls === 3) {
        throw new Error("EBUSY injected");
      }
      return realFs.renameSync(from, to);
    });

    const s1 = new Store(root);
    const r1 = s1.open();
    expect(r1.recoveredFrom).toBeTruthy();
    vi.mocked(renameSync).mockImplementation(realFs.renameSync);
    s1.flushNow();
    s1.close();

    // Reopen and flush again as a normal post-recovery launch: the durable
    // turns.corrupt-* copy must still survive.
    const s2 = new Store(root);
    s2.open();
    s2.flushNow();
    s2.close();

    const backupDirs = readdirSync(root).filter((f) => f.startsWith("turns.corrupt-"));
    expect(backupDirs.length).toBe(1);
    expect(readFileSync(join(root, backupDirs[0]!, `${tid}.json`), "utf8")).toBe(segPayload);
  });

  it("fails closed and restores store.json if segment backup also fails", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(copyFileSync).mockImplementation(realFs.copyFileSync);
    vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
    vi.mocked(renameSync).mockImplementation(realFs.renameSync);

    const root = fresh();
    const tid = "22222222-2222-4222-8222-222222222222";
    const turnsDir = join(root, "turns");
    mkdirSync(turnsDir, { recursive: true });
    const segPayload = JSON.stringify({
      schemaVersion: 1,
      threadId: tid,
      messages: [{ id: "m1", role: "user", content: "must not lose", status: "done", ts: 1 }],
      turn: null,
    });
    const corruptHead = "{ corrupt json";
    writeFileSync(join(turnsDir, `${tid}.json`), segPayload);
    writeFileSync(join(root, "store.json"), corruptHead);

    let renameCalls = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      renameCalls++;
      if (renameCalls === 2 || renameCalls === 3) {
        throw new Error("EBUSY injected");
      }
      return realFs.renameSync(from, to);
    });
    vi.mocked(copyFileSync).mockImplementationOnce(() => {
      throw new Error("EACCES injected");
    });

    const s = new Store(root);
    try {
      expect(() => s.open()).toThrow(/turn segments could not be preserved aside/i);
      expect(readFileSync(join(root, "store.json"), "utf8")).toBe(corruptHead);
      expect(readFileSync(join(turnsDir, `${tid}.json`), "utf8")).toBe(segPayload);
      expect(existsSync(join(root, "store.lock"))).toBe(false);
    } finally {
      vi.mocked(renameSync).mockImplementation(realFs.renameSync);
      vi.mocked(copyFileSync).mockImplementation(realFs.copyFileSync);
      s.close();
    }
  });
});
