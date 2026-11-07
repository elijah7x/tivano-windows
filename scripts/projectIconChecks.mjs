// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A51 e2e — F01 project icons: folder mark by default, the picker
// popover (title/search/Folder tile/eight groups), frozen search
// semantics with zh keywords, pick → persisted mark, Folder tile →
// clear, empty state, dismissal, zh localization. Emoji only — the
// frozen SF Symbol half cannot render on Windows and stays absent.

import { join } from "node:path";

export async function runProjectIconChecks({
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
  const waitSnap = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };

  const s1 = await launch({}, "icon-main");
  instances.push(s1);
  const page = await s1.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  await page.evaluate(() =>
    window.tivano.invoke("projects:create", { name: "Icon Proj" }),
  );
  await page.waitForSelector(".group-name");

  // PI-01: the mark button defaults to the folder emoji.
  const mark = await page.textContent(".group-row .proj-icon");
  verify("PI-01 folder mark by default", mark.trim() === "📁", mark);

  // PI-02: clicking opens the popover with title, search, Folder tile,
  // and all eight frozen emoji groups.
  await page.click(".group-row .proj-icon");
  await page.waitForSelector(".icon-pop");
  const pop = await page.evaluate(() => {
    const p = document.querySelector(".icon-pop");
    return {
      title: p.querySelector(".icon-pop-title")?.textContent,
      search: !!p.querySelector(".icon-pop-search"),
      folder: p.querySelector(".icon-tile.folder .icon-tile-name")?.textContent,
      headings: [...p.querySelectorAll(".icon-pop-heading")].map((h) => h.textContent),
      tiles: p.querySelectorAll(".icon-pop-grid .icon-tile").length,
    };
  });
  verify("PI-02 picker shape", pop.title === "Project icon" && pop.search
    && pop.folder === "Folder" && pop.headings.length === 8
    && pop.headings[0] === "Development & Tools"
    && pop.headings[7] === "Symbols & Communication"
    && pop.tiles === 155, pop);
  await page.screenshot({ path: join(outDir, "icon-picker-en.png") });

  // PI-03: frozen search — a zh keyword filters entries, empty groups drop.
  await page.fill(".icon-pop-search", "猫");
  const filtered = await page.evaluate(() => ({
    headings: [...document.querySelectorAll(".icon-pop-heading")].map((h) => h.textContent),
    tiles: [...document.querySelectorAll(".icon-pop-grid .icon-tile")].map((b) => b.textContent.trim()),
  }));
  verify("PI-03 zh keyword search", filtered.tiles.includes("🐱")
    && filtered.tiles.length < 10
    && filtered.headings.every((h) => h === "Nature & Animals"), filtered);

  // PI-04: picking the emoji sets the mark and persists to the snapshot.
  await page.click('.icon-pop-grid .icon-tile:has-text("🐱")');
  await page.waitForSelector(".icon-pop", { state: "detached" });
  const mark2 = await page.textContent(".group-row .proj-icon");
  const s2 = await waitSnap(page, (st) => st.projects[0]?.icon === "🐱");
  verify("PI-04 pick persists", mark2.trim() === "🐱" && s2.projects[0].icon === "🐱", { mark2 });

  // PI-05: empty state — a query nothing matches shows both frozen rows.
  await page.click(".group-row .proj-icon");
  await page.waitForSelector(".icon-pop");
  await page.fill(".icon-pop-search", "zzzqqq-nothing");
  const empty = await page.evaluate(() => ({
    empty: document.querySelector(".icon-pop-empty")?.textContent ?? "",
    groups: document.querySelectorAll(".icon-pop-heading").length,
  }));
  verify("PI-05 empty state", empty.groups === 0
    && empty.empty.includes("No matching icons")
    && empty.empty.includes("Try another keyword or clear the search."), empty);

  // PI-06: Escape dismisses; outside mousedown also dismisses.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".icon-pop", { state: "detached" });
  await page.click(".group-row .proj-icon");
  await page.waitForSelector(".icon-pop");
  await page.mouse.click(640, 480);
  await page.waitForSelector(".icon-pop", { state: "detached" });
  verify("PI-06 dismissal", true);

  // PI-07: the Folder tile clears the mark back to the default.
  await page.click(".group-row .proj-icon");
  await page.waitForSelector(".icon-pop");
  await page.click(".icon-tile.folder");
  await page.waitForSelector(".icon-pop", { state: "detached" });
  const mark3 = await page.textContent(".group-row .proj-icon");
  const s3 = await waitSnap(page, (st) => st.projects[0]?.icon === undefined);
  verify("PI-07 folder tile clears", mark3.trim() === "📁" && s3.projects[0]?.icon === undefined, { mark3 });

  // PI-08: zh localization — title, Folder, headings, empty state.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page.click(".group-row .proj-icon");
  await page.waitForSelector(".icon-pop");
  const zh = await page.evaluate(() => ({
    title: document.querySelector(".icon-pop-title")?.textContent,
    folder: document.querySelector(".icon-tile.folder .icon-tile-name")?.textContent,
    heading: document.querySelector(".icon-pop-heading")?.textContent,
  }));
  verify("PI-08 zh labels", zh.title === "项目图标" && zh.folder === "文件夹"
    && zh.heading === "开发与工具", zh);
  await page.fill(".icon-pop-search", "zzzqqq-nothing");
  const zhEmpty = await page.textContent(".icon-pop-empty");
  verify("PI-09 zh empty state", zhEmpty.includes("没有匹配的图标")
    && zhEmpty.includes("试试其他关键词，或清空搜索。"), zhEmpty);
  await page.fill(".icon-pop-search", "");
  await page.screenshot({ path: join(outDir, "icon-picker-zh.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // PI-10: icon survives an app restart — every launch shares this run's
  // data root, so the second instance reads the same store.
  await page.click(".group-row .proj-icon");
  await page.waitForSelector(".icon-pop");
  await page.fill(".icon-pop-search", "rocket");
  await page.click('.icon-pop-grid .icon-tile:has-text("🚀")');
  await waitSnap(page, (st) => st.projects[0]?.icon === "🚀");
  const rc = await boundedClose(s1.app, s1.proc);
  verify("PI-10a clean close", rc.outcome === "resolved", rc);
  const s3i = await launch({}, "icon-restart");
  instances.push(s3i);
  const page3 = await s3i.app.firstWindow();
  await page3.waitForSelector(".group-row .proj-icon", { timeout: 15000 });
  const mark4 = await page3.textContent(".group-row .proj-icon");
  verify("PI-10 restart keeps mark", mark4.trim() === "🚀", mark4);
  // Convention: every instance a module launches is closed before it
  // returns — a live one holds the store lock and the next module's
  // launch waits on a window that never arrives.
  const rc3 = await boundedClose(s3i.app, s3i.proc);
  verify("PI-11 restart instance closed", rc3.outcome === "resolved", rc3);
}
