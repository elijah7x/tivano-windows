// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-74 main-thread reduction: deferred startup reads, WhatsNew caching,
// badge deduplication, async MCP/Git/FileIndex/TokenLedger reads & writes,
// and streaming CPU reductions (HydraStaveBar prefix scan, streamMend).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
  },
  shell: { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} },
  clipboard: { writeText: () => {} },
}));

import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { registerIpc } from "../src/main/ipc";
import { LocalControlService } from "../src/main/localControl";
import { MockProvider } from "../src/main/mockProvider";
import { TokenLedger, dayKey } from "../src/main/tokenLedger";
import {
  resolveCodexMcpServers,
  resolveCodexMcpServersAsync,
  resolveMcpCommand,
  resolveMcpCommandAsync,
} from "../src/main/mcpService";
import {
  resolveGitExecutable,
  resolveGitExecutableAsync,
  type GitRuntimeAsyncFs,
  type GitRuntimeFs,
} from "../src/main/gitRuntimeConfig";
import { FileIndexService } from "../src/main/fileIndex";
import { RemoteMcpAuthority, RemoteMcpService } from "../src/main/remoteMcp";
import { stavesOf } from "../src/renderer/components/HydraStaveBar";
import { streamMend } from "../src/renderer/markdown";
import { buildWhatsNewInfo } from "../src/shared/whatsNew";
import type { Message } from "../src/shared/types";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-p274-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  ipcHandlers.clear();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("P2-74 TokenLedger deferred async load and background flush", () => {
  it("defers disk read until loadAsync() and merges pre-load deltas", async () => {
    const root = freshRoot();
    const today = dayKey(new Date());
    const writer = new TokenLedger(root);
    writer.record(120);
    writer.flush();

    const deferred = new TokenLedger(root, { deferLoad: true });
    expect(deferred.dailyTotals()).toEqual({});

    // Live spend recorded before async load finishes is preserved and merged.
    deferred.record(30);
    await deferred.loadAsync();
    expect(deferred.dailyTotals()[today]).toBe(150);

    await deferred.flushAsync();
    const reloaded = new TokenLedger(root);
    expect(reloaded.dailyTotals()[today]).toBe(150);
  });

  it("quarantines corrupt token-activity.json asynchronously and preserves pre-load live deltas", async () => {
    const root = freshRoot();
    const today = dayKey(new Date());
    writeFileSync(join(root, "token-activity.json"), "{corrupt-json");

    const deferred = new TokenLedger(root, { deferLoad: true });
    deferred.record(45);
    await deferred.loadAsync();
    expect(deferred.recoveryNote).toContain("corrupt token-activity preserved aside");
    expect(deferred.dailyTotals()).toEqual({ [today]: 45 });
    expect(readdirSync(root).some((f) => f.startsWith("token-activity.corrupt-"))).toBe(true);
  });
});

describe("P2-74 Engine startup deferral, WhatsNew cache, and badge deduplication", () => {
  it("defers CHANGELOG and token-activity reads until startDeferredReads()", async () => {
    const root = freshRoot();
    const today = dayKey(new Date());
    const seedLedger = new TokenLedger(root);
    seedLedger.record(75);
    seedLedger.flush();

    const changelogFile = join(root, "CHANGELOG.md");
    writeFileSync(
      changelogFile,
      [
        "## [0.2.0] - 2026-11-28",
        "",
        "### English",
        "",
        "### Refinements",
        "",
        "- Deferred startup reads.",
        "",
      ].join("\n"),
    );

    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.2.0", undefined, undefined, {
      deferStartupReads: true,
    });

    // Before deferred reads run, neither CHANGELOG nor token-activity was read synchronously.
    expect(engine.info.whatsNew).toBeUndefined();
    expect(engine.snapshot().tokenActivity).toEqual({});

    await engine.startDeferredReads(changelogFile);
    await engine.whenReady();

    expect(engine.snapshot().tokenActivity[today]).toBe(75);
    const info1 = engine.info;
    const info2 = engine.info;
    expect(info1.whatsNew?.en.categories.refinements).toContain("Deferred startup reads.");
    // Cached WhatsNewInfo object is reused across consecutive info/snapshot reads.
    expect(info2.whatsNew).toBe(info1.whatsNew);

    engine.shutdown();
    store.close();
  });

  it("whenReady() kicks deferred token-ledger load when startDeferredReads() was not called first", async () => {
    const root = freshRoot();
    const today = dayKey(new Date());
    const seedLedger = new TokenLedger(root);
    seedLedger.record(42);
    seedLedger.flush();

    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.2.0", undefined, undefined, {
      deferStartupReads: true,
    });
    expect(engine.snapshot().tokenActivity).toEqual({});
    await engine.whenReady();
    expect(engine.snapshot().tokenActivity[today]).toBe(42);

    engine.shutdown();
    store.close();
  });

  it("skips OS badge updates on turn-chunk and unchanged unread counts", async () => {
    const root = freshRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 5 }), root, "0.2.0");
    const badgeCounts: number[] = [];
    engine.attachBadgeUpdater((count) => badgeCounts.push(count));
    expect(badgeCounts).toEqual([0]);

    const th = engine.createThread(null, "streaming");
    engine.sendTurn(th.id, "hello streaming world");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (th.turn?.status === "done") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(th.turn?.status).toBe("done");
    // Thread is selected so unread stays 0 across the entire turn and every chunk.
    expect(badgeCounts).toEqual([0]);

    // A background thread finishing increments unread once (0 -> 1).
    const bg = engine.createThread(null, "bg");
    engine.selectThread(th.id);
    engine.sendTurn(bg.id, "background turn");
    const bgDeadline = Date.now() + 2000;
    while (Date.now() < bgDeadline) {
      if (bg.turn?.status === "done") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(bg.turn?.status).toBe("done");
    expect(badgeCounts).toEqual([0, 1]);

    engine.shutdown();
    store.close();
  });
});

