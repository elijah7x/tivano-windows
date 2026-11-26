// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-18 text-generation Model picker & Codex background engine tests:
//   - single named constant + mini-tier Automatic resolution
//   - old store ("automatic" / "off") loading with identical effect
//   - IPC settings:set validation for textGeneration / model / effort
//   - fake Codex app-server transcript verifying exact model + effort on the wire
//   - TextGenerationPicker component rendering in en and zh-Hans

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_AUTOMATIC_TEXT_EFFORT,
  CODEX_AUTOMATIC_TEXT_MODEL,
  extractRefreshedTitle,
  findAutomaticCodexTextModel,
  resolveTextGenerationPlan,
} from "../src/shared/textGen";
import { SCHEMA_VERSION, type CodexModelOption, type Settings } from "../src/shared/types";
import { requestValidators } from "../src/shared/ipc";
import { Store, defaultSettings } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { CodexAppServerProvider, type ProviderThreadBinding } from "../src/main/codexAppServerProvider";
import { CODEX_ONE_SHOT_CONFIG_ARGS, type CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import { TextGenerationPicker } from "../src/renderer/components/TextGenerationPicker";
import { LanguageContext } from "../src/renderer/locale";

const roots: string[] = [];
function tmp(prefix = "tivano-p218-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

class FakeAppServerChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 777;
  private buf = "";

  constructor(private readonly onMsg: (msg: Record<string, unknown>, child: FakeAppServerChild) => void) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.onMsg(JSON.parse(line) as Record<string, unknown>, this);
        } catch {
          /* ignore */
        }
      }
    });
  }

  write(obj: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  kill(): boolean {
    setTimeout(() => {
      this.emit("exit", 0, null);
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      this.emit("close", 0, null);
    }, 2);
    return true;
  }
}

const CATALOG: CodexModelOption[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    isDefault: false,
  },
  {
    id: CODEX_AUTOMATIC_TEXT_MODEL,
    name: "GPT-5.1 Codex Mini",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    isDefault: false,
  },
];

describe("P2-18 text generation resolution and validation", () => {
  it("uses the single named constant mini-tier model at low effort for Automatic", () => {
    expect(CODEX_AUTOMATIC_TEXT_EFFORT).toBe("low");
    const picked = findAutomaticCodexTextModel(CATALOG);
    expect(picked?.id).toBe(CODEX_AUTOMATIC_TEXT_MODEL);

    const plan = resolveTextGenerationPlan({ textGeneration: "automatic" }, CATALOG);
    expect(plan).toEqual({
      enabled: true,
      model: CODEX_AUTOMATIC_TEXT_MODEL,
      effort: "low",
    });

    // When the exact named model is absent, falls back to another mini-tier model before default.
    const otherMini = CATALOG.filter((m) => m.id !== CODEX_AUTOMATIC_TEXT_MODEL);
    expect(resolveTextGenerationPlan({ textGeneration: "automatic" }, otherMini)).toEqual({
      enabled: true,
      model: "gpt-5.4-mini",
      effort: "low",
    });

    // Predictions (allowsDefaultModel=false) never fall back to the costly default when no mini exists.
    const noMini = [CATALOG[0]!];
    expect(
      resolveTextGenerationPlan({ textGeneration: "automatic" }, noMini, {
        allowsDefaultModel: false,
      }),
    ).toEqual({ enabled: false });
  });

  it("honors Specific model + effort and Off without falling back to Codex default", () => {
    expect(
      resolveTextGenerationPlan(
        {
          textGeneration: "codex",
          textGenerationModelID: "gpt-5.4-mini",
          textGenerationEffort: "high",
        },
        CATALOG,
      ),
    ).toEqual({ enabled: true, model: "gpt-5.4-mini", effort: "high" });

    // Default effort ("") omits effort rather than forcing low or default model.
    expect(
      resolveTextGenerationPlan(
        {
          textGeneration: "codex",
          textGenerationModelID: "gpt-5.4-mini",
        },
        CATALOG,
      ),
    ).toEqual({ enabled: true, model: "gpt-5.4-mini" });

    expect(
      resolveTextGenerationPlan(
        {
          textGeneration: "off",
          textGenerationModelID: "gpt-5.4",
          textGenerationEffort: "high",
        },
        CATALOG,
      ),
    ).toEqual({ enabled: false });
  });

  it("validates settings:set for textGeneration, textGenerationModelID, and textGenerationEffort", () => {
    expect(
      requestValidators["settings:set"]({
        textGeneration: "codex",
        textGenerationModelID: "gpt-5.4-mini",
        textGenerationEffort: "low",
      }),
    ).toBeTruthy();
    expect(
      requestValidators["settings:set"]({
        textGeneration: "automatic",
        textGenerationModelID: null,
        textGenerationEffort: null,
      }),
    ).toBeTruthy();
    expect(requestValidators["settings:set"]({ textGeneration: "off" })).toBeTruthy();
    expect(() => requestValidators["settings:set"]({ textGeneration: "claude" })).toThrow();
    expect(() => requestValidators["settings:set"]({ textGenerationModelID: "" })).toThrow();
    expect(() => requestValidators["settings:set"]({ textGenerationEffort: "" })).toThrow();
  });

  it("handles KEEP vs updated title replies", () => {
    expect(extractRefreshedTitle("Old title", "KEEP")).toBeNull();
    expect(extractRefreshedTitle("Old title", '"keep"')).toBeNull();
    expect(extractRefreshedTitle("Old title", "Old title")).toBeNull();
    expect(extractRefreshedTitle("Old title", "Refactor auth middleware")).toBe(
      "Refactor auth middleware",
    );
  });
});

