// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A63 e2e — F09 conversation rewind (frozen revert/resend, bounded):
// a right-clicked message earns "Edit from here" (user prompts) and
// "Rewind to this turn" (any message bound to a turn). Rewind drops the
// turn and everything after it, always keeps file changes (the menu
// says so up front), and the edited send goes out as a fresh turn.
// Synthetic provider only.

export async function runRevertChecks({
  launch,
  instances,
  snap,
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

  const s1 = await launch({}, "revert-main");
  instances.push(s1);
  const page = await s1.app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const tid = await page.evaluate(() =>
    window.tivano
      .invoke("threads:create", { projectId: null, title: "rewind chat" })
      .then((t) => t.id),
  );
  await page.locator(".thread-list .row", { hasText: "rewind chat" }).click();
  const box = page.locator("textarea[aria-label='Message']");
  await box.waitFor();
  const send = async (text) => {
    await box.fill(text);
    await page.locator("button.primary").click();
    await waitSnap(page, (s) => {
      const t = s.threads.find((x) => x.id === tid);
      return t?.turn?.status === "done" && t.turn === null
        ? true
        : t?.turn?.status === "done";
    });
  };
  await send("first question");
  await send("second question");
  const st0 = await snap(page);
  const turnIds = [
    ...new Set(
      st0.threads
        .find((x) => x.id === tid)
        .messages.map((m) => m.turnId)
        .filter(Boolean),
    ),
  ];
  verify(
    "RW-01 two turns landed before the rewind",
    turnIds.length === 2,
    turnIds.length,
  );

  // RW-02: rewind the SECOND turn — the timeline keeps only the first.
  await page
    .locator("article.msg.user", { hasText: "second question" })
    .click({ button: "right" });
  await page.waitForSelector(".msg-menu", { timeout: 5000 });
  const rows = await page
    .locator(".msg-menu .suggest-row .suggest-name")
    .allInnerTexts();
  verify(
    "RW-02 popover carries the rewind rows",
    rows.includes("Edit from here") && rows.includes("Rewind to this turn"),
    rows,
  );
  await page
    .locator(".msg-menu .suggest-row", { hasText: "Rewind to this turn" })
    .click();
  // Two-step confirm: the armed label states files are kept.
  const armed = await page
    .locator(".msg-menu .suggest-row .suggest-name")
    .allInnerTexts();
  verify(
    "RW-03 confirm label states files are kept",
    armed.some((x) => x.includes("file changes stay")),
    armed,
  );
  await page
    .locator(".msg-menu .suggest-row", { hasText: "file changes stay" })
    .click();
  const st1 = await waitSnap(page, (s) => {
    const t = s.threads.find((x) => x.id === tid);
    return (
      t && !t.messages.some((m) => m.content.endsWith("second question"))
    );
  });
  const cur1 = st1.threads.find((x) => x.id === tid);
  const users1 = cur1.messages.filter((m) => m.role === "user");
  verify(
    "RW-04 second turn rewound, notice marks the point",
    users1.length === 1 &&
      users1[0].content.endsWith("first question") &&
      cur1.turn === null &&
      cur1.messages.some(
        (m) => m.role === "system" && m.content.includes("File changes were kept"),
      ),
    { users: users1.length, turn: cur1.turn },
  );

  // RW-05: Edit-from-here on the surviving prompt — composer arms, the
  // next send rewinds first and goes out as a fresh turn.
  await page
    .locator("article.msg.user", { hasText: "first question" })
    .click({ button: "right" });
  await page
    .locator(".msg-menu .suggest-row", { hasText: "Edit from here" })
    .click();
  await page.waitForSelector(".edit-banner", { timeout: 5000 });
  verify(
    "RW-05 edit arms the composer with the original text",
    (await box.inputValue()) === "first question",
    await box.inputValue(),
  );
  await box.fill("edited first question");
  await page.locator("button.primary").click();
  const st2 = await waitSnap(page, (s) => {
    const t = s.threads.find((x) => x.id === tid);
    return (
      t?.turn?.status === "done" &&
      t.messages.some((m) => m.content.endsWith("edited first question"))
    );
  });
  const cur2 = st2.threads.find((x) => x.id === tid);
  const users2 = cur2.messages.filter((m) => m.role === "user");
  verify(
    "RW-06 resend rewound and sent the edited text",
    users2.length === 1 &&
      users2[0].content.endsWith("edited first question") &&
      cur2.turn !== null,
    users2.map((m) => m.content.slice(-30)),
  );

  // RW-07: the rewound timeline survives a restart.
  await boundedClose(s1.app, s1.proc);
  const s2 = await launch({}, "revert-again");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  const st3 = await snap(page2);
  const cur3 = st3.threads.find((x) => x.id === tid);
  verify(
    "RW-07 rewound timeline persisted across restart",
    cur3 &&
      cur3.messages.filter((m) => m.role === "user").length === 1 &&
      cur3.turn?.status === "done",
    cur3?.messages.length,
  );
  await boundedClose(s2.app, s2.proc);
}
