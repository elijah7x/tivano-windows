// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Injected-failure persistence tests: a corrupt file whose backup rename
// fails must fail CLOSED (original bytes untouched, no empty overwrite); a
// failed flush keeps the lock and the previous file contents.

import {
  mkdtempSync,
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
      d.settings.theme = "dark";
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
    expect(after.settings.theme).toBe("dark");
    s.close();
  });

  it("close() with a failing final flush throws, keeps ownership, and retries", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    s.update((d) => {
      d.settings.theme = "dark";
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
    expect(stored.settings.theme).toBe("dark");
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
    s.update((d) => { d.settings.theme = "dark"; });
    s.close();
    expect(JSON.parse(readFileSync(join(root, "store.json"), "utf8")).settings.theme).toBe("dark");
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
});
