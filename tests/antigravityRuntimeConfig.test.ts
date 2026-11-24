// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AntigravityConfigError,
  AntigravitySetup,
  antigravitySavedEffect,
  antigravityTestPick,
  discoverAntigravityExecutable,
  resolveAntigravityRuntime,
  validateAntigravityExecutable,
} from "../src/main/antigravityRuntimeConfig";
import { AntigravityProvider } from "../src/main/antigravityProvider";
import { PROCESS_TREE_UNSUPPORTED } from "../src/main/providerProcessLifecycle";

const fixtureScript = resolve("tests/fixtures/antigravity-stream.mjs");
const createdDirs: string[] = [];

function makeTempDir(prefix = "ag-cfg-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

describe("antigravityRuntimeConfig", () => {
  it("validates native agy executable and rejects .cmd/.bat, relative paths, and foreign names", () => {
    const dir = makeTempDir();
    const agyExe = join(dir, "agy.exe");
    const cmdShim = join(dir, "agy.cmd");
    const otherExe = join(dir, "codex.exe");
    writeFileSync(agyExe, "stub", "utf8");
    writeFileSync(cmdShim, "@echo off\n", "utf8");
    writeFileSync(otherExe, "stub", "utf8");

    expect(validateAntigravityExecutable(agyExe, "win32")).toBe(agyExe);
    expect(() => validateAntigravityExecutable("agy.exe", "win32")).toThrow(AntigravityConfigError);
    expect(() => validateAntigravityExecutable("\\\\evil-host\\share\\agy.exe", "win32")).toThrow(
      AntigravityConfigError,
    );
    expect(() => validateAntigravityExecutable("//evil-host/share/agy.exe", "win32")).toThrow(
      AntigravityConfigError,
    );
    expect(() => validateAntigravityExecutable(cmdShim, "win32")).toThrow(AntigravityConfigError);
    expect(() => validateAntigravityExecutable(otherExe, "win32")).toThrow(AntigravityConfigError);
    expect(() => validateAntigravityExecutable(dir, "win32")).toThrow(AntigravityConfigError);

    const posixBin = join(dir, "agy");
    writeFileSync(posixBin, "#!/bin/sh\n", "utf8");
    expect(validateAntigravityExecutable(posixBin, "linux")).toBe(posixBin);
  });

  it("refuses simultaneous fixture + real executable overrides", () => {
    const dataRoot = makeTempDir();
    const exe = join(dataRoot, "agy.exe");
    writeFileSync(exe, "stub", "utf8");
    expect(() =>
      resolveAntigravityRuntime(
        {
          TIVANO_ANTIGRAVITY_FIXTURE: fixtureScript,
          TIVANO_ANTIGRAVITY_NODE: process.execPath,
          TIVANO_ANTIGRAVITY_EXECUTABLE: exe,
        },
        dataRoot,
        { discover: false },
      ),
    ).toThrow(AntigravityConfigError);
  });

  it("isolates fixture environment inside dataRoot without inheriting unrelated host secrets", () => {
    const dataRoot = makeTempDir();
    const cfg = resolveAntigravityRuntime(
      {
        TIVANO_ANTIGRAVITY_FIXTURE: fixtureScript,
        TIVANO_ANTIGRAVITY_NODE: process.execPath,
        SECRET_API_KEY: "should-never-leak",
      },
      dataRoot,
      { discover: false },
    );
    expect(cfg.mode).toBe("fixture");
    expect(cfg.configuredFrom).toBe("fixture");
    expect(cfg.env.HOME).toContain("antigravity-home");
    expect(cfg.env.SECRET_API_KEY).toBeUndefined();
  });

  it("enforces fail-closed Windows job-helper capability for real CLI launches", async () => {
    const dataRoot = makeTempDir();
    const binDir = makeTempDir();
    const agyExe = join(binDir, "agy.exe");
    writeFileSync(agyExe, "stub", "utf8");

    const cfg = resolveAntigravityRuntime(
      { TIVANO_ANTIGRAVITY_EXECUTABLE: agyExe },
      dataRoot,
      {
        platform: "win32",
        treeCapability: {
          platform: "win32",
          supported: false,
          reason: `${PROCESS_TREE_UNSUPPORTED}: unpackaged build has no attested job helper`,
        },
      },
    );
    expect(cfg.mode).toBe("real");
    expect(cfg.treeCapability.supported).toBe(false);
    expect(cfg.realUnavailableReason).toContain(PROCESS_TREE_UNSUPPORTED);

    const provider = new AntigravityProvider({ config: cfg });
    const err = await new Promise<string>((resolveErr) => {
      provider.start(
        {
          prompt: "hello",
          threadId: "t-unattested",
          turnId: "turn-1",
        },
        {
          onChunk: () => {},
          onApproval: () => {},
          onDone: () => resolveErr("unexpected-done"),
          onError: (msg) => resolveErr(msg),
        },
      );
    });
    expect(err).toContain(PROCESS_TREE_UNSUPPORTED);
  });

  it("discovers standard %LOCALAPPDATA%\\agy\\bin\\agy.exe installation while skipping .cmd shims", () => {
    const root = makeTempDir();
    const badPath = makeTempDir();
    writeFileSync(join(badPath, "agy.cmd"), "@echo off\n", "utf8");
    const agyDir = join(root, "agy", "bin");
    mkdirSync(agyDir, { recursive: true });
    const exe = join(agyDir, "agy.exe");
    writeFileSync(exe, "stub", "utf8");

    const found = discoverAntigravityExecutable(
      { LOCALAPPDATA: root, PATH: badPath },
      "win32",
    );
    expect(found).toBe(exe);
  });

  it("manages AntigravitySetup choose/save/clear lifecycle and savedEffect reporting", async () => {
    const dir = makeTempDir();
    const exe = join(dir, "agy.exe");
    writeFileSync(exe, "stub", "utf8");

    let persisted: string | undefined;
    const setup = new AntigravitySetup({
      mutable: () => true,
      savedExecutable: () => persisted,
      commit: (p) => {
        persisted = p;
      },
      platform: "win32",
    });

    const bad = await setup.choose(async () => ({ canceled: false, filePaths: [join(dir, "missing.exe")] }));
    expect(bad.status).toBe("invalid");

    const chosen = await setup.choose(async () => ({ canceled: false, filePaths: [exe] }));
    expect(chosen).toEqual({ status: "chosen", path: exe });

    const saved = setup.save();
    expect(saved).toEqual({ status: "saved", path: exe, changed: true });
    expect(persisted).toBe(exe);

    expect(
      antigravitySavedEffect(persisted, null, { TIVANO_PROVIDER: "mock" }).savedEffect,
    ).toBe("blocked");
    expect(antigravitySavedEffect(persisted, null, {}).savedEffect).toBe("pending-restart");
    expect(
      antigravityTestPick(false, {
        TIVANO_TEST_MODE: "antigravity-setup",
        TIVANO_TEST_ANTIGRAVITY_PICK: exe,
      }),
    ).toBe(exe);

    expect(setup.clear()).toEqual({ status: "cleared", changed: true });
    expect(persisted).toBeUndefined();
  });
});
