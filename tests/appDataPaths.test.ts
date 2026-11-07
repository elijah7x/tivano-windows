// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Pure data-root resolution: flag > env > packaged appData > dev .devdata.
import { isAbsolute, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_DATA_DIR_NAME,
  resolveDataRoot,
  type DataRootInputs,
} from "../src/main/appDataPaths";

const base: DataRootInputs = {
  argv: ["electron", "app"],
  env: {},
  packaged: false,
  appPath: "/repo",
  appDataDir: "/home/u/AppData/Roaming",
};

describe("resolveDataRoot", () => {
  it("explicit --data-root flag wins over everything", () => {
    const d = resolveDataRoot({
      ...base,
      argv: ["electron", "app", "--data-root=/tmp/flag-root"],
      env: { TIVANO_DATA_ROOT: "/tmp/env-root" },
      packaged: true,
    });
    expect(d).toEqual({ root: resolve("/tmp/flag-root"), source: "flag" });
  });

  it("relative --data-root resolves against cwd", () => {
    const d = resolveDataRoot({ ...base, argv: ["x", "--data-root=rel-dir"] });
    expect(d.source).toBe("flag");
    expect(isAbsolute(d.root)).toBe(true);
    expect(d.root).toBe(resolve("rel-dir"));
  });

  it("empty --data-root= falls through to env", () => {
    const d = resolveDataRoot({
      ...base,
      argv: ["x", "--data-root="],
      env: { TIVANO_DATA_ROOT: "/tmp/env-root" },
    });
    expect(d).toEqual({ root: resolve("/tmp/env-root"), source: "env" });
  });

  it("env override used when no flag, even when packaged", () => {
    const d = resolveDataRoot({
      ...base,
      packaged: true,
      env: { TIVANO_DATA_ROOT: "/tmp/env-root" },
    });
    expect(d.source).toBe("env");
  });

  it("unbundled development defaults to <project>/.devdata", () => {
    const d = resolveDataRoot(base);
    expect(d).toEqual({ root: join("/repo", ".devdata"), source: "dev-default" });
  });

  it("packaged builds default to <appData>/Tivano Windows Dev — never the ASAR", () => {
    const d = resolveDataRoot({ ...base, packaged: true, appPath: "C:\\Program Files\\Tivano\\resources\\app.asar" });
    expect(d.source).toBe("packaged-default");
    expect(d.root).toBe(join("/home/u/AppData/Roaming", "Tivano Windows Dev"));
    // The packaged default must NOT live under the install path / ASAR.
    expect(d.root.includes(".asar")).toBe(false);
    expect(d.root.endsWith(`${sep}${PACKAGED_DATA_DIR_NAME}`)).toBe(true);
  });

  it("packaged + flag still honours the explicit flag", () => {
    const d = resolveDataRoot({
      ...base,
      packaged: true,
      argv: ["x", "--data-root=D:\\isolated"],
    });
    expect(d.source).toBe("flag");
  });

  it("packaged default refuses a missing/relative app-data dir", () => {
    expect(() =>
      resolveDataRoot({ ...base, packaged: true, appDataDir: "" }),
    ).toThrow(/app-data/i);
    expect(() =>
      resolveDataRoot({ ...base, packaged: true, appDataDir: "relative" }),
    ).toThrow(/app-data/i);
  });

  it("packaged dir name matches the dev edition identity", () => {
    expect(PACKAGED_DATA_DIR_NAME).toBe("Tivano Windows Dev");
    // Never collides with Tivano, Tivano Dev or Droppy stores.
    expect(["Tivano", "Tivano Dev", "Droppy", "Droppy Code"]).not.toContain(
      PACKAGED_DATA_DIR_NAME,
    );
  });

  it("explicit flag does not query the OS app-data directory", () => {
    const d = resolveDataRoot({
      ...base,
      argv: ["x", "--data-root=/tmp/flag-root"],
      env: { TIVANO_DATA_ROOT: "/tmp/env-root" },
      packaged: true,
      appDataDir: () => { throw new Error("unexpected app-data query"); },
    });
    expect(d).toEqual({ root: resolve("/tmp/flag-root"), source: "flag" });
  });

  it("env override does not query the OS app-data directory", () => {
    const d = resolveDataRoot({
      ...base,
      env: { TIVANO_DATA_ROOT: "/tmp/env-root" },
      packaged: true,
      appDataDir: () => { throw new Error("unexpected app-data query"); },
    });
    expect(d).toEqual({ root: resolve("/tmp/env-root"), source: "env" });
  });

  it("development default does not query the OS app-data directory", () => {
    const d = resolveDataRoot({
      ...base,
      appDataDir: () => { throw new Error("unexpected app-data query"); },
    });
    expect(d).toEqual({ root: join("/repo", ".devdata"), source: "dev-default" });
  });

  it("empty flag keeps env priority without querying OS app-data", () => {
    const d = resolveDataRoot({
      ...base,
      argv: ["x", "--data-root="],
      env: { TIVANO_DATA_ROOT: "/tmp/env-root" },
      packaged: true,
      appDataDir: () => { throw new Error("unexpected app-data query"); },
    });
    expect(d).toEqual({ root: resolve("/tmp/env-root"), source: "env" });
  });

  it("packaged default queries OS app-data exactly once and uses its result", () => {
    const appDataDir = resolve("/tmp/lazy-app-data");
    let calls = 0;
    const d = resolveDataRoot({
      ...base,
      packaged: true,
      appDataDir: () => {
        calls += 1;
        return appDataDir;
      },
    });
    expect(calls).toBe(1);
    expect(d).toEqual({
      root: join(appDataDir, PACKAGED_DATA_DIR_NAME),
      source: "packaged-default",
    });
  });

  it("packaged default propagates an OS app-data query failure", () => {
    const failure = new Error("Failed to get 'appData' path");
    expect(() =>
      resolveDataRoot({
        ...base,
        packaged: true,
        appDataDir: () => { throw failure; },
      }),
    ).toThrow(failure);
  });

  it("packaged default refuses an empty app-data callback result", () => {
    expect(() =>
      resolveDataRoot({ ...base, packaged: true, appDataDir: () => "" }),
    ).toThrow(/app-data/i);
  });

  it("packaged default refuses a relative app-data callback result", () => {
    expect(() =>
      resolveDataRoot({ ...base, packaged: true, appDataDir: () => "relative" }),
    ).toThrow(/app-data/i);
  });
});
