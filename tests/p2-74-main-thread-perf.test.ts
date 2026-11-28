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
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
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
import { RemoteMcpAuthority } from "../src/main/remoteMcp";
import { stavesOf } from "../src/renderer/components/HydraStaveBar";
import { streamMend } from "../src/renderer/markdown";
import type { Message } from "../src/shared/types";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-p274-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
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

  it("quarantines corrupt token-activity.json asynchronously without throwing", async () => {
    const root = freshRoot();
    writeFileSync(join(root, "token-activity.json"), "{corrupt-json");

    const deferred = new TokenLedger(root, { deferLoad: true });
    await deferred.loadAsync();
    expect(deferred.recoveryNote).toContain("corrupt token-activity preserved aside");
    expect(deferred.dailyTotals()).toEqual({});
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
      { id: "s1", name: "demo", transport: "stdio" as const, command: "demo-mcp", args: ["--ok"], env: {} },
      { id: "s2", name: "missing", transport: "stdio" as const, command: "no-such-mcp", args: [], env: {} },
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
