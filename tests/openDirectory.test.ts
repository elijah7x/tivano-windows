// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// User-selected project directories (phase-2d): main-owned chooser via DI,
// canonical dedupe, durable grant-before-project ordering, restart
// restoration, unavailable/missing/renamed bindings, forged display
// metadata, and delete preserving user files. Every fixture lives in a
// fresh temp dir outside the source tree.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientStore } from "../src/renderer/client";
import { Store } from "../src/main/store";
import { Engine, EngineError } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  ProjectRuntimePaths,
  type GrantRestoreResult,
} from "../src/main/projectRuntimePaths";
import { DirectoryOpener } from "../src/main/openProjectDirectory";
import type { OpenDirectoryResult } from "../src/shared/types";

const dirs: string[] = [];
function tmp(prefix = "tivano-p2d-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Rig {
  dataRoot: string;
  grantFile: string;
  store: Store;
  paths: ProjectRuntimePaths;
  engine: Engine;
}

function rig(dataRoot = tmp()): Rig {
  const store = new Store(dataRoot);
  store.open();
  const grantFile = join(dataRoot, "workspace-grants.json");
  // No fixture roots: user-selected dirs never depend on them.
  const paths = new ProjectRuntimePaths([], grantFile, dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  return { dataRoot, grantFile, store, paths, engine };
}

function reopen(r: Rig): Rig & { restored: GrantRestoreResult } {
  r.store.close();
  const next = rig(r.dataRoot);
  const restored = next.paths.restore(
    new Set(next.engine.snapshot().projects.map((p) => p.id)),
  );
  return { ...next, restored };
}

function openerFor(
  r: Rig,
  impl: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  usable: () => boolean = () => !r.engine.readOnly,
): DirectoryOpener {
  return new DirectoryOpener({
    showOpenDialog: impl,
    usable,
    attach: (p) => r.engine.openUserDirectory(p),
  });
}

const choose = (...filePaths: string[]) =>
  () => Promise.resolve({ canceled: false, filePaths });

describe("main-owned directory chooser", () => {
  it("a cancelled or empty chooser creates no project and no grant", async () => {
    const r = rig();
    for (const result of [
      { canceled: true, filePaths: [] },
      { canceled: false, filePaths: [] },
    ]) {
      const out = await openerFor(r, () => Promise.resolve(result)).open();
      expect(out.cancelled).toBe(true);
      expect(out.opened).toEqual([]);
    }
    expect(r.engine.snapshot().projects).toEqual([]);
    expect(existsSync(r.grantFile)).toBe(false);
    r.store.close();
  });

  it("opens a real folder: canonical path, basename name, durable grant", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const opener = openerFor(r, choose(dir));
    const out = await opener.open();
    expect(out.cancelled).toBe(false);
    expect(out.opened).toHaveLength(1);
    const project = out.opened[0]!;
    const canonical = realpathSync(dir);
    expect(project.directory).toBe(canonical);
    expect(project.name).toBe(canonical.split("/").pop());
    expect(project.directoryStatus).toBe("available");
    // Grant authority: the app-private file records a USER-section entry.
    const doc = JSON.parse(readFileSync(r.grantFile, "utf8"));
    expect(doc.userGrants[project.id]).toBe(canonical);
    expect(doc.grants?.[project.id]).toBeUndefined();
    expect(r.paths.lookup(project.id)?.directory).toBe(canonical);
    // Snapshot reports the live status.
    expect(r.engine.snapshot().projects[0]!.directoryStatus).toBe("available");
    r.store.close();
  });

  it("opening the same folder again re-opens the existing project", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const first = (await openerFor(r, choose(dir)).open()).opened[0]!;
    const again = await openerFor(r, choose(dir)).open();
    expect(again.opened).toHaveLength(1);
    expect(again.opened[0]!.id).toBe(first.id);
    expect(r.engine.snapshot().projects).toHaveLength(1);
    r.store.close();
  });

  it("selecting a folder already granted to another project dedupes", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const first = (await openerFor(r, choose(dir)).open()).opened[0]!;
    // A second selection through the chooser still lands on the same
    // project — grant identity, not display metadata, is the authority.
    const second = await openerFor(r, choose(dir)).open();
    expect(second.opened[0]!.id).toBe(first.id);
    expect(r.engine.snapshot().projects).toHaveLength(1);
    r.store.close();
  });

  it("one chooser at a time — concurrent requests coalesce", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    let calls = 0;
    const opener = new DirectoryOpener({
      showOpenDialog: () => {
        calls++;
        return new Promise((res) =>
          setTimeout(() => res({ canceled: false, filePaths: [dir] }), 20),
        );
      },
      usable: () => true,
      attach: (p) => r.engine.openUserDirectory(p),
    });
    const [a, b] = await Promise.all([opener.open(), opener.open()]);
    expect(calls).toBe(1);
    expect(a.opened[0]!.id).toBe(b.opened[0]!.id);
    r.store.close();
  });

  it("an engine that entered read-only while the chooser was open binds nothing", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    let resolveDialog!: (v: { canceled: boolean; filePaths: string[] }) => void;
    const opener = new DirectoryOpener({
      showOpenDialog: () => new Promise((res) => (resolveDialog = res)),
      usable: () => !r.engine.readOnly,
      attach: (p) => r.engine.openUserDirectory(p),
    });
    const pending = opener.open();
    // The app begins closing AFTER the dialog resolved but before its
    // result is applied — a late project must never materialize.
    r.engine.shutdown();
    resolveDialog({ canceled: false, filePaths: [dir] });
    const out = await pending;
    expect(out.cancelled).toBe(true);
    expect(out.opened).toEqual([]);
    expect(r.engine.snapshot().projects).toEqual([]);
    expect(r.paths.lookup("anything")).toBeUndefined();
    r.store.close();
  });

  it("read-only state refuses the chooser before it even opens", async () => {
    const r = rig();
    r.engine.enterReadOnly();
    let calls = 0;
    const opener = new DirectoryOpener({
      showOpenDialog: () => {
        calls++;
        return Promise.resolve({ canceled: false, filePaths: [tmp("tivano-p2d-user-")] });
      },
      usable: () => !r.engine.readOnly,
      attach: (p) => r.engine.openUserDirectory(p),
    });
    const out = await opener.open();
    expect(calls).toBe(0);
    expect(out.cancelled).toBe(true);
    r.store.close();
  });

  it("openUserDirectory is mutability-gated even bypassing the chooser", () => {
    const r = rig();
    r.engine.enterReadOnly();
    expect(() => r.engine.openUserDirectory(tmp("tivano-p2d-user-"))).toThrowError(EngineError);
    r.store.close();
  });

  it("a destroyed-window unusable state after await binds nothing", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    let alive = true;
    let resolveDialog!: (v: { canceled: boolean; filePaths: string[] }) => void;
    const opener = new DirectoryOpener({
      showOpenDialog: () => new Promise((res) => (resolveDialog = res)),
      usable: () => alive && !r.engine.readOnly,
      attach: (p) => r.engine.openUserDirectory(p),
    });
    const pending = opener.open();
    alive = false; // window gone while the chooser was up
    resolveDialog({ canceled: false, filePaths: [dir] });
    const out = await pending;
    expect(out.opened).toEqual([]);
    expect(r.engine.snapshot().projects).toEqual([]);
    r.store.close();
  });

  it("multi-select opens each distinct directory and reports failures", async () => {
    const r = rig();
    const a = tmp("tivano-p2d-a-");
    const b = tmp("tivano-p2d-b-");
    const out = await openerFor(r, choose(a, b, a)).open();
    // duplicate inside one selection collapses to one project
    expect(out.opened).toHaveLength(2);
    expect(r.engine.snapshot().projects).toHaveLength(2);
    r.store.close();

    const r2 = rig();
    const out2 = await openerFor(r2, choose(tmp("tivano-p2d-c-"), join(tmp(), "definitely-gone"))).open();
    expect(out2.opened).toHaveLength(1);
    expect(out2.errors).toHaveLength(1);
    r2.store.close();
  });

  it("a chooser path that is a symlink is refused, not followed", async () => {
    const r = rig();
    const real = tmp("tivano-p2d-real-");
    const link = join(tmp(), "link");
    symlinkSync(real, link, "dir");
    await expect(openerFor(r, choose(link)).open()).rejects.toThrowError();
    expect(r.engine.snapshot().projects).toEqual([]);
    r.store.close();
  });
});

