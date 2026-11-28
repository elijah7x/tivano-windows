// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-72 unit, renderer, and persistence tests: folded sidebar sub-agent /
// helper rows, live running counts, pluralization, stale/completed/failed
// state distinction, folded/unfolded transitions, and expandsHelpers persistence.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMImplementation } from "@xmldom/xmldom";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store, defaultSettings } from "../src/main/store";
import { clientStore, type TivanoApi } from "../src/renderer/client";
import {
  Sidebar,
  foldedHelpersAriaLabel,
  foldedHelpersLabel,
  foldedHelpersMeta,
  foldedHelpersTitle,
  groupSidebarHelpers,
  isSidebarChildRunning,
  orderedSidebarHeads,
  visibleSidebarHelpers,
} from "../src/renderer/components/Sidebar";
import { translate } from "../src/renderer/i18n";
import { LanguageContext } from "../src/renderer/locale";
import type {
  AppInfo,
  ChatThread,
  LanguageId,
  Project,
  Settings,
  Snapshot,
} from "../src/shared/types";

const prevWindow = (globalThis as { window?: unknown }).window;
const prevDocument = (globalThis as { document?: unknown }).document;
const prevActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const prevSnapshot = clientStore.snapshot;
const tempDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tivano-p2-72-"));
  tempDirs.push(dir);
  return dir;
}

function makeInfo(): AppInfo {
  return {
    appVersion: "0.0.0-test",
    baselineTag: "v3.0.26",
    baselineCommit: "23ac46c6f2e922d62b1a388f3ead7c42260e2dd4",
    dataRoot: "C:\\synthetic\\data",
    providerId: "mock",
    providerLabel: "Mock",
    mock: true,
    mode: "mock",
    realCli: { status: "not-configured" },
    home: "C:\\synthetic\\home",
    worktreesDir: "C:\\synthetic\\worktrees",
  };
}

function makeLead(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "lead-1",
    projectId: null,
    title: "Lead thread",
    createdAt: 100,
    updatedAt: 100,
    messages: [],
    turn: null,
    sessionGrants: [],
    ...over,
  };
}

function makeHead(
  id: string,
  headIndex: number,
  status: "running" | "completed" | "stopped" | "failed",
  over: Partial<ChatThread> = {},
  headOver: Partial<NonNullable<ChatThread["hydraHead"]>> = {},
): ChatThread {
  return {
    id,
    projectId: null,
    title: `Task ${headIndex}`,
    createdAt: 100 + headIndex,
    updatedAt: 100 + headIndex,
    messages: [],
    turn: status === "running" ? ({ id: `turn-${id}`, threadId: id, status: "running", seq: 1, startedAt: 100, assistantMessageId: `msg-${id}` }) : null,
    sessionGrants: [],
    ...over,
    hydraHead: {
      leadId: "lead-1",
      headIndex,
      name: `Agent ${headIndex}`,
      task: `Do work ${headIndex}`,
      batchId: "batch-1",
      status,
      spawnedAt: 100 + headIndex,
      ...headOver,
    },
  };
}

function makePlainHelper(
  id: string,
  turnStatus: NonNullable<ChatThread["turn"]>["status"] | null,
  over: Partial<ChatThread> = {},
): ChatThread {
  return {
    id,
    projectId: null,
    title: `Helper ${id}`,
    createdAt: 200,
    updatedAt: 200,
    messages: [],
    turn:
      turnStatus === null
        ? null
        : {
            id: `turn-${id}`,
            threadId: id,
            status: turnStatus,
            seq: 1,
            startedAt: 200,
            assistantMessageId: `msg-${id}`,
          },
    sessionGrants: [],
    parentThreadId: "lead-1",
    isInPanel: false,
    ...over,
  };
}

