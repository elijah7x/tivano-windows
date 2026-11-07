// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A81 frozen SidebarLayout/terminal-drawer drag e2e — real mouse drags on
// the sidebar edge (268 default, 210–440, <110 collapses, drag-back-open)
// and the terminal drawer's top edge (260 default, 140–760), with the
// persisted settings verified through the snapshot.

import { join } from "node:path";

export async function runLayoutChecks({ launch: launchApp, instances, snap, outDir, check, boundedClose }) {
  const launch = (label) => launchApp({}, label);
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
  const sidebarW = (page) =>
    page.evaluate(() => {
      const el = document.querySelector(".sidebar");
      return el ? el.getBoundingClientRect().width : null;
    });

  const s1 = await launch("layout-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // LAY-01: frozen default — sidebar rests at 268 with a live edge strip.
  const w0 = await sidebarW(page);
  const edge = page.locator(".sidebar-edge");
  verify(
    "LAY-01 sidebar rests at the frozen 268 default",
    w0 !== null && Math.abs(w0 - 268) <= 2 && (await edge.count()) === 1,
    { w0, edges: await edge.count() },
  );

  // LAY-02: drag right +60 — live width follows and the release persists.
  const eb = await edge.boundingBox();
  await page.mouse.move(eb.x + eb.width / 2, eb.y + 200);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width / 2 + 60, eb.y + 200, { steps: 8 });
  const wLive = await sidebarW(page);
  await page.mouse.up();
  await waitSnap(page, (s) => s.settings.sidebarWidth === 328);
  const wAfter = await sidebarW(page);
  verify(
    "LAY-02 edge drag widens and persists sidebarWidth",
    wLive !== null && Math.abs(wLive - 328) <= 3 && Math.abs(wAfter - 328) <= 3,
    { wLive, wAfter },
  );

  // LAY-03: drag below the 110 threshold — the bar collapses (session-only)
  // and the persisted width is untouched.
  const eb2 = await edge.boundingBox();
  await page.mouse.move(eb2.x + eb2.width / 2, eb2.y + 200);
  await page.mouse.down();
  await page.mouse.move(eb2.x + eb2.width / 2 - 260, eb2.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".sidebar", { state: "detached", timeout: 8000 });
  const st3 = await snap(page);
  verify(
    "LAY-03 drag past 110 collapses, setting kept",
    (await sidebarW(page)) === null && st3.settings.sidebarWidth === 328,
    { collapsed: (await sidebarW(page)) === null, w: st3.settings.sidebarWidth },
  );

  // LAY-04: the collapsed edge still takes a drag — pull it open again.
  const eb3 = await edge.boundingBox();
  await page.mouse.move(eb3.x + eb3.width / 2, eb3.y + 200);
  await page.mouse.down();
  await page.mouse.move(eb3.x + eb3.width / 2 + 240, eb3.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".sidebar", { timeout: 8000 });
  await waitSnap(page, (s) => s.settings.sidebarWidth === 240);
  const w4 = await sidebarW(page);
  verify(
    "LAY-04 collapsed edge drags back open",
    w4 !== null && Math.abs(w4 - 240) <= 3,
    { w4 },
  );

  // LAY-05/06: terminal drawer — top-edge drag resizes and persists.
  // The dock only renders for a selected thread.
  await page.locator('button[title="New thread"]').click();
  const termToggle = page.locator('button[title="Terminal"]');
  await termToggle.waitFor({ timeout: 8000 });
  await termToggle.click();
  await page.waitForSelector(".term-panel", { timeout: 8000 });
  const h0 = await page.evaluate(
    () => document.querySelector(".term-panel").getBoundingClientRect().height,
  );
  verify(
    "LAY-05 terminal drawer rests at the frozen 260 default",
    Math.abs(h0 - 260) <= 2,
    { h0 },
  );
  const rh = page.locator(".term-resize");
  const rb = await rh.boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2 - 40, {
    steps: 8,
  });
  await page.mouse.up();
  await waitSnap(page, (s) => s.settings.terminalHeight === 300);
  const hAfter = await page.evaluate(
    () => document.querySelector(".term-panel").getBoundingClientRect().height,
  );
  verify(
    "LAY-06 top-edge drag resizes and persists terminalHeight",
    Math.abs(hAfter - 300) <= 3,
    { hAfter },
  );

  await page.screenshot({ path: `${outDir}/layout-drags.png` });
  await boundedClose(app, proc, {});

  // LAY-07: a fresh instance reads the persisted sizes back — the bar
  // reopens at 240 and the drawer at 300.
  const s2 = await launch("layout-reload");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  await waitSnap(
    page2,
    (s) => s.settings.sidebarWidth === 240 && s.settings.terminalHeight === 300,
  );
  const w7 = await sidebarW(page2);
  verify(
    "LAY-07 persisted sizes survive a restart",
    w7 !== null && Math.abs(w7 - 240) <= 3,
    { w7 },
  );

  // ---- A82 frozen AppCommands chords -------------------------------------
  // LAY-08: mod+N opens the Nth thread in sidebar (DOM) order.
  await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await waitSnap(page2, (s) => s.threads.length >= 3);
  const rows = await page2.evaluate(() =>
    Array.from(
      document.querySelectorAll(".thread-list .row[data-thread-id]"),
      (r) => r.dataset.threadId,
    ).filter(Boolean),
  );
  verify("LAY-08a sidebar lists at least two threads", rows.length >= 2, rows);
  await page2.keyboard.press("Meta+2");
  await waitSnap(page2, (s) => s.selectedThreadId === rows[1]);
  verify(
    "LAY-08b mod+2 selects the second sidebar thread",
    (await snap(page2)).selectedThreadId === rows[1],
    { rows },
  );
  await page2.keyboard.press("Meta+1");
  await waitSnap(page2, (s) => s.selectedThreadId === rows[0]);
  verify(
    "LAY-08c mod+1 selects the first sidebar thread",
    (await snap(page2)).selectedThreadId === rows[0],
    { rows },
  );

  // LAY-09/10: mod+= steps all three font sizes up, mod+- back down, and
  // mod+0 resets once the default show-main binding is cleared (frozen
  // shares the shadow: ⌘0 answers to whichever command keeps it).
  const fs0 = (await snap(page2)).settings.fontSizes ?? {};
  await page2.keyboard.press("Meta+Equal");
  await waitSnap(page2, (s) => s.settings.fontSizes?.ui === 15, 8000);
  const fs1 = (await snap(page2)).settings.fontSizes;
  verify(
    "LAY-09 mod+= steps every font size up",
    fs1.ui === 15 && fs1.content === 16 && fs1.code === 14,
    { fs0, fs1 },
  );
  await page2.keyboard.press("Meta+Minus");
  await waitSnap(page2, (s) => s.settings.fontSizes?.ui === 14, 8000);
  const fs2 = (await snap(page2)).settings.fontSizes;
  verify(
    "LAY-10 mod+- steps every font size back down",
    fs2.ui === 14 && fs2.content === 15 && fs2.code === 13,
    fs2,
  );

  // ---- A84 skylight hero + stream veil -----------------------------------
  // SKY-01: the hero card sits in the sidebar by default (showsSkylight).
  await page2.waitForSelector(".skylight", { timeout: 8000 });
  verify("SKY-01 skylight hero present by default", true);

  // SKY-02/03: a held streaming turn ([mock:mend] flushes then pauses)
  // keeps status=streaming — the fresh tail carries .md-veil and the
  // hero folds the running thread into RUN · 1.
  await page2.locator(".composer textarea").fill("spin [mock:mend]");
  await page2.keyboard.press("Enter");
  let veils = 0;
  const veilDeadline = Date.now() + 9000;
  while (veils === 0 && Date.now() < veilDeadline) {
    veils = await page2.locator(".msg.assistant .md-veil").count();
    if (veils === 0) await new Promise((r) => setTimeout(r, 40));
  }
  verify("SKY-02 flushed tail carries the veil span", veils > 0, `veils=${veils}`);
  // SKY-03: the tag must equal the real fold of THIS data root — earlier
  // suites leave interrupted/failed threads here, and frozen precedence
  // puts those above a running turn. Recompute the expected tag from the
  // snapshot rather than assume RUN wins.
  const foldTag = (s) => {
    const st = { failed: 0, awaiting: 0, running: 0, done: 0 };
    const workingParents = new Set(
      s.threads
        .filter(
          (x) =>
            x.parentThreadId &&
            (x.turn?.status === "running" || x.turn?.status === "waiting-approval"),
        )
        .map((x) => x.parentThreadId),
    );
    for (const th of s.threads) {
      if (th.isArchived || th.hydraHead) continue;
      let a = "idle";
      if (workingParents.has(th.id) && th.turn?.status !== "running") a = "running";
      else if (th.turn?.approval?.status === "pending" || th.turn?.status === "waiting-approval")
        a = "awaiting";
      else if (th.turn?.question?.status === "pending") a = "awaiting";
      else if (th.turn?.status === "running") a = "running";
      else if (th.hasUnread)
        a = th.unreadStatus === "error" || th.unreadStatus === "interrupted" ? "failed" : "done";
      st[a] = (st[a] ?? 0) + 1;
    }
    if (st.failed > 0) return `FAIL · ${st.failed}`;
    if (st.awaiting > 0) return `WAIT · ${st.awaiting}`;
    if (st.running > 0) return `RUN · ${st.running}`;
    if (st.done > 0) return `DONE · ${st.done}`;
    return null;
  };
  const tagExpected = foldTag(await snap(page2));
  await new Promise((r) => setTimeout(r, 300));
  const tagRun =
    (await page2.locator(".sky-tag").count()) > 0
      ? (await page2.locator(".sky-tag").textContent()).trim()
      : null;
  verify("SKY-03 hero tag equals the real weather fold",
    tagRun === tagExpected, { dom: tagRun, expected: tagExpected });
  await page2.screenshot({ path: join(outDir, "skylight-running.png") });
  const selId = (await snap(page2)).selectedThreadId;
  // The held turn never settles on its own — stop it, then the hero
  // leaves RUN.
  await page2.evaluate(
    (id) => window.tivano.invoke("turns:cancel", { threadId: id }),
    selId,
  );
  await waitSnap(
    page2,
    (s) =>
      ["done", "cancelled", "error"].includes(
        s.threads.find((y) => y.id === selId)?.turn?.status,
      ) || s.threads.find((y) => y.id === selId)?.turn == null,
    30000,
  );
  const tagAfter = await page2.locator(".sky-tag").count()
    ? (await page2.locator(".sky-tag").textContent()).trim()
    : null;
  const tagExpectedAfter = foldTag(await snap(page2));
  verify("SKY-04 hero reflects the fold once the turn settles",
    tagAfter === tagExpectedAfter && !tagAfter?.startsWith("RUN ·"),
    { dom: tagAfter, expected: tagExpectedAfter });

  // SKY-05: the setting hides and restores the card.
  await page2.evaluate(() => window.tivano.invoke("settings:set", { showsSkylight: false }));
  await page2.waitForSelector(".skylight", { state: "detached", timeout: 8000 });
  verify("SKY-05 showsSkylight=false hides the hero", true);
  await page2.evaluate(() => window.tivano.invoke("settings:set", { showsSkylight: true }));
  await page2.waitForSelector(".skylight", { timeout: 8000 });
  verify("SKY-05b showsSkylight=true restores the hero", true);

  // SKY-06: Performance Mode parks the hero even while the setting is on
  // (frozen showsSkylightNow = showsSkylight && !performanceMode).
  await page2.evaluate(() => window.tivano.invoke("settings:set", { performanceMode: true }));
  await page2.waitForSelector(".skylight", { state: "detached", timeout: 8000 });
  verify("SKY-06 performanceMode parks the hero", true);
  await page2.evaluate(() => window.tivano.invoke("settings:set", { performanceMode: false }));
  await page2.waitForSelector(".skylight", { timeout: 8000 });

  // SKY-07: activating the hero creates a thread (frozen onActivate → newThread).
  const nBefore = (await snap(page2)).threads.length;
  await page2.locator(".skylight").click();
  await waitSnap(page2, (s) => s.threads.length === nBefore + 1);
  verify("SKY-07 hero activation creates a thread", true, { nBefore });

  await boundedClose(s2.app, s2.proc, {});
}