describe("grant durability and ordering", () => {
  it("a failed grant write creates no project and preserves older grants", async () => {
    const r = rig();
    const keepDir = tmp("tivano-p2d-keep-");
    const first = (await openerFor(r, choose(keepDir)).open()).opened[0]!;
    const before = readFileSync(r.grantFile, "utf8");
    // Break the NEXT persist: the temp path the atomic writer uses is
    // occupied, so the write fails before the real file is touched.
    mkdirSync(`${r.grantFile}.tmp-${process.pid}`);
    const dir = tmp("tivano-p2d-user-");
    await expect(openerFor(r, choose(dir)).open()).rejects.toThrowError();
    expect(r.engine.snapshot().projects).toHaveLength(1);
    expect(r.paths.lookup(first.id)?.directory).toBe(realpathSync(keepDir));
    expect(readFileSync(r.grantFile, "utf8")).toBe(before);
    r.store.close();
  });

  it("grant persists BEFORE the project — an unused grant restores nothing", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    // Forge an orphan: a grant for a project that does not exist.
    writeFileSync(
      r.grantFile,
      JSON.stringify({ version: 1, grants: {}, userGrants: { ghost: realpathSync(dir) } }),
    );
    const res = r.paths.restore(new Set());
    expect(res.restored).toBe(0);
    expect(res.failed).toEqual([]);
    expect(r.paths.lookup("ghost")).toBeUndefined();
    // The orphan entry is dropped from the file — never usable by itself.
    const doc = JSON.parse(readFileSync(r.grantFile, "utf8"));
    expect(doc.userGrants?.ghost).toBeUndefined();
    r.store.close();
  });
});

