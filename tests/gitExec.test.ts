// gitExec runner tests — REAL child processes, not mocks. Covers the
// three bounds the lead probes reproduced: hard retained-byte cap while
// a child ignores SIGTERM, idempotent escalation, spawn-error reporting
// and observed exits.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitChildEnv, makeGitRunner } from "../src/main/gitExec";

const NODE = process.execPath;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tivano-p2f-exec-"));
  dirs.push(d);
  return d;
};

const env = (home: string): Record<string, string> =>
  gitChildEnv(join(home, "home"));

describe("makeGitRunner — real children", () => {
  it("retains at most the byte cap while a TERM-ignoring child floods", async () => {
    const home = tmp();
    const runner = makeGitRunner(NODE);
    // 32 KiB writes every 5ms, SIGTERM ignored — the only out is SIGKILL.
    const h = runner.run(
      [
        "-e",
        'process.on("SIGTERM",()=>{});const b=Buffer.alloc(32768,65);setInterval(()=>process.stdout.write(b),5)',
      ],
      { env: env(home), timeoutMs: 5000, maxBytes: 1024 },
    );
    const r = await h.done;
    expect(r.overflowed).toBe(true);
    // Hard retained bound: never more than the cap itself.
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024);
    // Exit was OBSERVED (SIGKILL after the grace window), not inferred.
    expect(r.signal).toBe("SIGKILL");
    expect(runner.active().size).toBe(0);
    expect(h.pid).toBeGreaterThan(0);
  });

  it("bounds stderr the same way", async () => {
    const home = tmp();
    const runner = makeGitRunner(NODE);
    const h = runner.run(
      ["-e", 'const b=Buffer.alloc(65536,66);for(let i=0;i<10;i++)process.stderr.write(b)'],
      { env: env(home), timeoutMs: 5000, maxBytes: 2048 },
    );
    const r = await h.done;
    expect(r.overflowed).toBe(true);
    expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(2048);
  });

  it("collects bounded output on a clean exit", async () => {
    const home = tmp();
    const runner = makeGitRunner(NODE);
    const h = runner.run(["-e", 'process.stdout.write("ok-42")'], {
      env: env(home),
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    const r = await h.done;
    expect(r.code).toBe(0);
    expect(r.overflowed).toBe(false);
    expect(r.stdout).toBe("ok-42");
    expect(runner.active().size).toBe(0);
  });

  it("repeated cancel never postpones the SIGKILL escalation", async () => {
    const home = tmp();
    const runner = makeGitRunner(NODE);
    const h = runner.run(
      ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],
      { env: env(home), timeoutMs: 60_000, maxBytes: 1024 },
    );
    // Let the child boot and register its SIGTERM handler first — a
    // signal arriving before the -e script runs is a default kill, not
    // the escalation path under test.
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    h.cancel();
    // Re-cancel inside the grace window must NOT push SIGKILL later.
    await new Promise((r) => setTimeout(r, 400));
    h.cancel();
    h.cancel();
    const r = await h.done;
    const elapsed = Date.now() - t0;
    expect(r.cancelled).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    // Grace is 800ms from the FIRST cancel; the two repeats added nothing.
    expect(elapsed).toBeLessThan(2000);
    expect(runner.active().size).toBe(0);
  });

  it("cancel on a settled handle is a no-op (never signals a reused pid)", async () => {
    const home = tmp();
    const runner = makeGitRunner(NODE);
    const h = runner.run(["-e", ""], { env: env(home), timeoutMs: 5000, maxBytes: 1024 });
    await h.done;
    // Handle already resolved — a late cancel cannot throw or signal.
    expect(() => h.cancel()).not.toThrow();
    expect(runner.active().size).toBe(0);
  });

  it("distinguishes a spawn failure from a process exit", async () => {
    const home = tmp();
    const runner = makeGitRunner(join(home, "no-such-git-executable"));
    const h = runner.run(["status"], { env: env(home), timeoutMs: 5000, maxBytes: 1024 });
    const r = await h.done;
    expect(r.spawnError).toBeTruthy();
    expect(h.pid).toBeNull();
    expect(runner.active().size).toBe(0);
  });

  it("timeout escalates and observes the exit", async () => {
    const home = tmp();
    const runner = makeGitRunner(NODE);
    const h = runner.run(["-e", "setInterval(()=>{},50)"], {
      env: env(home),
      timeoutMs: 300,
      maxBytes: 1024,
    });
    const r = await h.done;
    expect(r.timedOut).toBe(true);
    expect(runner.active().size).toBe(0);
  });

  it("gitChildEnv never leaks inherited Git/host configuration", () => {
    const e = gitChildEnv(tmp(), { GIT_CEILING_DIRECTORIES: "/x" });
    expect(e.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(e.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(e.GIT_ASKPASS).toBe("/bin/false");
    expect(e.GIT_ALLOW_PROTOCOL).toBe("");
    expect(e.GIT_CEILING_DIRECTORIES).toBe("/x");
    expect(Object.keys(e).some((k) => k.startsWith("SSH_AUTH"))).toBe(false);
  });
});

describe("gitChildEnv — simulated win32", () => {
  const sysEnv = {
    PATH: "C:\\Windows\\System32;D:\\UserBins",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    SystemDrive: "C:",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    USERPROFILE: "C:\\Users\\victim",
    GIT_DIR: "C:\\evil",
    GIT_SSH_COMMAND: "evil.exe",
  };
  const gitExe = "C:\\Program Files\\Git\\cmd\\git.exe";

  const winEnv = (home: string, extra?: Record<string, string>) =>
    gitChildEnv(home, extra, { platform: "win32", executable: gitExe, systemEnv: sysEnv });

  it("PATH contains ONLY the Git install dir and trusted system dirs", () => {
    const e = winEnv(tmp());
    const dirs = (e.PATH ?? "").split(";");
    expect(dirs).toEqual([
      "C:\\Program Files\\Git\\cmd",
      "C:\\Windows\\System32",
      "C:\\Windows",
    ]);
    // User PATH entries must never leak.
    expect(e.PATH).not.toContain("UserBins");
  });

  it("isolates HOME/USERPROFILE/TEMP/TMP/XDG under the git home", () => {
    const home = join(tmp(), "git-home");
    const e = winEnv(home);
    expect(e.HOME).toBe(home);
    expect(e.USERPROFILE).toBe(home);
    expect(e.APPDATA).toBe(home);
    expect(e.LOCALAPPDATA).toBe(home);
    expect(e.TEMP).toBe(join(home, "tmp"));
    expect(e.TMP).toBe(join(home, "tmp"));
    expect(e.XDG_CONFIG_HOME).toBe(join(home, "xdg"));
    expect(e.USERPROFILE).not.toBe(sysEnv.USERPROFILE);
  });

  it("masks system/global config with an OWNED empty file, never NUL", () => {
    const home = tmp();
    const e = winEnv(home);
    expect(e.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(e.GIT_CONFIG_SYSTEM).toBe(join(home, "empty-gitconfig"));
    expect(e.GIT_CONFIG_GLOBAL).toBe(join(home, "empty-gitconfig"));
    expect(e.GIT_CONFIG_SYSTEM).not.toMatch(/^NUL$/i);
    // The mask file exists, is ours, and is empty.
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const mask = e.GIT_CONFIG_SYSTEM!;
    expect(existsSync(mask)).toBe(true);
    expect(readFileSync(mask, "utf8")).toBe("");
  });

  it("no GIT_* or helper variables are inherited; helpers point at nothing", () => {
    const home = tmp();
    const e = winEnv(home);
    expect(e.GIT_DIR).toBeUndefined();
    expect(e.GIT_SSH_COMMAND).toBe(join(home, "no-helper.exe"));
    expect(e.GIT_ASKPASS).toBe(join(home, "no-helper.exe"));
    expect(e.SSH_ASKPASS).toBe(join(home, "no-helper.exe"));
    expect(e.GIT_TERMINAL_PROMPT).toBe("0");
    expect(e.GIT_PAGER).toBe("");
    expect(e.GIT_ALLOW_PROTOCOL).toBe("");
    expect(e.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(e.GIT_LITERAL_PATHSPECS).toBe("1");
    expect(e.GIT_NOGLOB_PATHSPECS).toBe("1");
  });

  it("trusted system vars pass through case-insensitively", () => {
    const e = winEnv(tmp());
    expect(e.SystemRoot).toBe("C:\\Windows");
    expect(e.windir).toBe("C:\\Windows");
    expect(e.SystemDrive).toBe("C:");
    expect(e.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("extra values layer over the base — ceilings/alternates internal only", () => {
    const e = winEnv(tmp(), { GIT_CEILING_DIRECTORIES: "C:\\repo", GIT_ALTERNATE_OBJECT_DIRECTORIES: "\"C:\\o\"" });
    expect(e.GIT_CEILING_DIRECTORIES).toBe("C:\\repo");
    expect(e.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe("\"C:\\o\"");
  });
});


describe("Git environment fails closed", () => {
  it.each(["PATH", "GIT_CONFIG_GLOBAL", "GIT_ALLOW_PROTOCOL", "git_config_global"])(
    "rejects internal override %s before creating a home", (key) => {
      for (const platform of ["darwin", "win32"] as const) {
        const home = join(tmp(), "uncreated");
        expect(() => gitChildEnv(home, { [key]: "unsafe" }, { platform })).toThrow(/environment key/);
        expect(existsSync(home)).toBe(false);
      }
    });
  it.each(["nonempty", "link", "directory"])("rejects a %s config mask without altering it", (kind) => {
    const home = tmp(), mask = join(home, "empty-gitconfig");
    if (kind === "nonempty") writeFileSync(mask, "[include]\npath=bad\n");
    else if (kind === "directory") mkdirSync(mask);
    else {
      const target = join(home, "target"); writeFileSync(target, ""); symlinkSync(target, mask);
    }
    expect(() => gitChildEnv(home, undefined, { platform: "win32" })).toThrow(/regular empty file/);
  });
  it("propagates home/config creation failure", () => {
    const parent = join(tmp(), "file"); writeFileSync(parent, "occupied");
    expect(() => gitChildEnv(join(parent, "home"), undefined, { platform: "win32" })).toThrow();
  });
});
