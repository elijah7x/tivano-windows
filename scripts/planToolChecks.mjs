// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 plan/todos/tool e2e — OFFLINE Codex fixture only: plan items land as
// a collapsible markdown block, turn/plan/updated lands as a todos row,
// mcpToolCall/webSearch/dynamicToolCall land as structured tool rows with
// frozen kind/state semantics, all persisting across restart and
// localizing. Never proof of a real provider.

import { join } from "node:path";

export async function runPlanToolChecks({
  launch: launchApp,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) =>
    launchApp(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
        ...overrides,
      },
      label,
    );
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitSnapshot = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };

  // --- session PT1: plan block + todos + tool rows -----------------------
  let s = await launch({}, "s-plantool-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const projId = await page.evaluate(() =>
    window.tivano.invoke("projects:create", { name: "Plan Proj" }),
  );
  const tid = (
    await page.evaluate((p) => window.tivano.invoke("threads:create", { projectId: p.id }), projId)
  ).id;
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);

  await page.locator(".composer textarea").fill("plan the change");
  await page.keyboard.press("Enter");
  const s1 = await waitSnapshot(
    page,
    (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done",
  );
  const th = s1.threads.find((y) => y.id === tid);
  const pm = th.messages.find((m) => m.kind === "plan");
  verify(
    "PLAN-01 plan item landed done with the completed markdown",
    pm?.status === "done" && pm.content === "## Fixture plan\n1. Survey\n2. Draft\n3. Verify",
    pm?.content?.slice(0, 120),
  );
  const am = th.messages.find((m) => m.role === "assistant");
  verify(
    "PLAN-02 plan stayed out of the assistant message",
    am && !am.content.includes("Fixture plan"),
    am?.content?.slice(0, 120),
  );
  const tm = th.messages.find((m) => m.kind === "todos");
  verify(
    "PLAN-03 todos row carries the last whole step list",
    tm &&
      tm.steps?.length === 3 &&
      tm.steps[2].text === "Verify and report" &&
      tm.steps[2].status === "active",
    tm?.steps,
  );
  const toolMsgs = th.messages.filter((m) => m.kind === "tool");
  verify("PLAN-04 three tool rows landed", toolMsgs.length === 3, toolMsgs.length);
  const mcp = toolMsgs.find((m) => m.tool?.kind === "mcp");
  verify(
    "PLAN-05 mcp row: server · tool title, result detail, completed",
    mcp?.tool?.title === "fixture-mcp · lookup" &&
      mcp.tool.state === "completed" &&
      mcp.tool.detail === "mcp fixture result",
    mcp?.tool,
  );
  const web = toolMsgs.find((m) => m.tool?.kind === "web");
  verify(
    "PLAN-06 web row: query title, completed without detail",
    web?.tool?.title === "fixture plan search" && web.tool.state === "completed",
    web?.tool,
  );
  const dyn = toolMsgs.find((m) => m.tool?.kind === "other");
  verify(
    "PLAN-07 dynamic row: tool name, completed",
    dyn?.tool?.title === "fixtureDynamicTool" && dyn.tool.state === "completed",
    dyn?.tool,
  );
  await page.waitForSelector(".plan-block", { timeout: 10000 });
  await page.waitForSelector(".todo-block", { timeout: 10000 });
  const planHead = await page.locator(".plan-block summary").innerText();
  verify("PLAN-08 plan block renders labelled Plan", planHead.trim().startsWith("Plan"), planHead);
  const mcpRow = page.locator(".tool-row", { hasText: "fixture-mcp" }).first();
  const stateText = await mcpRow.locator(".tool-state").innerText();
  verify("PLAN-09 tool row state label renders", stateText.trim() === "Completed", stateText);
  await page.screenshot({ path: join(outDir, "89-plan-tool.png") });
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("plantool-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session PT2: restart persistence + zh labels ----------------------
  s = await launch({}, "s-plantool-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const s2 = await waitSnapshot(
    page,
    (x) => {
      const t = x.threads.find((y) => y.id === tid);
      return (
        t?.messages.some((m) => m.kind === "plan") &&
        t?.messages.some((m) => m.kind === "todos") &&
        t?.messages.filter((m) => m.kind === "tool").length === 3
      );
    },
  );
  verify("PLAN-10 plan/todos/tool rows persisted across restart", true);
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".plan-block", { timeout: 10000 });

  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".plan-block summary", { timeout: 10000 });
  const zhPlan = await page.locator(".plan-block summary").innerText();
  verify("PLAN-11 zh-Hans plan label renders", zhPlan.trim().startsWith("计划"), zhPlan);
  const zhTodo = await page.locator(".todo-head").innerText();
  verify("PLAN-12 zh-Hans steps header renders", zhTodo.trim().startsWith("步骤"), zhTodo);
  const zhState = await page
    .locator(".tool-row", { hasText: "fixture-mcp" })
    .first()
    .locator(".tool-state")
    .innerText();
  verify("PLAN-13 zh-Hans tool state renders", zhState.trim() === "已完成", zhState);
  await page.screenshot({ path: join(outDir, "90-plan-tool-zh.png") });
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("plantool-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
