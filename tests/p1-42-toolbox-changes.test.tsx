// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-42 Toolbox changes: inline Commit / Push / Create pull request under
// the chat's changes, gated on the live Git snapshot with honest reasons,
// never firing on its own. Synthetic remotes and snapshots only.

import { act, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMImplementation } from "@xmldom/xmldom";
import { afterEach, describe, expect, it } from "vitest";
import type { TivanoApi } from "../src/renderer/client";
import {
  ToolboxChanges,
  ToolboxGitActions,
  toolboxGitGate,
  type ToolboxGitGate,
} from "../src/renderer/components/ToolboxChanges";
import { ThreadChangesTab } from "../src/renderer/components/ThreadChangesTab";
import { translate } from "../src/renderer/i18n";
import { LanguageContext } from "../src/renderer/locale";
import { parseForgeRemote, pullRequestUrl } from "../src/shared/pullRequestUrl";
import type { GitSnapshot } from "../src/shared/types";

const REMOTE = "https://github.com/example-org/sample-repo.git";

type Branch = NonNullable<GitSnapshot["branch"]>;
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
function snap(over: Loose<GitSnapshot> = {}, branch: Loose<Branch> = {}): GitSnapshot {
  const b: Record<string, unknown> = {
    name: "feature/toolbox",
    detached: false,
    unborn: false,
    upstream: "origin/feature/toolbox",
    ahead: 0,
    behind: 0,
    ...branch,
  };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return {
    snapshotId: "snap-1",
    projectId: "prj-1",
    capturedAt: 1,
    kind: "ready",
    branch: b as unknown as Branch,
    entries: [{ path: "src/a.ts" } as GitSnapshot["entries"][number]],
    remoteUrl: REMOTE,
    ...over,
  } as GitSnapshot;
}

describe("P1-42 pull-request URL from the origin remote", () => {
  it("parses https, ssh:// and scp-style GitHub remotes", () => {
    for (const r of [
      "https://github.com/example-org/sample-repo.git",
      "https://github.com/example-org/sample-repo",
      "ssh://git@github.com/example-org/sample-repo.git",
      "git@github.com:example-org/sample-repo.git",
    ]) {
      expect(parseForgeRemote(r), r).toEqual({
        forge: "github",
        origin: "https://github.com",
        repoPath: "example-org/sample-repo",
      });
    }
  });

  it("drops credentials embedded in the remote", () => {
    const url = pullRequestUrl("https://user:synthetic-token@github.com/example-org/sample-repo.git", "main");
    expect(url).toBe("https://github.com/example-org/sample-repo/compare/main?expand=1");
    expect(url).not.toContain("synthetic-token");
    expect(url).not.toContain("user");
  });

  it("builds GitHub compare and GitLab merge-request pages with encoded branches", () => {
    expect(pullRequestUrl(REMOTE, "feature/a b#1")).toBe(
      "https://github.com/example-org/sample-repo/compare/feature/a%20b%231?expand=1",
    );
    expect(pullRequestUrl("git@gitlab.com:group/sub/sample.git", "feat/x")).toBe(
      "https://gitlab.com/group/sub/sample/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx",
    );
  });

  it("refuses local paths, file URLs, unknown hosts and missing branches", () => {
    for (const r of [
      "C:\\synthetic\\repos\\sample",
      "/synthetic/repos/sample.git",
      "file:///synthetic/repos/sample.git",
      "https://git.example.test/example-org/sample-repo.git",
      "https://github.com/only-owner",
      "https://github.com/a/b/c",
      "https://github.com/a/../b",
      "",
    ]) {
      expect(pullRequestUrl(r, "main"), r).toBeUndefined();
    }
    expect(pullRequestUrl(REMOTE, null)).toBeUndefined();
    expect(pullRequestUrl(REMOTE, "  ")).toBeUndefined();
  });
});