describe("P2-74 Async MCP, Git, FileIndex, and RemoteMcpAuthority reads", () => {
  it("resolveMcpCommandAsync and resolveCodexMcpServersAsync match sync resolution", async () => {
    const root = freshRoot();
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const toolPath = join(binDir, "demo-mcp.cmd");
    writeFileSync(toolPath, "@echo off\r\n");
    chmodSync(toolPath, 0o755);

    const env = { Path: binDir, PATHEXT: ".CMD;.EXE" };
    expect(await resolveMcpCommandAsync("demo-mcp", undefined, env, "win32")).toBe(
      resolveMcpCommand("demo-mcp", undefined, env, "win32"),
    );

    const servers = [
      { id: "dup", name: "demo", transport: "stdio" as const, command: "  demo-mcp  ", args: ["--ok"], env: {} },
      { id: "dup", name: "missing", transport: "stdio" as const, command: "no-such-mcp", args: [], env: {} },
    ];
    const asyncRes = await resolveCodexMcpServersAsync(servers, env, "win32");
    const syncRes = resolveCodexMcpServers(servers, env, "win32");
    expect(asyncRes).toEqual(syncRes);
    expect(asyncRes.skipped).toEqual(["missing"]);
    expect(asyncRes.mcpServers?.["demo"]).toBeDefined();
  });

  it("resolveGitExecutableAsync matches resolveGitExecutable on win32 routes", async () => {
    const files = new Set(["C:\\Program Files\\Git\\cmd\\git.exe", "D:\\tools\\git.exe"]);
    const syncFs: GitRuntimeFs = {
      existsFile: (p) => files.has(p),
      realpath: (p) => p,
    };
    const asyncFs: GitRuntimeAsyncFs = {
      existsFile: async (p) => files.has(p),
      realpath: async (p) => p,
    };
    const src = {
      ProgramFiles: "C:\\Program Files",
      PATH: "D:\\tools",
    };
    expect(await resolveGitExecutableAsync(src, { platform: "win32", fs: asyncFs })).toEqual(
      resolveGitExecutable(src, { platform: "win32", fs: syncFs }),
    );
    expect(await resolveGitExecutableAsync({}, { platform: "win32", fs: asyncFs })).toEqual(
      resolveGitExecutable({}, { platform: "win32", fs: syncFs }),
    );
  });

  it("FileIndexService builds directory listings asynchronously skipping hidden & vendor dirs", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export {};\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

    const index = new FileIndexService({
      isRepo: async () => false,
      gitFiles: async () => [],
    });
    const listed = await index.list(root);
    expect(listed).toEqual(["src/app.ts"]);
    expect(await FileIndexService.existsAsync(root)).toBe(true);
    expect(await FileIndexService.existsAsync(join(root, "missing"))).toBe(false);
  });

  it("RemoteMcpAuthority defers disk load until ensureLoaded()", async () => {
    const root = freshRoot();
    writeFileSync(
      join(root, "remote-mcp.json"),
      JSON.stringify({
        clients: [{ id: "c1", name: "Client", redirectURIs: ["http://127.0.0.1/cb"], source: "registered", createdAt: 1 }],
        grants: [
          {
            id: "g1",
            clientId: "c1",
            clientName: "Client",
            scopes: ["tivano.read"],
            createdAt: 1,
            refreshTokenHash: "abc",
            refreshExpiresAt: Date.now() + 60_000,
          },
        ],
      }),
    );

    const auth = new RemoteMcpAuthority(root, () => {}, () => "en", { deferLoad: true });
    expect(auth.grants()).toEqual([]);
    await auth.ensureLoaded();
    expect(auth.grants().map((g) => g.id)).toEqual(["g1"]);
  });

  it("RemoteMcpAuthority revoke/revokeAll before ensureLoaded preserves clients/other grants and never resurrects", async () => {
    const root = freshRoot();
    writeFileSync(
      join(root, "remote-mcp.json"),
      JSON.stringify({
        clients: [{ id: "c1", name: "Client", redirectURIs: ["http://127.0.0.1/cb"], source: "registered", createdAt: 1 }],
        grants: [
          {
            id: "g1",
            clientId: "c1",
            clientName: "Client",
            scopes: ["tivano.read"],
            createdAt: 1,
            refreshTokenHash: "abc",
            refreshExpiresAt: Date.now() + 60_000,
          },
          {
            id: "g2",
            clientId: "c1",
            clientName: "Client",
            scopes: ["tivano.read"],
            createdAt: 2,
            refreshTokenHash: "def",
            refreshExpiresAt: Date.now() + 60_000,
          },
        ],
      }),
    );

    const auth = new RemoteMcpAuthority(root, () => {}, () => "en", { deferLoad: true });
    const inFlight = auth.ensureLoaded();
    auth.revoke("g1");
    await inFlight;
    expect(auth.grants().map((g) => g.id)).toEqual(["g2"]);

    const auth2 = new RemoteMcpAuthority(root, () => {}, () => "en", { deferLoad: true });
    await auth2.ensureLoaded();
    expect(auth2.grants().map((g) => g.id)).toEqual(["g2"]);

    const auth3 = new RemoteMcpAuthority(root, () => {}, () => "en", { deferLoad: true });
    const inFlight3 = auth3.ensureLoaded();
    auth3.revokeAll();
    await inFlight3;
    expect(auth3.grants()).toEqual([]);

    const auth4 = new RemoteMcpAuthority(root, () => {}, () => "en", { deferLoad: true });
    await auth4.ensureLoaded();
    expect(auth4.grants()).toEqual([]);
  });
});

