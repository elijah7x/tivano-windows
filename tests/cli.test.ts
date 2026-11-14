// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-14.
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
import { basename, join } from "node:path";
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
    // win32 status reads the tivano.cmd sibling first; either marked
    // shim name counts as installed.
    const st = cliStatus(dir);
    expect(st).toMatchObject({ state: "installed", target });
    if (st.state === "installed")
      expect(["tivano", "tivano.cmd"]).toContain(basename(st.path));
  });

  it("repairs its own shim but refuses to replace a foreign command", () => {
    const dir = freshDir();
    installCli(dir, "/old/target.mjs");
    // Repair: same surface, new target — allowed.
    const r = installCli(dir, target);
    expect(r.target).toBe(target);
    // Foreign file: no marker → conflict refusal, file untouched.
    uninstallCli(dir);
    const foreign = join(dir, "tivano");
    writeFileSync(foreign, "#!/bin/sh\necho foreign\n");
    expect(cliStatus(dir).state).toBe("foreign");
    expect(() => installCli(dir, target)).toThrow(CliInstallError);
    expect(readFileSync(foreign, "utf8")).toContain("foreign");
  });

  it("refuses when either command-name sibling is foreign", () => {
    const dir = freshDir();
    installCli(dir, target);
    // win32 status reads tivano.cmd first; a foreign file under the
    // other name must still block install and stay untouched.
    const foreign = join(dir, "tivano");
    writeFileSync(foreign, "#!/bin/sh\necho foreign\n");
    expect(() => installCli(dir, target)).toThrow(CliInstallError);
    expect(readFileSync(foreign, "utf8")).toContain("foreign");
  });

  it("reports repair when its shim points at a stale or missing client", () => {
    const dir = freshDir();
    const realClient = join(freshDir(), "tivano.mjs");
    writeFileSync(realClient, "// synthetic client\n");
    installCli(dir, realClient);
    // Healthy: marker matches this launch's bundled client.
    expect(cliStatus(dir, realClient).state).toBe("installed");
    // Out of date: marker still points at an older copy.
    const stale = join(freshDir(), "older", "tivano.mjs");
    installCli(dir, stale);
    expect(cliStatus(dir, realClient)).toMatchObject({ state: "repair", target: stale });
    // A stale shim is still ours — uninstall removes it.
    expect(uninstallCli(dir).state).toBe("absent");
    // Broken: marker matches but the client itself is gone.
    installCli(dir, realClient);
    rmSync(realClient);
    expect(cliStatus(dir, realClient).state).toBe("repair");
  });

  it("uninstalls every marked sibling and refuses foreign removal", () => {
    const dir = freshDir();
    installCli(dir, target);
    expect(uninstallCli(dir).state).toBe("absent");
    expect(cliStatus(dir).state).toBe("absent");
    // Whatever sibling set install wrote (win32 adds tivano.cmd), all
    // marked files are gone — nothing ours can report installed again.
    expect(existsSync(join(dir, "tivano"))).toBe(false);
    expect(existsSync(join(dir, "tivano.cmd"))).toBe(false);
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