function makeSnapshot(
  threads: ChatThread[],
  projects: Project[] = [],
  settingsOver: Partial<Settings> = {},
  readOnly?: boolean,
): Snapshot {
  const settings: Settings = { ...defaultSettings(), ...settingsOver };
  return {
    projects,
    threads,
    settings,
    selectedThreadId: threads[0]?.id ?? null,
    info: makeInfo(),
    rev: 1,
    tokenActivity: {},
    ...(readOnly !== undefined ? { readOnly } : {}),
  };
}

function installStubWindow(invoke: TivanoApi["invoke"] = async () => ({})): void {
  (globalThis as { window?: unknown }).window = {
    tivano: { platform: "win32", invoke, onEvent: () => () => {} },
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function setProp(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

function patchTarget(target: object): void {
  setProp(target, "addEventListener", () => {});
  setProp(target, "removeEventListener", () => {});
  setProp(target, "dispatchEvent", () => true);
}

function installMountedDom(invoke: TivanoApi["invoke"]): Document {
  const doc = new DOMImplementation().createDocument(null, "html", null) as Document;
  const origCreateElement = doc.createElement.bind(doc);
  setProp(doc, "createElement", (tag: string) => {
    const el = origCreateElement(tag);
    patchTarget(el);
    setProp(el, "style", {});
    return el;
  });
  const origCreateTextNode = doc.createTextNode.bind(doc);
  setProp(doc, "createTextNode", (data: string) => {
    const node = origCreateTextNode(data);
    Object.defineProperty(node, "nodeValue", {
      configurable: true,
      get: () => node.data,
      set: (v: string) => {
        node.data = String(v);
      },
    });
    return node;
  });
  const head = doc.createElement("head");
  const body = doc.createElement("body");
  doc.documentElement.appendChild(head);
  doc.documentElement.appendChild(body);
  setProp(doc, "head", head);
  setProp(doc, "body", body);
  setProp(doc.documentElement, "dataset", {});
  patchTarget(doc);
  function HTMLIFrameElement(): void {}
  const testWindow = {
    document: doc,
    HTMLIFrameElement,
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    tivano: { platform: "win32", invoke, onEvent: () => () => {} },
  };
  setProp(doc, "defaultView", testWindow);
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { window?: unknown }).window = testWindow;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return doc;
}

function findButtonsByClass(root: Element, cls: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    const classAttr = el.getAttribute("class") ?? "";
    if (el.tagName.toLowerCase() === "button" && classAttr.split(/\s+/).includes(cls)) {
      out.push(el);
    }
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child && child.nodeType === 1) walk(child as Element);
    }
  };
  walk(root);
  return out;
}

function renderSidebar(snapshot: Snapshot, lang: LanguageId = "en"): string {
  installStubWindow();
  clientStore.snapshot = snapshot;
  return renderToStaticMarkup(
    createElement(
      LanguageContext.Provider,
      { value: lang },
      createElement(Sidebar, {
        snapshot,
        onOpenSettings: () => {},
        onOpenPalette: () => {},
      }),
    ),
  );
}

