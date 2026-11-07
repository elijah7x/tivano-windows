// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 conversation outline e2e — the leading-edge rail: one tick per
// user message, hidden below two, hover preview card, click jumps the
// timeline to the anchored message, the lit tick tracks the reader.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function runMinimapChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  boundedClose,
  dataRoot,
}) {
  const launch = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  // Seed a thread with interleaved user/assistant history directly into
  // the segmented store — head thread + turns/<id>.json segment.
  const tid = randomUUID();
  const m = (id, role, content, extra = {}) => ({
    id,
    role,
    content,
    status: "done",
    ts: 1,
    ...extra,
  });
  const messages = [
    m("u1", "user", "short first prompt"),
    m("a1", "assistant", "x".repeat(4000)),
    m("u2", "user", "a much longer second prompt with several more words to widen this tick"),
    m("a2", "assistant", "y".repeat(4000)),
    m("u3", "user", "", { attachments: [{ id: "p1", name: "shot.png", size: 10 }] }),
    m("a3", "assistant", "z".repeat(2000)),
  ];
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.threads.push({
    id: tid,
    projectId: null,
    title: "minimap thread",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionGrants: [],
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
  mkdirSync(join(dataRoot, "turns"), { recursive: true });
  writeFileSync(
    join(dataRoot, "turns", `${tid}.json`),
    JSON.stringify({ schemaVersion: 1, threadId: tid, messages, turn: null }),
  );

  const s1 = await launch("minimap-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // MM-01: a thread with no user messages shows no rail.
  const fresh = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "empty" }),
  );
  await page.waitForSelector(".chat-head h1", { timeout: 10000 });
  verify("MM-01", (await page.locator(".minimap-rail").count()) === 0);

  // Select the seeded thread — three user messages → three ticks.
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".minimap-rail", { timeout: 10000 });
  const ticks = page.locator(".minimap-tick");
  await ticks.first().waitFor({ state: "visible", timeout: 5000 });
  verify("MM-02", (await ticks.count()) === 3);

  // MM-03: widths differ by weight — scroll to the bottom first so the
  // lit tick is the last one; the unlit first/second ticks then compare
  // by weight (the long second prompt is wider than the short first).
  // The image-only third titles by attachment fallback.
  const tl = page.locator(".timeline");
  await tl.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => {
    const ticks = [...document.querySelectorAll(".minimap-tick")];
    return ticks.at(-1)?.classList.contains("lit");
  }, { timeout: 5000 });
  const widths = await ticks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  const labels = await ticks.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  verify("MM-03", widths[1] > widths[0] && widths[1] < 26 && widths[0] < 26
    && labels[2] === "1 image", { widths, labels });

  // MM-04: hover the last tick → preview card carries the title.
  await ticks.nth(2).hover();
  await page.waitForSelector(".minimap-card", { timeout: 5000 });
  verify("MM-04",
    (await page.locator(".minimap-card-title").innerText()).trim() === "1 image");

  // MM-05: click the first tick → the timeline scrolls so its message
  // lands in view; the lit tick follows the reader.
  await page.mouse.move(0, 0);
  await ticks.first().click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".timeline");
    const art = el.querySelector('[data-mid="u1"]');
    if (!art) return false;
    const r = art.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return r.top >= er.top - 2 && r.top < er.bottom;
  }, { timeout: 5000 });
  await page.waitForSelector(".minimap-tick.lit", { timeout: 5000 });
  const litLabel = await page.locator(".minimap-tick.lit").getAttribute("aria-label");
  verify("MM-05", litLabel === "short first prompt", { litLabel });

  // MM-05b: frozen scrub — press on the first tick and drag down across
  // the cluster; the timeline tracks 1:1 and lands on the last entry.
  const firstBox = await ticks.first().boundingBox();
  const lastBox = await ticks.nth(2).boundingBox();
  await page.mouse.move(firstBox.x + 4, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + 4, lastBox.y + lastBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const el = document.querySelector(".timeline");
    const art = el.querySelector('[data-mid="u3"]');
    if (!art) return false;
    const r = art.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return r.top >= er.top - 2 && r.top < er.bottom;
  }, { timeout: 5000 });
  const scrubLabel = await page.locator(".minimap-tick.lit").getAttribute("aria-label");
  verify("MM-05b", scrubLabel === "1 image", { scrubLabel });

  // MM-06: scroll back to the bottom → the lit tick returns to the last
  // user message.
  await tl.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => {
    const ticks = [...document.querySelectorAll(".minimap-tick")];
    return ticks.at(-1)?.classList.contains("lit");
  }, { timeout: 5000 });
  verify("MM-06", true);

  // MM-07: zh locale — rail label localized; image fallback localized.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.waitForFunction(
    () => document.querySelector(".minimap-rail")?.getAttribute("aria-label") === "对话大纲",
    { timeout: 5000 },
  );
  const zhLabel = await ticks.nth(2).getAttribute("aria-label");
  verify("MM-07", zhLabel === "1 张图片", { zhLabel });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  await boundedClose(app, proc);
  check("MM-08", true, "clean shutdown");
}
