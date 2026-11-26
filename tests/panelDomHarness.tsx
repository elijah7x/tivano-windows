// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Browser-side harness for the P2-40 DOM tests: it mounts the real React
// components in Chromium and exposes small fixture/commit helpers to the
// Playwright-driven test runner. The tivano bridge is stubbed by index.html.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/renderer/components/ChatView";
import { HelperPanel } from "../src/renderer/components/HelperPanel";
import type { ChatThread, Settings } from "../src/shared/types";

const root = createRoot(document.getElementById("root")!);
let mountKey = 0;
let closeCalls = 0;

function lead(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "lead",
    projectId: null,
    title: "Lead chat",
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    turn: null,
    sessionGrants: [],
    ...over,
  } as ChatThread;
}

function head(index: number, status: "running" | "completed" = "running"): ChatThread {
  return {
    id: `head-${index}`,
    projectId: null,
    title: `Head ${index}`,
    createdAt: index,
    updatedAt: index,
    messages: [],
    turn: status === "running" ? ({ status: "running" } as ChatThread["turn"]) : null,
    sessionGrants: [],
    hydraHead: {
      leadId: "lead",
      headIndex: index,
      name: `Walter ${index}`,
      task: "work",
      batchId: "b",
      status,
      spawnedAt: index,
    },
  } as ChatThread;
}

function helper(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "helper-1",
    projectId: null,
    title: "Helper",
    createdAt: 100,
    updatedAt: 100,
    messages: [],
    turn: { status: "running" } as ChatThread["turn"],
    sessionGrants: [],
    parentThreadId: "lead",
    isInPanel: false,
    ...over,
  } as ChatThread;
}

function commit(node: ReactNode): void {
  flushSync(() => root.render(node));
}

interface ChatScene {
  settings: Partial<Settings>;
  threads: ChatThread[];
}

function chatNode(scene: ChatScene, key: number): ReactNode {
  const thread =
    scene.threads.find((t) => !t.parentThreadId && !t.hydraHead) ?? scene.threads[0]!;
  return (
    <ChatView
      key={key}
      thread={thread}
      threads={scene.threads}
      providerLabel="Mock"
      mode="mock"
      settings={scene.settings as Settings}
    />
  );
}

const harness = {
  lead,
  head,
  helper,
  async mountChat(scene: ChatScene): Promise<true> {
    mountKey += 1;
    commit(chatNode(scene, mountKey));
    return true;
  },
  async updateChat(scene: ChatScene): Promise<true> {
    commit(chatNode(scene, mountKey));
    return true;
  },
  async mountHelperPanel(thread: ChatThread): Promise<true> {
    mountKey += 1;
    closeCalls = 0;
    commit(
      <HelperPanel
        key={mountKey}
        thread={thread}
        parentTitle="Lead chat"
        readOnly={false}
        onDock={() => {}}
        onClose={() => {
          closeCalls += 1;
        }}
      />,
    );
    return true;
  },
  invocations(): unknown {
    return (window as unknown as { __invocations?: unknown[] }).__invocations ?? [];
  },
  clearInvocations(): void {
    (window as unknown as { __invocations?: unknown[] }).__invocations = [];
  },
  closeCalls(): number {
    return closeCalls;
  },
};

(window as unknown as { __panelHarness: typeof harness }).__panelHarness = harness;
