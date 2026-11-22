// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// StreamingMarkdownCoordinator (frozen StreamingParseCoordinator): tails
// within the sync bound parse during the call; bigger tails defer and
// the caller keeps painting the last landed result until it publishes.

import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import * as React from "react";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  URL,
  require: (name: string) => {
    if (name === "react") return React;
    throw new Error(`unexpected require ${name}`);
  },
};
runInNewContext(bundled, sandbox, { timeout: 2000 });

interface Coordinator {
  parse(
    text: string,
    labels: undefined,
    veil: null,
  ): ReactNode[] | null;
  dispose(): void;
}
const Coordinator = sandbox.module.exports.StreamingMarkdownCoordinator as new (
  onLanded: () => void,
  schedule?: (fn: () => void) => void,
) => Coordinator;
const SYNC_BOUND = (
  sandbox.module.exports.STREAM_SYNC_TAIL_CHARS as number
);
expect(typeof Coordinator).toBe("function");
expect(SYNC_BOUND).toBe(4096);

/** A manual scheduler: deferred parses sit in `queue` until flushed. */
function manualQueue() {
  const queue: Array<() => void> = [];
  return {
    queue,
    schedule: (fn: () => void) => queue.push(fn),
    flush: () => {
      while (queue.length) queue.shift()!();
    },
  };
}

function walkText(node: ReactNode, acc = ""): string {
  if (node == null || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number")
    return acc + String(node);
  if (Array.isArray(node))
    return node.reduce((a, n) => walkText(n, a), acc);
  if (typeof node === "object" && "props" in node) {
    const p = (node as { props: { children?: ReactNode } }).props;
    return walkText(p.children, acc);
  }
  return acc;
}

describe("StreamingMarkdownCoordinator (frozen sync/deferred split)", () => {
  it("parses tails within the sync bound during the call", () => {
    const mq = manualQueue();
    const c = new Coordinator(() => {}, mq.schedule);
    const nodes = c.parse("# hi\n\nfirst para", undefined, null);
    expect(mq.queue.length).toBe(0); // nothing deferred
    expect(walkText(nodes)).toContain("first para");
    // Growing within the bound stays synchronous and reuses the result.
    const again = c.parse("# hi\n\nfirst para\n\nsecond", undefined, null);
    expect(mq.queue.length).toBe(0);
    expect(walkText(again)).toContain("second");
  });

  it("defers a tail past the bound and keeps painting the last result", () => {
    const mq = manualQueue();
    const c = new Coordinator(() => {}, mq.schedule);
    const base = "# t\n\n" + "seed paragraph\n\n";
    c.parse(base, undefined, null);
    // A huge unclosed code fence: everything below the last final block
    // is unstable tail, far over the 4096-code-unit bound.
    const big = base + "```ts\n" + "const x = 1;\n".repeat(4000);
    const during = c.parse(big, undefined, null);
    expect(mq.queue.length).toBe(1); // deferred, not parsed in the call
    expect(walkText(during)).toContain("seed paragraph");
    expect(walkText(during)).not.toContain("const x");
    mq.flush();
    const after = c.parse(big, undefined, null); // landed → returns it
    expect(walkText(after)).toContain("const x = 1;");
  });

  it("drops a deferred result when newer text replaced the request", () => {
    const mq = manualQueue();
    let landed = 0;
    const c = new Coordinator(() => landed++, mq.schedule);
    const bigTail = "```\n" + "y\n".repeat(6000);
    c.parse("a\n\n" + bigTail, undefined, null);
    expect(mq.queue.length).toBe(1);
    // A non-append rewrite bumps the generation before the parse lands.
    c.parse("completely different text\n\n" + bigTail, undefined, null);
    mq.flush();
    // Exactly one publish: the stale-generation parse is dropped, the
    // rewrite's own deferred parse lands instead.
    expect(landed).toBe(1);
    const nodes = c.parse("completely different text\n\n" + bigTail + "tail", undefined, null);
    expect(walkText(nodes)).toContain("completely different");
  });

  it("keeps the newest request when requests outpace the deferred parse", () => {
    const mq = manualQueue();
    const c = new Coordinator(() => {}, mq.schedule);
    const fence = "```\n" + "line\n".repeat(5000);
    c.parse("x\n\n" + fence, undefined, null);
    // While the first deferred parse is queued, a newer request replaces
    // pending: only the newest should parse when the queue drains.
    c.parse("x\n\n" + fence + "more\n", undefined, null);
    expect(mq.queue.length).toBe(1);
    mq.flush();
    const nodes = c.parse("x\n\n" + fence + "more\n", undefined, null);
    expect(walkText(nodes)).toContain("more");
  });

  it("dispose stops a queued deferred parse from publishing", () => {
    const mq = manualQueue();
    let landed = 0;
    const c = new Coordinator(() => landed++, mq.schedule);
    c.parse("z\n\n```\n" + "w\n".repeat(6000), undefined, null);
    c.dispose();
    mq.flush();
    expect(landed).toBe(0);
    expect(c.parse("z", undefined, null)).toBe(null);
  });
});
