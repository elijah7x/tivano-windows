// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A73 MCPCatalog: registry integrity, frozen grouping, {key}
// placeholder resolution, "~" expansion, OAuth honesty (resolve →
// null), plus the codex http_headers emission and the IPC/store header
// validators.

import { describe, expect, it } from "vitest";
import {
  MCP_CATALOG,
  catalogByCategory,
  catalogEntry,
  catalogNeedsInput,
  resolveCatalogEntry,
} from "../src/shared/mcpCatalog";
import { codexMcpServers } from "../src/shared/mcp";

describe("MCP catalog registry (A73)", () => {
  it("every id is unique and every entry carries docs + a sample tool", () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of MCP_CATALOG) {
      expect(e.docsURL).toMatch(/^https:\/\//);
      expect(e.sampleTools.length).toBeGreaterThan(0);
      if (e.keysURL) expect(e.keysURL).toMatch(/^https:\/\//);
    }
  });

  it("groups by the frozen category order with no empty groups", () => {
    const groups = catalogByCategory();
    expect(groups.map((g) => g.category)).toEqual([
      "developer", "browser", "search", "work", "data", "cloud", "knowledge",
    ]);
    for (const g of groups) {
      expect(g.entries.length).toBeGreaterThan(0);
      expect(g.entries.every((e) => e.category === g.category)).toBe(true);
    }
  });

  it("a stdio entry resolves command/args and drops the {root} default against home", () => {
    const fs = catalogEntry("filesystem")!;
    expect(fs.transport).toMatchObject({ kind: "stdio" });
    const cfg = resolveCatalogEntry(fs, {}, "/home/u")!;
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toEqual([
      "-y", "@modelcontextprotocol/server-filesystem", "/home/u",
    ]);
    expect(cfg.env).toBeUndefined();
  });

  it("typed values fill {key} in env and headers; an optional empty field drops its placeholder", () => {
    const brave = catalogEntry("brave-search")!;
    const cfg = resolveCatalogEntry(brave, { key: "BSA-123" }, "/home/u")!;
    expect(cfg.env).toEqual({ BRAVE_API_KEY: "BSA-123" });

    const ctx7 = catalogEntry("context7")!;
    // Optional API key left empty → "Bearer {key}" fills to "Bearer ",
    // which is non-empty so the frozen filter keeps it verbatim — the
    // endpoint treats it as an anonymous request and rate-limits.
    const noKey = resolveCatalogEntry(ctx7, {}, "/home/u")!;
    expect(noKey.transport).toBe("http");
    expect(noKey.url).toBe("https://mcp.context7.com/mcp");
    expect(noKey.headers).toEqual({ Authorization: "Bearer " });
    const withKey = resolveCatalogEntry(ctx7, { key: "ctx7sk-x" }, "/home/u")!;
    expect(withKey.headers).toEqual({ Authorization: "Bearer ctx7sk-x" });
  });

  it("GitHub's bearer template fills into an Authorization header", () => {
    const gh = catalogEntry("github")!;
    const cfg = resolveCatalogEntry(gh, { token: "ghp_x" }, "/home/u")!;
    expect(cfg).toMatchObject({
      id: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_x" },
    });
  });

  it("OAuth entries resolve to null — the picker never offers them", () => {
    for (const e of MCP_CATALOG.filter((x) => x.transport.kind === "oauth")) {
      expect(resolveCatalogEntry(e, { instance: "gitlab.example" }, "/home/u")).toBeNull();
    }
    expect(catalogEntry("linear")!.transport.kind).toBe("oauth");
  });

  it("needsInput only when a required field exists", () => {
    expect(catalogNeedsInput(catalogEntry("github")!)).toBe(true);
    expect(catalogNeedsInput(catalogEntry("context7")!)).toBe(false); // key optional
    expect(catalogNeedsInput(catalogEntry("fetch")!)).toBe(false);
  });

  it("constant env values (aws-docs FASTMCP_LOG_LEVEL) survive resolution", () => {
    const aws = catalogEntry("aws-docs")!;
    const cfg = resolveCatalogEntry(aws, {}, "/home/u")!;
    expect(cfg.env).toEqual({ FASTMCP_LOG_LEVEL: "ERROR" });
  });
});

describe("codexMcpServers http_headers (A73)", () => {
  it("emits http_headers for an HTTP entry with configured headers", () => {
    const out = codexMcpServers([
      {
        id: "g", name: "github", transport: "http", command: "", args: [],
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_x" },
      },
    ]);
    expect(out).toEqual({
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        http_headers: { Authorization: "Bearer ghp_x" },
      },
    });
  });

  it("an all-empty header map is dropped like an empty env", () => {
    const out = codexMcpServers([
      {
        id: "h", name: "httpx", transport: "http", command: "", args: [],
        url: "https://x/mcp", headers: { Authorization: "" },
      },
    ]);
    expect(out).toEqual({ httpx: { url: "https://x/mcp" } });
  });
});

describe("mcp headers validation (A73)", () => {
  it("rejects malformed header names and newline values at the settings edge", async () => {
    const { requestValidators } = await import("../src/shared/ipc");
    const bad = (headers: unknown) =>
      requestValidators["settings:set"]({
        mcpServers: [
          { id: "x", name: "n", command: "", args: [], transport: "http",
            url: "https://x/mcp", headers },
        ],
      });
    expect(() => bad({ "Bad Name": "v" })).toThrow(/bad header name/);
    expect(() => bad({ "X-Auth": "a\nInjected: 1" })).toThrow(/bad header value/);
    expect(() =>
      bad(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`h${i}`, "v"]))),
    ).toThrow(/headers exceed 32/);
    // A valid map passes.
    expect(() =>
      bad({ Authorization: "Bearer tok", "X-Thing": "1" }),
    ).not.toThrow();
  });
});
