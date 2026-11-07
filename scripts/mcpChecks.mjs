// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A54 e2e — F18 bounded slice: MCP settings registers local stdio
// server configs and CHECK runs the real probe (spawn → initialize →
// tools/list) against the synthetic fakeMcpServer.cjs fixture. Covers
// the honest failure states (missing binary, exit+stderr, malformed
// tool list, silence timeout), removal, restart persistence, and
// zh-Hans. HTTP/OAuth transports and provider bridging stay out of
// slice — nothing here claims a real MCP package or a provider session.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(SCRIPTS_DIR, "scripts", "fakeMcpServer.cjs");

export async function runMcpChecks({
  launch,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitFor = async (locator, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await locator.count()) > 0) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected element");
  };

  // 5s probe bound: generous for a local spawn + two JSON-RPC rounds,
  // still short enough for the silence-timeout check to finish.
  const s1 = await launch({ TIVANO_MCP_PROBE_TIMEOUT_MS: "5000" }, "mcp-main");
  instances.push(s1);
  const { app } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const openSettings = async () => {
    if ((await page.locator(".modal").count()) === 0) {
      await page.locator(".sidebar-foot button.row").click();
      await page.waitForSelector(".modal", { timeout: 8000 });
    }
    await page.locator(".mcp-section").scrollIntoViewIfNeeded();
    await page.waitForSelector(".mcp-add, .mcp-form", { timeout: 8000 });
  };
  await openSettings();

  // ---- MC-01/02: section + empty state -------------------------------
  verify("MC-01 Add server button", await page.locator(".mcp-add").count() === 1);
  verify(
    "MC-02 empty state",
    (await page.locator(".mcp-section .kv").first().textContent()).includes(
      "No tools listed yet.",
    ),
  );

  // ---- MC-03: form validation ----------------------------------------
  await page.locator(".mcp-add").click();
  await page.waitForSelector(".mcp-form");
  await page.locator(".mcp-f-save").click();
  verify(
    "MC-03a empty name rejected",
    (await page.locator(".mcp-err").textContent()) === "The server needs a name.",
  );
  await page.locator(".mcp-f-name").fill("fake");
  await page.locator(".mcp-f-save").click();
  verify(
    "MC-03b empty command rejected",
    (await page.locator(".mcp-err").textContent()) === "A stdio server needs a command.",
  );

  // ---- MC-04..07: real probe against the synthetic fixture -----------
  await page.locator(".mcp-f-command").fill(process.execPath);
  await page.locator(".mcp-f-args").fill(FIXTURE);
  await page.locator(".mcp-f-env").fill("MCP_FAKE_MODE=ok\nMCP_FAKE_NAME=e2e-srv");
  await page.locator(".mcp-f-save").click();
  const row = page.locator(".mcp-row").first();
  await row.waitFor();
  verify(
    "MC-04 row shows name + command",
    (await row.locator(".mcp-name").textContent()) === "fake" &&
      (await row.locator(".mcp-cmd").textContent()).includes("fakeMcpServer.cjs"),
  );

  await row.locator(".mcp-check").click();
  try {
    await waitFor(row.locator(".mcp-st-ok"));
  } catch (e) {
    throw new Error(
      `MC-05 probe state was: ${await row.locator(".mcp-st").textContent().catch(() => "<none>")} — ${e.message}`,
    );
  }
  verify(
    "MC-05 connected with tool count",
    (await row.locator(".mcp-st").textContent()) === "Connected · 2 tools",
    await row.locator(".mcp-st").textContent(),
  );
  verify(
    "MC-06 serverInfo surfaced",
    (await row.locator(".mcp-st").getAttribute("title")) === "e2e-srv 0.1",
  );
  await row.locator(".mcp-tools-toggle").click();
  await waitFor(row.locator(".mcp-tools li").first());
  const toolNames = await row.locator(".mcp-tools li .mono").allTextContents();
  verify("MC-07 tools listed", toolNames.join(",") === "alpha,beta", toolNames);
  await page.screenshot({ path: join(outDir, "68-mcp-connected.png") });

  // ---- MC-08..10: honest failure states ------------------------------
  const addServer = async (name, command, args = "", env = "") => {
    await page.locator(".mcp-add").click();
    await page.waitForSelector(".mcp-form");
    await page.locator(".mcp-f-name").fill(name);
    await page.locator(".mcp-f-command").fill(command);
    if (args) await page.locator(".mcp-f-args").fill(args);
    if (env) await page.locator(".mcp-f-env").fill(env);
    await page.locator(".mcp-f-save").click();
    return page.locator(".mcp-row", { hasText: name }).first();
  };

  const rDie = await addServer("dies", process.execPath, FIXTURE, "MCP_FAKE_MODE=die");
  await rDie.locator(".mcp-check").click();
  await waitFor(rDie.locator(".mcp-st-bad"));
  verify(
    "MC-08 exit code reported",
    (await rDie.locator(".mcp-st").textContent()) === "The server quit (exit 3).",
    await rDie.locator(".mcp-st").textContent(),
  );
  verify(
    "MC-08b stderr tail kept",
    ((await rDie.locator(".mcp-st").getAttribute("title")) ?? "").includes("boom at boot"),
  );

  const rBad = await addServer("badtools", process.execPath, FIXTURE, "MCP_FAKE_MODE=badtools");
  await rBad.locator(".mcp-check").click();
  await waitFor(rBad.locator(".mcp-st-bad"));
  verify(
    "MC-09 malformed tool list",
    (await rBad.locator(".mcp-st").textContent()) ===
      "The server sent an invalid tool list.",
  );

  const rMiss = await addServer("gone", "tivano-mcp-no-such-binary-xyz");
  await rMiss.locator(".mcp-check").click();
  await waitFor(rMiss.locator(".mcp-st-bad"));
  verify(
    "MC-10 missing executable",
    (await rMiss.locator(".mcp-st").textContent()).includes("isn't installed."),
  );

  const rSilent = await addServer("silent", process.execPath, FIXTURE, "MCP_FAKE_MODE=silent");
  await rSilent.locator(".mcp-check").click();
  await waitFor(rSilent.locator(".mcp-st-bad"), 15000);
  verify(
    "MC-11 silence reports timeout",
    (await rSilent.locator(".mcp-st").textContent()) ===
      "The server didn't answer in time.",
    await rSilent.locator(".mcp-st").textContent(),
  );

  // ---- MC-12: duplicate name rejected ---------------------------------
  await page.locator(".mcp-add").click();
  await page.waitForSelector(".mcp-form");
  await page.locator(".mcp-f-name").fill("fake");
  await page.locator(".mcp-f-command").fill("x");
  await page.locator(".mcp-f-save").click();
  verify(
    "MC-12 duplicate name rejected",
    (await page.locator(".mcp-err").textContent()).includes("already exists"),
  );
  await page.locator(".mcp-form-ops .choice:not(.active)").click();

  // ---- MC-13: removal -------------------------------------------------
  await rSilent.locator(".mcp-remove").click();
  verify(
    "MC-13 remove drops the row",
    (await page.locator(".mcp-row", { hasText: "silent" }).count()) === 0,
  );

  // ---- MC-14: restart persistence -------------------------------------
  const st = await snap(page);
  verify(
    "MC-14a registry in snapshot",
    (st.settings.mcpServers ?? []).length === 4,
    (st.settings.mcpServers ?? []).map((x) => x.name),
  );
  await boundedClose(s1.app, s1.proc);
  instances.pop();
  const s2 = await launch({ TIVANO_MCP_PROBE_TIMEOUT_MS: "5000" }, "mcp-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page2.locator(".sidebar-foot button.row").click();
  await page2.waitForSelector(".modal", { timeout: 8000 });
  await page2.locator(".mcp-section").scrollIntoViewIfNeeded();
  verify(
    "MC-14b servers survive restart",
    (await page2.locator(".mcp-row").count()) === 4,
  );

  // ---- MC-15: zh-Hans --------------------------------------------------
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  const row2 = page2.locator(".mcp-row", { hasText: "fake" }).first();
  await row2.locator(".mcp-check").click();
  await waitFor(row2.locator(".mcp-st-ok"));
  verify(
    "MC-15 zh status localized",
    (await row2.locator(".mcp-st").textContent()) === "已连接 · 2 个工具",
    await row2.locator(".mcp-st").textContent(),
  );
  verify(
    "MC-15b zh add button",
    (await page2.locator(".mcp-add").textContent()) === "添加服务器",
  );
  await page2.screenshot({ path: join(outDir, "69-mcp-zh.png") });
  await boundedClose(s2.app, s2.proc);
  instances.pop();

  // ---- MC-16..18: streamable-HTTP transport (F18 second slice) ------
  // A real local fixture speaks the spec's POST path; checks run through
  // the real bridge (mcp:probe + the settings UI), never direct calls.
  const openLog = join(outDir, "open-external.log");
  const s3 = await launch(
    {
      TIVANO_MCP_PROBE_TIMEOUT_MS: "5000",
      TIVANO_TEST_OPEN_LOG: openLog,
      TIVANO_TEST_MCP_PICK: "/tmp/e2e-mcp-root",
    },
    "mcp-http",
  );
  instances.push(s3);
  const page3 = await s3.app.firstWindow();
  await page3.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page3.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const hdrLog = join(outDir, "mcp-headers.log");
  const fx = spawn(process.execPath, [join(SCRIPTS_DIR, "scripts", "fakeMcpHttp.cjs")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, MCP_HDR_LOG: hdrLog },
  });
  const port = await new Promise((resolve, reject) => {
    fx.stdout.once("data", (d) => resolve(Number(d.toString().trim())));
    setTimeout(() => reject(new Error("fixture printed no port")), 8000);
  });
  try {
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const cur = (await snap(page3)).settings.mcpServers ?? [];
    await page3.evaluate(
      (a) => window.tivano.invoke("settings:set", a),
      {
        mcpServers: [
          ...cur,
          { id: "httpx", name: "httpx", transport: "http", command: "", args: [], url: endpoint },
        ],
      },
    );
    const probe = await page3.evaluate(
      (a) => window.tivano.invoke("mcp:probe", a),
      { transport: "http", command: "", args: [], url: endpoint },
    );
    verify(
      "MC-16 http probe connects over real JSON-RPC",
      probe.status === "connected" && probe.serverName === "http-fixture",
      probe,
    );
    verify(
      "MC-16b tools listed",
      (probe.tools ?? []).map((t) => t.name).join(",") === "alpha,beta",
      probe.tools,
    );

    await page3.locator(".sidebar-foot button.row").click();
    await page3.waitForSelector(".modal", { timeout: 8000 });
    await page3.locator(".mcp-section").scrollIntoViewIfNeeded();
    const rHttp = page3.locator(".mcp-row", { hasText: "httpx" }).first();
    verify(
      "MC-17 row shows the endpoint, not a command",
      (await rHttp.locator(".mcp-cmd").textContent()).includes(`:${port}/mcp`),
      await rHttp.locator(".mcp-cmd").textContent(),
    );
    await rHttp.locator(".mcp-check").click();
    await waitFor(rHttp.locator(".mcp-st-ok"));
    verify(
      "MC-17b UI check connects",
      (await rHttp.locator(".mcp-st").textContent()).includes("Connected · 2 tools"),
      await rHttp.locator(".mcp-st").textContent(),
    );
    await page3.screenshot({ path: join(outDir, "72-mcp-http.png") });

    await page3.locator(".mcp-add").click();
    verify(
      "MC-18 transport picker offered",
      (await page3.locator(".mcp-transport").count()) === 1,
    );
    await page3.locator(".mcp-transport .choice", { hasText: "Streamable HTTP" }).click();
    verify(
      "MC-18b http mode shows the URL field",
      (await page3.locator(".mcp-f-url").count()) === 1 &&
        (await page3.locator(".mcp-f-command").count()) === 0,
    );
    await page3.locator(".mcp-form-ops .choice:not(.active)").click();

    // ---- MC-19..23: A73 catalog picker -------------------------------
    // Frozen MCPCatalog ported: grouped registry, OAuth rows honestly
    // disabled, no-field entries add straight, keyed entries take a
    // field form whose {key} templates resolve into env/headers.
    await page3.locator(".mcp-browse").click();
    await waitFor(page3.locator(".mcp-catalog"));
    verify(
      "MC-19 catalog grouped by the frozen categories",
      (await page3.locator(".mcp-cat-head").allTextContents()).join("|")
        .toLowerCase() === "developer|browser|search|work|data|cloud|knowledge",
      await page3.locator(".mcp-cat-head").allTextContents(),
    );
    verify(
      "MC-19b OAuth entries disabled with the honest note",
      (await page3.locator('.mcp-cat-row[data-entry="notion"]').count()) === 1 &&
        (await page3.locator('.mcp-cat-row[data-entry="notion"]').isDisabled()) &&
        (await page3.locator('.mcp-cat-row[data-entry="notion"] .mcp-cat-side').textContent()) ===
          "Needs sign-in",
      await page3.locator('.mcp-cat-row[data-entry="notion"] .mcp-cat-side').textContent(),
    );

    // MC-20: a no-field stdio entry adds straight from the list.
    await page3.locator('.mcp-cat-row[data-entry="fetch"]').click();
    await waitFor(page3.locator(".mcp-row", { hasText: "Fetch" }));
    const rFetch = page3.locator(".mcp-row", { hasText: "Fetch" }).first();
    verify(
      "MC-20 no-field entry adds with its resolved command",
      (await rFetch.locator(".mcp-cmd").textContent()).includes("uvx mcp-server-fetch"),
      await rFetch.locator(".mcp-cmd").textContent(),
    );

    // MC-21: a required-field entry opens its field form (save gated);
    // the typed token resolves into the Authorization header.
    await page3.locator('.mcp-cat-row[data-entry="github"]').click();
    await waitFor(page3.locator(".mcp-cat-form"));
    verify(
      "MC-21 keyed entry opens the field form with key links + gate",
      (await page3.locator('.mcp-cat-form input[data-field="token"]').count()) === 1 &&
        (await page3.locator(".mcp-cat-keys").count()) === 1 &&
        (await page3.locator(".mcp-cat-save").isDisabled()),
    );
    await page3.locator('.mcp-cat-form input[data-field="token"]').fill("ghp_e2e");
    await page3.locator(".mcp-cat-save").click();
    await waitFor(page3.locator(".mcp-row", { hasText: "GitHub" }));
    const st3 = await snap(page3);
    const ctx = (st3.settings.mcpServers ?? []).find((s) => s.id === "github");
    verify(
      "MC-21b saved server carries the resolved Authorization header",
      ctx?.transport === "http" &&
        ctx.url === "https://api.githubcopilot.com/mcp/" &&
        ctx.headers?.Authorization === "Bearer ghp_e2e",
      ctx,
    );

    // MC-22: a header-templated entry pointed at the local fixture proves
    // the wire path — save a copy of Context7 with the fixture's URL.
    const cur2 = (await snap(page3)).settings.mcpServers ?? [];
    await page3.evaluate(
      (a) => window.tivano.invoke("settings:set", a),
      {
        mcpServers: [
          ...cur2,
          {
            id: "ctxfx", name: "ctxfx", transport: "http", command: "", args: [],
            url: endpoint, headers: { Authorization: "Bearer ghp_e2e" },
          },
        ],
      },
    );
    const probe2 = await page3.evaluate(
      (a) => window.tivano.invoke("mcp:probe", a),
      {
        transport: "http", command: "", args: [], url: endpoint,
        headers: { Authorization: "Bearer ghp_e2e" },
      },
    );
    const wire = readFileSync(hdrLog, "utf8").trim().split("\n").map(JSON.parse);
    verify(
      "MC-22 header reached the wire and probe still connects",
      probe2.status === "connected" &&
        wire.some((h) => h.authorization === "Bearer ghp_e2e"),
      { status: probe2.status, auth: wire.map((h) => h.authorization) },
    );

    // MC-23: a required-field entry gates its save until typed (slack's
    // token field is required), and the docs/key links are offered.
    await page3.locator('.mcp-cat-row[data-entry="slack"]').click();
    await waitFor(page3.locator(".mcp-cat-form"));
    verify(
      "MC-23 save stays disabled until the required token is typed",
      (await page3.locator(".mcp-cat-save").isDisabled()) &&
        (await page3.locator(".mcp-cat-doc").count()) >= 1,
    );
    await page3.locator(".mcp-form-ops .choice:not(.active)").click();

    // ---- MC-24..26: A74 frozen MCPKeyPanel parity --------------------
    // The key page opens in the browser as the form appears (recorded
    // via the main-owned test seam — never a real shell.openExternal),
    // numbered steps describe the flow, and a path field's browse button
    // rides the main-owned native chooser.
    const opened = existsSync(openLog)
      ? readFileSync(openLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    verify(
      "MC-24 keyed picks opened their keysURL in the browser",
      opened.includes("https://github.com/settings/personal-access-tokens/new") &&
        opened.includes("https://api.slack.com/apps"),
      opened,
    );
    await page3.locator('.mcp-cat-row[data-entry="github"]').click();
    await waitFor(page3.locator(".mcp-cat-form"));
    verify(
      "MC-24b frozen numbered steps render",
      (await page3.locator(".mcp-step-n").allTextContents()).join("") === "123" &&
        (await page3.locator(".mcp-cat-form").innerText()).includes(
          "The page is open in your browser",
        ),
      await page3.locator(".mcp-cat-form").innerText(),
    );
    await page3.screenshot({ path: join(outDir, "74-mcp-key-form.png") });
    await page3.locator(".mcp-form-ops .choice:not(.active)").click();

    // MC-25: filesystem's root is a path field → folder browse, test
    // pick returns /tmp/e2e-mcp-root, save resolves args with it.
    await page3.locator('.mcp-cat-row[data-entry="filesystem"]').click();
    await waitFor(page3.locator(".mcp-cat-form"));
    verify(
      "MC-25 path field offers the browse button",
      (await page3.locator(".mcp-cat-browse").count()) === 1,
    );
    await page3.locator(".mcp-cat-browse").click();
    // The pick rides the real IPC — poll for the filled value rather
    // than reading in the same tick.
    let pickedVal = "";
    {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        pickedVal = await page3
          .locator('.mcp-cat-form input[data-field="root"]')
          .inputValue();
        if (pickedVal === "/tmp/e2e-mcp-root") break;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    verify(
      "MC-25b native pick fills the field",
      pickedVal === "/tmp/e2e-mcp-root",
      pickedVal,
    );
    await page3.locator(".mcp-cat-save").click();
    await waitFor(page3.locator(".mcp-row", { hasText: "Filesystem" }));
    const st4 = await snap(page3);
    const fsv = (st4.settings.mcpServers ?? []).find((s) => s.id === "filesystem");
    verify(
      "MC-25c saved server resolves the picked root",
      fsv?.args?.[fsv.args.length - 1] === "/tmp/e2e-mcp-root",
      fsv,
    );

    // MC-26: "Save and connect" probes immediately — the GitHub row's
    // status leaves "Not checked" without a manual Check press.
    const rGh = page3.locator(".mcp-row", { hasText: "GitHub" }).first();
    const ghText = await rGh.locator(".mcp-st").textContent();
    verify(
      "MC-26 save-and-connect already probed the GitHub row",
      ghText !== "Not checked",
      ghText,
    );

    await page3.screenshot({ path: join(outDir, "73-mcp-catalog.png") });
    await page3.locator(".mcp-browse").click();
  } finally {
    fx.kill();
  }
  await boundedClose(s3.app, s3.proc);
  instances.pop();
}
