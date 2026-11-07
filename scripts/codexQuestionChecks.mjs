// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Codex requestUserInput e2e checks — against the OFFLINE fixture only:
// the question card presents validated questions, choices + Other text
// reach the wire in the frozen {answers:{qid:{answers:[...]}}} shape
// (echoed into assistant text), skip sends {answers:{}}, server-side
// resolution expires the card, malformed payloads are declined
// in-protocol, and secret questions mask their input.
// Nothing here proves a real provider.

import { join } from "node:path";

export async function runCodexQuestionChecks({
  launch: launchApp,
  instances,
  snap,
  codexFixture,
  workspaceRoot,
  outDir,
  check,
  boundedClose,
}) {
  const launch = (overrides = {}, label) =>
    launchApp(
      {
        TIVANO_PROVIDER: "codex",
        TIVANO_CODEX_FIXTURE: codexFixture,
        TIVANO_CODEX_NODE: process.execPath,
        TIVANO_WORKSPACE_ROOT: workspaceRoot,
        ...overrides,
      },
      label,
    );
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitSnapshot = async (page, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const s = await snap(page);
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out waiting for the expected application state");
  };
  const newCodexThread = async (page, name) => {
    await page.locator('button[title="New project"]').click();
    await page.getByLabel("Project name").fill(name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".group-name");
    await page.locator(`button[title="New thread in ${name}"]`).click();
    await page.waitForSelector(".chat-head h1");
    return (await snap(page)).selectedThreadId;
  };
  // Language-independent thread creation — localized sessions cannot rely
  // on English control titles.
  const newCodexThreadIpc = async (page, name) => {
    const proj = await page.evaluate((n) => window.tivano.invoke("projects:create", { name: n }), name);
    const th = await page.evaluate(
      (pid) => window.tivano.invoke("threads:create", { projectId: pid, title: "q" }),
      proj.id,
    );
    await page.evaluate((id) => window.tivano.invoke("threads:select", { id }), th.id);
    await page.waitForSelector(".chat-head h1");
    return th.id;
  };
  const send = async (page, text) => {
    await page.locator(".composer textarea").fill(text);
    await page.keyboard.press("Enter");
  };
  const questionOf = (s, threadId) => s.threads.find((x) => x.id === threadId)?.turn?.question;
  const lastText = (s, threadId) => {
    const th = s.threads.find((x) => x.id === threadId);
    return th?.messages.map((m) => m.content).join("\n") ?? "";
  };

  // --- session Q1: single question, choice + Other, answer on the wire ---
  let s = await launch({}, "s-questions-a");
  instances.push(s);
  let { app, proc, ledger } = s;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  let threadId = await newCodexThread(page, "Q Proj");
  await send(page, "question please");
  await waitSnapshot(page, (st) => questionOf(st, threadId)?.status === "pending");
  await page.waitForSelector(".approval.question", { timeout: 10000 });
  let q = questionOf(await snap(page), threadId);
  verify("question card presented (validated)", q?.questions?.length === 1, q);
  verify(
    "question carries prompt + choices + flags",
    q.questions[0].prompt === "Proceed with the deploy?" &&
      q.questions[0].choices.length === 2 &&
      q.questions[0].allowsOther === true &&
      q.questions[0].isSecret === false,
    q.questions[0],
  );
  await page.screenshot({ path: join(outDir, "40-question-card.png") });

  // Recommended choice is preselected (frozen parity); pick the other choice
  // and add free text via the Other field, then Send.
  await page.locator(".qchoice", { hasText: "Hold" }).click();
  await page.locator(".qother").fill("ship it friday");
  await page.locator(".approval.question button", { hasText: "Send" }).click();
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  let text = lastText(await snap(page), threadId);
  verify(
    "answer reached the wire in the frozen shape",
    text.includes("answered: q-deploy=Hold|ship it friday"),
    text.slice(-200),
  );
  verify("card settled to answered", questionOf(await snap(page), threadId)?.status === "answered");
  await page.screenshot({ path: join(outDir, "41-question-answered.png") });

  // --- session Q2 (same instance): multi-question paging + skip-path ----
  await send(page, "qmulti please");
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.question?.status === "pending" && t.status === "running";
  });
  await page.waitForSelector(".approval.question .qnav");
  // Question 1: recommended preselected; go Next.
  await page.locator(".approval.question button", { hasText: "Next" }).click();
  // Question 2: free-text Other answer.
  await page.locator(".qother").fill("billing-api");
  await page.locator(".approval.question button", { hasText: "Send" }).click();
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  text = lastText(await snap(page), threadId);
  verify(
    "multi-question answers on the wire (recommended default kept)",
    text.includes("q-region=us-east-1 (recommended)") && text.includes("q-name=billing-api"),
    text.slice(-240),
  );
  await page.screenshot({ path: join(outDir, "42-question-multi-answered.png") });

  // --- session Q3 (same instance): skip → {answers:{}} -----------------
  await send(page, "question skip");
  await waitSnapshot(page, (st) => questionOf(st, threadId)?.status === "pending");
  await page.locator(".approval.question button", { hasText: "Skip" }).click();
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  text = lastText(await snap(page), threadId);
  verify("skip wrote the empty answers map", text.includes("question skipped"), text.slice(-200));

  // --- session Q4 (same instance): server-side resolution expires card --
  // The fixture resolves ~15ms after the request — below the poll interval,
  // so "pending" is never a guaranteed observation. The question object's
  // existence with status expired IS the proof it was presented, then
  // withdrawn by the server (never a user answer).
  await send(page, "qresolve please");
  await waitSnapshot(page, (st) => questionOf(st, threadId)?.status === "expired");
  verify("server-side resolution expired the card", true);
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });

  // --- session Q5 (same instance): malformed → declined in-protocol -----
  await send(page, "qbad please");
  await waitSnapshot(page, (st) => {
    const t = st.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  let st = await snap(page);
  verify(
    "malformed question never presented; turn still completed",
    st.threads.find((x) => x.id === threadId)?.turn?.question === undefined ||
      st.threads.find((x) => x.id === threadId)?.turn?.question === null,
    st.threads.find((x) => x.id === threadId)?.turn?.question,
  );

  // --- session Q6 (same instance): secret question → masked input -------
  await send(page, "qsecret please");
  await waitSnapshot(page, (st) => questionOf(st, threadId)?.status === "pending");
  const qtype = await page.locator(".qother").getAttribute("type");
  verify("secret question masks its input", qtype === "password", qtype);
  await page.locator(".qother").fill("s3cr3t");
  await page.screenshot({ path: join(outDir, "43-question-secret.png") });
  await page.locator(".approval.question button", { hasText: "Send" }).click();
  await waitSnapshot(page, (st2) => {
    const t = st2.threads.find((x) => x.id === threadId)?.turn;
    return t?.status === "done" || t?.status === "error";
  });
  text = lastText(await snap(page), threadId);
  verify("secret answer reached the wire verbatim", text.includes("q-token=s3cr3t"), text.slice(-160));

  const q1close = await boundedClose(app, proc);
  ledger.exited = q1close.exited;
  ledger.outcome = q1close.outcome;
  check("questions instance exited cleanly", q1close.exited && q1close.exitCode === 0, q1close.outcome);

  // --- session Q7: zh-Hans card ---------------------------------------
  s = await launch({}, "s-questions-zh");
  instances.push(s);
  ({ app, proc, ledger } = s);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  threadId = await newCodexThreadIpc(page, "问 Proj");
  await send(page, "question please");
  await waitSnapshot(page, (st2) => questionOf(st2, threadId)?.status === "pending");
  await page.waitForSelector(".approval.question", { timeout: 10000 });
  const zhCard = await page.locator(".approval.question").innerText();
  verify(
    "zh-Hans question card renders localized",
    zhCard.includes("Codex 向你提问") && zhCard.includes("跳过") && zhCard.includes("发送"),
    zhCard.slice(0, 120),
  );
  await page.screenshot({ path: join(outDir, "44-question-card-zh.png") });
  const q7close = await boundedClose(app, proc);
  ledger.exited = q7close.exited;
  ledger.outcome = q7close.outcome;
  check("zh questions instance exited cleanly", q7close.exited && q7close.exitCode === 0, q7close.outcome);
}
