// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-01 Codex one-shot prediction tests against the offline Codex app-server
// fixture: lightweight args, JSON suggestion extraction, failure/empty/invalid
// resilience, and unconfigured mode returning null.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerProvider } from "../src/main/codexAppServerProvider";
import type { CodexRuntimeConfig } from "../src/main/codexRuntimeConfig";
import { Engine } from "../src/main/engine";
import { Store } from "../src/main/store";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-codex-pred-"));
  roots.push(d);
  return d;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureConfig(codexHome: string): CodexRuntimeConfig {
  return {
    mode: "fixture",
    fixtureScript: FIXTURE,
    fixtureNode: NODE,
    codexHome,
    codexHomeId: codexHome,
    args: ["app-server"],
    env: { CODEX_HOME: codexHome },
    treeCapability: { supported: false, platform: "darwin", reason: "test" },
  };
}

describe("P2-01 CodexAppServerProvider.generateNextPrompt", () => {
  it("runs lightweight one-shot prediction via the Codex fixture and feeds Engine.predictNextPrompt", async () => {
    const root = freshRoot();
    const codexHome = freshRoot();
    const store = new Store(root);
    store.open();
    const provider = new CodexAppServerProvider({
      config: fixtureConfig(codexHome),
      lookupBinding: () => undefined,
      bindThread: async () => {},
    });
    const engine = new Engine(store, provider, root, "0.0.0-test");
    try {
      const raw = await provider.generateNextPrompt(
        "First request: check\nUser: hello [mock:predict:Run vitest now]\nAssistant: done",
      );
      expect(raw).toBe('{"suggestion":"Run vitest now"}');

      expect(
        await provider.generateNextPrompt("User: [mock:predict-empty]\nAssistant: ok"),
      ).toBe('{"suggestion":null}');
      expect(
        await provider.generateNextPrompt("User: [mock:predict-invalid]\nAssistant: ok"),
      ).toBe("not valid json");
      expect(
        await provider.generateNextPrompt("User: [mock:predict-fail]\nAssistant: ok"),
      ).toBeNull();

      // Wire through Engine.predictNextPrompt on a completed thread.
      const t = engine.createThread(null, "CodexPred");
      const turnId = "11111111-1111-4111-8111-111111111111";
      const th = store.state.threads.find((x) => x.id === t.id)!;
      th.turn = {
        id: turnId,
        threadId: t.id,
        status: "done",
        seq: 1,
        startedAt: Date.now(),
        assistantMessageId: "m-asst",
      };
      th.messages.push(
        {
          id: "m-user",
          role: "user",
          content: "fix bug [mock:predict:Inspect the diff]",
          status: "done",
          turnId,
          ts: Date.now(),
        },
        {
          id: "m-asst",
          role: "assistant",
          content: "Fixed it.",
          status: "done",
          turnId,
          ts: Date.now(),
        },
      );
      expect(await engine.predictNextPrompt(t.id, turnId)).toEqual({
        prediction: "Inspect the diff",
      });
    } finally {
      await provider.dispose();
    }
  });

  it("returns null cleanly when Codex runtime is unconfigured", async () => {
    const provider = new CodexAppServerProvider({
      config: {
        mode: "unconfigured",
        codexHome: "/none",
        codexHomeId: "/none",
        args: ["app-server"],
        env: {},
        treeCapability: { supported: false, platform: "win32", reason: "test" },
      },
      lookupBinding: () => undefined,
      bindThread: async () => {},
    });
    expect(await provider.generateNextPrompt("User: hi\nAssistant: ok")).toBeNull();
  });
});