afterEach(() => {
  clientStore.snapshot = prevSnapshot;
  if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = prevWindow;
  if (prevDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = prevDocument;
  if (prevActEnv === undefined) {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  } else {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("P2-72 folded sub-agent/helper state & pluralization", () => {
  it("distinguishes running sub-agents from stale, completed, stopped, and failed states", () => {
    const runningNoTurn = makeHead("h1", 0, "running", { turn: null });
    const completedWithStaleTurn = makeHead("h2", 1, "completed", {
      turn: {
        id: "stale",
        threadId: "h2",
        status: "running",
        seq: 1,
        startedAt: 100,
        assistantMessageId: "m2",
      },
    });
    const stalled = makeHead("h3", 2, "stopped", {}, { stopReason: "stalled" });
    const failed = makeHead("h4", 3, "failed");
    const plainRunning = makePlainHelper("p1", "running");
    const plainWaiting = makePlainHelper("p2", "waiting-approval");
    const plainDone = makePlainHelper("p3", "done");
    const plainError = makePlainHelper("p4", "error");

    expect(isSidebarChildRunning(runningNoTurn)).toBe(true);
    expect(isSidebarChildRunning(completedWithStaleTurn)).toBe(false);
    expect(isSidebarChildRunning(stalled)).toBe(false);
    expect(isSidebarChildRunning(failed)).toBe(false);
    expect(isSidebarChildRunning(plainRunning)).toBe(true);
    expect(isSidebarChildRunning(plainWaiting)).toBe(true);
    expect(isSidebarChildRunning(plainDone)).toBe(false);
    expect(isSidebarChildRunning(plainError)).toBe(false);
  });

  it("formats singular, plural running, and plural idle labels across all languages", () => {
    const tEn = (k: string, ...v: string[]) => translate("en", k, v);
    expect(foldedHelpersLabel({ count: 1, running: 1, isHeads: true }, tEn)).toBe("1 sub-agent");
    expect(foldedHelpersLabel({ count: 1, running: 0, isHeads: false }, tEn)).toBe("1 helper");
    expect(foldedHelpersLabel({ count: 5, running: 2, isHeads: true }, tEn)).toBe(
      "5 sub-agents · 2 running",
    );
    expect(foldedHelpersLabel({ count: 3, running: 0, isHeads: true }, tEn)).toBe("3 sub-agents");
    expect(foldedHelpersLabel({ count: 4, running: 1, isHeads: false }, tEn)).toBe(
      "4 helpers · 1 running",
    );
    expect(foldedHelpersLabel({ count: 2, running: 0, isHeads: false }, tEn)).toBe("2 helpers");

    expect(foldedHelpersAriaLabel({ count: 5, running: 2, isHeads: true }, tEn)).toBe(
      "5 folded sub-agents, 2 running",
    );
    expect(foldedHelpersTitle({ count: 1, running: 1, isHeads: true }, tEn)).toBe(
      "Show the sub-agent",
    );
    expect(foldedHelpersTitle({ count: 5, running: 2, isHeads: true }, tEn)).toBe(
      "Show 5 sub-agents",
    );

    for (const lang of ["zh-Hans", "zh-Hant", "ja", "ko", "fr"] as const) {
      const tLang = (k: string, ...v: string[]) => translate(lang, k, v);
      const label = foldedHelpersLabel({ count: 5, running: 2, isHeads: true }, tLang);
      expect(label).toContain("5");
      expect(label).toContain("2");
      expect(label).not.toContain("%d");
    }
  });

  it("uses helper wording when plain helpers and heads are mixed, and keeps archived/panel helpers excluded", () => {
    const lead = makeLead();
    const hRun = makeHead("h1", 0, "running");
    const hArchived = makeHead("h2", 1, "running", { isArchived: true });
    const pOpen = makePlainHelper("p1", "running", { isInPanel: true });
    const pClosed = makePlainHelper("p2", "done", { isInPanel: false });

    const grouping = groupSidebarHelpers([lead, hRun, hArchived, pOpen, pClosed]);
    const visible = visibleSidebarHelpers(lead.id, grouping);
    expect(visible.map((x) => x.id)).toEqual(["p2", "h1"]);
    expect(foldedHelpersMeta(visible)).toEqual({ count: 2, running: 1, isHeads: false });
  });

  it("orders unfolded heads running-first then newest createdAt first", () => {
    const hDoneOld = makeHead("done-old", 0, "completed", { createdAt: 10 });
    const hDoneNew = makeHead("done-new", 1, "failed", { createdAt: 30 });
    const hRunOld = makeHead("run-old", 2, "running", { createdAt: 20 });
    const hRunNew = makeHead("run-new", 3, "running", { createdAt: 40 });
    expect(orderedSidebarHeads([hDoneOld, hRunOld, hDoneNew, hRunNew]).map((h) => h.id)).toEqual([
      "run-new",
      "run-old",
      "done-new",
      "done-old",
    ]);
  });
});

describe("P2-72 Sidebar rendering & fold transitions", () => {
  it("renders folded row '5 sub-agents · 2 running' with spinner when 2 of 5 heads are running", () => {
    const lead = makeLead();
    const heads = [
      makeHead("h1", 0, "running"),
      makeHead("h2", 1, "running"),
      makeHead("h3", 2, "completed", {
        turn: {
          id: "stale",
          threadId: "h3",
          status: "running",
          seq: 1,
          startedAt: 1,
          assistantMessageId: "m",
        },
      }),
      makeHead("h4", 3, "failed"),
      makeHead("h5", 4, "stopped"),
    ];
    const html = renderSidebar(makeSnapshot([lead, ...heads]));
    expect(html).toContain("helper-stub-row");
    expect(html).toContain('data-count="5"');
    expect(html).toContain('data-running="2"');
    expect(html).toContain("5 sub-agents · 2 running");
    expect(html).toContain('aria-label="5 folded sub-agents, 2 running"');
    expect(html).toContain('title="Show 5 sub-agents"');
    expect(html).toContain("spin-grid");
    expect(html).not.toContain("hydra-sidebar-row");
  });

  it("transitions cleanly from folded to unfolded and back, and updates counts on completion/failure", async () => {
    const calls: Array<{ ch: string; payload: unknown }> = [];
    const doc = installMountedDom(async (ch, payload) => {
      calls.push({ ch, payload });
      return {};
    });
    const container = doc.createElement("div");
    patchTarget(container);
    doc.body.appendChild(container);
    const root = createRoot(container);

    const lead = makeLead();
    const h1 = makeHead("h1", 0, "running");
    const h2 = makeHead("h2", 1, "running");
    const h3 = makeHead("h3", 2, "completed");
    const snapFolded = makeSnapshot([lead, h1, h2, h3]);
    clientStore.snapshot = snapFolded;

    await act(async () => {
      root.render(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(Sidebar, {
            snapshot: snapFolded,
            onOpenSettings: () => {},
            onOpenPalette: () => {},
          }),
        ),
      );
    });

    const stubButtons = findButtonsByClass(container, "helper-stub-row");
    expect(stubButtons).toHaveLength(1);
    expect(stubButtons[0]!.textContent).toContain("3 sub-agents · 2 running");

    await act(async () => {
      (stubButtons[0] as unknown as { click?: () => void }).click?.();
      const propsKey = Object.keys(stubButtons[0]!).find((k) => k.startsWith("__reactProps$"));
      const reactProps = propsKey
        ? ((stubButtons[0] as unknown as Record<string, { onClick?: () => void }>)[propsKey])
        : undefined;
      reactProps?.onClick?.();
    });
    expect(calls).toContainEqual({ ch: "threads:toggle-helpers-fold", payload: { id: "lead-1" } });

    // Re-render unfolded (simulating Engine thread-updated with expandsHelpers: true).
    const snapExpanded = makeSnapshot([{ ...lead, expandsHelpers: true }, h1, h2, h3]);
    clientStore.snapshot = snapExpanded;
    await act(async () => {
      root.render(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(Sidebar, {
            snapshot: snapExpanded,
            onOpenSettings: () => {},
            onOpenPalette: () => {},
          }),
        ),
      );
    });
    expect(findButtonsByClass(container, "helper-stub-row")).toHaveLength(0);
    expect(findButtonsByClass(container, "hydra-sidebar-row")).toHaveLength(3);
    const foldButtons = findButtonsByClass(container, "helper-fold-btn");
    expect(foldButtons).toHaveLength(1);
    expect(foldButtons[0]!.getAttribute("aria-label")).toBe("Hide helpers");

    // Fold back via fold button, with h2 now failed -> "3 sub-agents · 1 running".
    const snapFoldedAfterFail = makeSnapshot([
      { ...lead, expandsHelpers: false },
      h1,
      { ...h2, turn: null, hydraHead: { ...h2.hydraHead!, status: "failed" } },
      h3,
    ]);
    clientStore.snapshot = snapFoldedAfterFail;
    await act(async () => {
      root.render(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(Sidebar, {
            snapshot: snapFoldedAfterFail,
            onOpenSettings: () => {},
            onOpenPalette: () => {},
          }),
        ),
      );
    });
    const stubAfterFail = findButtonsByClass(container, "helper-stub-row");
    expect(stubAfterFail).toHaveLength(1);
    expect(stubAfterFail[0]!.textContent).toContain("3 sub-agents · 1 running");

    // Once all heads complete/fail (0 running), heads drop out of sidebar.
    const snapAllFinished = makeSnapshot([
      { ...lead, expandsHelpers: false },
      { ...h1, turn: null, hydraHead: { ...h1.hydraHead!, status: "completed" } },
      { ...h2, turn: null, hydraHead: { ...h2.hydraHead!, status: "failed" } },
      h3,
    ]);
    clientStore.snapshot = snapAllFinished;
    await act(async () => {
      root.render(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(Sidebar, {
            snapshot: snapAllFinished,
            onOpenSettings: () => {},
            onOpenPalette: () => {},
          }),
        ),
      );
    });
    expect(findButtonsByClass(container, "helper-stub-row")).toHaveLength(0);
    expect(findButtonsByClass(container, "hydra-sidebar-row")).toHaveLength(0);
    expect(findButtonsByClass(container, "helper-fold-btn")).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders folded plain helpers with and without running spinner and respects isInPanel", () => {
    const lead = makeLead();
    const hOpen = makePlainHelper("p-open", "running", { isInPanel: true });
    const htmlOpen = renderSidebar(makeSnapshot([lead, hOpen]));
    expect(htmlOpen).not.toContain("helper-stub-row");
    expect(htmlOpen).not.toContain("helper-row");

    const hClosedDone1 = makePlainHelper("p1", "done", { isInPanel: false });
    const hClosedDone2 = makePlainHelper("p2", "error", { isInPanel: false });
    const htmlIdle = renderSidebar(makeSnapshot([lead, hClosedDone1, hClosedDone2]));
    expect(htmlIdle).toContain("helper-stub-row");
    expect(htmlIdle).toContain('data-running="0"');
    expect(htmlIdle).toContain('<span class="title">2 helpers</span>');
    expect(htmlIdle).not.toContain("spin-grid");

    const htmlSingle = renderSidebar(makeSnapshot([lead, hClosedDone1]));
    expect(htmlSingle).toContain("1 helper");
    expect(htmlSingle).toContain('title="Show the helper"');
  });
});

describe("P2-72 Engine & Store persistence", () => {
  it("toggles and persists expandsHelpers across Store reload", () => {
    const dir = freshDir();
    const store1 = new Store(dir);
    store1.open();
    const engine = new Engine(store1, new MockProvider({ tickMs: 5 }), dir, "0.0.0-test");
    const t = engine.createThread(null, "Parent");
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.expandsHelpers).toBeUndefined();

    engine.toggleHelpersFold(t.id);
    expect(engine.snapshot().threads.find((x) => x.id === t.id)?.expandsHelpers).toBe(true);
    store1.close();

    const store2 = new Store(dir);
    store2.open();
    expect(store2.state.threads.find((x) => x.id === t.id)?.expandsHelpers).toBe(true);

    const engine2 = new Engine(store2, new MockProvider({ tickMs: 5 }), dir, "0.0.0-test");
    engine2.toggleHelpersFold(t.id);
    expect(engine2.snapshot().threads.find((x) => x.id === t.id)?.expandsHelpers).toBe(false);
    store2.close();
  });
});
