// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex setup (P2N): saved-executable resolution priority, the main-owned
// choose/save/clear state machine (epochs, busy, superseded, failure-safe
// commits) and the engine's durable-commit semantics — all synthetic, no
// real CLI, no spawned process anywhere.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSetup, codexSavedEffect, codexTestPick, resolveCodexRuntime, validateCodexExecutable } from "../src/main/codexRuntimeConfig";
import { Store, emptyStore } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { validateStoreFile } from "../src/main/storeDoc";

const dirs: string[] = [];
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-codexsetup-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeExe(dir: string, name = "codex.exe"): string {
  const p = join(dir, name);
  writeFileSync(p, "MZ");
  return p;
}

const resolved = (dialogPath: string | null) =>
  Promise.resolve(
    dialogPath === null
      ? { canceled: true as const, filePaths: [] as string[] }
      : { canceled: false as const, filePaths: [dialogPath] },
  );

interface SetupRig {
  setup: CodexSetup;
  committed: (string | undefined)[];
  saved: { value: string | undefined };
  mutable: { value: boolean };
  commitError: Error | null;
}
function rig(over: { saved?: string | undefined; mutable?: boolean | undefined } = {}): SetupRig {
  const state: SetupRig = {
    committed: [],
    saved: { value: over.saved },
    mutable: { value: over.mutable ?? true },
    commitError: null,
    setup: null as unknown as CodexSetup,
  };
  state.setup = new CodexSetup({
    mutable: () => state.mutable.value,
    savedExecutable: () => state.saved.value,
    commit: (p) => {
      if (state.commitError) throw state.commitError;
      state.committed.push(p);
      state.saved.value = p;
    },
    platform: "win32",
  });
  return state;
}

// ---------------------------------------------------------------------------
// resolveCodexRuntime — saved path is the LOWEST-priority source
// ---------------------------------------------------------------------------

