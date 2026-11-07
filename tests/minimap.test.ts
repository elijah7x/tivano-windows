// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F03 conversation outline entry derivation (frozen TimelineMinimap):
// user messages only, title = first 8 words then image/attachment/
// "Message" fallbacks, snippet = flattened 160-char preview (dropped
// when identical to the title), weight = clamp(len/420, 0.15, 1).

import { describe, expect, it } from "vitest";
import { minimapEntries } from "../src/renderer/components/TimelineMinimap";
import type { Message } from "../src/shared/types";

const L = {
  oneImage: "1 image",
  images: (n: number) => `${n} images`,
  fallback: "Message",
};
const msg = (id: string, role: Message["role"], content: string, attachments?: Message["attachments"]): Message =>
  ({ id, role, content, ts: 0, status: "done", ...(attachments ? { attachments } : {}) }) as Message;

describe("minimapEntries (F03)", () => {
  it("emits a tick per user message and skips every other role", () => {
    const entries = minimapEntries(
      [
        msg("u1", "user", "first prompt"),
        msg("a1", "assistant", "reply"),
        msg("u2", "user", "follow up"),
        msg("s1", "system", "notice"),
        msg("u3", "user", "third"),
      ],
      L,
    );
    expect(entries.map((e) => e.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("titles by the first 8 words with an ellipsis beyond that", () => {
    const [e] = minimapEntries(
      [msg("u", "user", "one two three four five six seven eight nine ten")],
      L,
    );
    expect(e!.title).toBe("one two three four five six seven eight…");
  });

  it("falls back to image counts, then the attachment name, then Message", () => {
    const one = minimapEntries(
      [msg("u1", "user", "", [{ id: "a", name: "shot.png", size: 1 }])],
      L,
    );
    const many = minimapEntries(
      [
        msg("u2", "user", "", [
          { id: "a", name: "a.jpg", size: 1 },
          { id: "b", name: "b.png", size: 1 },
        ]),
      ],
      L,
    );
    const file = minimapEntries(
      [msg("u3", "user", "", [{ id: "a", name: "spec.pdf", size: 1 }])],
      L,
    );
    const bare = minimapEntries([msg("u4", "user", "   ")], L);
    expect(one[0]!.title).toBe("1 image");
    expect(many[0]!.title).toBe("2 images");
    expect(file[0]!.title).toBe("spec.pdf");
    expect(bare[0]!.title).toBe("Message");
  });

  it("flattens and caps the snippet at 160 chars, dropping it when it equals the title", () => {
    const long = "word ".repeat(60).trim(); // 300 chars
    const [e] = minimapEntries([msg("u", "user", `a\n\nb   c\n${long}`)], L);
    expect(e!.snippet.length).toBe(161); // 160 + ellipsis
    expect(e!.snippet).not.toContain("\n");
    const [short] = minimapEntries([msg("s", "user", "tiny")], L);
    expect(short!.snippet).toBe("");
  });

  it("weights by clamped content length (len/420 within 0.15…1)", () => {
    const [small, mid, big] = minimapEntries(
      [
        msg("s", "user", "hi"),
        msg("m", "user", "x".repeat(210)),
        msg("b", "user", "x".repeat(5000)),
      ],
      L,
    );
    expect(small!.weight).toBeCloseTo(0.15);
    expect(mid!.weight).toBeCloseTo(0.5);
    expect(big!.weight).toBe(1);
  });
});
