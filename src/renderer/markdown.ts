// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Safe markdown subset renderer: produces React elements directly (never
// innerHTML), so every byte of source text is escaped by React itself. The
// only URLs that become real anchors are http/https; script schemes, file:
// paths, data: blobs and unknown syntax degrade to plain text.

import { createElement, type ReactNode } from "react";

function isSafeLink(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  // Reject control chars and any scheme that is not http/https.
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // No credentials, no backslash tricks, no whitespace in host.
  try {
    const u = new URL(trimmed);
    if (u.username || u.password) return false;
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "del"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "img"; alt: string; url: string };

function inlineTokens(text: string): Token[] {
  const tokens: Token[] = [];
  // img | link | `code` | **strong** | *em* | ~~del~~
  const re =
    /!\[([^\]]{0,200})\]\(([^)\s]{1,2048})\)|\[([^\]]{0,500})\]\(([^)\s]{1,2048})\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined && m[2] !== undefined) {
      tokens.push({ kind: "img", alt: m[1], url: m[2] });
    } else if (m[3] !== undefined && m[4] !== undefined) {
      tokens.push({ kind: "link", text: m[3], url: m[4] });
    } else if (m[5] !== undefined) {
      tokens.push({ kind: "code", text: m[5] });
    } else if (m[6] !== undefined) {
      tokens.push({ kind: "strong", text: m[6] });
    } else if (m[7] !== undefined) {
      tokens.push({ kind: "em", text: m[7] });
    } else if (m[8] !== undefined) {
      tokens.push({ kind: "del", text: m[8] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

/**
 * F03 (frozen StreamVeil): the freshly flushed tail of a still-streaming
 * block is wrapped in `.md-veil` spans that dissolve in once, paced by the
 * stream's own cadence (`ms`). `chars` counts trailing rendered characters;
 * a straddling text token splits, a straddling formatted token veils whole.
 * Cosmetic only — the source is untouched and settled text never animates.
 */
export interface StreamVeil {
  chars: number;
  ms: number;
}

function renderInline(
  text: string,
  keyBase: string,
  mend = false,
  veil?: StreamVeil | null,
): ReactNode[] {
  const tokens = inlineTokens(mend ? streamMend(text) : text);
  const cut =
    veil && veil.chars > 0
      ? Math.max(
          0,
          tokens.reduce((n, tok) => n + (tok.kind === "img" ? tok.alt.length : tok.text.length), 0) -
            veil.chars,
        )
      : -1;
  const veilStyle = { "--veil-d": `${veil?.ms ?? 240}ms` } as React.CSSProperties;
  let pos = 0;
  return tokens.map((t, i) => {
    const k = `${keyBase}-${i}`;
    const start = pos;
    pos += t.kind === "img" ? t.alt.length : t.text.length;
    const node = (() => {
      switch (t.kind) {
      case "text":
        return t.text;
      case "strong":
        return createElement("strong", { key: k }, t.text);
      case "em":
        return createElement("em", { key: k }, t.text);
      case "del":
        return createElement("del", { key: k }, t.text);
      case "code":
        return createElement("code", { key: k }, t.text);
      case "link":
        if (!isSafeLink(t.url)) return createElement("span", { key: k }, t.text);
        return createElement(
          "a",
          { key: k, href: t.url, rel: "noreferrer", "data-md-link": "1" },
          t.text,
        );
      case "img":
        // Same gate as links: only http/https ever becomes a fetch; file,
        // data and script schemes degrade to the alt text.
        if (!isSafeLink(t.url)) return createElement("span", { key: k }, t.alt);
        return createElement("img", {
          key: k,
          src: t.url,
          alt: t.alt,
          loading: "lazy",
          className: "md-img",
        });
      }
    })();
    if (cut < 0 || pos <= cut) return node;
    if (start >= cut || t.kind !== "text")
      return createElement("span", { key: k, className: "md-veil", style: veilStyle }, node);
    return [
      t.text.slice(0, cut - start),
      createElement(
        "span",
        { key: k, className: "md-veil", style: veilStyle },
        t.text.slice(cut - start),
      ),
    ];
  });
}

// Every line separator JS recognizes: \r\n, lone \r (classic Mac), \n and
// the Unicode line/paragraph separators. Splitting on all of them means no
// scanned "line" can ever contain a character `.` refuses to match, so a
// recognizer's test and its consumer regex can never disagree about
// whether a match reaches end-of-line.
const LINE_SPLIT = /\r\n|\r|\n|\u2028|\u2029/;

/**
 * F04 — port of frozen StreamMend.swift (display-only): closes the inline
 * markup a still-streaming paragraph has opened but not yet closed, so `**bold`
 * renders bold instead of leaking literal asterisks mid-flush. Once the reply
 * finishes the original text is parsed as written, so a marker that truly never
 * closes settles honestly. Paired on a stack, innermost first; half-written
 * closers complete; `2*3`, `snake_case`, escaped markers and whitespace-only
 * spans stay literal. Synthetic closers insert before trailing whitespace.
 */
export function streamMend(source: string): string {
  if (!/[*_~`]/.test(source)) return source;
  const chars = [...source];
  const ws = (c: string) => /\s/.test(c);
  const isAlphaNum = (c: string) => /[\p{L}\p{N}]/u.test(c);
  const run = (at: number): number => {
    let n = 0;
    while (at + n < chars.length && chars[at + n] === chars[at]) n++;
    return n;
  };
  // The display suffix belongs before whitespace, where emphasis can close.
  let end = chars.length;
  while (end > 0 && ws(chars[end - 1]!)) end--;
  let partial: { marker: string; missing: number } | undefined;
  let partialTicks = 0;
  const stack: { marker: string; length: number; contentStart: number }[] = [];
  let code: { ticks: number; contentStart: number } | undefined;
  let index = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    if (char === "\\" && !code) {
      index += 2;
      continue;
    }
    if (char === "`") {
      const n = run(index);
      if (code) {
        if (code.ticks === n) code = undefined;
        else if (n < code.ticks && index + n === end) partialTicks = n;
      } else {
        code = { ticks: n, contentStart: index + n };
      }
      index += n;
      continue;
    }
    if (code || (char !== "*" && char !== "_" && char !== "~")) {
      index += 1;
      continue;
    }
    const full = run(index);
    let rest = full;
    const before = index > 0 ? chars[index - 1] : undefined;
    const after = index + full < chars.length ? chars[index + full] : undefined;
    if (char === "~" && rest < 2 && stack[stack.length - 1]?.marker !== char) {
      index += full;
      continue;
    }
    if (before !== undefined && !ws(before)) {
      let top = stack[stack.length - 1];
      while (rest > 0 && top && top.marker === char && rest >= top.length) {
        stack.pop();
        rest -= top.length;
        top = stack[stack.length - 1];
      }
    }
    // Only an unescaped terminal run can be a half-written closer. Account
    // for markers already consumed by an inner span (e.g. `***a**`).
    const top = stack[stack.length - 1];
    if (
      rest > 0 &&
      top &&
      top.marker === char &&
      rest < top.length &&
      index + full === end &&
      before !== undefined &&
      !ws(before)
    ) {
      partial = { marker: char, missing: top.length - rest };
      stack.pop();
      rest = 0;
    }
    const opens =
      (after !== undefined && !ws(after)) && !(before !== undefined && isAlphaNum(before));
    if (rest > 0 && opens) {
      while (rest > 0) {
        if (char === "~" && rest < 2) break;
        const length = char === "~" ? 2 : Math.min(rest, 2);
        stack.push({ marker: char, length, contentStart: index + full });
        rest -= length;
      }
    }
    index += full;
  }

  // Closers go before any trailing whitespace: a closer after a space closes nothing.
  const hasContent = (start: number) =>
    start < end && chars.slice(start, end).some((c) => !ws(c));
  let closers = "";
  if (code) {
    if (!hasContent(code.contentStart)) return source;
    closers += "`".repeat(code.ticks - partialTicks);
  }
  if (partial) closers += partial.marker.repeat(partial.missing);
  for (const open of [...stack].reverse()) {
    if (hasContent(open.contentStart)) closers += open.marker.repeat(open.length);
  }
  if (!closers) return source;
  if (!code) {
    let slashStart = end;
    while (slashStart > 0 && chars[slashStart - 1] === "\\") slashStart--;
    // A dangling escape must not swallow the first synthetic closer.
    if ((end - slashStart) % 2 === 1) closers = "\\" + closers;
  }
  return chars.slice(0, end).join("") + closers + chars.slice(end).join("");
}

// Block-start recognizers. Each consumer below uses the exact same regex
// it is recognised by, and the paragraph gatherer only stops at a line one
// of these accepts — so any line no consumer takes (e.g. `` ```a`b ``,
// whose info string contains a backtick) is eaten as paragraph text.
const FENCE_OPEN = /^(`{3,})([^`]*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?/;
/** indent | marker | content — `-` `*` `+` or `1.`/`1)` ordered markers. */
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** Thematic break: 3+ of the SAME -, * or _ char, spaces allowed. */
const HR = /^\s{0,3}([*_\-])(?:\s*\1){2,}\s*$/;
/** Table delimiter row: `|---|---|`, `:--:`, `--:`… */
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const LANG_SAFE = /^[A-Za-z0-9_+.#-]{1,40}$/;

const MAX_LIST_ITEMS = 200;
const MAX_LIST_DEPTH = 6;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 20;
const MAX_CELL = 2000;

function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i]!.includes("|") &&
    TABLE_DELIM.test(lines[i + 1]!)
  );
}

function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    HR.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, i)
  );
}

