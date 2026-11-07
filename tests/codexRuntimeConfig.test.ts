// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex runtime resolution: three honest states, executable validation,
// app-private CODEX_HOME with file credential store, whitelisted child env.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexEnv,
  resolveCodexHome,
  resolveCodexRuntime,
  validateCodexExecutable,
  CodexConfigError,
} from "../src/main/codexRuntimeConfig";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-codexcfg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("validateCodexExecutable", () => {
  it("rejects non-absolute, .cmd/.bat, and non-codex basenames", () => {
    expect(() => validateCodexExecutable("codex")).toThrow(CodexConfigError);
    const d = freshRoot();
    const bat = join(d, "codex.bat");
    writeFileSync(bat, "@echo off");
    expect(() => validateCodexExecutable(bat, "win32")).toThrow(/\.cmd\/\.bat/);
    const notCodex = join(d, "codex-wrapper.exe");
    writeFileSync(notCodex, "x");
    expect(() => validateCodexExecutable(notCodex, "win32")).toThrow(/native Codex CLI/);
  });

  it("accepts a real codex.exe (win32) and returns its physical path", () => {
    const d = freshRoot();
    const exe = join(d, "codex.exe");
    writeFileSync(exe, "MZ");
    expect(validateCodexExecutable(exe, "win32")).toBe(realpathSync(exe));
  });

  it("rejects a missing file and a directory", () => {
    const d = freshRoot();
    expect(() => validateCodexExecutable(join(d, "codex.exe"), "win32")).toThrow(/not a regular file/);
    expect(() => validateCodexExecutable(d, "win32")).toThrow();
  });
});

