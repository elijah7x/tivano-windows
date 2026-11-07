// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F09 local commands e2e — /compact on the offline Codex fixture sends
// thread/compact/start and lands standalone notices; unsupported mock
// falls through to a plain send; /plan toggles the interaction mode.

import { join } from "node:path";

export async function runCompactChecks({
  launch: launchApp,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const launchCodex = (label) =>
    launchApp(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
      },
      label,
    );
  const launchMock = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitSnap = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };
  const typeAndSend = async (page, text) => {
    await page.locator(".composer textarea").fill(text);
    // Frozen suggestion semantics: Enter over an open menu picks the
    // row into a chip — a second Enter actually sends it.
    await page.keyboard.press("Enter");
    if (text.startsWith("/") && (await page.$(".cmd-chip"))) {
      await page.keyboard.press("Enter");
    }
  };
  const notices = (s, tid) =>
    s.threads
      .find((y) => y.id === tid)
      .messages.filter((m) => m.kind === "notice")
      .map((m) => ({ text: m.content, level: m.noticeLevel, turnId: m.turnId }));
  const newCodexThread = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`button[title="New thread in ${name}"]`);
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };

  // --- session CP1: /compact on a bound session --------------------------
  let s = await launchCodex("s-compact-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid = await newCodexThread(page, "Compact Proj");
  await typeAndSend(page, "hello compact");
  await waitSnap(page, (x) => x.threads.find((y) => y.id === tid)?.turn?.status === "done");

  await typeAndSend(page, "/compact");
  const s1 = await waitSnap(
    page,
    (x) => notices(x, tid).some((n) => n.text === "Context compacted."),
  );
  const n1 = notices(s1, tid);
  const compacted = n1.find((n) => n.text === "Context compacted.");
  const compacting = n1.find((n) => n.text === "Compacting context.");
  verify("CP-01 compacting + compacted notices landed", !!compacted && !!compacting, n1);
  verify(
    "CP-02 notices are standalone (not folded into the dead turn)",
    compacted?.turnId === undefined && compacting?.turnId === undefined,
    n1,
  );
  verify("CP-03 /compact produced no extra user turn", !s1.threads.find((y) => y.id === tid).messages.some((m) => m.role === "user" && m.content === "/compact"), n1);
  await page.waitForSelector(".notice-row", { timeout: 10000 });
  await page.screenshot({ path: join(outDir, "92-compact.png") });

  // /compact on a never-started thread — the frozen "nothing yet" path.
  const tid2 = await newCodexThread(page, "Compact Empty");
  await typeAndSend(page, "/compact");
  const s2 = await waitSnap(
    page,
    (x) => notices(x, tid2).some((n) => n.text === "Nothing to compact yet."),
  );
  verify("CP-04 unbound session is the frozen nothing-to-compact notice", true, notices(s2, tid2));

  // /plan toggles build↔plan on the composer.
  const before = (await snap(page)).threads.find((y) => y.id === tid2)?.interactionMode ?? "build";
  await typeAndSend(page, "/plan");
  const s3 = await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tid2)?.interactionMode !== before,
  );
  const after = s3.threads.find((y) => y.id === tid2)?.interactionMode;
  verify("CP-05 /plan toggled the interaction mode", before === "build" && after === "plan", { before, after });
  await typeAndSend(page, "/plan");
  const s4 = await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tid2)?.interactionMode === "build",
  );
  verify("CP-06 /plan toggles back to build", true, s4.threads.find((y) => y.id === tid2)?.interactionMode);
  let c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("compact-a exited cleanly", c.exited && c.outcome === "resolved", c.outcome);

  // --- session CP2: mock falls through to a plain send -------------------
  s = await launchMock("s-compact-b");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const tidM = await page.evaluate(
    (p) => window.tivano.invoke("threads:create", p).then((t) => t.id),
    { projectId: null, title: "MockCompact" },
  );
  await typeAndSend(page, "/compact");
  const s5 = await waitSnap(
    page,
    (x) => x.threads.find((y) => y.id === tidM)?.turn?.status === "done",
  );
  const th5 = s5.threads.find((y) => y.id === tidM);
  verify(
    "CP-07 mock sends /compact as ordinary text (frozen fall-through)",
    th5.messages.some((m) => m.role === "user" && m.content === "/compact") &&
      th5.messages.filter((m) => m.kind === "notice").length === 0,
    th5.messages.map((m) => m.content).slice(0, 4),
  );
  c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("compact-b exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
