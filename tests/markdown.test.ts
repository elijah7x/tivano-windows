// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Safe content rendering: the markdown subset can never emit scriptable
// markup, dangerous link schemes or unescaped HTML — React escapes all text
// and only http/https anchors are created.
//
// EVERY parse in this file runs inside node:vm with a hard execution
// timeout: a parser hang is a synchronous infinite loop that neither
// vitest's async test timeout nor jest-style fake timers can interrupt —
// it would freeze the whole worker before any later test ran.

import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import * as React from "react";
import { isSafeLink } from "../src/renderer/markdown";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Bundle the parser once and give the VM the REAL react module — elements
// created inside the sandbox are genuine React elements outside it.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundled = buildSync({
  entryPoints: [join(root, "src/renderer/markdown.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["react"],
  write: false,
}).outputFiles[0]!.text;

const sandbox = {
  module: { exports: {} as Record<string, unknown> },
  exports: {},
  URL, // URL is a Node/Web global — absent from a bare vm realm by default
  require: (name: string) => {
    if (name === "react") return React;
    throw new Error(`unexpected require ${name}`);
  },
};
runInNewContext(bundled, sandbox, { timeout: 2000 });
const renderFn = sandbox.module.exports.renderMarkdown as (s: string) => ReactNode[];
expect(typeof renderFn).toBe("function");

/** Parse under a hard VM timeout — any stall aborts at 500ms, not forever. */
function md(source: string): ReactNode[] {
  return runInNewContext("renderMarkdown(input)", {
    renderMarkdown: renderFn,
    input: source,
  }, { timeout: 500 }) as ReactNode[];
}

interface Found {
  types: string[];
  hrefs: (string | null)[];
  classes: (string | undefined)[];
  text: string;
}

function walk(
  node: ReactNode,
  acc: Found = { types: [], hrefs: [], classes: [], text: "" },
): Found {
  if (node == null || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.text += String(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, acc);
    return acc;
  }
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    const t = typeof el.type === "string" ? el.type : "component";
    acc.types.push(t);
    if (t === "a") acc.hrefs.push((el.props.href as string) ?? null);
    if (el.props.className !== undefined) acc.classes.push(el.props.className as string);
    walk(el.props.children as ReactNode, acc);
  }
  return acc;
}

describe("safe markdown rendering", () => {
  it("renders the supported subset", () => {
    const found = walk(md("# Title\n\npara **bold** *em* `code`\n\n- a\n- b\n\n> quote\n\n```ts\nx=1\n```"));
    for (const t of ["h1", "p", "strong", "em", "code", "ul", "li", "blockquote", "pre"])
      expect(found.types).toContain(t);
    expect(found.text).toContain("Title");
    expect(found.text).toContain("x=1");
  });

  it("never emits script/iframe/object elements from hostile input", () => {
    const hostile = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src='https://evil'></iframe>",
      "**<svg onload=alert(1)>**",
      "`onclick=alert(1)`",
    ];
    for (const h of hostile) {
      const found = walk(md(h));
      expect(found.types).not.toContain("script");
      expect(found.types).not.toContain("iframe");
      expect(found.types).not.toContain("object");
      expect(found.types).not.toContain("img");
      // Raw markup arrives as inert text only (React escapes it).
      if (h.includes("<")) expect(found.text).toContain("<");
    }
  });

  it("renders only http/https links as anchors", () => {
    const cases: Array<[string, boolean]> = [
      ["[ok](https://example.com/x?y=1)", true],
      ["[ok](http://example.com)", true],
      ["[js](javascript:alert(1))", false],
      ["[file](file:///etc/passwd)", false],
      ["[data](data:text/html,hi)", false],
      ["[rel](/etc/passwd)", false],
      ["[unc](\\\\host\\share)", false],
      ["[win](C:\\Windows\\system32)", false],
      ["[ftp](ftp://host/x)", false],
    ];
    for (const [source, anchored] of cases) {
      const found = walk(md(source));
      if (anchored) {
        expect(found.hrefs.length, source).toBe(1);
        expect(found.hrefs[0]).toMatch(/^https?:\/\//);
      } else {
        expect(found.hrefs.length, source).toBe(0);
      }
    }
  });

  it("drops credential-bearing URLs", () => {
    expect(isSafeLink("https://user:pw@example.com")).toBe(false);
    expect(isSafeLink("https://example.com")).toBe(true);
  });
});

