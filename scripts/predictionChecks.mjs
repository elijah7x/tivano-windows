// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-01 composer predictions e2e — Mock provider only:
//   - empty composer shows gray prediction + "Press Tab to accept" after turn done
//   - Tab accepts into draft for editing; ArrowRight accepts when empty
//   - typing dismisses it and sends only what was typed
//   - failed/empty prediction shows nothing and does not interrupt next turn
//   - Settings > Text generation = Off suppresses prediction
//   - zh-Hans shows "按 Tab 键接受"

import { join } from "node:path";

export async function runPredictionChecks({
  launch: launchApp,
  instances,
  snap,
  outDir,
  check,
  boundedClose,
}) {
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
  const sendTurn = async (page, threadId, text) => {
    await page.evaluate(
      (a) => window.tivano.invoke("turns:send", a),
      { threadId, text },
    );
    await waitSnap(
      page,
      (x) => x.threads.find((y) => y.id === threadId)?.turn?.status === "done",
    );
  };

  const s = await launch("s-predict");
  instances.push(s);
  const { app, proc, ledger } = s;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  const tid = await page.evaluate(() =>
    window.tivano.invoke("threads:create", { projectId: null, title: "Predict" }).then((t) => t.id),
  );
  await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), tid);
  await page.waitForSelector(".composer textarea", { timeout: 10000 });

  // 1. Completed turn shows gray prediction + "Press Tab to accept" hint.
  await sendTurn(page, tid, "first request [mock:predict:Run the unit tests]");
  const pred = page.locator(".composer-prediction");
  await pred.waitFor({ timeout: 10000 });
  const predText = await page.locator(".composer-prediction-text").innerText();
  const hintText = await page.locator(".composer-prediction-hint").innerText();
  const predColor = await pred.evaluate((el) => getComputedStyle(el).color);
  verify(
    "PRED-01 suggestion and Press Tab to accept hint appear after turn completes",
    predText === "Run the unit tests" && hintText === "Press Tab to accept" && !!predColor,
    { predText, hintText, predColor },
  );
  await page.screenshot({ path: join(outDir, "92-composer-prediction-en.png") });

  // 2. Tab puts suggestion in the draft for editing.
  await page.locator(".composer textarea").focus();
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => !document.querySelector(".composer-prediction"));
  await page.keyboard.type(" --watch");
  const afterTab = await page.locator(".composer textarea").inputValue();
  verify(
    "PRED-02 Tab accepts prediction into draft for further editing",
    afterTab === "Run the unit tests --watch",
    afterTab,
  );
  await page.locator(".composer textarea").fill("");

  // 3. ArrowRight accepts when composer is empty.
  await sendTurn(page, tid, "second request [mock:predict:Check git status]");
  await pred.waitFor({ timeout: 10000 });
  await page.locator(".composer textarea").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => !document.querySelector(".composer-prediction"));
  const afterRight = await page.locator(".composer textarea").inputValue();
  verify(
    "PRED-03 ArrowRight accepts prediction into empty draft",
    afterRight === "Check git status",
    afterRight,
  );
  await page.locator(".composer textarea").fill("");

  // 4. Typing dismisses prediction; sending sends only what was typed.
  await sendTurn(page, tid, "third request [mock:predict:Should be dismissed]");
  await pred.waitFor({ timeout: 10000 });
  await page.locator(".composer textarea").focus();
  await page.keyboard.type("only typed text");
  await page.waitForFunction(() => !document.querySelector(".composer-prediction"));
  await page.keyboard.press("Enter");
  const sTyped = await waitSnap(
    page,
    (x) => {
      const th = x.threads.find((y) => y.id === tid);
      return th?.turn?.status === "done" && th.messages.some((m) => m.role === "user" && m.content === "only typed text");
    },
  );
  const sentTyped = sTyped.threads
    .find((y) => y.id === tid)
    .messages.filter((m) => m.role === "user")
    .at(-1)?.content;
  verify(
    "PRED-04 typing dismisses suggestion and sends only what was typed",
    sentTyped === "only typed text",
    sentTyped,
  );

  // 5. Failed prediction shows nothing, surfaces no error, and allows the next turn.
  await sendTurn(page, tid, "fourth request [mock:predict-fail]");
  await new Promise((r) => setTimeout(r, 250));
  const errCount = await page.locator(".error-banner").count();
  const predCountAfterFail = await pred.count();
  await page.locator(".composer textarea").fill("after failure [mock:predict:Follow up]");
  await page.keyboard.press("Enter");
  await pred.waitFor({ timeout: 10000 });
  verify(
    "PRED-05 failed prediction shows nothing and does not interrupt next turn",
    errCount === 0 && predCountAfterFail === 0 && (await pred.count()) === 1,
    { errCount, predCountAfterFail },
  );

  // 6. Text generation Off suppresses prediction.
  await page.evaluate(() => window.tivano.invoke("settings:set", { textGeneration: "off" }));
  await page.waitForFunction(() => !document.querySelector(".composer-prediction"));
  await sendTurn(page, tid, "fifth request [mock:predict:Should not appear]");
  await new Promise((r) => setTimeout(r, 250));
  verify(
    "PRED-06 textGeneration off suppresses prediction",
    (await pred.count()) === 0,
    await pred.count(),
  );

  // 7. zh-Hans localized hint.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { textGeneration: "automatic", language: "zh-Hans" }),
  );
  await sendTurn(page, tid, "sixth request [mock:predict:运行测试]");
  await pred.waitFor({ timeout: 10000 });
  const zhHint = await page.locator(".composer-prediction-hint").innerText();
  verify("PRED-07 zh-Hans shows 按 Tab 键接受", zhHint === "按 Tab 键接受", zhHint);

  const c = await boundedClose(app, proc);
  ledger.exited = c.exited;
  ledger.outcome = c.outcome;
  verify("predict exited cleanly", c.exited && c.outcome === "resolved", c.outcome);
}
