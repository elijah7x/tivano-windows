// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 anti-slop guidance e2e — the mock provider echoes the wire prompt
// verbatim, so the delivered block is observable in the assistant reply:
// once per session, skipped for slash commands, off still sends the
// disregard notice once.

export async function runAntiSlopChecks({ launch: launchApp, instances, snap, check, boundedClose }) {
  const launch = (label) => launchApp({}, label);
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
  const sendDone = async (page, threadId, text) => {
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId, text },
    );
    const s = await waitSnap(
      page,
      (x) => x.threads.find((t) => t.id === threadId)?.turn?.status === "done",
    );
    const thread = s.threads.find((t) => t.id === threadId);
    const asst = [...thread.messages].reverse().find((m) => m.role === "assistant");
    return asst?.content ?? "";
  };
  const newThread = async (page) => {
    await page.locator('button[title="New thread"]').click();
    return (await snap(page)).selectedThreadId;
  };
  const ENABLED = "[Tivano anti-slop guidance]";
  const DISABLED = "[Tivano anti-slop guidance: off]";

  const s1 = await launch("antislop-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // AS-01: first ordinary message carries the enabled guidance once.
  const t1 = await newThread(page);
  let reply = await sendDone(page, t1, "antislop check one");
  verify("AS-01 first send injects the enabled guidance block", reply.includes(ENABLED));

  // AS-02: the same session never injects again.
  reply = await sendDone(page, t1, "antislop check two");
  verify(
    "AS-02 second send on the same session carries no guidance",
    !reply.includes(ENABLED) && !reply.includes(DISABLED),
  );

  // AS-03: the frozen "Concise AI replies" switch renders active.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  const switchBtn = page.locator('.modal .choice-row .choice[role="switch"]', {
    hasText: "Concise AI replies",
  });
  verify("AS-03 concise-replies switch renders", await switchBtn.count() === 1);
  verify(
    "AS-03b switch is on by default",
    (await switchBtn.getAttribute("aria-checked")) === "true",
  );

  // AS-04: toggling off still delivers the disregard block once.
  await switchBtn.click();
  await page.locator(".modal-actions .primary").click();
  await page.waitForSelector(".modal", { state: "detached", timeout: 8000 });
  await waitSnap(page, (x) => x.settings.antiSlopEnabled === false);
  const t2 = await newThread(page);
  reply = await sendDone(page, t2, "antislop off check");
  verify("AS-04 off state delivers the disregard notice once", reply.includes(DISABLED));

  // AS-05: the off delivery is also a one-shot.
  reply = await sendDone(page, t2, "antislop off again");
  verify("AS-05 off block is not repeated", !reply.includes(DISABLED));

  // AS-06: re-enable; a slash-opened message skips guidance and keeps it
  // pending for the next ordinary message.
  await page.evaluate(() => window.tivano.invoke("settings:set", { antiSlopEnabled: true }));
  const t3 = await newThread(page);
  reply = await sendDone(page, t3, "/plan antislop skip");
  verify("AS-06 a known slash command carries no guidance", !reply.includes(ENABLED));
  reply = await sendDone(page, t3, "antislop ordinary after slash");
  verify("AS-06b pending delivery lands on the next ordinary message", reply.includes(ENABLED));

  // AS-07: an unknown slash word is ordinary text.
  const t4 = await newThread(page);
  reply = await sendDone(page, t4, "/nosuch antislop unknown");
  verify("AS-07 unknown slash word still receives guidance", reply.includes(ENABLED));

  const c = await boundedClose(app, proc);
  verify("AS-08 antislop instance closed cleanly", c.outcome === "resolved", c);
}
