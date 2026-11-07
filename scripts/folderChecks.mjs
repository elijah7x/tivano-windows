// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F15 folder actions e2e — a bound project gets Reveal/Copy; the copy
// path is main-resolved and written to the real clipboard; threads with
// no directory get an honest refusal, never a guessed path.

import { existsSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

export async function runFolderChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  dataRoot,
  check,
  boundedClose,
}) {
  // External-open seam: every Finder/Terminal/browser open is recorded
  // here instead of launched — assertions read the intent log.
  const openLog = join(outDir, "external-opens.jsonl");
  const launch = (label) =>
    launchApp({ TIVANO_TEST_EXTERNAL_OPEN: openLog }, label);
  const openRecs = () =>
    existsSync(openLog)
      ? readFileSync(openLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
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

  // Seed a bound project + thread exactly as the chooser would persist
  // them (the native dialog cannot be driven headlessly).
  const dir = mkdtempSync(join(tmpdir(), "tivano-e2e-folder-"));
  writeFileSync(join(dir, "sentinel.txt"), "user content — never touched");
  const pid = randomUUID();
  const tid = randomUUID();
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.projects.push({
    id: pid,
    name: basename(realpathSync(dir)),
    createdAt: Date.now(),
    expanded: true,
    directory: realpathSync(dir),
  });
  doc.threads.push({
    id: tid,
    projectId: pid,
    title: "folder thread",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    turn: null,
    sessionGrants: [],
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
  const grants = JSON.parse(readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"));
  grants.userGrants[pid] = realpathSync(dir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(grants));

  const s1 = await launch("folder-main");
  instances.push(s1);
  const { app, proc, ledger } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // Select the bound thread — both actions must be enabled.
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".chat-head h1", { timeout: 10000 });
  // Reveal/Copy now live inside the "Open in" menu (frozen OpenInMenu).
  await page.waitForSelector('button[title="Open in another app"]', { timeout: 10000 });
  await page.locator('button[title="Open in another app"]').click();
  await page.waitForSelector('.openin-menu [role="menuitem"]', { timeout: 5000 });
  const fmItem = page.locator('.openin-menu [role="menuitem"]').first();
  verify("FOLDER-01 reveal enabled on a bound thread", await fmItem.isEnabled());

  // Copy path — main resolves the directory, writes the real clipboard.
  const copied = await page.evaluate(
    (id) => window.tivano.invoke("folder:copy", { threadId: id }),
    tid,
  );
  verify(
    "FOLDER-02 copy returns the main-resolved path",
    copied.path === realpathSync(dir),
    copied,
  );
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  verify(
    "FOLDER-03 clipboard actually carries the directory",
    clip === realpathSync(dir),
    clip.slice(0, 80),
  );

  // Reveal — the action completes against the real directory.
  const revealed = await page.evaluate(
    (id) => window.tivano.invoke("folder:reveal", { threadId: id }),
    tid,
  );
  verify(
    "FOLDER-04 reveal completed on the real directory",
    revealed.path === realpathSync(dir) &&
      openRecs().some((r) => r.action === "openPath" && r.target === realpathSync(dir)),
    { revealed, recs: openRecs() },
  );

  // A thread with no project gets an honest refusal, not a guess.
  await page.keyboard.press("Escape"); // close the open menu first
  await page.locator('button[title="New thread"]').click();
  const lone = (await snap(page)).selectedThreadId;
  await page.locator('button[title="Open in another app"]').click();
  await page.waitForSelector('.openin-menu [role="menuitem"]', { timeout: 5000 });
  const offItem = page.locator('.openin-menu [role="menuitem"]').first();
  verify("FOLDER-05 unbound thread shows the disabled state", !(await offItem.isEnabled()));
  await page.keyboard.press("Escape");
  const refused = await page.evaluate(
    async (id) => {
      try {
        await window.tivano.invoke("folder:copy", { threadId: id });
        return "unexpected-ok";
      } catch (e) {
        return String(e?.message ?? e);
      }
    },
    lone,
  );
  verify(
    "FOLDER-06 unbound copy refuses honestly",
    refused.includes("no working directory"),
    refused,
  );

  // F15 remainder — editor discovery, open-with-editor, sidebar reveals.
  const { editors } = await page.evaluate(() =>
    window.tivano.invoke("openin:editors", {}),
  );
  verify(
    "OI-01 editors expose only id+name",
    Array.isArray(editors) &&
      editors.every((e) => Object.keys(e).sort().join(",") === "id,name"),
    editors?.length,
  );
  verify(
    "OI-02 macOS host discovers Terminal",
    process.platform !== "darwin" ||
      editors.some((e) => e.id === "terminal" && e.name === "Terminal"),
    editors?.map((e) => e.id),
  );

  // Back on the bound thread the menu shows file-manager + editors + copy.
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.locator('button[title="Open in another app"]').click();
  await page.waitForSelector('.openin-menu [role="menuitem"]', { timeout: 5000 });
  const itemCount = await page.locator('.openin-menu [role="menuitem"]').count();
  verify(
    "OI-03 menu = file manager + discovered editors + copy path",
    itemCount === 1 + editors.length + 1,
    { itemCount, editors: editors.length },
  );
  await page.keyboard.press("Escape");

  // A real open-with-editor launch through the discovered set.
  if (editors.some((e) => e.id === "terminal")) {
    const opened = await page.evaluate(
      (a) => window.tivano.invoke("openin:open", a),
      { threadId: tid, editorId: "terminal" },
    );
    verify(
      "OI-04 open-with-editor resolved the real directory",
      opened.path === realpathSync(dir) && opened.editor === "Terminal" &&
        openRecs().some(
          (r) => r.action === "openWithEditor" && r.target === realpathSync(dir) && r.detail === "terminal",
        ),
      { opened, recs: openRecs() },
    );
  }
  const badEd = await page.evaluate(async (a) => {
    try {
      await window.tivano.invoke("openin:open", a);
      return "unexpected-ok";
    } catch (e) {
      return String(e?.message ?? e);
    }
  }, { threadId: tid, editorId: "ghost-editor" });
  verify("OI-05 unknown editor refuses honestly", badEd.includes("not available"), badEd);

  // Sidebar reveals: project row (bound) + worktree row (absent here).
  const projReveal = await page.evaluate(
    (id) => window.tivano.invoke("openin:reveal", { projectId: id }),
    pid,
  );
  verify(
    "OI-06 project reveal selects the real bound directory",
    projReveal.path === realpathSync(dir) &&
      openRecs().some(
        (r) => r.action === "showItemInFolder" && r.target === realpathSync(dir),
      ),
    { projReveal, recs: openRecs() },
  );
  const wtRefused = await page.evaluate(async (id) => {
    try {
      await window.tivano.invoke("openin:reveal", { threadId: id });
      return "unexpected-ok";
    } catch (e) {
      return String(e?.message ?? e);
    }
  }, tid);
  verify(
    "OI-07 plain-thread worktree reveal refuses (frozen worktree-only rule)",
    wtRefused.includes("unavailable") || wtRefused.includes("nothing to reveal"),
    wtRefused,
  );
  const revealBtns =
    (await page.locator('button[aria-label*="Reveal in Finder"]').count()) +
    (await page.locator('button[aria-label*="Reveal in File Explorer"]').count());
  verify("OI-08 project row shows its reveal action", revealBtns >= 1, revealBtns);

  await page.screenshot({ path: join(outDir, "84-folder-actions.png") });
  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify(
    "FOLDER-07 folder instance closed cleanly",
    c.exited && c.outcome === "resolved",
    c.outcome,
  );
}
