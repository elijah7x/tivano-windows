// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Git runtime resolution — the Windows executable can ONLY come from an
// explicit absolute config, a standard Git-for-Windows root, or an
// absolute PATH entry; everything else is an honest unavailable. These
// tests simulate win32 on the host — real Windows acceptance is
// scripts/windows/packaged-git-test.mjs.

import { describe, expect, it } from "vitest";
import {
  resolveGitExecutable,
  winIsAbsolute,
  type GitRuntimeFs,
} from "../src/main/gitRuntimeConfig";

/** In-memory filesystem for resolution — paths are Windows-shaped. */
const memFs = (files: string[]): Partial<GitRuntimeFs> => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    existsFile: (p) => set.has(p.toLowerCase()),
    realpath: (p) => p,
  };
};
const win = (source: Record<string, string>, files: string[] = []) =>
  resolveGitExecutable(source, { platform: "win32", fs: memFs(files) });

describe("resolveGitExecutable — posix convention", () => {
  it("non-win32 resolves /usr/bin/git unconditionally", () => {
    const r = resolveGitExecutable({}, { platform: "darwin" });
    expect(r).toEqual({ kind: "resolved", executable: "/usr/bin/git", source: "posix" });
  });
});

describe("resolveGitExecutable — win32 explicit config", () => {
  const git = "C:\\Program Files\\Git\\cmd\\git.exe";

  it("a valid absolute TIVANO_GIT_EXECUTABLE resolves with env source", () => {
    const r = win({ TIVANO_GIT_EXECUTABLE: git }, [git]);
    expect(r).toEqual({ kind: "resolved", executable: git, source: "env" });
  });

  it.each([
    ["relative path", "Git\\cmd\\git.exe"],
    ["just a name", "git.exe"],
    ["a .bat wrapper", "C:\\Git\\git.bat"],
    ["not git.exe", "C:\\Git\\cmd\\git-cmd.exe"],
    ["missing file", "C:\\Nope\\git.exe"],
    ["cwd-relative", ".\\git.exe"],
  ])("invalid explicit %s → git-config-invalid, NEVER fallback", (_l, exe) => {
    // Even with a perfect standard install + PATH hit available.
    const files = ["C:\\Program Files\\Git\\cmd\\git.exe", "D:\\bin\\git.exe"];
    const r = win(
      {
        TIVANO_GIT_EXECUTABLE: exe,
        ProgramFiles: "C:\\Program Files",
        PATH: "D:\\bin",
      },
      files,
    );
    expect(r.kind).toBe("unavailable");
    expect(r.kind === "unavailable" && r.reason).toBe("git-config-invalid");
  });

  it.each(["", "   "])("explicit blank %j fails closed without fallback", (value) => {
    const r = win({ TIVANO_GIT_EXECUTABLE: value, PATH: "D:\\bin" }, ["D:\\bin\\git.exe"]);
    expect(r.kind === "unavailable" && r.reason).toBe("git-config-invalid");
  });
});

describe("resolveGitExecutable — win32 standard + PATH routes", () => {
  const pf = "C:\\Program Files\\Git\\cmd\\git.exe";
  const pf32 = "C:\\Program Files (x86)\\Git\\cmd\\git.exe";
  const local = "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe";

  it("standard ProgramFiles install resolves", () => {
    const r = win({ ProgramFiles: "C:\\Program Files" }, [pf]);
    expect(r).toEqual({ kind: "resolved", executable: pf, source: "standard" });
  });

  it("LOCALAPPDATA per-user install resolves (Programs\\Git)", () => {
    const r = win(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      [local],
    );
    expect(r).toEqual({ kind: "resolved", executable: local, source: "standard" });
  });

  it("PATH: first ABSOLUTE directory containing git.exe wins", () => {
    const r = win(
      { PATH: "D:\\tools;C:\\Git\\cmd;D:\\bin" },
      ["D:\\bin\\git.exe", "C:\\Git\\cmd\\git.exe"],
    );
    // D:\tools has no git.exe; C:\Git\cmd does — first real hit.
    expect(r).toEqual({ kind: "resolved", executable: "C:\\Git\\cmd\\git.exe", source: "path" });
  });

  it("PATH ignores relative, dot and empty entries — cwd is never searched", () => {
    const r = win(
      { PATH: ".;rel\\dir;;C:\\safe\\bin" },
      ["C:\\safe\\bin\\git.exe", ".\\git.exe", "rel\\dir\\git.exe"],
    );
    expect(r).toEqual({ kind: "resolved", executable: "C:\\safe\\bin\\git.exe", source: "path" });
  });

  it("env names are case-insensitive (Path vs PATH)", () => {
    const r = win({ Path: "C:\\safe\\bin" }, ["C:\\safe\\bin\\git.exe"]);
    expect(r).toEqual({ kind: "resolved", executable: "C:\\safe\\bin\\git.exe", source: "path" });
  });

  it("nothing usable → no-git", () => {
    const r = win(
      { ProgramFiles: "C:\\Program Files", PATH: "D:\\x;.;rel" },
      [pf32, local],
    );
    // standard candidates checked: pf (missing) / pf32 hit? — pf32 lives
    // under ProgramFiles(x86), which is UNSET here → not checked.
    expect(r.kind).toBe("unavailable");
    expect(r.kind === "unavailable" && r.reason).toBe("no-git");
  });

  it("non-regular-file candidates are rejected (existsFile false)", () => {
    const r = win({ ProgramFiles: "C:\\Program Files" }, []);
    expect(r.kind).toBe("unavailable");
  });
});

describe("winIsAbsolute", () => {
  it.each([
    ["C:\\Git\\git.exe", true],
    ["c:/git/git.exe", true],
    ["\\\\server\\share\\git.exe", true],
    ["\\\\?\\C:\\git.exe", true],
    ["git.exe", false],
    [".\\git.exe", false],
    ["rel\\dir\\git.exe", false],
    ["\\Git\\git.exe", false], // rooted-but-relative — no drive/UNC anchor
    ["/usr/bin/git", false],
    ["", false],
  ])("%s → %s", (p, want) => {
    expect(winIsAbsolute(p)).toBe(want);
  });
});
