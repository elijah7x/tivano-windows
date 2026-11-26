// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-56 / P2-20 component tests: renders ModelListSettings (two-column
// master-detail Your models + All chip wall + group detail + Browse all
// models provider rail) and group-aware ModelPicker (optgroups +
// two-column group popover) in English and Simplified Chinese.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelListSettings,
  createModelListController,
  type PendingSectionRename,
} from "../src/renderer/components/ModelListSettings";
import { ModelPicker } from "../src/renderer/components/ModelPicker";
import { LanguageContext } from "../src/renderer/locale";
import { clientStore } from "../src/renderer/client";
import { defaultSettings } from "../src/main/store";
import type {
  ChatThread,
  CodexModelCatalog,
  LanguageId,
  Settings,
  Snapshot,
} from "../src/shared/types";
import type { ModelPin, ModelPreference, ModelSection } from "../src/shared/modelList";

const prevSnapshot = clientStore.snapshot;

afterEach(() => {
  clientStore.snapshot = prevSnapshot;
});

function setMockSettings(settingsPatch: Partial<Settings>, language: LanguageId = "en"): void {
  const settings: Settings = {
    ...defaultSettings(),
    language,
    modelList: [
      { provider: "codex", modelID: "gpt-u" },
      { provider: "codex", modelID: "gpt-a1" },
      { provider: "codex", modelID: "gpt-b1" },
    ],
    modelSections: [
      { id: "sec-a", name: "Reasoning", position: 1 },
      { id: "sec-b", name: "Coding", position: 2 },
      { id: "sec-empty", name: "Empty Lane", position: 3 },
    ],
    modelPreferences: {
      "codex/gpt-a1": { effort: "high", fastMode: true },
    },
    ...settingsPatch,
  };
  clientStore.snapshot = {
    projects: [],
    threads: [],
    selectedThreadId: null,
    activeTurns: {},
    settings,
  } as unknown as Snapshot;
}

const SAMPLE_CATALOG: CodexModelCatalog = {
  state: "ready",
  models: [
    {
      id: "gpt-u",
      name: "GPT-5.4 Mini",
      detail: "Fast lightweight model",
      efforts: ["low", "medium"],
      defaultEffort: "low",
      isDefault: false,
    },
    {
      id: "gpt-a1",
      name: "GPT-5.4 Sol",
      detail: "Flagship reasoning",
      efforts: ["medium", "high"],
      defaultEffort: "medium",
      fastTier: "fast",
      isDefault: true,
    },
    {
      id: "gpt-b1",
      name: "GPT-5.4 Codex",
      detail: "Coding specialist",
      efforts: ["high"],
      defaultEffort: "high",
      isDefault: false,
    },
  ],
};

function makeThread(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    codexModel: "gpt-a1",
    ...over,
  } as ChatThread;
}

function renderLang(lang: LanguageId, node: React.ReactElement): string {
  return renderToStaticMarkup(createElement(LanguageContext.Provider, { value: lang }, node));
}