describe("P1-42 inline Git action gate", () => {
  it("enables commit and pull request on a pushed branch with changes", () => {
    const g = toolboxGitGate(snap(), {});
    expect(g.blocked).toBeUndefined();
    expect(g.commit).toEqual({ enabled: true });
    expect(g.push).toEqual({ enabled: false, reason: "Nothing to push" });
    expect(g.pullRequest).toEqual({
      enabled: true,
      url: "https://github.com/example-org/sample-repo/compare/feature/toolbox?expand=1",
    });
  });

  it("names a reason for every disabled action", () => {
    expect(toolboxGitGate(snap({ entries: [] }), {}).commit).toEqual({ enabled: false, reason: "No changes to commit" });
    const ahead = toolboxGitGate(snap({}, { ahead: 2 }), {});
    expect(ahead.push).toEqual({ enabled: true });
    expect(ahead.pullRequest).toEqual({ enabled: false, reason: "Push your commits first" });
    const unpushed = toolboxGitGate(snap({}, { upstream: undefined, ahead: undefined }), {});
    expect(unpushed.push).toEqual({ enabled: true });
    expect(unpushed.pullRequest).toEqual({ enabled: false, reason: "Push this branch first" });
    const detached = toolboxGitGate(snap({}, { detached: true, name: null }), {});
    expect(detached.push).toEqual({ enabled: false, reason: "Switch to a branch first" });
    expect(detached.pullRequest).toEqual({ enabled: false, reason: "Switch to a branch first" });
    const unborn = toolboxGitGate(snap({}, { unborn: true }), {});
    expect(unborn.push).toEqual({ enabled: false, reason: "Switch to a branch first" });
    const noRemote = toolboxGitGate(snap({ remoteUrl: undefined }), {});
    expect(noRemote.push).toEqual({ enabled: false, reason: "Add an origin remote first" });
    expect(noRemote.pullRequest).toEqual({ enabled: false, reason: "Add an origin remote first" });
    const other = toolboxGitGate(snap({ remoteUrl: "https://git.example.test/a/b.git" }), {});
    expect(other.push).toEqual({ enabled: false, reason: "Nothing to push" });
    expect(other.pullRequest).toEqual({
      enabled: false,
      reason: "Pull requests can be opened for GitHub and GitLab remotes only",
    });
  });

  it("blocks the whole row for worktree chats, running replies, read-only windows and non-repositories", () => {
    const cases: [ToolboxGitGate, string][] = [
      [toolboxGitGate(snap(), { worktree: true }), "Inline Git actions are not available for worktree chats yet"],
      [toolboxGitGate(snap(), { running: true }), "Wait for the reply to finish"],
      [toolboxGitGate(snap(), { readOnly: true }), "This window is read-only"],
      [toolboxGitGate(snap({ kind: "not-repository" }), {}), "Git is not available for this project"],
      [toolboxGitGate(null, {}), "Loading"],
    ];
    for (const [g, reason] of cases) {
      expect(g.blocked).toBe(reason);
      expect([g.commit.enabled, g.push.enabled, g.pullRequest.enabled]).toEqual([false, false, false]);
    }
  });
});

