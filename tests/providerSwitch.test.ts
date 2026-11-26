// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-02 provider switching — per-thread provider routing, staging + Undo
// with original session intact, text handoff + takeover marker on send,
// Hydra pair switching, availability guards, persistence, and UI/i18n.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type {
  AdapterDisposeResult,
  ProviderAdapter,
  ProviderCallbacks,
  ProviderDescriptor,
  ProviderTurnHandle,
  TurnContext,
} from "../src/main/provider";
import { Store } from "../src/main/store";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Composer } from "../src/renderer/components/Composer";
import { ChatView } from "../src/renderer/components/ChatView";
import { clientStore } from "../src/renderer/client";
import { LanguageContext } from "../src/renderer/locale";
import { translate, translateError, translateNotice } from "../src/renderer/i18n";
import type { ChatThread, ProviderMode } from "../src/shared/types";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

class FakeSecondaryProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly startedPrompts: TurnContext[] = [];
  readonly endedSessions: string[] = [];
  readonly rolledBack: string[] = [];
  failNextStart = false;
  holdTurns = false;
  pendingApproval = false;
  private activeCb: ProviderCallbacks | null = null;

  constructor(mode: ProviderMode = "codex", label = "Fake Codex") {
    this.descriptor = {
      id: mode,
      label,
      mode,
      synthetic: true,
    };
  }

  start(ctx: TurnContext, cb: ProviderCallbacks): ProviderTurnHandle {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("SYNTHETIC_START_FAIL");
    }
    this.startedPrompts.push(ctx);
    this.activeCb = cb;
    if (!this.holdTurns) {
      queueMicrotask(() => {
        if (this.pendingApproval) {
          cb.onApproval({
            kind: "action",
            headline: "Allow action?",
            title: "synthetic action",
            symbol: "shield",
            options: [{ id: "once", title: "Allow once", role: "approve", scope: "once" }],
          });
          return;
        }
        cb.onChunk(1, `reply-from-${this.descriptor.mode}`);
        cb.onDone();
      });
    }
    return {
      cancel: () => {},
      resume: () => {
        this.activeCb?.onDone();
      },
    };
  }

  finishHeld(): void {
    this.activeCb?.onChunk(1, `held-done-${this.descriptor.mode}`);
    this.activeCb?.onDone();
  }

  endSession(threadId: string): void {
    this.endedSessions.push(threadId);
  }

  async rollback(localThreadId: string): Promise<string | null> {
    this.rolledBack.push(localThreadId);
    return null;
  }

  async dispose(): Promise<AdapterDisposeResult> {
    return { children: [], orphanedPending: 0 };
  }
}

function makeMultiProviderEngine(root: string, opts?: { withProject?: boolean }) {
  const store = new Store(root);
  store.open();
  const wsDir = opts?.withProject ? tmp("tivano-ps-ws-") : undefined;
  const paths = wsDir
    ? new ProjectRuntimePaths([wsDir], join(root, "grants.json"), root)
    : undefined;
  const codex = new FakeSecondaryProvider("codex", "Codex (fake)");
  const mock = new MockProvider({ tickMs: 1 });
  const engine = new Engine(store, codex, root, "0.0.0-test", paths, undefined, [mock]);
  let projectId: string | null = null;
  if (wsDir) {
    const proj = engine.createProject("Proj");
    engine.registerWorkspace(proj.id, wsDir);
    projectId = proj.id;
  }
  return { store, engine, codex, mock, projectId };
}

