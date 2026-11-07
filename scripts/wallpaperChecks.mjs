// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A55 e2e — F26 bounded slice: wallpaper (frozen WallpaperCard — choose
// copies the picture into the app library under a generated basename,
// preview + edge-to-edge layer at backdropOpacity, softness → blur,
// remove deletes the library copy) and the Transparency slider. The
// Electron window is OPAQUE — the honest note states the slider drives
// the picture's own show-through, never the desktop behind the window.
// TIVANO_TEST_WALLPAPER is the main-owned dialog seam; the renderer
// never names a path (settings:set wallpaper is ignored — WP-08).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// 8×8 opaque-red PNG — a real decodable image, generated for the test.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8" +
    "z8Dwn4GBgQEAGvsB/Y3ys8cAAAAASUVORK5CYII=",
  "base64",
);

export async function runWallpaperChecks({
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
  const waitFor = async (locator, timeout = 8000) =>
    locator.waitFor({ state: "visible", timeout });
  const setRange = (locator, v) =>
    locator.evaluate((el, value) => {
      // React-controlled inputs install their own value descriptor —
      // set through the NATIVE setter so the change is detected.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
        el,
        String(value),
      );
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, v);

  const pic = join(outDir, "wp-src.png");
  const notPic = join(outDir, "wp-src.txt");
  writeFileSync(pic, PNG);
  writeFileSync(notPic, "not an image");

  const s1 = await launch({ TIVANO_TEST_WALLPAPER: pic }, "wp-main");
  instances.push(s1);
  const { app } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const openSettings = async () => {
    if ((await page.locator(".modal").count()) === 0) {
      await page.locator(".sidebar-foot button.row").click();
      await page.waitForSelector(".modal", { timeout: 8000 });
    }
    await page.locator(".wp-card").scrollIntoViewIfNeeded();
    await page.waitForSelector(".wp-card", { timeout: 8000 });
  };
  await openSettings();

  // ---- WP-01..03: section, honest transparency row -------------------
  verify("WP-01 wallpaper section + Choose", (await page.locator(".wp-card .wp-btn").count()) >= 1);
  const heads = await page.locator(".modal h3").allTextContents();
  verify("WP-02 Wallpaper + Transparency headings",
    heads.includes("Wallpaper") && heads.includes("Transparency"), heads);
  verify(
    "WP-03 honest opaque-window note",
    (await page.locator(".wp-note").last().textContent()).includes("stays opaque"),
  );

  // ---- WP-04..07: choose → library install → layer --------------------
  await page.locator(".wp-card .wp-btn").first().click(); // Choose…
  await waitSnap(page, (s) => !!s.settings.wallpaper?.file);
  const st = await snap(page);
  const file = st.settings.wallpaper.file;
  verify("WP-04 generated library basename, never the source path",
    /^wallpaper-[0-9a-f-]{36}\.png$/.test(file) && file !== pic, file);
  await waitFor(page.locator(".wp-backdrop"));
  verify(
    "WP-05 backdrop layer painted at the frozen 0.5 default",
    (await page.locator(".wp-backdrop").evaluate((el) => getComputedStyle(el).opacity)) ===
      "0.5",
  );
  verify(
    "WP-06 preview shows the picture (data URL, no path leak)",
    (await page.locator(".wp-preview").evaluate((el) => el.style.backgroundImage)).startsWith(
      'url("data:image/',
    ),
  );
  verify(
    "WP-07 Change + Remove + Softness controls appear",
    (await page.locator(".wp-card .wp-btn").count()) === 2 &&
      (await page.locator(".wp-slider").count()) >= 2,
  );

  // ---- WP-08: settings:set cannot plant a wallpaper path -------------
  const rejected = await page.evaluate(() =>
    window.tivano
      .invoke("settings:set", { wallpaper: { file: "wp-src.png", softness: 0 } })
      .then(() => "accepted")
      .catch((e) => `rejected:${String(e?.message ?? e)}`),
  );
  verify(
    "WP-08 wallpaper slot refuses settings patches outright",
    rejected.startsWith("rejected:") &&
      rejected.includes("wallpaper") &&
      (await snap(page)).settings.wallpaper?.file === file,
    rejected,
  );

  // ---- WP-09/10: opacity + softness sliders reach the layer ----------
  const opacitySlider = page.locator(".wp-slider").nth(1).locator("input[type=range]");
  await setRange(opacitySlider, 0.9);
  await waitSnap(page, (s) => s.settings.backdropOpacity === 0.9);
  verify(
    "WP-09 backdrop opacity drives the layer",
    (await page.locator(".wp-backdrop").evaluate((el) => getComputedStyle(el).opacity)) ===
      "0.9",
  );
  const softness = page.locator(".wp-slider").first().locator("input[type=range]");
  await setRange(softness, 1);
  await waitSnap(page, (s) => s.settings.wallpaper?.softness === 1);
  verify(
    "WP-10 softness maps to a CSS blur",
    (await page.locator(".wp-backdrop").evaluate((el) => el.style.filter)) ===
      "blur(28px)",
  );
  await page.screenshot({ path: join(outDir, "70-wallpaper-en.png") });

  // ---- WP-11/12: Reset + a rejected pick keeps the wallpaper ---------
  await page.locator(".wp-slider").nth(1).locator(".wp-btn").click(); // Reset
  await waitSnap(page, (s) => s.settings.backdropOpacity === 0.5);
  verify("WP-11 Reset restores the frozen 0.5",
    (await snap(page)).settings.backdropOpacity === 0.5);
  await app.evaluate((_electron, v) => {
    process.env.TIVANO_TEST_WALLPAPER = v;
  }, notPic);
  await page.locator(".wp-card .wp-btn").first().click(); // Change… → txt
  await page.waitForSelector(".wp-status", { timeout: 8000 });
  verify(
    "WP-12 a non-image pick reports and keeps the current wallpaper",
    (await page.locator(".wp-status").textContent()).includes("isn't a supported image") &&
      (await snap(page)).settings.wallpaper?.file === file,
  );

  // ---- WP-13: Performance Mode = frozen solid fallback ----------------
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { performanceMode: true }),
  );
  await waitSnap(page, (s) => s.settings.performanceMode === true);
  verify(
    "WP-13 performance mode paints the solid fallback (no layer, setting kept)",
    (await page.locator(".wp-backdrop").count()) === 0 &&
      (await snap(page)).settings.wallpaper?.file === file,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { performanceMode: false }),
  );
  await waitFor(page.locator(".wp-backdrop"));

  // ---- WP-14: remove deletes the copy + clears the slot ---------------
  await page.locator(".wp-card .wp-btn.danger").click();
  await waitSnap(page, (s) => s.settings.wallpaper === undefined);
  verify(
    "WP-14 remove clears slot + layer",
    (await page.locator(".wp-backdrop").count()) === 0,
  );
  // Black-box proof the library copy is gone: the guarded read channel
  // stops serving the removed basename (it never returned a path).
  const stale = await page.evaluate((f) =>
    window.tivano.invoke("wallpaper:data", { file: f }), file);
  verify("WP-14b library copy deleted (data channel serves null)", stale === null, stale);
  // And a traversal attempt on the same channel is refused outright.
  const traversal = await page.evaluate(() =>
    window.tivano.invoke("wallpaper:data", { file: "../store.json" }));
  verify("WP-14c basename guard refuses traversal", traversal === null, traversal);

  // ---- WP-15/16: restart persistence + zh-Hans -------------------------
  await app.evaluate((_electron, v) => {
    process.env.TIVANO_TEST_WALLPAPER = v;
  }, pic); // restore a real pick — WP-12 left the txt file behind
  await page.locator(".wp-card .wp-btn").first().click(); // Choose… again
  await waitSnap(page, (s) => !!s.settings.wallpaper?.file);
  await app.evaluate((_electron, v) => {
    process.env.TIVANO_TEST_WALLPAPER = "";
  }, "");
  await boundedClose(app, s1.proc);

  const s2 = await launch({}, "wp-restart");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  verify(
    "WP-15 wallpaper + opacity survive a restart",
    await (async () => {
      const s = await waitSnap(page2, (x) => !!x.settings.wallpaper?.file);
      return (
        s.settings.backdropOpacity === 0.5 &&
        /^wallpaper-[0-9a-f-]{36}\.png$/.test(s.settings.wallpaper.file) &&
        s.settings.wallpaper.softness === 0 // fresh install: slot was cleared first
      );
    })(),
  );
  await waitFor(page2.locator(".wp-backdrop"));

  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page2.locator(".sidebar-foot button.row").click();
  await page2.waitForSelector(".modal", { timeout: 8000 });
  await page2.locator(".wp-card").scrollIntoViewIfNeeded();
  const zhHeads = await page2.locator(".modal h3").allTextContents();
  verify(
    "WP-16 zh-Hans wallpaper + transparency + buttons",
    zhHeads.includes("壁纸") &&
      zhHeads.includes("透明度") &&
      (await page2.locator(".wp-card .wp-btn").first().textContent()) === "更换…",
    zhHeads,
  );
  await page2.screenshot({ path: join(outDir, "71-wallpaper-zh.png") });
  await boundedClose(s2.app, s2.proc);
}
