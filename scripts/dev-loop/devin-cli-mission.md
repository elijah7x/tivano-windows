# Devin lane: one headless run

The watchdog (`Start-DevinAutopilot.ps1 -DevinMode cli`) starts this mission with `devin -p` whenever no Devin run is active, at most every 15 minutes. Each run has a wall-clock cap and is stopped when it stays idle. Nobody reads the output, and nobody can answer a question.

## Rules

1. Run `git -C C:\tivano\dev-loop\repo fetch origin`, then read `AGENTS.md`, `scripts/dev-loop/solo-v3.md` and `scripts/dev-loop/autopilot.md` from `origin/main`.
2. Follow every rule in those files: queue order, `lane-devin` claiming, worktrees under `C:\tivano\dev-loop\work\`, guarded paths, the PR template, and the PR-body line `Parity: <ID> -> <status>` (never edit `docs/parity.md` in an issue PR). Run the pre-push self-check `Invoke-PrePrSelfCheck.ps1 -RunChecks` (build, typecheck, whole unit suite with capped workers). Also follow the gate, Neon escalation, parking, public text hygiene, no attribution and no new repositories rules.
3. Ignore only the parts that assume a never-ending chat. Never sleep or poll in a loop, never wait for `nyx/audit`, the watchdog merge or the daily cap, and never keep the run open to "stay available". Ending the run is correct; the watchdog starts the next one.
4. Never ask a question, and never use a tool that waits for user input. If a decision is unclear, take the conservative choice from the rules, write it in the PR body or the tracking issue line, and continue.

## Start

1. Check `C:\tivano\dev-loop\state\STOP`. If it exists, print `RESULT: stopped` and end.
2. Read `C:\tivano\dev-loop\autopilot\progress.json`, `solo-v3.json` and `parked.json`. If a previous run left an issue or PR in the middle of a step, continue exactly that step first.

## Choose one unit of work

Pick the first that applies:

1. A one-off phase step that `solo-v3.md` still requires, for example the step 2a follow-up issues while `solo-v3.json` `rebaseline3026` is not `issues-opened`.
2. One of this lane's open PRs (branch `nyx/<n>-...`, not `nyx/h-...`, not parked) whose newest gate verdict on its current head is `fail` or missing, or whose `nyx/audit` status is `failure`:
   - merge `origin/main` into it first if it is behind;
   - fix the cause;
   - run the self-check, push, and re-run the gate.
3. Otherwise, claim the next eligible issue under the queue rules, implement it, open the PR, and run the gate.

## Finish

1. End the run right after the gate verdict for this unit is recorded. That means a pass, a fail after the allowed fix rounds and Neon escalation, or a parked issue.
2. Before ending, update `progress.json` and post the one-line update to the tracking issue.
3. Before ending, stop every process still running under your worktree. Leave no background process behind.
4. Run builds, tests and `Invoke-AutopilotGate.ps1` in the foreground with generous timeouts: the gate may take up to 120 minutes.
5. The last line you print must be one of:
   - `RESULT: <issue or PR> <what happened> <gate verdict>`
   - `RESULT: idle - no eligible work`
