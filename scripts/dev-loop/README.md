# Automated development loop

A Windows 11 test machine runs `elijah7x/tivano-windows`'s `nyx-auto` issue backlog unattended in a single long-running Devin Desktop chat (**Autopilot**, following `scripts/dev-loop/autopilot.md` or `scripts/dev-loop/solo-v3.md`), watched and kept up to date by `Start-DevinAutopilot.ps1`.

Everything produced by the loop is **agent self-tested**, not maintainer acceptance. It never approves or requests changes, never touches pull requests outside its own `nyx/` branches, and never force-pushes.

## Autonomous policy (no human waits)

The owner does **not** participate during development, review, or audit, and enters only when a packaged build is ready for hands-on testing:

- **No human pauses or escalations:** the loop never stops to ask questions, wait for confirmation, consult a person, or wait on manual audit overrides. Only creating `<Root>\state\STOP` stops it.
- **Automatic arbitration & non-blocking audit waits:** `nyx/audit` disputes are arbitrated automatically by the independent auditor (which never asks a person to intervene). While a PR's `nyx/audit` status is `pending` or `arbitration pending`, autopilot records it in `progress.json` (`awaitingAudit`) and works on another issue instead of idling.
- **Daily merge cap auto-resume:** when the cap of 40 merges per local calendar day is reached, autopilot sleeps in 5-minute intervals (checking `STOP`) until the next local calendar day and resumes automatically.
- **Queue priority:** open eligible `nyx-auto` issues (skipping permanently `parked` ones) are worked in strict order:
  1. `audit-followup` issues (and `build-break` issues opened by the milestone), lowest number first;
  2. reopened issues (`state_reason == "reopened"`), lowest number first;
  3. remaining parity issues.

## Model roles

| Role | Model | Responsibility |
| --- | --- | --- |
| Implementer (Devin lane) | Devin (SWE) | Claims `nyx-auto` issues with `lane-devin` (skipping `lane-hydrogen` issues and `nyx/h-` PRs), implements issues on `nyx/<n>-<slug>`, runs `npm run verify`, makes the first fix commit on gate or `nyx/audit` failure, reviews/commits/pushes Neon fixes, and manages its own PRs (never runs `gh pr merge`; the watchdog is the only merger). |
| Implementer (Hydrogen lane) | Gemini 4 Hydrogen (`agy`) | Runs in parallel via `Start-HydrogenWorker.ps1` and `hydrogen.md`, claims non-`audit-followup` `nyx-auto` issues from the highest issue number down with `lane-hydrogen`, and uses `nyx/h-<n>-<slug>` branches (never runs `gh pr merge`; the watchdog is the only merger). |
| Quality gate: auditor & second reviewer | GLM-5.4 | Runs the independent `nyx/audit` checks and serves as the read-only second reviewer inside `Invoke-AutopilotGate.ps1`. Never edits code or fixes. |
| Quality gate: escalation fixer | Gemini 4 Neon (`agy`) | Fixes escalations via `Invoke-NeonFix.ps1` inside the PR worktree when an audit block survives Devin's fix round, when the gate fails after Devin's first fix round, or at the start of a parked-issue revisit. Never commits or pushes. |
| Final arbiter | Claude Opus | Settles post-rebuttal `nyx/audit` disputes inside the independent auditor. |

Both implementers run `Invoke-PrePrSelfCheck.ps1` (the trusted copy under `C:\tivano\audit\tool`) before every push: it checks conflicts with `origin/main`, guarded paths, dependency changes, parity status, missing zh-Hans strings, license headers, attribution, `Closes #<n>` and stray files, and with `-RunChecks` runs typecheck and the changed test files. It never changes the worktree; exit 0 means no `FAIL`, 1 means at least one `FAIL`, 2 means bad parameters.

The watchdog remains the only merger. Implementers are Devin (SWE) and Gemini 4 Hydrogen; quality gates are GLM-5.4 and Gemini 4 Neon; Claude Opus is the final arbiter for `nyx/audit` disputes.

## Hydrogen lane