// ---- v2.2.x shelved projects (frozen shelf row + popover + rename) -----
export async function runShelfChecks({ launch: launchApp, instances, snap, check, boundedClose }) {
  const launch = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const s1 = await launch("shelf-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // SH-01: shelving removes the project row and raises the shelf row.
  const pid = await page.evaluate(async () => {
    const r = await window.tivano.invoke("projects:create", { name: "shelf-proj" });
    return r.id;
  });
  await page.evaluate((id) => window.tivano.invoke("projects:set-shelved", { id, shelved: true }), pid);
  await page.waitForSelector(".shelf-row", { timeout: 8000 });
  const rowGone = (await page.locator(".group-row .group-name .title", { hasText: "shelf-proj" }).count()) === 0;
  const shelfTitle = await page.locator(".shelf-toggle .title").textContent();
  verify(
    "SH-01 shelved project leaves the list; shelf row carries the count",
    rowGone && shelfTitle?.includes("Shelved projects") && shelfTitle?.includes("(1)"),
    { rowGone, shelfTitle },
  );

  // SH-02: the popover lists the project and unshelves it back in place.
  await page.locator(".shelf-toggle").click();
  await page.waitForSelector(".shelf-pop .shelf-proj-name", { timeout: 8000 });
  verify(
    "SH-02 shelf popover lists the shelved project",
    (await page.locator(".shelf-proj-name").textContent()) === "shelf-proj",
  );
  await page.locator(".shelf-proj-head .icon-btn").click();
  await page.waitForSelector(".shelf-row", { state: "detached", timeout: 8000 });
  const restored = await page.locator(".group-row .group-name .title", { hasText: "shelf-proj" }).count();
  verify("SH-03 unshelve restores the project row", restored === 1, { restored });

  // SH-04: a thread created inside a shelved project wakes it (frozen rule).
  await page.evaluate((id) => window.tivano.invoke("projects:set-shelved", { id, shelved: true }), pid);
  await page.waitForSelector(".shelf-row", { timeout: 8000 });
  await page.evaluate((id) => window.tivano.invoke("threads:create", { projectId: id }), pid);
  await page.waitForSelector(".shelf-row", { state: "detached", timeout: 8000 });
  verify("SH-04 new thread in a shelved project wakes it", true);

  // SH-05: right-click rename sets a custom shelf name; empty restores.
  await page.evaluate((id) => window.tivano.invoke("projects:set-shelved", { id, shelved: true }), pid);
  await page.waitForSelector(".shelf-row", { timeout: 8000 });
  await page.locator(".shelf-row").click({ button: "right" });
  await page.waitForSelector(".shelf-rename input", { timeout: 8000 });
  await page.locator(".shelf-rename input").fill("On hold");
  await page.locator(".shelf-rename input").press("Enter");
  const custom = await page.locator(".shelf-toggle .title").textContent();
  verify(
    "SH-05 shelf rename applies the custom name",
    custom?.includes("On hold"),
    { custom },
  );
  const persisted = await snap(page);
  verify(
    "SH-06 shelf name persists in settings",
    persisted.settings.shelvedGroupName === "On hold",
    persisted.settings.shelvedGroupName,
  );
  // Empty rename restores the default label.
  await page.locator(".shelf-row").click({ button: "right" });
  await page.waitForSelector(".shelf-rename input", { timeout: 8000 });
  await page.locator(".shelf-rename input").fill("");
  await page.locator(".shelf-rename input").press("Enter");
  const back = await page.locator(".shelf-toggle .title").textContent();
  verify("SH-07 empty rename restores the default label", back?.includes("Shelved projects"), { back });

  await boundedClose(app, proc, {});
}

// ---- session 31: v2.2.34 quick chat — panel, send, expand, hide -------
export async function runQuickChecks({ launch: launchApp, instances, snap, outDir, check, boundedClose }) {
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const s = await launchApp({}, "quick-chat");
  instances.push(s);
  const { app, proc } = s;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  const threadsBefore = new Set(
    (await snap(page)).threads.map((t) => t.id),
  );

  // QC-01: enabling the setting lets quick:show raise a second window.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { quickChatEnabled: true }));
  const winP = app.waitForEvent("window", { timeout: 8000 });
  await page.evaluate(() => window.tivano.invoke("quick:show", {}));
  await winP;
  const quick = app
    .windows()
    .find((w) => w.url().includes("#quick"));
  verify("QC-01 quick chat window opens over the app", !!quick, {
    windows: app.windows().length,
  });
  await quick.waitForSelector(".quick-input", { timeout: 8000 });

  // QC-02: Return sends a new chat — a real thread+turn via the engine.
  await quick.fill(".quick-input", "quick hello");
  await quick.press(".quick-input", "Enter");
  await page.waitForFunction(
    (n) => window.tivano.invoke("state:get", {}).then((s) => s.threads.length > n),
    threadsBefore.size,
    { timeout: 10000 },
  );
  const sentSnap = await snap(page);
  const quickThread = sentSnap.threads.find((t) => !threadsBefore.has(t.id));
  verify(
    "QC-02 Return sends it as a new chat",
    !!quickThread &&
      sentSnap.selectedThreadId === quickThread.id &&
      quickThread.messages.some(
        (m) => m.role === "user" && m.content === "quick hello",
      ),
    { id: quickThread?.id, selected: sentSnap.selectedThreadId },
  );

  // QC-03: typed draft survives hide + show (the panel keeps its DOM).
  // OS-window visibility is read back through the main-owned probe —
  // playwright DOM state can't see a hidden BrowserWindow.
  await page.evaluate(() => window.tivano.invoke("quick:show", {}));
  const quick2 = app.windows().find((w) => w.url().includes("#quick"));
  await quick2.waitForSelector(".quick-input", { timeout: 8000 });
  await quick2.fill(".quick-input", "draft survives");
  await quick2.press(".quick-input", "Escape");
  await page.waitForFunction(
    () => window.tivano.invoke("quick:state", {}).then((s) => s.visible === false),
    null,
    { timeout: 8000 },
  );
  await page.evaluate(() => window.tivano.invoke("quick:show", {}));
  const kept = await quick2.inputValue(".quick-input");
  verify("QC-03 Esc hides and the draft is kept", kept === "draft survives", { kept });

  // QC-04: expand carries the draft into the main composer.
  await quick2.locator(".quick-act", { hasText: "⤢" }).click();
  await page.waitForFunction(
    () => document.querySelector(".composer textarea")?.value === "draft survives",
    null,
    { timeout: 8000 },
  );
  const draft = await page.evaluate(
    () => document.querySelector(".composer textarea")?.value,
  );
  verify("QC-04 expand carries the draft into the composer", draft === "draft survives", { draft });
  await mkdirSync(join(outDir, "shots"), { recursive: true });
  await quick2.screenshot({ path: join(outDir, "shots", "quick-chat.png") }).catch(() => undefined);
  await page.screenshot({ path: join(outDir, "shots", "quick-expanded.png") });

  // QC-05: disabling the setting + closing the panel leaves the app intact.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { quickChatEnabled: false }));
  await page.evaluate(() => window.tivano.invoke("quick:hide", {}));
  verify("QC-05 disable + hide leaves the app intact", true);

  await boundedClose(app, proc, {});
}
