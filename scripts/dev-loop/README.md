# Automated development loop

A Windows 11 test machine runs `elijah7x/tivano-windows`'s `nyx-auto` issue backlog unattended in a single long-running Devin Desktop chat (**Autopilot**, following `scripts/dev-loop/autopilot.md` or `scripts/dev-loop/solo-v3.md`), watched and kept up to date by `Start-DevinAutopilot.ps1`.

Everything produced by the loop is **agent self-tested**, not maintainer acceptance. It never approves or requests changes, never touches pull requests outside its own `nyx/` branches, and never force-pushes.

## Autonomous policy (no human waits)

The owner does **not** participate during development, review, or audit, and enters only when a packaged build is ready for hands-on testing:

- **No human pauses or escalations:** the loop never stops to ask questions, wait for confirmation, consult a person, or wait on manual audit overrides. Only creating `<Root>\state\STOP` stops it.
- **Automatic arbitration & non-blocking audit waits:** `nyx/audit` disputes are arbitrated automatically by the independent auditor (which never asks a person to intervene). While a PR's `nyx/audit` status is `pending` or `arbitration pending`, autopilot records it in `progress.json` (`awaitingAudit`) and works on another issue instead of idling.
- **Daily merge cap auto-resume:** when the cap of 20 merges per local calendar day is reached, autopilot sleeps in 5-minute intervals (checking `STOP`) until the next local calendar day and resumes automatically.
- **Queue priority:** open eligible `nyx-auto` issues (skipping permanently `parked` ones) are worked in strict order:
  1. `audit-followup` issues (and `build-break` issues opened by the milestone), lowest number first;
  2. reopened issues (`state_reason == "reopened"`), lowest number first;
  3. remaining parity issues.

## Parking and revisits

Stuck work never blocks the queue or waits for a person:

1. **Park and move on:** if the independent auditor's newest comment is `## Nyx audit - <sha7> - PARKED` for the PR's current head (the `audit-parked` label alone can be stale and is removed before each new push), or an issue fails its own gate after the allowed fix rounds (2 fix rounds + 1 automated GLM-5.3 consult round, or consult/gate unavailable), autopilot leaves the PR open, records `{issue, pr, reason, attempt}` in `<Root>\autopilot\parked.json`, and moves on to the next issue.
2. **Revisit at most twice:** once no unparked open `nyx-auto` issues (or in-flight `awaitingAudit` PRs) remain, autopilot revisits each parked issue up to two times. On each revisit it closes the old PR with a one-line comment, starts a fresh branch (`nyx/<n>-<slug>-r<k>`) from current `origin/main` using a different approach informed by the audit and gate comments, and opens a new PR.
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

### GLM-5.3 second reviewer and automated consult

- **What it checks and what blocks:** `Invoke-AutopilotGate.ps1` also runs `scripts/dev-loop/Invoke-GlmReview.ps1` (GLM-5.3) as an independent second reviewer on the same PR head and posts its own PR comment. Blocking findings appear in `failures` prefixed with `GLM-5.3: ` and fail the gate; non-blocking, out-of-scope, or style-only points are advisory. If the two reviewers contradict each other, autopilot follows the issue text and `AGENTS.md`, takes the safer option, and explains why in the commit message and a short PR comment. If GLM-5.3 is `unavailable`, it never blocks the gate by itself.
- **Credentials and isolation:** GLM-5.3 runs through the ZCode CLI with an isolated `ZCODE_DATA_BASE_DIR` (`C:\tivano\zcode\home`) whose `provider_config` holds a BigModel Coding Plan API key. That directory sits outside the repository (never committed) and must be readable only by the runner account.
- **Automated consult step:** when an issue fails the gate after 2 fix rounds or hits 3 identical `npm run verify` failures, autopilot writes trimmed failures to `<Root>\autopilot\runs\<n>\failures-<k>.md` and runs `Invoke-GlmReview.ps1 -Mode consult -PrNumber <pr> -FailuresFile <file>` (up to ~20 minutes; exit `0` ok, `2` unavailable) once per attempt. It applies one guided fix round and re-gates; if that also fails or consult is unavailable, it parks the issue in `parked.json` and moves on.
- **Disabling and read-only boundary:** pass `-SkipGlm` to `Invoke-AutopilotGate.ps1` to skip the GLM review (`glm.status` becomes `"skipped"`). GLM never edits repository files or commits; it only reviews and advises.

### Independent audit