describe("buildCodexEnv", () => {
  it("carries CODEX_HOME + HOME-ish roots and never leaks secrets", () => {
    const env = buildCodexEnv("/data/codex-home", "linux");
    expect(env.CODEX_HOME).toBe("/data/codex-home");
    expect(env.HOME).toBe("/data/codex-home");
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|PROXY/i);
    }
    expect(env.PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("resolveCodexHome", () => {
  it("creates a persistent dir under dataRoot + pins file credential store", () => {
    const root = freshRoot();
    const a = resolveCodexHome(root);
    const b = resolveCodexHome(root);
    expect(a.codexHome).toBe(b.codexHome);
    expect(a.codexHomeId).toBe(b.codexHomeId);
    expect(a.codexHome).not.toBe(join(homedir(), ".codex"));
    const cfg = join(a.codexHome, "config.toml");
    expect(existsSync(cfg)).toBe(true);
    expect(readFileSync(cfg, "utf8")).toContain('cli_auth_credentials_store = "file"');
    // tmp exists and stays physically inside the home
    const tmp = join(a.codexHome, "tmp");
    expect(lstatSync(tmp).isDirectory()).toBe(true);
    expect(realpathSync(tmp).startsWith(a.codexHome)).toBe(true);
  });

  it("refuses a codex-home symlink pointing outside the data root", () => {
    const root = freshRoot();
    const outside = freshRoot();
    symlinkSync(outside, join(root, "codex-home"), "dir");
    expect(() => resolveCodexHome(root)).toThrow(/CODEX_HOME_UNSAFE/);
  });

  it("refuses a config.toml that is a link to an external file", () => {
    const root = freshRoot();
    const home = join(root, "codex-home");
    mkdirSync(home);
    const external = join(freshRoot(), "victim.toml");
    writeFileSync(external, "x = 1\n");
    symlinkSync(external, join(home, "config.toml"));
    expect(() => resolveCodexHome(root)).toThrow(/CODEX_HOME_UNSAFE/);
    // the external file must be untouched
    expect(readFileSync(external, "utf8")).toBe("x = 1\n");
  });

  it("refuses an existing config that demands a non-file credential store", () => {
    const root = freshRoot();
    const home = join(root, "codex-home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(() => resolveCodexHome(root)).toThrow(/CODEX_CONFIG_INCOMPATIBLE/);
    // never overwritten
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("keyring");
  });

  it("accepts an existing config that already carries exactly our minimal policy", () => {
    const root = freshRoot();
    const home = join(root, "codex-home");
    mkdirSync(home);
    const content = '# ours\ncli_auth_credentials_store = "file"   # pinned\n\n';
    writeFileSync(join(home, "config.toml"), content);
    const res = resolveCodexHome(root);
    expect(res.codexHome).toBe(realpathSync(home));
    // bytes preserved verbatim — never rewritten, never appended to
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(content);
  });

  it("accepts our policy line even without a trailing newline", () => {
    const root = freshRoot();
    const home = join(root, "codex-home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"');
    expect(() => resolveCodexHome(root)).not.toThrow();
    // and the file was NOT appended to — bytes are exactly what existed
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
      'cli_auth_credentials_store = "file"',
    );
  });

  it.each([
    ["a different top-level key", 'model = "x"\n'],
    ["a policy inside a table", '[profiles.test]\ncli_auth_credentials_store = "file"\n'],
    ["single-quoted value", "cli_auth_credentials_store = 'file'\n"],
    ["a non-file store", 'cli_auth_credentials_store = "keyring"\n'],
    ["duplicate keys", 'cli_auth_credentials_store = "file"\ncli_auth_credentials_store = "file"\n'],
    ["an unquoted value", "cli_auth_credentials_store = file\n"],
    ["our file missing the policy (empty)", ""],
    ["a bare key with no value", "cli_auth_credentials_store\n"],
    ["junk after the value", 'cli_auth_credentials_store = "file" extra\n'],
  ])("refuses to adopt or modify an existing config carrying %s", (_why, toml) => {
    const root = freshRoot();
    const home = join(root, "codex-home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), toml);
    expect(() => resolveCodexHome(root)).toThrow(/CODEX_CONFIG_INCOMPATIBLE/);
    // original bytes are preserved verbatim — never appended or rewritten
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(toml);
  });

  it("refuses a tmp entry that is a link", () => {
    const root = freshRoot();
    const home = join(root, "codex-home");
    mkdirSync(home);
    symlinkSync(freshRoot(), join(home, "tmp"), "dir");
    expect(() => resolveCodexHome(root)).toThrow(/CODEX_HOME_UNSAFE/);
  });
});

describe("resolveCodexRuntime", () => {
  it("nothing set → unconfigured", () => {
    const c = resolveCodexRuntime({}, freshRoot());
    expect(c.mode).toBe("unconfigured");
    // argv pins the credential store too — config alone is never trusted
    // to keep the policy.
    expect(c.args).toEqual(["-c", 'cli_auth_credentials_store="file"', "app-server"]);
  });

  it("both fixture and real set → refuses to guess (unconfigured + reason)", () => {
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_FIXTURE: "/f/app-server.mjs", TIVANO_CODEX_EXECUTABLE: "/x/codex.exe" },
      freshRoot(),
    );
    expect(c.mode).toBe("unconfigured");
    expect(c.realUnavailableReason).toContain("both set");
  });

  it("fixture requires absolute .mjs + absolute node", () => {
    const root = freshRoot();
    expect(
      resolveCodexRuntime({ TIVANO_CODEX_FIXTURE: "rel/app.mjs", TIVANO_CODEX_NODE: "/bin/node" }, root)
        .mode,
    ).toBe("unconfigured");
    expect(
      resolveCodexRuntime({ TIVANO_CODEX_FIXTURE: "/f/app.js", TIVANO_CODEX_NODE: "/bin/node" }, root)
        .realUnavailableReason,
    ).toContain("CODEX_FIXTURE_INVALID");
    expect(
      resolveCodexRuntime({ TIVANO_CODEX_FIXTURE: "/f/app.mjs" }, root).realUnavailableReason,
    ).toContain("CODEX_FIXTURE_INVALID");
    const ok = resolveCodexRuntime(
      { TIVANO_CODEX_FIXTURE: "/f/app-server.mjs", TIVANO_CODEX_NODE: "/bin/node" },
      root,
    );
    expect(ok.mode).toBe("fixture");
    expect(ok.fixtureScript).toBe("/f/app-server.mjs");
  });

  it("real mode reports mode:real but stays gated by the tree capability", () => {
    const d = freshRoot();
    const exe = join(d, "codex.exe");
    writeFileSync(exe, "MZ");
    const c = resolveCodexRuntime({ TIVANO_CODEX_EXECUTABLE: exe }, freshRoot());
    expect(c.mode).toBe("real");
    expect(c.executable).toBe(realpathSync(exe));
    // No Windows Job evidence on this host → unsupported stays honest.
    expect(c.treeCapability.supported).toBe(false);
    expect(c.realUnavailableReason).toContain("PROCESS_TREE_UNSUPPORTED");
  });

  it("invalid real executable degrades to unconfigured with the reason", () => {
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_EXECUTABLE: "C:\\x\\codex.bat" },
      freshRoot(),
    );
    expect(c.mode).toBe("unconfigured");
    expect(c.realUnavailableReason).toContain("CODEX_EXECUTABLE_INVALID");
  });

  it("an injected attested capability is used verbatim — real mode ungated", () => {
    const d = freshRoot();
    const exe = join(d, "codex.exe");
    writeFileSync(exe, "MZ");
    const attested = {
      supported: true as const,
      platform: "win32" as const,
      mechanism: "windows-job-object" as const,
      helperPath: "D:\\pkg\\resources\\job-helper\\tivano-job-helper.exe",
      helperVersion: "1.1.0",
    };
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_EXECUTABLE: exe, TIVANO_CODEX_JOB_HELPER: "D:\\evil\\fake.exe" },
      freshRoot(),
      { platform: "win32", treeCapability: attested },
    );
    expect(c.mode).toBe("real");
    expect(c.treeCapability).toBe(attested); // identity — used verbatim
    // The env helper hint was IGNORED: the attested path stands.
    expect(c.treeCapability.helperPath).toBe(attested.helperPath);
    expect(c.realUnavailableReason).toBeUndefined();
  });

  it("an injected UNSUPPORTED verdict is used verbatim too", () => {
    const d = freshRoot();
    const exe = join(d, "codex.exe");
    writeFileSync(exe, "MZ");
    const verdict = {
      supported: false as const,
      platform: "win32" as const,
      reason: "PROCESS_TREE_UNSUPPORTED: job-helper hash mismatch",
    };
    const c = resolveCodexRuntime(
      { TIVANO_CODEX_EXECUTABLE: exe },
      freshRoot(),
      { platform: "win32", treeCapability: verdict },
    );
    expect(c.mode).toBe("real");
    expect(c.treeCapability).toBe(verdict);
    expect(c.realUnavailableReason).toContain("hash mismatch");
  });
});
