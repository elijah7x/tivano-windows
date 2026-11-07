// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A50 e2e — F04 message popover + reply quotes (frozen
// MessagePopoverMenu/messageActions + ReplyQuote): right-click on a
// message opens a transient menu at the pointer; assistant replies
// carry Copy / Copy message as markdown / Copy last code block / Add
// to reply, user prompts the two copy rows. A link inside a message
// keeps the link popover. Quote chips serialize ahead of the words as
// `> ` blocks and peel back into chips on the sent message. The
// frozen "Edit from here" row is revert — not in this build.
// (The mock reply always ends with a fenced block, so the code row
// is always present in e2e; the no-fence negative is unit-covered.)

export async function runMessageMenuChecks({
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
  const clip = (page) =>
    page.evaluate(() => navigator.clipboard.readText().catch((e) => `err:${e}`));
  const send = async (page, text) => {
    await page.locator("textarea[aria-label='Message']").fill(text);
    await page.locator("button.primary").click();
  };
  const threadDone = (s, tid) =>
    s.threads.find((x) => x.id === tid)?.turn?.status === "done";
  const rightClick = (page, selector, last = false) =>
    page.evaluate(([sel, pickLast]) => {
      const els = document.querySelectorAll(sel);
      const el = pickLast ? els[els.length - 1] : els[0];
      el.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 240, clientY: 200 }),
      );
    }, [selector, last]);
  /** Select the last paragraph of the last assistant body, then open
   *  the menu — mirrors right-clicking inside a selection. */
  const rightClickSelected = (page) =>
    page.evaluate(() => {
      const bodies = document.querySelectorAll(".msg.assistant .msg-body");
      const body = bodies[bodies.length - 1];
      const p = [...body.querySelectorAll("p")].pop() ?? body;
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 240, clientY: 200 }),
      );
    });
  const menuRows = (page) =>
    page.locator(".msg-menu .msg-row .suggest-name").allInnerTexts();

  const s1 = await launch({}, "msgmenu-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const tid = await page.evaluate(() =>
    window.tivano
      .invoke("threads:create", { projectId: null, title: "menu" })
      .then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "menu" }).click();
  await page.locator("textarea[aria-label='Message']").waitFor();

  // Turn 1: the mock reply carries markdown **and** the fixed fence.
  await send(page, "echo **bold** tail");
  await waitSnap(page, (s) => threadDone(s, tid));
  await page.locator(".msg.assistant").last().waitFor();

  // MQ-01: assistant rows — the mock reply always ends fenced, so the
  // code row is always present; Add to reply starts the second group.
  await rightClick(page, ".msg.assistant", true);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  verify(
    "MQ-01 assistant rows",
    (await menuRows(page)).join("|") ===
      "Copy|Copy message as markdown|Copy last code block|Add to reply",
    await menuRows(page),
  );
  verify(
    "MQ-02 Add to reply starts a group",
    (await page.locator(".msg-menu .msg-row.group-start", { hasText: "Add to reply" }).count()) === 1,
  );
  await page.screenshot({ path: `${outDir}/msg-menu-en.png` });

  // MQ-03: Copy with no selection → the rendered plain text (markdown
  // formatting flattened, fence body included).
  await page.locator(".msg-menu .msg-row", { hasText: "Copy" }).first().click();
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  const plainClip = await clip(page);
  verify(
    "MQ-03 Copy → plain rendered text",
    plainClip.includes("echo bold tail") && !plainClip.includes("**bold**"),
    plainClip.slice(0, 80),
  );

  // MQ-04: Copy message as markdown → the raw source.
  await rightClick(page, ".msg.assistant", true);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page
    .locator(".msg-menu .msg-row", { hasText: "Copy message as markdown" })
    .click();
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  const rawClip = await clip(page);
  verify(
    "MQ-04 markdown copy → raw source",
    rawClip.includes("echo **bold** tail") && rawClip.includes("```ts"),
    rawClip.slice(0, 80),
  );

  // MQ-05: Copy last code block → the last fence's body only.
  await rightClick(page, ".msg.assistant", true);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page
    .locator(".msg-menu .msg-row", { hasText: "Copy last code block" })
    .click();
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  verify(
    "MQ-05 code copy → fence body only",
    (await clip(page)) === "const synthetic = true; // mock output, not generated code",
    await clip(page),
  );

  // MQ-06: a selection inside the message wins the Copy fallback.
  await rightClickSelected(page);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.locator(".msg-menu .msg-row", { hasText: "Copy" }).first().click();
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  verify(
    "MQ-06 selection copy beats the whole-message fallback",
    (await clip(page)) === "Done — nothing was executed.",
    await clip(page),
  );

  // MQ-07: Add to reply with the selection live → the chip quotes the
  // selected words (frozen quoteSnapshot = selection ?? text).
  await rightClickSelected(page);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.locator(".msg-menu .msg-row", { hasText: "Add to reply" }).click();
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  await page.waitForSelector(".composer-chips .quote-chip", { timeout: 5000 });
  const chipText = await page
    .locator(".composer-chips .quote-chip .quote-chip-text")
    .innerText();
  verify("MQ-07 Add to reply → composer quote chip", chipText === "Done — nothing was executed.", chipText);

  // Dedupe: the same quote is not added twice.
  await rightClickSelected(page);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.locator(".msg-menu .msg-row", { hasText: "Add to reply" }).click();
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  verify(
    "MQ-08 identical quote not added twice",
    (await page.locator(".composer-chips .quote-chip").count()) === 1,
  );

  // Backspace peels the last quote from an empty draft.
  await page.locator("textarea[aria-label='Message']").focus();
  await page.keyboard.press("Backspace");
  await page.waitForFunction(
    () => document.querySelectorAll(".composer-chips .quote-chip").length === 0,
    { timeout: 5000 },
  );
  verify("MQ-09 empty backspace peels the last quote", true);

  // Re-add, type the words, send — the sent message peels the quote
  // back into a chip over the typed body.
  await rightClickSelected(page);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.locator(".msg-menu .msg-row", { hasText: "Add to reply" }).click();
  await page.waitForSelector(".composer-chips .quote-chip", { timeout: 5000 });
  await send(page, "following up");
  const sent = await waitSnap(page, (s) => {
    const m = s.threads.find((x) => x.id === tid)?.messages;
    const last = [...(m ?? [])].reverse().find((x) => x.role === "user");
    return last && last.content.startsWith("> ") ? s : null;
  });
  verify(
    "MQ-10 quote serializes as the leading > block",
    sent.threads
      .find((x) => x.id === tid)
      .messages.filter((m) => m.role === "user")
      .pop().content === "> Done — nothing was executed.\n\nfollowing up",
  );
  const userMsg = page.locator(".msg.user").last();
  await userMsg.waitFor();
  verify(
    "MQ-11 sent message peels back to chip + body",
    (await userMsg.locator(".quote-chip.ro").count()) === 1 &&
      (await userMsg.locator(".quote-chip.ro .quote-chip-text").innerText()) ===
        "Done — nothing was executed." &&
      (await userMsg.locator(".msg-body").innerText()).includes("following up"),
  );
  await page.screenshot({ path: `${outDir}/quote-peel-en.png` });

  // MQ-12: the quote chip's × removes it from a fresh draft.
  await rightClickSelected(page);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.locator(".msg-menu .msg-row", { hasText: "Add to reply" }).click();
  await page.waitForSelector(".composer-chips .quote-chip", { timeout: 5000 });
  await page.locator(".composer-chips .quote-chip-x").click();
  await page.waitForFunction(
    () => !document.querySelector(".composer-chips .quote-chip"),
    { timeout: 5000 },
  );
  verify("MQ-12 chip × removes the quote", true);

  // MQ-13: user prompts carry the copy pair plus the F09 rewind rows
  // (frozen "Edit from here" / bounded Rewind — user-only).
  await rightClick(page, ".msg.user", true);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  verify(
    "MQ-13 user rows = copy pair + rewind rows",
    (await menuRows(page)).join("|") ===
      "Copy|Copy message as markdown|Edit from here|Rewind to this turn",
    await menuRows(page),
  );

  // MQ-14: Escape closes; outside click closes (transient).
  await page.keyboard.press("Escape");
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  await rightClick(page, ".msg.user", true);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  await page.mouse.click(30, 400);
  await page.waitForSelector(".msg-menu", { state: "detached", timeout: 5000 });
  verify("MQ-14 Escape + outside close", true);

  // MQ-15: a link inside a message keeps the link popover.
  await send(page, "see [the spec](https://example.com/spec)");
  await waitSnap(page, (s) =>
    s.threads.find((x) => x.id === tid)?.messages.filter((m) => m.role === "assistant").length === 3,
  );
  await page.locator(".msg.assistant a[data-md-link]", { hasText: "the spec" }).last().click({ button: "right" });
  await page.waitForSelector(".link-pop", { timeout: 5000 });
  verify(
    "MQ-15 link popover wins over the message menu",
    (await page.locator(".msg-menu").count()) === 0,
  );
  await page.keyboard.press("Escape");

  // MQ-16: zh-Hans rows.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await rightClick(page, ".msg.assistant", true);
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  verify(
    "MQ-16 zh rows",
    (await menuRows(page)).join("|") ===
      "复制|将消息复制为 Markdown|复制最后一个代码块|添加到回复",
    await menuRows(page),
  );
  await page.screenshot({ path: `${outDir}/msg-menu-zh.png` });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const c = await boundedClose(app, proc);
  verify("msgmenu instance closed cleanly", c.outcome === "resolved" && c.exited, c);
}