describe("fenced code blocks", () => {
  it("accepts non-word info strings and long languages", () => {
    const cpp = walk(md("```c++\nint x = 0;\n```"));
    expect(cpp.types).toContain("pre");
    expect(cpp.text).toContain("int x = 0;");
    expect(cpp.classes).toContain("md-lang-c++");

    const csharp = walk(md("```c#\nvar x = 1;\n```"));
    expect(csharp.types).toContain("pre");
    expect(csharp.classes).toContain("md-lang-c#");

    const long = walk(
      md("```averyverylonglanguagenamethatstillexceedsthelimit\nx\n```"),
    );
    expect(long.types).toContain("pre");
    expect(long.text).toContain("x");
    // Over-length language is sanitized away, never part of a class name.
    expect(long.classes.some((c) => c?.startsWith("md-lang-"))).toBe(false);
  });

  it("requires a closing fence at least as long as the opener", () => {
    const found = walk(md("````\n``` inside\nmore\n````"));
    expect(found.types).toContain("pre");
    expect(found.text).toContain("``` inside");
    expect(found.text).toContain("more");
    // The inner ``` did NOT terminate the four-backtick block.
    expect(found.types.filter((t) => t === "pre")).toHaveLength(1);
  });

  it("treats an unclosed (still streaming) fence as a block", () => {
    const found = walk(md("```ts\npartial code\nstill typing"));
    expect(found.types).toContain("pre");
    expect(found.text).toContain("partial code");
    expect(found.text).toContain("still typing");
  });

  it("renders a backtick-bearing opener as inert paragraph text", () => {
    const found = walk(md("```a`b\nnext"));
    expect(found.types).not.toContain("pre");
    // `` ```a`b `` parses as text + inline-code + text — it terminates and
    // never becomes a fence, exactly like CommonMark.
    expect(found.text).toContain("``ab");
    expect(found.text).toContain("next");
  });

  it("keeps fence contents inert text (React escapes everything)", () => {
    const found = walk(md("```html\n<script>alert(1)</script>\n```"));
    expect(found.types).not.toContain("script");
    expect(found.text).toContain("<script>");
  });
});

describe("line separators and termination", () => {
  it("splits on bare CR and renders heading + paragraph", () => {
    const found = walk(md("# a\rb"));
    expect(found.types).toContain("h1");
    expect(found.text).toContain("a");
    expect(found.text).toContain("b");
  });

  it("splits on Unicode line/paragraph separators", () => {
    for (const sep of ["\u2028", "\u2029"]) {
      const found = walk(md(`# a${sep}b`));
      expect(found.types).toContain("h1");
      expect(found.text).toContain("a");
      expect(found.text).toContain("b");
    }
  });

  it("mixed separators in one document terminate", () => {
    const found = walk(md("# one\rtwo\nthree\u2028four\u2029five\r\nsix"));
    expect(found.types).toContain("h1");
    for (const word of ["one", "two", "three", "four", "five", "six"])
      expect(found.text).toContain(word);
  });

  // A hanging parser is a sync infinite loop — the VM timeout above is the
  // only thing that can interrupt it, so even these "just parse" cases go
  // through md(), never through renderMarkdown directly.
  const cases = [
    "```c++\nx\n```",
    "```c#\nx\n```",
    "```averyverylonglanguagenamethatstillexceedsthelimit\nx",
    "```ts\nunclosed stream",
    "```a`b",
    "````\n```\n````",
    "```",
    "```\n",
    "x\n```\ny",
    "```\x00\xff\n\u{1f4a9}\n```",
    "``` \t\n x",
    "# a\rb",
    "# a\u2028b",
    "# a\u2029b",
    "#\r# x",
    "```c++\r```",
    "- a\r- b",
    "> q\r> r",
    "# nospace#\r\n\tx\u2028",
  ];

  it.each(cases)("always terminates: %#", (input) => {
    const out = md(input);
    expect(out).toBeDefined();
  });
});