describe("restart restoration and unavailable bindings", () => {
  it("the binding survives an app restart (project + grant + status)", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const opened = (await openerFor(r, choose(dir)).open()).opened[0]!;
    const r2 = reopen(r);
    expect(r2.restored.restored).toBe(1);
    expect(r2.restored.failed).toEqual([]);
    const project = r2.engine.snapshot().projects.find((p) => p.id === opened.id)!;
    expect(project.directory).toBe(realpathSync(dir));
    expect(project.directoryStatus).toBe("available");
    expect(r2.paths.lookup(opened.id)?.directory).toBe(realpathSync(dir));
    r2.store.close();
  });

  it("a missing folder stays bound, is reported, and shows unavailable", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const opened = (await openerFor(r, choose(dir)).open()).opened[0]!;
    const canonical = opened.directory!; // recorded canonical path
    rmSync(dir, { recursive: true });
    const r2 = reopen(r);
    expect(r2.restored.restored).toBe(0);
    expect(r2.restored.failed).toHaveLength(1);
    expect(r2.restored.failed[0]!.projectId).toBe(opened.id);
    // The project record is preserved; the snapshot reports it honestly.
    const project = r2.engine.snapshot().projects.find((p) => p.id === opened.id)!;
    expect(project.directory).toBe(canonical);
    expect(project.directoryStatus).toBe("unavailable");
    // The grant entry is PRESERVED in the file — not silently dropped.
    const doc = JSON.parse(readFileSync(r2.grantFile, "utf8"));
    expect(doc.userGrants[opened.id]).toBe(canonical);
    r2.store.close();
  });

  it("a renamed folder is unavailable until it honestly exists again", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const opened = (await openerFor(r, choose(dir)).open()).opened[0]!;
    const moved = `${dir}-moved`;
    renameSync(dir, moved);
    const r2 = reopen(r);
    expect(r2.restored.restored).toBe(0);
    expect(r2.engine.snapshot().projects[0]!.directoryStatus).toBe("unavailable");
    // Rename it back — a later restart restores the binding honestly.
    renameSync(moved, dir);
    const r3 = reopen(r2);
    expect(r3.restored.restored).toBe(1);
    expect(r3.engine.snapshot().projects[0]!.id).toBe(opened.id);
    expect(r3.engine.snapshot().projects[0]!.directoryStatus).toBe("available");
    r3.store.close();
  });

  it("re-selecting a folder a project displays but lost its grant re-attaches it", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const opened = (await openerFor(r, choose(dir)).open()).opened[0]!;
    // Break the grant without touching the project display record.
    r.paths.revoke(opened.id);
    expect(r.paths.lookup(opened.id)).toBeUndefined();
    const out = await openerFor(r, choose(dir)).open();
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0]!.id).toBe(opened.id);
    expect(r.engine.snapshot().projects).toHaveLength(1);
    expect(r.paths.lookup(opened.id)?.directory).toBe(realpathSync(dir));
    r.store.close();
  });

  it("a retargeted path is never broadened: symlink at the recorded path fails restore", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const opened = (await openerFor(r, choose(dir)).open()).opened[0]!;
    const canonical = opened.directory!;
    rmSync(dir, { recursive: true });
    symlinkSync(tmp("tivano-p2d-elsewhere-"), dir, "dir");
    const r2 = reopen(r);
    expect(r2.restored.restored).toBe(0);
    expect(r2.paths.lookup(opened.id)).toBeUndefined();
    const doc = JSON.parse(readFileSync(r2.grantFile, "utf8"));
    expect(doc.userGrants[opened.id]).toBe(canonical); // preserved, not repointed
    r2.store.close();
  });
});

