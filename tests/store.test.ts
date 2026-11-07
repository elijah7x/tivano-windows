// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Isolated persistence: atomic writes, exclusive lock, corrupt/schema
// recovery with preserved backup, symlink and traversal refusal.

import { mkdtempSync, writeFileSync, symlinkSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, StoreLock, isInsideRoot, isPathInsideRoot, resolveDataRoot, emptyStore } from "../src/main/store";
import { SCHEMA_VERSION } from "../src/shared/types";

const dirs: string[] = [];
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Store", () => {
  it("round-trips state through an atomic write", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    s.update((d) => {
      d.settings.theme = "dark";
      d.projects.push({ id: "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6", name: "p", createdAt: 1, expanded: true });
    });
    s.close();
    const again = new Store(root);
    again.open();
    expect(again.state.settings.theme).toBe("dark");
    expect(again.state.projects).toHaveLength(1);
    again.close();
    // No temp files leak alongside the store.
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("refuses a second writer on the same root", () => {
    const root = fresh();
    const a = new Store(root);
    a.open();
    const b = new Store(root);
    expect(() => b.open()).toThrow(/lock/i);
    a.close();
  });

  it("reclaims a lock left by a dead process (real ESRCH)", async () => {
    const root = fresh();
    // Spawn a real child and wait for it to die, so the recorded owner pid
    // provably returns ESRCH — not just a number that looks dead.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid!;
    await new Promise((r) => child.once("exit", r));
    writeFileSync(
      join(root, "store.lock"),
      JSON.stringify({ pid: deadPid, at: Date.now(), token: "crashed-owner" }),
    );
    const s = new Store(root);
    expect(() => s.open()).not.toThrow();
    s.close();
  });

  it("recovers from a corrupt file and preserves the evidence", () => {
    const root = fresh();
    writeFileSync(join(root, "store.json"), "{ not json !!!");
    const s = new Store(root);
    const res = s.open();
    expect(res.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(res.recoveredFrom).toBeTruthy();
    expect(existsSync(res.recoveredFrom!)).toBe(true);
    s.close();
  });

  it("recovers from an older schemaVersion", () => {
    const root = fresh();
    const store = emptyStore();
    store.schemaVersion = 0; // older than current: preserved aside, clean start
    writeFileSync(join(root, "store.json"), JSON.stringify(store));
    const s = new Store(root);
    const res = s.open();
    expect(res.recoveredFrom).toBeTruthy();
    s.close();
  });

  it("refuses a symlinked store file", () => {
    const root = fresh();
    const outside = fresh();
    const real = join(outside, "elsewhere.json");
    writeFileSync(real, JSON.stringify(emptyStore()));
    symlinkSync(real, join(root, "store.json"));
    const s = new Store(root);
    expect(() => s.open()).toThrow(/link/i);
    s.close();
  });

  it("confines writes to the root", () => {
    const root = fresh();
    expect(isPathInsideRoot(root, "store.json")).toBe(true);
    expect(isPathInsideRoot(root, "../escape.json")).toBe(false);
    expect(isPathInsideRoot(root, "../../etc/passwd")).toBe(false);
    expect(isPathInsideRoot(root, "/abs/path")).toBe(false);
  });

  it("refuses a dangling store link without replacing it", () => {
    const root = fresh();
    symlinkSync(join(fresh(), "missing"), join(root, "store.json"));
    const s = new Store(root);
    expect(() => s.open()).toThrow(/link/i);
    s.close();
    expect(readdirSync(root)).toContain("store.json");
    expect(existsSync(join(root, "store.json"))).toBe(false);
  });

  it("keeps ownership when closing encounters a busy lock guard", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    const guard = join(root, "store.lock.guard");
    mkdirSync(guard);
    expect(() => s.close()).toThrow(/guard.*busy/);
    expect(s.ownsWrites).toBe(true);
    rmSync(guard, { recursive: true });
    s.update((d) => { d.settings.theme = "dark"; });
    s.close();
    expect(JSON.parse(readFileSync(join(root, "store.json"), "utf8")).settings.theme).toBe("dark");
  });

  it("rejects a symlinked data root", () => {
    const real = fresh();
    const link = join(fresh(), "link");
    symlinkSync(real, link);
    expect(() => resolveDataRoot(link)).toThrow(/symlink/i);
  });
});