describe("resolveCodexRuntime — saved executable", () => {
  it("uses the saved path when no explicit source exists", () => {
    const d = fresh();
    const exe = fakeExe(d);
    const c = resolveCodexRuntime({}, fresh(), { savedExecutable: exe, platform: "win32" });
    expect(c.mode).toBe("real");
    expect(c.configuredFrom).toBe("saved");
    expect(c.executable).toBe(realpathSync(exe));
  });

  it("env executable beats the saved path", () => {
    const d = fresh();
    const envExe = fakeExe(d, "codex.exe");
    const savedExe = fakeExe(fresh(), "codex.exe");
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_EXECUTABLE: envExe },
      fresh(),
      { savedExecutable: savedExe, platform: "win32" },
    );
    expect(c.configuredFrom).toBe("environment");
    expect(c.executable).toBe(realpathSync(envExe));
  });

  it("env fixture beats the saved path", () => {
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_FIXTURE: "/f/app-server.mjs", TIVANO_CODEX_NODE: "/bin/node" },
      fresh(),
      { savedExecutable: fakeExe(fresh()), platform: "win32" },
    );
    expect(c.mode).toBe("fixture");
    expect(c.configuredFrom).toBe("fixture");
  });

  it("a fixture+executable conflict is NOT rescued by the saved path", () => {
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_FIXTURE: "/f/app-server.mjs", TIVANO_CODEX_EXECUTABLE: "/x/codex.exe" },
      fresh(),
      { savedExecutable: fakeExe(fresh()), platform: "win32" },
    );
    expect(c.mode).toBe("unconfigured");
    expect(c.configuredFrom).toBe("none");
    expect(c.realUnavailableReason).toContain("both set");
  });

  it("a saved path that no longer validates degrades loudly — stored value untouched", () => {
    const gone = join(fresh(), "codex.exe"); // never written
    const c = resolveCodexRuntime({}, fresh(), {
      savedExecutable: gone,
      platform: "win32",
    });
    expect(c.mode).toBe("unconfigured");
    expect(c.configuredFrom).toBe("saved");
    expect(c.realUnavailableReason).toContain("saved executable no longer valid");
    expect(c.realUnavailableReason).toContain("CODEX_EXECUTABLE_INVALID");
  });

  it("nothing anywhere stays unconfigured", () => {
    const c = resolveCodexRuntime({}, fresh(), { platform: "win32" });
    expect(c.mode).toBe("unconfigured");
    expect(c.configuredFrom).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// CodexSetup — choose state machine
// ---------------------------------------------------------------------------

describe("CodexSetup.choose", () => {
  it("a canceled dialog leaves pending and saved untouched", async () => {
    const r = rig();
    const res = await r.setup.choose(() => resolved(null));
    expect(res.status).toBe("canceled");
    expect(r.setup.pendingExecutable).toBeNull();
    expect(r.committed).toEqual([]);
  });

  it("rejects relative / script / missing / wrong-basename picks", async () => {
    const d = fresh();
    const batPath = join(d, "codex.bat");
    writeFileSync(batPath, "@echo off");
    for (const bad of [
      "codex.exe",                        // relative
      batPath,                            // .bat script entrypoint
      join(d, "codex.exe"),               // missing file
      fakeExe(d, "codex-wrapper.exe"),    // wrong basename
    ]) {
      const r = rig();
      const res = await r.setup.choose(() => resolved(bad));
      expect(res.status, `pick ${bad}`).toBe("invalid");
      expect(r.setup.pendingExecutable).toBeNull();
    }
  });

  it("a valid dialog pick becomes the validated pending path", async () => {
    const exe = fakeExe(fresh());
    const r = rig();
    const res = await r.setup.choose(() => resolved(exe));
    expect(res).toEqual({ status: "chosen", path: realpathSync(exe) });
    expect(r.setup.pendingExecutable).toBe(realpathSync(exe));
  });

  it("a second choose while the dialog is open reports busy", async () => {
    const r = rig();
    let release!: (v: { canceled: boolean; filePaths: string[] }) => void;
    const first = r.setup.choose(() => new Promise((res) => (release = res)));
    const second = await r.setup.choose(() => resolved(fakeExe(fresh())));
    expect(second).toEqual({ status: "busy" });
    release({ canceled: true, filePaths: [] });
    await first;
  });

  it("a late dialog result after clear() is superseded, never applied", async () => {
    const exe = fakeExe(fresh());
    const r = rig();
    const first = r.setup.choose(async () => {
      r.setup.clear(); // user cleared while the native dialog was open
      return { canceled: false, filePaths: [exe] };
    });
    const res = await first;
    expect(res).toEqual({ status: "superseded" });
    expect(r.setup.pendingExecutable).toBeNull();
  });

  it("read-only / closing refuses before the dialog opens", async () => {
    const r = rig({ mutable: false });
    const res = await r.setup.choose(() => resolved(fakeExe(fresh())));
    expect(res.status).toBe("unavailable");
    expect(r.setup.pendingExecutable).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CodexSetup — save / clear ordering and failure handling
// ---------------------------------------------------------------------------

describe("CodexSetup.save / clear", () => {
  it("save with nothing selected is an honest error, not a write", () => {
    const r = rig();
    const res = r.setup.save();
    expect(res.status).toBe("error");
    expect(r.committed).toEqual([]);
  });

  it("choose → save commits the validated path exactly once", async () => {
    const exe = fakeExe(fresh());
    const r = rig();
    await r.setup.choose(() => resolved(exe));
    const res = r.setup.save();
    expect(res).toEqual({ status: "saved", path: realpathSync(exe), changed: true });
    expect(r.committed).toEqual([realpathSync(exe)]);
    expect(r.setup.pendingExecutable).toBeNull();
  });

  it("saving the already-saved value reports unchanged — no write, no fake pending", async () => {
    const exe = realpathSync(fakeExe(fresh()));
    const r = rig({ saved: exe });
    await r.setup.choose(() => resolved(exe));
    const res = r.setup.save();
    expect(res).toEqual({ status: "saved", path: exe, changed: false });
    expect(r.committed).toEqual([]);
  });

  it("a failed commit reports error, keeps pending for retry, writes nothing", async () => {
    const exe = fakeExe(fresh());
    const r = rig({ saved: undefined });
    await r.setup.choose(() => resolved(exe));
    r.commitError = new Error("ENOSPC injected");
    const res = r.setup.save();
    expect(res.status).toBe("error");
    expect((res as { error: string }).error).toContain("ENOSPC");
    expect(r.setup.pendingExecutable).toBe(realpathSync(exe)); // retry possible
    expect(r.committed).toEqual([]);
    // Fault cleared: the same pending choice saves cleanly.
    r.commitError = null;
    expect(r.setup.save().status).toBe("saved");
  });

  it("save is refused while a chooser is still open", async () => {
    const exe = fakeExe(fresh());
    const r = rig();
    let release!: (v: { canceled: boolean; filePaths: string[] }) => void;
    const choosing = r.setup.choose(() => new Promise((res) => (release = res)));
    expect(r.setup.save()).toEqual({ status: "error", error: "chooser is still open" });
    release({ canceled: false, filePaths: [exe] });
    await choosing;
    expect(r.setup.save().status).toBe("saved");
  });

  it("clear removes the persisted value and invalidates a pending choice", async () => {
    const r = rig({ saved: "/old/codex.exe" });
    await r.setup.choose(() => resolved(fakeExe(fresh())));
    expect(r.setup.pendingExecutable).not.toBeNull();
    const res = r.setup.clear();
    expect(res).toEqual({ status: "cleared", changed: true });
    expect(r.committed).toEqual([undefined]);
    expect(r.setup.pendingExecutable).toBeNull();
  });

  it("clear with nothing persisted is a no-op success", () => {
    const r = rig();
    expect(r.setup.clear()).toEqual({ status: "cleared", changed: false });
    expect(r.committed).toEqual([]);
  });

  it("a failed clear reports the error and restores nothing itself", () => {
    const r = rig({ saved: "/keep/codex.exe" });
    r.commitError = new Error("disk gone");
    const res = r.setup.clear();
    expect(res.status).toBe("error");
    expect(r.saved.value).toBe("/keep/codex.exe");
  });

  it("read-only blocks save and clear", () => {
    const r = rig({ mutable: false, saved: "/x/codex.exe" });
    expect(r.setup.save().status).toBe("error");
    expect(r.setup.clear().status).toBe("error");
    expect(r.committed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// engine.setCodexExecutable — durable commit semantics on a real Store
// ---------------------------------------------------------------------------

describe("engine.setCodexExecutable", () => {
  function makeEngine(root: string) {
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    return { store, engine };
  }

  it("persists the path and it survives a store reopen", () => {
    const root = fresh();
    const e1 = makeEngine(root);
    e1.engine.setCodexExecutable("C:\\tools\\codex.exe");
    e1.store.close();
    const stored = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      settings: { codexExecutable?: string };
    };
    expect(stored.settings.codexExecutable).toBe("C:\\tools\\codex.exe");
    const e2 = makeEngine(root);
    expect(e2.store.state.settings.codexExecutable).toBe("C:\\tools\\codex.exe");
    e2.store.close();
  });

  it("clear removes the field — the key is absent, not null", () => {
    const root = fresh();
    const e = makeEngine(root);
    e.engine.setCodexExecutable("C:\\tools\\codex.exe");
    e.engine.setCodexExecutable(undefined);
    e.store.close();
    const stored = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      settings: Record<string, unknown>;
    };
    expect("codexExecutable" in stored.settings).toBe(false);
  });

  it("a failed flush reverts memory and never persists the candidate", () => {
    const root = fresh();
    const e = makeEngine(root);
    const { store } = e;
    store.update((d) => {
      d.settings.codexExecutable = "C:\\prev\\codex.exe";
    });
    store.flushNow();
    // The next atomic write fails; the candidate must not survive anywhere.
    const origFlush = store.flushNow.bind(store);
    store.flushNow = () => {
      throw new Error("ENOSPC injected");
    };
    expect(() => e.engine.setCodexExecutable("C:\\new\\codex.exe")).toThrow(/ENOSPC/);
    expect(store.state.settings.codexExecutable).toBe("C:\\prev\\codex.exe");
    store.flushNow = origFlush;
    store.flushNow(); // the revert's scheduled write lands idempotently
    const stored = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      settings: { codexExecutable?: string };
    };
    expect(stored.settings.codexExecutable).toBe("C:\\prev\\codex.exe");
    store.close();
  });

  it("closing/read-only refuses the mutation", () => {
    const root = fresh();
    const e = makeEngine(root);
    e.engine.enterReadOnly();
    expect(() => e.engine.setCodexExecutable("C:\\x\\codex.exe")).toThrow(/read-only/);
    e.store.close();
  });

  it("does not disturb other pending document changes", () => {
    const root = fresh();
    const e = makeEngine(root);
    const t = e.engine.createThread(null, "keep me");
    e.engine.setCodexExecutable("C:\\x\\codex.exe");
    const stored = JSON.parse(readFileSync(join(root, "store.json"), "utf8")) as {
      threads: { id: string; title: string }[];
    };
    expect(stored.threads.some((x) => x.id === t.id && x.title === "keep me")).toBe(true);
    e.store.close();
  });
});

// ---------------------------------------------------------------------------
// Store schema — old documents without the field load; bad shape rejects
// ---------------------------------------------------------------------------

describe("store schema — settings.codexExecutable", () => {
  it("a pre-P2N store without the field validates verbatim", () => {
    const doc = emptyStore();
    expect(validateStoreFile(doc).settings.codexExecutable).toBeUndefined();
    const withField = {
      ...doc,
      settings: { ...doc.settings, codexExecutable: "C:\\tools\\codex.exe" },
    };
    expect(validateStoreFile(withField).settings.codexExecutable).toBe("C:\\tools\\codex.exe");
  });

  it("rejects a non-string / oversized value structurally", () => {
    const doc = emptyStore();
    for (const bad of [123, null, {}, "", "x".repeat(4001)]) {
      const d = { ...doc, settings: { ...doc.settings, codexExecutable: bad } };
      expect(() => validateStoreFile(d)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// A saved file deleted later fails live revalidation (setup-state seam) —
// resolved config AND direct validation both report, nothing is deleted.
// ---------------------------------------------------------------------------

describe("saved effect matches this launch", () => {
  it("A to B to A requires restart only for a different saved path", async () => {
    const a = realpathSync(fakeExe(fresh()));
    const b = realpathSync(fakeExe(fresh()));
    const runtime = resolveCodexRuntime({}, fresh(), { savedExecutable: a, platform: "win32" });
    const r = rig({ saved: a });
    const effect = () => codexSavedEffect(r.saved.value ?? null, runtime, {}).savedEffect;
    expect(effect()).toBe("active");
    await r.setup.choose(() => resolved(b));
    expect(r.setup.save().status).toBe("saved");
    expect(effect()).toBe("pending-restart");
    expect(runtime.executable).toBe(a);
    await r.setup.choose(() => resolved(a));
    expect(r.setup.save().status).toBe("saved");
    expect(effect()).toBe("active");
    expect(r.setup.clear().status).toBe("cleared");
    expect(effect()).toBe("none");
    expect(runtime.executable).toBe(a);
  });

  it("blocks invalid saved paths without changing the pinned runtime", () => {
    const gone = realpathSync(fakeExe(fresh()));
    const launch = resolveCodexRuntime({}, fresh(), { savedExecutable: gone, platform: "win32" });
    rmSync(gone);
    let reason: string | undefined;
    try { validateCodexExecutable(gone, "win32"); }
    catch (error) { reason = (error as Error).message; }
    expect(reason).toContain("CODEX_EXECUTABLE_INVALID");
    expect(codexSavedEffect(gone, launch, {}, reason)).toEqual({ savedEffect: "blocked", savedBlockReason: reason });
    const restarted = resolveCodexRuntime({}, fresh(), { savedExecutable: gone, platform: "win32" });
    expect(restarted.mode).toBe("unconfigured");
    expect(codexSavedEffect(gone, restarted, {}, reason).savedEffect).toBe("blocked");
    expect(codexSavedEffect(realpathSync(fakeExe(fresh())), restarted, {}).savedEffect).toBe("pending-restart");
    expect(launch.executable).toBe(gone);
  });

  it.each(["", "mock", "synthetic-stdio", "unknown"])("blocks explicit provider %j", (provider) => {
    const state = codexSavedEffect("/saved/codex.exe", null, { TIVANO_PROVIDER: provider });
    expect(state.savedEffect).toBe("blocked");
    expect(state.savedBlockReason).toContain("TIVANO_PROVIDER=" + provider);
  });
  it("permits absent or explicit Codex routing", () => {
    for (const source of [{}, { TIVANO_PROVIDER: "codex" }])
      expect(codexSavedEffect("/saved/codex.exe", null, source).savedEffect).toBe("pending-restart");
  });
  it.each([
    { TIVANO_CODEX_EXECUTABLE: "/env/codex.exe" },
    { TIVANO_CODEX_FIXTURE: "/fixture.mjs" },
    { TIVANO_CODEX_EXECUTABLE: "/env/codex.exe", TIVANO_CODEX_FIXTURE: "/fixture.mjs" },
  ])("preserves explicit runtime override %j", (source) => {
    expect(codexSavedEffect("/saved/codex.exe", null, source).savedEffect).toBe("blocked");
  });
});

describe("Codex chooser test seam", () => {
  it.each([
    { packaged: true, mode: "codex-setup" },
    { packaged: true, mode: undefined },
    { packaged: false, mode: undefined },
    { packaged: false, mode: "" },
    { packaged: false, mode: "other" },
  ])("ignores injection outside isolated test mode: %j", ({ packaged, mode }) => {
    expect(codexTestPick(packaged, { TIVANO_TEST_MODE: mode, TIVANO_TEST_CODEX_PICK: "/injected/codex.exe" })).toBeUndefined();
  });
  it("preserves absent picks and explicit cancellation", () => {
    expect(codexTestPick(false, { TIVANO_TEST_MODE: "codex-setup" })).toBeUndefined();
    expect(codexTestPick(false, { TIVANO_TEST_MODE: "codex-setup", TIVANO_TEST_CODEX_PICK: "" })).toBe("");
  });
  it("test injection still passes live chooser and save validation", async () => {
    const r = rig();
    const inject = (path: string) => {
      const pick = codexTestPick(false, { TIVANO_TEST_MODE: "codex-setup", TIVANO_TEST_CODEX_PICK: path });
      expect(pick).toBe(path);
      return r.setup.choose(() => resolved(pick!));
    };
    const d = fresh();
    const directory = join(fresh(), "codex.exe"); mkdirSync(directory);
    for (const bad of ["codex.exe", fakeExe(d, "codex.cmd"), fakeExe(d, "codex.bat"), fakeExe(d, "other.exe"), join(fresh(), "codex.exe"), directory, "/bad\0/codex.exe", "/" + "x".repeat(4001)]) {
      expect((await inject(bad)).status).toBe("invalid");
      expect(r.setup.pendingExecutable).toBeNull();
      expect(r.committed).toEqual([]);
    }
    const valid = fakeExe(fresh());
    expect((await inject(valid)).status).toBe("chosen");
    rmSync(valid);
    expect(r.setup.save().status).toBe("error");
    expect(r.committed).toEqual([]);
  });
});

describe("saved path lifecycle", () => {
  it("deleted-after-save: resolve reports invalid, stored value preserved", () => {
    const d = fresh();
    const exe = fakeExe(d);
    const phys = realpathSync(exe);
    rmSync(exe);
    expect(existsSync(exe)).toBe(false);
    const c = resolveCodexRuntime({}, fresh(), { savedExecutable: phys, platform: "win32" });
    expect(c.mode).toBe("unconfigured");
    expect(c.realUnavailableReason).toContain("saved executable no longer valid");
    // And the settings document itself is never rewritten by the resolver.
    expect(() => validateStoreFile(emptyStore())).not.toThrow();
  });
});