Before merging, autopilot PRs require a `success` commit status on context `nyx/audit` from a separate GitHub App auditor running from its own scheduled tasks on Nyx (not using Devin's `gh` login). Disputes are arbitrated automatically, and PRs the auditor cannot pass receive `audit-parked` rather than halting for a person. The same suite runs a daily post-merge audit and `main` ruleset self-heal; see [scripts/audit/README.md](../audit/README.md).

### Watchdog, self-sync, and liveness (`Start-DevinAutopilot.ps1`)

`scripts/dev-loop/Start-DevinAutopilot.ps1` launches the chat (`-Kickoff`) and keeps it running via the scheduled task `\TivanoDevLoop\autopilot` (`-Watch`, run every `-IntervalMinutes`, default `15`, with a 30-minute execution limit, `MultipleInstances IgnoreNew`, and Interactive logon for GUI access):

- **Self-sync before inspecting Devin:** at the start of every watchdog tick (after checking `STOP`), `-Watch` runs `git -C C:\tivano\audit\tool pull --ff-only origin main` (retrying up to 3 times on transient network failures). On success, it compares `HEAD` against `lastSyncedSha` in `watchdog.json`; when unchanged (and both target directories exist), it logs the SHA and skips mirroring. When changed, it mirrors `scripts\dev-loop` and `scripts\pr-review` into `C:\tivano\pr-bot\tool\scripts` via `robocopy /MIR` per folder (treating exit codes `< 8` as success) and logs the synced SHA. Override paths with `-SyncSource` and `-SyncTarget` if needed.
- **Idle-user rule:** before touching the GUI, `-Watch` checks `GetLastInputInfo`; if the user has been active within `-UserIdleSeconds` (default `120`), it logs `user active, deferred` and exits without touching any window.
- **Window safety:** immediately before every paste and every keystroke batch, it verifies the foreground window is still the target `<Workspace>` Devin Desktop window; if focus changed, it aborts that attempt and never types into another window.
- **Devin Desktop liveness:** once idle, if no matching Devin Desktop window is open, `-Watch` automatically relaunches Devin Desktop via `-Kickoff` (`devin desktop <Workspace>`, `/bypass`, and prompt) so the 24/7 loop stays alive across crashes, restarts, milestones, and polling.
- **Approval and stall recovery:**
  1. **Approval pending `>= -ApprovalMinutes` (default `3`):** detects an unresolved permission prompt in `%APPDATA%\Devin\cli\logs\devin_*.log`, focuses the window, re-sends `/bypass` and waits for confirmation, then pastes a continuation prompt.
  2. **No log write for `>= -IdleMinutes` (default `25`, range `5`–`240`):** when eligible work remains (or the chat is not in an empty-queue `polling` state) and no worktree, gate, review, packaging, or smoke process is running, focuses the window and pastes a continuation prompt pointing back to `autopilot.md` / `solo-v3.md` and `progress.json`.
  3. **Automatic restart after 6 unresponsive nudges:** every nudge is recorded in `<Root>\autopilot\watchdog.json`. If 6 consecutive nudges produce no new agent log activity and no child task process is running, the watchdog posts one informational public-text-safe note to `Automated dev loop: progress log`, stops the unresponsive Devin Desktop process, resets the counter, and relaunches via `-Kickoff` instead of waiting for a person.
- **Quiet exits:** exits immediately if `<Root>\state\STOP` exists. When Devin Desktop is open and waiting on today's `daily merge cap` or legitimately `polling` with no eligible open `nyx-auto` issues, the watchdog avoids unnecessary nudges.

### Guarded paths and trust model

- **Guarded paths:** issue PRs must never modify `scripts/audit/`, `scripts/dev-loop/`, `scripts/pr-review/`, `scripts/windows-acceptance/`, `.github/`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `TRADEMARK.md`, `docs/source-baseline.json` (exempt only in `solo-v3.md` Phase 1), or `package-lock.json`, must never alter dependencies in `package.json`, and must never set a `docs/parity.md` row to `done`.
- **Devin runs with full permissions** in bypass mode on the operating account. Keep `-Root` private to that account, keep the `gh` token scoped appropriately, and keep the scripts mirrored from `C:\tivano\audit\tool` into `C:\tivano\pr-bot\tool\scripts` rather than running from the working clone.
- **Branch protection enforces `nyx/audit`:** `main` requires the independent GitHub App's `nyx/audit` status check; `--admin` is never used.
- **Public text hygiene:** no machine names, user names, local paths, tokens, or secrets in issues, PRs, releases, commits, or comments; refer to the host only as `a Windows test machine`.
- **Verification limits:** automated merges and packaged smoke runs are **agent self-tested**. Real provider, real install/update, and interactive desktop workflows stay `NOT RUN` until the owner performs hands-on testing.

### State and files (relative to `-Root`, default `C:\tivano\dev-loop`)

- `<Root>\autopilot\progress.json`: current autopilot progress (`state`, `issue`, `step`, `merged`, `awaitingAudit`, `parked`, `updatedAt`).
- `<Root>\autopilot\parked.json`: parked issues with `issue`, `pr`, `reason`, and `attempt` (`0`, `1`, `2`).
- `<Root>\autopilot\hands-on.json`: last hands-on build commit SHA, prerelease tag/number, and open `hands-on` issue number.
- `<Root>\autopilot\solo-v3.json`: phase/queue/worked-row state when running `solo-v3.md`.
- `<Root>\autopilot\watchdog.json`: `lastSyncedSha`, consecutive nudge counter, nudge history, and `stuckNotified` flag.
- `<Root>\autopilot\builds\<tag>\`: external packaging outputs (`pkg\`) and smoke evidence (`smoke\`), never inside a worktree.
- `<Root>\autopilot\gate\pr-<n>-<timestamp>\`: gate run logs and `failures.md`.
- `<Root>\autopilot\runs\<n>\`: commit messages, PR bodies, and failure snippets.
- `<Root>\state\logs\autopilot-yyyyMMdd.log`: kickoff, self-sync, and watchdog logs.
- `<Root>\state\STOP`: stop file checked by autopilot and `-Watch` / `-Kickoff`.

### Prerequisites

- Devin Desktop signed in, chat set to **Local**, and workspace trust disabled (`"security.workspace.trust.enabled": false`).
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