describe("forge resistance and file preservation", () => {
  it("a forged directory in the project record never mints a grant", async () => {
    const r = rig();
    const dirA = tmp("tivano-p2d-a-");
    const dirB = tmp("tivano-p2d-b-");
    const opened = (await openerFor(r, choose(dirA)).open()).opened[0]!;
    r.store.flushNow();
    r.store.close();
    // Edit ONLY the display metadata in the store file.
    const storeFile = join(r.dataRoot, "store.json");
    const doc = JSON.parse(readFileSync(storeFile, "utf8"));
    const rec = doc.projects.find((p: { id: string }) => p.id === opened.id)!;
    rec.directory = realpathSync(dirB);
    writeFileSync(storeFile, JSON.stringify(doc));
    // Reopen: the grant still points at dirA — display forged to dirB.
    const r2 = rig(r.dataRoot);
    const res = r2.paths.restore(new Set(r2.engine.snapshot().projects.map((p) => p.id)));
    expect(res.restored).toBe(1);
    expect(r2.paths.lookup(opened.id)!.directory).toBe(realpathSync(dirA));
    const project = r2.engine.snapshot().projects[0]!;
    expect(project.directory).toBe(realpathSync(dirB)); // display kept as written
    // ...and it can never LOOK bound: grant identity ≠ display path.
    expect(project.directoryStatus).toBe("unavailable");
    r2.store.close();
  });

  it("deleting a project revokes the grant but keeps every user file", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    writeFileSync(join(dir, "sentinel.txt"), "keep me");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.txt"), "deep");
    const opened = (await openerFor(r, choose(dir)).open()).opened[0]!;
    r.engine.deleteProject(opened.id);
    expect(r.paths.lookup(opened.id)).toBeUndefined();
    expect(r.engine.snapshot().projects).toEqual([]);
    // Nothing inside the user-selected directory was touched.
    expect(readFileSync(join(dir, "sentinel.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(dir, "nested", "deep.txt"), "utf8")).toBe("deep");
    const doc = JSON.parse(readFileSync(r.grantFile, "utf8"));
    expect(doc.userGrants?.[opened.id]).toBeUndefined();
    // No marker was ever written into the user directory.
    expect(existsSync(join(dir, ".tivano-project.json"))).toBe(false);
    r.store.close();
  });

  it("opening a directory never writes into it", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const before = readdirSync(dir).sort();
    await openerFor(r, choose(dir)).open();
    expect(readdirSync(dir).sort()).toEqual(before);
    r.store.close();
  });
});

describe("chooser result honesty", () => {
  it("total failure inside one selection surfaces as an error", async () => {
    const r = rig();
    await expect(
      openerFor(r, choose(join(tmp(), "gone-a"), join(tmp(), "gone-b"))).open(),
    ).rejects.toThrowError();
    expect(r.engine.snapshot().projects).toEqual([]);
    r.store.close();
  });

  it("the result type matches the shared contract", async () => {
    const r = rig();
    const dir = tmp("tivano-p2d-user-");
    const out: OpenDirectoryResult = await openerFor(r, choose(dir)).open();
    expect(typeof out.cancelled).toBe("boolean");
    expect(Array.isArray(out.opened)).toBe(true);
    r.store.close();
  });
});


describe("directory write-failure recovery", () => {
  it("a project flush failure stays visible and reopening retries durable storage", () => {
    const r = rig();
    const dir = tmp("tivano-p2d-flush-");
    const client = new ClientStore();
    client.hydrate(r.engine.snapshot(), client.beginHydration());
    const unsubscribe = r.engine.onEvent((event) => client.onBridgeEvent(event));
    const flush = vi.spyOn(r.store, "flushNow").mockImplementation(() => {
      throw new Error("simulated store write failure");
    });
    try {
      expect(() => r.engine.openUserDirectory(dir)).toThrow("could not be confirmed on disk");
      const id = r.engine.snapshot().projects[0]!.id;
      expect(client.snapshot!.projects.map((p) => p.id)).toContain(id);
      expect(() => r.engine.openUserDirectory(dir)).toThrow("simulated store write failure");
      flush.mockRestore();
      const retry = r.engine.openUserDirectory(dir);
      expect(retry.project.id).toBe(id);
      expect(client.snapshot!.projects).toHaveLength(1);
      const stored = JSON.parse(readFileSync(join(r.dataRoot, "store.json"), "utf8"));
      expect(stored.projects.map((p: { id: string }) => p.id)).toContain(id);
    } finally {
      flush.mockRestore();
      unsubscribe();
      r.store.close();
    }
  });

  it("failed grant revocation preserves the project, its threads and the rendered row", () => {
    const r = rig();
    const project = r.engine.openUserDirectory(tmp()).project;
    const thread = r.engine.createThread(project.id);
    const client = new ClientStore();
    client.hydrate(r.engine.snapshot(), client.beginHydration());
    const unsubscribe = r.engine.onEvent((event) => client.onBridgeEvent(event));
    const obstacle = `${r.grantFile}.tmp-${process.pid}`;
    mkdirSync(obstacle);
    try {
      expect(() => r.engine.deleteProject(project.id)).toThrow();
      expect(r.engine.snapshot().projects.map((p) => p.id)).toContain(project.id);
      expect(r.engine.snapshot().threads.map((t) => t.id)).toContain(thread.id);
      expect(r.paths.lookup(project.id)).toBeDefined();
      expect(client.snapshot!.projects.map((p) => p.id)).toContain(project.id);
      rmSync(obstacle, { recursive: true });
      r.engine.deleteProject(project.id);
      expect(client.snapshot!.projects).toEqual([]);
      expect(r.engine.snapshot().threads).toEqual([]);
      expect(r.paths.lookup(project.id)).toBeUndefined();
    } finally {
      rmSync(obstacle, { recursive: true, force: true });
      unsubscribe();
      r.store.close();
    }
  });

  it("replacing an unrestored managed grant leaves only the new user grant on restart", () => {
    const r = rig();
    const project = r.engine.createProject("rebound");
    const dir = realpathSync(tmp());
    writeFileSync(r.grantFile, JSON.stringify({ version: 1, grants: { [project.id]: dir } }));
    expect(r.paths.restore(new Set([project.id])).failed).toHaveLength(1);
    r.paths.registerUser(project.id, dir);
    const saved = JSON.parse(readFileSync(r.grantFile, "utf8"));
    expect(saved.grants[project.id]).toBeUndefined();
    expect(saved.userGrants[project.id]).toBe(dir);
    const next = new ProjectRuntimePaths([], r.grantFile, r.dataRoot);
    expect(next.restore(new Set([project.id]))).toEqual({ restored: 1, failed: [] });
    expect(next.lookup(project.id)?.directory).toBe(dir);
    r.store.close();
  });
});


describe("unrecognized grants documents", () => {
  it.each(["future-version", "invalid-section", "invalid-value"])("preserves %s and refuses writes until a readable document is restored", (scenario) => {
    const r = rig();
    const dir = realpathSync(tmp());
    const project = r.engine.createProject("preserved");
    const valid = { version: 1, grants: {}, userGrants: { [project.id]: dir } };
    const malformed = scenario === "future-version" ? { ...valid, version: 99 }
      : scenario === "invalid-section" ? { ...valid, userGrants: [dir] }
      : { ...valid, userGrants: { [project.id]: 42 } };
    const original = JSON.stringify(malformed);
    writeFileSync(r.grantFile, original);
    const restored = r.paths.restore(new Set([project.id]));
    expect(restored.restored).toBe(0);
    expect(restored.failed.length).toBeGreaterThan(0);
    expect(readFileSync(r.grantFile, "utf8")).toBe(original);
    expect(() => r.paths.registerUser(project.id, dir)).toThrow();
    expect(readFileSync(r.grantFile, "utf8")).toBe(original);
    writeFileSync(r.grantFile, JSON.stringify(valid));
    expect(r.paths.restore(new Set([project.id]))).toEqual({ restored: 1, failed: [] });
    expect(r.paths.lookup(project.id)?.directory).toBe(dir);
    r.store.close();
  });
});