describe("P2-18 old store migration", () => {
  it("loads old stores with automatic and off textGeneration values cleanly with identical effect", async () => {
    for (const oldChoice of ["automatic", "off"] as const) {
      const root = tmp(`tivano-p218-old-${oldChoice}-`);
      writeFileSync(
        join(root, "store.json"),
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          projects: [],
          threads: [],
          settings: {
            theme: "breeze",
            language: "en",
            alwaysAllow: [],
            textGeneration: oldChoice,
          },
          ui: { selectedThreadId: null },
        }),
      );
      const store = new Store(root);
      const res = store.open();
      expect(res.recoveredFrom).toBeUndefined();
      expect(store.state.settings.textGeneration).toBe(oldChoice);
      expect(store.state.settings.textGenerationModelID).toBeUndefined();

      const engine = new Engine(store, new MockProvider({ tickMs: 1 }));
      const t = engine.createThread(null);
      engine.sendTurn(t.id, "fix the login flow");
      await new Promise((r) => setTimeout(r, 30));
      const snapTitle = engine.snapshot().threads.find((x) => x.id === t.id)?.title;
      expect(snapTitle).toBe(oldChoice === "automatic" ? "Fix the login flow" : "fix the login flow");

      const commit = await engine.commitMessageFor("M src/app.ts", "diff");
      expect(commit.kind).toBe(oldChoice === "automatic" ? "ok" : "unavailable");
      store.close();
    }
  });
});