describe("extended blocks (F04)", () => {
  it("renders ordered lists with a non-1 start", () => {
    const found = walk(md("3. three\n4. four"));
    expect(found.types).toContain("ol");
    expect(found.text).toContain("three");
    expect(found.text).toContain("four");
  });

  it("nests deeper-indented items inside their parent", () => {
    const found = walk(md("- a\n  - a1\n  - a2\n- b"));
    const uls = found.types.filter((t) => t === "ul");
    expect(uls.length).toBe(2);
    for (const w of ["a", "a1", "a2", "b"]) expect(found.text).toContain(w);
  });

  it("renders task items as disabled checkboxes", () => {
    const found = walk(md("- [ ] todo\n- [x] done"));
    const boxes = found.classes.filter((c) => c === "md-taskbox");
    expect(boxes.length).toBe(2);
    expect(found.text).toContain("todo");
    expect(found.text).toContain("done");
  });

  it("renders a table with alignment classes", () => {
    const found = walk(md("| l | c | r |\n|:--|:-:|--:|\n| a | b | d |"));
    for (const t of ["table", "thead", "tbody", "tr", "th", "td"])
      expect(found.types).toContain(t);
    expect(found.classes).toContain("md-al-center");
    expect(found.classes).toContain("md-al-right");
    expect(found.text).toContain("a");
  });

  it("renders horizontal rules for all three markers", () => {
    for (const src of ["---", "***", "___", "- - -"]) {
      const found = walk(md(`a\n${src}\nb`));
      expect(found.types, src).toContain("hr");
    }
  });

  it("a plain - item is a list, not a rule", () => {
    const found = walk(md("- item"));
    expect(found.types).toContain("ul");
    expect(found.types).not.toContain("hr");
  });

  it("renders strikethrough as del", () => {
    const found = walk(md("a ~~gone~~ b"));
    expect(found.types).toContain("del");
    expect(found.text).toContain("gone");
  });

  it("renders http/https images only — unsafe sources degrade to alt text", () => {
    const good = walk(md("![cat](https://example.com/c.png)"));
    expect(good.types).toContain("img");
    for (const bad of [
      "![x](file:///etc/passwd)",
      "![x](data:text/html,hi)",
      "![x](javascript:alert(1))",
      "![x](/local/path.png)",
    ]) {
      const found = walk(md(bad));
      expect(found.types, bad).not.toContain("img");
      expect(found.text, bad).toContain("x");
    }
  });

  it("never emits scriptable elements from tables or images", () => {
    const found = walk(md("| <script>alert(1)</script> |\n|--|\n| ![x](javascript:alert(1)) |"));
    expect(found.types).not.toContain("script");
    expect(found.types).not.toContain("img");
    expect(found.text).toContain("<script>");
  });

  it("bounds: a 300-item list stays linear and still renders", () => {
    const src = Array.from({ length: 300 }, (_, i) => `- item ${i}`).join("\n");
    const found = walk(md(src));
    expect(found.text).toContain("item 0");
    expect(found.text).toContain("item 299");
  });
});

it("marker-kind change at the base level starts a new list", () => {
  const found = walk(md("1. one\n- two"));
  expect(found.types).toContain("ol");
  expect(found.types).toContain("ul");
});

it("code fences emit a preblock head with lang label and copy button", () => {
  const found = walk(md("```ts\nx=1\n```"));
  expect(found.classes).toContain("md-preblock");
  expect(found.classes).toContain("md-pre-head");
  expect(found.classes).toContain("md-copy");
  expect(found.types).toContain("pre");
});

it("a hydra fence degrades to a code block without the injected renderer", () => {
  const found = walk(md("```hydra\n[{\"task\":\"x\",\"prompt\":\"y\"}]\n```"));
  expect(found.classes).toContain("md-preblock");
  expect(found.classes).not.toContain("md-delegation");
});

it("a hydra fence becomes the delegation card when the renderer is injected", () => {
  const out = runInNewContext(
    "renderMarkdown(input, { renderDelegation: (body, sent) => React.createElement('div', { className: 'fake-card', 'data-sent': sent }, body) })",
    {
      renderMarkdown: renderFn,
      input: "```hydra-sent\n[{\"task\":\"x\",\"prompt\":\"y\"}]\n```",
      React,
    },
    { timeout: 500 },
  ) as ReactNode[];
  const found = walk(out);
  expect(found.classes).toContain("md-delegation");
  expect(found.classes).toContain("fake-card");
  expect(found.classes).not.toContain("md-preblock");
});
