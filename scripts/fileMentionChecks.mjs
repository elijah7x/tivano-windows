// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 remainder e2e — frozen @-mention suggestions (workspace index →
// scored rows → "@path " draft insertion) and the frozen downloads
// popover (recent list, id-scoped attach through main, Choose Files…
// pass-through, recentDownloadsPicker setting gate, zh-Hans).
// Synthetic files + the test-env directory seams only — nothing real.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, delimiter } from "node:path";
import { randomUUID } from "node:crypto";

export async function runFileMentionChecks({
  launch,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
  dataRoot,
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
  const setDraft = async (page, value) =>
    page.evaluate((v) => {
      const ta = document.querySelector(".composer textarea");
      const set = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set;
      set.call(ta, v);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);

  // A bound workspace directory — git-init'd when the host has git so the
  // frozen ls-files path is exercised; node_modules is .gitignore'd so the
  // listing is identical under the enumerate fallback either way.
  const work = mkdtempSync(join(tmpdir(), "tivano-e2e-mention-"));
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "engine.ts"), "x\n");
  writeFileSync(join(work, "src", "engine-notes.md"), "x\n");
  writeFileSync(join(work, "src", "store.ts"), "x\n");
  writeFileSync(join(work, "README.md"), "x\n");
  writeFileSync(join(work, ".gitignore"), "node_modules/\n.hidden/\n");
  mkdirSync(join(work, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(work, "node_modules", "pkg", "junk.js"), "x\n");
  mkdirSync(join(work, ".hidden"), { recursive: true });
  writeFileSync(join(work, ".hidden", "secret.ts"), "x\n");
  try {
    execFileSync("git", ["init", "-q"], { cwd: work });
  } catch {
    // No git on PATH — the enumerate fallback lists the same shape.
  }
  const workReal = realpathSync(work);

  // Deterministic downloads folder — the TIVANO_DOWNLOADS_DIR seam, same
  // class of test hook as TIVANO_TEST_ATTACH.
  const dl = mkdtempSync(join(tmpdir(), "tivano-e2e-downloads-"));
  const dlNames = ["alpha-report.pdf", "beta-photo.png", "gamma-notes.txt"];
  dlNames.forEach((n, i) => {
    const p = join(dl, n);
    writeFileSync(p, `download ${i} ${"x".repeat(100 * (i + 1))}\n`);
    const t = new Date(2026, 0, 10, 12, 0, 10 + i); // alpha oldest, gamma newest
    utimesSync(p, t, t);
  });
  writeFileSync(join(dl, ".hidden-dl"), "x\n");
  mkdirSync(join(dl, "a-folder"));

  // A file the "Choose Files…" pass-through picks via TIVANO_TEST_ATTACH.
  const pick = join(mkdtempSync(join(tmpdir(), "tivano-e2e-pick-")), "chosen.txt");
  writeFileSync(pick, "picked\n");

  // Seed the bound project + thread exactly like the folder checks.
  const pid = randomUUID();
  const tid = randomUUID();
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.projects.push({
    id: pid,
    name: basename(workReal),
    createdAt: Date.now(),
    expanded: true,
    directory: workReal,
  });
  doc.threads.push({
    id: tid,
    projectId: pid,
    title: "mention thread",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    turn: null,
    sessionGrants: [],
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
  const grants = JSON.parse(
    readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
  );
  grants.userGrants[pid] = workReal;
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(grants));

  const s1 = await launch(
    {
      TIVANO_DOWNLOADS_DIR: realpathSync(dl),
      TIVANO_TEST_ATTACH: pick,
      TIVANO_TEST_EXTERNAL_OPEN: join(outDir, "external-opens.jsonl"),
    },
    "mention-main",
  );
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      recentDownloadsPicker: true,
    }),
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".chat-head h1", { timeout: 10000 });
  await page.locator("textarea[aria-label='Message']").waitFor();

  // FM-01: "@" opens the Files suggestion menu over the workspace index.
  await setDraft(page, "@");
  await page.waitForSelector(".suggest-menu .suggest-row", { timeout: 8000 });
  const head = await page.locator(".suggest-menu .suggest-head").innerText();
  verify("FM-01 @ opens the Files menu", head === "Files", head);
  const allRows = await page.locator(".suggest-menu .suggest-row").allInnerTexts();
  verify(
    "FM-02 index bounded at 8, node_modules/.hidden excluded",
    allRows.length <= 8 &&
      allRows.every((r) => !r.includes("node_modules") && !r.includes("secret")),
    allRows,
  );
  await page.screenshot({ path: join(outDir, "mention-menu-en.png") });

  // FM-03: the query narrows; frozen ranking puts the name hits first.
  await setDraft(page, "@engine");
  await page.waitForFunction(
    () =>
      document.querySelector(".suggest-menu .suggest-row")?.textContent?.includes("engine"),
    { timeout: 8000 },
  );
  const engRows = await page.locator(".suggest-menu .suggest-row .suggest-detail").allInnerTexts();
  verify(
    "FM-03 frozen ranking — engine.ts names first, README out",
    engRows.length >= 2 &&
      engRows[0] === "src/engine.ts" &&
      engRows.includes("src/engine-notes.md") &&
      !engRows.some((r) => r === "README.md"),
    engRows,
  );

  // FM-04: ArrowDown + Enter replaces "@query" with "@path ".
  await page.locator(".composer textarea").press("ArrowDown");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".composer textarea").value.endsWith(" "),
    { timeout: 5000 },
  );
  const draft = await page.locator(".composer textarea").inputValue();
  verify(
    "FM-04 Enter picks the second row → '@path '",
    draft === `@${engRows[1]} `,
    draft,
  );
  verify(
    "FM-05 menu closes after the pick",
    (await page.locator(".suggest-menu").count()) === 0,
  );

  // FM-06: Escape dismisses until the text changes again.
  await setDraft(page, "@store");
  await page.waitForSelector(".suggest-menu .suggest-row", { timeout: 8000 });
  await page.locator(".composer textarea").press("Escape");
  await page.waitForSelector(".suggest-menu", { state: "detached", timeout: 5000 });
  verify("FM-06 Escape dismisses", true);
  // "@stor" still matches store.ts — a changed draft reopens the menu.
  await setDraft(page, "@stor");
  await page.waitForSelector(".suggest-menu", { timeout: 8000 });
  verify("FM-06b a changed text reopens", true);
  await page.locator(".composer textarea").press("Escape");

  // FM-07: mouse pick inserts the same "@path " form.
  await setDraft(page, "read @read");
  await page.waitForSelector(".suggest-menu .suggest-row", { timeout: 8000 });
  await page.locator(".suggest-menu .suggest-row").first().dispatchEvent("mousedown");
  const draft7 = await page.locator(".composer textarea").inputValue();
  verify(
    "FM-07 mouse pick keeps surrounding text",
    draft7 === "read @README.md ",
    draft7,
  );

  // FM-08: the mention is draft text — send carries "@README.md" to the
  // provider verbatim (frozen: no implicit attach).
  await page.locator("button.primary").click();
  await waitSnap(
    page,
    (s) => s.threads.find((x) => x.id === tid)?.turn?.status === "done",
  );
  const sent = await snap(page);
  const reply = sent.threads
    .find((x) => x.id === tid)
    .messages.find((m) => m.role === "assistant")?.content ?? "";
  verify("FM-08 '@README.md' reaches the prompt", reply.includes("@README.md"), reply);

  // FM-09: a directory-less thread's search is empty — no menu, no crash.
  const bareId = await page.evaluate(() =>
    window.tivano
      .invoke("threads:create", { projectId: null, title: "bare" })
      .then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "bare" }).click();
  await page.locator("textarea[aria-label='Message']").waitFor();
  await setDraft(page, "@anything");
  await page.waitForTimeout(600);
  verify(
    "FM-09 unbound thread: no suggestions, IPC stays alive",
    (await page.locator(".suggest-menu").count()) === 0 &&
      (await page.evaluate(
        (id) => window.tivano.invoke("mention:search", { threadId: id, query: "x" }),
        bareId,
      )).paths.length === 0,
  );

  // ---- downloads popover -------------------------------------------------
  // The settings snapshot reaches clientStore a hop after the invoke
  // resolves — wait until the popover wrapper is in the DOM.
  await page.waitForFunction(() => !!document.querySelector(".dl-anchor"), {
    timeout: 8000,
  });
  // DL-01: the attach button opens the frozen popover, newest first.
  await page.locator(".attach-btn").click();
  await page.waitForSelector(".dl-menu .dl-row", { timeout: 8000 });
  // The action rows render immediately — wait out the loading state
  // before reading the item rows.
  await page.waitForSelector(".dl-loading", { state: "detached", timeout: 8000 });
  const dlHead = await page.locator(".dl-menu .suggest-head").innerText();
  verify("DL-01 popover header", dlHead === "Recent downloads", dlHead);
  const dlRows = await page.locator(".dl-menu .dl-row .suggest-name").allInnerTexts();
  verify(
    "DL-02 newest-first listing, hidden/dir excluded, actions last",
    dlRows.join("|") ===
      "gamma-notes.txt|beta-photo.png|alpha-report.pdf|Show in Finder|Choose Files…",
    dlRows,
  );
  const sizes = await page.locator(".dl-menu .dl-size").allInnerTexts();
  verify("DL-03 real byte sizes render", sizes.every((s) => /B$|KB$|MB$/.test(s) || s === ""), sizes);
  await page.screenshot({ path: join(outDir, "downloads-popover-en.png") });

  // DL-04: picking a row attaches a real chip through main's resolver.
  await page.locator(".dl-menu .dl-row", { hasText: "gamma-notes.txt" }).dispatchEvent("mousedown");
  await page.locator(".attach-chip", { hasText: "gamma-notes.txt" }).waitFor();
  verify("DL-04 download row → attachment chip", true);

  // DL-05: Choose Files… passes through to the ordinary picker.
  await page.locator(".attach-btn").click();
  await page.locator(".dl-menu .dl-row", { hasText: "Choose Files…" }).dispatchEvent("mousedown");
  await page.locator(".attach-chip", { hasText: "chosen.txt" }).waitFor();
  verify("DL-05 Choose Files… reaches the native pick", true);

  // DL-06: a stale id resolves to nothing — no chip, honest report.
  const stale = await page.evaluate((id) =>
    window.tivano
      .invoke("downloads:attach", { threadId: id, ids: ["0:0:0"] })
      .catch((e) => ({ error: String(e) })),
    bareId,
  );
  verify(
    "DL-06 stale id attaches nothing",
    stale?.unresolved === 1 && stale?.attached?.length === 0,
    stale,
  );

  // DL-07: reveal invokes main's openPath on the real downloads dir.
  const revealed = await page.evaluate(() =>
    window.tivano.invoke("downloads:reveal", {}).then(() => "ok").catch((e) => String(e)),
  );
  const dlRecs = existsSync(join(outDir, "external-opens.jsonl"))
    ? readFileSync(join(outDir, "external-opens.jsonl"), "utf8")
        .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  verify(
    "DL-07 reveal recorded on the test dir",
    revealed === "ok" &&
      dlRecs.some((r) => r.action === "openPath" && r.target === realpathSync(dl)),
    { revealed, dlRecs },
  );

  // DL-08: the setting gate — off means the button is the plain picker.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { recentDownloadsPicker: false }),
  );
  await page.waitForFunction(
    () => !document.querySelector(".dl-anchor"),
    { timeout: 5000 },
  );
  await page.locator(".attach-btn").click();
  await page.locator(".attach-chip", { hasText: "chosen.txt" }).nth(1).waitFor();
  verify("DL-08 picker off → attach is direct", true);
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { recentDownloadsPicker: true }),
  );

  // DL-09: zh-Hans — header, action rows and the empty string localize.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page.locator(".attach-btn").click();
  await page.waitForSelector(".dl-menu .dl-row", { timeout: 8000 });
  await page.waitForSelector(".dl-loading", { state: "detached", timeout: 8000 });
  const zhHead = await page.locator(".dl-menu .suggest-head").innerText();
  const zhRows = await page.locator(".dl-menu .dl-row .suggest-name").allInnerTexts();
  // The reveal label follows the host platform: Finder on macOS, File
  // Explorer on Windows — either localized string proves the slot.
  verify(
    "DL-09 zh labels",
    zhHead === "最近下载" &&
      (zhRows.includes("在 Finder 中显示") ||
        zhRows.includes("在文件资源管理器中显示")) &&
      zhRows.includes("选择文件…"),
    { zhHead, zhRows },
  );
  await page.screenshot({ path: join(outDir, "downloads-popover-zh.png") });
  await page.locator(".attach-btn").click(); // toggle the popover closed
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const c1 = await boundedClose(app, proc);
  verify("mention-main exited cleanly", c1.outcome === "resolved", c1);
}