type BtnProps = { disabled?: boolean; title?: string; onClick?: () => void; children?: ReactNode };
function buttons(node: ReactNode, out: BtnProps[] = []): BtnProps[] {
  if (Array.isArray(node)) {
    for (const n of node) buttons(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<BtnProps>;
  if (el.type === "button") out.push(el.props);
  buttons(el.props.children, out);
  return out;
}

describe("P1-42 inline action row", () => {
  const en = (k: string, ...v: string[]) => translate("en", k, v);

  it("renders the three actions with translated disabled reasons", () => {
    const html = renderToStaticMarkup(
      createElement(ToolboxGitActions, {
        t: (k, ...v) => translate("zh-Hans", k, v),
        gate: toolboxGitGate(snap({ entries: [] }, { upstream: undefined, ahead: undefined }), {}),
        busy: false,
        note: null,
        onCommit: () => {},
        onPush: () => {},
        onPullRequest: () => {},
      }),
    );
    expect(html).toContain("提交…");
    expect(html).toContain("推送");
    expect(html).toContain("创建拉取请求");
    expect(html).toContain('title="没有可提交的改动"');
    expect(html).toContain('title="请先推送此分支"');
  });

  it("fires an action only through its click and hands the compare URL to the PR action", () => {
    const calls: string[] = [];
    const tree = ToolboxGitActions({
      t: en,
      gate: toolboxGitGate(snap(), {}),
      busy: false,
      note: null,
      onCommit: () => calls.push("commit"),
      onPush: () => calls.push("push"),
      onPullRequest: (url) => calls.push(`pr:${url}`),
    });
    expect(calls).toEqual([]);
    const [commit, push, pr] = buttons(tree);
    expect(push!.disabled).toBe(true);
    expect(push!.title).toBe("Nothing to push");
    commit!.onClick!();
    pr!.onClick!();
    expect(calls).toEqual([
      "commit",
      "pr:https://github.com/example-org/sample-repo/compare/feature/toolbox?expand=1",
    ]);
  });

  it("keeps every catalog translation for the new keys", () => {
    for (const k of [
      "Git actions",
      "Inline Git actions are not available for worktree chats yet",
      "Pull requests can be opened for GitHub and GitLab remotes only",
      "Couldn't open the pull request page",
    ]) {
      for (const lang of ["zh-Hans", "zh-Hant", "ja", "ko", "fr"] as const) {
        expect(translate(lang, k), `${lang}: ${k}`).not.toBe(k);
      }
    }
    expect(translate("zh-Hans", "Nothing to push")).toBe("没有需要推送的内容");
  });
});

// Mount harness: same approach as p2-53-chrome — an XML document from the
// existing dev dependency tree with the few event hooks React touches stubbed.
type GlobalSlots = { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const prevWindow = (globalThis as GlobalSlots).window;
const prevDocument = (globalThis as GlobalSlots).document;
const prevAct = (globalThis as GlobalSlots).IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
  const g = globalThis as GlobalSlots;
  if (prevWindow === undefined) delete g.window;
  else g.window = prevWindow;
  if (prevDocument === undefined) delete g.document;
  else g.document = prevDocument;
  if (prevAct === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = prevAct;
});

function setProp(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}
function stubEvents(target: object): void {
  setProp(target, "addEventListener", () => {});
  setProp(target, "removeEventListener", () => {});
  setProp(target, "dispatchEvent", () => true);
}
function mountDom(invoke: TivanoApi["invoke"]): Document {
  const doc = new DOMImplementation().createDocument(null, "html", null) as Document;
  const createText = doc.createTextNode.bind(doc);
  setProp(doc, "createTextNode", (data: string) => {
    const node = createText(data);
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
  stubEvents(doc);
  function HTMLIFrameElement(): void {}
  const win = {
    document: doc,
    HTMLIFrameElement,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    tivano: { platform: "win32", invoke, onEvent: () => () => {} } satisfies TivanoApi,
  };
  setProp(doc, "defaultView", win);
  const g = globalThis as GlobalSlots;
  g.document = doc;
  g.window = win;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return doc;
}

/** Click through React's own props on the host node (no DOM event system here). */
function click(el: Element): void {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = key ? (el as unknown as Record<string, { onClick?: () => void }>)[key] : undefined;
  props?.onClick?.();
}
function buttonByText(doc: Document, root: Element, text: string): Element {
  const all = Array.from(root.getElementsByTagName("button"));
  const hit = all.find((b) => b.textContent === text);
  if (!hit) throw new Error(`no button "${text}" in ${root.toString()}`);
  void doc;
  return hit;
}

describe("P1-42 live Toolbox changes section", () => {
  it("hydrates the snapshot without firing any action, then pushes and opens the PR page on click", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    let current = snap({}, { ahead: 1 });
    const doc = mountDom(async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "git:overview") return current;
      if (channel === "git:push") {
        current = snap({}, { ahead: 0 });
        return { kind: "pushed" };
      }
      if (channel === "git:refresh") return current;
      if (channel === "links:open-external") return undefined;
      throw new Error(`unexpected IPC channel: ${channel}`);
    });
    const container = doc.createElement("div");
    stubEvents(container);
    doc.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          LanguageContext.Provider,
          { value: "en" },
          createElement(ToolboxChanges, { projectId: "prj-1" }),
        ),
      );
    });
    expect(calls.map((c) => c.channel)).toEqual(["git:overview"]);
    const prBefore = buttonByText(doc, container, "Create pull request");
    expect(prBefore.getAttribute("title")).toBe("Push your commits first");

    await act(async () => {
      click(buttonByText(doc, container, "Push"));
    });
    expect(calls.map((c) => c.channel)).toEqual(["git:overview", "git:push", "git:refresh"]);
    expect(container.toString()).toContain("Pushed");

    await act(async () => {
      click(buttonByText(doc, container, "Create pull request"));
    });
    expect(calls.at(-1)).toEqual({
      channel: "links:open-external",
      payload: { url: "https://github.com/example-org/sample-repo/compare/feature/toolbox?expand=1" },
    });
    expect(container.toString()).toContain("Opened the pull request page");
    await act(async () => {
      root.unmount();
    });
  });

  it("reports a failed push honestly and keeps the PR action gated", async () => {
    const doc = mountDom(async (channel) => {
      if (channel === "git:overview") return snap({}, { upstream: undefined, ahead: undefined });
      if (channel === "git:push") return { kind: "unavailable", reason: "synthetic: remote rejected" };
      throw new Error(`unexpected IPC channel: ${channel}`);
    });
    const container = doc.createElement("div");
    stubEvents(container);
    doc.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ToolboxChanges, { projectId: "prj-1" }));
    });
    await act(async () => {
      click(buttonByText(doc, container, "Push"));
    });
    const html = container.toString();
    expect(html).toContain("Push failed: synthetic: remote rejected");
    expect(html).toContain('role="alert"');
    expect(buttonByText(doc, container, "Create pull request").getAttribute("title")).toBe("Push this branch first");
    await act(async () => {
      root.unmount();
    });
  });

  it("mounts inside the chat changes popover only when the chat has a project folder", async () => {
    const channels: string[] = [];
    const doc = mountDom(async (channel) => {
      channels.push(channel);
      if (channel === "checkpoints:changes") return null;
      if (channel === "git:overview") return snap();
      throw new Error(`unexpected IPC channel: ${channel}`);
    });
    const container = doc.createElement("div");
    stubEvents(container);
    doc.body.appendChild(container);
    const root = createRoot(container);
    const git = { projectId: "prj-1", worktree: true, running: false, readOnly: false };
    await act(async () => {
      root.render(createElement(ThreadChangesTab, { threadId: "thr-1", toggleSeq: 0, git }));
    });
    expect(channels).toEqual(["checkpoints:changes"]);
    await act(async () => {
      root.render(createElement(ThreadChangesTab, { threadId: "thr-1", toggleSeq: 1, git }));
    });
    const html = container.toString();
    expect(html).toContain('class="thread-changes-pop"');
    expect(html).toContain('class="toolbox-git"');
    expect(html).toContain("Inline Git actions are not available for worktree chats yet");
    expect(channels).toEqual(["checkpoints:changes", "git:overview"]);

    await act(async () => {
      root.render(createElement(ThreadChangesTab, { threadId: "thr-1", toggleSeq: 1 }));
    });
    expect(container.toString()).not.toContain("toolbox-git");
    await act(async () => {
      root.unmount();
    });
  });
});
