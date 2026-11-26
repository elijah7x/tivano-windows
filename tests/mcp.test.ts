// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18 MCP stdio slice: real child-process probing of a synthetic Node
// server speaking newline JSON-RPC — initialize/tools-list happy path,
// cursor paging (incl. the 10-page cap), malformed tool lists, missing
// executable, immediate exit (stderr tail), silence timeout, env merge;
// plus the settings round-trip, document rejection, and the arg splitter.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeMcpServer,
  resolveCodexMcpServers,
  resolveMcpCommand,
} from "../src/main/mcpService";
import { splitArgs } from "../src/renderer/components/McpSection";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import type { McpServerConfig } from "../src/shared/mcp";

const dirs: string[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-mcp-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A newline-framed JSON-RPC MCP stand-in. Behavior is driven by the
// MCP_FAKE_MODE env var so one file covers every probe outcome.
const FAKE = `
const readline = require("node:readline");
const MODE = process.env.MCP_FAKE_MODE || "ok";
if (MODE === "die") { process.stderr.write("boom at boot\\n"); process.exit(3); }
const rl = readline.createInterface({ input: process.stdin });
const tool = (n) => ({ name: n, inputSchema: { type: "object" }, description: "does " + n });
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let page = 0;
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications ignored
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: process.env.MCP_FAKE_NAME || "fake", version: "0.1" },
    });
  } else if (msg.method === "tools/list") {
    if (MODE === "silent") return;
    if (MODE === "badtools") { reply(msg.id, { tools: [{ name: "x" }] }); return; }
    if (MODE === "badcursor") { reply(msg.id, { tools: [], nextCursor: 42 }); return; }
    const cur = msg.params && msg.params.cursor;
    if (MODE === "pages") {
      if (cur === "p2") reply(msg.id, { tools: [tool("gamma")] });
      else reply(msg.id, { tools: [tool("alpha"), tool("beta")], nextCursor: "p2" });
      return;
    }
    if (MODE === "infinite") {
      page += 1;
      reply(msg.id, { tools: [tool("t" + page)], nextCursor: "n" + page });
      return;
    }
    reply(msg.id, { tools: [tool("alpha"), tool("beta")] });
  }
});
if (MODE === "silent") setInterval(() => {}, 1000);
`;

function fakeServer(mode: string, extraEnv: Record<string, string> = {}): McpServerConfig {
  const dir = root();
  const script = join(dir, "fake.cjs");
  writeFileSync(script, FAKE);
  return {
    id: `s-${mode}`,
    name: mode,
    command: process.execPath,
    args: [script],
    env: { MCP_FAKE_MODE: mode, ...extraEnv },
  };
}

describe("mcpService probe (F18, real stdio spawn)", () => {
  it("connects: initialize → initialized → tools/list", async () => {
    const r = await probeMcpServer(fakeServer("ok", { MCP_FAKE_NAME: "srv" }));
    expect(r.status).toBe("connected");
    if (r.status !== "connected") return;
    expect(r.serverName).toBe("srv");
    expect(r.serverVersion).toBe("0.1");
    expect(r.tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
  });

  it("follows nextCursor across pages until it stops", async () => {
    const r = await probeMcpServer(fakeServer("pages"));
    expect(r.status).toBe("connected");
    if (r.status === "connected")
      expect(r.tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("stops at the frozen 10-page cap and still reports the tools seen", async () => {
    const r = await probeMcpServer(fakeServer("infinite"));
    expect(r.status).toBe("connected");
    if (r.status === "connected") expect(r.tools.length).toBe(10);
  });

  it("a malformed tool entry fails the probe as malformed", async () => {
    const r = await probeMcpServer(fakeServer("badtools"));
    expect(r.status).toBe("malformed");
    if (r.status === "malformed") expect(r.reason).toBe("invalid tool list");
  });

  it("a non-string nextCursor is a malformed reply, not a silent stop", async () => {
    const r = await probeMcpServer(fakeServer("badcursor"));
    expect(r.status).toBe("malformed");
  });

  it("an uninstalled command reports missing, not a generic failure", async () => {
    const r = await probeMcpServer(
      { command: "tivano-mcp-definitely-not-installed-xyz", args: [], env: {} },
      5000,
    );
    expect(r.status).toBe("missing");
  });

  it("an immediate exit reports the code and the stderr tail", async () => {
    const r = await probeMcpServer(fakeServer("die"));
    expect(r.status).toBe("exited");
    if (r.status === "exited") {
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("boom at boot");
    }
  });

  it("silence reports timedOut and kills the child", async () => {
    const r = await probeMcpServer(fakeServer("silent"), 400);
    expect(r.status).toBe("timedOut");
  });

  it("configured env reaches the child over the inherited environment", async () => {
    const r = await probeMcpServer(fakeServer("ok", { MCP_FAKE_NAME: "from-env" }));
    expect(r.status).toBe("connected");
    if (r.status === "connected") expect(r.serverName).toBe("from-env");
  });
});

describe("splitArgs (composer for the stdio argv field)", () => {
  it("splits bare words and keeps quoted segments whole", () => {
    expect(splitArgs('-y pkg "a b" \'c d\'')).toEqual(["-y", "pkg", "a b", "c d"]);
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("  spaced   out ")).toEqual(["spaced", "out"]);
  });
});

describe("mcpServers settings persistence (F18)", () => {
  function makeEngine(dir: string) {
    const store = new Store(dir);
    store.open();
    return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), dir, "t") };
  }

  it("round-trips a server list through setSettings and survives reopen", () => {
    const dir = root();
    const srv: McpServerConfig = {
      id: "s1",
      name: "fs",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { TOKEN: "abc" },
    };
    const { store, engine } = makeEngine(dir);
    engine.setSettings({ mcpServers: [srv] });
    expect(engine.snapshot().settings.mcpServers).toEqual([srv]);
    store.close();

    const { store: s2, engine: e2 } = makeEngine(dir);
    expect(e2.snapshot().settings.mcpServers).toEqual([srv]);
    e2.setSettings({ mcpServers: [] });
    expect(e2.snapshot().settings.mcpServers).toBeUndefined();
    s2.close();
  });

  it("a pre-F18 store without mcpServers loads unchanged", () => {
    const { engine } = makeEngine(root());
    expect(engine.snapshot().settings.mcpServers).toBeUndefined();
  });

  it("a server with a bad env key makes the document unreadable, never silently kept", () => {
    const dir = root();
    const { store, engine } = makeEngine(dir);
    engine.setSettings({ chimeWhenFinished: false }); // force a pending write
    store.flushNow(); // …onto disk now, not at the scheduled flush
    const raw = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
    raw.settings.mcpServers = [
      { id: "x", name: "n", command: "c", args: [], env: { "9BAD": "v" } },
    ];
    store.close();
    writeFileSync(join(dir, "store.json"), JSON.stringify(raw));
    const s = new Store(dir);
    s.open();
    expect(s.recoveredFrom).toBeTruthy();
    s.close();
  });
});

// ---- F18 second slice: streamable-HTTP transport ---------------------
// A real local HTTP fixture speaks the POST path of the 2025-06-18 spec:
// JSON or SSE bodies, Mcp-Session-Id round-trips, 202 notifications.

import { createServer, type Server } from "node:http";

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

function httpFixture(mode: "json" | "sse" | "garbage" | "noReply" | "hang" = "json") {
  let deleted = false;
  const srv = createServer((req, res) => {
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(204).end();
      return;
    }
    if (mode === "hang") return; // never answers → probe times out
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let msg: { id?: number; method?: string };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (mode === "noReply") {
        res.writeHead(500).end();
        return;
      }
      if (mode === "garbage") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not rpc");
        return;
      }
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "http-fixture", version: "1.2" },
            }
          : msg.method === "tools/list"
            ? {
                tools: [
                  { name: "alpha", inputSchema: { type: "object" }, description: "does alpha" },
                  { name: "beta", inputSchema: { type: "object" } },
                ],
              }
            : {};
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (mode === "sse") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "sess-1",
        });
        res.end(`event: message\ndata: ${reply}\n\n`);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "sess-1",
      });
      res.end(reply);
    });
  });
  servers.push(srv);
  return new Promise<{ url: string; isDeleted: () => boolean }>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        isDeleted: () => deleted,
      });
    });
  });
}