describe("write ownership & lifecycle", () => {
  it("close() before open() writes nothing and releases nothing", () => {
    const root = fresh();
    const s = new Store(root);
    s.close();
    expect(existsSync(join(root, "store.json"))).toBe(false);
    expect(existsSync(join(root, "store.lock"))).toBe(false);
  });

  it("close() is idempotent", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    s.close();
    expect(() => s.close()).not.toThrow();
    expect(existsSync(join(root, "store.json"))).toBe(true);
  });

  it("a losing second instance never flushes over the winner's file", () => {
    const root = fresh();
    const a = new Store(root);
    a.open();
    a.update((d) => {
      d.settings.theme = "dark";
    });
    a.flushNow();
    const winner = readFileSync(join(root, "store.json"), "utf8");

    const b = new Store(root);
    expect(() => b.open()).toThrow(/lock/i);
    b.close(); // must not overwrite the winner's document with an empty one
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(winner);
    a.close();
  });

  it("no mutations land after close()", () => {
    const root = fresh();
    const s = new Store(root);
    s.open();
    s.close();
    const bytes = readFileSync(join(root, "store.json"), "utf8");
    s.update((d) => {
      d.settings.theme = "dark";
    });
    s.flushNow();
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(bytes);
  });
});

describe("store document validation", () => {
  it("recovers a same-version document missing required sections", () => {
    const root = fresh();
    const doc = emptyStore() as unknown as Record<string, unknown>;
    delete doc["settings"];
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    const res = s.open();
    expect(res.recoveredFrom).toBeTruthy();
    expect(res.data.settings.language).toBe("en");
    s.close();
  });

  it("rejects a thread pointing at an unknown project", () => {
    const root = fresh();
    const doc = emptyStore();
    doc.threads.push({
      id: "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
      projectId: "9f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
      title: "x",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: null,
      sessionGrants: [],
    });
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    const res = s.open();
    expect(res.recoveredFrom).toBeTruthy();
    s.close();
  });

  it("rejects a turn whose assistant message does not exist", () => {
    const root = fresh();
    const doc = emptyStore();
    doc.threads.push({
      id: "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
      projectId: null,
      title: "x",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: {
        id: "4f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
        threadId: "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
        status: "done",
        seq: 0,
        startedAt: 1,
        assistantMessageId: "5f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
      },
      sessionGrants: [],
    });
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    const res = s.open();
    expect(res.recoveredFrom).toBeTruthy();
    s.close();
  });

  it("fails closed on a NEWER schemaVersion and keeps bytes intact", () => {
    const root = fresh();
    const doc = emptyStore();
    doc.schemaVersion = SCHEMA_VERSION + 1;
    const raw = JSON.stringify(doc);
    writeFileSync(join(root, "store.json"), raw);
    const s = new Store(root);
    expect(() => s.open()).toThrow(/newer|schema version/i);
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(raw);
    s.close(); // closed without ownership: still no write
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(raw);
    expect(existsSync(join(root, "store.lock"))).toBe(false);
  });

  it("rejects an enum-violating document", () => {
    const root = fresh();
    const doc = emptyStore() as unknown as { settings: { theme: string } };
    doc.settings.theme = "neon-party";
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    const res = s.open();
    expect(res.recoveredFrom).toBeTruthy();
    s.close();
  });
});

