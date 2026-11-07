// F12 project scripts (A34): engine-owned list editing, tivano.json
// pickup at bind time, and script runs routed into REAL terminals
// (the command is resolved main-side — the renderer only names the
// script id).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const st of stores.splice(0)) st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = "scr-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function rig(repoDir?: string) {
  const dataRoot = tmp("scr-data-");
  const store = new Store(dataRoot);
  store.open();
  stores.push(store);
  const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const project = repoDir
    ? engine.openUserDirectory(repoDir).project
    : engine.createProject("p");
  const thread = engine.createThread(project.id);
  const calls: { threadId: string; opts: { title?: string; command?: string } | undefined }[] = [];
  engine.attachTerminals({
    create: (threadId: string, _cols: number, _rows: number, opts?: { title?: string; command?: string }) => {
      calls.push({ threadId, opts });
      return { terminal: { id: `term-${calls.length}`, threadId, title: opts?.title ?? "t", state: "starting", incarnation: 1 } };
    },
  });
  return { engine, project, thread, calls, dataRoot, paths };
}

describe("project scripts (F12)", () => {
  it("setProjectScripts persists a bounded, cleaned list", () => {
    const r = rig();
    r.engine.setProjectScripts(r.project.id, [
      { id: "", name: "Build", command: "npm run build", icon: "hammer", runOnWorktreeCreate: false },
      { id: "", name: "  ", command: "echo hi", icon: "", runOnWorktreeCreate: true },
    ]);
    const p = r.engine.snapshot().projects.find((x) => x.id === r.project.id)!;
    expect(p.scripts).toHaveLength(2);
    expect(p.scripts![0]!.name).toBe("Build");
    expect(p.scripts![0]!.id).toBeTruthy();
    expect(p.scripts![1]!.name).toBe("Script 2"); // blank name → fallback
    expect(p.scripts![1]!.icon).toBe("play");
    expect(p.scripts![1]!.runOnWorktreeCreate).toBe(true);
    // Clearing writes an absent field, not an empty array.
    r.engine.setProjectScripts(r.project.id, []);
    expect(r.engine.snapshot().projects[0]!.scripts).toBeUndefined();
  });

  it("a blank command refuses the whole save, matching the frozen editor", () => {
    const r = rig();
    expect(() =>
      r.engine.setProjectScripts(r.project.id, [
        { id: "", name: "ok", command: "true", icon: "", runOnWorktreeCreate: false },
        { id: "", name: "bad", command: "   ", icon: "", runOnWorktreeCreate: false },
      ]),
    ).toThrow(/every script needs a command/);
    expect(r.engine.snapshot().projects[0]!.scripts).toBeUndefined();
  });

  it("runProjectScript opens a script terminal with the resolved command", () => {
    const r = rig();
    r.engine.setProjectScripts(r.project.id, [
      { id: "", name: "Lint", command: "npm run lint", icon: "", runOnWorktreeCreate: false },
    ]);
    const scriptId = r.engine.snapshot().projects[0]!.scripts![0]!.id;
    const res = r.engine.runProjectScript(r.thread.id, scriptId);
    expect(res.terminal?.id).toBe("term-1");
    expect(r.calls).toEqual([
      { threadId: r.thread.id, opts: { title: "Lint", command: "npm run lint" } },
    ]);
    // Identity only — a foreign script id can never run.
    expect(r.engine.runProjectScript(r.thread.id, "nope").unavailable).toBe("unknown-script");
    const solo = r.engine.createThread(null);
    expect(r.engine.runProjectScript(solo.id, scriptId).unavailable).toBe("unbound");
  });

  it("tivano.json scripts are picked up when the directory is bound", () => {
    const repo = tmp("scr-repo-");
    writeFileSync(
      join(repo, "tivano.json"),
      JSON.stringify({
        scripts: [
          { name: "Test", command: "npm test", icon: "test", runOnWorktreeCreate: true },
          { name: "NoIcon", command: "make it" },
          { name: "", command: "dropped — blank name" },
          { name: "NoCmd" },
          { name: "Lint", command: "npm run lint", icon: "lint" },
        ],
      }),
    );
    const r = rig(repo);
    const p = r.engine.snapshot().projects.find((x) => x.id === r.project.id)!;
    expect(p.scripts?.map((s) => s.name)).toEqual(["Test", "NoIcon", "Lint"]);
    expect(p.scripts![0]!.icon).toBe("checkmark.seal");
    expect(p.scripts![0]!.runOnWorktreeCreate).toBe(true);
    expect(p.scripts![1]!.icon).toBe("play");
    expect(p.scripts![1]!.runOnWorktreeCreate).toBe(false);
    expect(p.scripts![2]!.icon).toBe("wand.and.stars");
  });

  it("a missing or malformed tivano.json yields no scripts, never blocks", () => {
    const repo = tmp("scr-repo-");
    const r = rig(repo);
    expect(r.engine.snapshot().projects[0]!.scripts).toBeUndefined();
    const repo2 = tmp("scr-repo-");
    writeFileSync(join(repo2, "tivano.json"), "not json {{{");
    const r2 = rig(repo2);
    expect(r2.engine.snapshot().projects[0]!.scripts).toBeUndefined();
  });
});
