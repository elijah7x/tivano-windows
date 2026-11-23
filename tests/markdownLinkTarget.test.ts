// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-31 local-file chat links: frozen MarkdownLinkTarget semantics —
// web vs existing-file vs missing, base-joined relatives, ~ expansion,
// file: URLs, the pseudo-scheme (Foo.ts:12) file-first rule, and the
// :line[:column] strip that only lands on an existing file.

import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { win32 } from "node:path";
import {
  resolveMarkdownLinkTarget,
  type MarkdownLinkStat,
} from "../src/main/markdownLinkTarget";

const BASE = "C:\\work\\proj";

/** Map-backed stat: entries name files, `dir/` prefixes name dirs. */
function statWith(files: string[], dirs: string[] = []) {
  const fileSet = new Set(files.map((p) => p.toLowerCase()));
  const dirSet = new Set(dirs.map((p) => p.toLowerCase()));
  return (p: string): MarkdownLinkStat => {
    const k = p.toLowerCase();
    if (fileSet.has(k)) return "file";
    if (dirSet.has(k)) return "dir";
    return "none";
  };
}

// win32 semantics on every host — the app is a Windows app and the
// resolver's outputs are win32 paths (matches hydraNonGit's precedent).
// Production defaults to the host's node:path; the suite injects win32
// explicitly so it runs identically on any CI host.
const resolve = (
  href: string,
  base: string | undefined,
  stat: (p: string) => MarkdownLinkStat,
) => resolveMarkdownLinkTarget(href, base, stat, win32);
const abs = (rel: string) => win32.resolve(BASE, rel);
const home = (...rest: string[]) => win32.resolve(homedir(), ...rest);

