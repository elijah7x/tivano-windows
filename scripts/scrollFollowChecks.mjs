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
  // The band is dist <= 8 — endGap is offset by the 18px pad so a
  // sentinel-aligned snap reads 0 while the wheel-to-bottom resting
  // reads -18 (inside the <=1px stale-pin REVIVAL range). Breaking on
  // the band itself keeps this on the scrollFollowRepin path.
  {
    const box = await tl.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(60);
      const now = await metrics();
      if (now.dist <= 8 && now.dist > 1) break;
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

  const wheelUp = async (n, dy = -700, gap = 60) => {
    const box = await tl.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < n; i++) {
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(gap);
    }
  };
  const pill = page.locator(".history-pill");
  const pillHidden = async () => {
    if ((await pill.count()) === 0) return 0;
    const num = /(\d+)/.exec(await pill.innerText());
    return num ? Number(num[1]) : -1;
  };
  const waitSnap = async (fn, label) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const st = await snap(page);
      if (fn(st)) return st;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`snapshot never satisfied: ${label}`);
  };
  // The first timeline row whose box is at least partly visible — the
  // reader's current spot; a page prepend must not move it.
  const topVisibleMid = () =>
    tl.evaluate((el) => {
      const tlTop = el.getBoundingClientRect().top;
      for (const m of el.querySelectorAll("[data-mid]")) {
        const r = m.getBoundingClientRect();
        if (r.bottom > tlTop + 4) return { mid: m.dataset.mid, top: r.top };
      }
      return null;
    });
  const midTop = (mid) =>
    tl.evaluate((el, id) => {
      const m = el.querySelector(`[data-mid="${id}"]`);
      return m ? m.getBoundingClientRect().top : null;
    }, mid);

  // SF-05a/b/c: scroll-back paging mounts earlier rows ahead of the
  // viewport while the anchor holds the read position. Frozen pages
  // only inside the top screenful — wheel up until a wheel's landing
  // fires a page. The anchor invariant survives whatever scroll the
  // wheel applied: viewTop(row) == its pre-wheel top plus the wheel's
  // own motion (scrollTop delta minus the prepended height).
  const n0 = await pillHidden();
  verify("SF-05a pill counts hidden history", n0 > 0, { n0 });
  let paged = null;
  for (let i = 0; i < 16 && !paged; i++) {
    const pre = await metrics();
    const preAnchor = await topVisibleMid();
    await wheelUp(1, -1200);
    await page.waitForTimeout(300);
    const post = await metrics();
    const n1 = await pillHidden();
    if (n1 >= 0 && n1 < n0) {
      paged = { pre, preAnchor, post, n1 };
    }
  }
  verify(
    "SF-05b wheel paging loads earlier history",
    paged !== null,
    { n0, n1: paged?.n1 },
  );
  {
    const { pre, preAnchor, post } = paged;
    const prepend = post.h - pre.h;
    const rowTop = await midTop(preAnchor.mid);
    // viewTop' = viewTop − wheelDelta where wheelDelta = the scroll the
    // wheel applied before the restore = (post.top − prepend) − pre.top.
    // Equivalently: the anchor restore adds the prepended height back to
    // scrollTop so the only residual motion is the wheel itself.
    const wheelDelta = post.top - prepend - pre.top;
    const expected = preAnchor.top - wheelDelta;
    verify(
      "SF-05c read spot held across the prepend",
      prepend > 0 && Math.abs(rowTop - expected) <= 6,
      { preAnchor, rowTop, expected, prepend, post },
    );
  }

  // SF-05d: the frozen top pill taps a page itself.
  if ((await pill.count()) > 0) {
    await pill.click();
    await page.waitForTimeout(300);
  }
  const n2 = await pillHidden();
  verify(
    "SF-05d pill tap pages earlier history",
    n2 >= 0 && n2 < paged.n1,
    { n1: paged.n1, n2 },
  );

  // SF-05e: history is never stranded — wheel landings into the top
  // screenful (or exactly onto scrollTop 0 inside the cooldown) keep
  // paging, and the pill remains the tap-through fallback at a hard
  // top where a wheel produces no scroll event.
  for (let i = 0; i < 12; i++) {
    await wheelUp(2, -1200, 50);
    await page.waitForTimeout(120);
    if ((await pillHidden()) === 0) break;
    if ((await pill.count()) > 0) await pill.click();
    await page.waitForTimeout(160);
  }
  verify(
    "SF-05e no stranding at scrollTop 0",
    (await pillHidden()) === 0,
    { pill: await pill.count() },
  );

  // SF-06: a held pointer suppresses the growth snap even with the pin
  // armed — an attended send (Ctrl+Enter) while the press holds leaves
  // the reader where they put it; the next quiet growth after release
  // lands the pin again (frozen !isReaderInteracting).
  await tl.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sendTurn("[mock:slow] re-pin setup");
  await waitDone();
  await wheelUp(6);
  await page.waitForTimeout(200);
  {
    const composer = page.locator(".composer textarea");
    await composer.fill("held [mock:slow] attended");
    const box = await tl.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(600); // user row + chunks land while held
    const held = await metrics();
    await page.mouse.up();
    await waitDone();
    await page.waitForTimeout(300);
    mm = await metrics();
    verify(
      "SF-06 held pointer suppresses snap, release restores it",
      held.dist > 40 && Math.abs(mm.endGap) < 4,
      { held, after: mm },
    );
  }

  // SF-07: a newly-outstanding question row re-pins a paged-back reader.
  await wheelUp(6);
  await page.waitForTimeout(200);
  await sendTurn("[mock:question] repin check");
  await waitSnap(
    (st) => st.threads.find((x) => x.id === tid)?.turn?.question?.status === "pending",
    "question pending",
  );
  await page.waitForTimeout(400);
  mm = await metrics();
  verify("SF-07 outstanding question re-pins", Math.abs(mm.endGap) < 4, mm);
  await page.locator(".approval.question .qchoice").first().click();
  await page.locator(".approval.question button", { hasText: "Send" }).click();
  await waitDone();

  // SF-08: an approval row never re-pins on its own (frozen rule).
  await wheelUp(6);
  await page.waitForTimeout(200);
  await sendTurn("[mock:approval] hold");
  await waitSnap(
    (st) => st.threads.find((x) => x.id === tid)?.turn?.approval?.status === "pending",
    "approval pending",
  );
  await page.waitForTimeout(400);
  mm = await metrics();
  verify("SF-08 approval row does not re-pin", mm.dist > 40, mm);
  await page.getByRole("button", { name: "Allow once" }).click();
  await waitDone();

  // SF-09: a queued follow-up draining unattended never re-pins — only
  // an attended send does (frozen fetch-on-send).
  await wheelUp(6);
  await page.waitForTimeout(200);
  await sendTurn("[mock:slow] drain parent");
  await page.evaluate(
    (id) =>
      window.tivano.invoke("followUps:enqueue", {
        threadId: id,
        text: "[mock:slow] drained unattended",
      }),
    tid,
  );
  await waitDone(); // parent finishes, the queue drains on its own
  await waitDone(); // drained turn finishes
  await page.waitForTimeout(300);
  mm = await metrics();
  verify("SF-09 unattended drain does not re-pin", mm.dist > 40, mm);

  await boundedClose(app, proc);
  check("SF-10", true, "clean shutdown");
}
