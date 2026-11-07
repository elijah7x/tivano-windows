// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// A79 e2e — frozen working/streaming display parity: the working line's
// seeded rotating word + ticking elapsed + quiet label, the engine quiet
// watchdog's label→interrupt sequence, stream-mend styling of unclosed
// inline markup while a reply streams, MiniSpinner on running rows, and
// the MCP settle tick. Fixture/mock provider only — no real provider,
// no real-time waits (thresholds ride TIVANO_QUIET_* env overrides).

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_FIXTURE = join(SCRIPTS_DIR, "scripts", "fakeMcpServer.cjs");

export async function runWorkingIndicatorChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) => launchApp({ ...overrides }, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  // Sequential sessions share one data root — never run two instances at
  // once. Close the previous before launching the next and report each
  // clean exit as its own check.
  const closeQuiet = async (s, label) => {
    if (s.ledger.outcome !== "pending") return;
    const r = await boundedClose(s.app, s.proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
    s.ledger.exited = r.exited;
    s.ledger.outcome = r.killed ? `${r.outcome}+killed` : r.outcome;
    verify(`${label} instance closed cleanly`, r.exited, r.outcome);
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
  const waitFor = async (locator, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await locator.count()) > 0) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected element");
  };
  const newThread = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`button[title="New thread in ${name}"]`);
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };

  // ---- session WI live: word label + elapsed + mend + mini spinner ---
  const s1 = await launch({}, "wi-live");
  instances.push(s1);
  const p1 = await s1.app.firstWindow();
  await p1.waitForSelector(".sidebar-head", { timeout: 15000 });
  await p1.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid1 = await newThread(p1, "WI Proj");

  await p1.locator(".composer textarea").fill("hold [mock:mend]");
  await p1.keyboard.press("Enter");
  await waitSnap(
    p1,
    (x) => x.threads.find((y) => y.id === tid1)?.turn?.status === "running" &&
      x.threads.find((y) => y.id === tid1)?.messages.some((m) => m.content.includes("an open")),
  );

  // WI-01: the working card carries a rotating-word label + live elapsed.
  await p1.waitForSelector(".work-card .work-label", { timeout: 8000 });
  const label1 = (await p1.locator(".work-card .work-label").textContent()).trim();
  verify("WI-01a working label is a rotating word", label1.endsWith("…"), label1);
  await p1.waitForSelector(".work-card .work-elapsed", { timeout: 8000 });
  const elapsed = (await p1.locator(".work-card .work-elapsed").textContent()).trim();
  verify("WI-01b elapsed is narrow format", /^\d+s$|^\d+m/.test(elapsed), elapsed);

  // WI-02: sidebar running row shows the 2×3 MiniSpinner, not a still dot.
  verify(
    "WI-02 sidebar mini spinner",
    (await p1.locator(`.sidebar .row .spin-grid`).count()) >= 1,
    `spin-grids=${await p1.locator(".sidebar .spin-grid").count()}`,
  );
  verify(
    "WI-02b mini spinner has 6 cells",
    (await p1.locator(".sidebar .row .spin-cell").count()) === 6,
  );

  // WI-03: stream-mend — the unclosed `**` renders styled mid-flush.
  const strong = p1.locator(".msg.assistant .msg-body strong");
  let strongTexts = await strong.allTextContents();
  const mendDeadline = Date.now() + 8000;
  while (!strongTexts.some((x) => x.includes("an open")) && Date.now() < mendDeadline) {
    await new Promise((r) => setTimeout(r, 80));
    strongTexts = await strong.allTextContents();
  }
  verify(
    "WI-03a unclosed bold renders as <strong>",
    strongTexts.some((x) => x.includes("an open")),
    strongTexts,
  );
  await p1.screenshot({ path: join(outDir, "wi-stream-mend.png") });

  // Interrupt: the message settles and the marker reverts to literal text.
  await p1.evaluate((id) => window.tivano.invoke("turns:cancel", { threadId: id }), tid1);
  await waitSnap(
    p1,
    (x) => ["cancelled", "interrupted"].includes(x.threads.find((y) => y.id === tid1)?.turn?.status),
  );
  const settledStrong = await p1.locator(".msg.assistant .msg-body strong").allTextContents();
  const settledBody = (await p1.locator(".msg.assistant .msg-body").last().textContent()) ?? "";
  verify(
    "WI-03b settled message shows the literal marker",
    !settledStrong.some((x) => x.includes("an open")) && settledBody.includes("**an open"),
    settledStrong,
  );

  // WI-08: the running indicator's chevron folds this turn's tool +
  // thinking steps (frozen WorkingBlockView) — tool entries never render
  // as their own rows while the turn is live.
  await p1.locator(".composer textarea").fill("hold [mock:reason]");
  await p1.keyboard.press("Enter");
  await waitSnap(
    p1,
    (x) =>
      x.threads.find((y) => y.id === tid1)?.turn?.status === "running" &&
      x.threads.find((y) => y.id === tid1)?.messages.some((m) => m.kind === "tool"),
  );
  const wgDeadline = Date.now() + 8000;
  let wgLabel = "";
  while (Date.now() < wgDeadline) {
    wgLabel = ((await p1.locator(".work-card .work-label").textContent()) ?? "").trim();
    if (wgLabel.includes("·")) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  verify(
    "WI-08a counted work-group label",
    wgLabel.includes("Ran 1 command") && wgLabel.includes("Read 1 file"),
    wgLabel,
  );
  verify(
    "WI-08b running tools fold into the indicator (no rows)",
    (await p1.locator(".msg.tool-row").count()) === 0,
  );
  await p1.locator(".work-card .work-head").click();
  verify(
    "WI-08c chevron opens the folded work steps",
    (await p1.locator(".work-steps .msg.tool-row").count()) === 2,
  );
  // Settings persist per data root — pin the flag so the assertion does
  // not depend on what earlier modules left behind.
  await p1.evaluate(() =>
    window.tivano.invoke("settings:set", { showReasoning: false }),
  );
  const offDeadline = Date.now() + 4000;
  let thinkingCount = -1;
  while (Date.now() < offDeadline) {
    thinkingCount = await p1.locator(".work-thinking").count();
    if (thinkingCount === 0) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  verify(
    "WI-08d thinking stays out while showReasoning=off",
    thinkingCount === 0,
    `thinking=${thinkingCount}`,
  );
  await p1.evaluate(() =>
    window.tivano.invoke("settings:set", { showReasoning: true }),
  );
  await p1.waitForSelector(".work-thinking", { timeout: 8000 });
  verify(
    "WI-08e thinking joins the disclosure when enabled",
    ((await p1.locator(".work-thinking").first().textContent()) ?? "").includes(
      "Considering the request",
    ),
  );
  await p1.screenshot({ path: join(outDir, "wi-work-steps.png") });
  await p1.evaluate(() =>
    window.tivano.invoke("settings:set", { showReasoning: false }),
  );
  await p1.evaluate((id) => window.tivano.invoke("turns:cancel", { threadId: id }), tid1);
  await waitSnap(
    p1,
    (x) => ["cancelled", "interrupted"].includes(x.threads.find((y) => y.id === tid1)?.turn?.status),
  );
  verify(
    "WI-08f settled tools return as their own rows",
    (await p1.locator(".msg.tool-row").count()) === 2 &&
      (await p1.locator(".work-steps .msg.tool-row").count()) === 0,
  );

  await closeQuiet(s1, "wi-live");

  // ---- session WI quiet: env-shortened watchdog thresholds -----------
  const s2 = await launch(
    {
      TIVANO_QUIET_TICK_MS: "150",
      TIVANO_QUIET_LABEL_MS: "500",
      TIVANO_QUIET_STOP_MS: "1500",
    },
    "wi-quiet",
  );
  instances.push(s2);
  const p2 = await s2.app.firstWindow();
  await p2.waitForSelector(".sidebar-head", { timeout: 15000 });
  await p2.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const tid2 = await newThread(p2, "Quiet Proj");

  await p2.locator(".composer textarea").fill("hold [mock:quiet]");
  await p2.keyboard.press("Enter");
  await waitSnap(
    p2,
    (x) => x.threads.find((y) => y.id === tid2)?.turn?.status === "running",
  );

  // WI-04: silence past the label threshold → "No response for N min…".
  await p2.waitForSelector(".work-card .work-label", { timeout: 8000 });
  const deadline = Date.now() + 10000;
  let quietLabel = "";
  while (Date.now() < deadline) {
    quietLabel = ((await p2.locator(".work-card .work-label").textContent()) ?? "").trim();
    if (quietLabel.includes("No response for")) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  verify("WI-04 quiet label appears", quietLabel.includes("No response for"), quietLabel);
  await p2.screenshot({ path: join(outDir, "wi-quiet-label.png") });

  // WI-05: silence past the stop threshold → one interrupt + error notice.
  await waitSnap(
    p2,
    (x) => x.threads.find((y) => y.id === tid2)?.turn?.status === "interrupted",
    15000,
  );
  const noticeText = (await p2.locator(".notice-row.lv-error .notice-text").last().textContent()) ?? "";
  verify(
    "WI-05a quiet stop interrupts the turn",
    noticeText.includes("stopped the turn"),
    noticeText.trim(),
  );
  verify(
    "WI-05b quiet readout cleared at turn end",
    (await p2.locator(".work-card .work-label").count()) === 0,
  );
  await p2.screenshot({ path: join(outDir, "wi-quiet-stopped.png") });

  // ---- WI-06: settle chime on a real probe → connected transition ----
  await closeQuiet(s2, "wi-quiet");
  const s3 = await launch({ TIVANO_MCP_PROBE_TIMEOUT_MS: "5000" }, "wi-mcp");
  instances.push(s3);
  const p3 = await s3.app.firstWindow();
  await p3.waitForSelector(".sidebar-head", { timeout: 15000 });
  await p3.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await p3.locator(".sidebar-foot button.row").click();
  await p3.waitForSelector(".modal", { timeout: 8000 });
  await p3.locator(".mcp-section").scrollIntoViewIfNeeded();
  await p3.locator(".mcp-add").click();
  await p3.waitForSelector(".mcp-form");
  await p3.locator(".mcp-f-name").fill("tick");
  await p3.locator(".mcp-f-command").fill(process.execPath);
  await p3.locator(".mcp-f-args").fill(MCP_FIXTURE);
  await p3.locator(".mcp-f-save").click();
  // Frozen semantics: a manual add does not connect by itself — the row's
  // Check-now runs the probe, and landing in connected plays the settle tick.
  const tickRow = p3.locator(".mcp-row", { hasText: "tick" });
  await tickRow.waitFor({ timeout: 8000 });
  await tickRow.locator(".mcp-check").click();
  const chime = async () =>
    parseInt(
      await p3.evaluate(() => document.documentElement.dataset.settleChimeCount ?? "0"),
      10,
    );
  const c0 = await chime();
  const settleDeadline = Date.now() + 10000;
  let settled = false;
  while (Date.now() < settleDeadline) {
    if ((await chime()) > c0 && (await p3.locator(".mcp-st-ok").count()) === 1) {
      settled = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  verify("WI-06 settle chime on connected transition", settled, `count=${await chime()}`);

  // zh-Hans: the quiet label and working words localize.
  await closeQuiet(s3, "wi-mcp");
  const s4 = await launch(
    {
      TIVANO_QUIET_TICK_MS: "150",
      TIVANO_QUIET_LABEL_MS: "400",
      TIVANO_QUIET_STOP_MS: "60000",
    },
    "wi-zh",
  );
  instances.push(s4);
  const p4 = await s4.app.firstWindow();
  await p4.waitForSelector(".sidebar-head", { timeout: 15000 });
  // The new-project button's title/aria-label localize with the chrome —
  // build the thread while the UI is still in English.
  const tid4 = await newThread(p4, "静音项目");
  await p4.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await p4.locator(".composer textarea").fill("hold [mock:quiet]");
  await p4.keyboard.press("Enter");
  const zhDeadline = Date.now() + 10000;
  let zhLabel = "";
  while (Date.now() < zhDeadline) {
    zhLabel = ((await p4.locator(".work-card .work-label").textContent()) ?? "").trim();
    if (zhLabel.includes("无响应")) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  verify("WI-07 zh quiet label", zhLabel.includes("无响应"), zhLabel);
  await p4.screenshot({ path: join(outDir, "wi-quiet-zh.png") });

  await closeQuiet(s4, "wi-zh");
}
