// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-31 local-file chat links: frozen MarkdownLinkTarget semantics —
// web vs existing-file vs missing, base-joined relatives, ~ expansion,
// file: URLs, the pseudo-scheme (Foo.ts:12) file-first rule, and the
// :line[:column] strip that only lands on an existing file.

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
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

const abs = (rel: string) => resolve(BASE, rel);
const home = (...rest: string[]) => resolve(homedir(), ...rest);

describe("resolveMarkdownLinkTarget (P2-31, frozen MarkdownLinkTarget)", () => {
  it("opens an existing relative file against the chat directory", () => {
    const stat = statWith([abs("out\\report.pdf")]);
    expect(resolveMarkdownLinkTarget("out/report.pdf", BASE, stat)).toEqual({
      kind: "file",
      path: abs("out\\report.pdf"),
    });
  });

  it("understands :line and :line:column only when the base file exists", () => {
    const stat = statWith([abs("src\\Foo.ts"), abs("src\\Has.txt")]);
    // Foo.ts exists -> the file opens, not the missing Foo.ts:12.
    expect(resolveMarkdownLinkTarget("src/Foo.ts:12", BASE, stat)).toEqual({
      kind: "file",
      path: abs("src\\Foo.ts"),
    });
    // :12:5 — the second strip lands on the real file.
    expect(resolveMarkdownLinkTarget("src/Foo.ts:12:5", BASE, stat)).toEqual({
      kind: "file",
      path: abs("src\\Foo.ts"),
    });
    // `Has.txt:12` exists literally? It does not — the strip still wins.
    expect(
      resolveMarkdownLinkTarget("src/Has.txt:12", BASE, statWith([abs("src\\Has.txt")])),
    ).toEqual({ kind: "file", path: abs("src\\Has.txt") });
  });

  it("does not strip a line suffix onto a directory or a missing file", () => {
    const stat = statWith([], [abs("src\\Dir")]);
    // `src/Dir:5` — the strip candidate is a directory: not a file open.
    expect(resolveMarkdownLinkTarget("src/Dir:5", BASE, stat)).toEqual({
      kind: "missing",
    });
    // `no/such.ts:9` — nothing exists at any strip level.
    expect(resolveMarkdownLinkTarget("no/such.ts:9", BASE, stat)).toEqual({
      kind: "missing",
    });
    // A real numeric file still wins its own literal path first.
    expect(
      resolveMarkdownLinkTarget(
        "src/Foo.ts:12",
        BASE,
        statWith([abs("src\\Foo.ts:12")]),
      ),
    ).toEqual({ kind: "file", path: abs("src\\Foo.ts:12") });
  });

  it("keeps web URLs web — a scheme with a host never reads as a path", () => {
    const stat = statWith([abs("https:")]);
    expect(resolveMarkdownLinkTarget("https://ex.com/a", BASE, stat)).toEqual({
      kind: "web",
      url: "https://ex.com/a",
    });
  });

  it("lets a pseudo-scheme local path win when the file exists", () => {
    // `Foo.ts:12` parses with scheme `foo.ts` and no host: frozen tries
    // the raw string as a file first.
    const stat = statWith([abs("Foo.ts")]);
    expect(resolveMarkdownLinkTarget("Foo.ts:12", BASE, stat)).toEqual({
      kind: "file",
      path: abs("Foo.ts"),
    });
    // Nothing named like it: the same shape falls back to web.
    expect(
      resolveMarkdownLinkTarget("other.ts:12", BASE, statWith([])),
    ).toEqual({ kind: "web", url: "other.ts:12" });
  });

  it("resolves file: URLs to local paths", () => {
    const f = "C:\\work\\proj\\a.txt";
    expect(
      resolveMarkdownLinkTarget("file:///C:/work/proj/a.txt", BASE, statWith([f])),
    ).toEqual({ kind: "file", path: f });
    // A UNC host maps to a share path.
    expect(
      resolveMarkdownLinkTarget(
        "file://nas/share/x.txt",
        BASE,
        statWith(["\\\\nas\\share\\x.txt"]),
      ),
    ).toEqual({ kind: "file", path: "\\\\nas\\share\\x.txt" });
    // A malformed percent-escape is a bad file URL — quiet beep, not a throw.
    expect(resolveMarkdownLinkTarget("file:///C:/work/%E0%A4%A", BASE, statWith([]))).toEqual({
      kind: "missing",
    });
  });

  it("treats drive-letter and UNC prefixes as paths, not schemes", () => {
    const f = "D:\\docs\\a.txt";
    expect(resolveMarkdownLinkTarget(f, BASE, statWith([f]))).toEqual({
      kind: "file",
      path: f,
    });
    const u = "\\\\nas\\share\\y.md";
    expect(resolveMarkdownLinkTarget(u, BASE, statWith([u]))).toEqual({
      kind: "file",
      path: u,
    });
    // A missing drive path is missing, not web.
    expect(
      resolveMarkdownLinkTarget("D:\\docs\\gone.txt", BASE, statWith([])),
    ).toEqual({ kind: "missing" });
  });

  it("expands ~ and refuses a relative path with no base", () => {
    const f = home("docs", "a.txt");
    expect(resolveMarkdownLinkTarget("~/docs/a.txt", BASE, statWith([f]))).toEqual(
      { kind: "file", path: f },
    );
    expect(
      resolveMarkdownLinkTarget("out/report.pdf", undefined, statWith([])),
    ).toEqual({ kind: "missing" });
  });

  it("opens an existing directory like a file (frozen fileExists)", () => {
    const d = abs("docs");
    expect(
      resolveMarkdownLinkTarget("docs", BASE, statWith([], [d])),
    ).toEqual({ kind: "file", path: d });
  });

  it("beeps on empty and whitespace-only input", () => {
    const stat = statWith([abs("a.txt")]);
    expect(resolveMarkdownLinkTarget("", BASE, stat)).toEqual({
      kind: "missing",
    });
    expect(resolveMarkdownLinkTarget("   ", BASE, stat)).toEqual({
      kind: "missing",
    });
  });
});