describe("store document validation", () => {
  it("accepts a realistic doc whose messages reference ENDED turns", () => {
    // Regression: only the latest turn is persisted per thread, so
    // assistant messages from earlier turns legitimately carry turnIds
    // that do not exist anywhere in the file anymore.
    const root = fresh();
    const doc = emptyStore();
    doc.threads.push({
      id: "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
      projectId: null,
      title: "x",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: "4f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
          role: "assistant",
          content: "old reply",
          status: "done",
          ts: 1,
          turnId: "6f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6", // ended turn, unpersisted
        },
        {
          id: "5f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
          role: "assistant",
          content: "",
          status: "streaming",
          ts: 2,
          turnId: "7f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
        },
      ],
      turn: {
        id: "7f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
        threadId: "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
        status: "waiting-approval",
        seq: 1,
        startedAt: 2,
        assistantMessageId: "5f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
        approval: {
          id: "8f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
          turnId: "7f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6",
          kind: "command",
          headline: "Allow this action?",
          title: "mock-write ./notes.txt",
          symbol: "exclamationmark.shield",
          options: [
            { id: "deny", title: "Deny", role: "deny", scope: "none" },
            { id: "once", title: "Allow once", role: "approve", scope: "once" },
          ],
          status: "pending",
        },
      },
      sessionGrants: [],
    });
    writeFileSync(join(root, "store.json"), JSON.stringify(doc));
    const s = new Store(root);
    const res = s.open();
    expect(res.recoveredFrom).toBeUndefined();
    expect(res.data.threads).toHaveLength(1);
    s.close();
  });
});

describe("platform containment semantics", () => {
  it("posix containment", () => {
    expect(isInsideRoot("/a/b", "store.json", posix)).toBe(true);
    expect(isInsideRoot("/a/b", "/a/b", posix)).toBe(true);
    expect(isInsideRoot("/a/b", "../escape", posix)).toBe(false);
    expect(isInsideRoot("/a/b", "..notes/ok", posix)).toBe(true); // '..' prefix is not a component
    expect(isInsideRoot("/a/b", "/a/b-evil/x", posix)).toBe(false);
    expect(isInsideRoot("/a/b", "/etc/passwd", posix)).toBe(false);
  });

  // Path-semantics check for the Windows rules — not a claim of real
  // Windows runtime validation.
  it("win32 containment: drive, .., same-prefix and UNC escapes", () => {
    expect(isInsideRoot("C:\\isolated", "store.json", win32)).toBe(true);
    expect(isInsideRoot("C:\\isolated", "sub\\store.json", win32)).toBe(true);
    expect(isInsideRoot("C:\\isolated", "..notes\\ok", win32)).toBe(true);
    expect(isInsideRoot("C:\\isolated", "..\\store.json", win32)).toBe(false);
    expect(isInsideRoot("C:\\isolated", "C:\\isolated-evil\\store.json", win32)).toBe(false);
    expect(isInsideRoot("C:\\isolated", "D:\\other\\store.json", win32)).toBe(false);
    expect(isInsideRoot("C:\\isolated", "\\\\server\\share\\x", win32)).toBe(false);
  });

  it("physical containment: intermediate symlink escapes are refused", () => {
    const root = fresh();
    const outside = fresh();
    writeFileSync(join(outside, "store.json"), "synthetic");
    symlinkSync(outside, join(root, "sub"), "dir");
    expect(isPathInsideRoot(root, "sub/store.json")).toBe(false);
    // …and so is a symlinked descendant that does not exist yet.
    rmSync(join(outside, "store.json"));
    expect(isPathInsideRoot(root, "sub/newfile.json")).toBe(false);
  });

  it("physical containment: a dangling final link is refused", () => {
    const root = fresh();
    const outside = fresh();
    symlinkSync(join(outside, "missing-target"), join(root, "dangling"));
    expect(isPathInsideRoot(root, "dangling")).toBe(false);
  });
});