describe("P2-02 provider switching", () => {
  it("stages switch on a started chat without ending the old session, and Undo restores it intact", async () => {
    const root = tmp("tivano-ps-undo-");
    const { engine, codex, store, projectId } = makeMultiProviderEngine(root, {
      withProject: true,
    });
    const thread = engine.createThread(projectId, "Chat");
    engine.setThreadModel(thread.id, "gpt-5.4", "high", "fast");
    await engine.bindProviderThread(thread.id, {
      providerId: "codex",
      codexThreadId: "cx-original-1",
      cwd: root,
      codexHomeId: "h1",
      schemaPin: "1",
      cliVersion: "0",
      savedAt: Date.now(),
    });
    engine.sendTurn(thread.id, "first turn");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "done");

    const beforeMsgs = engine.snapshot().threads[0]!.messages.length;
    engine.setThreadProvider(thread.id, "mock", { hydraPairId: null });

    const staged = engine.snapshot().threads[0]!;
    expect(staged.provider).toBe("mock");
    expect(staged.codexModel).toBeUndefined();
    expect(staged.providerThread).toBeUndefined();
    expect(staged.pendingProviderSwitch?.provider).toBe("codex");
    expect(staged.pendingProviderSwitch?.codexModel).toBe("gpt-5.4");
    expect(staged.pendingProviderSwitch?.codexEffort).toBe("high");
    expect(staged.pendingProviderSwitch?.codexServiceTier).toBe("fast");
    expect(staged.pendingProviderSwitch?.providerThread?.codexThreadId).toBe("cx-original-1");
    expect(staged.messages.length).toBe(beforeMsgs);
    expect(codex.endedSessions).toEqual([]);

    // Persists across restart/reload before Undo.
    store.close();
    const store2 = new Store(root);
    store2.open();
    const mock2 = new MockProvider({ tickMs: 1 });
    const codex2 = new FakeSecondaryProvider("codex", "Codex (fake)");
    const engine2 = new Engine(store2, codex2, root, "0.0.0-test", undefined, undefined, [mock2]);
    expect(engine2.snapshot().threads[0]?.pendingProviderSwitch?.providerThread?.codexThreadId).toBe(
      "cx-original-1",
    );

    engine2.undoProviderSwitch(thread.id);
    const restored = engine2.snapshot().threads[0]!;
    expect(restored.pendingProviderSwitch).toBeUndefined();
    expect(restored.provider).toBe("codex");
    expect(restored.codexModel).toBe("gpt-5.4");
    expect(restored.codexEffort).toBe("high");
    expect(restored.codexServiceTier).toBe("fast");
    expect(restored.providerThread?.codexThreadId).toBe("cx-original-1");
    store2.close();
  });

  it("delivers recent conversation as text and inserts takeover marker on send", async () => {
    const root = tmp("tivano-ps-handoff-");
    const { engine, codex, projectId } = makeMultiProviderEngine(root, {
      withProject: true,
    });
    const thread = engine.createThread(projectId, "Handoff Chat");
    await engine.bindProviderThread(thread.id, {
      providerId: "codex",
      codexThreadId: "cx-orig-2",
      cwd: root,
      codexHomeId: "h1",
      schemaPin: "1",
      cliVersion: "0",
      savedAt: Date.now(),
    });
    engine.sendTurn(thread.id, "alpha question");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "done");

    engine.setThreadProvider(thread.id, "mock");
    engine.sendTurn(thread.id, "beta followup");
    await waitFor(() => {
      const t = engine.snapshot().threads[0]!;
      return t.turn?.status === "done" && !t.pendingProviderSwitch;
    });

    const after = engine.snapshot().threads[0]!;
    expect(codex.endedSessions).toContain(thread.id);
    expect(after.provider).toBe("mock");
    expect(after.pendingProviderSwitch).toBeUndefined();

    const noticeIdx = after.messages.findIndex(
      (m) => m.kind === "notice" && m.content === "Continued with Mock Provider",
    );
    const betaIdx = after.messages.findIndex(
      (m) => m.role === "user" && m.content === "beta followup",
    );
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeLessThan(betaIdx);

    const mockReply = after.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(mockReply.content).toContain("The conversation continues in this same thread.");
    expect(mockReply.content).toContain("----- BEGIN FORWARDED CONTEXT -----");
    expect(mockReply.content).toContain("User: alpha question");
    expect(mockReply.content).toContain("Assistant: reply-from-codex");
  });

  it("switches to another provider's Hydra pair and Undo restores the prior Hydra choice", async () => {
    const root = tmp("tivano-ps-pair-");
    const { engine, projectId } = makeMultiProviderEngine(root, { withProject: true });
    engine.setSettings({
      hydraPairs: [
        {
          id: "pair-codex",
          provider: "codex",
          orchestratorModel: "gpt-5.4",
          orchestratorEffort: "medium",
          headProfiles: [],
        },
        {
          id: "pair-mock",
          provider: "mock",
          headProfiles: [],
        },
      ],
    });
    const thread = engine.createThread(projectId, "Hydra Chat");
    engine.setThreadProvider(thread.id, "codex", {
      model: "gpt-5.4",
      effort: "medium",
      hydraPairId: "pair-codex",
    });
    engine.sendTurn(thread.id, "start hydra chat");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "done");

    engine.setThreadProvider(thread.id, "mock", {
      model: null,
      effort: null,
      hydraPairId: "pair-mock",
    });
    const staged = engine.snapshot().threads[0]!;
    expect(staged.provider).toBe("mock");
    expect(staged.hydraPairId).toBe("pair-mock");
    expect(staged.pendingProviderSwitch?.hydraPairId).toBe("pair-codex");

    engine.undoProviderSwitch(thread.id);
    const undone = engine.snapshot().threads[0]!;
    expect(undone.provider).toBe("codex");
    expect(undone.hydraPairId).toBe("pair-codex");
    expect(undone.codexModel).toBe("gpt-5.4");
    expect(undone.codexEffort).toBe("medium");
  });

  it("refuses switching while a turn, pending request, or Hydra heads are running", async () => {
    const root = tmp("tivano-ps-lock-");
    const { engine, codex, projectId } = makeMultiProviderEngine(root, {
      withProject: true,
    });
    const thread = engine.createThread(projectId, "Busy Chat");
    codex.holdTurns = true;
    engine.sendTurn(thread.id, "running turn");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "running");
    expect(() => engine.setThreadProvider(thread.id, "mock")).toThrow(/running turn/);
    codex.finishHeld();
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "done");

    // Pending approval request blocks switching.
    codex.holdTurns = false;
    codex.pendingApproval = true;
    engine.sendTurn(thread.id, "wait approval");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "waiting-approval");
    expect(() => engine.setThreadProvider(thread.id, "mock")).toThrow(/running turn|pending/);
    const approvalId = engine.snapshot().threads[0]!.turn!.approval!.id;
    engine.resolveApproval(thread.id, approvalId, "once");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "done");

    // Running Hydra head blocks switching providers on the lead thread.
    engine.setThreadProvider(thread.id, "mock");
    engine.sendTurn(thread.id, "[mock:hydra-wait] spawn held head");
    await waitFor(() =>
      engine.snapshot().threads.some(
        (t) => t.hydraHead?.leadId === thread.id && t.turn?.status === "waiting-approval",
      ),
    );
    await waitFor(() => engine.snapshot().threads.find((t) => t.id === thread.id)?.turn?.status === "done");
    expect(() => engine.setThreadProvider(thread.id, "codex")).toThrow(/sub-agents/);
    const head = engine.snapshot().threads.find((t) => t.hydraHead?.leadId === thread.id)!;
    engine.stopHydraHead(head.id);
    await waitFor(() => !engine.hydraLeadBusy(thread.id));
  });

  it("keeps pending switch undoable on pre-provider failure and clears stale session on revert", async () => {
    // Engine without task-workspace root: project-less switch to codex fails
    // pre-provider with WORKSPACE_NOT_CONFIGURED (retainUnsent).
    const noPaths = makeMultiProviderEngine(tmp("tivano-ps-nopaths-"));
    const noProj = noPaths.engine.createThread(null, "NoProj");
    noPaths.engine.setThreadProvider(noProj.id, "mock");
    noPaths.engine.sendTurn(noProj.id, "hi mock");
    await waitFor(() => noPaths.engine.snapshot().threads.find((t) => t.id === noProj.id)?.turn?.status === "done");
    noPaths.engine.setThreadProvider(noProj.id, "codex");
    // Send fails pre-provider with WORKSPACE_NOT_CONFIGURED (retainUnsent).
    noPaths.engine.sendTurn(noProj.id, "fails workspace");
    const afterFail = noPaths.engine.snapshot().threads.find((t) => t.id === noProj.id)!;
    expect(afterFail.pendingProviderSwitch?.provider).toBe("mock");
    expect(afterFail.continuation).toBeUndefined();
    noPaths.engine.undoProviderSwitch(noProj.id);
    expect(noPaths.engine.snapshot().threads.find((t) => t.id === noProj.id)?.provider).toBe("mock");
    noPaths.store.close();

    // Revert while a switch is staged reverts locally and clears origin.providerThread.
    const root = tmp("tivano-ps-edge-");
    const { engine, codex, projectId, store } = makeMultiProviderEngine(root, {
      withProject: true,
    });
    const projThread = engine.createThread(projectId, "Revert While Staged");
    await engine.bindProviderThread(projThread.id, {
      providerId: "codex",
      codexThreadId: "cx-rev-1",
      cwd: root,
      codexHomeId: "h1",
      schemaPin: "1",
      cliVersion: "0",
      savedAt: Date.now(),
    });
    engine.sendTurn(projThread.id, "turn 1");
    await waitFor(() => engine.snapshot().threads.find((t) => t.id === projThread.id)?.turn?.status === "done");
    const turnId = engine.snapshot().threads.find((t) => t.id === projThread.id)!.turn!.id;
    engine.setThreadProvider(projThread.id, "mock");
    await engine.revertTurn(projThread.id, turnId);
    const reverted = engine.snapshot().threads.find((t) => t.id === projThread.id)!;
    expect(codex.rolledBack).toEqual([]);
    expect(reverted.pendingProviderSwitch?.providerThread).toBeUndefined();
    store.close();
  });

  it("renders ProviderSwitchTab warning + Undo and localizes strings in en and zh-Hans", () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async () => ({}),
        onEvent: () => () => {},
      },
    };
    try {
    const thread: ChatThread = {
      id: "t-ui-1",
      projectId: "p-1",
      title: "UI",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      turn: null,
      sessionGrants: [],
      provider: "mock",
      pendingProviderSwitch: {
        provider: "codex",
        codexModel: "gpt-5.4",
      },
    };
    const renderComposer = (lang: "en" | "zh-Hans", switchLocked = false) =>
      renderToStaticMarkup(
        createElement(
          LanguageContext.Provider,
          { value: lang },
          createElement(Composer, {
            thread,
            mode: "codex",
            info: {
              mode: "codex",
              providerId: "codex",
              providerLabel: "Codex",
              providers: [
                { id: "codex", mode: "codex", label: "Codex" },
                { id: "mock", mode: "mock", label: "Mock Provider" },
              ],
            },
            hydraHeadsRunning: switchLocked,
          }),
        ),
      );
    const enHtml = renderComposer("en");
    expect(enHtml).toContain("Context may be incomplete after switching providers");
    expect(enHtml).toContain("Undo");
    expect(enHtml).toContain("Back to Codex · gpt-5.4");

    const zhHtml = renderComposer("zh-Hans");
    expect(zhHtml).toContain("切换服务商后，上下文可能不完整");
    expect(zhHtml).toContain("撤销");
    expect(zhHtml).toContain("回到 Codex · gpt-5.4");

    const lockedHtml = renderComposer("en", true);
    expect(lockedHtml).toContain('class="provider-switch-undo" disabled=""');
    expect(lockedHtml).toContain('class="provider-select" aria-label="Provider" title="Provider — applies to the next turn" disabled=""');

    const zhT = (k: string, ...vars: string[]) => translate("zh-Hans", k, vars);
    expect(translateNotice(zhT, "Continued with Mock Provider")).toBe(
      "以下由 Mock Provider 接力",
    );
    expect(translateError(zhT, "sub-agents cannot switch providers")).toBe("子代理不能切换服务商");
    expect(translateError(zhT, "switch providers after the running turn finishes")).toBe("请在当前回合完成后切换服务商");
    expect(translateError(zhT, "resolve the pending request before switching providers")).toBe("请先处理待确认请求后再切换服务商");
    expect(translateError(zhT, "switch providers when the chat is idle")).toBe("请在对话空闲时切换服务商");
    expect(translateError(zhT, "switch providers when no sub-agents are at work")).toBe("请在没有子代理运行时切换服务商");
    expect(translateError(zhT, 'provider "codex" is not available in this launch')).toBe('本次启动未启用服务商“codex”');
    expect(translateError(zhT, 'provider "codex" is not available')).toBe('服务商“codex”不可用');
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWindow;
    }
  });

  it("restores origin model, effort, tier, Hydra choice, and session when reselecting origin provider", async () => {
    const root = tmp("tivano-ps-reselect-");
    const { engine, store, projectId } = makeMultiProviderEngine(root, { withProject: true });
    engine.setSettings({
      hydraPairs: [
        { id: "pair-cx", provider: "codex", orchestratorModel: "gpt-5.4", orchestratorEffort: "high", headProfiles: [] },
      ],
    });
    const thread = engine.createThread(projectId, "Reselect");
    engine.setThreadProvider(thread.id, "codex", {
      model: "gpt-5.4",
      effort: "high",
      fastTier: "fast",
      hydraPairId: "pair-cx",
    });
    await engine.bindProviderThread(thread.id, {
      providerId: "codex",
      codexThreadId: "cx-reselect-1",
      cwd: root,
      codexHomeId: "h1",
      schemaPin: "1",
      cliVersion: "0",
      savedAt: Date.now(),
    });
    engine.sendTurn(thread.id, "turn 1");
    await waitFor(() => engine.snapshot().threads[0]?.turn?.status === "done");

    // Stage switch to mock (like ModelPicker does), then reselect plain codex (hydraPairId: null).
    engine.setThreadProvider(thread.id, "mock", { hydraPairId: null });
    expect(engine.snapshot().threads[0]?.pendingProviderSwitch?.provider).toBe("codex");
    engine.setThreadProvider(thread.id, "codex", { hydraPairId: null });

    const restored = engine.snapshot().threads[0]!;
    expect(restored.pendingProviderSwitch).toBeUndefined();
    expect(restored.provider).toBe("codex");
    expect(restored.codexModel).toBe("gpt-5.4");
    expect(restored.codexEffort).toBe("high");
    expect(restored.codexServiceTier).toBe("fast");
    expect(restored.hydraEnabled).toBe(true);
    expect(restored.hydraPairId).toBe("pair-cx");
    expect(restored.subagentMode).toBe("preset");
    expect(restored.providerThread?.codexThreadId).toBe("cx-reselect-1");
    store.close();
  });

  it("gates /compact, header badge, and Continue affordance on thread effective provider", async () => {
    const root = tmp("tivano-ps-ui-");
    const store = new Store(root);
    store.open();
    const codexCompact: ProviderAdapter = {
      descriptor: { id: "codex", label: "Codex", mode: "codex", synthetic: true, compact: true },
      start: (_ctx, cb) => {
        queueMicrotask(() => cb.onDone());
        return { cancel: () => {}, resume: () => {} };
      },
      compact: async () => {},
      dispose: async () => ({ children: [], orphanedPending: 0 }),
    };
    const mock = new MockProvider({ tickMs: 1 });
    const engine = new Engine(store, codexCompact, root, "0.0.0-test", undefined, undefined, [mock]);
    const info = engine.info;
    const baseSnap = engine.snapshot();
    expect(info.providers).toEqual([
      { id: "codex", mode: "codex", label: "Codex", supportsCompact: true },
      { id: "mock", mode: "mock", label: mock.descriptor.label },
    ]);
    store.close();

    const prevWindow = (globalThis as { window?: unknown }).window;
    const calls: { channel: string; payload: unknown }[] = [];
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async (channel: string, payload: unknown) => {
          calls.push({ channel, payload });
          return {};
        },
        onEvent: () => () => {},
      },
    };
    const prevSnapshot = clientStore.snapshot;
    try {
      const switchedThread: ChatThread = {
        id: "t-switched",
        projectId: "p-1",
        title: "Switched",
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        turn: {
          id: "turn-err",
          threadId: "t-switched",
          status: "error",
          seq: 0,
          startedAt: 1,
          assistantMessageId: "m-1",
          error: "failed",
        },
        sessionGrants: [],
        provider: "mock",
      };
      const chatHtml = renderToStaticMarkup(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(ChatView, {
            thread: switchedThread,
            providerLabel: "Codex",
            mode: "codex",
            codex: { state: "fixture", protocolPin: "0.164.0", cliVersion: "0" },
          }),
        ),
      );
      expect(chatHtml).toContain("Mock Provider");
      expect(chatHtml).not.toContain("Codex fixture");
      expect(chatHtml).toContain("Continue");

      // /compact on a thread switched from Codex to Mock falls through to turns:send
      // and is omitted from Composer slash suggestions.
      clientStore.snapshot = {
        ...baseSnap,
        info,
        threads: [switchedThread],
      };
      clientStore.setDraft(switchedThread.id, "/compact");
      await clientStore.sendDraft(switchedThread.id);
      expect(calls.some((c) => c.channel === "threads:compact")).toBe(false);
      expect(calls.some((c) => c.channel === "turns:send")).toBe(true);

      const composerHtml = renderToStaticMarkup(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(Composer, {
            thread: switchedThread,
            mode: "codex",
            info,
          }),
        ),
      );
      expect(composerHtml).toBeTruthy();
    } finally {
      clientStore.snapshot = prevSnapshot;
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});
