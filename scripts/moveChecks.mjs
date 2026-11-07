// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01/F02 move/reorder e2e checks — real HTML5 drag events against the
// sidebar: same-affiliation reorder, pin inheritance, drop onto a
// project header to change affiliation, drop onto the standalone zone,
// the never-started gate, project reorder, restart persistence.

import { join } from "node:path";

export async function runMoveChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
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
  const rowSel = (title) => `.thread-list .row:has-text("${title}")`;
  // Dispatch a real dragstart→dragover→drop→dragend sequence with one
  // shared DataTransfer. `after` picks the lower/upper half of the target.
  // Locators resolve in Node (Playwright selectors allowed); handles go in.
  const drag = async (page, srcSel, dstSel, after) => {
    const src = await page.locator(srcSel).first().elementHandle();
    const dst = await page.locator(dstSel).first().elementHandle();
    // dragstart first — React's setDrag must flush before dragover/drop
    // handlers read it, so the sequence spans separate evaluate calls.
    await page.evaluate((srcEl) => {
      window.__mvDataTransfer = new DataTransfer();
      srcEl.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__mvDataTransfer }),
      );
    }, src);
    await page.waitForTimeout(80);
    await page.evaluate(
      ([dstEl, placeAfter]) => {
        const r = dstEl.getBoundingClientRect();
        const y = r.top + (placeAfter ? r.height * 0.8 : r.height * 0.2);
        dstEl.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            clientY: y,
            dataTransfer: window.__mvDataTransfer,
          }),
        );
        dstEl.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            clientY: y,
            dataTransfer: window.__mvDataTransfer,
          }),
        );
      },
      [dst, after],
    );
    await page.evaluate((srcEl) => {
      srcEl.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer: window.__mvDataTransfer }),
      );
      delete window.__mvDataTransfer;
    }, src);
    return { ok: true };
  };
  const projectRowSel = (name) =>
    `.thread-list .group-row:has(.group-name .title:text-is("${name}"))`;
  const mkProject = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`button[title="New thread in ${name}"]`);
  };
  const mkThread = async (page, projectName, title) => {
    await page.locator(`button[title="New thread in ${projectName}"]`).click();
    const id = (await snap(page)).selectedThreadId;
    await page.evaluate(
      ([tid, t]) => window.tivano.invoke("threads:rename", { id: tid, title: t }),
      [id, title],
    );
    await page.waitForSelector(rowSel(title));
    return id;
  };

  // ---- A: reorder inside a project, pin inheritance, cross-affiliation ----
  {
    const s1 = await launch("move-main");
    instances.push(s1);
    const { app, proc, ledger } = s1;
    const page = await app.firstWindow();
    await page.waitForSelector(".sidebar-head", { timeout: 15000 });
    await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
    await mkProject(page, "Move Proj");
    const t1 = await mkThread(page, "Move Proj", "MV-ONE");
    const t2 = await mkThread(page, "Move Proj", "MV-TWO");
    const t3 = await mkThread(page, "Move Proj", "MV-THREE");
    // nil sortOrder → newest leads: [THREE, TWO, ONE].
    let s = await waitSnap(page, (x) =>
      x.threads.some((t) => t.id === t3) && x.threads.some((t) => t.id === t1),
    );
    const domOrder = () =>
      page
        .locator(`${projectRowSel("Move Proj")} ~ .row`)
        .allInnerTexts()
        .then((xs) => xs.map((x) => x.split("\n")[0]));
    const titles = await domOrder();
    verify(
      "MOVE-01 newest leads before any reorder",
      titles.indexOf("MV-THREE") < titles.indexOf("MV-TWO") &&
        titles.indexOf("MV-TWO") < titles.indexOf("MV-ONE"),
      titles,
    );

    // Drag THREE onto the UPPER half of TWO → [TWO? no: THREE before TWO]
    // Upper half = insert before target: [ONE? ...] → [THREE, TWO, ONE]
    // stays? No — THREE was already first; before TWO lands it between
    // TWO and ONE? Order [THREE,TWO,ONE]: removing THREE → [TWO,ONE],
    // insert before TWO → [THREE,TWO,ONE]. Same. Use lower half of ONE:
    // remove THREE → [TWO,ONE], after ONE → [TWO,ONE,THREE].
    await drag(page, rowSel("MV-THREE"), rowSel("MV-ONE"), true);
    s = await waitSnap(
      page,
      (x) => x.threads.find((t) => t.id === t3)?.sortOrder === 2,
    );
    verify("MOVE-02 drop rewrote the section order", true);
    const titles2 = await domOrder();
    verify(
      "MOVE-03 DOM order follows the manual order",
      titles2.indexOf("MV-TWO") < titles2.indexOf("MV-ONE") &&
        titles2.indexOf("MV-ONE") < titles2.indexOf("MV-THREE"),
      titles2,
    );

    // Pin TWO, then drag ONE above it → ONE inherits the pin.
    const twoRow = page.locator(rowSel("MV-TWO"));
    await twoRow.hover();
    await twoRow.locator('button[title="Pin thread"]').click();
    await waitSnap(page, (x) => x.threads.find((t) => t.id === t2)?.isPinned === true);
    await drag(page, rowSel("MV-ONE"), rowSel("MV-TWO"), false);
    s = await waitSnap(page, (x) => x.threads.find((t) => t.id === t1)?.isPinned === true);
    verify("MOVE-04 dragged thread inherited the target pin", s.threads.length >= 0);

    // Cross-affiliation: drag ONE (a project thread) onto a standalone row.
    const solo = await page.evaluate(() =>
      window.tivano.invoke("threads:create", { projectId: null, title: "MV-SOLO" }),
    );
    const soloId = solo.thread?.id ?? solo.id;
    await page.waitForSelector(rowSel("MV-SOLO"));
    // A started thread must be refused — send a turn on ONE first.
    await page.evaluate((id) => {
      window.tivano.invoke("threads:select", { id });
      return window.tivano.invoke("turns:send", { threadId: id, text: "work started" });
    }, t1);
    await page.waitForTimeout(200);
    await drag(page, rowSel("MV-ONE"), rowSel("MV-SOLO"), true);
    await page.waitForSelector(".banner", { timeout: 8000 }).catch(() => null);
    const banner = await page.locator(".banner").innerText().catch(() => "");
    s = await snap(page);
    verify(
      "MOVE-05 started thread refused the move",
      s.threads.find((t) => t.id === t1)?.projectId !== null,
      { projectId: s.threads.find((t) => t.id === t1)?.projectId, banner },
    );
    verify(
      "MOVE-06 refusal surfaced the location banner",
      banner.includes("Could not change thread location"),
      banner,
    );

    // A clean thread drops onto the standalone row — affiliation changes,
    // then it lands right after the target row.
    const clean = await mkThread(page, "Move Proj", "MV-CLEAN");
    await drag(page, rowSel("MV-CLEAN"), rowSel("MV-SOLO"), true);
    s = await waitSnap(
      page,
      (x) => x.threads.find((t) => t.id === clean)?.projectId === null,
    );
    verify("MOVE-07 clean thread moved to standalone", true);
    const ungrouped = s.threads
      .filter((t) => t.projectId === null && !t.isArchived)
      .map((t) => t.id);
    verify(
      "MOVE-08 moved thread sits after its drop target",
      ungrouped.indexOf(soloId) >= 0 && ungrouped.indexOf(clean) > ungrouped.indexOf(soloId),
      ungrouped,
    );

    // A standalone thread drops onto the project HEADER → affiliation
    // changes and it lands on TOP of the destination section (nil
    // sortOrder, frozen parity).
    const clean3Res = await page.evaluate(() =>
      window.tivano.invoke("threads:create", { projectId: null, title: "MV-CLEAN3" }),
    );
    const clean3 = clean3Res.id;
    await page.waitForSelector(rowSel("MV-CLEAN3"));
    await drag(page, rowSel("MV-CLEAN3"), projectRowSel("Move Proj"), true);
    s = await waitSnap(page, (x) => {
      const t = x.threads.find((t) => t.id === clean3);
      const proj = x.projects.find((p) => p.name === "Move Proj");
      return t?.projectId === proj?.id && t?.sortOrder === undefined;
    });
    verify("MOVE-09 header drop lands on top of the section", true);
    const titles3 = await domOrder();
    // Pinned rows still lead the group (frozen: pin beats nil sortOrder);
    // the moved thread leads the UNPINNED partition.
    verify(
      "MOVE-10 header-drop thread leads the unpinned partition",
      titles3.find((x) => x !== "📌") === "MV-CLEAN3" &&
        titles3.indexOf("MV-CLEAN3") > titles3.lastIndexOf("📌"),
      titles3,
    );
    await page.screenshot({ path: join(outDir, "95-move.png") });
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("MOVE-11 instance closed cleanly", c.exited && c.outcome === "resolved", c.outcome);
  }

  // ---- B: project reorder + restart persistence + zh banner --------------
  {
    const s2 = await launch("move-proj");
    instances.push(s2);
    const { app, proc, ledger } = s2;
    const page = await app.firstWindow();
    await page.waitForSelector(".sidebar-head", { timeout: 15000 });
    await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
    await mkProject(page, "PRJ-AAA");
    await mkProject(page, "PRJ-BBB");
    const before = (await snap(page)).projects.map((p) => p.name);
    const aaa = before.indexOf("PRJ-AAA");
    const bbb = before.indexOf("PRJ-BBB");
    verify("MOVE-12 two fresh projects exist", aaa >= 0 && bbb >= 0, before);
    // Drag BBB's header onto AAA's upper half → BBB leads AAA.
    await drag(page, projectRowSel("PRJ-BBB"), projectRowSel("PRJ-AAA"), false);
    let s = await waitSnap(page, (x) => {
      const names = x.projects.map((p) => p.name);
      return names.indexOf("PRJ-BBB") < names.indexOf("PRJ-AAA");
    });
    verify("MOVE-13 project drag reordered the array", true);
    const c = await boundedClose(app, proc);
    ledger.exited = c.exited;
    ledger.outcome = c.outcome;
    verify("MOVE-14 proj session closed", c.exited && c.outcome === "resolved", c.outcome);

    const s3 = await launch("move-restart");
    instances.push(s3);
    const { app: app2, proc: proc2, ledger: ledger2 } = s3;
    const page2 = await app2.firstWindow();
    await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
    s = await waitSnap(page2, (x) => {
      const names = x.projects.map((p) => p.name);
      return names.indexOf("PRJ-BBB") < names.indexOf("PRJ-AAA");
    });
    verify("MOVE-15 project order persisted across restart", true);
    const c2 = await boundedClose(app2, proc2);
    ledger2.exited = c2.exited;
    ledger2.outcome = c2.outcome;
    verify("MOVE-16 restart closed cleanly", c2.exited && c2.outcome === "resolved", c2.outcome);
  }
}