describe("ModelListSettings (P2-56 / P2-20)", () => {
  it("renders two-column Your models rail, All chip wall, and two-column Browse all models", () => {
    setMockSettings({});
    const html = renderLang(
      "en",
      createElement(ModelListSettings, {
        initialGroup: { kind: "all" },
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    expect(html).toContain("Your models");
    expect(html).toContain("3 / 30");
    // Left group rail lists All, Ungrouped, Reasoning, Coding, Empty Lane, New group.
    expect(html).toContain("ml-rail");
    expect(html).toContain("Ungrouped");
    expect(html).toContain("Reasoning");
    expect(html).toContain("Coding");
    expect(html).toContain("Empty Lane");
    expect(html).toContain("New group");
    // All chip wall renders draggable chips per non-empty group with fast indicator.
    expect(html).toContain('data-wall-group="ungrouped"');
    expect(html).toContain('data-wall-group="sec-a"');
    expect(html).toContain('data-wall-group="sec-b"');
    expect(html).toContain('data-pin-id="codex/gpt-a1"');
    expect(html).toContain("GPT-5.4 Sol");
    expect(html).toContain("Click a model to jump to its group");
    // Browse all models shows All models + provider counts + non-folding Codex card.
    expect(html).toContain("Browse all models");
    expect(html).toContain("All models");
    expect(html).toContain("ml-catalog-card");
  });

  it("renders group detail rows and empty group message", () => {
    setMockSettings({});
    const groupHtml = renderLang(
      "en",
      createElement(ModelListSettings, {
        initialGroup: { kind: "group", sectionId: "sec-a" },
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    const detailPart = groupHtml.split("ml-catalog-card")[0]!;
    expect(detailPart).toContain("Effort and fast mode apply immediately");
    expect(detailPart).toContain("GPT-5.4 Sol");
    expect(detailPart).toContain("High effort");
    expect(detailPart).toContain("Fast");
    expect(detailPart).not.toContain("GPT-5.4 Codex");

    const emptyHtml = renderLang(
      "en",
      createElement(ModelListSettings, {
        initialGroup: { kind: "group", sectionId: "sec-empty" },
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    expect(emptyHtml).toContain("No models in this group");
  });

  it("localizes Settings > Models labels in zh-Hans", () => {
    setMockSettings({}, "zh-Hans");
    const html = renderLang(
      "zh-Hans",
      createElement(ModelListSettings, {
        initialGroup: { kind: "all" },
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    expect(html).toContain("你的模型");
    expect(html).toContain("未分组");
    expect(html).toContain("浏览全部模型");
    expect(html).toContain("全部模型");
    expect(html).toContain("新建分组");
    expect(html).toContain("点击任意模型跳到所在分组");
  });
});

describe("ModelPicker (P2-56 group-aware picker)", () => {
  it("renders grouped optgroups in select and the group-aware two-column popover", () => {
    setMockSettings({});
    const closedHtml = renderLang(
      "en",
      createElement(ModelPicker, {
        thread: makeThread({ codexModel: "gpt-a1" }),
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    expect(closedHtml).toContain('<optgroup label="Reasoning">');
    expect(closedHtml).toContain('<optgroup label="Coding">');
    // Empty group is omitted from native optgroups, while button labels active group.
    expect(closedHtml).not.toContain('<optgroup label="Empty Lane">');
    expect(closedHtml).toContain("model-groups-btn");
    expect(closedHtml).toContain("Reasoning");

    const openHtml = renderLang(
      "en",
      createElement(ModelPicker, {
        thread: makeThread({ codexModel: "gpt-a1" }),
        initialCatalog: SAMPLE_CATALOG,
        initialOpen: true,
      }),
    );
    expect(openHtml).toContain("model-picker-pop");
    expect(openHtml).toContain('data-picker-cat="all"');
    expect(openHtml).toContain('data-picker-cat="group/sec-a"');
    expect(openHtml).toContain('data-picker-cat="group/sec-empty"');
    expect(openHtml).toContain('data-picker-cat="ungrouped"');
    // Default category opens on Reasoning (the group containing gpt-a1).
    expect(openHtml).toContain('data-picker-cat="group/sec-a"');
    const popListHtml = openHtml.split('class="model-pop-list"')[1]!;
    expect(popListHtml).toContain("GPT-5.4 Sol");
    expect(popListHtml).not.toContain("GPT-5.4 Codex");
  });

  it("filters grouped search results and hides group button when no groups exist", () => {
    setMockSettings({});
    const searchHtml = renderLang(
      "en",
      createElement(ModelPicker, {
        thread: makeThread({ codexModel: "gpt-a1" }),
        initialCatalog: SAMPLE_CATALOG,
        initialOpen: true,
        initialQuery: "codex",
      }),
    );
    const searchListHtml = searchHtml.split('class="model-pop-list"')[1]!;
    expect(searchListHtml).toContain("Coding");
    expect(searchListHtml).toContain("GPT-5.4 Codex");
    expect(searchListHtml).not.toContain("GPT-5.4 Sol");

    setMockSettings({ modelSections: [] }, "zh-Hans");
    const noGroupHtml = renderLang(
      "zh-Hans",
      createElement(ModelPicker, {
        thread: makeThread({ codexModel: "gpt-a1" }),
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    expect(noGroupHtml).not.toContain("model-groups-btn");
  });

  it("localizes group picker labels in zh-Hans", () => {
    setMockSettings({}, "zh-Hans");
    const openZh = renderLang(
      "zh-Hans",
      createElement(ModelPicker, {
        thread: makeThread({ codexModel: "gpt-a1" }),
        initialCatalog: SAMPLE_CATALOG,
        initialOpen: true,
      }),
    );
    expect(openZh).toContain("模型分组");
    expect(openZh).toContain("未分组");
    expect(openZh).toContain("全部");
  });
});

describe("ModelListSettings P2-33 controller & component regressions", () => {
  function setupControllerRig(overrides: Partial<Settings> = {}) {
    setMockSettings(overrides);
    const writes: Record<string, unknown>[] = [];
    let editingId: string | null = null;
    let draft = "";
    let pendingNewId: string | null = null;
    const pendingRenamesRef: { current: Record<string, PendingSectionRename> } = { current: {} };
    const dragRef: { current: string | null } = { current: null };
    let dropHint: string | null = null;
    let effortPop: { pin: ModelPin; x: number; y: number } | null = null;

    const getSnap = () => clientStore.snapshot?.settings;
    const ctrl = createModelListController({
      getSnapshotSettings: getSnap,
      fallback: {
        pins: getSnap()?.modelList ?? [],
        sections: getSnap()?.modelSections ?? [],
        collapsed: getSnap()?.collapsedModelSections ?? [],
        prefs: getSnap()?.modelPreferences ?? {},
      },
      getEditingId: () => editingId,
      setEditingId: (id) => {
        editingId = id;
      },
      getDraft: () => draft,
      setDraft: (d) => {
        draft = d;
      },
      getPendingNewId: () => pendingNewId,
      setPendingNewId: (id) => {
        pendingNewId = id;
      },
      pendingRenamesRef,
      dragRef,
      setDropHint: (h) => {
        dropHint = h;
      },
      setEffortPop: (p) => {
        effortPop = p;
      },
      write: (patch) => {
        writes.push(patch);
      },
    });

    const echoSnapshot = (patch: Partial<Settings>) => {
      clientStore.snapshot = {
        ...clientStore.snapshot!,
        settings: {
          ...clientStore.snapshot!.settings,
          ...patch,
        },
      };
    };

    return {
      ctrl,
      writes,
      echoSnapshot,
      getState: () => ({
        editingId,
        draft,
        pendingNewId,
        pendingRenames: Object.fromEntries(
          Object.entries(pendingRenamesRef.current).map(([k, v]) => [k, v.name]),
        ),
        dropHint,
        effortPop,
      }),
      setDraftVal: (d: string) => {
        draft = d;
      },
      setDrag: (d: string | null) => {
        dragRef.current = d;
      },
      setPop: (pin: ModelPin) => {
        effortPop = { pin, x: 10, y: 20 };
      },
    };
  }

  it("renders group detail rename and ungroup actions cleanly", () => {
    setMockSettings({});
    const html = renderLang(
      "en",
      createElement(ModelListSettings, {
        initialGroup: { kind: "group", sectionId: "sec-a" },
        initialCatalog: SAMPLE_CATALOG,
      }),
    );
    expect(html).toContain("Rename group");
    expect(html).toContain("Ungroup. Models stay in the list.");
  });

  it("preserves multiple per-section pending renames, revert-before-echo, live removePin, cancelRename, and startRename", () => {
    const rig = setupControllerRig();
    const secA = clientStore.snapshot!.settings.modelSections![0]!;
    const secB = clientStore.snapshot!.settings.modelSections![1]!;
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning v2");

    // Simulate blur firing commitRename (async IPC, snapshot not updated yet).
    rig.ctrl.commitRename("sec-a");
    expect(rig.getState().editingId).toBeNull();
    expect(rig.getState().pendingRenames).toEqual({ "sec-a": "Reasoning v2" });

    // Reverting sec-a back to its original snapshot name before IPC echo must STILL write!
    rig.ctrl.startRename(secA);
    expect(rig.getState().draft).toBe("Reasoning v2");
    rig.setDraftVal("Reasoning");
    rig.ctrl.commitRename("sec-a");
    expect(rig.writes).toHaveLength(2);
    expect(rig.getState().pendingRenames).toEqual({ "sec-a": "Reasoning" });
    // Immediate syncEffects on the same stale snapshot array must NOT prematurely drop pending.
    rig.ctrl.syncEffects(
      clientStore.snapshot!.settings.modelList!,
      clientStore.snapshot!.settings.modelSections!,
      null,
    );
    expect(rig.getState().pendingRenames).toEqual({ "sec-a": "Reasoning" });

    // Rename secA to "Reasoning v2" and secB to "Small v2" before any echo arrives: both stay pending and fold together.
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning v2");
    rig.ctrl.commitRename("sec-a");
    rig.ctrl.startRename(secB);
    rig.setDraftVal("Small v2");
    rig.ctrl.commitRename("sec-b");
    expect(rig.getState().pendingRenames).toEqual({
      "sec-a": "Reasoning v2",
      "sec-b": "Small v2",
    });
    const bothCommit = rig.writes[3] as { modelSections: ModelSection[] };
    expect(bothCommit.modelSections.find((s) => s.id === "sec-a")?.name).toBe("Reasoning v2");
    expect(bothCommit.modelSections.find((s) => s.id === "sec-b")?.name).toBe("Small v2");

    // Start renaming secA without blurring, then removePin directly -> live draft folds AND secB's pending rename stays folded!
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning Live Remove");
    rig.ctrl.removePin({ provider: "codex", modelID: "gpt-a1" });
    expect(rig.getState().editingId).toBeNull();
    const removeWrite = rig.writes[4] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(removeWrite.modelList.map((p) => p.modelID)).toEqual(["gpt-u", "gpt-b1"]);
    expect(removeWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Live Remove",
    );
    expect(removeWrite.modelSections.find((s) => s.id === "sec-b")?.name).toBe("Small v2");

    // startRename while already editing another section commits the first before switching, and cancelRename closes edit without dropping secB's pending rename.
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning Before Switch");
    rig.ctrl.startRename(secB);
    expect(rig.getState().editingId).toBe("sec-b");
    expect(rig.getState().pendingRenames).toEqual({
      "sec-a": "Reasoning Before Switch",
      "sec-b": "Small v2",
    });
    rig.ctrl.cancelRename("sec-b");
    expect(rig.getState().editingId).toBeNull();
    expect(rig.getState().pendingRenames).toEqual({
      "sec-a": "Reasoning Before Switch",
      "sec-b": "Small v2",
    });

    // Once the store echoes secA + secB, both pending renames clear.
    rig.echoSnapshot({
      modelList: removeWrite.modelList,
      modelSections: removeWrite.modelSections.map((s) =>
        s.id === "sec-a"
          ? { ...s, name: "Reasoning Before Switch" }
          : s.id === "sec-b"
            ? { ...s, name: "Small v2" }
            : s,
      ),
    });
    rig.ctrl.syncEffects(
      removeWrite.modelList,
      clientStore.snapshot!.settings.modelSections!,
      null,
    );
    expect(rig.getState().pendingRenames).toEqual({});
  });

  it("folds an in-flight rename when removing a sibling section and never resurrects a deleted section", () => {
    const rig = setupControllerRig();
    const secA = clientStore.snapshot!.settings.modelSections![0]!;
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning Live");
    rig.ctrl.commitRename("sec-a");

    // Remove sec-b before sec-a rename echoes.
    rig.ctrl.removeSection("sec-b");
    const w1 = rig.writes[1] as { modelSections: ModelSection[] };
    expect(w1.modelSections.map((s) => [s.id, s.name])).toEqual([
      ["sec-a", "Reasoning Live"],
      ["sec-empty", "Empty Lane"],
    ]);

    // Now rename sec-empty and delete sec-empty itself: must not resurrect and clears only sec-empty's pending rename.
    const secEmpty = clientStore.snapshot!.settings.modelSections![2]!;
    rig.ctrl.startRename(secEmpty);
    rig.setDraftVal("Doomed");
    rig.ctrl.commitRename("sec-empty");
    rig.ctrl.removeSection("sec-empty");
    const wLast = rig.writes.at(-1) as { modelSections: ModelSection[] };
    expect(wLast.modelSections.some((s) => s.id === "sec-empty")).toBe(false);
    expect(rig.getState().pendingRenames).toEqual({ "sec-a": "Reasoning Live" });
  });

  it("folds pending and live renames into reorder and catalog operations (rail drop, pin drop, wall drop, moveSection, movePinToSection, toggleCatalogPin)", () => {
    const rig = setupControllerRig();
    const secA = clientStore.snapshot!.settings.modelSections![0]!;
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning Reordered");
    rig.ctrl.commitRename("sec-a");

    // Reorder sec-b onto sec-a via rail drop before IPC echo.
    rig.setDrag("section/sec-b");
    rig.ctrl.dropOnRail("sec-a", false);
    const dropWrite = rig.writes[1] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(dropWrite.modelSections[0]?.id).toBe("sec-b");
    expect(dropWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Reordered",
    );

    // Drop a pin onto another pin and onto a wall group while editing (folds live draft).
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning Pin Drop");
    rig.setDrag("codex/gpt-u");
    rig.ctrl.dropOnPin({ provider: "codex", modelID: "gpt-a1" }, false);
    const pinDropWrite = rig.writes[2] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(pinDropWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Pin Drop",
    );

    rig.setDrag("codex/gpt-b1");
    rig.ctrl.dropOnWallGroup("sec-a", false);
    const wallDropWrite = rig.writes[3] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(wallDropWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Pin Drop",
    );

    // Move pin while editing (context-menu path keeps editingId active).
    rig.setDraftVal("Reasoning Menu");
    rig.ctrl.movePinToSection({ provider: "codex", modelID: "gpt-u" }, "sec-a");
    const movePinWrite = rig.writes[4] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(movePinWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Menu",
    );
    // sec-a position is 0 since gpt-u moved under sec-a.
    expect(movePinWrite.modelSections.find((s) => s.id === "sec-a")?.position).toBe(0);

    // Move section up while editing.
    rig.ctrl.moveSection("sec-b", -1);
    const moveSecWrite = rig.writes[5] as { modelSections: ModelSection[] };
    expect(moveSecWrite.modelSections[0]?.id).toBe("sec-b");
    expect(moveSecWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Menu",
    );

    // Unpin via catalog toggle while editing also folds the active rename.
    rig.ctrl.toggleCatalogPin({ provider: "codex", modelID: "gpt-a1" }, true);
    const catUnpinWrite = rig.writes[6] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(catUnpinWrite.modelList.some((p) => p.modelID === "gpt-a1")).toBe(false);
    expect(catUnpinWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Menu",
    );
  });

  it("guards mid-drag removal of sections and pins without crashing or writing stale data", () => {
    const rig = setupControllerRig();

    // Start dragging sec-b, then remove sec-b from store before drop lands.
    rig.setDrag("section/sec-b");
    rig.echoSnapshot({
      modelSections: clientStore.snapshot!.settings.modelSections!.filter(
        (s) => s.id !== "sec-b",
      ),
    });
    rig.ctrl.dropOnRail("sec-a", false);
    expect(rig.writes).toHaveLength(0);

    // Start dragging codex/gpt-b1, then remove gpt-b1 from store before drop lands.
    rig.setDrag("codex/gpt-b1");
    rig.echoSnapshot({
      modelList: clientStore.snapshot!.settings.modelList!.filter(
        (p) => p.modelID !== "gpt-b1",
      ),
    });
    rig.ctrl.dropOnPin({ provider: "codex", modelID: "gpt-a1" }, false);
    rig.setDrag("codex/gpt-b1");
    rig.ctrl.dropOnWallGroup("sec-a", false);
    expect(rig.writes).toHaveLength(0);
  });

  it("keeps New group rename alive until echoed, then clears vanished editingId/effortPop", () => {
    const rig = setupControllerRig();
    rig.ctrl.addNewGroup("New group");
    const addWrite = rig.writes[0] as { modelSections: ModelSection[] };
    const newId = addWrite.modelSections.at(-1)!.id;
    expect(rig.getState().editingId).toBe(newId);
    expect(rig.getState().pendingNewId).toBe(newId);

    // Before IPC echo, syncEffects sees old sections without newId -> must NOT close editor.
    rig.ctrl.syncEffects(
      clientStore.snapshot!.settings.modelList!,
      clientStore.snapshot!.settings.modelSections!,
      null,
    );
    expect(rig.getState().editingId).toBe(newId);

    // Once echoed, pendingNewId clears while editingId stays open.
    rig.echoSnapshot({ modelSections: addWrite.modelSections });
    rig.ctrl.syncEffects(
      clientStore.snapshot!.settings.modelList!,
      addWrite.modelSections,
      null,
    );
    expect(rig.getState().pendingNewId).toBeNull();
    expect(rig.getState().editingId).toBe(newId);

    // When the target section or effortPop pin vanishes later, both clear.
    rig.setPop({ provider: "codex", modelID: "gpt-a1" });
    const prunedSections = addWrite.modelSections.filter((s) => s.id !== newId);
    const prunedPins = clientStore.snapshot!.settings.modelList!.filter(
      (p) => p.modelID !== "gpt-a1",
    );
    rig.ctrl.syncEffects(prunedPins, prunedSections, rig.getState().effortPop);
    expect(rig.getState().editingId).toBeNull();
    expect(rig.getState().effortPop).toBeNull();
  });

  it("EffortCard updatePref reads the latest snapshot modelPreferences", () => {
    const rig = setupControllerRig();
    // Another pin's preference arrived in the store after render.
    rig.echoSnapshot({
      modelPreferences: {
        "codex/gpt-a1": { effort: "high", fastMode: true },
        "codex/gpt-b1": { effort: "medium" },
      },
    });
    rig.ctrl.updatePref({ provider: "codex", modelID: "gpt-u" }, { effort: "low" });
    const prefWrite = rig.writes[0] as {
      modelPreferences: Record<string, ModelPreference>;
    };
    expect(prefWrite.modelPreferences).toEqual({
      "codex/gpt-a1": { effort: "high", fastMode: true },
      "codex/gpt-b1": { effort: "medium" },
      "codex/gpt-u": { effort: "low" },
    });
  });

  it("carries one in-flight rename through a section move into a single pin-remove write", () => {
    const rig = setupControllerRig();
    const secA = clientStore.snapshot!.settings.modelSections![0]!;
    rig.ctrl.startRename(secA);
    rig.setDraftVal("Reasoning Live");

    rig.ctrl.moveSection("sec-b", -1);
    expect(rig.writes).toHaveLength(1);
    const moveWrite = rig.writes[0] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(moveWrite.modelSections[0]?.id).toBe("sec-b");
    expect(moveWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Live",
    );

    rig.echoSnapshot({ modelList: moveWrite.modelList, modelSections: moveWrite.modelSections });
    rig.ctrl.removePin({ provider: "codex", modelID: "gpt-a1" });
    expect(rig.writes).toHaveLength(2);
    const removeWrite = rig.writes[1] as {
      modelList: ModelPin[];
      modelSections: ModelSection[];
    };
    expect(removeWrite.modelList.map((p) => p.modelID)).toEqual(["gpt-u", "gpt-b1"]);
    expect(removeWrite.modelSections.find((s) => s.id === "sec-a")?.name).toBe(
      "Reasoning Live",
    );
    expect(removeWrite.modelSections[0]?.id).toBe("sec-b");
  });
});
