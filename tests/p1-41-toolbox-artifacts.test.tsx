// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-41 Toolbox outputs: artifact classification, capture from chat/tool
// activity, newest-first ordering, bounded retention, win32/posix path
// resolution, opaque-id open/reveal resolution and the panel view.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactsService } from "../src/main/artifactsService";
import { requestValidators } from "../src/shared/ipc";
import {
  artifactKind,
  cleanArtifactPath,
  collectArtifactCandidates,
  extractArtifactPaths,
  resolveArtifacts,
  type ArtifactSourceMessage,
  type ThreadArtifactItem,
} from "../src/shared/threadArtifacts";
import { appendMention, ToolboxOutputs, type ToolboxState } from "../src/renderer/components/ToolboxPanel";
import { translate } from "../src/renderer/i18n";

const statFrom = (files: Record<string, number>) => (p: string) => files[p] ?? null;

describe("P1-41 artifact classification", () => {
  it("maps extensions to the four kinds and ignores the rest", () => {
    expect(artifactKind("report.MD")).toBe("document");
    expect(artifactKind("deck.pptx")).toBe("document");
    expect(artifactKind("site/index.html")).toBe("webpage");
    expect(artifactKind("chart.webp")).toBe("image");
    expect(artifactKind("demo.mkv")).toBe("video");
    expect(artifactKind("main.ts")).toBeNull();
    expect(artifactKind(".png")).toBeNull();
    expect(artifactKind("https://example.test/a.png")).toBeNull();
  });

  it("cleans file URLs, fragments and line suffixes", () => {
    expect(cleanArtifactPath("file:///C:/work/out%20put.pdf")).toBe("C:/work/out put.pdf");
    expect(cleanArtifactPath("file:///srv/work/a.png")).toBe("/srv/work/a.png");
    expect(cleanArtifactPath("<docs/a.md#intro>")).toBe("docs/a.md");
    expect(cleanArtifactPath("docs/a.md:12:4")).toBe("docs/a.md");
    expect(cleanArtifactPath("C:\\work\\a.md:3")).toBe("C:\\work\\a.md");
    expect(cleanArtifactPath("mailto:someone@example.test")).toBeNull();
  });

  it("extracts markdown links, backticks and bare paths from text", () => {
    const text =
      "Wrote [the report](out/report.pdf), `assets/logo.svg` and C:\\work\\clip.mp4; see https://example.test/x.png and main.ts.";
    expect(extractArtifactPaths(text)).toEqual(
      expect.arrayContaining(["out/report.pdf", "assets/logo.svg", "C:\\work\\clip.mp4"]),
    );
    expect(extractArtifactPaths(text).some((p) => p.includes("example.test"))).toBe(false);
    expect(extractArtifactPaths(text).some((p) => p.endsWith("main.ts"))).toBe(false);
  });
});

describe("P1-41 artifact capture order", () => {
  it("lists newest first from assistant text, plans, edit tools and touched paths", () => {
    const messages: ArtifactSourceMessage[] = [
      { role: "user", content: "make old.md", turnId: "t1" },
      { role: "assistant", content: "Created `old.md`.", turnId: "t1" },
      { role: "user", content: "and more", turnId: "t2" },
      { role: "system", kind: "tool", content: "", turnId: "t2", tool: { kind: "edit", title: "site/index.html" } },
      { role: "system", kind: "tool", content: "", turnId: "t2", tool: { kind: "command", title: "ls shot.png" } },
      { role: "system", kind: "plan", content: "1. write plan.md", turnId: "t2" },
    ];
    const touched = new Map([
      ["t2", ["notes.txt"]],
      ["t9", ["orphan.csv"]],
    ]);
    const raws = collectArtifactCandidates({ messages, touchedByTurn: touched });
    expect(raws.map((c) => c.raw)).toEqual(["plan.md", "notes.txt", "site/index.html", "old.md", "orphan.csv"]);
    expect(raws.map((c) => c.turnIndex)).toEqual([1, 1, 1, 0, 2]);
  });
});

