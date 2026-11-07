// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A48 e2e — F04 link popover (frozen LinkPopover: right-click →
// transient Open Link / Copy Link menu under the link; the frozen
// Merge row needs a forge target, intentionally absent) and F26
// performanceMode (frozen: strips rendered effects — html flag → CSS
// kills shadows/glows/filters/transitions/animations, persisted,
// zh-Hans).

export async function runAppearanceChecks({
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

  const s1 = await launch({}, "appearance-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // A link-bearing turn — the mock reply echoes the prompt verbatim, so
  // the URL lands inside a rendered assistant markdown link.
  const tid = await page.evaluate(() =>
    window.tivano
      .invoke("threads:create", { projectId: null, title: "links" })
      .then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "links" }).click();
  await page.locator("textarea[aria-label='Message']").waitFor();
  await page
    .locator("textarea[aria-label='Message']")
    .fill("see [the spec](https://example.com/spec) for the rule");
  await page.locator("button.primary").click();
  await waitSnap(
    page,
    (s) => s.threads.find((x) => x.id === tid)?.turn?.status === "done",
  );
  const link = page.locator("a[data-md-link]", { hasText: "the spec" }).first();
  await link.waitFor();

  // LP-01: right-click opens the popover under the link with both rows.
  await link.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  const rows = await page.locator(".link-pop .suggest-row .suggest-name").allInnerTexts();
  verify(
    "LP-01 frozen rows, no fabricated merge",
    rows.join("|") === "Open Link|Copy Link",
    rows,
  );
  const popBox = await page.locator(".link-pop").boundingBox();
  const linkBox = await link.boundingBox();
  verify(
    "LP-02 anchored at the link's bounds",
    popBox && linkBox && Math.abs(popBox.x - linkBox.x) < 40 && popBox.y >= linkBox.y + linkBox.height - 1,
    { popBox, linkBox },
  );
  await page.screenshot({ path: `${outDir}/link-popover-en.png` });

  // LP-03: Copy Link writes the real href to the OS clipboard.
  await page.locator(".link-pop .suggest-row", { hasText: "Copy Link" }).click();
  await page.waitForSelector(".link-pop", { state: "detached", timeout: 5000 });
  const clip = await page.evaluate(() =>
    navigator.clipboard.readText().catch((e) => `err:${e}`),
  );
  verify("LP-03 Copy Link wrote the clipboard", clip === "https://example.com/spec", clip);

  // LP-04: re-open then Escape dismisses.
  await link.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".link-pop", { state: "detached", timeout: 5000 });
  verify("LP-04 Escape closes", true);

  // LP-05: re-open then outside click dismisses (transient).
  await link.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  await page.mouse.click(30, 400);
  await page.waitForSelector(".link-pop", { state: "detached", timeout: 5000 });
  verify("LP-05 outside click closes", true);

  // LP-06: the Open Link row is present and enabled — firing it would
  // launch the host browser, so the row is verified, not dispatched
  // (the links:open-external channel is separately covered).
  await link.click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  verify(
    "LP-06 Open Link enabled",
    await page.locator(".link-pop .suggest-row", { hasText: "Open Link" }).isEnabled(),
  );
  await page.keyboard.press("Escape");

  // ---- F26 performanceMode --------------------------------------------
  // PM-01: the switch renders in the Appearance block, default off.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  const pmBtn = page.locator('button[role="switch"]', { hasText: "Performance Mode" });
  await pmBtn.waitFor();
  verify("PM-01 switch present, default off", (await pmBtn.getAttribute("aria-checked")) === "false");

  // PM-02: on → html flag + a real effect stripped. The theme picker's
  // menu (.openin-menu) carries a real drop shadow — observable in both
  // directions while the modal stays open.
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu");
  const before = await page.evaluate(
    () => getComputedStyle(document.querySelector(".theme-menu")).boxShadow,
  );
  await page.locator(".theme-btn").click(); // close the menu
  await pmBtn.click();
  await page.waitForFunction(
    () => document.documentElement.dataset.performance === "1",
    { timeout: 5000 },
  );
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu");
  const after = await page.evaluate(
    () => getComputedStyle(document.querySelector(".theme-menu")).boxShadow,
  );
  verify(
    "PM-02 on strips the menu shadow",
    before !== "none" && after === "none",
    { before, after },
  );
  await page.screenshot({ path: `${outDir}/performance-on.png` });
  await page.locator(".theme-btn").click(); // close the menu

  // PM-03: off → flag removed, the effect returns.
  await pmBtn.click();
  await page.waitForFunction(
    () => document.documentElement.dataset.performance === undefined,
    { timeout: 5000 },
  );
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu");
  const back = await page.evaluate(
    () => getComputedStyle(document.querySelector(".theme-menu")).boxShadow,
  );
  verify("PM-03 off restores effects", back !== "none", back);
  await page.locator(".theme-btn").click();
  await page.keyboard.press("Escape"); // close settings

  // PM-04: on persists across a real restart.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  await page.locator('button[role="switch"]', { hasText: "Performance Mode" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.performance === "1",
    { timeout: 5000 },
  );
  await page.keyboard.press("Escape");
  const c1 = await boundedClose(app, proc);
  verify("appearance-main exited cleanly", c1.outcome === "resolved", c1);
  const s2 = await launch({}, "appearance-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const persisted = await page2.evaluate(
    () => document.documentElement.dataset.performance,
  );
  verify("PM-04 flag persisted across restart", persisted === "1", persisted);
  const stored = await page2.evaluate(() =>
    window.tivano.invoke("state:get", {}).then((s) => s.settings.performanceMode),
  );
  verify("PM-05 settings store holds true", stored === true, stored);

  // PM-06: zh-Hans — the switch label localizes.
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page2.locator(".sidebar-foot button.row").click();
  await page2.waitForSelector(".modal", { timeout: 8000 });
  const zhBtn = page2.locator('button[role="switch"]', { hasText: "性能模式" });
  await zhBtn.waitFor();
  verify("PM-06 zh label 性能模式", true);
  verify(
    "PM-06b zh detail",
    (await zhBtn.getAttribute("title")) ===
      "关闭窗口透明度、模糊、光晕和背景效果，以最大程度降低 GPU 占用",
    await zhBtn.getAttribute("title"),
  );
  // Restore en + off for the next module.
  await zhBtn.click();
  await page2.waitForFunction(
    () => document.documentElement.dataset.performance === undefined,
    { timeout: 5000 },
  );
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  const c2 = await boundedClose(s2.app, s2.proc);
  verify("appearance-restart exited cleanly", c2.outcome === "resolved", c2);
}
