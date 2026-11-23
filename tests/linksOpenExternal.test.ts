// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-31: the links:open-external handler itself — an existing local file
// reaches the recorded openPath seam, a missing path (and a resolved web
// target that is not http) gets the quiet beep, and nothing else opens.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  beep: vi.fn(),
  openPath: vi.fn((_path: string) => Promise.resolve("")),
  openExternal: vi.fn((_url: string) => Promise.resolve()),
}));

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => "") },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) =>
      mocks.handlers.set(channel, fn),
    removeHandler: vi.fn(),
  },
  shell: {
    beep: mocks.beep,
    openPath: mocks.openPath,
    openExternal: mocks.openExternal,
  },
}));

import { registerIpc } from "../src/main/ipc";
import type { Engine } from "../src/main/engine";

const ALLOWED = "file:///C:/tivano/index.html";

const event = {
  sender: { isDestroyed: () => false },
  senderFrame: { url: ALLOWED },
};

function register(logDir: string, withLog = true) {
  const externalLog = join(logDir, "external-open.log");
  const engine = {
    threadDirectory: () => null,
    onEvent: () => () => {},
  } as unknown as Engine;
  registerIpc({
    engine,
    allowedUrl: ALLOWED,
    broadcast: () => {},
    externalLog: withLog ? externalLog : undefined,
  });
  return {
    externalLog,
    invoke: (url: string) =>
      mocks.handlers.get("links:open-external")!(event, { url }),
  };
}

describe("links:open-external handler (P2-31)", () => {
  beforeEach(() => {
    mocks.beep.mockClear();
    mocks.openPath.mockClear();
    mocks.openExternal.mockClear();
  });

  it("an existing local file records the openPath seam instead of opening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tivano-links-"));
    const target = join(dir, "note.txt");
    writeFileSync(target, "hi");
    const { externalLog, invoke } = register(dir);
    await invoke(target);
    // The armed seam stands in for the real open (no real app launches),
    // so shell.openPath must not fire and nothing beeps.
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.beep).not.toHaveBeenCalled();
    const seam = readFileSync(externalLog, "utf8").trim();
    expect(JSON.parse(seam)).toMatchObject({ action: "openPath", target });
  });

  it("without the seam an existing local file reaches shell.openPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tivano-links-"));
    const target = join(dir, "note.txt");
    writeFileSync(target, "hi");
    const { invoke } = register(dir, false);
    await invoke(target);
    expect(mocks.openPath).toHaveBeenCalledWith(target);
    expect(mocks.beep).not.toHaveBeenCalled();
  });

  it("a missing path beeps and opens nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tivano-links-"));
    const { invoke } = register(dir);
    await invoke(join(dir, "does-not-exist.txt"));
    expect(mocks.beep).toHaveBeenCalledTimes(1);
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("a bare missing name resolves to a non-http web target — beep, no throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tivano-links-"));
    const { invoke } = register(dir);
    await expect(invoke("DefinitelyMissing.ts:12")).resolves.toBeUndefined();
    expect(mocks.beep).toHaveBeenCalledTimes(1);
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