describe("P1-41 artifact resolution (win32)", () => {
  const root = "C:\\Users\\dev\\proj";
  const home = "C:\\Users\\dev";
  it("resolves relative, forward-slash and file URL forms; folds case; drops excluded and missing", () => {
    const items = resolveArtifacts(
      [
        { raw: "out/report.pdf", turnIndex: 2 },
        { raw: "C:\\USERS\\DEV\\PROJ\\out\\REPORT.pdf" },
        { raw: "file:///C:/Users/dev/proj/site/index.html" },
        { raw: "node_modules/pkg/readme.md" },
        { raw: "missing.png" },
        { raw: "~\\Pictures\\shot.png" },
        { raw: "D:\\elsewhere\\clip.mp4" },
      ],
      {
        pathApi: win32,
        workingDirectory: root,
        home,
        statFile: statFrom({
          [win32.join(root, "out", "report.pdf")]: 2048,
          [win32.join(root, "site", "index.html")]: 0,
          [win32.join(root, "node_modules", "pkg", "readme.md")]: 10,
          [win32.join(home, "Pictures", "shot.png")]: 5,
          "D:\\elsewhere\\clip.mp4": 9,
        }),
      },
    );
    expect(items).toEqual([
      {
        path: "C:\\Users\\dev\\proj\\out\\report.pdf",
        name: "report.pdf",
        displayPath: "out\\report.pdf",
        mentionPath: "out/report.pdf",
        kind: "document",
        turnIndex: 2,
        size: 2048,
      },
      {
        path: "C:\\Users\\dev\\proj\\site\\index.html",
        name: "index.html",
        displayPath: "site\\index.html",
        mentionPath: "site/index.html",
        kind: "webpage",
      },
      { path: "C:\\Users\\dev\\Pictures\\shot.png", name: "shot.png", displayPath: "~\\Pictures\\shot.png", kind: "image", size: 5 },
      { path: "D:\\elsewhere\\clip.mp4", name: "clip.mp4", displayPath: "D:\\elsewhere\\clip.mp4", kind: "video", size: 9 },
    ]);
  });

  it("never resolves a relative path without a working directory", () => {
    const seen: string[] = [];
    const items = resolveArtifacts([{ raw: "a.md" }], {
      pathApi: win32,
      workingDirectory: null,
      home: null,
      statFile: (p) => (seen.push(p), 1),
    });
    expect(items).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("rejects UNC and file-url host paths before any filesystem check", () => {
    let checks = 0;
    const items = resolveArtifacts(
      [
        { raw: "\\\\server\\share\\report.pdf" },
        { raw: "//server/share/report.pdf" },
        { raw: "file://server/share/report.pdf" },
      ],
      {
        pathApi: win32,
        workingDirectory: root,
        home,
        statFile: () => (checks++, 1),
      },
    );
    expect(items).toEqual([]);
    expect(checks).toBe(0);
  });
});

describe("P1-41 artifact resolution (posix) and bounds", () => {
  it("keeps case-distinct paths and bounds rows and filesystem checks", () => {
    const root = "/srv/proj";
    const files: Record<string, number> = { "/srv/proj/A.md": 1, "/srv/proj/a.md": 1 };
    const opts = { pathApi: posix, workingDirectory: root, home: "/home/dev", statFile: statFrom(files) };
    expect(resolveArtifacts([{ raw: "A.md" }, { raw: "a.md" }, { raw: "./a.md" }], opts).map((i) => i.name)).toEqual([
      "A.md",
      "a.md",
    ]);
    const many = Array.from({ length: 50 }, (_, i) => ({ raw: `f${i}.md` }));
    for (let i = 0; i < 50; i++) files[`/srv/proj/f${i}.md`] = 1;
    expect(resolveArtifacts(many, { ...opts, limit: 10 })).toHaveLength(10);
    let checks = 0;
    const missing = Array.from({ length: 50 }, (_, i) => ({ raw: `gone${i}.png` }));
    resolveArtifacts(missing, { ...opts, statLimit: 7, statFile: () => (checks++, null) });
    expect(checks).toBe(7);
  });
});

describe("P1-41 ArtifactsService", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("hands out opaque ids resolvable only from the thread's latest listing", () => {
    dir = mkdtempSync(join(tmpdir(), "tivano-artifacts-"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "report.md"), "# synthetic");
    const svc = new ArtifactsService({ home: null });
    const sources = {
      directory: dir,
      messages: [{ role: "assistant" as const, content: "Wrote `out/report.md` and `out/missing.png`.", turnId: "t1" }],
      turns: [{ turnId: "t1", touchedPaths: ["out/report.md"] }],
    };
    const [item, ...rest] = svc.list("th1", sources);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ name: "report.md", mentionPath: "out/report.md", kind: "document", turnIndex: 0 });
    expect(JSON.stringify(item)).not.toContain(dir);
    expect(svc.resolve("th1", item!.id)).toBe(join(dir, "out", "report.md"));
    expect(svc.resolve("th2", item!.id)).toBeNull();
    const [again] = svc.list("th1", sources);
    expect(svc.resolve("th1", item!.id)).toBeNull();
    rmSync(join(dir, "out", "report.md"));
    expect(svc.resolve("th1", again!.id)).toBeNull();
  });

  it("validates the artifact channels", () => {
    const threadId = "00000000-0000-4000-8000-000000000001";
    expect(() => requestValidators["artifacts:list"]({ threadId })).not.toThrow();
    expect(() => requestValidators["artifacts:open"]({ threadId, id: "x" })).not.toThrow();
    expect(() => requestValidators["artifacts:open"]({ threadId, path: "C:\\x.md" })).toThrow();
    expect(() => requestValidators["artifacts:reveal"]({ threadId, id: "" })).toThrow();
  });
});

