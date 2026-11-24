// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A48 e2e — F04 link popover (frozen LinkPopover: right-click →
// transient Open Link / Copy Link menu under the link; the frozen
// Merge row needs a forge target, intentionally absent) and P2-62
// retired Performance Mode absence.

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

  // ---- P2-62: Performance Mode switch is retired -----------------------
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  const pmBtn = page.locator('button[role="switch"]', { hasText: "Performance Mode" });
  verify("PM-01 retired Performance Mode switch absent", (await pmBtn.count()) === 0);
  await page.keyboard.press("Escape");

  const c1 = await boundedClose(app, proc);
  verify("appearance-main exited cleanly", c1.outcome === "resolved", c1);
}
