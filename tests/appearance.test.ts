// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-62 settings migration: v2.x stores carrying retired v3.0.0 fields
// (performanceMode, notifyOnDone, commitInstructions, antiSlopEnabled)
// load cleanly without corruption, drop the retired keys from settings,
// and persist cleanly across reopen.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, emptyStore } from "../src/main/store";
import { CorruptStoreError, validateStoreFile, validateStoreHead } from "../src/main/storeDoc";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { requestValidators } from "../src/shared/ipc";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-pm-"));
  dirs.push(d);
  return d;
}
function makeEngine(root: string): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("P2-62 retired settings migration", () => {
  it("opens a v2.x store carrying retired settings without corruption", () => {
    const root = freshRoot();
    const { store } = makeEngine(root);
    store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    doc.settings.performanceMode = true;
    doc.settings.notifyOnDone = false;
    doc.settings.commitInstructions = "use conventional commits";
    doc.settings.antiSlopEnabled = false;
    writeFileSync(path, JSON.stringify(doc));

    const { store: store2, engine: engine2 } = makeEngine(root);
    expect(store2.recoveredFrom).toBeUndefined();
    const settings = engine2.snapshot().settings;
    expect("performanceMode" in settings).toBe(false);
    expect("notifyOnDone" in settings).toBe(false);
    expect("commitInstructions" in settings).toBe(false);
    expect("antiSlopEnabled" in settings).toBe(false);
    store2.close();
  });

  it("re-persists migrated stores without retired keys", () => {
    const root = freshRoot();
    const { store } = makeEngine(root);
    store.close();
    const path = join(root, "store.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    doc.settings.performanceMode = true;
    doc.settings.notifyOnDone = true;
    doc.settings.commitInstructions = "concise";
    doc.settings.antiSlopEnabled = true;
    writeFileSync(path, JSON.stringify(doc));

    const { store: store2, engine: engine2 } = makeEngine(root);
    engine2.setSettings({ chimeWhenFinished: false });
    store2.close();

    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      settings: Record<string, unknown>;
    };
    expect("performanceMode" in persisted.settings).toBe(false);
    expect("notifyOnDone" in persisted.settings).toBe(false);
    expect("commitInstructions" in persisted.settings).toBe(false);
    expect("antiSlopEnabled" in persisted.settings).toBe(false);
    expect(persisted.settings.chimeWhenFinished).toBe(false);
  });

  it("drops malformed retired keys on load during document validation", () => {
    const raw = JSON.parse(JSON.stringify(emptyStore())) as {
      settings: Record<string, unknown>;
    };
    raw.settings.performanceMode = "loud";
    raw.settings.notifyOnDone = 123;
    raw.settings.commitInstructions = 42;
    raw.settings.antiSlopEnabled = "invalid";

    const migrated = validateStoreFile(raw);
    expect("performanceMode" in migrated.settings).toBe(false);
    expect("notifyOnDone" in migrated.settings).toBe(false);
    expect("commitInstructions" in migrated.settings).toBe(false);
    expect("antiSlopEnabled" in migrated.settings).toBe(false);
  });

  it("still rejects genuinely unknown settings keys with CorruptStoreError", () => {
    const raw = JSON.parse(JSON.stringify(emptyStore())) as {
      settings: Record<string, unknown>;
    };
    raw.settings.bogusUnknownKey = true;
    expect(() => validateStoreFile(raw)).toThrow(CorruptStoreError);
  });

  it("persists and reloads live settings keys without corrupt-store recovery", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    engine.setSettings({
      threadTitles: "updated",
      autoShelveDays: 7,
      shelvedGroupName: "  Archived Work  ",
      quickChatEnabled: true,
    });
    store.close();

    const { store: store2, engine: engine2 } = makeEngine(root);
    expect(store2.recoveredFrom).toBeUndefined();
    expect(engine2.snapshot().settings.threadTitles).toBe("updated");
    expect(engine2.snapshot().settings.autoShelveDays).toBe(7);
    expect(engine2.snapshot().settings.shelvedGroupName).toBe("Archived Work");
    expect(engine2.snapshot().settings.quickChatEnabled).toBe(true);

    engine2.setSettings({ shelvedGroupName: "   ", quickChatEnabled: false });
    store2.close();

    const { store: store3, engine: engine3 } = makeEngine(root);
    expect(store3.recoveredFrom).toBeUndefined();
    expect(engine3.snapshot().settings.shelvedGroupName).toBeNull();
    expect(engine3.snapshot().settings.quickChatEnabled).toBe(false);
    store3.close();
  });

  it("round-trips every Engine.setSettings field through a clean reopen", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const patch: Parameters<Engine["setSettings"]>[0] = {
      theme: "nord",
      appearanceMode: "dark",
      language: "zh-Hans",
      chimeWhenFinished: false,
      autoContinueAfterLimit: false,
      confirmBeforeDeleting: false,
      recentDownloadsPicker: false,
      newThreadLocation: "standalone",
      defaultRuntimeMode: "fullAccess",
      defaultWorkspaceMode: "worktree",
      showReasoning: true,
      showsWorkingCard: false,
      weatherWindowMode: "full",
      showsSkylight: true,
      cliInstallationTarget: "/usr/local/bin/tivano",
      taskSleepMode: "display",
      textGeneration: "codex",
      textGenerationModelID: "gpt-5.4-mini",
      textGenerationEffort: "low",
      threadTitles: "updated",
      autoShelveDays: 7,
      shelvedGroupName: "Archived Work",
      quickChatEnabled: true,
      shortcuts: {
        quickChat: { key: "Space", mod: true, ctrl: false, alt: false, shift: true },
      },
      alphaEnabled: true,
      externalControlEnabled: true,
      remoteMCPEnabled: true,
      remoteMCPFullAccess: true,
      remoteMCPPublicURL: "http://127.0.0.1:8765",
      remoteMCPPort: 8765,
      fontSizes: { ui: 14, content: 15, code: 13 },
      hydraEnabled: true,
      hydraDefaultEnabled: true,
      hydraQueueHeads: false,
      hydraAlwaysHeads: true,
      hydraIsolateHeads: false,
      hydraMaxHeads: 4,
      hydraAutoMerge: true,
      hydraArchivesCodexHeads: true,
      hydraShowsHeadDetails: true,
      hydraAutoOpensPanels: false,
      hydraAutoPopsHeads: true,
      hydraTempersHeadEffort: false,
      hasSeenHydraIntro: true,
      hydraPairs: [
        {
          id: "pair-roundtrip",
          provider: "codex",
          orchestratorModel: "gpt-5.4",
          orchestratorEffort: "high",
          workerProvider: "codex",
          workerModel: "gpt-5.4-mini",
          workerEffort: "low",
          maxHeads: 2,
          name: "Roundtrip",
          headProfiles: [],
        },
      ],
      lastHydraPairId: "pair-roundtrip",
      lastNewChatPairId: "pair-roundtrip",
      lastNewChatModel: { provider: "codex", modelID: "gpt-5.4" },
      subagentModeDefault: "adaptive",
      chimeraPresets: [
        {
          id: "custom-roundtrip",
          name: "Custom reviewer",
          specialty: "Review the exact diff carefully.",
          pick: { provider: "codex", model: "gpt-5.4", effort: "high" },
          builtin: "reviewer",
          enabled: true,
        },
      ],
      chimeraAutoDispatch: true,
      hydraTilt: "aggressive",
      hydraReviewEnabled: true,
      hydraReviewFirst: { provider: "codex", model: "gpt-5.4", effort: "high" },
      hydraReviewSecond: { provider: "codex", model: "gpt-5.4-mini", effort: "low" },
      modelList: [{ provider: "codex", modelID: "gpt-5.4" }],
      modelSections: [{ id: "section-roundtrip", name: "Roundtrip", position: 0 }],
      collapsedModelSections: ["section-roundtrip"],
      modelPreferences: { "codex/gpt-5.4": { effort: "high", fastMode: true } },
      hideOutdatedModels: false,
      mcpServers: [
        {
          id: "mcp-roundtrip",
          name: "Roundtrip",
          transport: "stdio",
          command: "node",
          args: ["--version"],
          env: { ROUNDTRIP: "1" },
        },
      ],
      backdropOpacity: 0.7,
      helperPanelSize: { width: 500, height: 300 },
      sidebarWidth: 300,
      terminalHeight: 320,
      whatsNewSeenVersion: "0.1.0",
    };
    engine.setSettings(patch);
    const before = JSON.parse(JSON.stringify(engine.snapshot().settings)) as Record<string, unknown>;
    store.close();

    const { store: store2, engine: engine2 } = makeEngine(root);
    expect(store2.recoveredFrom).toBeUndefined();
    const after = JSON.parse(JSON.stringify(engine2.snapshot().settings)) as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      expect(before, key).toHaveProperty(key);
      expect(after[key], key).toEqual(before[key]);
    }
    store2.close();
  });

  it("rejects retired keys in settings:set IPC validation and ignores them in Engine.setSettings", () => {
    const { store, engine } = makeEngine(freshRoot());
    for (const key of [
      "performanceMode",
      "notifyOnDone",
      "commitInstructions",
      "antiSlopEnabled",
    ]) {
      const patch: Record<string, unknown> = { [key]: true };
      expect(() => requestValidators["settings:set"](patch)).toThrow();
      engine.setSettings(patch as Parameters<Engine["setSettings"]>[0]);
      expect(key in engine.snapshot().settings).toBe(false);
    }
    store.close();
  });

  it("migrates legacy v2.x theme variants onto the 12 accent families + appearanceMode (P2-51)", () => {
    for (const [legacy, expectedTheme, expectedMode] of [
      ["tokyoNight", "nightOwl", "dark"],
      ["githubLight", "github", "light"],
      ["breezeDark", "breeze", "dark"],
      ["breezeLight", "breeze", "light"],
      ["dark", "system", "dark"],
      ["light", "system", "light"],
      ["catppuccinLatte", "catppuccin", "light"],
    ] as const) {
      const raw = JSON.parse(JSON.stringify(emptyStore())) as {
        settings: Record<string, unknown>;
      };
      raw.settings.theme = legacy;
      const migrated = validateStoreFile(raw);
      expect(migrated.settings.theme, legacy).toBe(expectedTheme);
      expect(migrated.settings.appearanceMode, legacy).toBe(expectedMode);
    }
  });

  it("carries legacy dark appearances for theme ids kept as accents through both store validators", () => {
    const validators = [
      ["head", validateStoreHead],
      ["file", validateStoreFile],
    ] as const;
    for (const theme of [
      "nord",
      "claude",
      "matrix",
      "everforest",
      "rosePine",
      "ayu",
      "nightOwl",
      "monokai",
    ] as const) {
      for (const [validatorName, validate] of validators) {
        const raw = JSON.parse(JSON.stringify(emptyStore())) as {
          settings: Record<string, unknown>;
        };
        raw.settings.theme = theme;
        delete raw.settings.appearanceMode;
        const migrated = validate(raw);
        expect(migrated.settings.theme, `${validatorName}:${theme}`).toBe(theme);
        expect(migrated.settings.appearanceMode, `${validatorName}:${theme}`).toBe("dark");
      }
    }
  });

  it("keeps neutral current accents on system appearance and preserves explicit appearanceMode", () => {
    const validators = [
      ["head", validateStoreHead],
      ["file", validateStoreFile],
    ] as const;
    for (const theme of ["breeze", "system", "github"] as const) {
      for (const [validatorName, validate] of validators) {
        const raw = JSON.parse(JSON.stringify(emptyStore())) as {
          settings: Record<string, unknown>;
        };
        raw.settings.theme = theme;
        delete raw.settings.appearanceMode;
        expect(validate(raw).settings.appearanceMode, `${validatorName}:${theme}`).toBe("system");
      }
    }
    for (const mode of ["system", "light", "dark"] as const) {
      for (const [validatorName, validate] of validators) {
        const raw = JSON.parse(JSON.stringify(emptyStore())) as {
          settings: Record<string, unknown>;
        };
        raw.settings.theme = "nord";
        raw.settings.appearanceMode = mode;
        expect(validate(raw).settings.appearanceMode, `${validatorName}:explicit-${mode}`).toBe(mode);
      }
    }
  });
});