A second implementer lane powered by **Gemini 4 Hydrogen** via the Antigravity CLI (`Start-HydrogenWorker.ps1`, prompt `hydrogen.md`, scheduled task `\TivanoDevLoop\hydrogen` registered by `Register-HydrogenTask.ps1`) works `nyx-auto` issues in parallel with Devin:

- **Lane contract:** Hydrogen claims issues with label `lane-hydrogen`, works from the highest issue number down, and never takes `audit-followup` issues. Devin claims issues with `lane-devin` when starting them and skips `lane-hydrogen` issues and `nyx/h-` PRs.
- **Branches and per-lane WIP cap:** Hydrogen uses `nyx/h-<issue>-<slug>` branches while Devin uses `nyx/<issue>-<slug>`. Devin's 3-PR hard WIP cap counts only Devin's own open non-parked `nyx/` PRs (branches not starting with `nyx/h-`), and Devin never works, fixes, or gates `nyx/h-` PRs.
- **Merging:** the watchdog remains the only merger once both the gate and `nyx/audit` pass on the exact head SHA.

## Parking and revisits

Stuck work never blocks the queue or waits for a person:

1. **Park and move on:** if the independent auditor's newest comment is `## Nyx audit - <sha7> - PARKED` for the PR's current head (the `audit-parked` label alone can be stale and is removed before each new push), or an issue still fails its own gate or `nyx/audit` after Devin's first fix round and up to 2 Gemini 4 Neon fix runs on that head lineage (or Neon returns `no-change`/`unavailable` with no valid rebuttal, or the gate stays unavailable), autopilot leaves the PR open, records `{issue, pr, reason, attempt}` in `<Root>\autopilot\parked.json`, and moves on to the next issue.
2. **Revisit at most twice:** once no unparked open `nyx-auto` issues (or in-flight `awaitingAudit` PRs) remain, autopilot revisits each parked issue up to two times. On each revisit it closes the old PR with a one-line comment, starts a fresh branch (`nyx/<n>-<slug>-r<k>`) from current `origin/main`, runs `Invoke-NeonFix.ps1` first with the `PARKED` audit comment as failures (falling back to Devin's own implementation attempt if Neon returns `no-change` or `unavailable`), and opens a new PR.
3. **Permanent park:** if the second revisit attempt also fails (or an issue cannot be implemented without modifying a guarded path or `package.json` dependencies), autopilot labels the issue `parked`, leaves the open PR open, records the one-line reason in `parked.json`, and skips the issue for good.

## Hands-on testing milestone and continuous polling

Once no open `nyx-auto` issue remains outside permanently `parked` ones (and `origin/main` has commits newer than the last hands-on build):

1. **Verify `main`:** in a clean detached worktree of `origin/main`, autopilot runs `npm run build`, `npm run typecheck`, and `npm test` (pre-existing documented baseline unit failures are allowed).
2. **Package and smoke-test:** autopilot runs `npm run package:windows -- --output <fresh external dir>` followed by `npm run smoke:packaged -- --exe <unpacked exe> --evidence <fresh external dir>` (under `<Root>\autopilot\builds\<tag>\`, never inside the worktree) and stops leftover processes afterward.
3. **Fix breakage via normal PRs:** if build, typecheck, unit tests, packaging, or packaged smoke fails, autopilot opens an issue labelled `nyx-auto` and `build-break`, works it through the normal branch -> verify -> PR -> gate -> `nyx/audit` -> merge flow, and re-runs the milestone.
4. **Publish prerelease and hands-on issue:** once `smoke:packaged` passes, autopilot uploads the unsigned per-user NSIS installer (`Tivano-Windows-Dev-<version>-x64-setup.exe`) as a GitHub Release asset via `gh release create v<version>-nyx.<n> <installer> --prerelease`, and opens **one** issue titled `Ready for hands-on testing: <version>` assigned to `elijah7x` and labelled `hands-on`. Its body includes:
   - install steps for the prerelease installer;
   - what changed since the last hands-on build (merged PR titles);
   - permanently `parked` items with one-line reasons;
   - known untested areas (`real provider`, `install/update`, and `desktop interaction`).
5. **Single open hands-on issue:** autopilot never opens a second `hands-on` issue while one is still open; when new work merges, it builds a new prerelease and updates the existing open `hands-on` issue instead.
6. **30-minute polling loop:** after publishing, autopilot polls every 30 minutes (checking `STOP` every 5 minutes) for new or reopened `nyx-auto` issues. Owner feedback arrives as `nyx-auto` issues, which the loop picks up automatically, merges, and rolls into the next hands-on build.

## Labels

| Label | Meaning |
| --- | --- |
| `nyx-auto` (`-Label`) | Marks an open issue for the autonomous loop to pick up. |
| `audit-followup` | Post-merge audit finding; worked ahead of reopened and remaining parity issues. |
| `build-break` | Opened by the milestone when `main` build, packaging, or packaged smoke fails; worked through the normal PR path. |
| `audit-parked` | Set by the independent auditor on a PR it cannot pass; triggers parking in `parked.json`. |
| `parked` | Set on an issue after two failed revisit attempts (or a guarded-path/dependency impossibility); skipped for good and listed in the hands-on issue. |
| `hands-on` | Single open milestone issue assigned to `elijah7x` pointing to the latest smoke-tested installer prerelease. |

## Autopilot components

### Gate script (`Invoke-AutopilotGate.ps1`)

The autopilot chat runs the isolated reviewer through `scripts/dev-loop/Invoke-AutopilotGate.ps1`:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Invoke-AutopilotGate.ps1 `
  -PrNumber 12 -ReviewRoot C:\tivano\pr-review -ReviewCheckout C:\tivano\pr-review\clone `
  -StandardCredentialFile C:\tivano\private\standard-account.json
```

- Reads the PR head SHA with `gh`, runs `scripts/pr-review/Invoke-PrReview.ps1` with `-Force` and comment posting enabled, and waits up to `-ReviewTimeoutMin` (default `240` minutes).
- If another review holds the reviewer lock, waits 60 seconds and retries up to 10 times.
- Evaluates `gate.json` (`install`, `build`, `typecheck`, unit diff vs base, e2e vs base, reviewer verdict `merge` with empty `blocking`, `reviewOk` and `posted`, PR open on same head SHA without conflicts) and writes logs and failure lists under `<Root>\autopilot\gate\pr-<n>-<timestamp>\` (`-Root` defaults to `C:\tivano\dev-loop`).
- Prints one compact JSON line to stdout (`{"pr":n,"headSha":"...","verdict":"pass|fail|unavailable","failures":["..."],"gatePath":"...","glm":{"status":"ok|unavailable|skipped","verdict":"pass|changes","blocking":<count>,"runDir":"..."},"notes":[...]}`) and exits `0` on `pass`, `1` on `fail`, or `2` on `unavailable`.
- Never merges, labels, or comments itself beyond the review comments from `Invoke-PrReview.ps1` and `Invoke-GlmReview.ps1`.

### GLM-5.4 second reviewer

- **What it checks and what blocks:** `Invoke-AutopilotGate.ps1` runs `scripts/dev-loop/Invoke-GlmReview.ps1` (GLM-5.4) as an independent read-only second reviewer on the same PR head and posts its own PR comment. Blocking findings appear in `failures` prefixed with `GLM-5.4: ` and fail the gate; non-blocking, out-of-scope, or style-only points are advisory. If the two reviewers contradict each other, autopilot follows the issue text and `AGENTS.md`, takes the safer option, and explains why in the commit message and a short PR comment. If GLM-5.4 is `unavailable`, it never blocks the gate by itself. If GLM-5.4 fails, the gate falls back once to Gemini 4 Neon for that review, and its blocking items are prefixed with `Gemini 4 Neon (fallback): ` and handled exactly like `GLM-5.4: ` (including the second-reviewer advisory carve-out rule).
- **Credentials and isolation:** GLM-5.4 runs through the ZCode CLI with an isolated `ZCODE_DATA_BASE_DIR` (`C:\tivano\zcode\home`) whose `provider_config` holds a BigModel Coding Plan API key. That directory sits outside the repository (never committed) and must be readable only by the runner account.
- **Audit and review only:** GLM-5.4 never edits repository files or commits, and autopilot no longer runs GLM-5.4 consult for stuck gates; escalations go to Gemini 4 Neon (`Invoke-NeonFix.ps1`). Pass `-SkipGlm` to `Invoke-AutopilotGate.ps1` to skip the gate's GLM review (`glm.status` becomes `"skipped"`).

### Gemini 4 Neon escalation fixer (`Invoke-NeonFix.ps1`)

Autopilot dispatches Gemini 4 Neon through the Antigravity CLI (`%LOCALAPPDATA%\agy\bin\agy.exe`, called directly inside Devin's interactive desktop session — never over SSH) via `scripts/dev-loop/Invoke-NeonFix.ps1`:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Invoke-NeonFix.ps1 `
  -PrNumber 45 -IssueNumber 12 -WorktreeDir C:\tivano\dev-loop\work\12-slug `
  -FailuresFile C:\tivano\dev-loop\autopilot\runs\12\neon-1.md
```

- **When it runs (max 2 runs per PR head lineage, tracked in `progress.json` `neonRuns`):**
  1. A `nyx/audit` block survives Devin's first fix commit on an item with the same `id` or `title`.
  2. `Invoke-AutopilotGate.ps1` still fails after Devin's first fix round (or the same `npm run verify` test fails 3 times in a row).
  3. A parked-issue revisit begins on a fresh branch (`nyx/<n>-<slug>-r<k>`), before Devin's own attempt, passing the `PARKED` audit comment as `-FailuresFile`.
- **Execution and prompt:** fills `scripts/dev-loop/neon-fix-prompt.md` with the PR number, issue number, failures text, and reference root (`C:\tivano\reference\tivano-v3.0.0`) into the run dir (`<Root>\autopilot\neon\pr-<n>-<timestamp>\`), and runs `agy.exe` in the PR worktree with `--model gemini-4-neon-high` (default), `--mode accept-edits`, `--add-dir` for the run dir and reference root, `--print-timeout <TimeoutMinutes>m` (default `45m`), `--output-format text`, and `--log-file`. On timeout it kills the process tree via `taskkill /T /F` and cleans up leftover worktree processes.
- **Boundary enforcement and handoff:** collects `git status --porcelain` and `git diff --stat`, unwinds any accidental commit, and reverts (with path-scoped `git checkout` and `git clean`) any change outside tracked source/tests or under `scripts/audit/`, `scripts/dev-loop/`, `scripts/pr-review/`, `scripts/windows-acceptance/`, `.github/`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `TRADEMARK.md`, `docs/source-baseline.json`, `package.json` dependency sections, or `package-lock.json`. It never commits or pushes.
- **Output and exit codes:** prints one compact JSON line to stdout (`{"status":"ok|unavailable|no-change","changedFiles":[...],"reverted":[...],"error":"","retryable":bool,"runDir":""}`) with exit codes `0` (`ok`), `2` (`unavailable`), and `3` (`no-change`).
- **On `ok`:** Devin reviews the diff, removes the `audit-parked` label if present, runs `npm run verify`, commits with a plain message without any co-author or tool attribution, pushes, and re-runs its gate (which automatically triggers a new `nyx/audit`).
- **6-hour unavailability cooldown:** if `agy` fails with a non-retryable error (such as `AGY_ERROR` with `"retryable": false`, e.g. `FAILED_PRECONDITION ... User location is not supported`), `Invoke-NeonFix.ps1` writes `<Root>\autopilot\neon\health.json` and skips calling `agy` for 6 hours, returning `unavailable` immediately with the stored error.
- **Fallbacks:** if `Invoke-NeonFix.ps1` returns `no-change` or `unavailable` (or the 2-run lineage cap is reached), autopilot falls back to the existing path: a structured `Audit rebuttal:` comment or parking (`parked.json`) for open PRs, or Devin's own implementation attempt on parked revisits.

### Independent audit

Before merging, autopilot PRs require a `success` commit status on context `nyx/audit` from a separate GitHub App auditor running from its own scheduled tasks on Nyx (not using Devin's `gh` login). Disputes are arbitrated automatically, and PRs the auditor cannot pass receive `audit-parked` rather than halting for a person. The same suite runs a daily post-merge audit and `main` ruleset self-heal; see [scripts/audit/README.md](../audit/README.md).

### Watchdog, self-sync, and liveness (`Start-DevinAutopilot.ps1`)

`scripts/dev-loop/Start-DevinAutopilot.ps1` launches the chat (`-Kickoff`) and keeps it running via the scheduled task `\TivanoDevLoop\autopilot` (`-Watch`, run every `-IntervalMinutes`, default `15`, with a 30-minute execution limit, `MultipleInstances IgnoreNew`, and Interactive logon for GUI access):

- **Self-sync before inspecting Devin:** at the start of every watchdog tick (after checking `STOP`), `-Watch` runs `git -C C:\tivano\audit\tool pull --ff-only origin main` (retrying up to 3 times on transient network failures). On success, it compares `HEAD` against `lastSyncedSha` in `watchdog.json`; when unchanged (and both target directories exist), it logs the SHA and skips mirroring. When changed, it mirrors `scripts\dev-loop` and `scripts\pr-review` into `C:\tivano\pr-bot\tool\scripts` via `robocopy /MIR` per folder (treating exit codes `< 8` as success) and logs the synced SHA. Override paths with `-SyncSource` and `-SyncTarget` if needed.
- **Idle-user rule:** before touching the GUI, `-Watch` checks `GetLastInputInfo`; if the user has been active within `-UserIdleSeconds` (default `120`), it logs `user active, deferred` and exits without touching any window.
- **Window safety:** immediately before every paste and every keystroke batch, it verifies the foreground window is still the target `<Workspace>` Devin Desktop window; if focus changed, it aborts that attempt and never types into another window.
- **Devin Desktop liveness and fresh-session kickoff:** once idle, if no matching Devin Desktop window is open, `-Watch` automatically relaunches Devin Desktop via `-Kickoff` (`devin desktop <Workspace>`). Once the window is ready (whether newly launched or already open), `-Kickoff` starts a fresh session (focuses the chat input, then `Ctrl+N`, which in the IDE view would otherwise open an Untitled editor tab; pastes the fresh-session prompt instructing Devin to inspect `git status` and `git diff` first, and requires ACP `session/new` or `session/prompt` in Devin's logs within 30 seconds, logging `session rotated (kickoff)`). New sessions already open in Bypass Permissions and current clients do not log `/bypass`, so no `/bypass` is sent there. If the rotation is unconfirmed (`session rotation unconfirmed (kickoff)`), it falls back to pasting into the current session, sending `/bypass` first on a best-effort basis that no longer blocks the prompt. The chat input is located through UI Automation (the Edit control named Prompt), which works in both the Agents view and the IDE view side panel; a fixed click point is only the fallback.
- **Aggressive session rotation:** `-Watch` tracks `sessionStartedUtc` and `sessionRotations` in `watchdog.json` (initializing `sessionStartedUtc` to now without rotating if missing) and performs at most one rotation per tick after STOP and user-idle checks:
  1. **Idle rotation (`-SessionIdleRotateMinutes`, default `45`, range `5`-`1440`):** whenever the idle nudge would fire and the current session is at least `-SessionIdleRotateMinutes` old, the watchdog rotates to a fresh session (`session rotated (idle, age N min)`) instead of nudging, falling back to the ordinary nudge if unconfirmed.
  2. **Hard rotation (`-SessionMaxMinutes`, default `180`, range `15`-`2880`):** when the session is at least `-SessionMaxMinutes` old, no busy autopilot process is running, and Devin's logs show no agent activity in the last 3 minutes, the watchdog rotates (`session rotated (max age N min)`).
- **Hang recovery:** `-Watch` tracks consecutive hung health samples in `hungStreak` (incremented when `hungWindows > 0` or `notRespondingDialogs > 0`, otherwise reset to `0`). When `hungStreak >= 2`, the user is idle, and no busy autopilot process is running, it logs `Devin Desktop hung for N samples; restarting`, stops Devin Desktop, resets `hungStreak`, and relaunches via `-Kickoff` (deferring with a log entry if busy processes exist).
- **Stray-app cleanup (`-StrayApps`, default `@('ZCode', 'msedge')`, `none` disables it):** when the user has been idle for at least 600 seconds, `-Watch` closes only auto-started instances (ZCode relaunched by its updater with `--updated`, Edge running in the background with `--no-startup-window`), never a window the user opened, never a process tree whose command lines reference `C:\tivano\` (the GLM audit runtime) and never `msedgewebview2`, via `taskkill /T /F`, logging `stray app closed: <name> (N MB)`. `-Register` keeps the configured list.
- **Approval and stall recovery:**
  1. **Approval pending `>= -ApprovalMinutes` (default `3`):** detects an unresolved permission prompt in `%APPDATA%\Devin\cli\logs\devin_*.log`, focuses the window, re-sends `/bypass` and waits for confirmation, then pastes a continuation prompt.
  2. **No log write for `>= -IdleMinutes` (default `25`, range `5`–`240`):** when eligible work remains (or the chat is not in an empty-queue `polling` state) and no worktree, gate, review, packaging, or smoke process is running, rotates the session if due or focuses the window and pastes a continuation prompt pointing back to `autopilot.md` / `solo-v3.md` and `progress.json`.
  3. **Automatic restart after 6 unresponsive nudges:** every nudge is recorded in `<Root>\autopilot\watchdog.json`. If 6 consecutive nudges produce no new agent log activity and no child task process is running, the watchdog posts one informational public-text-safe note to `Automated dev loop: progress log`, stops the unresponsive Devin Desktop process, resets the counter, and relaunches via `-Kickoff` instead of waiting for a person.
- **Health sampling, orphan reporting, and test-app reaping (`-OrphanMinutes`, `-ReapOrphanedTestApps`):** at the start of every watchdog tick (before user-idle deferral or `STOP` exits), `-Watch` records a UTC snapshot of free RAM, commit percentage, Devin Desktop working set, hung top-level window count, "not responding" dialog count, and orphan candidate count/MB (`orphanCandidates`, `orphanMB`) to `<Root>\state\health.jsonl` (trimmed to the last 5,000 lines when over 2 MB), writes a one-line `health:` log entry, and logs `orphan candidates: N (name:pid:ageH, ...)` (up to 8 entries) when `N > 0`. An orphaned loop root is any process (never the current watchdog process or its ancestors) whose parent PID is no longer alive, whose command line or executable path contains `C:\tivano`, whose name is `node.exe`, `electron.exe`, `esbuild.exe`, `cmd.exe`, `powershell.exe`, `pwsh.exe`, `npm*.exe`, `npx*.exe`, or the Devin CLI (`bin\devin.exe`), and which is older than `-OrphanMinutes` (default `120`, preserved by `-Register`); health samples count these orphaned roots without excluding busy processes. Busy-process checks (used by idle nudges, hard session rotation, hang restarts, kickoff resets, and stuck restarts) exclude all PIDs belonging to orphaned loop trees (each orphaned root plus all of its descendants) so leftover processes cannot block watchdog recovery. Right after the health sample (when `STOP` is not present), with `-ReapOrphanedTestApps` enabled (`1` by default; `0` disables it; preserved by `-Register`), `-Watch` closes only orphaned root `electron.exe` processes whose executable path or command line contains `\node_modules\electron\dist\electron.exe` under `C:\tivano` via `taskkill /T /F`, logging `orphaned test app closed: electron pid <n> (<age>h, <MB> MB)`. Orphaned `node`, `cmd`, `powershell`, and other loop processes stay report-only. Identified task processes (gate, PR review, GLM review, packaging, packaged smoke) are never treated as orphaned, so a running gate keeps its busy protection after its launcher exits. Reaping closes only orphaned test Electron instances started from `<Root>\work` or the Hydrogen lane folder, and only while the user has been idle for at least 600 seconds.
- **Stale-PR reporting and auto-parking (`-StalePrHours`, `-StalePrGateRuns`, `-AutoParkStale`):** each tick, `-Watch` writes open `nyx/` PRs open for at least `-StalePrHours` (default `48`) with at least `-StalePrGateRuns` (default `3`) gate runs to `<Root>\autopilot\stale-prs.json` and logs `stale PRs to park: #n (<R> runs, <H>h), ...`. With `-AutoParkStale` enabled (`1` by default; `-AutoParkStale 0` disables it; preserved by `-Register`; Hydrogen state is read from `-HydrogenLaneRoot`, default `<Root>\hydrogen`, and is never created), the watchdog also auto-parks up to 5 stale PRs per tick directly—appending to `<Root>\autopilot\parked.json` (attempt `0`) and clearing `progress.json` `awaitingAudit` for Devin `nyx/` PRs, or appending to `<Root>\hydrogen\state\progress-hydrogen.json` `parked` for Hydrogen `nyx/h-` PRs—leaving each PR open, posting one park line to `#34`, and logging `auto-parked PR #<pr> (issue #<n>): <H>h, <R> gate runs`.
- **Quiet exits:** exits immediately if `<Root>\state\STOP` exists (after recording the tick's health sample). When Devin Desktop is open and waiting on today's `daily merge cap` or legitimately `polling` with no eligible open `nyx-auto` issues, the watchdog avoids unnecessary nudges.

### Loop health report (`Get-LoopHealth.ps1`)

`scripts/dev-loop/Get-LoopHealth.ps1` is a read-only summary script over a trailing window (default `24` hours):

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Get-LoopHealth.ps1 `
  -Root C:\tivano\dev-loop -Hours 24
```

- Reads `<Root>\state\health.jsonl`, `<Root>\autopilot\gate\*\summary.json` (any non-pass run whose summary reports a timeout counts in `gates.timeoutFails`), and `<Root>\state\logs\autopilot-*.log`.
- Emits one compact JSON object (`windowHours`, `health` including `orphanMax`, `gates`, `watchdog` including `sessionRotations`, `rotationUnconfirmed`, `hangRestarts`, and `strayClosed`) and exits `0`; missing files report zeros without errors.

### Guarded paths and trust model

- **Guarded paths:** issue PRs must never modify `scripts/audit/`, `scripts/dev-loop/`, `scripts/pr-review/`, `scripts/windows-acceptance/`, `.github/`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `TRADEMARK.md`, `docs/source-baseline.json` (exempt only in `solo-v3.md` Phase 1), or `package-lock.json`, must never alter dependencies in `package.json`, and must never set a `docs/parity.md` row to `done`.
- **Devin runs with full permissions** in bypass mode on the operating account. Keep `-Root` private to that account, keep the `gh` token scoped appropriately, and keep the scripts mirrored from `C:\tivano\audit\tool` into `C:\tivano\pr-bot\tool\scripts` rather than running from the working clone.
- **Branch protection enforces `nyx/audit`:** `main` requires the independent GitHub App's `nyx/audit` status check; `--admin` is never used.
- **Public text hygiene:** no machine names, user names, local paths, tokens, or secrets in issues, PRs, releases, commits, or comments; refer to the host only as `a Windows test machine`.
- **Verification limits:** automated merges and packaged smoke runs are **agent self-tested**. Real provider, real install/update, and interactive desktop workflows stay `NOT RUN` until the owner performs hands-on testing.

### State and files (relative to `-Root`, default `C:\tivano\dev-loop`)

- `<Root>\autopilot\progress.json`: current autopilot progress (`state`, `issue`, `step`, `merged`, `awaitingAudit`, `parked`, `neonRuns`, `updatedAt`).
- `<Root>\autopilot\parked.json`: parked issues with `issue`, `pr`, `reason`, and `attempt` (`0`, `1`, `2`).
- `<Root>\autopilot\stale-prs.json`: open `nyx/` PRs meeting `-StalePrHours` and `-StalePrGateRuns`, written every tick and consumed by `-AutoParkStale`.
- `<Root>\autopilot\hands-on.json`: last hands-on build commit SHA, prerelease tag/number, and open `hands-on` issue number.
- `<Root>\autopilot\solo-v3.json`: phase/queue/worked-row state when running `solo-v3.md`.
- `<Root>\autopilot\watchdog.json`: `lastSyncedSha`, consecutive nudge counter, nudge history, `stuckNotified` flag, `sessionStartedUtc`, `sessionRotations`, and `hungStreak`.
- `<Root>\autopilot\builds\<tag>\`: external packaging outputs (`pkg\`) and smoke evidence (`smoke\`), never inside a worktree.
- `<Root>\autopilot\gate\pr-<n>-<timestamp>\`: gate run logs and `failures.md`.
- `<Root>\autopilot\neon\`: Gemini 4 Neon escalation fixer runs (`pr-<n>-<timestamp>\` with filled prompt, `agy` logs, git status/diff artifacts, and `result.json`) and `health.json` (6-hour non-retryable unavailability cooldown).
- `<Root>\autopilot\runs\<n>\`: commit messages, PR bodies, and `neon-<k>.md` failure inputs.
- `<Root>\state\health.jsonl`: per-tick watchdog health samples (`utc`, `freeRamMB`, `commitPct`, `desktopMB`, `hungWindows`, `notRespondingDialogs`, `orphanCandidates`, `orphanMB`; trimmed to the last 5,000 lines when over 2 MB).
- `<Root>\state\logs\autopilot-yyyyMMdd.log`: kickoff, self-sync, health, and watchdog logs.
- `<Root>\state\STOP`: stop file checked by autopilot and `-Watch` / `-Kickoff`.

### Prerequisites

- Devin Desktop signed in, chat set to **Local**, and workspace trust disabled (`"security.workspace.trust.enabled": false`).
- Antigravity CLI (`%LOCALAPPDATA%\agy\bin\agy.exe`) signed in within the interactive desktop session on Nyx for Gemini 4 Neon escalation fixes (optional: if unavailable, autopilot records a 6-hour cooldown in `health.json` and falls back automatically).
- Everything under [Prerequisites in the PR review README](../pr-review/README.md#prerequisites): Windows PowerShell 5.1, Git, GitHub CLI (`gh` signed in and `gh auth setup-git` configured), Node.js with npm, Devin CLI signed in as the operating account, standard check account credential file, and console session for e2e/GUI.
- `C:\tivano\audit\tool` cloned on `main` (source for watchdog self-sync into `C:\tivano\pr-bot\tool\scripts`), `C:\tivano\dev-loop\repo` cloned for worktrees, and `-Root` (`C:\tivano\dev-loop`) outside any git checkout.

### Start, register, and stop

```
# Launch (or focus) Devin Desktop for C:\tivano\dev-loop\repo and send the autopilot prompt once idle:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Start-DevinAutopilot.ps1 -Kickoff

# Register the 15-minute watchdog task \TivanoDevLoop\autopilot (disables legacy \TivanoDevLoop\run):
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Start-DevinAutopilot.ps1 -Register

# Stop autopilot and watchdog cleanly without unregistering:
New-Item -ItemType File -Path C:\tivano\dev-loop\state\STOP -Force | Out-Null

# Resume after stopping:
Remove-Item -Path C:\tivano\dev-loop\state\STOP -Force

# Remove the scheduled task (state and logs are kept):
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Start-DevinAutopilot.ps1 -Unregister
```

## Legacy per-issue runner (`Invoke-DevLoop.ps1`)

`Invoke-DevLoop.ps1` and `Register-DevLoopTask.ps1` (`\TivanoDevLoop\run`) remain in the repository for reference, but are disabled automatically when `Start-DevinAutopilot.ps1 -Register` runs so the two loops do not compete over the same `nyx-auto` issues. Use the Autopilot flow above for unattended operation on Nyx.
