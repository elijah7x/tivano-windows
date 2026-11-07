// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 timeline grouping: turnId clusters, legacy user-message claiming,
// lone rows, partition and frozen duration formatting.

import { describe, expect, it } from "vitest";
import {
  groupMessages,
  partitionGroup,
  formatDuration,
  type TurnGroup,
} from "../src/renderer/messageGroups";
import type { Message } from "../src/shared/types";

let n = 0;
function msg(partial: Partial<Message>): Message {
  n += 1;
  return {
    id: `m${n}`,
    role: "assistant",
    content: `c${n}`,
    status: "done",
    ts: n * 1000,
    ...partial,
  };
}

describe("F03 messageGroups", () => {
  it("clusters turnId messages into one group in order", () => {
    const a = msg({ role: "user", turnId: "t1" });
    const b = msg({ turnId: "t1" });
    const c = msg({ turnId: "t1" });
    const items = groupMessages([a, b, c]);
    expect(items).toHaveLength(1);
    const g = items[0] as TurnGroup;
    expect(g.kind).toBe("turn");
    expect(g.turnId).toBe("t1");
    expect(g.messages.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  it("an untagged user message is claimed by the turn it precedes", () => {
    const u = msg({ role: "user" }); // legacy store row — no turnId
    const a = msg({ turnId: "t1" });
    const items = groupMessages([u, a]);
    expect(items).toHaveLength(1);
    const g = items[0] as TurnGroup;
    expect(g.messages.map((m) => m.id)).toEqual([u.id, a.id]);
  });

  it("an untagged user message with no following turn stays a lone row", () => {
    const u = msg({ role: "user" });
    const items = groupMessages([u]);
    expect(items).toEqual([{ kind: "lone", message: u }]);
  });

  it("system rows between turns stay lone rows in place", () => {
    const a = msg({ turnId: "t1" });
    const s = msg({ role: "system", content: "limit note" });
    const b = msg({ turnId: "t2" });
    const items = groupMessages([a, s, b]);
    expect(items.map((i) => i.kind)).toEqual(["turn", "lone", "turn"]);
  });

  it("an untagged user between turns claims the FOLLOWING turn", () => {
    const a = msg({ turnId: "t1" });
    const u = msg({ role: "user" });
    const b = msg({ turnId: "t2" });
    const items = groupMessages([a, u, b]);
    expect(items).toHaveLength(2);
    const g = items[1] as TurnGroup;
    expect(g.turnId).toBe("t2");
    expect(g.messages[0]!.id).toBe(u.id);
  });

  it("partitionGroup splits step kinds from open rows", () => {
    const u = msg({ role: "user", turnId: "t1" });
    const r = msg({ turnId: "t1", kind: "reasoning" });
    const tl = msg({ turnId: "t1", kind: "tool" });
    const a = msg({ turnId: "t1" });
    const p = msg({ turnId: "t1", kind: "plan" });
    const td = msg({ turnId: "t1", kind: "todos" });
    const n = msg({ role: "system", turnId: "t1", kind: "notice", noticeLevel: "warning" });
    const g = { kind: "turn", turnId: "t1", messages: [u, r, tl, a, p, td, n] } as TurnGroup;
    const { steps, open } = partitionGroup(g);
    // Frozen: reasoning is `continue`d before grouping — it is never a
    // step row and never lands among the open rows either.
    expect(steps.map((m) => m.id)).toEqual([tl.id, p.id, td.id, n.id]);
    expect(open.map((m) => m.id)).toEqual([u.id, a.id]);
  });

  it("formatDuration matches the frozen narrow 2-unit style", () => {
    expect(formatDuration(0, 5000)).toBe("5s");
    expect(formatDuration(0, 80_000)).toBe("1m 20s");
    expect(formatDuration(0, 60_000)).toBe("1m");
    expect(formatDuration(0, 3_780_000)).toBe("1h 3m");
    expect(formatDuration(0, 3_600_000)).toBe("1h");
    expect(formatDuration(0, -5000)).toBe("0s");
    expect(formatDuration(0, 900)).toBe("1s"); // rounds whole seconds
  });
});
