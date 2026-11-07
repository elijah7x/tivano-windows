// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F04 reply quotes: the frozen ReplyQuote.peel read-back,
// ComposerDraft.outgoingText serialization, lastCodeBlock scan and
// quote excerpt — plus the clientStore draft-quote lifecycle.

import { describe, expect, it } from "vitest";
import {
  peelQuotes,
  serializeOutgoing,
  lastCodeBlock,
  quoteExcerpt,
  makeQuote,
} from "../src/shared/replyQuote";
import { ClientStore } from "../src/renderer/client";

const q = (text: string) => makeQuote(text);

describe("peelQuotes (frozen ReplyQuote.peel)", () => {
  it("a message with no leading quote comes back whole", () => {
    const r = peelQuotes("plain words\n> mid-quote stays body");
    expect(r.quotes).toHaveLength(0);
    expect(r.body).toBe("plain words\n> mid-quote stays body");
  });
  it("one leading block peels into a quote and the rest is the body", () => {
    const r = peelQuotes("> earlier words\n> more of it\n\nmy reply");
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]!.text).toBe("earlier words\nmore of it");
    expect(r.body).toBe("my reply");
  });
  it("two blocks separated by one blank line are two quotes", () => {
    const r = peelQuotes("> first\n\n> second\n\nthe words");
    expect(r.quotes.map((x) => x.text)).toEqual(["first", "second"]);
    expect(r.body).toBe("the words");
  });
  it("two blank lines end the quote run", () => {
    const r = peelQuotes("> q\n\n\nbody");
    expect(r.quotes).toHaveLength(1);
    expect(r.body).toBe("body");
  });
  it("a bare > keeps its emptiness; >  collapses the space", () => {
    const r = peelQuotes(">\n>  spaced\n\nb");
    expect(r.quotes[0]!.text).toBe("\n spaced");
    expect(r.body).toBe("b");
  });
  it("a leading /command separated by a blank line stays with the words", () => {
    const r = peelQuotes("/compact\n\n> quoted\n\nbody");
    expect(r.quotes.map((x) => x.text)).toEqual(["quoted"]);
    expect(r.body).toBe("/compact body");
  });
  it("a /command alone with an empty body comes back as the command", () => {
    const r = peelQuotes("/plan\n\n> q");
    expect(r.quotes).toHaveLength(1);
    expect(r.body).toBe("/plan");
  });
  it("a first-line /word without the quote pattern is no command", () => {
    const r = peelQuotes("/plan something\n> not a quote");
    expect(r.quotes).toHaveLength(0);
    expect(r.body).toBe("/plan something\n> not a quote");
  });
});

describe("serializeOutgoing (frozen ComposerDraft.outgoingText)", () => {
  it("no quotes, no command: the typed words", () => {
    expect(serializeOutgoing([], "hello")).toBe("hello");
  });
  it("quotes lead as blockquote lines ahead of the words", () => {
    expect(serializeOutgoing([q("earlier\nlines")], "my reply")).toBe(
      "> earlier\n> lines\n\nmy reply",
    );
  });
  it("two quotes are blank-line separated", () => {
    expect(serializeOutgoing([q("a"), q("b")], "t")).toBe("> a\n\n> b\n\nt");
  });
  it("an empty quote line serializes as a bare >", () => {
    expect(serializeOutgoing([q("a\n\nb")], "t")).toBe("> a\n>\n> b\n\nt");
  });
  it("command alone, command + words, command + quotes", () => {
    const c = { name: "plan" };
    expect(serializeOutgoing([], "  ", c)).toBe("/plan");
    expect(serializeOutgoing([], "do it", c)).toBe("/plan do it");
    expect(serializeOutgoing([q("q")], "do it", c)).toBe("/plan\n\n> q\n\ndo it");
  });
  it("serialize → peel is a round trip", () => {
    const text = serializeOutgoing([q("first quote"), q("second\nquote")], "the words");
    const r = peelQuotes(text);
    expect(r.quotes.map((x) => x.text)).toEqual(["first quote", "second\nquote"]);
    expect(r.body).toBe("the words");
  });
  it("serialize with command → peel keeps the command in the body", () => {
    const r = peelQuotes(serializeOutgoing([q("q")], "words", { name: "compact" }));
    expect(r.quotes.map((x) => x.text)).toEqual(["q"]);
    expect(r.body).toBe("/compact words");
  });
});

describe("lastCodeBlock (frozen scan)", () => {
  it("no fence → null", () => {
    expect(lastCodeBlock("just words")).toBeNull();
  });
  it("the last closed fence wins", () => {
    const t = "```\nfirst\n```\nmiddle\n```ts\nsecond\nmore\n```";
    expect(lastCodeBlock(t)).toBe("second\nmore");
  });
  it("an unclosed fence contributes nothing", () => {
    expect(lastCodeBlock("```\nnever closed")).toBeNull();
    expect(lastCodeBlock("```\nclosed\n```\n```\nopen")).toBe("closed");
  });
});

describe("quoteExcerpt (frozen ReplyQuote.excerpt)", () => {
  it("first non-empty line, whitespace collapsed", () => {
    expect(quoteExcerpt("\n\n  spaced   out \nsecond")).toBe("spaced out");
    expect(quoteExcerpt("")).toBe("");
  });
  it("collapses past 72 chars with an ellipsis", () => {
    const long = "word ".repeat(20).trim();
    const x = quoteExcerpt(long);
    expect(x.endsWith("…")).toBe(true);
    expect(x.length).toBe(73);
  });
});

describe("clientStore draft quotes", () => {
  const store = () =>
    new ClientStore(async () => {
      throw new Error("no invokes expected");
    });

  it("add → dedupe → remove → serialize", async () => {
    const s = store();
    s.addDraftQuote("t1", "quoted words");
    s.addDraftQuote("t1", "quoted words");
    s.addDraftQuote("t1", "another");
    expect(s.draftQuotes("t1").map((x) => x.text)).toEqual([
      "quoted words",
      "another",
    ]);
    s.setDraft("t1", "the reply");
    expect(s.draftQuotes("t1")).toHaveLength(2);
    const first = s.draftQuotes("t1")[0]!;
    s.removeDraftQuote("t1", first.id);
    expect(s.draftQuotes("t1").map((x) => x.text)).toEqual(["another"]);
  });

  it("quotes survive the command and attachment mutations", () => {
    const s = store();
    s.addDraftQuote("t1", "keep me");
    s.setDraftCommand("t1", { name: "plan", detail: "d", isBuiltIn: true });
    expect(s.draftQuotes("t1")).toHaveLength(1);
    s.setDraftCommand("t1", undefined);
    expect(s.draftQuotes("t1")).toHaveLength(1);
    s.setDraft("t1", "typed");
    expect(s.draftQuotes("t1")).toHaveLength(1);
  });

  it("quotes alone make a sendable draft via outgoingText", async () => {
    const sent: { text: string }[] = [];
    const s = new ClientStore(async (_ch, payload) => {
      sent.push(payload as { text: string });
      return {};
    });
    s.addDraftQuote("t1", "the quote");
    await s.sendDraft("t1");
    expect(sent).toEqual([{ threadId: "t1", text: "> the quote\n\n" }]);
    expect(s.draftQuotes("t1")).toHaveLength(0);
  });
});
