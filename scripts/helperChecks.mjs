// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A62 e2e — F25 helper chat (frozen spawnSubagent/closeSubagent +
// MergeRequestLink): a merge/PR link in a chat earns the "Merge {label}"
// popover row; picking it spawns the parent's helper — a panel-bound
// thread of its own running the frozen forge brief. One helper per
// parent (a later merge queues/hands its brief to it), closing the
// panel drops the helper nested under its parent in the sidebar, and
// everything survives a restart. Synthetic provider only — nothing
// here proves a real forge CLI ever runs.

export async function runHelperChecks({
  launch,
  instances,
  snap,
  check,
  boundedClose,
}) {
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
  const helperOf = (s, parentId) =>
    s.threads.find((t) => t.parentThreadId === parentId);

  const s1 = await launch({}, "helper-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const tid = await page.evaluate(() =>
    window.tivano
      .invoke("threads:create", { projectId: null, title: "merge parent" })
      .then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "merge parent" }).click();
  await page.locator("textarea[aria-label='Message']").waitFor();
  await page
    .locator("textarea[aria-label='Message']")
    .fill("please land [the PR](https://github.com/acme/shop/pull/95) when green");
  await page.locator("button.primary").click();
  await waitSnap(
    page,
    (s) => s.threads.find((x) => x.id === tid)?.turn?.status === "done",
  );

  // HB-01: the PR link earns the frozen top row — Merge #95 first.
  const link = page.locator("a[data-md-link]", { hasText: "the PR" }).first();
  await link.waitFor();
  await link.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  const rows = await page
    .locator(".link-pop .suggest-row .suggest-name")
    .allInnerTexts();
  verify("HB-01 merge row leads the popover", rows[0] === "Merge #95", rows);

  // HB-02: Merge spawns the helper — panel-bound, parent-bound, running.
  await page.locator(".link-pop .suggest-row", { hasText: "Merge #95" }).click();
  await page.waitForSelector(".helper-panel", { timeout: 5000 });
  const st1 = await waitSnap(page, (s) => helperOf(s, tid) !== undefined);
  const helper = helperOf(st1, tid);
  verify(
    "HB-02 helper spawned panel-bound with frozen title",
    helper.isInPanel === true &&
      helper.title === "Merge #95" &&
      helper.projectId === null,
    helper,
  );
  const panelText = await page.locator(".helper-head").innerText();
  verify("HB-03 panel heads the helper", panelText.includes("Merge #95"), panelText);

  // The frozen gh brief went out as the helper's first user turn.
  await waitSnap(
    page,
    (s) => helperOf(s, tid)?.turn?.status === "done",
  );
  const st2 = await snap(page);
  const helperMsgs = helperOf(st2, tid).messages;
  verify(
    "HB-04 frozen brief is the helper's first turn",
    helperMsgs[0]?.role === "user" &&
      helperMsgs[0].content.includes("`gh pr merge 95 --merge`") &&
      helperMsgs[0].content.includes("Merge #95 now:"),
    helperMsgs[0]?.content?.slice(0, 120),
  );

  // HB-05: an open helper stays out of the sidebar (frozen isInPanel).
  const sideRows = await page
    .locator(".thread-list .row", { hasText: "Merge #95" })
    .count();
  verify("HB-05 panel helper absent from sidebar", sideRows === 0, sideRows);

  // HB-06: a second merge on the SAME parent reuses the helper — a new
  // turn on the same thread, never a second helper.
  await page.locator("textarea[aria-label='Message']").fill(
    "and [the MR](https://gl.example.com/grp/tool/-/merge_requests/7) too",
  );
  await page.locator("button.primary").click();
  await waitSnap(
    page,
    (s) => s.threads.find((x) => x.id === tid)?.turn?.status === "done",
  );
  const gl = page.locator("a[data-md-link]", { hasText: "the MR" }).first();
  await gl.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  const rows2 = await page
    .locator(".link-pop .suggest-row .suggest-name")
    .allInnerTexts();
  verify("HB-06a gitlab link labels !n", rows2[0] === "Merge !7", rows2);
  await page.locator(".link-pop .suggest-row", { hasText: "Merge !7" }).click();
  const st3 = await waitSnap(
    page,
    (s) =>
      helperOf(s, tid)?.messages.filter((m) => m.role === "user").length === 2,
  );
  verify(
    "HB-06b second merge reuses the one helper",
    helperOf(st3, tid).id === helper.id &&
      st3.threads.filter((t) => t.parentThreadId === tid).length === 1 &&
      helperOf(st3, tid).messages[2]?.content.includes("`glab mr merge 7 --yes`"),
    helperOf(st3, tid).messages.map((m) => m.role),
  );
  await waitSnap(page, (s) => helperOf(s, tid)?.turn?.status === "done");

  // HB-07: closing the panel drops the helper nested under its parent.
  await page.locator(".helper-close").click();
  await waitSnap(page, (s) => helperOf(s, tid)?.isInPanel === false);
  await page.waitForSelector(".helper-panel", {
    state: "detached",
    timeout: 5000,
  });
  const helperRow = page.locator(".row.helper-row", { hasText: "Merge #95" });
  await helperRow.waitFor();
  verify("HB-07 closed helper nests under the parent", true);

  // HB-08: a closed helper still receives merge briefs without reopening.
  const gl2 = page.locator("a[data-md-link]", { hasText: "the MR" }).first();
  await gl2.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  await page.locator(".link-pop .suggest-row", { hasText: "Merge !7" }).click();
  const st4 = await waitSnap(
    page,
    (s) =>
      helperOf(s, tid)?.messages.filter((m) => m.role === "user").length === 3,
  );
  verify(
    "HB-08 closed helper keeps receiving, stays closed",
    helperOf(st4, tid).isInPanel === false &&
      st4.threads.filter((t) => t.parentThreadId === tid).length === 1,
    helperOf(st4, tid).isInPanel,
  );
  await waitSnap(page, (s) => helperOf(s, tid)?.turn?.status === "done");

  // HB-09: the binding + closed placement survive a restart.
  await boundedClose(app, proc);
  const s2 = await launch({}, "helper-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const st5 = await waitSnap(page2, (s) => helperOf(s, tid) !== undefined);
  const rh = helperOf(st5, tid);
  verify(
    "HB-09 helper binding persisted across restart",
    rh.parentThreadId === tid && rh.isInPanel === false,
    { parentThreadId: rh.parentThreadId, isInPanel: rh.isInPanel },
  );
  await page2
    .locator(".row.helper-row", { hasText: "Merge #95" })
    .waitFor();

  // ---- A65: floating panel (frozen PlacedPanel) --------------------
  // A fresh parent earns a fresh panel to exercise drag/dock/resize.
  const tid2 = await page2.evaluate(() =>
    window.tivano
      .invoke("threads:create", { projectId: null, title: "float parent" })
      .then((t) => t.id),
  );
  await page2.locator(".thread-list .row", { hasText: "float parent" }).click();
  await page2.locator("textarea[aria-label='Message']").waitFor();
  await page2
    .locator("textarea[aria-label='Message']")
    .fill("review [the change](https://github.com/acme/shop/pull/41)");
  await page2.locator("button.primary").click();
  await waitSnap(
    page2,
    (s) => s.threads.find((x) => x.id === tid2)?.turn?.status === "done",
  );
  const link2 = page2.locator("a[data-md-link]", { hasText: "the change" });
  await link2.click({ button: "right" });
  await page2.waitForSelector(".link-pop", { timeout: 5000 });
  await page2
    .locator(".link-pop .suggest-row", { hasText: "Merge #41" })
    .click();
  await page2.waitForSelector(".helper-panel", { timeout: 5000 });
  const helperOf2 = (s) => s.threads.find((t) => t.parentThreadId === tid2);

  await page2.waitForFunction(
    () =>
      parseFloat(
        getComputedStyle(document.querySelector(".chat-row")).paddingRight,
      ) > 400,
    undefined,
    { timeout: 5000 },
  );
  const stackBox = await page2.locator(".chat-stack").boundingBox();
  const panelBox = await page2.locator(".helper-panel").boundingBox();
  const pos = await page2
    .locator(".helper-panel")
    .evaluate((el) => getComputedStyle(el).position);
  // HB-10: floating — absolutely placed inside the chat pane, docked
  // top-right by default, and the chat column keeps clear on its side.
  const padR = await page2
    .locator(".chat-row")
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
  verify(
    "HB-10 panel floats docked right, chat keeps clear",
    pos === "absolute" &&
      (await page2.locator(".helper-panel").getAttribute("data-corner")) ===
        "tr" &&
      (await page2.locator(".helper-panel").getAttribute("data-dock-side")) ===
        "right" &&
      padR > 400 &&
      panelBox.x + panelBox.width <= stackBox.x + stackBox.width + 1 &&
      panelBox.y >= stackBox.y,
    { pos, padR, panelBox, stackBox },
  );

  // HB-11: drag the head strip to the bottom-left → snaps to bl, the
  // reservation flips to the left padding.
  const head = await page2.locator(".helper-head").boundingBox();
  const pb = await page2.locator(".helper-panel").boundingBox();
  const grabDX = head.x + head.width * 0.4 - pb.x;
  const grabDY = head.y + head.height * 0.5 - pb.y;
  const blY = stackBox.height - 8 - pb.height;
  await page2.mouse.move(pb.x + grabDX, pb.y + grabDY);
  await page2.mouse.down();
  await page2.mouse.move(stackBox.x + 20 + grabDX, stackBox.y + blY + grabDY, { steps: 10 });
  await page2.mouse.up();
  await page2.waitForFunction(
    () =>
      document.querySelector(".helper-panel")?.dataset.corner === "bl" &&
      parseFloat(
        getComputedStyle(document.querySelector(".chat-row")).paddingLeft,
      ) > 400,
    undefined,
    { timeout: 5000 },
  );
  const padL = await page2
    .locator(".chat-row")
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  verify(
    "HB-11 drag docks bottom-left, reservation flips left",
    (await page2.locator(".helper-panel").getAttribute("data-dock-side")) ===
      "left" &&
      padL > 400,
    padL,
  );

  // HB-12: the frozen slack — inside ±56px of the centerline the side
  // does NOT flip; past it, it does. From bl: nudge center to mx-30
  // (still left), then to mx+100 (flips right → br).
  const w = pb.width;
  const h = pb.height;
  const mx = stackBox.width / 2;
  const originFor = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2 });
  const pbNow = async () => page2.locator(".helper-panel").boundingBox();
  const dragCorner = async (cx, cy) => {
    const o = originFor(cx, cy);
    const cur = await pbNow();
    await page2.mouse.move(cur.x + grabDX, cur.y + grabDY);
    await page2.mouse.down();
    await page2.mouse.move(stackBox.x + o.x + grabDX, stackBox.y + o.y + grabDY, { steps: 10 });
    await page2.mouse.up();
  };
  await dragCorner(mx - 30, stackBox.height - 8 - h / 2);
  await new Promise((r) => setTimeout(r, 150));
  const c1 = await page2.locator(".helper-panel").getAttribute("data-corner");
  await dragCorner(mx + 100, stackBox.height - 8 - h / 2);
  await page2.waitForFunction(
    () => document.querySelector(".helper-panel")?.dataset.corner === "br",
    undefined,
    { timeout: 5000 },
  );
  const c2 = await page2.locator(".helper-panel").getAttribute("data-corner");
  verify(
    "HB-12 dock corner keeps side inside the slack band",
    c1 === "bl" && c2 === "br",
    { c1, c2 },
  );

  // HB-13: the grip resizes the panel and persists the fitted size.
  const grip = await page2.locator(".helper-grip").boundingBox();
  const before = await pbNow();
  await page2.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page2.mouse.down();
  await page2.mouse.move(
    grip.x + grip.width / 2 + 80,
    grip.y + grip.height / 2 + 40,
    { steps: 8 },
  );
  await page2.mouse.up();
  const st6 = await waitSnap(
    page2,
    (s) => s.settings.helperPanelSize?.width >= 470,
  );
  const after = await pbNow();
  verify(
    "HB-13 grip resizes and persists helperPanelSize",
    after.width > before.width + 60 &&
      st6.settings.helperPanelSize.width === Math.round(after.width),
    { before: before.width, after: after.width, size: st6.settings.helperPanelSize },
  );

  // HB-14: the dragged size survives a restart.
  const savedSize = st6.settings.helperPanelSize;
  await boundedClose(s2.app, s2.proc);
  const s3 = await launch({}, "helper-float-restart");
  instances.push(s3);
  const page3 = await s3.app.firstWindow();
  await page3.waitForSelector(".sidebar-head", { timeout: 15000 });
  const st7 = await waitSnap(page3, (s) => helperOf2(s) !== undefined);
  verify(
    "HB-14 helperPanelSize persisted across restart",
    st7.settings.helperPanelSize?.width === savedSize.width &&
      st7.settings.helperPanelSize?.height === savedSize.height,
    st7.settings.helperPanelSize,
  );
  await boundedClose(s3.app, s3.proc);
}