describe("lock ownership", () => {
  it("release() never unlinks a lock it does not hold", () => {
    const root = fresh();
    const lockPath = join(root, "store.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "foreign", at: 1 }));
    const lock = new StoreLock(lockPath);
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("release() keeps a lock whose token changed hands", () => {
    const root = fresh();
    const lockPath = join(root, "store.lock");
    const lock = new StoreLock(lockPath);
    expect(lock.acquire()).toBe(true);
    // Our file was replaced by a different owner in the meantime.
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: "someone-else", at: 1 }));
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { force: true });
  });

  it("refuses a lock with an unreadable or invalid owner", () => {
    const root = fresh();
    writeFileSync(join(root, "store.lock"), "{ broken");
    const s = new Store(root);
    expect(() => s.open()).toThrow(/lock/i);
    rmSync(join(root, "store.lock"), { force: true });
    writeFileSync(join(root, "store.lock"), JSON.stringify({ pid: "not-a-number" }));
    expect(() => s.open()).toThrow(/lock/i);
  });

  it("refuses a lock owned by an EPERM/alive process", () => {
    const root = fresh();
    // pid 1 (launchd on macOS / init on Linux): kill → EPERM → unknown → refuse
    writeFileSync(join(root, "store.lock"), JSON.stringify({ pid: 1, token: "x", at: 1 }));
    const s = new Store(root);
    expect(() => s.open()).toThrow(/lock/i);
  });

  it("refuses while the mkdir guard is held — never steals it", () => {
    const root = fresh();
    mkdirSync(join(root, "store.lock.guard"));
    const lock = new StoreLock(join(root, "store.lock"));
    expect(lock.acquire()).toBe(false);
    rmSync(join(root, "store.lock.guard"), { recursive: true, force: true });
  });

  it("a contender inside its guard section is never interrupted", () => {
    // Deterministic check for the mkdir-guard protocol: while ANY guard is
    // up, a competing acquire must refuse rather than sneak a read between
    // the holder's read-check and recreate — the failure mode of the old
    // read-token-twice scheme. (The concurrent-winner property is covered
    // by the multi-process race below.)
    const root = fresh();
    const guard = join(root, "store.lock.guard");
    mkdirSync(guard);
    writeFileSync(join(guard, "owner"), JSON.stringify({ pid: 1, token: "x", at: 1 }));
    const B = new StoreLock(join(root, "store.lock"));
    expect(B.acquire()).toBe(false);
    expect(B.isHeld()).toBe(false);
    // Once the guard is gone, acquisition proceeds normally.
    rmSync(guard, { recursive: true, force: true });
    expect(B.acquire()).toBe(true);
    B.release();
  });

  it("exactly one of several real processes wins the lock", async () => {
    const root = fresh();
    const lockPath = join(root, "store.lock");
    const { buildSync } = await import("esbuild");
    const { spawn } = await import("node:child_process");
    const bundle = buildSync({
      entryPoints: [join(process.cwd(), "src/main/store.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      write: false,
    }).outputFiles[0]!.text;
    // A losing contender exits quickly; a winner stays ALIVE for a beat so
    // the others see a live pid — otherwise sequential dead-pid reclaims
    // would (correctly) produce multiple winners.
    const raceSource = `
      ${bundle}
      const l = new module.exports.StoreLock(${JSON.stringify(lockPath)});
      // Barrier: every child spins to the same wall-clock before acquiring,
      // so contention is real instead of a launch-order race.
      const start = Date.now();
      while (Date.now() - start < 400) {}
      const won = l.acquire();
      process.stdout.write(String(won));
      if (won) {
        setTimeout(() => { l.release(); process.exit(0); }, 1500);
      }
    `;
    const runs = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<string>((res) => {
            const c = spawn(process.execPath, ["-e", raceSource]);
            let out = "";
            c.stdout.on("data", (d) => (out += d));
            c.once("exit", () => res(out));
          }),
      ),
    );
    expect(runs.filter((r) => r === "true")).toHaveLength(1);
    expect(runs.filter((r) => r === "false")).toHaveLength(3);
  });
});
