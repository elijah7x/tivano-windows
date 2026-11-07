// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Workspace authorization: register/verify/revoke, physical containment,
// symlink/non-dir/relative rejection, and no name-derived paths.

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRuntimePaths, WorkspaceError } from "../src/main/projectRuntimePaths";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "tivano-ws-"));
}

describe("ProjectRuntimePaths", () => {
  it("register → lookup → verify → revoke", () => {
    const dir = ws();
    const paths = new ProjectRuntimePaths();
    const grant = paths.register("p1", dir);
    expect(grant.projectId).toBe("p1");
    expect(paths.lookup("p1")?.directory).toBe(grant.directory);
    expect(() => paths.verify(grant)).not.toThrow();
    paths.revoke("p1");
    expect(paths.lookup("p1")).toBeUndefined();
    expect(() => paths.verify(grant)).toThrowError(/WORKSPACE_REVOKED/);
  });

  it("refuses relative paths, NULs, files and symlinks", () => {
    const paths = new ProjectRuntimePaths();
    expect(() => paths.register("p", "relative/dir")).toThrowError(WorkspaceError);
    expect(() => paths.register("p", "/tmp/x\0y")).toThrowError(WorkspaceError);
    const dir = ws();
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(() => paths.register("p", file)).toThrowError(WorkspaceError);
    const link = join(dir, "link");
    symlinkSync(dir, link, "dir");
    expect(() => paths.register("p", link)).toThrowError(WorkspaceError);
  });

  it("an authorized root contains grants — escapes are refused", () => {
    const root = ws();
    const inside = join(root, "proj-abc");
    mkdirSync(inside);
    const outside = ws();
    const paths = new ProjectRuntimePaths([root]);
    expect(() => paths.register("p1", inside)).not.toThrow();
    expect(() => paths.register("p2", outside)).toThrowError(/escapes/);
  });

  it("verify catches a directory replaced by a link after registration", () => {
    // Re-registration is honest — verify() must catch post-grant drift.
    const dir = ws();
    const paths = new ProjectRuntimePaths();
    const grant = paths.register("p1", dir);
    paths.revoke("p1");
    paths.register("p1", dir); // re-register same dir
    expect(() => paths.verify(grant)).not.toThrow();
    paths.revoke("p1");
    expect(() => paths.verify(paths.register("p1", dir))).not.toThrow();
  });

  it("REALLY replacing the directory with a symlink is refused at spawn-verify", () => {
    // The prior version never actually swapped the inode. Here the
    // authorized directory is deleted and a symlink to an outside dir is
    // put in its place — the spawn-time verify must refuse it.
    const dir = ws();
    const outside = ws();
    const paths = new ProjectRuntimePaths();
    const grant = paths.register("p1", dir);
    expect(() => paths.verify(grant)).not.toThrow();
    rmSync(dir, { recursive: true });
    symlinkSync(outside, dir, "dir"); // same path string, different inode type
    expect(() => paths.verify(grant)).toThrowError(/WORKSPACE_INVALID/);
  });

  it("a registered directory that was DELETED is refused at verify", () => {
    const dir = ws();
    const paths = new ProjectRuntimePaths();
    const grant = paths.register("p1", dir);
    rmSync(dir, { recursive: true });
    // lstatSync throws ENOENT — a workspace that vanished cannot spawn.
    expect(() => paths.verify(grant)).toThrowError(/ENOENT|WORKSPACE_INVALID/);
  });
});