describe("resolveMarkdownLinkTarget (P2-31, frozen MarkdownLinkTarget)", () => {
  it("opens an existing relative file against the chat directory", () => {
    const stat = statWith([abs("out\\report.pdf")]);
    expect(resolve("out/report.pdf", BASE, stat)).toEqual({
      kind: "file",
      path: abs("out\\report.pdf"),
    });
  });

  it("understands :line and :line:column only when the base file exists", () => {
    const stat = statWith([abs("src\\Foo.ts"), abs("src\\Has.txt")]);
    // Foo.ts exists -> the file opens, not the missing Foo.ts:12.
    expect(resolve("src/Foo.ts:12", BASE, stat)).toEqual({
      kind: "file",
      path: abs("src\\Foo.ts"),
    });
    // :12:5 — the second strip lands on the real file.
    expect(resolve("src/Foo.ts:12:5", BASE, stat)).toEqual({
      kind: "file",
      path: abs("src\\Foo.ts"),
    });
    // `Has.txt:12` exists literally? It does not — the strip still wins.
    expect(
      resolve("src/Has.txt:12", BASE, statWith([abs("src\\Has.txt")])),
    ).toEqual({ kind: "file", path: abs("src\\Has.txt") });
  });

  it("does not strip a line suffix onto a directory or a missing file", () => {
    const stat = statWith([], [abs("src\\Dir")]);
    // `src/Dir:5` — the strip candidate is a directory: not a file open.
    expect(resolve("src/Dir:5", BASE, stat)).toEqual({
      kind: "missing",
    });
    // `no/such.ts:9` — nothing exists at any strip level.
    expect(resolve("no/such.ts:9", BASE, stat)).toEqual({
      kind: "missing",
    });
    // A real numeric file still wins its own literal path first.
    expect(
      resolve(
        "src/Foo.ts:12",
        BASE,
        statWith([abs("src\\Foo.ts:12")]),
      ),
    ).toEqual({ kind: "file", path: abs("src\\Foo.ts:12") });
  });

  it("keeps web URLs web — a scheme with a host never reads as a path", () => {
    const stat = statWith([abs("https:")]);
    expect(resolve("https://ex.com/a", BASE, stat)).toEqual({
      kind: "web",
      url: "https://ex.com/a",
    });
  });

  it("lets a pseudo-scheme local path win when the file exists", () => {
    // `Foo.ts:12` parses with scheme `foo.ts` and no host: frozen tries
    // the raw string as a file first.
    const stat = statWith([abs("Foo.ts")]);
    expect(resolve("Foo.ts:12", BASE, stat)).toEqual({
      kind: "file",
      path: abs("Foo.ts"),
    });
    // Nothing named like it: the same shape falls back to web.
    expect(
      resolve("other.ts:12", BASE, statWith([])),
    ).toEqual({ kind: "web", url: "other.ts:12" });
  });

  it("resolves file: URLs to local paths", () => {
    const f = "C:\\work\\proj\\a.txt";
    expect(
      resolve("file:///C:/work/proj/a.txt", BASE, statWith([f])),
    ).toEqual({ kind: "file", path: f });
    // A UNC host maps to a share path — refused outright (missing),
    // never statted and never opened.
    expect(
      resolve(
        "file://nas/share/x.txt",
        BASE,
        statWith(["\\\\nas\\share\\x.txt"]),
      ),
    ).toEqual({ kind: "missing" });
    // A malformed percent-escape is a bad file URL — quiet beep, not a throw.
    expect(resolve("file:///C:/work/%E0%A4%A", BASE, statWith([]))).toEqual({
      kind: "missing",
    });
  });

  it("treats drive-letter and UNC prefixes as paths, not schemes", () => {
    const f = "D:\\docs\\a.txt";
    expect(resolve(f, BASE, statWith([f]))).toEqual({
      kind: "file",
      path: f,
    });
    const u = "\\\\nas\\share\\y.md";
    expect(resolve(u, BASE, statWith([u]))).toEqual({ kind: "missing" });
    // A missing drive path is missing, not web.
    expect(
      resolve("D:\\docs\\gone.txt", BASE, statWith([])),
    ).toEqual({ kind: "missing" });
  });

  it("device-namespace UNC spellings skip stat; drive forms still stat", () => {
    const stat = vi.fn((_p: string): MarkdownLinkStat => "none");
    // \\?\UNC\… and \\?\GLOBALROOT\… spell SMB paths in the device
    // namespace — refused like every other UNC form, unstatted.
    for (const p of [
      "\\\\?\\UNC\\nas\\share\\x.txt",
      "\\\\?\\GLOBALROOT\\Device\\Mup\\nas\\share\\x.txt",
    ]) {
      expect(resolve(p, BASE, stat)).toEqual({ kind: "missing" });
    }
    expect(stat).not.toHaveBeenCalled();
    // Drive-form device spellings stay local: they take the stat path
    // under their verbatim \\?\ name.
    const device = "\\\\?\\C:\\work\\proj\\a.txt";
    expect(
      resolve(device, BASE, statWith([device])),
    ).toEqual({ kind: "file", path: device });
  });

  it("expands ~ and refuses a relative path with no base", () => {
    const f = home("docs", "a.txt");
    expect(resolve("~/docs/a.txt", BASE, statWith([f]))).toEqual(
      { kind: "file", path: f },
    );
    expect(
      resolve("out/report.pdf", undefined, statWith([])),
    ).toEqual({ kind: "missing" });
  });

  it("opens an existing directory like a file (frozen fileExists)", () => {
    const d = abs("docs");
    expect(
      resolve("docs", BASE, statWith([], [d])),
    ).toEqual({ kind: "file", path: d });
  });

  it("refuses every UNC spelling — never statted, never opened", () => {
    // The gate's security finding: statSync on `\\host\…` would block
    // the main process on SMB, and shell.openPath on it leaks NTLM
    // credentials and can execute a remote share's files — every
    // network-shaped spelling resolves to a quiet missing beep.
    let statCalls = 0;
    const stat = (p: string): MarkdownLinkStat => {
      statCalls++;
      return "none";
    };
    for (const href of [
      "\\\\nas\\share\\y.md",
      "//nas/share/y.md",
      "file://nas/share/y.md",
      "\\\\nas\\share\\f.ts:10",
    ]) {
      statCalls = 0;
      expect(resolve(href, BASE, stat)).toEqual({ kind: "missing" });
      expect(statCalls, href).toBe(0);
    }
  });

  it("refuses executable and shortcut extensions even when the file exists", () => {
    // A disguised markdown link must never hand a launcher to
    // shell.openPath — every executable form beeps like a missing path.
    const stat = vi.fn((_p: string): MarkdownLinkStat => "file");
    for (const href of [
      abs("tools\\run.exe"),
      abs("tools\\do.BAT"),
      abs("tools\\pwn.scr"),
      abs("tools\\go.lnk"),
      abs("tools\\x.url"),
      abs("tools\\reg.reg"),
    ]) {
      expect(resolve(href, BASE, stat)).toEqual({ kind: "missing" });
    }
    expect(stat).not.toHaveBeenCalled();
    // A `run.exe:12` strip target is refused the same way.
    const stat2 = statWith([abs("tools\\run.exe")]);
    expect(resolve("tools/run.exe:12", BASE, stat2)).toEqual({ kind: "missing" });
    // Ordinary files and directories still open.
    const doc = abs("docs\\a.txt");
    expect(resolve("docs/a.txt", BASE, statWith([doc]))).toEqual({
      kind: "file",
      path: doc,
    });
  });

  it("resolves a driveless rooted path on the BASE's drive", () => {
    // `\x`/`/x` count as absolute on win32 — without the base anchor
    // they would resolve against the process cwd's drive. The base
    // lends its DRIVE root: `\docs` means `<drive>:\docs`, not
    // `<base>\docs`.
    const f = "C:\\docs\\a.txt";
    expect(resolve("\\docs\\a.txt", "C:\\work\\proj", statWith([f]))).toEqual({
      kind: "file",
      path: f,
    });
    const g = "D:\\docs\\b.txt";
    expect(resolve("\\docs\\b.txt", "D:\\work\\proj", statWith([g]))).toEqual({
      kind: "file",
      path: g,
    });
    // No base → no drive to anchor on: missing, not cwd.
    expect(resolve("\\docs\\a.txt", undefined, statWith([]))).toEqual({
      kind: "missing",
    });
  });

  it("still stats the local device namespace (\\\\?\\ and \\\\.\\)", () => {
    const f = "\\\\?\\C:\\work\\proj\\dev.txt";
    expect(resolve(f, BASE, statWith([f]))).toEqual({
      kind: "file",
      path: f,
    });
  });

  it("beeps on empty and whitespace-only input", () => {
    const stat = statWith([abs("a.txt")]);
    expect(resolve("", BASE, stat)).toEqual({
      kind: "missing",
    });
    expect(resolve("   ", BASE, stat)).toEqual({
      kind: "missing",
    });
  });
});
