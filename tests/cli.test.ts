// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// F33 CLI command: installer semantics (frozen ControlCLIInstaller) and
// the real tivano.mjs client against a live control socket.

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { LocalControlService } from "../src/main/localControl";
import {
  cliStatus,
  CliInstallError,
  installCli,
  uninstallCli,
} from "../src/main/cliInstall";

const exec = promisify(execFile);
const CLI = join(__dirname, "..", "cli", "tivano.mjs");

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "tivano-cli-"));
  dirs.push(d);
  return d;
};
const services: LocalControlService[] = [];
afterEach(() => {
  for (const s of services) s.dispose();
  services.length = 0;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("cliInstall (frozen ControlCLIInstaller)", () => {
  const target = "/app/cli/tivano.mjs";

  it("installs a shim with the target marker and reports installed", () => {
    const dir = join(freshDir(), "bin");
    const r = installCli(dir, target);
    expect(r.state).toBe("installed");
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain(`# tivano-cli-shim: ${target}`);
    expect(text).toContain("exec node");
    expect(cliStatus(dir)).toEqual({ state: "installed", path: r.path, target });
  });

  it("repairs its own shim but refuses to replace a foreign command", () => {
    const dir = freshDir();
    installCli(dir, "/old/target.mjs");
    // Repair: same surface, new target — allowed.
    const r = installCli(dir, target);
    expect(r.target).toBe(target);
    // Foreign file: no marker → conflict refusal, file untouched.
    const foreign = join(dir, "tivano");
    writeFileSync(foreign, "#!/bin/sh\necho foreign\n");
    expect(cliStatus(dir).state).toBe("foreign");
    expect(() => installCli(dir, target)).toThrow(CliInstallError);
    expect(readFileSync(foreign, "utf8")).toContain("foreign");
  });

  it("uninstalls only its own shim and refuses foreign removal", () => {
    const dir = freshDir();
    installCli(dir, target);
    expect(uninstallCli(dir).state).toBe("absent");
    expect(cliStatus(dir).state).toBe("absent");
    // Foreign file survives an uninstall attempt with a conflict.
    const foreign = join(dir, "tivano");
    writeFileSync(foreign, "foreign");
    expect(() => uninstallCli(dir)).toThrow(CliInstallError);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe("tivano.mjs client (real socket round trip)", () => {
  function rig() {
    const root = freshDir();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "t");
    const svc = new LocalControlService(engine, root, "dev");
    services.push(svc);
    return { engine, svc, sock: join(root, "control", "control.sock") };
  }
  const run = (sock: string, ...args: string[]) =>
    exec("node", [CLI, ...args], {
      env: { ...process.env, TIVANO_CONTROL_SOCKET: sock },
      timeout: 15_000,
    });

  it("info returns the real welcome payload after handshake", async () => {
    const { engine, svc, sock } = rig();
    engine.setSettings({ alphaEnabled: true, externalControlEnabled: true });
    svc.refreshListening();
    const { stdout } = await run(sock, "info");
    const info = JSON.parse(stdout) as { info: { edition: string; version: number } };
    expect(info.info.edition).toBe("dev");
    expect(info.info.version).toBe(1);
  });

  it("settings get returns the bounded settings snapshot", async () => {
    const { engine, svc, sock } = rig();
    engine.setSettings({ alphaEnabled: true, externalControlEnabled: true });
    svc.refreshListening();
    const { stdout } = await run(sock, "settings", "get");
    const r = JSON.parse(stdout) as { settings: { key: string }[] };
    expect(r.settings.map((s) => s.key)).toContain("showsSkylight");
  });

  it("settings set writes a real persisted setting via a client ticket", async () => {
    const { engine, svc, sock } = rig();
    engine.setSettings({ alphaEnabled: true, externalControlEnabled: true });
    svc.refreshListening();
    const { stdout } = await run(sock, "settings", "set", "showsSkylight=false");
    const r = JSON.parse(stdout) as { operation: { state: string } };
    expect(r.operation.state).toBe("ended");
    expect(engine.snapshot().settings.showsSkylight).toBe(false);
  });

  it("exit code 4 with an honest error when the gates are off", async () => {
    const { svc, sock } = rig();
    // Gates off → service isn't even listening → connect fails (rc 3);
    // enable listening then the request is refused (rc 4).
    svc.refreshListening();
    expect(svc.listening).toBe(false);
    await expect(run(sock, "info")).rejects.toMatchObject({ code: 3 });
  });
});
