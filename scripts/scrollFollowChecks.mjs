// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-30 pinned-follow e2e — the frozen ThreadTimeline scroll contract
// exercised on a synthetic long chat: growth keeps the end only while
// pinned, an upward scroll releases, landing near the end re-pins, and
// an attended composer send fetches a paged-back reader. A slow mock
// tick keeps the stream open long enough to scroll mid-turn.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function runScrollFollowChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  boundedClose,
  dataRoot,
}) {
  const launch = (label) =>
    launchApp({ TIVANO_MOCK_TICK_MS: "80" }, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  // Seed a thread long enough to overflow the windowed tail (26 tall
  // messages > the 12-block initial window), with earlier history left
  // hidden so scroll-back paging has rows to load.
  const tid = randomUUID();
  const m = (id, role, content) => ({
    id,
    role,
    content,
    status: "done",
    ts: 1,
  });
  const messages = [];
  for (let i = 1; i <= 26; i++) {
    messages.push(m(`u${i}`, "user", `prompt ${i}`));
    messages.push(m(`a${i}`, "assistant", `reply ${i} ` + "x".repeat(2500)));
  }
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.threads.push({
    id: tid,
    projectId: null,
    title: "scroll thread",
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

  const s1 = await launch("scroll-follow");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".timeline", { timeout: 10000 });
  const tl = page.locator(".timeline");

  const metrics = () =>
    tl.evaluate((el) => {
      // The follow snap scrolls the end sentinel to the viewport's end
      // edge — the residual "distance from bottom" is the pad below it,
      // so "at the end" is the sentinel's bottom meeting the scrollport.
      const sentinel = el.lastElementChild;
      return {
        top: el.scrollTop,
        dist: el.scrollHeight - el.scrollTop - el.clientHeight,
        h: el.scrollHeight,
        endGap: sentinel
          ? sentinel.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom
          : 9999,
      };
    });
  const sendTurn = (text) =>
    page.evaluate(
      ([id, body]) =>
        window.tivano.invoke("turns:send", { threadId: id, text: body }),
      [tid, text],
    );
  const waitDone = async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await snap(page);
      const t = state.threads.find((x) => x.id === tid);
      if (t?.turn?.status === "done" || t?.turn == null) {
        if (t?.turn?.status === "done") return;
        // null turn only counts before any turn exists — keep polling
        // when one was just sent.
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("turn never reached done");
  };

  // SF-01: a pinned reader stays at the end while a turn streams.
  await tl.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sendTurn("[mock:slow] pinned growth");
  await waitDone();
  let mm = await metrics();
  verify("SF-01", Math.abs(mm.endGap) < 4, mm);

  // SF-02: a real wheel-up mid-stream releases the pin — later chunks
  // must not snap the reader back down (frozen scrollFollowRelease).
  await sendTurn("[mock:slow] release check");
  await page.waitForTimeout(300); // let the stream start
  {
    const box = await tl.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(60);
    }
  }
  await page.waitForTimeout(400); // chunks keep landing while released
  const released = await metrics();
  await waitDone(); // stream finishes
  mm = await metrics();
  verify("SF-02", released.dist > 50 && mm.dist > 50, { released, after: mm });

  // SF-03: wheeling back down into the re-pin band re-follows growth.
  {
    const box = await tl.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(60);
      const now = await metrics();
      if (Math.abs(now.endGap) < 4) break;
    }
  }
  await page.waitForTimeout(120);
  await sendTurn("[mock:slow] repin check");
  await waitDone();
  mm = await metrics();
  verify("SF-03", Math.abs(mm.endGap) < 4, mm);

  // SF-04: an attended composer send fetches a paged-back reader.
  {
    const box = await tl.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(60);
    }
  }
  await page.waitForTimeout(200);
  const composer = page.locator(".composer textarea");
  await composer.fill("attended send check");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  mm = await metrics();
  verify("SF-04", Math.abs(mm.endGap) < 4, mm);

  await boundedClose(app, proc);
  check("SF-05", true, "clean shutdown");
}
