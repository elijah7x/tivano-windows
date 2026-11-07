// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A66 e2e — F13 detection slice (frozen GitHubSettingsSection): the
// Forge CLIs settings section shows which CLIs merge/PR handoffs could
// run — presence + --version only, sign-in never probed, credentials
// never touched. The probe itself is real; the stub `gh` binary is a
// synthetic fixture and is labelled as such in its version output.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function runForgeChecks({
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

  // A stub `gh` on PATH — the probe is real; the binary is synthetic.
  const stubDir = mkdtempSync(join(tmpdir(), "tivano-forge-stub-"));
  writeFileSync(
    join(stubDir, "gh"),
    '#!/bin/sh\necho "gh version 0.0.0-synthetic (fixture)"\n',
  );
  chmodSync(join(stubDir, "gh"), 0o755);
  writeFileSync(join(stubDir, "glab"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stubDir, "glab"), 0o755);
  writeFileSync(
    join(stubDir, "origin"),
    '#!/bin/sh\necho "origin version 0.0.0-synthetic (fixture)"\n',
  );
  chmodSync(join(stubDir, "origin"), 0o755);

  const openLog = join(outDir, "external-opens.jsonl");
  const s1 = await launch(
    {
      PATH: `${stubDir}:${process.env.PATH}`,
      TIVANO_TEST_EXTERNAL_OPEN: openLog,
    },
    "forge-main",
  );
  instances.push(s1);
  const { app, proc } = s1;
  const page = await app.firstWindow();
  await page.waitForSelector(".sidebar-head", { timeout: 15000 });
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // FG-01: the IPC itself returns one row per CLI — real probe.
  const rows = await page.evaluate(() =>
    window.tivano.invoke("forge:probe", {}),
  );
  const gh = rows.find((r) => r.id === "gh");
  const glab = rows.find((r) => r.id === "glab");
  const tea = rows.find((r) => r.id === "tea");
  const origin = rows.find((r) => r.id === "origin");
  verify(
    "FG-01 probe reports stub gh/origin + honest glab/tea states",
    gh?.found === true &&
      gh?.version === "gh version 0.0.0-synthetic (fixture)" &&
      glab?.found === true && // ran but exited 1 — present, no version
      glab?.version === undefined &&
      tea?.found === false &&
      origin?.found === true &&
      origin?.version === "origin version 0.0.0-synthetic (fixture)" &&
      origin?.forge === "origin",
    rows,
  );

  // FG-02: the settings section renders the same truth.
  await page.locator(".sidebar-foot button.row").click();
  await page.waitForSelector(".modal", { timeout: 8000 });
  await page.locator(".forge-section").scrollIntoViewIfNeeded();
  await page.waitForSelector(".forge-row", { timeout: 8000 });
  const ghText = await page
    .locator(".forge-row[data-cli='gh']")
    .innerText();
  const teaText = await page
    .locator(".forge-row[data-cli='tea']")
    .innerText();
  verify(
    "FG-02 section shows found gh + missing tea",
    ghText.includes("gh version 0.0.0-synthetic") &&
      teaText.includes("not found on PATH"),
    { ghText, teaText },
  );

  await page.screenshot({ path: join(outDir, "96-forge-clis.png") });

  // FG-03: the frozen PR note + the honest-credential note are visible —
  // no auth/token probe ever runs.
  const notes = await page
    .locator(".forge-section .codex-note")
    .allInnerTexts();
  verify(
    "FG-03 PR-CLI note + sign-in-never-probed note",
    notes.some((n) =>
      n.includes("Cursor Origin CLI (origin)"),
    ) &&
      notes.some(
        (n) =>
          n.includes("Sign-in is never probed") && n.includes("credentials"),
      ),
    notes.map((n) => n.slice(0, 80)),
  );

  // FG-04: Re-check re-probes live.
  await page.locator(".forge-refresh").click();
  await page.waitForSelector(".forge-row[data-cli='gh']", { timeout: 8000 });
  verify("FG-04 re-check repopulates rows", true);

  // FG-05: zh-Hans labels.
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "zh-Hans" }),
  );
  await page.locator(".forge-refresh").click();
  const teaZh = await page
    .locator(".forge-row[data-cli='tea']")
    .innerText();
  verify(
    "FG-05 zh-Hans forge rows",
    teaZh.includes("未在 PATH 中找到"),
    teaZh,
  );
  await page.evaluate(() =>
    window.tivano.invoke("settings:set", { language: "en" }),
  );

  // FG-06/07: the frozen "Worktrees · Reveal" row — the shown path is
  // the app-owned <dataRoot>/worktrees (main-computed), and Reveal
  // rides the main-owned shell.openPath end-to-end (a real open on the
  // isolated data root, matching FOLDER-04/DL-07 precedent).
  const wtRow = page.locator(".forge-row[data-cli='worktrees']");
  const wtText = await wtRow.innerText();
  const info = (await snap(page)).info;
  verify(
    "FG-06 worktrees row shows the app-owned root",
    wtText.includes("Worktrees") &&
      wtText.includes(info.worktreesDir) &&
      info.worktreesDir.endsWith("/worktrees"),
    wtText,
  );
  const revealed = await page.evaluate(() =>
    window.tivano.invoke("worktrees:reveal", {}),
  );
  verify(
    "FG-07 reveal opens the real directory",
    revealed.path === info.worktreesDir &&
      existsSync(openLog) &&
      readFileSync(openLog, "utf8")
        .includes(`"action":"openPath","target":${JSON.stringify(info.worktreesDir)}`),
    { revealed, log: existsSync(openLog) ? readFileSync(openLog, "utf8") : null },
  );

  await boundedClose(app, proc);
}