describe("P1-41 Toolbox panel view", () => {
  const items: ThreadArtifactItem[] = [
    { id: "a", name: "report.pdf", displayPath: "out\\report.pdf", mentionPath: "out/report.pdf", kind: "document", turnIndex: 0, size: 2048 },
    { id: "b", name: "clip.mp4", displayPath: "D:\\elsewhere\\clip.mp4", kind: "video" },
  ];
  const render = (state: ToolboxState, lang: "en" | "zh-Hans" = "en", filter: ThreadArtifactItem["kind"] | null = null) =>
    renderToStaticMarkup(
      createElement(ToolboxOutputs, {
        t: (k: string, ...v: string[]) => translate(lang, k, v),
        state,
        filter,
        revealLabel: translate(lang, "Reveal in File Explorer"),
        onFilter: () => {},
        onOpen: () => {},
        onReveal: () => {},
        onReference: () => {},
      }),
    );

  it("renders filters with counts, rows, and @ only for project files", () => {
    const html = render({ kind: "ready", items });
    expect(html).toContain("Documents <span class=\"toolbox-count\">1</span>");
    expect(html).toContain("All <span class=\"toolbox-count\">2</span>");
    expect(html).toContain("out\\report.pdf · Turn 1 · 2 KB");
    expect(html.match(/Reference in chat/g)).toHaveLength(2);
    expect(html.match(/Reveal in File Explorer/g)).toHaveLength(4);
    expect(html).not.toContain("Finder");
    expect(render({ kind: "ready", items }, "en", "image")).toContain("No outputs yet");
  });

  it("shows honest empty and error states in Simplified Chinese", () => {
    expect(render({ kind: "ready", items: [] }, "zh-Hans")).toContain("暂无产出物");
    const err = render({ kind: "error", message: "boom" }, "zh-Hans");
    expect(err).toContain("无法加载产出物");
    expect(err).toContain("boom");
    expect(render({ kind: "ready", items }, "zh-Hans")).toContain("第 1 轮");
  });

  it("appends an @ reference without disturbing the draft", () => {
    expect(appendMention("", "out/a.md")).toBe("@out/a.md ");
    expect(appendMention("look at", "out/a.md")).toBe("look at @out/a.md ");
    expect(appendMention("look at ", "out/a.md")).toBe("look at @out/a.md ");
  });
});