describe("F18 streamable-HTTP probe", () => {
  it("JSON replies → connected with the server's tools", async () => {
    const fx = await httpFixture("json");
    const r = await probeMcpServer(
      { transport: "http", url: fx.url, command: "", args: [] },
      8000,
    );
    expect(r).toMatchObject({ status: "connected", serverName: "http-fixture" });
    expect((r as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(fx.isDeleted()).toBe(true); // session DELETE happened
  });

  it("SSE replies → the data: frame supplies the response", async () => {
    const fx = await httpFixture("sse");
    const r = await probeMcpServer(
      { transport: "http", url: fx.url, command: "", args: [] },
      8000,
    );
    expect(r.status).toBe("connected");
    expect((r as { tools: unknown[] }).tools).toHaveLength(2);
  });

  it("a non-RPC body reports malformed", async () => {
    const fx = await httpFixture("garbage");
    const r = await probeMcpServer(
      { transport: "http", url: fx.url, command: "", args: [] },
      8000,
    );
    expect(r.status).toBe("malformed");
  });

  it("an HTTP error status reports error with the code", async () => {
    const fx = await httpFixture("noReply");
    const r = await probeMcpServer(
      { transport: "http", url: fx.url, command: "", args: [] },
      8000,
    );
    expect(r.status).toBe("error");
    expect((r as { reason: string }).reason).toContain("500");
  });

  it("a dead endpoint reports error, never a fake connect", async () => {
    const r = await probeMcpServer(
      { transport: "http", url: "http://127.0.0.1:1/mcp", command: "", args: [] },
      4000,
    );
    expect(r.status).toBe("error");
  });

  it("a silent endpoint reports timedOut", async () => {
    const fx = await httpFixture("hang");
    const r = await probeMcpServer(
      { transport: "http", url: fx.url, command: "", args: [] },
      700,
    );
    expect(r.status).toBe("timedOut");
  });

  it("a non-http URL reports missing before any request", async () => {
    const r = await probeMcpServer(
      { transport: "http", url: "ftp://x/mcp", command: "", args: [] },
      2000,
    );
    expect(r.status).toBe("missing");
  });

  it("an empty command on stdio reports missing without spawning", async () => {
    const r = await probeMcpServer({ command: "  ", args: [] }, 2000);
    expect(r.status).toBe("missing");
  });
});

describe("codexMcpServers (F18 — Settings registry → codex config.mcp_servers)", () => {
  it("maps stdio + http entries into the frozen codex shape", async () => {
    const { codexMcpServers } = await import("../src/shared/mcp");
    const out = codexMcpServers([
      {
        id: "1",
        name: "localfs",
        command: "/usr/bin/fs-server",
        args: ["--root", "/tmp"],
        env: { TOKEN: "x", EMPTY: "" },
      },
      {
        id: "2",
        name: "httpx",
        transport: "http",
        command: "",
        args: [],
        url: "http://127.0.0.1:9999/mcp",
      },
    ]);
    expect(out).toEqual({
      localfs: {
        command: "/usr/bin/fs-server",
        args: ["--root", "/tmp"],
        env: { TOKEN: "x" },
      },
      httpx: { url: "http://127.0.0.1:9999/mcp" },
    });
  });

  it("skips entries whose name a config patch could not carry", async () => {
    const { codexMcpServers } = await import("../src/shared/mcp");
    const out = codexMcpServers([
      { id: "1", name: "has space", command: "/x", args: [] },
      { id: "2", name: "dot.name", command: "/x", args: [] },
      { id: "3", name: 'quo"te', command: "/x", args: [] },
      { id: "4", name: "brack[et", command: "/x", args: [] },
      { id: "5", name: "comm,a", command: "/x", args: [] },
      { id: "6", name: "  ", command: "/x", args: [] },
      { id: "7", name: "fine", command: "/x", args: [] },
    ]);
    expect(out).toEqual({ fine: { command: "/x", args: [] } });
  });

  it("drops unusable entries and stays undefined when empty", async () => {
    const { codexMcpServers } = await import("../src/shared/mcp");
    expect(codexMcpServers([])).toBeUndefined();
    expect(
      codexMcpServers([
        { id: "1", name: "nocmd", command: "  ", args: [] },
        { id: "2", name: "nourl", transport: "http", command: "", args: [] },
      ]),
    ).toBeUndefined();
    // A duplicate key keeps the first entry rather than overwriting.
    expect(
      codexMcpServers([
        { id: "1", name: "dup", command: "/a", args: [] },
        { id: "2", name: "dup", command: "/b", args: [] },
      ]),
    ).toEqual({ dup: { command: "/a", args: [] } });
  });
});

describe("P1-33 — resolveMcpCommand, PATHEXT, Path casing, and .cmd shim", () => {
  it.runIf(process.platform === "win32")(
    "resolves a bare command honoring Path/PATH casing and PATHEXT order on Windows",
    () => {
      const dir = root();
      const shim = join(dir, "mytool.cmd");
      const exe = join(dir, "mytool.exe");
      writeFileSync(shim, "@echo off\r\n");
      writeFileSync(exe, "");
      // Extensionless POSIX-style file should NOT win over PATHEXT on Windows.
      writeFileSync(join(dir, "onlysh"), "#!/bin/sh\n");

      const fromPathMixed = resolveMcpCommand(
        "mytool",
        { Path: dir, Pathext: ".CMD;.EXE" },
        {},
        "win32",
      );
      expect(fromPathMixed).toBe(win32.join(dir, "mytool.cmd"));

      const fromPathExeFirst = resolveMcpCommand(
        "mytool",
        undefined,
        { Path: dir, PATHEXT: ".EXE;.CMD" },
        "win32",
      );
      expect(fromPathExeFirst).toBe(win32.join(dir, "mytool.exe"));

      // Extensionless file is skipped on Windows when no PATHEXT match exists.
      expect(
        resolveMcpCommand("onlysh", undefined, { Path: dir, PATHEXT: ".CMD;.EXE" }, "win32"),
      ).toBeNull();

      // Explicit .cmd extension resolves directly.
      expect(
        resolveMcpCommand("mytool.cmd", undefined, { PATH: dir }, "win32"),
      ).toBe(win32.join(dir, "mytool.cmd"));
    },
  );

  it("honors Path/PATH casing and server.env override on the host platform", () => {
    const dirA = root();
    const dirB = root();
    const isWin = process.platform === "win32";
    const name = "tivano-host-tool";
    const binA = join(dirA, isWin ? `${name}.cmd` : name);
    const binB = join(dirB, isWin ? `${name}.cmd` : name);
    writeFileSync(binA, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
    writeFileSync(binB, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
    if (!isWin) {
      chmodSync(binA, 0o755);
      chmodSync(binB, 0o755);
    }
    expect(resolveMcpCommand(name, undefined, { Path: dirA })).toBe(binA);
    expect(resolveMcpCommand(name, { PATH: dirB }, { Path: dirA })).toBe(binB);
    expect(resolveMcpCommand(binA)).toBe(binA);
  });

  it("rejects UNC and missing paths without hitting the network", () => {
    expect(resolveMcpCommand("\\\\nonexistent-host\\share\\mcp.exe")).toBeNull();
    expect(resolveMcpCommand("//nonexistent-host/share/mcp")).toBeNull();
    expect(resolveMcpCommand("tivano-definitely-missing-mcp-cmd", undefined, { PATH: root() })).toBeNull();
    expect(resolveMcpCommand(join(root(), "missing-explicit-bin"))).toBeNull();
  });

  it("resolveCodexMcpServers maps bare commands to full paths and skips missing servers", () => {
    const dir = root();
    const cmdName = basename(process.execPath);
    const { mcpServers, skipped } = resolveCodexMcpServers(
      [
        {
          id: "1",
          name: "good",
          command: cmdName,
          args: ["--version"],
          env: { Path: join(process.execPath, "..") },
        },
        {
          id: "2",
          name: "missing-one",
          command: "tivano-missing-mcp-server-a",
          args: [],
        },
        {
          id: "3",
          name: "httpx",
          transport: "http",
          command: "",
          args: [],
          url: "http://127.0.0.1:9999/mcp",
        },
      ],
      { PATH: dir },
    );
    expect(mcpServers).toEqual({
      good: {
        command: join(join(process.execPath, ".."), cmdName),
        args: ["--version"],
        env: { Path: join(process.execPath, "..") },
      },
      httpx: { url: "http://127.0.0.1:9999/mcp" },
    });
    expect(skipped).toEqual(["missing-one"]);
  });

  it("probes a bare command resolving to a .cmd/.sh shim wrapping the fake MCP server", async () => {
    const dir = root();
    const script = join(dir, "fake.cjs");
    writeFileSync(script, FAKE);
    const isWin = process.platform === "win32";
    const shimName = "tivano-shim-mcp";
    const shimPath = join(dir, isWin ? `${shimName}.cmd` : shimName);
    if (isWin) {
      writeFileSync(
        shimPath,
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
    } else {
      writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(shimPath, 0o755);
    }

    const r = await probeMcpServer({
      command: shimName,
      args: [],
      env: isWin
        ? { Path: dir, MCP_FAKE_MODE: "ok", MCP_FAKE_NAME: "shim-srv" }
        : { PATH: dir, MCP_FAKE_MODE: "ok", MCP_FAKE_NAME: "shim-srv" },
    });
    expect(r.status).toBe("connected");
    if (r.status === "connected") {
      expect(r.serverName).toBe("shim-srv");
      expect(r.tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
    }

    // Timeout cleanup on a .cmd/.sh shim also kills the child tree cleanly.
    const pidFile = join(dir, "grandchild.pid");
    const silentScript = join(dir, "silent-pid.cjs");
    writeFileSync(
      silentScript,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const silentShimName = "tivano-silent-shim";
    const silentShimPath = join(dir, isWin ? `${silentShimName}.cmd` : silentShimName);
    if (isWin) {
      writeFileSync(silentShimPath, `@echo off\r\n"${process.execPath}" "${silentScript}" %*\r\n`);
    } else {
      writeFileSync(silentShimPath, `#!/bin/sh\nexec "${process.execPath}" "${silentScript}" "$@"\n`);
      chmodSync(silentShimPath, 0o755);
    }
    const rSilent = await probeMcpServer(
      {
        command: silentShimName,
        args: [],
        env: isWin ? { Path: dir } : { PATH: dir },
      },
      300,
    );
    expect(rSilent.status).toBe("timedOut");
    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isFinite(grandchildPid) && grandchildPid > 0).toBe(true);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it("rejects null bytes and newlines in command or arguments", async () => {
    const rNull = await probeMcpServer({ command: process.execPath, args: ["a\0b"] });
    expect(rNull).toEqual({
      status: "error",
      reason: "Invalid null byte in command or arguments.",
    });
    if (process.platform === "win32") {
      const dir = root();
      const shim = join(dir, "nl.cmd");
      writeFileSync(shim, "@echo off\r\n");
      const rNl = await probeMcpServer({ command: shim, args: ["a\nb"] });
      expect(rNl).toEqual({
        status: "error",
        reason: "Invalid newline in command or arguments.",
      });
    }
  });
});
