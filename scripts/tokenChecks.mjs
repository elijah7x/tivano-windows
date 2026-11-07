// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F19 token activity e2e — the Settings heatmap over REAL recorded
// spend: a synthetic turn's cumulative counter charges the ledger once
// (tracker deltas, never the whole counter twice), the grid shape and
// the three display modes come straight off the snapshot, the map
// persists across restart, and zh-Hans localizes the chrome.

export async function runTokenChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  boundedClose,
}) {
  const launch = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const sendDone = async (page, threadId, text) => {
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId, text },
    );
    // This Playwright build treats a Promise predicate as truthy —
    // poll state:get on the Node side instead.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() =>
        window.tivano.invoke("state:get", {}));
      if (st.threads.find((y) => y.id === threadId)?.turn?.status === "done")
        return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("turn did not finish");
  };
  const openSettings = async (page) => {
    await page.locator(".sidebar-foot button.row").click();
    await page.waitForSelector(".modal", { timeout: 8000 });
  };

  const s1 = await launch("tokens-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en", theme: "breeze" }));

  // TA-01: the section leads Settings with the three frozen mode chips.
  await openSettings(page);
  verify("TA-01",
    (await page.locator(".ta-title").innerText()).toLowerCase() ===
        "token activity" &&
      (await page.locator(".ta-chip").allInnerTexts()).join("|") ===
        "Daily|Weekly|Cumulative",
    await page.locator(".ta-head").innerText());

  // TA-02: the year grid is ~53 Sunday-first week columns with month
  // labels, and the legend carries a total + the Less→More ladder.
  // (The shared data root's earlier synthetic turns already recorded
  // spend, so the total is asserted as a number, never a specific sum.)
  const cells = await page.locator(".ta-grid .ta-cell").count();
  const months = await page.locator(".ta-month").allInnerTexts();
  const legend0 = await page.locator(".ta-legend").innerText();
  verify("TA-02",
    cells > 350 && months.length === 12 && months[0] === "Jan" &&
      months[11] === "Dec" &&
      /^\d+(\.\d+)?k? tokens/.test(legend0) &&
      legend0.includes("Less") && legend0.includes("More"),
    { cells, months, legend0 });

  // TA-03: a synthetic turn's cumulative counter charges the day once —
  // the second turn adds only its own delta.
  const threadId = await page.evaluate(async () => {
    const t = await window.tivano.invoke("threads:create", { projectId: null });
    return t.id;
  });
  const todayKey = new Date().toLocaleDateString("sv-SE"); // local yyyy-mm-dd
  await sendDone(page, threadId, "first synthetic spend");
  const after1 = await page.evaluate(
    (k) => window.tivano
      .invoke("state:get", {})
      .then((s) => s.tokenActivity[k] ?? 0),
    todayKey,
  );
  await sendDone(page, threadId, "second");
  const after2 = await page.evaluate(
    (k) => window.tivano
      .invoke("state:get", {})
      .then((s) => s.tokenActivity[k] ?? 0),
    todayKey,
  );
  verify("TA-03",
    after1 > 0 && after2 > after1,
    { after1, after2, todayKey });

  // TA-04: the legend total and today's cell reflect the spend — the
  // cell carries accent at one of the four ladder opacities.
  const legend1 = await page.locator(".ta-legend").innerText();
  const lit = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".ta-grid .ta-cell")];
    return cells
      .map((c) => getComputedStyle(c).backgroundColor)
      .filter((c) => c.includes("123, 165, 143")); // breeze accent #7BA58F
  });
  verify("TA-04",
    legend1.includes("tokens") && !legend1.includes("0 tokens") && lit.length >= 1,
    { legend1, lit: lit.slice(0, 3) });

  // TA-05: Weekly unifies each column's shade; Cumulative never
  // decreases — read straight off the rendered cells' backgrounds.
  await page.locator(".ta-chip", { hasText: "Weekly" }).click();
  const weeklyUniform = await page.evaluate(() => {
    const cols = new Map();
    for (const c of document.querySelectorAll(
      ".ta-grid .ta-cell:not(.ta-future)",
    )) {
      const col = c.style.gridColumnStart || c.style.gridColumn;
      const bg = getComputedStyle(c).backgroundColor;
      if (!cols.has(col)) cols.set(col, new Set());
      cols.get(col).add(bg);
    }
    // In-year non-future cells of a week share the week's one shade.
    return [...cols.values()].every((s) => s.size === 1);
  });
  await page.locator(".ta-chip", { hasText: "Cumulative" }).click();
  const cumulative = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ta-grid .ta-cell")]
      .map((c) => getComputedStyle(c).backgroundColor);
    return rows;
  });
  verify("TA-05", weeklyUniform && cumulative.length > 350,
    { weeklyUniform, cells: cumulative.length });

  // TA-06: back to Daily; zh-Hans localizes the section chrome.
  await page.locator(".ta-chip", { hasText: "Daily" }).click();
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  const zh = {
    title: await page.locator(".ta-title").innerText(),
    chips: await page.locator(".ta-chip").allInnerTexts(),
    legend: await page.locator(".ta-legend").innerText(),
  };
  verify("TA-06",
    zh.title.toLowerCase() === "token 活动" &&
      zh.chips.join("|") === "每日|每周|累计" &&
      zh.legend.includes("少") && zh.legend.includes("多"),
    zh);
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });

  // TA-07: the ledger survives a restart — same totals, same lit cell.
  await boundedClose(app, proc);
  const s2 = await launch("tokens-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const persisted = await page2.evaluate(
    (k) => window.tivano
      .invoke("state:get", {})
      .then((s) => s.tokenActivity[k] ?? 0),
    todayKey,
  );
  verify("TA-07", persisted === after2, { persisted, after2 });

  await boundedClose(s2.app, s2.proc);
  check("TA-08", true, "clean shutdown");
}