/** Split a `| a | b |` row into trimmed cells. */
function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim().slice(0, MAX_CELL));
}

/** Delimiter-cell alignment: `:---:` center, `---:` right, else left. */
function tableAlign(cell: string): "left" | "center" | "right" {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

interface ListItem {
  ordered: boolean;
  num: number | null;
  /** Task-list state — frozen renders checkboxes. */
  task: "open" | "done" | null;
  text: string;
  children: ListItem[];
}

/** Gather one contiguous run of list items into an indent tree. */
function parseList(lines: string[], start: number): { items: ListItem[]; next: number } {
  const roots: ListItem[] = [];
  const stack: { indent: number; item: ListItem }[] = [];
  const base = lines[start]!.match(LIST_ITEM)!;
  const baseIndent = base[1]!.length;
  const baseOrdered = /\d/.test(base[2]![0]!);
  let count = 0;
  let i = start;
  while (i < lines.length && count < MAX_LIST_ITEMS) {
    const m = lines[i]!.match(LIST_ITEM);
    if (!m) break;
    const indent = m[1]!.length;
    const ordered = /\d/.test(m[2]![0]!);
    // Marker-kind change at the base level ends this list (CommonMark).
    if (indent === baseIndent && ordered !== baseOrdered) break;
    const num = ordered ? parseInt(m[2]!, 10) : null;
    let text = m[3]!;
    let task: ListItem["task"] = null;
    const tm = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (tm) {
      task = tm[1]!.toLowerCase() === "x" ? "done" : "open";
      text = tm[2]!;
    }
    const item: ListItem = { ordered, num, task, text, children: [] };
    count++;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (stack.length === 0) roots.push(item);
    else stack[stack.length - 1]!.item.children.push(item);
    // Depth cap: items deeper than MAX_LIST_DEPTH keep flattening onto
    // the cap-level parent instead of growing the stack.
    if (stack.length < MAX_LIST_DEPTH) stack.push({ indent, item });
    i++;
  }
  return { items: roots, next: i };
}

function renderList(
  items: ListItem[],
  keyBase: string,
  mend = false,
  veil?: StreamVeil | null,
): ReactNode {
  if (!items.length) return null;
  const ordered = items[0]!.ordered;
  const start = ordered && items[0]!.num !== null && items[0]!.num !== 1 ? items[0]!.num : undefined;
  const last = items.length - 1;
  const children = items.map((it, j) =>
    createElement(
      "li",
      { key: `${keyBase}-${j}`, className: it.task ? "md-task" : undefined },
      it.task
        ? createElement("input", {
            type: "checkbox",
            checked: it.task === "done",
            disabled: true,
            readOnly: true,
            className: "md-taskbox",
            "aria-hidden": true,
          })
        : null,
      renderInline(it.text, `${keyBase}-${j}`, mend, j === last && !it.children.length ? veil : null),
      it.children.length ? renderList(it.children, `${keyBase}-${j}`, mend, j === last ? veil : null) : null,
    ),
  );
  return createElement(
    ordered ? "ol" : "ul",
    start !== undefined ? { key: keyBase, start } : { key: keyBase },
    children,
  );
}

/** Render a markdown subset into React elements. */
export interface MarkdownLabels {
  /** Localized labels for the code-block copy button. */
  copy?: string;
  copied?: string;
  /**
   * F22: a fenced ```hydra(-sent|-leaving) delegation block renders as
   * the summoning card it stands for, never the JSON. The component
   * lives outside this pure pass so the parser stays dependency-free.
   */
  renderDelegation?: (body: string, sent: boolean) => ReactNode;
}

/**
 * @param streaming F04: true while the reply is still arriving — the last
 * block's inline text passes through `streamMend` so unclosed markup shows
 * styled instead of literal markers. Display-only; the source is untouched.
 */
export function renderMarkdown(
  source: string,
  labels?: MarkdownLabels,
  streaming = false,
  veil?: StreamVeil | null,
): ReactNode[] {
  const v = streaming ? (veil ?? null) : null;
  const lines = source.split(LINE_SPLIT);
  return renderBlocks(lines, 0, 0, labels, streaming, v).nodes;
}

/**
 * The block pass behind renderMarkdown. `lines[start..]` is walked
 * top-down; `keyBase` seeds element keys so a resumed parse keeps the key
 * each block would have had from the beginning. Returns the rendered nodes
 * and, for each, the line index where its block began — the data a
 * streaming caller needs to decide what may be reused (frozen
 * `blockLines`).
 */
function renderBlocks(
  lines: string[],
  start: number,
  keyBase: number,
  labels: MarkdownLabels | undefined,
  streaming: boolean,
  v: StreamVeil | null,
): { nodes: ReactNode[]; starts: number[] } {
  const out: ReactNode[] = [];
  const starts: number[] = [];
  let i = start;
  let block = keyBase;
  while (i < lines.length) {
    const before = i;
    const line = lines[i]!;
    const key = `b${block++}`;
    const push = (node: ReactNode): void => {
      starts.push(before);
      out.push(node);
    };

    // Fenced code block. The info string is everything after the opening
    // backtick run that is not itself a backtick; its first token becomes
    // the language class only after charset+length sanitization. A closing
    // fence needs at least as many backticks as the opener (CommonMark). An
    // unclosed fence — e.g. a still-streaming reply — just swallows the
    // rest of the input.
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const closeRe = new RegExp(`^\\s*\`{${fence[1]!.length},}\\s*$`);
      const info = fence[2]!.trim();
      const lang = info.split(/\s+/)[0] ?? "";
      const langSafe = LANG_SAFE.test(lang) ? lang : "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i]!)) buf.push(lines[i++]!);
      const closed = i < lines.length;
      if (closed) i++; // consume the closing fence, if any
      // F22: the delegation block is a summoning card, not a code block
      // (frozen HydraDelegationBlock). Plain ```hydra = streaming; the
      // -sent/-leaving info states mean the heads already went out.
      if (
        labels?.renderDelegation &&
        (langSafe === "hydra" || langSafe === "hydra-sent" || langSafe === "hydra-leaving")
      ) {
        push(
          createElement(
            "div",
            { key, className: "md-delegation" },
            labels.renderDelegation(buf.join("\n"), langSafe !== "hydra"),
          ),
        );
        continue;
      }
      // Frozen parity: a copy affordance on the block header. The actual
      // clipboard write is delegated to a document click handler (app.tsx)
      // so this renderer stays pure.
      push(
        createElement(
          "div",
          { key, className: "md-preblock" },
          createElement(
            "div",
            { className: "md-pre-head" },
            createElement("span", { className: "md-pre-lang" }, langSafe || "text"),
            createElement(
              "button",
              {
                type: "button",
                className: "md-copy",
                "data-md-copy": "1",
                "data-label-copy": labels?.copy ?? "Copy",
                "data-label-copied": labels?.copied ?? "Copied",
              },
              labels?.copy ?? "Copy",
            ),
          ),
          createElement(
            "pre",
            { className: "md-pre" },
            createElement(
              "code",
              langSafe ? { className: `md-lang-${langSafe}` } : {},
              (() => {
                const code = buf.join("\n");
                if (!closed && v && v.chars > 0 && v.chars < code.length)
                  return [
                    code.slice(0, code.length - v.chars),
                    createElement(
                      "span",
                      { className: "md-veil", style: { "--veil-d": `${v.ms}ms` } as React.CSSProperties },
                      code.slice(code.length - v.chars),
                    ),
                  ];
                return code;
              })(),
            ),
          ),
        ),
      );
      continue;
    }

    // Heading — recognised and consumed by the same HEADING regex.
    const h = line.match(HEADING);
    if (h) {
      const level = h[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const lastHead = streaming && i === lines.length - 1;
      push(
        createElement(`h${level}`, { key }, renderInline(h[2]!, key, lastHead, lastHead ? v : null)),
      );
      i++;
      continue;
    }

    // Thematic break — before lists so `- - -`/`***`/`___` break, not list.
    if (HR.test(line)) {
      push(createElement("hr", { key, className: "md-rule" }));
      i++;
      continue;
    }

    // Blockquote
    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      const mend = streaming && i === lines.length;
      push(
        createElement(
          "blockquote",
          { key },
          buf.map((b, j) =>
            createElement(
              "p",
              { key: `${key}-${j}` },
              renderInline(b, `${key}-${j}`, mend, mend && j === buf.length - 1 ? v : null),
            ),
          ),
        ),
      );
      continue;
    }

    // Ordered/unordered/task list — indent-nested, bounded.
    if (LIST_ITEM.test(line)) {
      const { items, next } = parseList(lines, i);
      const lastList = streaming && next === lines.length;
      push(renderList(items, key, lastList, lastList ? v : null));
      i = next;
      continue;
    }

    // Table — header row, delimiter row, then body rows.
    if (isTableStart(lines, i)) {
      const header = tableCells(lines[i]!).slice(0, MAX_TABLE_COLS);
      const aligns = tableCells(lines[i + 1]!)
        .slice(0, header.length)
        .map(tableAlign);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.includes("|") &&
        lines[i]!.trim() !== "" &&
        rows.length < MAX_TABLE_ROWS
      ) {
        const cells = tableCells(lines[i]!).slice(0, header.length);
        while (cells.length < header.length) cells.push("");
        rows.push(cells);
        i++;
      }
      const mend = streaming && i === lines.length;
      push(
        createElement(
          "table",
          { key, className: "md-table" },
          createElement(
            "thead",
            {},
            createElement(
              "tr",
              {},
              header.map((c, j) =>
                createElement(
                  "th",
                  { key: `${key}-h${j}`, className: `md-al-${aligns[j] ?? "left"}` },
                  renderInline(
                    c,
                    `${key}-h${j}`,
                    mend,
                    mend && rows.length === 0 && j === header.length - 1 ? v : null,
                  ),
                ),
              ),
            ),
          ),
          createElement(
            "tbody",
            {},
            rows.map((r, ri) =>
              createElement(
                "tr",
                { key: `${key}-r${ri}` },
                r.map((c, j) =>
                  createElement(
                    "td",
                    { key: `${key}-r${ri}c${j}`, className: `md-al-${aligns[j] ?? "left"}` },
                    renderInline(
                      c,
                      `${key}-r${ri}c${j}`,
                      mend,
                      mend && ri === rows.length - 1 && j === r.length - 1 ? v : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: gather until a blank line or a block-start line.
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines, i)) {
      buf.push(lines[i++]!);
    }
    const lastPara = streaming && i === lines.length;
    push(
      createElement("p", { key }, renderInline(buf.join("\n"), key, lastPara, lastPara ? v : null)),
    );

    // Forward-progress invariant: if no branch consumed input, emit the
    // line as plain paragraph text. Unreachable while recognizers and
    // consumers stay paired, but a parser must never be able to stall.
    if (i === before) {
      push(createElement("p", { key: `b${block++}` }, renderInline(line, `b${block}`)));
      i++;
    }
  }
  return { nodes: out, starts };
}

/**
 * Frozen `MarkdownParser.Parse`: a streamed parse remembers how much of it
 * survives the reply growing underneath. The parser decides each line from
 * that line and the next, so a block that starts at least two lines above
 * the end is final — the nodes before it are `stableNodes`, and a longer
 * text parses again from `restart`, the boundary block's own start line.
 */
export interface StreamingParse {
  /** Nodes of the stable prefix — the same element objects every chunk. */
  stableNodes: ReactNode[];
  /** Line index where the unstable tail begins; always a block start. */
  restart: number;
  /** UTF-16 offset in `source` where the `restart` line begins. The
   *  coordinator needs it to size the unstable tail without re-scanning. */
  restartChar: number;
  /** Line count the last parse covered. */
  lines: number;
  /** The source the last parse covered — reuse requires a pure append. */
  source: string;
}

/**
 * Frozen `MarkdownParser.parse(_:extending:)`: while a reply only appends,
 * its stable leading blocks are reused — identical element references, so
 * React bails out of reconciling them — and just the tail re-renders. The
 * per-chunk cost tracks the arriving text, not the whole message; whole
 * reparse was the measured cause of long-reply lag (P1-29 replay).
 *
 * `prev` comes from the previous call for the same message; pass null the
 * first time. Non-append edits or a shrinking source fall back to a full
 * parse.
 */
export function renderMarkdownStreaming(
  source: string,
  labels: MarkdownLabels | undefined,
  prev: StreamingParse | null,
  veil: StreamVeil | null,
): { nodes: ReactNode[]; state: StreamingParse } {
  const lines = source.split(LINE_SPLIT);
  // Frozen requires text.startsWith(previous.text): a pure append keeps
  // every earlier line frozen, so the stable prefix is still correct. A
  // replaced or rewritten text — Codex may re-send whole items — parses
  // from scratch.
  const resume = prev !== null && source.startsWith(prev.source);
  const stable = resume ? prev.stableNodes : [];
  const start = resume ? prev.restart : 0;
  const { nodes, starts } = renderBlocks(lines, start, stable.length, labels, true, veil);
  // The last block that begins at least two lines above the end marks
  // everything before it final (frozen `stable`); parsing resumes AT its
  // own start next time, so the boundary block itself renders again.
  let boundary = -1;
  for (let s = starts.length - 1; s >= 0; s--) {
    if (starts[s]! <= lines.length - 3) {
      boundary = s;
      break;
    }
  }
  // UTF-16 offset of the restart line, for the coordinator's tail-size
  // bound. LINE_SPLIT separators are 1-2 code units (\r\n counts two).
  const restartLine = boundary >= 0 ? starts[boundary]! : start;
  let restartChar = 0;
  if (restartLine > 0) {
    if (boundary < 0 && resume) {
      restartChar = prev!.restartChar;
    } else {
      for (let li = 0; li < restartLine; li++) {
        restartChar += lines[li]!.length;
        restartChar +=
          source.charCodeAt(restartChar) === 13 &&
          source.charCodeAt(restartChar + 1) === 10
            ? 2
            : 1;
      }
    }
  }
  const state: StreamingParse =
    boundary >= 0
      ? {
          stableNodes: [...stable, ...nodes.slice(0, boundary)],
          restart: starts[boundary]!,
          restartChar,
          lines: lines.length,
          source,
        }
      : { stableNodes: stable, restart: start, restartChar, lines: lines.length, source };
  return { nodes: [...stable, ...nodes], state };
}

/**
 * Frozen `StreamingParseCoordinator`: requests under this tail size parse
 * synchronously in the caller; a bigger unstable tail is deferred so the
 * render paints the last landed result while the new parse completes.
 * Upstream sizes the tail in UTF-8 bytes; UTF-16 code units is the same
 * order of bound and errs small for non-ASCII text.
 */
export const STREAM_SYNC_TAIL_CHARS = 4096;

interface StreamRequest {
  text: string;
  labels: MarkdownLabels | undefined;
  veil: StreamVeil | null;
}

/**
 * Per-message streaming-parse coordinator (frozen
 * `MarkdownView.StreamingParseCoordinator`). `parse` is called from render
 * like frozen's: an append whose unstable tail fits
 * `STREAM_SYNC_TAIL_CHARS` parses on the spot (~1 ms for typical flushes);
 * a larger tail schedules a deferred parse and keeps returning the last
 * landed nodes until it publishes. Non-appending text bumps the
 * generation and drops in-flight results, so a stale deferred parse can
 * never overwrite a newer request.
 *
 * The frozen coordinator defers onto `Task.detached`; this port defers
 * onto a scheduled task on the same thread — the observable contract
 * (stale paint while the big parse lands, newest request wins) is
 * identical, and the incremental parse stays bounded by the tail, not
 * the document. `schedule` is injectable for tests.
 */
export class StreamingMarkdownCoordinator {
  private requested: string | null = null;
  private result: {
    text: string;
    nodes: ReactNode[];
    state: StreamingParse;
  } | null = null;
  private pending: StreamRequest | null = null;
  private running = false;
  private disposed = false;
  private generation = 0;
  private readonly onLanded: () => void;
  private readonly schedule: (fn: () => void) => void;

  constructor(
    onLanded: () => void,
    schedule?: (fn: () => void) => void,
  ) {
    this.onLanded = onLanded;
    this.schedule = schedule ?? ((fn) => setTimeout(fn, 0));
  }

  /**
   * Request the nodes for `text`. Returns the latest landed nodes —
   * `null` until the first parse completes when the very first request
   * already exceeds the sync bound.
   */
  parse(
    text: string,
    labels: MarkdownLabels | undefined,
    veil: StreamVeil | null,
  ): ReactNode[] | null {
    if (this.disposed) return null;
    if (this.requested === text) return this.result?.nodes ?? null;
    if (this.requested !== null && !text.startsWith(this.requested)) {
      this.generation += 1;
      this.result = null;
    }
    this.requested = text;
    const tailChars = text.length - (this.result?.state.restartChar ?? 0);
    if (tailChars <= STREAM_SYNC_TAIL_CHARS) {
      this.pending = null;
      const r = renderMarkdownStreaming(
        text,
        labels,
        this.result?.state ?? null,
        veil,
      );
      this.result = { text, nodes: r.nodes, state: r.state };
    } else {
      this.pending = { text, labels, veil };
      this.startNext();
    }
    return this.result?.nodes ?? null;
  }

  /** Drop queued work; a scheduled parse in flight lands nowhere. */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
  }

  private startNext(): void {
    if (this.running || this.pending === null || this.disposed) return;
    const req = this.pending;
    this.pending = null;
    if (req.text === this.result?.text) return;
    this.running = true;
    const generation = this.generation;
    const prev = this.result?.state ?? null;
    this.schedule(() => {
      const r = renderMarkdownStreaming(req.text, req.labels, prev, req.veil);
      this.running = false;
      // Frozen: append-only streams may outpace parsing — publish only if
      // this is still the newest generation, the current request extends
      // the parsed text, and nothing newer already landed.
      if (
        !this.disposed &&
        this.generation === generation &&
        this.requested !== null &&
        this.requested.startsWith(req.text) &&
        (this.result === null || req.text.length > this.result.text.length)
      ) {
        this.result = { text: req.text, nodes: r.nodes, state: r.state };
        this.onLanded();
      }
      this.startNext();
    });
  }
}

/** Test helper: true when a URL would render as an anchor. */
export { isSafeLink };