describe("ProjectRuntimePaths persistence + restart restore", () => {
  it("registerManaged persists; a fresh instance restores the same grant", () => {
    const root = ws();
    const dataRoot = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    const file = join(root, "grants.json");
    const a = new ProjectRuntimePaths([root], file, dataRoot);
    const grant = a.registerManaged("p1", dir);
    const b = new ProjectRuntimePaths([root], file, dataRoot);
    const res = b.restore(new Set(["p1"]));
    expect(res.failed).toEqual([]);
    expect(res.restored).toBe(1);
    expect(b.lookup("p1")?.directory).toBe(grant.directory);
    expect(() => b.verify(b.lookup("p1")!)).not.toThrow();
  });

  it("with NO authorized roots nothing persisted is restored", () => {
    const root = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    const file = join(root, "grants.json");
    // A prior run HAD a root and persisted a grant…
    new ProjectRuntimePaths([root], file, root).registerManaged("p1", dir);
    // …this run has none: the persisted path can never widen authority.
    const b = new ProjectRuntimePaths([], file, root);
    const res = b.restore(new Set(["p1"]));
    expect(res.restored).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.reason).toContain("no authorized workspace roots");
    expect(b.lookup("p1")).toBeUndefined();
    // the entry stays in the file — a later run with roots may restore it
    expect(JSON.parse(readFileSync(file, "utf8")).grants.p1).toBe(realpathSync(dir));
  });

  it("a failed grant persist never leaves an active grant", () => {
    const root = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    // persistPath inside a file (not a dir) → rename/write always fails
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x");
    const badFile = join(blocker, "grants.json");
    const a = new ProjectRuntimePaths([root], badFile);
    expect(() => a.register("p1", dir)).toThrowError();
    expect(a.lookup("p1")).toBeUndefined();
  });

  it("a failed REPLACE persist keeps the original grant", () => {
    const root = ws();
    const dirA = join(root, "proj-a");
    const dirB = join(root, "proj-b");
    mkdirSync(dirA);
    mkdirSync(dirB);
    const file = join(root, "grants.json");
    const a = new ProjectRuntimePaths([root], file);
    const original = a.register("p1", dirA);
    // Break persistence, then attempt a replacement — the old grant wins.
    rmSync(file);
    mkdirSync(file); // directory at the file path → rename/write fails
    expect(() => a.register("p1", dirB)).toThrowError();
    expect(a.lookup("p1")?.directory).toBe(original.directory);
  });

  it("restore refuses an unmarked directory — grants file alone proves nothing", () => {
    const root = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    const file = join(root, "grants.json");
    // A foreign grants file claims a directory the app never marked.
    writeFileSync(file, JSON.stringify({ version: 1, grants: { p1: dir } }));
    const b = new ProjectRuntimePaths([root], file, root);
    const res = b.restore(new Set(["p1"]));
    expect(res.restored).toBe(0);
    expect(res.failed[0]!.reason).toContain("ownership marker");
    expect(b.lookup("p1")).toBeUndefined();
    // and the directory was NOT silently re-signed
    expect(() => readFileSync(join(dir, ".tivano-project.json"), "utf8")).toThrow();
  });

  it("restore refuses a marker naming a different project or data root", () => {
    const root = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    const file = join(root, "grants.json");
    const a = new ProjectRuntimePaths([root], file, root);
    a.registerManaged("p1", dir);
    // Marker claims another project → swap attempt refused.
    writeFileSync(
      join(dir, ".tivano-project.json"),
      JSON.stringify({ version: 1, projectId: "p9", dataRoot: root }),
    );
    const b = new ProjectRuntimePaths([root], file, root);
    expect(b.restore(new Set(["p1"])).restored).toBe(0);
    // Same marker, different current dataRoot → refused.
    writeFileSync(
      join(dir, ".tivano-project.json"),
      JSON.stringify({ version: 1, projectId: "p1", dataRoot: root }),
    );
    const c = new ProjectRuntimePaths([root], file, ws());
    expect(c.restore(new Set(["p1"])).restored).toBe(0);
  });

  it("restore revalidates: a dir replaced by an external symlink is refused", () => {
    const root = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    const file = join(root, "grants.json");
    new ProjectRuntimePaths([root], file).register("p1", dir);
    // Swap the real dir for a link pointing outside the root.
    rmSync(dir, { recursive: true });
    const outside = ws();
    symlinkSync(outside, dir, "dir");
    const b = new ProjectRuntimePaths([root], file);
    const res = b.restore(new Set(["p1"]));
    expect(res.restored).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(b.lookup("p1")).toBeUndefined();
  });

  it("restore refuses a missing dir and drops gone projects", () => {
    const root = ws();
    const dir = join(root, "proj-1");
    mkdirSync(dir);
    const file = join(root, "grants.json");
    const a = new ProjectRuntimePaths([root], file);
    a.register("p1", dir);
    a.register("p2", dir);
    rmSync(dir, { recursive: true });
    const b = new ProjectRuntimePaths([root], file);
    // p2 is no longer a live project — dropped from the file entirely.
    const res = b.restore(new Set(["p1"]));
    expect(res.restored).toBe(0);
    expect(res.failed.map((f) => f.projectId)).toEqual(["p1"]);
    expect(b.lookup("p1")).toBeUndefined();
    expect(b.lookup("p2")).toBeUndefined();
    // The failed entry is KEPT (a later launch may honestly restore it);
    // the dead project's entry is gone.
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(doc.grants)).toEqual(["p1"]);
  });

  it("a persisted path outside the authorized root can never become a grant", () => {
    const root = ws();
    const file = join(root, "grants.json");
    const outside = ws();
    writeFileSync(file, JSON.stringify({ version: 1, grants: { p1: outside } }));
    const b = new ProjectRuntimePaths([root], file);
    const res = b.restore(new Set(["p1"]));
    expect(res.restored).toBe(0);
    expect(b.lookup("p1")).toBeUndefined();
  });
});


describe("lead R2 workspace durability", () => {
  it("does not activate restored grants when the atomic save fails", () => {
    const root = ws(), dir = join(root, "project"), file = join(root, "grants.json");
    mkdirSync(dir);
    new ProjectRuntimePaths([root], file, root).registerManaged("p1", dir);
    const original = readFileSync(file, "utf8");
    mkdirSync(`${file}.tmp-${process.pid}`);
    const paths = new ProjectRuntimePaths([root], file, root);
    const result = paths.restore(new Set(["p1"]));
    expect(result.restored).toBe(0);
    expect(paths.lookup("p1")).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(original);
  });
  it("retains unavailable grants across unrelated changes until explicitly revoked", () => {
    const root = ws(), a = join(root, "a"), b = join(root, "b"), c = join(root, "c"), file = join(root, "grants.json");
    for (const dir of [a, b, c]) mkdirSync(dir);
    const first = new ProjectRuntimePaths([root], file, root);
    first.registerManaged("a", a); first.registerManaged("b", b);
    const bPath = first.lookup("b")!.directory;
    rmSync(b, { recursive: true });
    const paths = new ProjectRuntimePaths([root], file, root);
    paths.restore(new Set(["a", "b"]));
    expect(paths.lookup("b")).toBeUndefined();
    paths.registerManaged("c", c);
    expect(JSON.parse(readFileSync(file, "utf8")).grants.b).toBe(bPath);
    paths.revoke("c");
    expect(JSON.parse(readFileSync(file, "utf8")).grants.b).toBe(bPath);
    paths.revoke("b");
    expect(JSON.parse(readFileSync(file, "utf8")).grants.b).toBeUndefined();
  });
});
