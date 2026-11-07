// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 theme catalog e2e — the frozen 29-theme picker: sections, swatch,
// real computed-token evidence on the document, OS-follow resolution,
// persistence across restart, zh-Hans localized section headers with
// un-localized theme names (frozen localizesTitle:false parity).

export async function runThemeChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  boundedClose,
}) {
  const launch = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const css = (page, prop) =>
    page.evaluate((p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(), prop);

  const s1 = await launch("theme-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en", theme: "breeze" }));

  // TH-01: the picker button carries the current theme's swatch + name.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  const btnText = await page.locator(".theme-btn").innerText();
  verify("TH-01", btnText.includes("Breeze"), btnText);

  // TH-02: menu opens with 29 items and the frozen section headers.
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu", { timeout: 5000 });
  const items = page.locator('.theme-menu [role="menuitemradio"]');
  verify("TH-02", (await items.count()) === 29, await items.count());
  const sections = await page.locator(".theme-menu .openin-section").allInnerTexts();
  verify("TH-02b", sections.join("|") === "Dark|Light", sections);

  // TH-03: pick Tokyo Night → the document tokens resolve the palette.
  await page.locator('.theme-menu [role="menuitemradio"]', { hasText: "Tokyo Night" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "tokyoNight",
    { timeout: 5000 },
  );
  const tn = {
    accent: await css(page, "--accent"),
    surface: await css(page, "--surface"),
    danger: await css(page, "--danger"),
    scheme: await page.evaluate(() => document.documentElement.style.colorScheme),
    bodyBg: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  };
  verify("TH-03",
    tn.accent.toLowerCase() === "#7aa2f7" && tn.surface.toLowerCase() === "#1a1b26" && tn.danger.toLowerCase() === "#f7768e"
      && tn.scheme === "dark" && tn.bodyBg === "rgb(26, 27, 38)",
    tn);

  // TH-04: a light theme flips scheme, surface and accent.
  await page.locator(".theme-btn").click();
  await page.locator('.theme-menu [role="menuitemradio"]', { hasText: "GitHub Light" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "githubLight",
    { timeout: 5000 },
  );
  const gl = {
    accent: await css(page, "--accent"),
    surface: await css(page, "--surface"),
    text: await css(page, "--text"),
    scheme: await page.evaluate(() => document.documentElement.style.colorScheme),
  };
  verify("TH-04",
    gl.accent.toLowerCase() === "#0969da" && gl.surface.toLowerCase() === "#ffffff" && gl.scheme === "light"
      && gl.text === "#1d1d20",
    gl);

  // TH-05: an unknown theme id is refused at the IPC boundary.
  const refused = await page.evaluate(() =>
    window.tivano.invoke("settings:set", { theme: "neon-party" }).then(
      () => "accepted",
      (e) => String(e?.message ?? e),
    ));
  verify("TH-05", refused !== "accepted", refused);

  // TH-06: zh-Hans — section headers localize, theme names stay English
  // (frozen localizesTitle:false parity).
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu", { timeout: 5000 });
  const zhSections = await page.locator(".theme-menu .openin-section").allInnerTexts();
  const zhFirst = await items.first().innerText();
  const zhDetail = await page.locator(".theme-detail").innerText();
  verify("TH-06",
    zhSections.join("|") === "深色|浅色" && zhFirst.includes("Breeze") &&
      zhDetail === "浅色 · 蓝色",
    { zhSections, zhFirst, zhDetail });
  // Close the menu by toggling the button — Escape would close the modal too.
  await page.locator(".theme-btn").click();
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });

  // TH-07: restart keeps the picked theme — the picker and the tokens
  // both reflect it.
  await boundedClose(app, proc);
  const s2 = await launch("theme-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const persisted = {
    theme: await page2.evaluate(() => document.documentElement.dataset.theme),
    accent: await css(page2, "--accent"),
    scheme: await page2.evaluate(() => document.documentElement.style.colorScheme),
  };
  verify("TH-07",
    persisted.theme === "githubLight" && persisted.accent.toLowerCase() === "#0969da"
      && persisted.scheme === "light",
    persisted);

  // TH-08: a follow-OS theme resolves to the host's real color scheme.
  await page2.evaluate(() => window.tivano.invoke("settings:set", { theme: "breeze" }));
  await page2.waitForFunction(
    () => document.documentElement.dataset.theme === "breeze",
    { timeout: 5000 },
  );
  const osFollow = await page2.evaluate(() => ({
    scheme: document.documentElement.style.colorScheme,
    osDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  }));
  verify("TH-08",
    osFollow.scheme === (osFollow.osDark ? "dark" : "light") && osFollow.accent.toLowerCase() === "#7ba58f",
    osFollow);

  await boundedClose(s2.app, s2.proc);
  check("TH-09", true, "clean shutdown");
}