describe("P2-74 Streaming CPU reductions (HydraStaveBar + streamMend)", () => {
  it("stavesOf extracts first-line headline from bounded prefix on huge replies", () => {
    const longTail = "\nline ".repeat(20_000);
    const msg: Message = {
      id: "m1",
      role: "assistant",
      content: `First headline line of the reply${longTail}`,
      status: "streaming",
      ts: 1000,
    };
    const t0 = performance.now();
    const staves = stavesOf([msg], "Replied");
    const elapsedMs = performance.now() - t0;
    expect(staves).toHaveLength(1);
    expect(staves[0]?.step).toBe("Replied: First headline line of the reply");
    expect(elapsedMs).toBeLessThan(100);
  });

  it("streamMend handles BMP, surrogate emoji pairs, escaped tails, and code spans accurately", () => {
    expect(streamMend("**bold")).toBe("**bold**");
    expect(streamMend("Hello **world  ")).toBe("Hello **world**  ");
    expect(streamMend("🎉 **party")).toBe("🎉 **party**");
    expect(streamMend("a🎉**notopen")).toBe("a🎉**notopen**");
    expect(streamMend("𝐚**notopen")).toBe("𝐚**notopen");
    expect(streamMend("`code")).toBe("`code`");
    expect(streamMend("*escaped\\")).toBe("*escaped\\\\*");
    expect(streamMend("plain text without markers")).toBe("plain text without markers");
    expect(streamMend("snake_case_name")).toBe("snake_case_name");
  });
});

