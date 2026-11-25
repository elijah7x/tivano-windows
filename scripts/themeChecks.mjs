// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-51 / F26 accent & appearance e2e — the 12 named accent colors +
// AppearanceMode split-circle button (Match System / Light / Dark),
// computed-token evidence on the document, OS-follow resolution,
// persistence across restart, and localized zh-Hans accent names.

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
    window.tivano.invoke("settings:set", { language: "en", theme: "breeze", appearanceMode: "system" }));

  // TH-01: the picker button carries the current accent swatch + name.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  const btnText = await page.locator(".theme-btn").innerText();
  verify("TH-01", btnText.includes("Avocado"), btnText);

  // TH-02: menu opens with all 12 named v3.0.0 accent colors.
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu", { timeout: 5000 });
  const items = page.locator('.theme-menu [role="menuitemradio"]');
  verify("TH-02", (await items.count()) === 12, await items.count());

  // TH-03: pick Sky Blue + switch appearance to Dark → dark tokens + dark hex.
  await page.locator('.theme-menu [role="menuitemradio"]', { hasText: "Sky Blue" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "nightOwl",
    { timeout: 5000 },
  );
  // Cycle Match System -> Light -> Dark via the split-circle button.
  await page.locator(".appearance-btn").click();
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === "light",
    { timeout: 5000 },
  );
  await page.locator(".appearance-btn").click();
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === "dark",
    { timeout: 5000 },
  );
  const darkSky = {
    accent: await css(page, "--accent"),
    surface: await css(page, "--surface"),
    scheme: await page.evaluate(() => document.documentElement.style.colorScheme),
    bodyBg: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  };
  verify("TH-03",
    darkSky.accent.toLowerCase() === "#82aaff" && darkSky.surface.toLowerCase() === "#1e1e20"
      && darkSky.scheme === "dark" && darkSky.bodyBg === "rgb(30, 30, 32)",
    darkSky);

  // TH-04: pick Sea Blue + switch to Light → light surface and light hex.
  await page.locator(".theme-btn").click();
  await page.locator('.theme-menu [role="menuitemradio"]', { hasText: "Sea Blue" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "github",
    { timeout: 5000 },
  );
  // Dark -> Match System -> Light.
  await page.locator(".appearance-btn").click();
  await page.locator(".appearance-btn").click();
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === "light",
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

  // TH-06: zh-Hans — accent color names localize.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".theme-btn").click();
  await page.waitForSelector(".theme-menu", { timeout: 5000 });
  const zhFirst = await items.first().innerText();
  const zhBtnText = await page.locator(".theme-btn").innerText();
  verify("TH-06",
    zhFirst.includes("系统强调色") && zhBtnText.includes("海蓝"),
    { zhFirst, zhBtnText });
  await page.locator(".theme-btn").click();
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });

  // TH-07: restart keeps the picked accent and appearanceMode.
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
    persisted.theme === "github" && persisted.accent.toLowerCase() === "#0969da"
      && persisted.scheme === "light",
    persisted);

  // TH-08: Match System appearanceMode resolves to the host's real color scheme.
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { theme: "breeze", appearanceMode: "system" }));
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