describe("P2-18 fake Codex app-server transcript", () => {
  function setupTranscriptRig(opts?: { failTurnStart?: boolean }) {
    const root = tmp("tivano-p218-codex-");
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const cfg: CodexRuntimeConfig = {
      mode: "fixture",
      fixtureScript: "fake-codex-app-server.mjs",
      fixtureNode: process.execPath,
      codexHome,
      codexHomeId: codexHome,
      args: ["-c", 'cli_auth_credentials_store="file"', "app-server"],
      env: { CODEX_HOME: codexHome },
      treeCapability: { supported: false, platform: "win32", reason: "test" },
    };
    const transcript: Array<{
      args: string[];
      messages: Array<Record<string, unknown>>;
    }> = [];
    const bindings = new Map<string, ProviderThreadBinding>();
    const provider = new CodexAppServerProvider({
      config: cfg,
      lookupBinding: (t) => bindings.get(t),
      bindThread: async (t, b) => {
        bindings.set(t, b);
      },
      spawnImpl: (spec) => {
        const entry = { args: [...spec.args], messages: [] as Array<Record<string, unknown>> };
        transcript.push(entry);
        const child = new FakeAppServerChild((msg, c) => {
          entry.messages.push(msg);
          const id = msg.id;
          const method = msg.method as string | undefined;
          const params = (msg.params ?? {}) as Record<string, unknown>;
          if (method === "initialize") {
            c.write({ id, result: { codexHome, userAgent: "fake-codex/0.164.0" } });
          } else if (method === "model/list") {
            c.write({
              id,
              result: {
                data: CATALOG.map((m) => ({
                  id: m.id,
                  displayName: m.name,
                  hidden: false,
                  supportedReasoningEfforts: m.efforts.map((e) => ({ reasoningEffort: e })),
                  defaultReasoningEffort: m.defaultEffort,
                  isDefault: m.isDefault,
                })),
                nextCursor: null,
              },
            });
          } else if (method === "thread/start") {
            c.write({
              id,
              result: {
                thread: {
                  id: "codex-t-1",
                  model: params.model ?? "gpt-5.4",
                  reasoningEffort: null,
                },
              },
            });
          } else if (method === "turn/start") {
            if (opts?.failTurnStart) {
              c.write({ id, error: { code: -32000, message: "synthetic turn/start failure" } });
              return;
            }
            const turnId = "codex-turn-1";
            const usedModel = String(params.model ?? "none");
            const usedEffort = String(params.effort ?? "default");
            const input = Array.isArray(params.input) ? (params.input[0] as { text?: string }) : undefined;
            const promptText = input?.text ?? "";
            const reply = promptText.includes("git commit message")
              ? `Update parser (${usedModel}/${usedEffort})`
              : `Refine ${usedModel} ${usedEffort}`;
            c.write({ id, result: { turn: { id: turnId, status: "inProgress" } } });
            c.write({
              method: "item/agentMessage/delta",
              params: { threadId: "codex-t-1", turnId, itemId: "a1", delta: reply },
            });
            c.write({
              method: "item/completed",
              params: {
                threadId: "codex-t-1",
                turnId,
                item: { type: "agentMessage", id: "a1", text: reply },
              },
            });
            c.write({
              method: "turn/completed",
              params: { threadId: "codex-t-1", turn: { id: turnId, status: "completed" } },
            });
          }
        });
        return child as unknown as ChildProcess;
      },
    });
    const store = new Store(join(root, "store"));
    store.open();
    const engine = new Engine(store, provider);
    return { provider, store, engine, transcript };
  }

  it("Automatic uses the mini-tier constant at low effort and Specific model uses exact selected model + effort", async () => {
    const { provider, store, engine, transcript } = setupTranscriptRig();

    // 1. Automatic commit message: uses CODEX_AUTOMATIC_TEXT_MODEL at low effort, lightweight args, ephemeral read-only.
    const autoCommit = await engine.commitMessageFor("M src/a.ts", "diff --git a/src/a.ts b/src/a.ts");
    expect(autoCommit).toEqual({
      kind: "ok",
      message: `Update parser (${CODEX_AUTOMATIC_TEXT_MODEL}/${CODEX_AUTOMATIC_TEXT_EFFORT})`,
    });
    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.args).toEqual(["fake-codex-app-server.mjs", ...CODEX_ONE_SHOT_CONFIG_ARGS]);
    const autoThreadStart = transcript[0]!.messages.find((m) => m.method === "thread/start");
    const autoTurnStart = transcript[0]!.messages.find((m) => m.method === "turn/start");
    expect((autoThreadStart?.params as Record<string, unknown>)?.ephemeral).toBe(true);
    expect((autoThreadStart?.params as Record<string, unknown>)?.sandbox).toBe("read-only");
    expect((autoThreadStart?.params as Record<string, unknown>)?.approvalPolicy).toBe("never");
    expect((autoThreadStart?.params as Record<string, unknown>)?.model).toBe(CODEX_AUTOMATIC_TEXT_MODEL);
    expect((autoTurnStart?.params as Record<string, unknown>)?.model).toBe(CODEX_AUTOMATIC_TEXT_MODEL);
    expect((autoTurnStart?.params as Record<string, unknown>)?.effort).toBe(CODEX_AUTOMATIC_TEXT_EFFORT);

    // 2. Choose model + effort: sends exact selected model and effort, never the Codex default (gpt-5.4).
    engine.setSettings({
      textGeneration: "codex",
      textGenerationModelID: "gpt-5.4-mini",
      textGenerationEffort: "high",
    });
    const customCommit = await engine.commitMessageFor("M src/b.ts", "diff");
    expect(customCommit).toEqual({
      kind: "ok",
      message: "Update parser (gpt-5.4-mini/high)",
    });
    const customTurnStart = transcript[1]!.messages.find((m) => m.method === "turn/start");
    expect((customTurnStart?.params as Record<string, unknown>)?.model).toBe("gpt-5.4-mini");
    expect((customTurnStart?.params as Record<string, unknown>)?.effort).toBe("high");

    // 3. Choose model with Default effort: omits effort on turn/start, keeps chosen model.
    engine.setSettings({
      textGeneration: "codex",
      textGenerationModelID: "gpt-5.4-mini",
      textGenerationEffort: null,
    });
    const customTitle = await provider.generateTitle("fix login crash", {
      mode: "codex",
      model: "gpt-5.4-mini",
    });
    expect(customTitle).toBe("Refine gpt-5.4-mini default");
    const defaultEffortTurn = transcript[2]!.messages.find((m) => m.method === "turn/start");
    expect((defaultEffortTurn?.params as Record<string, unknown>)?.model).toBe("gpt-5.4-mini");
    expect((defaultEffortTurn?.params as Record<string, unknown>)?.effort).toBeUndefined();

    // 4. Off: spawns nothing for titles or commit messages.
    engine.setSettings({ textGeneration: "off" });
    const offCommit = await engine.commitMessageFor("M src/c.ts", "diff");
    expect(offCommit).toEqual({ kind: "unavailable", reason: "text-generation-off" });
    expect(transcript).toHaveLength(3);

    await provider.dispose();
    store.close();
  });

  it("handles turn/start RPC errors and connection close without unhandled rejections", async () => {
    const { provider, store, engine } = setupTranscriptRig({ failTurnStart: true });
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      engine.setSettings({
        textGeneration: "codex",
        textGenerationModelID: "gpt-5.4-mini",
        textGenerationEffort: "low",
      });
      const title = await provider.generateTitle("fix crash", {
        mode: "codex",
        model: "gpt-5.4-mini",
        effort: "low",
      });
      expect(title).toBeNull();

      const commit = await engine.commitMessageFor("M src/a.ts", "diff");
      expect(commit.kind).toBe("unavailable");
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await provider.dispose();
      store.close();
    }
  });
});

