// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18 third slice e2e: Settings-connected MCP servers ride into the
// codex session as `config.mcp_servers` on thread/start (frozen
// CodexSession threadParameters). Verified against the OFFLINE fixture
// — its persisted per-thread rows record the config it actually
// received; a "badmcp" entry answers with a real config-load refusal so
// the frozen strip-and-retry path is exercised end to end. Nothing here
// proves a real provider or a real MCP server.

import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const dirD = realpathSync(mkdtempSync(join(tmpdir(), "tivano-e2e-mcp-d-")));
  const projD = seedProject("mcp-proj-d", dirD);
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

  // MC-19: the saved registry rides into thread/start with resolved command path.
  await page.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    {
      mcpServers: [
        {
          id: "mcp-a",
          name: "localfs",
          command: process.execPath,
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
      row1.config?.mcp_servers?.localfs?.command === process.execPath &&
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
        { id: "mcp-c", name: "badmcp", command: process.execPath, args: [] },
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

  // MC-22 (P1-33): bare command resolves to full path while a missing command
  // is omitted with a single warning notice and the session still completes.
  const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "tivano-e2e-mcp-shim-")));
  const isWin = process.platform === "win32";
  const shimBase = "tivano-e2e-codex-mcp";
  const shimFull = join(shimDir, isWin ? `${shimBase}.cmd` : shimBase);
  writeFileSync(shimFull, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!isWin) chmodSync(shimFull, 0o755);
  try {
    await page.evaluate(
      (a) => window.tivano.invoke("settings:set", a),
      {
        mcpServers: [
          {
            id: "mcp-d1",
            name: "bareok",
            command: shimBase,
            args: ["--ok"],
            env: isWin ? { Path: shimDir } : { PATH: shimDir },
          },
          {
            id: "mcp-d2",
            name: "missingSrv",
            command: "tivano-missing-e2e-mcp-xyz",
            args: [],
          },
        ],
      },
    );
    const t4 = (await mkThread(page, projD)).id;
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId: t4, text: "hello p1-33" },
    );
    const s4 = await waitSnapshot(
      page,
      (st) =>
        rowFor(dirD) !== undefined &&
        st.threads.find((x) => x.id === t4)?.turn?.status === "done",
    );
    const row4 = rowFor(dirD);
    const thread4 = s4.threads.find((x) => x.id === t4);
    const notice4 = (thread4?.messages ?? []).find(
      (m) =>
        m.kind === "notice" &&
        m.content.includes("MCP servers skipped for this session because their command was not found on PATH: missingSrv"),
    );
    verify(
      "MC-22 bare MCP command resolved and missing server skipped with notice",
      row4?.config?.mcp_servers?.bareok?.command === shimFull &&
        row4?.config?.mcp_servers?.missingSrv === undefined &&
        notice4 !== undefined,
      { config: row4?.config, notice: notice4?.content },
    );
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }

  await boundedClose(s.app, s.proc);
  rmSync(dirD, { recursive: true, force: true });
}
