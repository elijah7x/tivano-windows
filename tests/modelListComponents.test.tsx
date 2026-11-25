// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-56 / P2-20 component tests: renders ModelListSettings (two-column
// master-detail Your models + All chip wall + group detail + Browse all
// models provider rail) and group-aware ModelPicker (optgroups +
// two-column group popover) in English and Simplified Chinese.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ModelListSettings } from "../src/renderer/components/ModelListSettings";
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
