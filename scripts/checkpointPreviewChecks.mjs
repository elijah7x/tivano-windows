// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Checkpoint-turn e2e checks (P2L): a REAL temporary Git repository is
// bound as a user grant, the offline Codex fixture ACTUALLY modifies it
// ("ckptfile" writes fixture-checkpoint.txt + appends tracked.txt), the
// engine's before/end capture lands a durable complete record, and the
// non-mutating preview classifies restore/keep honestly — including
// post-end staging, partial staging and preview-time drift. Restarting
// on the same data root reloads the SAME ledger. Nothing is ever written
// back by the app; only the driver mutates the synthetic repo.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export async function runCheckpointChecks({
  launch,
  instances,
  snap,
  dataRoot,
  workspaceRoot,
  codexFixture,
  outDir,
  check,
  boundedClose,
}) {
  const verify = (name, ok, detail) => {
    check(name, ok, detail === undefined ? "" : JSON.stringify(detail));
    if (!ok) throw new Error(name);
  };

  // --- fresh synthetic repo bound as a USER grant -------------------------
  const repoDir = mkdtempSync(join(tmpdir(), "tivano-e2e-ckpt-"));
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "e2e@example.com"]);
  git(repoDir, ["config", "user.name", "e2e"]);
  writeFileSync(join(repoDir, "tracked.txt"), "base line\n");
  writeFileSync(join(repoDir, "other.txt"), "sibling\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "base"]);
  const headBefore = readFileSync(join(repoDir, ".git", "HEAD"), "utf8");
  const indexBefore = readFileSync(join(repoDir, ".git", "index"));

  const projId = randomUUID();
  const doc = JSON.parse(readFileSync(join(dataRoot, "store.json"), "utf8"));
  doc.projects.push({
    id: projId,
    name: "ckpt-proj",
    createdAt: Date.now(),
    expanded: true,
    directory: realpathSync(repoDir),
  });
  writeFileSync(join(dataRoot, "store.json"), JSON.stringify(doc));
  const gdoc = JSON.parse(
    readFileSync(join(dataRoot, "workspace-grants.json"), "utf8"),
  );
  gdoc.userGrants[projId] = realpathSync(repoDir);
  writeFileSync(join(dataRoot, "workspace-grants.json"), JSON.stringify(gdoc));

  const env = {
    TIVANO_PROVIDER: "codex",
    TIVANO_CODEX_FIXTURE: codexFixture,
    TIVANO_CODEX_NODE: process.execPath,
    TIVANO_WORKSPACE_ROOT: workspaceRoot,
  };

  // --- session A: fixture really mutates the repo --------------------------
  const sA = await launch(env, "s-ckpt-a");
  instances.push(sA);
  let { app, proc, ledger } = sA;
  let page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  const threadId = await page.evaluate(
    (pid) => window.tivano.invoke("threads:create", { projectId: pid }),
    projId,
  );
  const turn = await page.evaluate(
    (tid) =>
      window.tivano.invoke("turns:send", { threadId: tid, text: "ckptfile please" }),
    threadId.id,
  );
  verify(
    "ckptfile turn was created (async provider start under before-capture)",
    typeof turn.id === "string" && turn.status === "running",
    turn.status,
  );

  // Turn completes, then the after-capture lands the pair.
  const waitTurn = async (want) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const s = await snap(page);
      const t = s.threads.find((x) => x.id === threadId.id)?.turn;
      if (t === null || t === undefined) {
        const msgs = s.threads.find((x) => x.id === threadId.id)?.messages ?? [];
        const done = msgs.find((m) => m.turnId === turn.id && m.status === want);
        if (done) return;
      } else if (t.status === want) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error(`turn did not reach ${want}`);
  };
  await waitTurn("done");

  const waitLedger = async (threadId, want) => {
    const end = Date.now() + 25000;
    let last = [];
    while (Date.now() < end) {
      last = await page.evaluate(
        (tid) => window.tivano.invoke("checkpoints:list", { threadId: tid }),
        threadId,
      );
      const rec = last.find((r) => r.turnId === turn.id);
      if (rec?.status === want) return rec;
      if (rec && (rec.status === "unavailable" || rec.status === "invalidated"))
        return rec;
      await new Promise((r) => setTimeout(r, 100));
    }
    return last.find((r) => r.turnId === turn.id) ?? null;
  };

  const rec = await waitLedger(threadId.id, "complete");
  verify(
    "durable complete checkpoint record for the turn",
    rec !== null && rec.status === "complete",
    rec ? `${rec.status}:${rec.reason ?? ""}` : "missing",
  );
  verify(
    "trusted structured attribution lists exactly the fixture paths",
    rec.touchedPaths.includes("fixture-checkpoint.txt") &&
      rec.touchedPaths.includes("tracked.txt") &&
      !rec.touchedPaths.some((p) => p.includes("..") || p.startsWith("/")),
    rec.touchedPaths,
  );
  verify(
    "fixture really wrote inside the synthetic repo",
    existsSync(join(repoDir, "fixture-checkpoint.txt")) &&
      readFileSync(join(repoDir, "tracked.txt"), "utf8").includes("checkpoint line"),
  );
  verify(
    "app never touched HEAD or index during capture",
    readFileSync(join(repoDir, ".git", "HEAD"), "utf8") === headBefore &&
      readFileSync(join(repoDir, ".git", "index")).equals(indexBefore),
  );
  // The turn's end-state bytes — needed again after the restore rewinds
  // the worktree so the staging checks still exercise index-vs-end diffs.
  const endContent = readFileSync(join(repoDir, "tracked.txt"), "utf8");

  // --- preview: honest per-path analysis -----------------------------------
  const preview = () =>
    page.evaluate(
      (a) => window.tivano.invoke("checkpoints:preview", a),
      { threadId: threadId.id, turnId: turn.id },
    );
  let pv = await preview();
  const entry = (p) => pv.entries.find((e) => e.path === p) ?? null;
  verify(
    "preview is a ready non-mutating analysis",
    pv.kind === "ready",
    `${pv.kind}:${pv.reason ?? ""}`,
  );
  verify(
    "modified tracked file proposes restore (base differs, state intact)",
    entry("tracked.txt")?.action === "restore",
    entry("tracked.txt"),
  );
  verify(
    "created file is kept — base omission is unknown, not absence",
    entry("fixture-checkpoint.txt")?.action === "keep" &&
      entry("fixture-checkpoint.txt")?.reason === "base-unknown",
    entry("fixture-checkpoint.txt"),
  );

  // --- UI: preview dialog is read-only; in-place restore is DISABLED --
  // A17 security deviation: the apply path was check-then-write and no
  // re-hash can exclude the overwrite/delete race, so every restore is
  // refused at the service entry. The dialog must show the analysis and
  // the honest unavailability note — and offer no restore control.
  await page.evaluate(
    (tid) => window.tivano.invoke("threads:select", { id: tid }),
    threadId.id,
  );
  await page.locator(".ckpt-card.s-complete").waitFor({ timeout: 10000 });
  await page.locator(".ckpt-preview-btn").click();
  await page.locator(".ckpt-preview").waitFor({ timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelector(".ckpt-preview .ckpt-entry") !== null,
    null,
    { timeout: 15000 },
  );
  const dialogText = await page.locator(".ckpt-preview").innerText();
  verify(
    "preview dialog is honest about read-only state",
    dialogText.includes("NO FILES HAVE BEEN CHANGED") &&
      dialogText.includes("tracked.txt") &&
      dialogText.includes("Would restore") &&
      dialogText.includes("Kept unchanged") &&
      dialogText.includes("In-place restore is temporarily unavailable"),
    dialogText.slice(0, 160),
  );
  verify(
    "no restore control is offered",
    (await page.locator(".ckpt-restore-btn").count()) === 0,
  );
  // Per-turn diff (F10): read-only base→end blob comparison, per entry.
  const entryRow = page.locator(".ckpt-entry", { hasText: "tracked.txt" });
  await entryRow.locator(".ckpt-diff-btn").click();
  await page.waitForFunction(
    () => document.querySelector(".ckpt-diff-wrap .git-patch") !== null,
    null,
    { timeout: 15000 },
  );
  const patchText = await page.locator(".ckpt-diff-wrap .git-patch").innerText();
  verify(
    "entry diff shows the recorded base→end change",
    patchText.includes("a/tracked.txt") &&
      patchText.includes("b/tracked.txt") &&
      patchText.includes("+checkpoint line"),
    patchText.slice(0, 200),
  );
  // The same diff over IPC — and an untouched path is refused honestly.
  const diffIpc = await page.evaluate(
    (a) => window.tivano.invoke("checkpoints:diff", a),
    { threadId: threadId.id, turnId: turn.id, path: "tracked.txt" },
  );
  verify(
    "checkpoints:diff returns a text patch",
    diffIpc.kind === "text" && diffIpc.patch.includes("+checkpoint line"),
    diffIpc.kind,
  );
  const diffOutside = await page.evaluate(
    (a) => window.tivano.invoke("checkpoints:diff", a),
    { threadId: threadId.id, turnId: turn.id, path: ".git/HEAD" },
  );
  verify(
    "checkpoints:diff refuses paths outside the touched set",
    diffOutside.kind === "unavailable",
    diffOutside,
  );
  // No UI path may bypass it — the IPC itself is also refused.
  const refused = await page.evaluate(
    (a) => window.tivano.invoke("checkpoints:restore", a),
    { threadId: threadId.id, turnId: turn.id },
  );
  verify(
    "checkpoints:restore is refused at the service entry",
    refused.kind === "unavailable" && refused.reason === "in-place-restore-disabled",
    refused,
  );
  verify(
    "refused restore wrote nothing — tracked file keeps current bytes",
    readFileSync(join(repoDir, "tracked.txt"), "utf8") === endContent,
    readFileSync(join(repoDir, "tracked.txt"), "utf8"),
  );
  verify(
    "refused restore deleted nothing",
    existsSync(join(repoDir, "fixture-checkpoint.txt")) &&
      readFileSync(join(repoDir, "fixture-checkpoint.txt"), "utf8").length > 0,
  );
  verify(
    "refused restore touched neither HEAD nor index",
    readFileSync(join(repoDir, ".git", "HEAD"), "utf8") === headBefore &&
      readFileSync(join(repoDir, ".git", "index")).equals(indexBefore),
  );
  await page.screenshot({ path: join(outDir, "40-checkpoint-restore-en.png") });
  await page.locator(".ckpt-preview .modal-actions button").last().click();

  // Staging after end must flip the tracked file to preserve(index-changed).
  // The worktree still holds the end bytes (nothing was restored), so
  // staging now leaves only the index differing.
  writeFileSync(join(repoDir, "tracked.txt"), endContent);
  git(repoDir, ["add", "tracked.txt"]);
  pv = await preview();
  verify(
    "staging after end → preserve with index-changed",
    entry("tracked.txt")?.action === "keep" &&
      entry("tracked.txt")?.reason === "index-changed",
    entry("tracked.txt"),
  );
  // Partial staging: stage ONLY the created file's sibling state — the
  // created file still keeps base-unknown while index evidence moves.
  git(repoDir, ["add", "fixture-checkpoint.txt"]);
  pv = await preview();
  verify(
    "partial staging preserves both paths honestly",
    entry("fixture-checkpoint.txt")?.action === "keep" &&
      entry("tracked.txt")?.action === "keep",
    pv.entries,
  );
  // Unstage, then mutate the worktree — preview-time drift → preserve.
  git(repoDir, ["reset"]);
  writeFileSync(
    join(repoDir, "tracked.txt"),
    readFileSync(join(repoDir, "tracked.txt"), "utf8") + "post-preview edit\n",
  );
  writeFileSync(join(repoDir, "fixture-checkpoint.txt"), "driver rewrite\n");
  pv = await preview();
  verify(
    "worktree drift after end → preserve with worktree-changed",
    entry("tracked.txt")?.action === "keep" &&
      entry("fixture-checkpoint.txt")?.action === "keep",
    pv.entries,
  );
  // Foreign identity can never select this record — a well-formed but
  // unowned turn id resolves to an honest unavailable, not the record.
  const foreign = await page.evaluate(
    (a) => window.tivano.invoke("checkpoints:preview", a),
    { threadId: threadId.id, turnId: randomUUID() },
  );
  verify(
    "foreign turn id cannot preview another record",
    foreign.kind === "unavailable",
    foreign.kind,
  );

  // --- UI evidence: per-turn card + preview dialog --------------------------
  await page.evaluate(
    (tid) => window.tivano.invoke("threads:select", { id: tid }),
    threadId.id,
  );
  await page.locator(".ckpt-card.s-complete").waitFor({ timeout: 10000 });
  await page.locator(".ckpt-preview-btn").click();
  await page.locator(".ckpt-preview").waitFor({ timeout: 10000 });
  // The modal mounts in a loading state — wait for resolved content.
  await page.waitForFunction(
    () =>
      document.querySelector(".ckpt-preview .ckpt-entry") !== null ||
      document.querySelector(".ckpt-preview .ckpt-note")?.textContent?.includes("unavailable"),
    null,
    { timeout: 15000 },
  );
  const dialogText2 = await page.locator(".ckpt-preview").innerText();
  const restoreBtnCount = await page.locator(".ckpt-restore-btn").count();
  verify(
    "post-drift preview offers NO restore control",
    dialogText2.includes("NO FILES HAVE BEEN CHANGED") &&
      dialogText2.includes("tracked.txt") &&
      dialogText2.includes("Kept unchanged") &&
      restoreBtnCount === 0,
    dialogText2.slice(0, 120),
  );
  await page.screenshot({ path: join(outDir, "40-checkpoint-preview-en.png") });
  await page.locator(".ckpt-preview .modal-actions button").last().click();

  // --- restart: same data root reloads the same ledger ----------------------
  const aClose = await boundedClose(app, proc);
  ledger.exited = aClose.exited;
  ledger.outcome = aClose.outcome;
  verify(
    "checkpoint instance closed cleanly",
    aClose.outcome === "resolved" && aClose.exited && aClose.exitCode === 0,
    `outcome=${aClose.outcome}`,
  );

  const sB = await launch(env, "s-ckpt-b-restart");
  instances.push(sB);
  ({ app, proc, ledger } = sB);
  page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  const again = await page.evaluate(
    (tid) => window.tivano.invoke("checkpoints:list", { threadId: tid }),
    threadId.id,
  );
  const rec2 = again.find((r) => r.turnId === turn.id);
  verify(
    "restart reloads the SAME complete ledger record",
    rec2 !== undefined &&
      rec2.recordId === rec.recordId &&
      rec2.status === "complete" &&
      rec2.touchedPaths.join() === rec.touchedPaths.join(),
    rec2?.status,
  );
  pv = await preview();
  verify(
    "preview still works after restart (persisted manifests)",
    pv.kind === "ready" && pv.entries.length === 2,
    `${pv.kind}:${pv.reason ?? ""}`,
  );

  // --- whole-thread changes tab (frozen ThreadChangesTab) ---------------
  // Scope: first base → latest end over the union of touched paths, from
  // stored blobs only — restart must not lose it and worktree drift must
  // not affect it.
  const changes = await page.evaluate(
    (tid) => window.tivano.invoke("checkpoints:changes", { threadId: tid }),
    threadId.id,
  );
  verify(
    "checkpoints:changes lists the fixture paths with counted +/-",
    changes !== null &&
      changes.files.length === 2 &&
      changes.files.some((f) => f.path === "tracked.txt" && f.additions >= 1) &&
      // Created file: base manifest omission stays UNKNOWN (R1-A) — the
      // path lists with its honest reason, not fabricated counts.
      changes.files.some(
        (f) => f.path === "fixture-checkpoint.txt" && f.reason === "base-unknown",
      ) &&
      changes.additions >= 1,
    changes,
  );
  const chDiff = await page.evaluate(
    (a) => window.tivano.invoke("checkpoints:changes-diff", a),
    { threadId: threadId.id, path: "tracked.txt" },
  );
  verify(
    "checkpoints:changes-diff returns the whole-thread patch",
    chDiff.kind === "text" && chDiff.patch.includes("+checkpoint line"),
    chDiff.kind,
  );
  const chOutside = await page.evaluate(
    (a) => window.tivano.invoke("checkpoints:changes-diff", a),
    { threadId: threadId.id, path: ".git/HEAD" },
  );
  verify(
    "checkpoints:changes-diff refuses paths outside the touched set",
    chOutside.kind === "unavailable",
    chOutside,
  );
  const chForeign = await page
    .evaluate(
      (a) => window.tivano.invoke("checkpoints:changes", { threadId: a }),
      randomUUID(),
    )
    .then(() => "resolved")
    .catch((e) => `rejected:${e.message ?? e}`);
  verify(
    "foreign thread id cannot read another scope",
    typeof chForeign === "string" && chForeign.startsWith("rejected:"),
    chForeign,
  );

  await page.evaluate(
    (tid) => window.tivano.invoke("threads:select", { id: tid }),
    threadId.id,
  );
  await page.locator(".thread-changes-tab").waitFor({ timeout: 10000 });
  const tabText = await page.locator(".thread-changes-tab").innerText();
  verify(
    "changes tab shows file count and +/- totals",
    tabText.includes("2") && tabText.includes("+") && tabText.includes("−"),
    tabText,
  );
  await page.locator(".thread-changes-tab").click();
  await page.locator(".thread-changes-pop").waitFor({ timeout: 10000 });
  const popText = await page.locator(".thread-changes-pop").innerText();
  verify(
    "changes popover lists both touched files",
    popText.includes("tracked.txt") && popText.includes("fixture-checkpoint.txt"),
    popText.slice(0, 160),
  );
  await page
    .locator(".tc-file-row", { hasText: "tracked.txt" })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".thread-changes-pop .git-patch") !== null,
    null,
    { timeout: 15000 },
  );
  const tcPatch = await page.locator(".thread-changes-pop .git-patch").innerText();
  verify(
    "inline whole-thread diff shows the recorded change",
    tcPatch.includes("+checkpoint line"),
    tcPatch.slice(0, 160),
  );
  await page.screenshot({ path: join(outDir, "40-thread-changes-en.png") });
  await page.locator(".thread-changes-tab").click();

  const bClose = await boundedClose(app, proc);
  ledger.exited = bClose.exited;
  ledger.outcome = bClose.outcome;
  verify(
    "restart instance closed cleanly",
    bClose.outcome === "resolved" && bClose.exited && bClose.exitCode === 0,
    `outcome=${bClose.outcome}`,
  );

  // Scratch must not leak past dispose (cap-* dirs are session-owned).
  const scratchLeft = existsSync(join(dataRoot, "checkpoints", "tmp"))
    ? readdirSync(join(dataRoot, "checkpoints", "tmp")).filter((d) => d.startsWith("cap-"))
    : [];
  verify("no checkpoint scratch leaked past close", scratchLeft.length === 0, scratchLeft);

  rmSync(repoDir, { recursive: true, force: true });
}
