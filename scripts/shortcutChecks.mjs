// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Configurable-shortcut e2e checks (F27): the settings section records a
// physical chord through the frozen refusal rules (conflict, typing-key
// and system-reserved refusals), overrides persist across relaunch, and
// the default chords DO the real commands — palette toggle, thread
// navigation, stop, direct archive, prompted archive, queue-behind-turn.

export async function runShortcutChecks({
  launch,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) return undefined;
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  const env = {
    TIVANO_PROVIDER: "codex",
    TIVANO_CODEX_FIXTURE: codexFixture,
    TIVANO_CODEX_NODE: process.execPath,
    TIVANO_WORKSPACE_ROOT: workspaceRoot,
  };
  const sA = await launch(env, "s-shcut-a");
  instances.push(sA);
  const { app, proc, ledger } = sA;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const press = async (chord) => page.keyboard.press(chord); // playwright names: Meta, Control, Shift, etc.

  // --- Cmd/Ctrl+K opens the palette through the dispatch table ---------
  await press("Meta+k");
  await page.locator(".cmd-palette, .palette, [role='dialog']").first().waitFor({ timeout: 8000 });
  const paletteOpen = await page.evaluate(() => !!document.querySelector("input[placeholder*='Search'], .palette input"));
  verify("SC-01 ⌘K opened the command palette", paletteOpen === true);
  await page.keyboard.press("Escape");

  // --- settings section renders all 17 rows with chord labels ----------
  await press("Meta+,");
  await page.locator(".modal").waitFor({ timeout: 8000 });
  await page.evaluate(() => {
    const h = [...document.querySelectorAll(".modal h3")].find((x) => x.textContent === "Keyboard shortcuts");
    h?.scrollIntoView();
  });
  // v2.2.34: 18 chorded commands (incl. quickChat) + 1 master toggle row.
  const rows = await page.locator(".shortcut-row .shortcut-chord").count();
  verify("SC-02 shortcuts section lists all 18 chorded commands", rows === 18, rows);
  const firstChords = await page.locator(".shortcut-row .shortcut-chord").allTextContents();
  verify(
    "SC-03 frozen defaults labelled (⌘N / ⇧⌘N / ⌘O …)",
    firstChords[0] === "⌘N" && firstChords[1] === "⇧⌘N" && firstChords[2] === "⌘O",
    firstChords.slice(0, 4),
  );

  // --- record a NEW chord for Toggle terminal: ⇧⌘S ----------------------
  // Row order in the window section: palette, sidebar, terminal(3rd).
  const termRow = page.locator(".shortcut-row", { hasText: "Toggle terminal" });
  await termRow.locator(".shortcut-chord").click();
  await page.locator(".shortcut-recording").waitFor({ timeout: 5000 });
  await press("Meta+Shift+s");
  await until(async () =>
    (await termRow.locator(".shortcut-chord").count()) > 0 ? true : undefined,
  );
  const newLabel = (await termRow.locator(".shortcut-chord").textContent())?.trim();
  verify("SC-04 ⇧⌘S recorded for Toggle terminal", newLabel === "⇧⌘S", newLabel);

  // --- refusals: conflict / bare typing key / reserved ------------------
  const stopRow = page.locator(".shortcut-row", { hasText: "Stop the running turn" });
  await stopRow.locator(".shortcut-chord").click();
  await press("Meta+k"); // owned by the palette
  const conflict = await until(async () => {
    const txt = await stopRow.locator(".shortcut-recording").textContent().catch(() => "");
    return txt?.includes("already uses") ? txt : undefined;
  });
  verify("SC-05 conflict refusal names the owner", !!conflict, conflict);
  await press("a"); // bare typing key
  const typing = await until(async () => {
    const txt = await stopRow.locator(".shortcut-recording").textContent().catch(() => "");
    return txt?.includes("typing") ? txt : undefined;
  });
  verify("SC-06 bare typing key refused", !!typing, typing);
  await press("Meta+q"); // system-reserved
  const reserved = await until(async () => {
    const txt = await stopRow.locator(".shortcut-recording").textContent().catch(() => "");
    return txt?.includes("already uses this chord") && !txt.includes("Stop") ? txt : undefined;
  });
  verify("SC-07 system chord refused", !!reserved, reserved);
  await page.keyboard.press("Escape");

  // --- reset returns the default ----------------------------------------
  await termRow.locator(".shortcut-mini", { hasText: "Reset" }).click();
  const restored = await until(async () => {
    const v = (await termRow.locator(".shortcut-chord").textContent())?.trim();
    return v === "⌘J" ? v : undefined;
  });
  verify("SC-08 Reset restored ⌘J", restored === "⌘J", restored);
  await page.keyboard.press("Escape"); // close settings

  // --- record again then verify it actually DISPATCHES ------------------
  await press("Meta+,");
  await page.locator(".modal").waitFor({ timeout: 8000 });
  await page.evaluate(() => {
    const h = [...document.querySelectorAll(".modal h3")].find((x) => x.textContent === "Keyboard shortcuts");
    h?.scrollIntoView();
  });
  const termRow2 = page.locator(".shortcut-row", { hasText: "Toggle terminal" });
  await termRow2.locator(".shortcut-chord").click();
  await press("Meta+Shift+s");
  await until(async () => (await termRow2.locator(".shortcut-chord").count()) > 0 ? true : undefined);
  await page.keyboard.press("Escape");
  // The new chord toggles the real terminal dock.
  const termThread = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), termThread.id);
  await press("Meta+Shift+s");
  const dockUp = await until(async () =>
    (await page.locator(".term-panel").count()) > 0 ? true : undefined,
  );
  verify("SC-09 recorded chord toggled the real terminal dock", dockUp === true);
  await press("Meta+Shift+s");
  const dockDown = await until(async () =>
    (await page.locator(".term-panel").count()) === 0 ? true : undefined,
  );
  verify("SC-10 second press hides the dock", dockDown === true);

  // --- next/prev thread navigation (⌃Tab / ⌃⇧Tab on macOS) --------------
  const t2 = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), t2.id);
  await press("Control+Tab");
  const prevSel = await until(async () => {
    const s = await snap(page);
    return s.selectedThreadId !== t2.id ? s.selectedThreadId : undefined;
  });
  verify("SC-11 ⌃Tab walked to the previous thread", prevSel === termThread.id, prevSel);
  await press("Control+Shift+Tab");
  const nextSel = await until(async () => {
    const s = await snap(page);
    return s.selectedThreadId === t2.id ? s.selectedThreadId : undefined;
  });
  verify("SC-12 ⌃⇧Tab walked back", nextSel === t2.id, nextSel);

  // --- ⌘. cancels a REAL held turn; ⌘↵ queues exactly once --------------
  // Unbound threads fail synchronously with WORKSPACE_NOT_CONFIGURED — an
  // "error" end state there proves nothing about stopTurn. A codex-fixture
  // [mock:approval] turn on a project-bound thread actually holds
  // waiting-approval until a decision arrives.
  const scProj = await page.evaluate((n) =>
    window.tivano.invoke("projects:create", { name: n }), "sc-proj");
  const tRun = await page.evaluate((pid) =>
    window.tivano.invoke("threads:create", { projectId: pid }), scProj.id);
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), tRun.id);
  await page.evaluate((tid) =>
    window.tivano.invoke("turns:send", { threadId: tid, text: "please [mock:approval] hold the line" }),
  tRun.id);
  const held = await until(async () => {
    const s = await snap(page);
    const st = s.threads.find((t) => t.id === tRun.id)?.turn?.status;
    return st === "waiting-approval" ? st : undefined;
  });
  verify("SC-13a approval turn is genuinely held", held === "waiting-approval", held);
  // While it waits, the Queue hint shows the effective ⌘Return label, and
  // ⌘↵ queues the draft exactly once — the dispatcher owns the chord, so
  // the composer's own Enter path must not double-fire.
  const qTitle = await page.locator(".queue-btn").getAttribute("title", { timeout: 10000 });
  verify("SC-13b queue hint shows the effective ⌘Return chord", qTitle === "Queue behind the running turn (⌘Return)", qTitle);
  await page.locator(".composer textarea").fill("queued-behind");
  await press("Meta+Enter");
  const queuedOnce = await until(async () => {
    const s = await snap(page);
    const q = s.threads.find((t) => t.id === tRun.id)?.followUps;
    return q?.length === 1 ? q : undefined;
  });
  verify("SC-13c ⌘↵ queued the draft exactly once", queuedOnce?.[0]?.text === "queued-behind", queuedOnce);
  await press("Meta+.");
  const stopped = await until(async () => {
    const s = await snap(page);
    const st = s.threads.find((t) => t.id === tRun.id)?.turn?.status;
    return st && st !== "running" && st !== "waiting-approval" ? st : undefined;
  });
  verify("SC-13d ⌘. stopped the held turn honestly", ["cancelled", "interrupted", "error", "denied"].includes(stopped), stopped);

  // --- ⌘⇧⌫ archives directly; ⌘W prompts ---------------------------------
  const t3 = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), t3.id);
  await press("Meta+Shift+Backspace");
  const gone = await until(async () => {
    const s = await snap(page);
    return s.threads.find((t) => t.id === t3.id)?.isArchived === true ? true : undefined;
  });
  verify("SC-14 ⇧⌘⌫ archived the selected thread directly", gone === true);

  const t4 = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null }),
  );
  await page.evaluate((tid) => window.tivano.invoke("threads:select", { id: tid }), t4.id);
  await press("Meta+w");
  await page.locator(".modal[role='alertdialog']").waitFor({ timeout: 8000 });
  verify("SC-15 ⌘W opened the archive prompt", true);
  await page.keyboard.press("Enter"); // frozen: Return archives
  const archivedViaPrompt = await until(async () => {
    const s = await snap(page);
    return s.threads.find((t) => t.id === t4.id)?.isArchived === true ? true : undefined;
  });
  verify("SC-16 Return archived via the prompt", archivedViaPrompt === true);

  // --- overrides persist across relaunch ----------------------------------
  const aClose = await boundedClose(app, proc);
  ledger.exited = aClose.exited;
  ledger.outcome = aClose.outcome;
  verify("SC-17 instance closed cleanly", aClose.outcome === "resolved" && aClose.exited, aClose);

  const sB = await launch(env, "s-shcut-b");
  instances.push(sB);
  const pageB = await sB.app.firstWindow();
  await pageB.waitForSelector(".sidebar-head", { timeout: 15000 });
  const persisted = await pageB.evaluate(() =>
    window.tivano.invoke("state:get", {}).then((s) => s.settings.shortcuts),
  );
  verify(
    "SC-18 ⇧⌘S override survived relaunch",
    persisted?.toggleTerminal?.key === "KeyS" && persisted.toggleTerminal.mod === true,
    persisted,
  );
  await pageB.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await pageB.keyboard.press("Meta+,");
  await pageB.locator(".modal").waitFor({ timeout: 8000 });
  await pageB.evaluate(() => {
    const h = [...document.querySelectorAll(".modal h3")].find((x) => x.textContent?.includes("快捷键"));
    h?.scrollIntoView();
  });
  const zhSection = await pageB.evaluate(() =>
    [...document.querySelectorAll(".modal h3")].map((x) => x.textContent),
  );
  verify("SC-19 zh section renders localized", zhSection.includes("键盘快捷键"), zhSection);
  await pageB.screenshot({ path: `${outDir}/98-shortcuts-zh.png` });
  // Shared store is handed to downstream modules: restore en + defaults,
  // and bring back the threads this module archived.
  await pageB.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await pageB.evaluate(() => window.tivano.invoke("settings:set", { shortcuts: {} }));
  await pageB.evaluate((ids) =>
    Promise.all(ids.map((id) => window.tivano.invoke("threads:unarchive", { id }))),
  [t3.id, t4.id]);
  const handoff = await pageB.evaluate(() =>
    window.tivano.invoke("state:get", {}).then((s) => ({
      lang: s.settings.language, shortcuts: s.settings.shortcuts,
    })),
  );
  verify(
    "SC-20 shared store restored to en + default shortcuts",
    handoff.lang === "en" && Object.keys(handoff.shortcuts ?? {}).length === 0,
    handoff,
  );
  const bClose = await boundedClose(sB.app, sB.proc);
  sB.ledger.exited = bClose.exited;
  sB.ledger.outcome = bClose.outcome;
  verify("SC-21 relaunch instance closed cleanly", bClose.outcome === "resolved" && bClose.exited, bClose);
}
