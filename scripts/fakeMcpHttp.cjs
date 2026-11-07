// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// e2e fixture: a streamable-HTTP MCP server (spec 2025-06-18 POST path).
// Speaks real JSON-RPC — initialize/tools/list, Mcp-Session-Id
// round-trip, 202 for notifications, DELETE for session close. Prints
// the bound port on stdout once listening.

const http = require("node:http");
const fs = require("node:fs");

// A73: when MCP_HDR_LOG names a file, each request's headers append a
// JSON line — the catalog probe check verifies resolved {key} values
// arrived on the wire (never asserted from settings alone).
const HDR_LOG = process.env.MCP_HDR_LOG;

const srv = http.createServer((req, res) => {
  if (HDR_LOG) fs.appendFileSync(HDR_LOG, JSON.stringify(req.headers) + "\n");
  if (req.method === "DELETE") {
    res.writeHead(204).end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
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
    res.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "e2e-session",
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});

srv.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(srv.address().port) + "\n");
});
