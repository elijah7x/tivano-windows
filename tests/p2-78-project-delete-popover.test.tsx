// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-78 unit & component tests: shared popover anchoring with viewport
// clamping, scroll container visibility, RemoveProjectPopover semantics and
// localization, and Sidebar project delete trigger attributes.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/store";
import { RemoveProjectPopover } from "../src/renderer/components/RemoveProjectPopover";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { LanguageContext } from "../src/renderer/locale";
import { anchorPopover, isAnchorVisibleInContainer } from "../src/shared/popoverAnchor";
import type { ChatThread, LanguageId, Project, Snapshot } from "../src/shared/types";

const prevWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (prevWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

describe("P2-78 shared popoverAnchor", () => {
  it("anchors trailing beside the selected sidebar project row", () => {
    const pos = anchorPopover({
      anchor: { left: 8, right: 260, top: 220, bottom: 252, width: 252, height: 32 },
      popover: { width: 280, height: 184 },
      viewport: { width: 1280, height: 800 },
      preferredSide: "trailing",
      gap: 8,
      margin: 8,
    });
    expect(pos).toEqual({
      left: 268,
      top: 220,
      maxWidth: 1264,
      maxHeight: 784,
      side: "trailing",
    });
  });

  it("clamps top and bottom edge rows inside the viewport", () => {
    const topPos = anchorPopover({
      anchor: { left: 8, right: 260, top: -6, bottom: 26, width: 252, height: 32 },
      popover: { width: 280, height: 184 },
      viewport: { width: 1280, height: 800 },
    });
    expect(topPos.top).toBe(8);
    expect(topPos.left).toBe(268);

    const bottomPos = anchorPopover({
      anchor: { left: 8, right: 260, top: 760, bottom: 792, width: 252, height: 32 },
      popover: { width: 280, height: 184 },
      viewport: { width: 1280, height: 800 },
    });
    expect(bottomPos.top).toBe(800 - 184 - 8);
    expect(bottomPos.left).toBe(268);

    const subpixelBottom = anchorPopover({
      anchor: { left: 17, right: 252, top: 618.5, bottom: 650.5, width: 235, height: 32 },
      popover: { width: 280, height: 201.09375 },
      viewport: { width: 1167, height: 739 },
    });
    expect(subpixelBottom.top + 201.09375).toBeLessThanOrEqual(739 - 8);
  });

  it("flips to leading when trailing overflows and leading fits, or clamps on narrow viewports", () => {
    const flipped = anchorPopover({
      anchor: { left: 400, right: 650, top: 180, bottom: 212, width: 250, height: 32 },
      popover: { width: 280, height: 184 },
      viewport: { width: 700, height: 600 },
      preferredSide: "trailing",
    });
    expect(flipped.side).toBe("leading");
    expect(flipped.left).toBe(400 - 8 - 280);

    const clamped = anchorPopover({
      anchor: { left: 8, right: 260, top: 180, bottom: 212, width: 252, height: 32 },
      popover: { width: 280, height: 184 },
      viewport: { width: 420, height: 600 },
      preferredSide: "trailing",
    });
    expect(clamped.left).toBe(420 - 280 - 8);
  });

  it("caps popover height and clamps safely when the viewport is smaller than the popover", () => {
    const pos = anchorPopover({
      anchor: { left: 8, right: 260, top: 80, bottom: 112, width: 252, height: 32 },
      popover: { width: 280, height: 300 },
      viewport: { width: 260, height: 160 },
      margin: 8,
    });
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(8);
    expect(pos.maxWidth).toBe(244);
    expect(pos.maxHeight).toBe(144);
  });

  it("checks scroll-container visibility accurately", () => {
    const container = { top: 80, bottom: 500, left: 0, right: 268 };
    expect(isAnchorVisibleInContainer({ top: 100, bottom: 132, left: 8, right: 260 }, container)).toBe(true);
    expect(isAnchorVisibleInContainer({ top: 60, bottom: 85, left: 8, right: 260 }, container)).toBe(true);
    expect(isAnchorVisibleInContainer({ top: 40, bottom: 80, left: 8, right: 260 }, container)).toBe(false);
    expect(isAnchorVisibleInContainer({ top: 500, bottom: 532, left: 8, right: 260 }, container)).toBe(false);
  });
});

describe("P2-78 RemoveProjectPopover & Sidebar", () => {
  function renderPopover(lang: LanguageId, anchorTop: number, threadCount: number): string {
    return renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: lang },
        createElement(RemoveProjectPopover, {
          projectId: "proj-1",
          projectName: "Alpha",
          threadCount,
          anchor: { left: 8, right: 260, top: anchorTop, bottom: anchorTop + 32, width: 252, height: 32 },
          onRemove: () => {},
          onCancel: () => {},
        }),
      ),
    );
  }

  it("renders alertdialog semantics, accurate thread count, and clamped coordinates", () => {
    const html = renderPopover("en", 760, 4);
    expect(html).toContain('id="project-delete-popover"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('data-project-id="proj-1"');
    expect(html).toContain('data-side="trailing"');
    expect(html).toContain("Remove this project?");
    expect(html).toContain("This permanently deletes 4 chats, including linked sub-agents and helpers in other projects. Project source files will not be deleted.");
    expect(html).toContain("Remove project");
    expect(html).toContain("Cancel");
    expect(html).toContain("left:268px");
    // 800 fallback viewport - 184 default height - 8 margin = 608px
    expect(html).toContain("top:608px");
  });

  it("renders localized zh-Hans confirmation copy", () => {
    const html = renderPopover("zh-Hans", 200, 2);
    expect(html).toContain("移除这个项目？");
    expect(html).toContain("这将永久删除 2 个对话，包括关联到其他项目的子代理和助手。项目源文件不会被删除。");
    expect(html).toContain("移除项目");
    expect(html).toContain("取消");
  });

  it("renders Sidebar project delete triggers with dialog aria attributes and no inline Delete? arm", () => {
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async () => ({}),
        onEvent: () => () => {},
      },
    };
    const projects: Project[] = [
      { id: "p1", name: "First", createdAt: 1, expanded: false },
      { id: "p2", name: "Second", createdAt: 2, expanded: true },
    ];
    const threads: ChatThread[] = [
      {
        id: "t1",
        projectId: "p1",
        title: "Hidden under collapsed",
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        turn: null,
        sessionGrants: [],
      },
    ];
    const snapshot = {
      projects,
      threads,
      settings: { ...defaultSettings(), language: "en" },
      selectedThreadId: null,
      info: {
        appVersion: "test",
        baselineTag: "v3.0.26",
        baselineCommit: "23ac46c6f2e922d62b1a388f3ead7c42260e2dd4",
        dataRoot: "C:/tivano-test",
        providerId: "mock",
        providerLabel: "Mock",
        mock: true,
        mode: "mock",
        realCli: { status: "not-configured" },
        home: "C:/tivano-test",
        worktreesDir: "C:/tivano-test/worktrees",
      },
      rev: 0,
      tokenActivity: {},
    } as unknown as Snapshot;

    const html = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: "en" },
        createElement(Sidebar, {
          snapshot,
          onOpenSettings: () => {},
          onOpenPalette: () => {},
        }),
      ),
    );
    expect(html).toContain('data-project-id="p1"');
    expect(html).toContain('data-project-id="p2"');
    expect(html).toContain('aria-label="Delete project: First" aria-haspopup="dialog" aria-expanded="false"');
    expect(html).not.toContain("danger-arm");
  });
});