describe("P2-74 IPC deferral guards, WhatsNew cache invalidation, and Git fail-closed async path", () => {
  it("resolveGitExecutableAsync fails closed on invalid config and missing paths using real fs", async () => {
    const missingExe = join(freshRoot(), "missing-git.exe");
    const invalid = await resolveGitExecutableAsync(
      { TIVANO_GIT_EXECUTABLE: missingExe },
      { platform: "win32" },
    );
    expect(invalid.kind).toBe("unavailable");
    if (invalid.kind === "unavailable") {
      expect(invalid.reason).toBe("git-config-invalid");
    }
    expect(
      await resolveGitExecutableAsync({ PATH: "" }, { platform: "win32" }),
    ).toEqual(resolveGitExecutable({ PATH: "" }, { platform: "win32" }));
  });

  it("Engine.info invalidates cached WhatsNewInfo when whatsNewPreviousVersion changes", async () => {
    const root = freshRoot();
    const changelogFile = join(root, "CHANGELOG.md");
    writeFileSync(
      changelogFile,
      [
        "## [0.2.0] - 2026-11-28",
        "",
        "### English",
        "",
        "### Refinements",
        "",
        "- Cached WhatsNew entry.",
        "",
      ].join("\n"),
    );

    const store = new Store(root);
    store.open();
    store.update((d) => {
      d.projects.push({ id: "p1", name: "proj", expanded: true, createdAt: 1 });
      d.settings.whatsNewPreviousVersion = "0.1.0";
    });
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.2.0", undefined, undefined, {
      deferStartupReads: true,
    });
    await engine.startDeferredReads(changelogFile);
    const first = engine.info;
    const second = engine.info;
    expect(first.whatsNew?.en.categories.refinements).toContain("Cached WhatsNew entry.");
    expect(second.whatsNew).toBe(first.whatsNew);

    store.update((d) => {
      d.settings.whatsNewPreviousVersion = "0.2.0";
    });
    expect(engine.info.whatsNew).toBeUndefined();

    engine.shutdown();
    store.close();
  });

  it("registerIpc awaits Engine.whenReady() on state:get/app:info and kicks/awaits RemoteMcpService on early IPC", async () => {
    const root = freshRoot();
    const today = dayKey(new Date());
    const seedLedger = new TokenLedger(root);
    seedLedger.record(64);
    seedLedger.flush();
    const g1 = "11111111-1111-4111-8111-111111111111";
    const g2 = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(root, "remote-mcp.json"),
      JSON.stringify({
        clients: [{ id: "c1", name: "Client", redirectURIs: ["http://127.0.0.1/cb"], source: "registered", createdAt: 1 }],
        grants: [
          {
            id: g1,
            clientId: "c1",
            clientName: "Client",
            scopes: ["tivano.read"],
            createdAt: 1,
            refreshTokenHash: "abc",
            refreshExpiresAt: Date.now() + 60_000,
          },
          {
            id: g2,
            clientId: "c1",
            clientName: "Client",
            scopes: ["tivano.read"],
            createdAt: 2,
            refreshTokenHash: "def",
            refreshExpiresAt: Date.now() + 60_000,
          },
        ],
      }),
    );

    const store = new Store(root);
    store.open();
    store.update((d) => {
      d.settings.remoteMCPPort = 45_123;
    });
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.2.0", undefined, undefined, {
      deferStartupReads: true,
    });
    const lc = new LocalControlService(engine, root, "dev");
    const rm = new RemoteMcpService({
      engine,
      localControl: lc,
      dataRoot: root,
      appVersion: "0.2.0",
      deferLoad: true,
    });

    let postWindowKicks = 0;
    const allowedUrl = "file:///C:/app/index.html";
    const unreg = registerIpc({
      engine,
      allowedUrl,
      broadcast: () => {},
      localControl: lc,
      remoteMcp: rm,
      ensurePostWindowServices: () => {
        postWindowKicks++;
        void rm.refresh();
      },
    });

    const trustedEvent = {
      sender: { isDestroyed: () => false },
      senderFrame: { url: allowedUrl },
    };

    try {
      const stateGet = ipcHandlers.get("state:get")!;
      const appInfo = ipcHandlers.get("app:info")!;
      const snap = (await stateGet(trustedEvent, {})) as { tokenActivity: Record<string, number> };
      expect(snap.tokenActivity[today]).toBe(64);
      const info = (await appInfo(trustedEvent, {})) as { appVersion: string };
      expect(info.appVersion).toBe("0.2.0");

      const status = (await ipcHandlers.get("remoteMcp:status")!(trustedEvent, {})) as {
        grants: { id: string }[];
      };
      expect(postWindowKicks).toBeGreaterThanOrEqual(1);
      expect(status.grants.map((g) => g.id)).toEqual([g1, g2]);

      const afterRevoke = (await ipcHandlers.get("remoteMcp:revoke")!(
        trustedEvent,
        { id: g1 },
      )) as { grants: { id: string }[] };
      expect(afterRevoke.grants.map((g) => g.id)).toEqual([g2]);

      const afterRevokeAll = (await ipcHandlers.get("remoteMcp:revoke-all")!(
        trustedEvent,
        {},
      )) as { grants: { id: string }[] };
      expect(afterRevokeAll.grants).toEqual([]);
    } finally {
      unreg();
      rm.dispose();
      lc.dispose();
      engine.shutdown();
      store.close();
    }
  });

  it("records reproducible P2-74 before/after synthetic measurements", async () => {
    const root = freshRoot();
    const today = dayKey(new Date());
    const changelogLines = ["## [0.2.0] - 2026-11-28", "", "### English", "", "### Refinements", ""];
    for (let i = 0; i < 60; i++) changelogLines.push(`- Synthetic release entry ${i}.`);
    for (let v = 1; v <= 30; v++) {
      changelogLines.push("", `## [0.1.${v}] - 2026-11-01`, "", "### English", "", "### Fixes", "");
      for (let j = 0; j < 20; j++) changelogLines.push(`- Historical note ${v}.${j}.`);
    }
    const changelog = changelogLines.join("\n");
    const changelogFile = join(root, "CHANGELOG.md");
    writeFileSync(changelogFile, changelog, "utf8");

    const seedLedger = new TokenLedger(root);
    seedLedger.record(250);
    seedLedger.flush();
    writeFileSync(
      join(root, "remote-mcp.json"),
      JSON.stringify({
        clients: [{ id: "c1", name: "Client", redirectURIs: ["http://127.0.0.1/cb"], source: "registered", createdAt: 1 }],
        grants: Array.from({ length: 25 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          clientId: "c1",
          clientName: "Client",
          scopes: ["tivano.read"],
          createdAt: 1000 + i,
          refreshTokenHash: `hash-${i}`,
          refreshExpiresAt: Date.now() + 60_000,
        })),
      }),
    );

    const store = new Store(root);
    store.open();
    store.update((d) => {
      d.projects.push({ id: "p1", name: "proj", expanded: true, createdAt: 1 });
      d.settings.whatsNewPreviousVersion = "0.1.0";
    });

    const tSyncBoot0 = performance.now();
    const syncEngine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.2.0", undefined, changelog);
    const syncAuth = new RemoteMcpAuthority(root, () => {}, () => "en");
    const startupSyncMs = performance.now() - tSyncBoot0;
    expect(syncEngine.snapshot().tokenActivity[today]).toBe(250);
    expect(syncAuth.grants()).toHaveLength(25);
    syncEngine.shutdown();

    const tDefBoot0 = performance.now();
    const defEngine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.2.0", undefined, undefined, {
      deferStartupReads: true,
    });
    const defAuth = new RemoteMcpAuthority(root, () => {}, () => "en", { deferLoad: true });
    const startupDeferredCtorMs = performance.now() - tDefBoot0;
    expect(defEngine.snapshot().tokenActivity).toEqual({});
    expect(defAuth.grants()).toEqual([]);

    await Promise.all([defEngine.startDeferredReads(changelogFile), defAuth.ensureLoaded()]);
    expect(defEngine.snapshot().tokenActivity[today]).toBe(250);
    expect(defAuth.grants()).toHaveLength(25);

    const tUncached0 = performance.now();
    for (let i = 0; i < 100; i++) buildWhatsNewInfo(changelog, "0.2.0", "0.1.0");
    const whatsNewUncached100Ms = performance.now() - tUncached0;

    const firstInfo = defEngine.info;
    const tCached0 = performance.now();
    for (let i = 0; i < 100; i++) {
      expect(defEngine.info.whatsNew).toBe(firstInfo.whatsNew);
    }
    const whatsNewCached100Ms = performance.now() - tCached0;
    defEngine.shutdown();
    store.close();

    const longReply = `Headline first line${"\nline ".repeat(20_000)}`;
    const msg: Message = { id: "m1", role: "assistant", content: longReply, status: "streaming", ts: 1000 };
    const tSplit0 = performance.now();
    for (let i = 0; i < 200; i++) void msg.content.split("\n")[0]!.trim().slice(0, 60);
    const stavesSplit200Ms = performance.now() - tSplit0;
    const tPrefix0 = performance.now();
    for (let i = 0; i < 200; i++) expect(stavesOf([msg], "Replied")).toHaveLength(1);
    const stavesPrefix200Ms = performance.now() - tPrefix0;

    console.info(
      `P2-74_METRICS=${JSON.stringify({
        startupSyncMs: Number(startupSyncMs.toFixed(3)),
        startupDeferredCtorMs: Number(startupDeferredCtorMs.toFixed(3)),
        whatsNewUncached100Ms: Number(whatsNewUncached100Ms.toFixed(3)),
        whatsNewCached100Ms: Number(whatsNewCached100Ms.toFixed(3)),
        stavesSplit200Ms: Number(stavesSplit200Ms.toFixed(3)),
        stavesPrefix200Ms: Number(stavesPrefix200Ms.toFixed(3)),
      })}`,
    );
  });
});
