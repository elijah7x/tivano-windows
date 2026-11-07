// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// SYNTHETIC e2e fixture only — a newline-framed JSON-RPC MCP stand-in.
// MCP_FAKE_MODE selects the scripted behavior so the probe's real
// spawn/initialize/tools-list path can be checked end to end without
// any real MCP package. It never pretends to be a provider.

const readline = require("node:readline");
const MODE = process.env.MCP_FAKE_MODE || "ok";
if (MODE === "die") {
  process.stderr.write("boom at boot\n");
  process.exit(3);
}
const rl = readline.createInterface({ input: process.stdin });
const tool = (n) => ({
  name: n,
  inputSchema: { type: "object" },
  description: "does " + n,
});
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let page = 0;
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications/initialized ignored
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: process.env.MCP_FAKE_NAME || "fake", version: "0.1" },
    });
  } else if (msg.method === "tools/list") {
    if (MODE === "silent") return;
    if (MODE === "badtools") {
      reply(msg.id, { tools: [{ name: "x" }] }); // no inputSchema
      return;
    }
    const cur = msg.params && msg.params.cursor;
    if (MODE === "pages") {
      if (cur === "p2") reply(msg.id, { tools: [tool("gamma")] });
      else reply(msg.id, { tools: [tool("alpha"), tool("beta")], nextCursor: "p2" });
      return;
    }
    reply(msg.id, { tools: [tool("alpha"), tool("beta")] });
  }
});
if (MODE === "silent") setInterval(() => {}, 1000);
