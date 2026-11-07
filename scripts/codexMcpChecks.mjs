// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18 third slice e2e: Settings-connected MCP servers ride into the
// codex session as `config.mcp_servers` on thread/start (frozen
// CodexSession threadParameters). Verified against the OFFLINE fixture
// — its persisted per-thread rows record the config it actually
// received; a "badmcp" entry answers with a real config-load refusal so
// the frozen strip-and-retry path is exercised end to end. Nothing here
// proves a real provider or a real MCP server.

import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function runCodexMcpChecks({
  launch: launchApp,
  instances,
  snap,
  dataRoot,
  codexFixture,
  workspaceRoot,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitSnapshot = async (page, predicate, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await snap(page);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 80));
    }
    return last;
  };
  // The fixture persists each bound thread under CODEX_HOME — the app's
  // private codex-home inside this run's dataRoot.
  const fixtureRows = () => {
    const dir = join(dataRoot, "codex-home", "fixture-state");
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("thread-"));
    } catch {
      return [];
    }
    return files.map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        return null;
      }
    }).filter(Boolean);
  };
  const rowFor = (dirPhys) =>
    fixtureRows().find((r) => {
      try {
        return realpathSync(r.cwd) === dirPhys;
      } catch {
        return false;
      }
    });
  // Managed `proj-*` directories never land on the project record —
  // `directory` is set only for user-attached dirs. Seed two synthetic
  // dirs as USER grants (worktreeChecks convention) so each check's
  // fixture row is matched by its own unambiguous cwd.
  const seedProject = (name, dir) => {
    const id = randomUUID();
    const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
    doc.projects.push({
      id,
      name,
      createdAt: Date.now(),
      expanded: true,
      directory: dir,
    });
    writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
    const gdoc = JSON.parse(
      readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
    );
    gdoc.userGrants[id] = dir;
    writeFileSync(
      join(dataRoot, "workspace-grants.json"),
      JSON.stringify(gdoc),
    );
    return id;
  };
  const dirA = realpathSync(mkdtempSync(join(tmpdir(), "tivano-e2e-mcp-a-")));
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), "tivano-e2e-mcp-b-")));
  const projA = seedProject("mcp-proj-a", dirA);
  const projB = seedProject("mcp-proj-b", dirB);
  const dirC = realpathSync(mkdtempSync(join(tmpdir(), "tivano-e2e-mcp-c-")));
  const projC = seedProject("mcp-proj-c", dirC);
  const mkThread = (page, projectId) =>
    page.evaluate(
      (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
      projectId,
    );

  const s = await launchApp(
    {
      TIVANO_PROVIDER: "codex",
      TIVANO_CODEX_FIXTURE: codexFixture,
      TIVANO_CODEX_NODE: process.execPath,
      TIVANO_WORKSPACE_ROOT: workspaceRoot,
    },
    "codex-mcp",
  );
  instances.push(s);
  const page = await s.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // MC-19: the saved registry rides into thread/start verbatim.
  await page.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    {
      mcpServers: [
        {
          id: "mcp-a",
          name: "localfs",
          command: "/usr/bin/fs-server",
          args: ["--root", "/tmp"],
          env: { TOKEN: "sekret" },
        },
        {
          id: "mcp-b",
          name: "httpx",
          transport: "http",
          command: "",
          args: [],
          url: "http://127.0.0.1:9999/mcp",
        },
      ],
    },
  );
  const t1 = (await mkThread(page, projA)).id;
  await page.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: t1, text: "hello mcp" },
  );
  await waitSnapshot(page, () => rowFor(dirA) !== undefined);
  const row1 = rowFor(dirA);
  verify(
    "MC-19 registry rides into thread/start config.mcp_servers",
    row1 &&
      row1.config?.mcp_servers?.localfs?.command === "/usr/bin/fs-server" &&
      row1.config.mcp_servers.localfs.args.join(" ") === "--root /tmp" &&
      row1.config.mcp_servers.localfs.env?.TOKEN === "sekret" &&
      row1.config.mcp_servers.httpx?.url === "http://127.0.0.1:9999/mcp",
    row1?.config,
  );

  // MC-20: a config-load refusal earns one stripped retry — the thread
  // binds anyway and the persisted row shows the retry's config-free
  // shape (frozen CodexSession requestThread).
  await page.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    {
      mcpServers: [
        { id: "mcp-c", name: "badmcp", command: "/bin/false", args: [] },
      ],
    },
  );
  const t2 = (await mkThread(page, projB)).id;
  await page.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: t2, text: "retry me" },
  );
  await waitSnapshot(
    page,
    (st) =>
      rowFor(dirB) !== undefined &&
      st.threads.find((x) => x.id === t2)?.turn?.status === "done",
  );
  const row2 = rowFor(dirB);
  const s2 = await snap(page);
  const turn2 = s2.threads.find((x) => x.id === t2)?.turn;
  verify(
    "MC-20 config refusal retries stripped and still binds",
    row2 &&
      row2.config === null &&
      (turn2 === undefined || turn2.status === "done"),
    { config: row2?.config, turn: turn2?.status },
  );

  // MC-21: an empty registry sends no config key at all — the row's
  // config stays null exactly like a registry-free launch.
  await page.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { mcpServers: [] },
  );
  const t3 = (await mkThread(page, projC)).id;
  await page.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: t3, text: "plain" },
  );
  await waitSnapshot(page, () => rowFor(dirC) !== undefined);
  verify(
    "MC-21 empty registry emits no config",
    rowFor(dirC)?.config === null,
    rowFor(dirC)?.config,
  );

  await boundedClose(s.app, s.proc);
}