describe("P2-18 TextGenerationPicker UI", () => {
  function renderPicker(
    settingsPatch: Partial<Settings>,
    language: "en" | "zh-Hans" = "en",
    initialOpen = false,
  ): string {
    const settings: Settings = { ...defaultSettings(), language, ...settingsPatch };
    return renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: language },
        createElement(TextGenerationPicker, {
          settings,
          providerMode: "codex",
          initialCatalog: { state: "ready", models: CATALOG },
          initialOpen,
        }),
      ),
    );
  }

  it("renders Automatic, Specific model + effort, and Off in English and zh-Hans", () => {
    const autoEn = renderPicker({ textGeneration: "automatic" }, "en", true);
    expect(autoEn).toContain("Automatic");
    expect(autoEn).toContain("Specific model");
    expect(autoEn).toContain("Choose a model");
    expect(autoEn).toContain("GPT-5.1 Codex Mini");
    expect(autoEn).toContain("at low effort");

    const customEn = renderPicker(
      {
        textGeneration: "codex",
        textGenerationModelID: "gpt-5.4-mini",
        textGenerationEffort: "high",
      },
      "en",
      true,
    );
    expect(customEn).toContain("Codex · GPT-5.4 Mini · High");
    expect(customEn).toContain("Reasoning effort");
    expect(customEn).toContain("Fast, inexpensive models are usually enough.");

    const offZh = renderPicker({ textGeneration: "off" }, "zh-Hans", true);
    expect(offZh).toContain("关闭");
    expect(offZh).toContain("自动");
    expect(offZh).toContain("指定模型");
    expect(offZh).toContain("选择模型");
    expect(offZh).toContain("不生成对话标题、提交信息和输入框预测。");
  });
});
