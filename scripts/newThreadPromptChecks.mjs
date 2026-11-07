// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Frozen NewThreadPrompt e2e checks — the centred question and editable
// affiliation before a thread's first message: project name as the link,
// the location menu (standalone / projects / add), real moves through
// threads:move-affiliation, zh-Hans rendering.

export async function runNewThreadPromptChecks({
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

  const s1 = await launch("ntp-main");
  instances.push(s1);
  const { app, proc, ledger } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // A project thread opens on the prompt with the project name as the link.
  const proj = await page.evaluate(() =>
    window.tivano.invoke("projects:create", { name: "NTP Proj" }),
  );
  const th = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid, title: "ntp" }),
    proj.id,
  );
  await page.waitForSelector(".ntp", { timeout: 10000 });
  const q1 = await page.locator(".ntp-q").innerText();
  verify(
    "NTP-01 project question carries the project link",
    q1.includes("What should we build in") &&
      (await page.locator(".ntp-q .ntp-link").innerText()) === "NTP Proj",
    q1,
  );

  // The link opens the location menu: standalone, projects, add.
  await page.locator(".ntp-q .ntp-link").click();
  await page.waitForSelector(".ntp-menu", { timeout: 5000 });
  const menuText = await page.locator(".ntp-menu").innerText();
  verify(
    "NTP-02 menu lists standalone + projects + add",
    menuText.includes("Work without a project") &&
      menuText.includes("PROJECTS") &&
      menuText.includes("NTP Proj") &&
      menuText.includes("Add project…"),
    menuText,
  );
  // The current project row is checked.
  const checked = await page.locator('.ntp-item[aria-checked="true"] .ntp-name').allInnerTexts();
  verify("NTP-02b current project checked", checked.length === 1 && checked[0] === "NTP Proj", checked);

  // Standalone moves the thread and the prompt rewords itself.
  await page.locator('.ntp-item:has-text("Work without a project")').click();
  await waitSnap(page, (s) => s.threads.find((x) => x.id === th.id)?.projectId === null);
  await page.waitForSelector('.ntp-q:text-is("What should we build?")', { timeout: 8000 });
  verify("NTP-03 moved standalone + prompt reworded", true);

  // The standalone sub-link reopens the menu; picking a project moves back.
  await page.locator('.ntp-sub .ntp-link').click();
  await page.waitForSelector(".ntp-menu", { timeout: 5000 });
  await page.locator('.ntp-item:has-text("NTP Proj")').click();
  await waitSnap(page, (s) => s.threads.find((x) => x.id === th.id)?.projectId === proj.id);
  await page.waitForSelector('.ntp-q .ntp-link:text-is("NTP Proj")', { timeout: 8000 });
  verify("NTP-04 moved back to the project", true);

  // "Add project…" creates + moves in one flow (bounded inline field).
  await page.locator(".ntp-q .ntp-link").click();
  await page.locator('.ntp-item:has-text("Add project…")').click();
  await page.locator(".ntp-input").fill("NTP Added");
  await page.locator('.ntp-add .btn:has-text("Add")').click();
  const s2 = await waitSnap(
    page,
    (s) =>
      s.projects.some((p) => p.name === "NTP Added") &&
      s.threads.find((x) => x.id === th.id)?.projectId ===
        s.projects.find((p) => p.name === "NTP Added")?.id,
  );
  verify("NTP-05 add creates the project and moves the thread", true, s2.projects.length);

  // Escape closes the menu without moving.
  await page.locator(".ntp-q .ntp-link").click();
  await page.waitForSelector(".ntp-menu", { timeout: 5000 });
  await page.keyboard.press("Escape");
  const menuGone = await page.locator(".ntp-menu").count() === 0;
  verify("NTP-06 Escape closes the menu", menuGone);

  // zh-Hans renders the question with the link inline.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForSelector(".ntp-q", { timeout: 8000 });
  const qZh = await page.locator(".ntp-q").innerText();
  verify(
    "NTP-07 zh-Hans question + link",
    qZh.includes("要在") && qZh.includes("里构建什么") &&
      (await page.locator(".ntp-q .ntp-link").innerText()) === "NTP Added",
    qZh,
  );
  await page.screenshot({ path: `${outDir}/new-thread-prompt.png` });

  const r = await boundedClose(app, proc, { closeMs: 8000, exitMs: 5000, killWaitMs: 3000 });
  ledger.exited = r.exited;
  ledger.outcome = r.killed ? `${r.outcome}+killed` : r.outcome;
  verify("NTP-08 instance closed cleanly", r.exited, r.outcome);
}
