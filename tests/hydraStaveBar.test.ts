// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { describe, expect, it } from "vitest";
import { stavesOf } from "../src/renderer/components/HydraStaveBar";
import type { Message } from "../src/shared/types";

let seq = 0;
const msg = (over: Partial<Message>): Message => ({
  id: `m${++seq}`,
  role: "assistant",
  content: "text",
  status: "done",
  ts: seq,
  ...over,
});

const tool = (kind: string, title?: string): Partial<Message> => ({
  kind: "tool",
  tool: { kind: kind as never, state: "completed", ...(title ? { title } : {}) },
});

describe("HydraStaveBar.stavesOf", () => {
  it("maps tool kinds to frozen stave kinds", () => {
    const st = stavesOf(
      [
        msg(tool("read", "Read file")),
        msg(tool("search", "Search")),
        msg(tool("web", "Web")),
        msg(tool("mcp", "MCP call")),
        msg(tool("agent", "Helper")),
        msg(tool("other", "Other")),
        msg(tool("command", "ls")),
        msg(tool("edit", "Edit file")),
      ],
      "Replied",
    );
    expect(st.map((s) => s.kind)).toEqual([
      "lookup", "lookup", "lookup", "lookup", "lookup", "lookup",
      "command", "edit",
    ]);
    expect(st[0]!.step).toBe("Read file");
  });

  it("one stave per assistant reply, first line only, labelled", () => {
    const st = stavesOf(
      [msg({ content: "First line here\nsecond line\nthird" })],
      "Replied",
    );
    expect(st).toHaveLength(1);
    expect(st[0]!.kind).toBe("reply");
    expect(st[0]!.step).toBe("Replied: First line here");
  });

  it("empty reply names the step without a colon", () => {
    const st = stavesOf([msg({ content: "" })], "Replied");
    expect(st[0]!.step).toBe("Replied");
  });

  it("user and system rows make no staves; order is preserved", () => {
    const st = stavesOf(
      [
        msg({ role: "user", content: "hi" }),
        msg({ role: "system", content: "note" }),
        msg(tool("command", "ls")),
        msg({ role: "assistant", content: "done" }),
        msg(tool("read", "Read")),
      ],
      "Replied",
    );
    expect(st.map((s) => s.kind)).toEqual(["command", "reply", "lookup"]);
  });

  it("a reply stave caps its step at 60 characters", () => {
    const long = "x".repeat(200);
    const st = stavesOf([msg({ content: long })], "Replied");
    expect(st[0]!.step.length).toBe("Replied: ".length + 60);
  });
});
