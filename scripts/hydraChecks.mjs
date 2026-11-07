// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F21 Hydra configuration e2e — the configuration layer only: honest
// catalog surface, persisted settings, the settings page, per-thread
// defaults, and IPC boundary discipline. Head scheduling is not
// implemented and the page must say so.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const GIT = "/usr/bin/git";
function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  });
}

export async function runHydraChecks({
  launch: launchApp,
  instances,
  snap,
  check,
  boundedClose,
  dataRoot,
  outDir,
}) {
  const launch = (label) => launchApp({}, label);
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };
  const waitIdle = (page) =>
    page.evaluate(
      () =>
        new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(r));
        }),
    );
  const storedSettings = () =>
    JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8")).settings;
  // The store debounces flushes (~80ms); poll the file until the predicate
  // sees the landed value rather than asserting on a stale read.
  const waitStore = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = storedSettings();
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 40));
    }
    return last;
  };
  const openSettings = async (page) => {
    await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
    await page.locator(".sidebar-foot button.row").click();
    await page.waitForSelector(".modal", { timeout: 10000 });
    await page.waitForSelector(".hydra-section", { timeout: 10000 });
    await waitIdle(page);
  };
  const closeSettings = async (page) => {
    await page.locator(".modal-actions .primary").click();
    await page.waitForSelector(".modal", { state: "detached", timeout: 10000 });
  };
  const newThread = async (page) => {
    await page.locator('button[title="New thread"]').click();
    return (await snap(page)).selectedThreadId;
  };

  const s1 = await launch("hydra-main");
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));

  // HY-01: the catalog reports exactly the bound provider, nothing invented.
  const cat = await page.evaluate(() => window.tivano.invoke("hydra:catalog", {}));
  verify(
    "HY-01 catalog lists only the bound provider",
    cat.providers?.length === 1 &&
      cat.providers[0].id === "mock" &&
      cat.providers[0].ready === true &&
      Array.isArray(cat.providers[0].models),
    cat.providers,
  );

  await openSettings(page);

  // HY-02: the section states honestly what isolation does and what is
  // still missing (merge requests, review gating).
  const status = await page.locator('[data-testid="hydra-status"]').textContent();
  verify(
    "HY-02 page states copy+landing, merge/review honestly absent",
    /lands its changes back/.test(status ?? "") && /not wired in this build/.test(status ?? ""),
    status,
  );

  // HY-03: master switch persists to the store.
  await page.locator('.hydra-section button[role="switch"]').first().click();
  verify(
    "HY-03 hydraEnabled false persisted",
    (await waitStore((s) => s.hydraEnabled === false)).hydraEnabled === false,
  );
  await page.locator('.hydra-section button[role="switch"]').first().click();
  verify(
    "HY-03b hydraEnabled restored",
    (await waitStore((s) => s.hydraEnabled === true)).hydraEnabled === true,
  );

  // HY-04: add a pair through the editor; it lands in the store verbatim.
  await page.locator('.hydra-pairs .kv button[title="One per provider is enough."]').click();
  await page.waitForSelector(".hydra-editor", { timeout: 5000 });
  await page.locator('select[aria-label="Heads at once"]').selectOption("8");
  await page.locator(".hydra-editor-actions .choice").first().click(); // Save pair
  const pairStored = (await waitStore((s) => (s.hydraPairs?.length ?? 0) >= 1)).hydraPairs?.[0];
  verify(
    "HY-04 pair saved with bound provider and cap",
    pairStored?.provider === "mock" && pairStored.maxHeads === 8,
    pairStored,
  );
  verify(
    "HY-04b pair shows in the list",
    (await page.locator(".hydra-pair").count()) === 1,
  );

  // HY-05: absent optional fields stay absent — no undefined keys serialized.
  verify(
    "HY-05 optional pair fields omitted, not undefined",
    pairStored !== undefined && !("workerModel" in pairStored) && !("name" in pairStored),
    pairStored,
  );

  // HY-06: an out-of-range cap is refused at the IPC boundary — the wire
  // schema itself enforces the frozen 1..8 range (the engine-side clamp for
  // store loads is covered by unit tests).
  const refusedCap = await page.evaluate(
    (a) =>
      window.tivano
        .invoke("settings:set", {
          hydraPairs: [{ id: a, provider: "mock", maxHeads: 42, headProfiles: [] }],
        })
        .then(() => false)
        .catch(() => true),
    pairStored.id,
  );
  verify("HY-06 out-of-range cap refused at IPC", refusedCap);
  verify(
    "HY-06b refused write left the pair untouched",
    storedSettings().hydraPairs?.[0]?.maxHeads === 8,
  );

  // HY-07: malformed pair payloads are refused at the IPC boundary.
  const refused = await page.evaluate(() =>
    window.tivano
      .invoke("settings:set", { hydraPairs: [{ maxHeads: 4 }] })
      .then(() => false)
      .catch(() => true),
  );
  verify("HY-07 pair without provider refused by IPC validation", refused);

  // HY-07c..f: A76 frozen HydraCookbookPanel — the "Pair presets" popover
  // lists resolvable recipes with Add and waits the rest under "Needs a
  // provider". On this mock build no recipe's provider is ready, so all
  // twelve wait and name the provider to set up — honest, not fabricated.
  await page.locator(".cook-open").click();
  await page.waitForSelector(".cook-pop", { timeout: 5000 });
  const cookText = await page.locator(".cook-pop").innerText();
  verify(
    "HY-07c pair-presets popover opens with the frozen header",
    cookText.includes("Pair presets") &&
      cookText.includes("Add a preset to your model picker."),
    cookText.slice(0, 120),
  );
  const waitCount = await page.locator(".cook-row.cook-waiting").count();
  verify(
    "HY-07d all twelve recipes wait under Needs a provider",
    waitCount === 12 &&
      cookText.includes("Needs a provider") &&
      cookText.includes("Set up Codex to add this pair.") &&
      (await page.locator(".cook-add").count()) === 0,
    { waitCount, add: await page.locator(".cook-add").count() },
  );
  await page.screenshot({ path: join(outDir, "97-pair-presets.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".cook-pop", { state: "detached", timeout: 5000 });
  verify("HY-07e presets popover closes on Escape", true);
  // Reopen → outside click closes too.
  await page.locator(".cook-open").click();
  await page.waitForSelector(".cook-pop", { timeout: 5000 });
  await page.locator(".hydra-pairs-head h4").click();
  await page.waitForSelector(".cook-pop", { state: "detached", timeout: 5000 });
  verify("HY-07f presets popover closes on outside click", true);

  // A83: frozen InfoHoverButton — the three section marks open their
  // explainer on hover and close a beat after the pointer leaves both.
  const marks = page.locator(".hydra-section .info-mark");
  verify(
    "HY-07g three section info marks exist",
    (await marks.count()) === 3,
    { count: await marks.count() },
  );
  await marks.nth(0).hover();
  await page.waitForSelector(".info-pop", { timeout: 5000 });
  const hydraInfo = await page.locator(".info-pop").textContent();
  verify(
    "HY-07h Hydra mark opens its explainer on hover",
    /You ask, the chat leads/.test(hydraInfo ?? "") &&
      /Heads go out in parallel/.test(hydraInfo ?? ""),
    hydraInfo?.slice(0, 120),
  );
  await page.mouse.move(40, 40);
  await page.waitForSelector(".info-pop", { state: "detached", timeout: 5000 });
  verify("HY-07i popover closes after the pointer leaves", true);
  await marks.nth(1).hover();
  await page.waitForSelector(".info-pop", { timeout: 5000 });
  const headsInfo = await page.locator(".info-pop").textContent();
  verify(
    "HY-07j Heads mark explains briefs and checkout copies",
    /One brief, one panel/.test(headsInfo ?? "") &&
      /own copy of the checkout/.test(headsInfo ?? ""),
    headsInfo?.slice(0, 120),
  );
  await page.mouse.move(40, 40);
  await page.waitForSelector(".info-pop", { state: "detached", timeout: 5000 });
  await marks.nth(2).hover();
  await page.waitForSelector(".info-pop", { timeout: 5000 });
  const histInfo = await page.locator(".info-pop").textContent();
  await page.screenshot({ path: `${outDir}/hydra-info-hover.png` });
  verify(
    "HY-07k history mark explains the archive limits",
    /Only newly dispatched heads/.test(histInfo ?? "") &&
      /no permanent deletion/.test(histInfo ?? ""),
    histInfo?.slice(0, 120),
  );
  await page.mouse.move(40, 40);

  await closeSettings(page);

  // HY-08: per-thread defaults seed from hydraDefaultEnabled + lastHydraPairId.
  const pairId = pairStored?.id ?? (storedSettings().hydraPairs?.[0]?.id);
  await page.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraDefaultEnabled: false, lastHydraPairId: pairId },
  );
  const t1 = await newThread(page);
  const s1snap = await snap(page);
  const th1 = s1snap.threads.find((t) => t.id === t1);
  verify(
    "HY-08 new thread inherits hydraDefaultEnabled=false and the last pair",
    th1?.hydraEnabled === false && th1?.hydraPairId === pairId,
    { hydraEnabled: th1?.hydraEnabled, hydraPairId: th1?.hydraPairId, pairId },
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraDefaultEnabled: true, lastHydraPairId: null }),
  );
  const t2 = await newThread(page);
  const th2 = (await snap(page)).threads.find((t) => t.id === t2);
  verify(
    "HY-08b default restored seeds enabled thread without a pair",
    th2?.hydraEnabled === true && th2?.hydraPairId === undefined,
    { hydraEnabled: th2?.hydraEnabled, hydraPairId: th2?.hydraPairId },
  );

  // HY-09: zh rendering — the frozen copy is translated, not left English.
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "zh-Hans" }));
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".hydra-section", { timeout: 10000 });
  const zhTitle = await page.locator(".hydra-section h3").first().textContent();
  const zhNote = await page.locator('[data-testid="hydra-status"]').textContent();
  verify(
    "HY-09 zh locale renders translated copy",
    zhTitle === "Hydra" && /尚|未|尚不/.test(zhNote ?? ""),
    { zhTitle, zhNote },
  );
  await page.evaluate(() => window.tivano.invoke("settings:set", { language: "en" }));
  await page.locator(".modal-actions .primary").click();

  await boundedClose(app, proc);

  // ---- HY-20..: F22 runtime slice — real delegation loop over the mock
  // provider: streamed block → head spawn → batched report → stop path.
  const s2 = await launch("hydra-runtime");
  instances.push(s2);
  const page2 = await s2.app.firstWindow();
  await page2.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  const waitSnap2 = async (predicate, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await snap(page2);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 80));
    }
    return last;
  };
  const teamOf = (snapState, leadId) =>
    snapState.threads
      .filter((t) => t.hydraHead?.leadId === leadId)
      .sort((a, b) => a.hydraHead.spawnedAt - b.hydraHead.spawnedAt);

  const leadId = await newThread(page2);
  // Observe the dot-field lifecycle before the turn starts: the working
  // dots live only while the turn runs and the head-finish sweep ~1.2s,
  // so both are recorded, not raced.
  await page2.evaluate(() => {
    window.__dots = { workSeen: false, sweepSeen: false, sweepTint: null };
    new MutationObserver(() => {
      if (document.querySelector(".composer .work-dots"))
        window.__dots.workSeen = true;
      const el = document.querySelector(".hydra-panel .sweep-dots");
      if (el) {
        window.__dots.sweepSeen = true;
        window.__dots.sweepTint = el.style.getPropertyValue("--sweep-tint");
      }
    }).observe(document.body, { subtree: true, childList: true });
  });
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadId, text: "split it up [mock:hydra]" },
  );
  const sSpawn = await waitSnap2(
    (s) => teamOf(s, leadId).length === 2,
  );
  const team = teamOf(sSpawn, leadId);
  verify(
    "HY-20 delegation block spawns two rostered heads",
    team.map((t) => t.hydraHead.name).join(",") === "Hank,Walter" &&
      team.every((t) => t.hydraHead.task.length > 0),
    team.map((t) => t.hydraHead.name),
  );
  const sidebarText = await page2.locator(".sidebar").textContent();
  verify(
    "HY-21 heads stay out of the sidebar",
    !sidebarText.includes("Draft the outline") &&
      !sidebarText.includes("Verify the numbers"),
    sidebarText.slice(0, 120),
  );
  await page2.waitForSelector(".hydra-panel", { timeout: 10000 });
  const rowCount = await page2.locator(".hydra-panel li").count();
  const panelText = await page2.locator(".hydra-panel").textContent();
  verify(
    "HY-22 lead chat shows the head panel",
    rowCount === 2 && panelText.includes("Hank") && panelText.includes("Walter"),
    { rowCount },
  );
  // HY-22b: while the lead's turn runs the composer carries the frozen
  // working-dots field (accent dot wave along the pill's bottom) —
  // recorded by the pre-send observer.
  const dotsEarly = await page2.evaluate(() => window.__dots.workSeen);
  verify(
    "HY-22b working dots field ran while the turn ran",
    dotsEarly === true,
  );
  // Batch completes → one report turn on the lead.
  const sReport = await waitSnap2(
    (s) =>
      teamOf(s, leadId).every((t) => t.hydraHead.status === "completed") &&
      s.threads
        .find((t) => t.id === leadId)
        ?.messages.some((m) => m.content.includes("Hydra reports:")),
    30000,
  );
  const report = sReport.threads
    .find((t) => t.id === leadId)
    .messages.find((m) => m.content.includes("Hydra reports:"));
  verify(
    "HY-23 batched report names both heads and the shared checkout",
    !!report &&
      report.content.includes("Hank") &&
      report.content.includes("Walter") &&
      report.content.includes("already"),
    report?.content.slice(0, 160),
  );
  const panelDone = await page2.locator(".hydra-panel").textContent();
  verify("HY-24 panel marks heads done", panelDone.includes("Done"), panelDone.slice(0, 120));

  // HY-24b: the head-finish sweep fired in the finishing head's persona
  // tint (Hank leads the roster), and the dots field left the composer
  // once the turn settled.
  const sweepSeen = await page2.evaluate(() => ({
    seen: window.__dots.sweepSeen === true,
    tint: window.__dots.sweepTint,
  }));
  verify(
    "HY-24b head-finish sweep fired with a persona tint",
    sweepSeen.seen && /^#[0-9a-f]{6}$/i.test(sweepSeen.tint ?? ""),
    sweepSeen,
  );
  verify(
    "HY-24c working dots left the composer when the turn settled",
    (await page2.locator(".composer .work-dots").count()) === 0,
  );
  // HY-24d: the sent delegation card carries its one-shot accent sweep
  // element (frozen DotFieldSweep on the outgoing card).
  verify(
    "HY-24d sent delegation card carries its sweep",
    (await page2.locator(".hydra-delegation.sent .sweep-dots").count()) === 1,
    await page2.locator(".hydra-delegation").count(),
  );

  // HY-23b..e: frozen HydraReportRow — the batch rides as a pill; the
  // digest popover carries one card per head (collapsed when >1).
  verify(
    "HY-23b report message carries the heads marker",
    Array.isArray(report.hydraHeads) && report.hydraHeads.length === 2,
    report.hydraHeads,
  );
  await page2.locator(".hydra-report-pill").waitFor({ timeout: 10000 });
  const pillText = await page2.locator(".hydra-report-pill").innerText();
  verify(
    "HY-23c pill summarizes who is done (no raw report text)",
    pillText.includes("Hank") && pillText.includes("Walter") &&
      pillText.includes("done") && !pillText.includes("## "),
    pillText,
  );
  await page2.locator(".hydra-report-pill").click();
  await page2.locator(".hydra-report-pop").waitFor({ timeout: 10000 });
  const popText = await page2.locator(".hydra-report-pop").innerText();
  verify(
    "HY-23d digest lists both heads with their tasks",
    popText.includes("Hank") && popText.includes("Walter"),
    popText.slice(0, 200),
  );
  const collapsedBodies = await page2.locator(".hr-card .hr-body").count();
  const cardCount = await page2.locator(".hr-card").count();
  verify(
    "HY-23e multi-head reports start collapsed to their cards",
    cardCount === 2 && collapsedBodies < cardCount,
    `${collapsedBodies}/${cardCount}`,
  );
  await page2.locator(".hr-card-head").first().click();
  await page2.waitForSelector(".hr-card .hr-body", { timeout: 8000 });
  await page2.screenshot({ path: join(outDir, "hydra-report-digest.png") });
  await page2.locator(".hydra-report-pill").click();

  // HY-25: stop a held head — the report reads stopped, never completed.
  const lead2 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead2, text: "go [mock:hydra-wait]" },
  );
  await waitSnap2(
    (s) =>
      teamOf(s, lead2).length === 1 &&
      s.threads.find((t) => t.hydraHead?.leadId === lead2)?.turn?.status ===
        "waiting-approval",
  );
  await page2.locator(".hydra-stop").click();
  const sStop = await waitSnap2(
    (s) =>
      teamOf(s, lead2)[0]?.hydraHead.status === "stopped" &&
      s.threads
        .find((t) => t.id === lead2)
        ?.messages.some((m) => m.content.includes("stopped by the user")),
  );
  verify(
    "HY-25 stopped head reports as stopped",
    teamOf(sStop, lead2)[0]?.hydraHead.status === "stopped",
    teamOf(sStop, lead2).map((t) => t.hydraHead.status),
  );

  // HY-26b: head rows carry the frozen stave progress bar — one stave
  // per tool call/reply in the head's persona tint (A72).
  const headBars = await page2.locator(".hydra-panel .hydra-row .stave-bar").count();
  const headStaves = await page2
    .locator(".hydra-panel .hydra-row .stave-bar svg rect.stave")
    .count();
  verify(
    "HY-26c head rows draw stave bars",
    headBars >= 1 && headStaves >= 1,
    { headBars, headStaves },
  );
  await page2.screenshot({ path: `${outDir}/hydra-staves.png` });

  // HY-26: head thread view — banner + back-to-lead navigation.
  await page2.locator(".hydra-open").first().click();
  await page2.waitForSelector(".hydra-strip", { timeout: 10000 });
  const stripText = await page2.locator(".hydra-strip").textContent();
  verify(
    "HY-26 head view shows the banner and way back",
    stripText.includes("Hydra head") && stripText.includes("Back to lead"),
    stripText.slice(0, 120),
  );
  await page2.locator(".hydra-back").click();
  const backSnap = await waitSnap2((s) => s.ui?.selectedThreadId === lead2 || s.selectedThreadId === lead2);
  verify(
    "HY-26b back-to-lead selects the lead",
    (backSnap.selectedThreadId ?? backSnap.ui?.selectedThreadId) === lead2,
    backSnap.selectedThreadId,
  );

  // HY-27: zh locale — the panel is translated.
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page2.waitForSelector(".hydra-panel", { timeout: 10000 });
  const zhPanel = await page2.locator(".hydra-panel").textContent();
  verify(
    "HY-27 zh panel localized",
    zhPanel.includes("子智能体"),
    zhPanel.slice(0, 120),
  );
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // HY-28: Hydra off — no heads; the refusal lands in the lead's queue.
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraEnabled: false }),
  );
  const lead3 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead3, text: "go [mock:hydra]" },
  );
  const sRefuse = await waitSnap2(
    (s) =>
      teamOf(s, lead3).length === 0 &&
      s.threads
        .find((t) => t.id === lead3)
        ?.messages.some((m) => m.content.includes("Hydra did not send the head")),
  );
  verify(
    "HY-28 disabled Hydra refuses, never spawns",
    teamOf(sRefuse, lead3).length === 0,
  );
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraEnabled: true }),
  );

  // ---- HY-29..: A58 pair binding — caps pace through hydraWaiting,
  // profiles route, a foreign heads-provider falls back with a note,
  // finished blocks mark hydra-sent, and the policy reaches the wire.

  // HY-29: page cap paces extra delegations through the waiting queue.
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraMaxHeads: 1 }),
  );
  const lead4 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead4, text: "go [mock:hydra-waitmany]" },
  );
  const sCap = await waitSnap2(
    (s) =>
      teamOf(s, lead4).length === 1 &&
      teamOf(s, lead4)[0]?.turn?.status === "waiting-approval",
  );
  verify(
    "HY-29 cap holds the extra delegations queued",
    teamOf(sCap, lead4).length === 1,
    teamOf(sCap, lead4).map((t) => t.hydraHead.status),
  );
  // Stopping the held head drains the queue; all three report in one batch.
  await page2.locator(".hydra-stop").click();
  const sDrain = await waitSnap2(
    (s) =>
      teamOf(s, lead4).length === 3 &&
      teamOf(s, lead4).every((t) => t.hydraHead.status !== "running") &&
      s.threads
        .find((t) => t.id === lead4)
        ?.messages.some((m) => m.content.includes("Part three")),
  );
  verify(
    "HY-29b queued heads drain and batch reports together",
    teamOf(sDrain, lead4).length === 3,
    teamOf(sDrain, lead4).map((t) => t.hydraHead.status),
  );
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", { hydraMaxHeads: null }),
  );

  // HY-30: a pair's own cap applies with no page cap set.
  const pair = {
    id: "pair-e2e-1",
    provider: "mock",
    maxHeads: 1,
    headProfiles: [],
  };
  await page2.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraPairs: [pair], lastHydraPairId: pair.id },
  );
  const lead5 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead5, text: "go [mock:hydra-waitmany]" },
  );
  const sPairCap = await waitSnap2(
    (s) =>
      teamOf(s, lead5).length === 1 &&
      teamOf(s, lead5)[0]?.turn?.status === "waiting-approval",
  );
  verify(
    "HY-30 the pair's own cap paces the queue",
    teamOf(sPairCap, lead5).length === 1,
    teamOf(sPairCap, lead5).length,
  );
  await page2.locator(".hydra-stop").click();
  await waitSnap2((s) => teamOf(s, lead5).length === 3, 25000);

  // HY-31: a routed profile marks the head and seeds its model fields.
  const profiled = {
    id: "pair-e2e-2",
    provider: "mock",
    headProfiles: [
      { id: "hp-1", name: "deep", model: "fixture-deep", effort: "high" },
    ],
  };
  await page2.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraPairs: [profiled], lastHydraPairId: profiled.id },
  );
  const lead6 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead6, text: "go [mock:hydra-profile]" },
  );
  const sProfile = await waitSnap2((s) => teamOf(s, lead6).length === 2);
  const routedHead = teamOf(sProfile, lead6)[0];
  verify(
    "HY-31 a routed head wears its profile + model fields",
    routedHead?.hydraHead?.profile === "deep" &&
      routedHead.title.includes("deep") &&
      routedHead.codexModel === "fixture-deep" &&
      routedHead.codexEffort === "high" &&
      teamOf(sProfile, lead6)[1]?.hydraHead?.profile === undefined,
    {
      profile: routedHead?.hydraHead?.profile,
      title: routedHead?.title,
      model: routedHead?.codexModel,
    },
  );

  // HY-32: a pair sending heads elsewhere keeps them local, noted once.
  const foreign = {
    id: "pair-e2e-3",
    provider: "mock",
    workerProvider: "other-provider",
    workerModel: "foreign-model",
    headProfiles: [],
  };
  await page2.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraPairs: [foreign], lastHydraPairId: foreign.id },
  );
  const lead7 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead7, text: "go [mock:hydra]" },
  );
  const sFallback = await waitSnap2(
    (s) =>
      teamOf(s, lead7).length === 2 &&
      s.threads
        .find((t) => t.id === lead7)
        ?.messages.some((m) =>
          m.content.includes("is not available in this build"),
        ),
  );
  const fallbackMsgs = sFallback.threads
    .find((t) => t.id === lead7)
    .messages.filter((m) => m.content.includes("is not available in this build"));
  verify(
    "HY-32 foreign heads-provider falls back with one honest note",
    fallbackMsgs.length === 1 &&
      fallbackMsgs[0].content.includes("other-provider") &&
      teamOf(sFallback, lead7).every((t) => t.codexModel === undefined),
    fallbackMsgs.length,
  );

  // HY-33: a finished lead turn marks its block hydra-sent.
  await page2.evaluate(() =>
    window.tivano.invoke("settings:set", {
      hydraPairs: [],
      lastHydraPairId: null,
    }),
  );
  const lead8 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead8, text: "go [mock:hydra]" },
  );
  const sSent = await waitSnap2(
    (s) =>
      s.threads.find((t) => t.id === lead8)?.turn?.status === "done",
  );
  const sentMsg = sSent.threads
    .find((t) => t.id === lead8)
    .messages.find((m) => m.role === "assistant");
  verify(
    "HY-33 the finished block is marked hydra-sent",
    sentMsg?.content.includes("```hydra-sent") &&
      !/```hydra[ \t]*\n/.test(sentMsg?.content ?? ""),
    sentMsg?.content.slice(-80),
  );

  // HY-34: the lead policy reaches the wire on a Hydra-on turn — the
  // mock's bounded echo shows the policy's own tail.
  const lead9 = await newThread(page2);
  await page2.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: lead9, text: "plain hello" },
  );
  const sPolicy = await waitSnap2(
    (s) =>
      s.threads.find((t) => t.id === lead9)?.turn?.status === "done",
  );
  const policyReply = sPolicy.threads
    .find((t) => t.id === lead9)
    .messages.find((m) => m.role === "assistant");
  verify(
    "HY-34 the lead policy rides the wire prompt",
    policyReply?.content.includes("settled or fixed yourself"),
    policyReply?.content.slice(0, 120),
  );

  await boundedClose(s2.app, s2.proc);

  // ---- HY-35..41: F22 isolation — own-copy heads + landing ------------
  // A REAL synthetic git repo bound as a user grant (worktreeChecks
  // pattern); the lead is a project thread so the heads get a copyable
  // checkout. Heads carry a slower tick so the copy is observable
  // mid-flight.
  const repoDir = mkdtempSync(join(tmpdir(), "tivano-e2e-hy-"));
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "e2e@example.com"]);
  git(repoDir, ["config", "user.name", "e2e"]);
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "base"]);

  const hyProj = randomUUID();
  const hyDoc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  hyDoc.projects.push({
    id: hyProj,
    name: "hy-proj",
    createdAt: Date.now(),
    expanded: true,
    directory: realpathSync(repoDir),
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(hyDoc));
  const hyGrants = JSON.parse(
    readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
  );
  hyGrants.userGrants[hyProj] = realpathSync(repoDir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(hyGrants));

  const s3 = await launchApp({ TIVANO_MOCK_TICK_MS: "120" }, "hydra-iso");
  instances.push(s3);
  const page3 = await s3.app.firstWindow();
  await page3.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page3.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );
  const waitSnap3 = async (predicate, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await snap(page3);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 80));
    }
    return last;
  };
  const mkLead3 = async () => {
    const t = await page3.evaluate(
      (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
      hyProj,
    );
    return t.id;
  };

  await page3.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraIsolateHeads: true },
  );
  const leadIso = await mkLead3();
  await page3.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadIso, text: "split it [mock:hydra-touch]" },
  );

  // HY-35: while the heads run, each is bound to an app-owned copy and
  // knows the tree it was cut from plus where its work lands.
  const sCopy = await waitSnap3(
    (s) =>
      teamOf(s, leadIso).length === 2 &&
      teamOf(s, leadIso).every(
        (t) =>
          t.worktreeDir &&
          /^[0-9a-f]{40}$/.test(t.hydraHead.baseTree ?? "") &&
          t.hydraHead.landingCheckout,
      ),
  );
  const copyTeam = teamOf(sCopy, leadIso);
  const wtRoot = realpathSync(join(dataRoot, "worktrees")) + sep;
  verify(
    "HY-35 isolated heads hold app-owned copies",
    copyTeam.every(
      (t) =>
        t.worktreeDir.startsWith(wtRoot) &&
        realpathSync(t.hydraHead.landingCheckout) === realpathSync(repoDir),
    ),
    copyTeam.map((t) => t.worktreeDir),
  );

  // Batch lands: files the heads wrote in their copies appear in the
  // real checkout, the report names the landing, copies are released.
  const sLand = await waitSnap3(
    (s) =>
      teamOf(s, leadIso).every(
        (t) =>
          t.hydraHead.status === "completed" &&
          t.hydraHead.landingPending !== true,
      ) &&
      s.threads
        .find((t) => t.id === leadIso)
        ?.messages.some((m) => m.content.includes("Hydra reports:")),
  );
  const landTeam = teamOf(sLand, leadIso);
  verify(
    "HY-36 head work landed in the checkout",
    existsSync(join(repoDir, "hydra-alpha.txt")) &&
      existsSync(join(repoDir, "hydra-beta.txt")) &&
      readFileSync(join(repoDir, "hydra-alpha.txt"), "utf8").includes(
        "hydra-alpha.txt",
      ) &&
      landTeam.every(
        (t) =>
          t.hydraHead.landing &&
          t.hydraHead.landing.files.length >= 1 &&
          t.hydraHead.copyKept !== true,
      ),
    landTeam.map((t) => t.hydraHead.landing),
  );
  const repIso = sLand.threads
    .find((t) => t.id === leadIso)
    .messages.find((m) => m.content.includes("Hydra reports:"));
  verify(
    "HY-37 report names the landing and the files",
    repIso?.content.includes("Landed in your checkout") &&
      repIso?.content.includes("hydra-alpha.txt"),
    repIso?.content.slice(0, 240),
  );
  verify(
    "HY-38 copies released after landing",
    landTeam.every((t) => t.worktreeDir === undefined) &&
      copyTeam.every((t) => !existsSync(t.worktreeDir)),
    copyTeam.map((t) => t.worktreeDir),
  );

  // HY-39: an unsafe landing (checkout mid-merge) keeps the work as a
  // patch — the head's record and the report both say so honestly.
  rmSync(join(repoDir, "hydra-alpha.txt"), { force: true });
  rmSync(join(repoDir, "hydra-beta.txt"), { force: true });
  writeFileSync(
    join(repoDir, ".git", "MERGE_HEAD"),
    git(repoDir, ["rev-parse", "HEAD"]),
  );
  const leadPatch = await mkLead3();
  await page3.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadPatch, text: "again [mock:hydra-touch]" },
  );
  const sPatch = await waitSnap3(
    (s) =>
      teamOf(s, leadPatch).length === 2 &&
      teamOf(s, leadPatch).every(
        (t) =>
          t.hydraHead.status === "completed" &&
          t.hydraHead.landingPending !== true,
      ) &&
      s.threads
        .find((t) => t.id === leadPatch)
        ?.messages.some((m) => m.content.includes("Hydra reports:")),
  );
  const patchTeam = teamOf(sPatch, leadPatch);
  const repPatch = sPatch.threads
    .find((t) => t.id === leadPatch)
    .messages.find((m) => m.content.includes("Hydra reports:"));
  verify(
    "HY-39 blocked landing keeps a patch and reports it",
    patchTeam.every(
      (t) =>
        t.hydraHead.landing?.patchPath &&
        existsSync(t.hydraHead.landing.patchPath),
    ) &&
      !existsSync(join(repoDir, "hydra-alpha.txt")) &&
      repPatch?.content.includes("patch is at"),
    patchTeam.map((t) => t.hydraHead.landing),
  );
  // The panel's landing badge says "patch kept" for these heads.
  await page3.evaluate(
    (a) => window.tivano.invoke("threads:select", a),
    { id: leadPatch },
  );
  await page3.waitForSelector(".hydra-panel .hydra-land", { timeout: 10000 });
  const landBadges = await page3
    .locator(".hydra-panel .hydra-land")
    .allTextContents();
  verify(
    "HY-40 panel exposes the kept-patch state",
    landBadges.some((x) => x.includes("patch kept")),
    landBadges,
  );
  rmSync(join(repoDir, ".git", "MERGE_HEAD"), { force: true });

  // HY-41: isolation off restores the shared-checkout behaviour — no
  // copy fields, the head's writes land directly in the checkout.
  await page3.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraIsolateHeads: false },
  );
  const leadShared = await mkLead3();
  await page3.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadShared, text: "split it [mock:hydra-touch]" },
  );
  const sShared = await waitSnap3(
    (s) =>
      teamOf(s, leadShared).length === 2 &&
      teamOf(s, leadShared).every(
        (t) => t.hydraHead.status === "completed",
      ),
  );
  const sharedTeam = teamOf(sShared, leadShared);
  verify(
    "HY-41 isolation off keeps shared-checkout behaviour",
    sharedTeam.every(
      (t) =>
        t.hydraHead.baseTree === undefined &&
        t.hydraHead.landing === undefined &&
        t.worktreeDir === undefined,
    ) && existsSync(join(repoDir, "hydra-alpha.txt")),
    sharedTeam.map((t) => ({
      base: t.hydraHead.baseTree,
      landing: t.hydraHead.landing,
    })),
  );

  // ---- HY-42..44: F22 head re-steer — a user turn into a finished
  // head runs it again: fresh batch, fresh isolated copy, only the new
  // write lands, and the lead hears a second report. ------------------
  await page3.evaluate(
    (a) => window.tivano.invoke("settings:set", a),
    { hydraIsolateHeads: true },
  );
  const leadSteer = await mkLead3();
  await page3.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: leadSteer, text: "split it [mock:hydra-touch]" },
  );
  const sSteer = await waitSnap3(
    (s) =>
      teamOf(s, leadSteer).length === 2 &&
      teamOf(s, leadSteer).every(
        (t) =>
          t.hydraHead.status === "completed" &&
          t.hydraHead.landingPending !== true,
      ),
  );
  const hankT = teamOf(sSteer, leadSteer)[0];
  const firstBatch = hankT.hydraHead.batchId;

  // Steering from the head chat is just a user turn on the head's
  // thread — the composer calls this same IPC.
  await page3.evaluate(
    (a) => window.tivano.invoke("turns:send", a),
    { threadId: hankT.id, text: "more work [mock:touch hydra-alpha4.txt]" },
  );
  const sSteerRun = await waitSnap3((s) => {
    const h = teamOf(s, leadSteer)[0];
    return (
      h?.hydraHead.status === "completed" &&
      h.hydraHead.landingPending !== true &&
      h.hydraHead.batchId !== firstBatch
    );
  });
  const hankAfter = teamOf(sSteerRun, leadSteer)[0];
  verify(
    "HY-42 steered head re-ran under a fresh batch",
    hankAfter.hydraHead.batchId.startsWith("steer-") &&
      hankAfter.hydraHead.batchId !== firstBatch &&
      hankAfter.hydraHead.status === "completed",
    hankAfter.hydraHead.batchId,
  );

  // The fresh copy captured the post-landing checkout, so only the
  // steer turn's write diffs back — earlier work isn't re-reported.
  verify(
    "HY-43 isolated steer lands only the new write",
    existsSync(join(repoDir, "hydra-alpha4.txt")) &&
      hankAfter.hydraHead.landing?.files.length === 1 &&
      hankAfter.hydraHead.landing.files[0].path === "hydra-alpha4.txt" &&
      hankAfter.worktreeDir === undefined,
    hankAfter.hydraHead.landing,
  );

  const sRep2 = await waitSnap3(
    (s) =>
      s.threads
        .find((t) => t.id === leadSteer)
        ?.messages.filter((m) => m.content.includes("Hydra reports:"))
        .length === 2,
  );
  const reps2 = sRep2.threads
    .find((t) => t.id === leadSteer)
    .messages.filter((m) => m.content.includes("Hydra reports:"));
  verify(
    "HY-44 steer produced a fresh second report",
    reps2.length === 2 && reps2[1].content.includes("hydra-alpha4.txt"),
    reps2.map((m) => m.content.slice(0, 200)),
  );

  // ---- HY-45..50: the Hydra mark — frozen HydraButton. The read-once
  // intro, the idle explainer, the right-click per-chat switch and the
  // heads-panel toggle. ---------------------------------------------
  // A lead with finished heads stays selected — the mark click toggles
  // its panel (frozen runtime.isHydraPanelHidden).
  await page3.locator('.hydra-mark').waitFor({ timeout: 10000 });
  const hasPanel = async () => (await page3.locator(".hydra-panel").count()) > 0;
  verify(
    "HY-45 mark present and the heads panel starts visible",
    (await page3.locator(".hydra-mark").count()) === 1 && (await hasPanel()),
  );
  await page3.locator(".hydra-mark").click();
  await page3.waitForSelector(".hydra-panel", { state: "detached", timeout: 8000 });
  verify("HY-45b mark click hides the heads panel", !(await hasPanel()));
  await page3.locator(".hydra-mark").click();
  await page3.waitForSelector(".hydra-panel", { timeout: 8000 });
  verify("HY-45c mark click shows the panel again", await hasPanel());

  // HY-46: unread → the mark opens the read-once intro; dismissing it
  // persists hasSeenHydraIntro.
  await page3.evaluate(() =>
    window.tivano.invoke("settings:set", { hasSeenHydraIntro: false }),
  );
  await page3.locator(".hydra-mark").click();
  await page3.waitForSelector(".hydra-intro-pop", { timeout: 8000 });
  const introText = await page3.locator(".hydra-intro-pop").innerText();
  verify(
    "HY-46 unread mark opens the intro",
    introText.includes("Meet Hydra") && introText.includes("Pairs"),
    introText.slice(0, 160),
  );
  await page3.screenshot({ path: join(outDir, "hydra-intro.png") });
  await page3.locator(".hi-btn.primary").click();
  verify(
    "HY-46b dismissing the intro marks it seen",
    (await waitStore((s) => s.hasSeenHydraIntro === true)).hasSeenHydraIntro === true,
  );

  // HY-47: seen + no heads → the idle explainer. New thread has no heads.
  const leadMark = await mkLead3();
  await page3.locator(".hydra-mark").click();
  await page3.waitForSelector(".hydra-idle-pop", { timeout: 8000 });
  const idleText = await page3.locator(".hydra-idle-pop").innerText();
  verify(
    "HY-47 idle explainer on a headless lead",
    idleText.includes("Hydra is on") && idleText.includes("No heads are out yet"),
    idleText.slice(0, 160),
  );
  // Outside click dismisses it.
  await page3.locator(".chat-head h1").click();
  await page3.waitForSelector(".hydra-idle-pop", { state: "detached", timeout: 8000 });

  // HY-48: right-click → the per-chat switch; flipping off writes the
  // thread AND the default for new chats (frozen setHydra parity).
  await page3.locator(".hydra-mark").click({ button: "right" });
  await page3.waitForSelector(".hydra-switch-pop", { timeout: 8000 });
  await page3.locator('.hmi-item:has-text("off for this chat")').click();
  await page3.waitForSelector(".hydra-switch-pop", { state: "detached", timeout: 8000 });
  const sFlip = await waitSnap3(
    (s) => s.threads.find((t) => t.id === leadMark)?.hydraEnabled === false,
  );
  verify(
    "HY-48 per-chat off persisted",
    sFlip.threads.find((t) => t.id === leadMark).hydraEnabled === false,
  );
  verify(
    "HY-48b per-chat flip saved to the default",
    (await waitStore((s) => s.hydraDefaultEnabled === false)).hydraDefaultEnabled === false,
  );
  const markedOff = await page3.locator(".hydra-mark.off").count();
  verify("HY-48c mark dims while the chat is off", markedOff === 1);

  // HY-49: flip it back on through the switch; the default follows.
  await page3.locator(".hydra-mark").click({ button: "right" });
  await page3.waitForSelector(".hydra-switch-pop", { timeout: 8000 });
  await page3.locator('.hmi-item:has-text("on for this chat")').click();
  const sOn = await waitSnap3(
    (s) => s.threads.find((t) => t.id === leadMark)?.hydraEnabled === true,
  );
  verify(
    "HY-49 per-chat on persisted",
    sOn.threads.find((t) => t.id === leadMark).hydraEnabled === true &&
      (await waitStore((s) => s.hydraDefaultEnabled === true)).hydraDefaultEnabled === true,
  );

  // HY-50: IPC refuses a non-thread id rather than fabricating a flip.
  const badFlip = await page3.evaluate(() =>
    window.tivano
      .invoke("threads:set-hydra", {
        threadId: "00000000-0000-4000-8000-000000000000",
        enabled: true,
      })
      .then(
        () => "resolved",
        (e) => String(e?.message ?? e),
      ),
  );
  verify(
    "HY-50 unknown thread refused",
    /unknown thread/i.test(badFlip),
    badFlip,
  );
  await page3.screenshot({ path: join(outDir, "hydra-mark.png") });

  // ---- HY-51..53: delegation card + head brief pill (frozen
  // HydraDelegationBlock / HydraBriefRow). -----------------------------
  // leadSteer's finished turn carries a ```hydra-sent block; it must
  // render as the card, never the JSON.
  await page3.evaluate(
    (id) => window.tivano.invoke("threads:select", { id }),
    leadSteer,
  );
  await page3.waitForSelector(".hydra-delegation.sent", { timeout: 10000 });
  const cardText = await page3.locator(".hydra-delegation").first().innerText();
  const cardRows = await page3.locator(".hydra-delegation .hd-row").count();
  verify(
    "HY-51 delegation block renders the summoning card",
    cardText.includes("Summoned") && cardRows === 2 && !cardText.includes("[mock:"),
    cardText.slice(0, 160),
  );
  const cardPersonaDots = await page3.locator(".hydra-delegation .hd-row .hydra-dot").count();
  verify("HY-51b head rows wear persona glyphs", cardPersonaDots >= 2, cardPersonaDots);
  await page3.screenshot({ path: join(outDir, "hydra-delegation.png") });

  // HY-52: the head's incoming brief is a pill, not a raw prompt bubble.
  const hankId = teamOf(await snap(page3), leadSteer)[0].id;
  await page3.evaluate((id) => window.tivano.invoke("threads:select", { id }), hankId);
  await page3.waitForSelector(".hydra-brief-pill", { timeout: 10000 });
  const pillTitle = await page3.locator(".hydra-brief-pill").first().innerText();
  verify(
    "HY-52 head thread renders the brief as a pill",
    /brief|cook/.test(pillTitle) && !pillTitle.includes("[Tivano"),
    pillTitle.slice(0, 120),
  );

  // HY-53: the pill opens the brief popover — header + markdown body.
  await page3.locator(".hydra-brief-pill").first().click();
  await page3.waitForSelector(".hydra-brief-pop", { timeout: 8000 });
  const briefPop = await page3.locator(".hydra-brief-pop").innerText();
  verify(
    "HY-53 brief popover shows header + brief",
    briefPop.includes("Brief") && briefPop.includes("Hank") &&
      briefPop.includes("Write alpha") && briefPop.includes("Hydra head"),
    briefPop.slice(0, 200),
  );
  await page3.screenshot({ path: join(outDir, "hydra-brief.png") });
  await page3.locator(".chat-head h1").click();
  await page3.waitForSelector(".hydra-brief-pop", { state: "detached", timeout: 8000 });

  await boundedClose(s3.app, s3.proc);
}
