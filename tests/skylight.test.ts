// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// A84 ports verification: frozen HeroWeather.resolve precedence +
// ThreadActivityStatus.resolve mapping + StreamVeil tail wrapping.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  heroWeatherTag,
  resolveHeroWeather,
  threadActivityStatus,
} from "../src/shared/skylight";
import { renderMarkdown } from "../src/renderer/markdown";
import type { ChatThread } from "../src/shared/types";

const thread = (over: Partial<ChatThread>): ChatThread =>
  ({
    id: over.id ?? "t1",
    projectId: null,
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    turn: null,
    sessionGrants: [],
    ...over,
  }) as ChatThread;

describe("threadActivityStatus (frozen resolve)", () => {
  it("pending approval outranks running", () => {
    expect(
      threadActivityStatus(
        thread({ turn: { status: "waiting-approval" } as ChatThread["turn"] }),
      ),
    ).toBe("approval");
  });
  it("pending question resolves to question", () => {
    expect(
      threadActivityStatus(
        thread({
          turn: {
            status: "running",
            question: { status: "pending" },
          } as ChatThread["turn"],
        }),
      ),
    ).toBe("question");
  });
  it("running turn", () => {
    expect(
      threadActivityStatus(thread({ turn: { status: "running" } as ChatThread["turn"] })),
    ).toBe("running");
  });
  it("unread terminal states only count until read", () => {
    expect(threadActivityStatus(thread({ hasUnread: true, unreadStatus: "error" }))).toBe(
      "failed",
    );
    expect(
      threadActivityStatus(thread({ hasUnread: true, unreadStatus: "interrupted" })),
    ).toBe("interrupted");
    expect(threadActivityStatus(thread({ hasUnread: true, unreadStatus: "done" }))).toBe(
      "completed",
    );
    expect(threadActivityStatus(thread({ hasUnread: false, unreadStatus: "error" }))).toBe(
      "idle",
    );
    expect(threadActivityStatus(thread({}))).toBe("idle");
  });
});

describe("resolveHeroWeather (frozen precedence)", () => {
  it("failed outranks awaiting outranks running outranks done", () => {
    expect(
      resolveHeroWeather(["completed", "running", "question", "failed", "completed"]),
    ).toEqual({ kind: "failed", count: 1 });
    expect(resolveHeroWeather(["completed", "running", "approval", "question"])).toEqual({
      kind: "awaiting",
      count: 2,
    });
    expect(resolveHeroWeather(["completed", "running", "running"])).toEqual({
      kind: "running",
      count: 2,
    });
    expect(resolveHeroWeather(["completed", "completed", "idle"])).toEqual({
      kind: "done",
      count: 2,
    });
    expect(resolveHeroWeather(["idle", "idle"])).toEqual({ kind: "idle", count: 0 });
    expect(resolveHeroWeather(["interrupted"])).toEqual({ kind: "failed", count: 1 });
  });
  it("frozen tag strings", () => {
    expect(heroWeatherTag({ kind: "idle", count: 0 })).toBeNull();
    expect(heroWeatherTag({ kind: "running", count: 3 })).toBe("RUN · 3");
    expect(heroWeatherTag({ kind: "awaiting", count: 1 })).toBe("WAIT · 1");
    expect(heroWeatherTag({ kind: "failed", count: 2 })).toBe("FAIL · 2");
    expect(heroWeatherTag({ kind: "done", count: 4 })).toBe("DONE · 4");
  });
});

describe("StreamVeil (A84)", () => {
  const html = (src: string, veil?: { chars: number; ms: number } | null) =>
    renderToStaticMarkup(
      createElement("div", {}, renderMarkdown(src, undefined, true, veil)),
    );

  it("veils only the trailing flushed characters", () => {
    const out = html("hello world", { chars: 5, ms: 200 });
    expect(out).toContain('class="md-veil"');
    expect(out).toContain("world");
    expect(out.indexOf("hello")).toBeLessThan(out.indexOf("md-veil"));
  });
  it("carries the cadence duration as a CSS var", () => {
    expect(html("abc def", { chars: 3, ms: 175 })).toContain("--veil-d:175ms");
  });
  it("no veil without streaming or without a veil window", () => {
    expect(html("hello", { chars: 5, ms: 200 })).not.toBe("undefined");
    const settled = renderToStaticMarkup(
      createElement("div", {}, renderMarkdown("hello", undefined, false, { chars: 2, ms: 200 })),
    );
    expect(settled).not.toContain("md-veil");
    expect(html("hello", null)).not.toContain("md-veil");
  });
  it("veils inside the mended last block only", () => {
    const out = html("done para\n\nnew **bo", { chars: 2, ms: 200 });
    expect(out).toContain("md-veil");
    // the earlier paragraph stays untouched; only the trailing "bo" veils
    expect(out.match(/md-veil/g)?.length).toBe(1);
  });
});
