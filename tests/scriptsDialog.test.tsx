// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-33 component regression tests: render ScriptsDialog and drive
// ScriptDraftList (the actual element tree ScriptsDialog renders) to
// verify row keys stay frozen by id / monotonic keyGen when removing a
// sibling mid-edit, and patch/delete target the row's stable key.

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = {
    tivano: {
      platform: "win32",
      invoke: () => Promise.resolve({}),
      onEvent: () => () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

import { LanguageContext } from "../src/renderer/locale";
import {
  ScriptDraftList,
  ScriptsDialog,
} from "../src/renderer/components/ScriptsDialog";
import {
  createScriptDraft,
  makeScriptDraftKeyGen,
  patchScriptDraft,
  removeScriptDraft,
  serializeScriptDrafts,
  toScriptDraft,
  type ScriptDraft,
} from "../src/renderer/scriptDrafts";
import type { ChatThread, LanguageId, Project } from "../src/shared/types";

function renderInLang(lang: LanguageId, node: ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, node),
  );
}

function collectElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean,
  out: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (predicate(el)) out.push(el);
  if (el.props?.children) collectElements(el.props.children as ReactNode, predicate, out);
  return out;
}

const sampleThread = {
  id: "t-1",
  projectId: "p-1",
  title: "Chat",
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  turn: null,
  sessionGrants: [],
} as ChatThread;

const sampleProject: Project = {
  id: "p-1",
  name: "Demo",
  createdAt: 1,
  expanded: true,
  scripts: [
    {
      id: "saved-1",
      name: "Build",
      command: "npm run build",
      icon: "hammer",
      runOnWorktreeCreate: false,
    },
  ],
};

describe("ScriptsDialog & ScriptDraftList (P2-33 remove-while-editing)", () => {
  it("renders ScriptsDialog in view and edit modes (including saved drafts keyed via ScriptDraftList) in en and zh-Hans", () => {
    const viewHtml = renderInLang(
      "en",
      createElement(ScriptsDialog, {
        thread: sampleThread,
        project: sampleProject,
        onClose: () => {},
        onRan: () => {},
      }),
    );
    expect(viewHtml).toContain("Build");
    expect(viewHtml).toContain("Edit scripts");

    const savedEditHtml = renderInLang(
      "en",
      createElement(ScriptsDialog, {
        thread: sampleThread,
        project: sampleProject,
        onClose: () => {},
        onRan: () => {},
        initialEditing: true,
      }),
    );
    expect(savedEditHtml).toContain('data-script-key="saved-1"');
    expect(savedEditHtml).toContain("Build");
    expect(savedEditHtml).toContain("npm run build");

    const editHtml = renderInLang(
      "zh-Hans",
      createElement(ScriptsDialog, {
        thread: sampleThread,
        project: { ...sampleProject, scripts: [] },
        onClose: () => {},
        onRan: () => {},
      }),
    );
    expect(editHtml).toContain("添加脚本");
    expect(editHtml).toContain("保存");
  });

  it("keys ScriptDraftList cards by d.key and keeps an edited sibling bound across delete + add", () => {
    const keyGen = makeScriptDraftKeyGen();
    let drafts: ScriptDraft[] = [
      toScriptDraft(sampleProject.scripts![0]!),
      createScriptDraft(keyGen, "New script"),
      createScriptDraft(keyGen, "New script"),
    ];

    const renderList = () =>
      ScriptDraftList({
        drafts,
        busy: false,
        t: (k) => k,
        onPatch: (key, p) => {
          drafts = patchScriptDraft(drafts, key, p);
        },
        onDelete: (key) => {
          drafts = removeScriptDraft(drafts, key);
        },
        onAdd: () => {
          drafts = [...drafts, createScriptDraft(keyGen, "New script")];
        },
      });

    let tree = renderList();
    let cards = collectElements(
      tree,
      (el) => el.type === "div" && el.props.className === "script-card",
    );
    // Keys must be stable row ids / keyGen tokens, never array indices.
    expect(cards.map((c) => c.key)).toEqual(["saved-1", "new-1", "new-2"]);

    // Drive the third row's name & command inputs directly through its element handlers.
    const thirdInputs = collectElements(cards[2], (el) => el.type === "input");
    (thirdInputs[0]!.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Keep me" },
    });
    (thirdInputs[1]!.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "echo keep" },
    });

    // Delete the second row (`new-1`) while editing the third (`new-2`).
    const secondDelete = collectElements(
      cards[1],
      (el) => el.type === "button" && el.props["aria-label"] === "Delete script",
    )[0]!;
    (secondDelete.props.onClick as () => void)();

    // Add another new row; it must get `new-3`, never recycling `new-2` or `new-1`.
    const addBtn = collectElements(
      tree,
      (el) => el.type === "button" && el.props.className === "term-btn",
    )[0]!;
    (addBtn.props.onClick as () => void)();

    tree = renderList();
    cards = collectElements(
      tree,
      (el) => el.type === "div" && el.props.className === "script-card",
    );
    expect(cards.map((c) => c.key)).toEqual(["saved-1", "new-2", "new-3"]);

    // The edited draft stayed bound to `new-2` with its typed values intact.
    const survivorInputs = collectElements(cards[1], (el) => el.type === "input");
    expect(survivorInputs[0]!.props.value).toBe("Keep me");
    expect(survivorInputs[1]!.props.value).toBe("echo keep");

    // Serialization for IPC drops the client-only `key`.
    const payload = serializeScriptDrafts(drafts);
    expect(payload[1]).toEqual({
      name: "Keep me",
      command: "echo keep",
      icon: "play",
      runOnWorktreeCreate: false,
    });
    expect("key" in payload[1]!).toBe(false);
  });
});
