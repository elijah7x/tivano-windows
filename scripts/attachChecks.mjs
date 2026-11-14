// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 attachment e2e — Mock provider only: pick via the test-attached
// dialog stub, chips, cap notice, send with the frozen "Attached files:"
// prompt suffix, isolation, restart persistence, and the P1-28 preview
// reload/Retry checks against the real library copy. Synthetic files
// only.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

export async function runAttachChecks({
  launch,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
  dataRoot,
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

  // Synthetic pick payloads — one launch per selection set because the
  // env stub is read at pick time (process-wide, set once at launch).
  const pickDir = mkdtempSync(join(tmpdir(), "tivano-e2e-attach-"));
  const srcs = [];
  for (let i = 0; i < 10; i++) {
    const f = join(pickDir, `pick-${i}.txt`);
    writeFileSync(f, `synthetic attachment ${i}\n`);
    srcs.push(f);
  }

  const s1 = await launch(
    { TIVANO_TEST_ATTACH: srcs.slice(0, 2).join(delimiter) },
    "attach-main",
  );
  instances.push(s1);
  const { app } = s1;
  const page = await app.firstWindow();
  // A47: the frozen default makes the attach button open the downloads
  // popover — these checks exercise the picker itself, so gate it off.
  // The snapshot reaches clientStore a hop after the invoke resolves;
  // wait for the popover wrapper to actually leave the DOM.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", {
      language: "en",
      recentDownloadsPicker: false,
    }),
  );
  const threadId = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "AttachEn" }).then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "AttachEn" }).click();
  await page.locator("textarea[aria-label='Message']").waitFor();

  // The settings snapshot reaches clientStore a hop after the invoke
  // resolves — wait until the popover wrapper is really gone so the
  // button is the direct picker again.
  await page.waitForFunction(() => !document.querySelector(".dl-anchor"), {
    timeout: 8000,
  });
  // AT-01: pick two files — chips render, Send lights up with no text.
  await page.locator(".attach-btn").click();
  await page.locator(".attach-chip").nth(1).waitFor();
  verify("AT-01 picks land as chips", (await page.locator(".attach-chip").count()) === 2);
  verify(
    "AT-02 chip-only draft enables Send",
    await page.locator("button.primary:not([disabled])").isVisible(),
  );
  await page.screenshot({ path: join(outDir, "attach-en-chips.png") });

  // AT-03: remove a chip via × — one remains.
  await page.locator(".attach-chip .attach-chip-x").first().click();
  await page.locator(".attach-chip").nth(1).waitFor({ state: "detached" });
  verify("AT-03 chip remove", (await page.locator(".attach-chip").count()) === 1);

  // AT-04: send — user message keeps the descriptor; the provider prompt
  // carries the frozen "Attached files:" suffix (mock echoes its prompt).
  await page.locator("textarea[aria-label='Message']").fill("read this file");
  await page.locator("button.primary").click();
  await waitSnap(
    page,
    (s) => s.threads.find((t) => t.id === threadId)?.turn?.status === "done",
  );
  const afterSend = await snap(page);
  const th = afterSend.threads.find((t) => t.id === threadId);
  const userMsg = th.messages.find((m) => m.role === "user");
  verify(
    "AT-04 sent message keeps the descriptor",
    userMsg?.attachments?.length === 1 && userMsg.attachments[0].name === "pick-1.txt",
  );
  const reply = th.messages.find((m) => m.role === "assistant")?.content ?? "";
  verify(
    "AT-05 provider prompt carries frozen suffix",
    reply.includes("Attached files:") && reply.includes("- ") && reply.includes("pick-1.txt"),
  );
  await page.locator(".msg-attach .attach-chip").waitFor();
  verify("AT-06 message chip renders", true);

  // AT-07: thread isolation — a second thread shows no chips.
  const otherId = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "AttachOther" }).then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "AttachOther" }).click();
  await page.locator("textarea[aria-label='Message']").waitFor();
  verify("AT-07 isolation: other thread clean", (await page.locator(".attach-chip").count()) === 0);

  // AT-08: restart — the sent descriptor persists; runtime chips gone.
  const c1 = await boundedClose(app, s1.proc);
  verify("attach-main exited cleanly", c1.outcome === "resolved", c1);
  const s2 = await launch(
    { TIVANO_TEST_ATTACH: srcs.join(delimiter) },
    "attach-cap",
  );
  instances.push(s2);
  const { app: app2 } = s2;
  const page2 = await app2.firstWindow();
  await page2.locator(".thread-list .row", { hasText: "AttachEn" }).click();
  await page2.locator(".msg-attach .attach-chip").waitFor();
  verify("AT-08 sent descriptor survives restart", true);

  // AT-09: cap — 10 picks land 8 chips + the frozen left-out notice.
  const capId = await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "AttachCap" }).then((t) => t.id),
  );
  await page2.locator(".thread-list .row", { hasText: "AttachCap" }).click();
  await page2.locator("textarea[aria-label='Message']").waitFor();
  await page2.locator(".attach-btn").click();
  await page2.locator(".attach-chip").nth(7).waitFor();
  verify("AT-09 cap at 8", (await page2.locator(".attach-chip").count()) === 8);
  const note = await page2.locator(".composer-note").innerText();
  verify(
    "AT-10 frozen left-out notice",
    note === "2 files were left out: a message holds 8 attachments",
    note,
  );
  // A second pick attempt while full drops everything.
  await page2.locator(".attach-btn").click();
  await page2.waitForFunction(
    () => document.querySelector(".composer-note")?.textContent?.startsWith("10 files"),
    { timeout: 8000 },
  );
  const note2 = await page2.locator(".composer-note").innerText();
  verify(
    "AT-11 full-set drop notice",
    note2 === "10 files were left out: a message holds 8 attachments",
    note2,
  );

  // AT-12: attachment-only send (no typed text).
  await page2.locator("button.primary").click();
  await waitSnap(
    page2,
    (s) => s.threads.find((t) => t.id === capId)?.turn?.status === "done",
  );
  const capDone = await snap(page2);
  const capTh = capDone.threads.find((t) => t.id === capId);
  verify(
    "AT-12 attachment-only send",
    capTh.messages.find((m) => m.role === "user")?.attachments?.length === 8,
  );

  // AT-15..: paste/drop attach — real DOM events with DataTransfer Files.
  const pasteId = await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "AttachPaste" }).then((t) => t.id),
  );
  await page2.locator(".thread-list .row", { hasText: "AttachPaste" }).click();
  await page2.locator("textarea").first().waitFor();
  const makeFile = `(name, body) => { const dt = new DataTransfer(); dt.items.add(new File([body], name, { type: "text/plain" })); return dt; }`;
  await page2.evaluate((src) => {
    const dt = eval(src)("pasted-note.txt", "pasted bytes");
    const ta = document.querySelector(".composer textarea");
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    ta.dispatchEvent(ev);
  }, makeFile);
  await page2.locator(".composer .attach-chip", { hasText: "pasted-note.txt" }).waitFor();
  verify("AT-15 paste attaches a chip", true);

  // Plain text with no files is not intercepted — a synthetic paste
  // event never performs the native insertion, so what is verifiable
  // is that no chip appears and the handler passes through.
  await page2.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "plain words");
    const ta = document.querySelector(".composer textarea");
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    ta.dispatchEvent(ev);
  });
  await page2.waitForTimeout(300);
  verify(
    "AT-16 text-only paste not intercepted",
    (await page2.locator(".attach-chip").count()) === 1, // only the earlier pasted chip
  );

  // Drop onto the composer attaches the same way.
  await page2.evaluate((src) => {
    const dt = eval(src)("dropped.bin", "drop bytes");
    const el = document.querySelector(".composer");
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, makeFile);
  await page2.locator(".composer .attach-chip", { hasText: "dropped.bin" }).waitFor();
  verify("AT-17 drop attaches a chip", true);

  // Send — the pasted file's library path reaches the provider prompt.
  await page2.evaluate(() => {
    const ta = document.querySelector(".composer textarea");
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, ta.value + " tail");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page2.locator("button.primary").click();
  await waitSnap(
    page2,
    (s) => s.threads.find((t) => t.id === pasteId)?.turn?.status === "done",
  );
  const pasteDone = await snap(page2);
  const pasteReply = pasteDone.threads
    .find((t) => t.id === pasteId)
    .messages.find((m) => m.role === "assistant")?.content ?? "";
  verify(
    "AT-18 pasted files reach the prompt",
    pasteReply.includes("pasted-note.txt") && pasteReply.includes("dropped.bin"),
  );

  // AT-19: byte-blob over cap lands the left-out notice too.
  const pasteCap = await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "PasteCap" }).then((t) => t.id),
  );
  await page2.locator(".thread-list .row", { hasText: "PasteCap" }).click();
  await page2.locator("textarea").first().waitFor();
  await page2.evaluate(() => {
    const dt = new DataTransfer();
    for (let i = 0; i < 10; i++) dt.items.add(new File([`b${i}`], `bulk-${i}.txt`));
    const el = document.querySelector(".composer");
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page2.locator(".attach-chip").nth(7).waitFor();
  verify("AT-19 blob cap at 8", (await page2.locator(".attach-chip").count()) === 8);
  await page2.waitForFunction(
    () => document.querySelector(".composer-note")?.textContent?.startsWith("2 files"),
    { timeout: 8000 },
  );
  verify("AT-20 blob left-out notice", true);

  // AT-21..26 (A80): image attachments carry a live thumbnail + the
  // frozen preview popover; text files keep the plain chip.
  const imgId = await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "AttachImg" }).then((t) => t.id),
  );
  await page2.locator(".thread-list .row", { hasText: "AttachImg" }).click();
  await page2.locator("textarea").first().waitFor();
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await page2.evaluate((b64) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    dt.items.add(new File(["text"], "note.txt", { type: "text/plain" }));
    const el = document.querySelector(".composer");
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, PNG_B64);
  await page2.locator(".attach-chip .attach-thumb").waitFor();
  verify("AT-21 image chip carries a thumbnail", true);
  verify(
    "AT-22 text chip stays plain",
    (await page2.locator(".attach-chip").count()) === 2 &&
      (await page2.locator(".attach-chip .attach-thumb").count()) === 1,
  );
  // Tap the thumbnail — the shared preview popover opens at the pointer.
  await page2.locator(".attach-chip .attach-thumb-btn").click();
  await page2.locator(".attach-pop .attach-pop-img").waitFor();
  const popMeta = await page2.locator(".attach-pop-meta").innerText();
  verify(
    "AT-23 preview popover shows image + meta",
    popMeta.includes("dot.png"),
    popMeta,
  );
  await page2.screenshot({ path: join(outDir, "attach-preview.png") });
  await page2.keyboard.press("Escape");
  await page2.locator(".attach-pop").waitFor({ state: "detached" });
  verify("AT-24 Escape dismisses the preview", true);
  // Send — the message-side chip keeps its thumbnail + preview.
  await page2.locator("button.primary").click();
  await waitSnap(
    page2,
    (s) => s.threads.find((t) => t.id === imgId)?.turn?.status === "done",
  );
  await page2.locator(".msg-attach .attach-thumb").waitFor();
  verify("AT-25 sent image chip keeps the thumbnail", true);
  await page2.locator(".msg-attach .attach-thumb-btn").click();
  await page2.locator(".attach-pop .attach-pop-img").waitFor();
  verify("AT-26 sent chip previews too", true);
  await page2.keyboard.press("Escape");

  // AT-27..29 (P1-28): the popover re-reads the attachment on every open
  // instead of reusing the chip's bytes, and a failed read lands the
  // frozen failure state whose Retry reloads. The library copy at
  // <dataRoot>/attachments/<id>/<name> is the file a reopen re-reads —
  // attachments are copied at attach time, so a replaced source file is
  // moot on Windows and no watcher is needed.
  const imgAtt = (await snap(page2)).threads
    .find((t) => t.id === imgId)
    ?.messages.find((m) => m.role === "user")
    ?.attachments?.find((a) => a.name === "dot.png");
  if (!imgAtt) throw new Error("sent dot.png attachment id not found");
  const libCopy = join(dataRoot, "attachments", imgAtt.id, "dot.png");
  const savedPng = readFileSync(libCopy);
  rmSync(libCopy);
  await page2.locator(".msg-attach .attach-thumb-btn").click();
  await page2.locator(".attach-pop-fail").waitFor();
  const failText = await page2.locator(".attach-pop-fail").innerText();
  verify(
    "AT-27 vanished copy lands the frozen failure state + Retry",
    failText.includes("Preview unavailable") &&
      (await page2.locator(".attach-pop-retry").count()) === 1,
    failText,
  );
  writeFileSync(libCopy, savedPng);
  await page2.locator(".attach-pop-retry").click();
  await page2.locator(".attach-pop .attach-pop-img").waitFor();
  verify("AT-28 Retry reloads the image", true);
  // A reopen re-reads: swap the library bytes, dismiss and reopen — the
  // popover serves the new copy, not the image it first opened with.
  const firstSrc = await page2
    .locator(".attach-pop .attach-pop-img")
    .getAttribute("src");
  const PNG_B64_ALT =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  writeFileSync(libCopy, Buffer.from(PNG_B64_ALT, "base64"));
  await page2.keyboard.press("Escape");
  await page2.locator(".attach-pop").waitFor({ state: "detached" });
  await page2.locator(".msg-attach .attach-thumb-btn").click();
  await page2.locator(".attach-pop .attach-pop-img").waitFor();
  const reopenedSrc = await page2
    .locator(".attach-pop .attach-pop-img")
    .getAttribute("src");
  verify(
    "AT-29 reopen serves the replaced copy",
    reopenedSrc === `data:image/png;base64,${PNG_B64_ALT}` && reopenedSrc !== firstSrc,
  );
  await page2.keyboard.press("Escape");

  // AT-13: zh-Hans — aria label + notice localize.
  await page2.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  const zhId = await page2.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "附件测试" }).then((t) => t.id),
  );
  await page2.locator(".thread-list .row", { hasText: "附件测试" }).click();
  await page2.locator("textarea").first().waitFor();
  verify(
    "AT-13 zh attach button label",
    (await page2.locator("button.attach-btn").getAttribute("aria-label")) === "添加附件",
  );
  await page2.locator(".attach-btn").click();
  await page2.locator(".attach-chip").nth(7).waitFor();
  const zhNote = await page2.locator(".composer-note").innerText();
  verify(
    "AT-14 zh left-out notice",
    zhNote === "有 2 个文件未添加：每条消息最多 8 个附件",
    zhNote,
  );
  await page2.screenshot({ path: join(outDir, "attach-zh-cap.png") });
  void zhId;
  const c2 = await boundedClose(app2, s2.proc);
  verify("attach-cap exited cleanly", c2.outcome === "resolved", c2);
}
