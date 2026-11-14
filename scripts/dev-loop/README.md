# Automated development loop

A Windows 11 machine can work through this repository's labeled issues on its own with the Devin CLI: take an issue, implement it in a git worktree, self-test, open a pull request, get it reviewed by the isolated [automated PR reviewer](../pr-review/README.md), merge it when the gate passes, and continue with the next issue. A person can stop it at any time and can take over any pull request it touches.

Everything it produces is **agent self-tested**, not maintainer acceptance. It never approves or requests changes, never touches pull requests that are not on its own `nyx/` branches, and never force-pushes.

## What one run does

`Invoke-DevLoop.ps1` is one pass. A scheduled task starts it every 30 minutes; a second start while one is running exits at once.

1. Exit at once if `<Root>\STOP` exists. Take the single-instance lock. Stop if today's merge limit is reached.
2. `git fetch origin` in `-Checkout`.
3. **Resume first.** An open pull request whose head branch starts with `nyx/` and whose author is the signed-in `gh` user is continued before anything new starts (lowest number first; one without a `needs-human` label). Its review, fix and merge steps run as below.
4. **Otherwise pick an issue**: the lowest-numbered open issue with the `-Label` label (default `nyx-auto`), without `needs-human` or `nyx-blocked`, and with no open pull request from a `nyx/<n>-*` branch. An issue already attempted twice without a pull request gets `needs-human` and a comment instead.
5. **Develop.** A worktree `<Root>\work\issue-<n>` on branch `nyx/<n>-<slug>` is cut from `origin/main` (reused when an earlier attempt left one). With `-DevinFrontEnd gui` (the default) the runner opens the worktree in Devin Desktop on the signed-in desktop, focuses its chat (Ctrl+Shift+E, then Ctrl+L), sends `/bypass`, pastes a one-line instruction pointing at the prompt file and sends it, then waits for the agent to create `agent-done-<step>.txt` in the run directory as its last action (or for `-DevinTimeoutMin`). The conversation stays in Devin Desktop, where it can be watched and joined. With `-DevinFrontEnd cli` Devin CLI runs in a console window instead; a running CLI session cannot be opened in Devin Desktop. Either way Devin works with `dev-prompt.md`, the issue text passed as a file, and the run directory `<Root>\runs\issue-<n>-<timestamp>`. It writes `result.json` (`{"status": "ready" | "blocked", "reason", "title"}`) and `pr-body.md`.
   - Devin failed, timed out, or left no usable result, no `pr-body.md`, or an empty diff: the attempt counts, the worktree is kept, and the run moves on.
   - `blocked`: the reason is commented on the issue, the issue gets `nyx-blocked`, the worktree is removed.
6. **Guard the diff** before committing (see below). On a trip the runner opens no pull request, labels the issue `needs-human`, comments what tripped, and keeps the branch locally.
7. **Commit and open the PR.** The commit message is the result title plus `Implemented by an AI coding agent (Devin); agent self-tested.`; then `git push -u origin <branch>` (never forced) and `gh pr create --base main` with `pr-body.md` (`Closes #<n>` is appended when missing).
8. **Review.** `..\pr-review\Invoke-PrReview.ps1` runs for the PR with `-Force`, posts its review comment, and writes `gate.json`. A head the pr-review poller already reviewed and posted is not reviewed twice: its existing `gate.json` is used.
9. **Merge gate.** All of these must hold:
   - the pr `install`, `build` and `typecheck` steps exit 0;
   - `newFailures` is empty;
   - the pr unit run exits 0, or fails exactly as base fails with a per-test comparison and no new failure;
   - the pr `e2e` exit is not worse than base (0 when base is 0; failing on both is accepted unless exactly one side hit the 15-minute timeout);
   - `verdict.recommendation` is `merge` and `verdict.blocking` is empty;
   - `reviewOk` and `posted` are true;
   - the PR is still open, its head SHA is unchanged and it does not conflict with `main`;
   - today's merges are below `-MaxMergesPerDay`.

   If only unit failures are in the way, the review runs once more with `-Force -DryRun` (no second comment) to rule out a flake, and that gate decides; a PR comment records the merge after a flake. On a pass: `gh pr merge --squash --match-head-commit <sha> --delete-branch`, the worktree is removed, and the run continues with the next issue up to `-MaxIssuesPerRun`.
10. **Fix rounds.** On a failed gate with rounds left, Devin runs in the same worktree with `fix-prompt.md` and the review, gate, check summary and a list of the failed conditions. It updates `result.json` and may update `pr-body.md`. The runner guards the diff again, adds a **new** commit (no amend), pushes it normally, updates the PR body when it changed, and reviews again. After `-MaxFixRounds` rounds the PR and the issue get `needs-human`, a short comment lists the failed conditions, the PR stays open, and the run moves on.

Problems with the review machinery rather than the change (the reviewer failed, wrote no usable verdict, or its lock was busy) never use a fix round. A busy reviewer is retried next run; two unusable reviews in a row hand the PR over with `needs-human`. A PR closed by a person without merging makes the issue `needs-human` rather than being redone.

### Guarded paths

The runner refuses to open or update a pull request whose whole difference from the merge base:

- touches `scripts/dev-loop/`, `scripts/pr-review/`, `scripts/windows-acceptance/`, `.github/`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `TRADEMARK.md`, `docs/source-baseline.json` or `package-lock.json`;
- changes a dependency section of `package.json` (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, bundled dependencies, `overrides`);
- sets a `docs/parity.md` row to `done` that was not `done` before.

These changes need a maintainer. The prompts tell Devin the same rules; the guard is what enforces them.

## Trust model

- **Devin runs with full permissions.** `--permission-mode dangerous` runs commands without approval, as the operating account, with that account's `git` and `gh` credentials and file access. The worktree is its working directory, not a sandbox: nothing stops it from reading or writing elsewhere that the account can. The prompts forbid pushing, using `gh`, committing and touching other paths, and the runner guards the diff afterwards, but those are rules, not walls. Run the loop only on a machine and account you accept that for, keep the account's `gh` token limited to this repository, and keep the scripts in a clone of their own that Devin has no reason to touch (check it with `git status` now and then).
- **The merge gate relies on the isolated reviewer.** Pull request code runs only under the separate standard account used by `pr-review`; the review agent cannot run commands. The merge decision rests on those check results and on `verdict.json`, which that agent wrote after reading untrusted pull request text. The agent that wrote the change and the one that reviews it use the same model by default (`-DevinModel`), so they can share blind spots. Treat a merged pull request as agent self-tested, and have a maintainer look at what landed.
- **Text from the agent is published.** Titles, bodies and comments pass a scrub that removes the runner's own paths and the profile path; this is a backstop to the prompt rule, not a guarantee.
- **Branch protection is yours.** The runner merges as the signed-in `gh` user with `--squash --match-head-commit`. If `main` requires approvals or checks, the merge is refused and the PR stays open after three tries; that is by design, and `--admin` is never used.
- **Keep `-Root` private** to the operating account: it holds worktrees, prompts, issue text and logs.

## Labels

| Label | Meaning |
| --- | --- |
| `nyx-auto` (`-Label`) | You add it to an issue to let the runner take it. It is never added by the runner. |
| `needs-human` | The runner stopped and a person decides (guard tripped, fix rounds used up, attempts used up, PR closed, review unusable, merge failing). Remove it to let the runner look again. |
| `nyx-blocked` | The agent could not do the issue unattended and said why in a comment. Answer there, then remove the label. |

The runner creates `needs-human` and `nyx-blocked` when it first needs them and leaves an existing label's color and description alone. Removing a label does not reset the attempt counters in `state.json`; edit the entry (or delete it) while no run is active.

## STOP

Create an empty file `<Root>\STOP` and every run exits at once, before taking the lock. A run already in progress finishes the step it is in (a Devin or review run is not interrupted) and then stops before the next one. Delete the file to resume. Unregistering the task also stops it.

## Prerequisites

- For the `gui` front end: Devin Desktop signed in, its chat set to **Local** (new windows keep that choice), and workspace trust off (`"security.workspace.trust.enabled": false` in its user settings). The runner sends `/bypass` before the instruction so the conversation never waits for approval, pastes text through the clipboard (an input method would rewrite typed keys) and takes the foreground for a few seconds to do it. `-DevinModel` applies to the CLI front end only; the GUI uses the model chosen in Devin Desktop.

- Everything under [Prerequisites in the PR review README](../pr-review/README.md#prerequisites): Windows PowerShell 5.1, Git, GitHub CLI, Node.js with npm, Devin CLI signed in as the operating account, the standard check account and its credential file, and the console session for e2e. `scripts\dev-loop` must sit next to `scripts\pr-review` and `scripts\windows-acceptance`.
- `gh` signed in as the operating account with access to this repository that can push branches, open and merge pull requests, and edit issues and labels. Git must push without a prompt (the runner sets `GIT_TERMINAL_PROMPT=0`): run `gh auth setup-git` once so pushes use the `gh` sign-in rather than a credential manager that cannot prompt in the scheduled session.
- A clone of this repository for the worktrees (`-Checkout`), with `origin` pointing at the repository. The runner creates and removes worktrees and branches `nyx/*` in it; do not check anything out there yourself.
- A state root (`-Root`) outside any git checkout and outside the directory that contains `scripts\`. Keep it short (`D:\tivano-dev-loop`): worktrees hold `node_modules`.
- The reviewer's state root (`-ReviewRoot`, the `-Root` of `Invoke-PrReview.ps1`) and, optionally, its clone (`-ReviewCheckout`). Pointing both at the poller's own root and clone makes the loop and the poller share one lock and one state, so they never review at the same time and a PR the poller reviewed first is not reviewed again. Without `-ReviewCheckout`, `-Checkout` serves for both and the runner skips `git fetch --prune`, which would delete the review clone's `pr-<n>` refs.
- Issues the runner can work are normal issues with the `nyx-auto` label. Parity rows are the natural unit; write the row ID (for example `P1-11`) in the title.

## Manual run

First run: a dry run on one issue. It needs only `-Root` and `-Checkout`:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Invoke-DevLoop.ps1 `
  -Root D:\tivano-dev-loop -Checkout D:\tivano-dev-loop\clone -DryRun -IssueNumber 12
```

`-DryRun` develops and commits locally only: no push, no pull request, no review, no merge, and no labels or comments on GitHub either. Resuming open pull requests is skipped. Read `<Root>\last-run.json`, `<Root>\logs\`, the run directory (`dev-prompt.md`, `devin-dev.log`, `result.json`, `pr-body.md`, `commit.txt`) and the worktree `<Root>\work\issue-12` with its one local commit. A later real run on the same issue reuses that worktree and branch. To discard it: `git -C <Checkout> worktree remove --force <Root>\work\issue-12` and `git -C <Checkout> branch -D nyx/12-<slug>`.

Then one real pass on that issue, with the review wiring:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Invoke-DevLoop.ps1 `
  -Root D:\tivano-dev-loop -Checkout D:\tivano-dev-loop\clone `
  -ReviewRoot D:\tivano-pr-review -ReviewCheckout D:\tivano-pr-review\clone `
  -StandardCredentialFile D:\private\standard-account.json -IssueNumber 12
```

`-IssueNumber` works that one issue regardless of its labels and attempts; an open `nyx/` pull request for it is continued instead. Without it the run resumes open pull requests and picks issues as described above.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `-Repo` | `elijah7x/tivano-windows` | `owner/name` |
| `-Root` | required | State, logs, run directories and worktrees |
| `-Checkout` | required | Existing clone used for worktrees |
| `-ReviewRoot` | required unless `-DryRun` | `-Root` of `Invoke-PrReview.ps1` |
| `-ReviewCheckout` | `-Checkout` | `-Checkout` of `Invoke-PrReview.ps1` |
| `-StandardCredentialFile` | required unless `-DryRun` | Passed to `Invoke-PrReview.ps1` |
| `-ReviewTokenFile` | none | Passed as `-TokenFile` to `Invoke-PrReview.ps1` (comment-only token for posting reviews) |
| `-Reference` | none | Read-only macOS v2.5.7 baseline clone, given to Devin and to the reviewer |
| `-DevinModel` | `swe-2-high` | For development, fixing and the review |
| `-Label` | `nyx-auto` | Issue label to pick up |
| `-MaxIssuesPerRun` | 1 | Pull requests resumed plus issues started in one run |
| `-MaxMergesPerDay` | 4 | Local calendar day; a run exits early once it is reached |
| `-MaxFixRounds` | 2 | Fix rounds per pull request, across runs |
| `-DevinTimeoutMin` | 90 | Per Devin run (development or one fix round) |
| `-IssueNumber` | 0 | Work only this issue (or its open PR) |
| `-DryRun` | off | Develop and commit locally only |

## Scheduled task

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dev-loop\Register-DevLoopTask.ps1 `
  -Root D:\tivano-dev-loop -Checkout D:\tivano-dev-loop\clone `
  -ReviewRoot D:\tivano-pr-review -ReviewCheckout D:\tivano-pr-review\clone `
  -StandardCredentialFile D:\private\standard-account.json
```

This registers `\TivanoDevLoop\run`: every 30 minutes (`-IntervalMinutes`), as the current user, Interactive/Limited, 8-hour limit, `MultipleInstances IgnoreNew`. It forwards `-Repo`, `-Root`, `-Checkout`, `-ReviewRoot`, `-ReviewCheckout`, `-StandardCredentialFile`, `-ReviewTokenFile`, `-Reference`, `-DevinModel`, `-Label`, `-MaxIssuesPerRun`, `-MaxMergesPerDay`, `-MaxFixRounds` and `-DevinTimeoutMin`; `-IssueNumber` and `-DryRun` are for manual runs only. The action runs a generated wrapper `<Root>\dev-loop-task.ps1` that rotates `<Root>\task.log` at 5 MB. Re-run the script to change arguments; `-Unregister` removes the task and leaves everything under `-Root` alone. The task runs only while the operating user is signed in.

## State and results

- `<Root>\state.json`: per issue `attempts`, `status`, `branch`, `pr`, `lastRunDir`, `fixRounds`, `reviewFailures`, `mergeFailures` and the last gate for the PR head; and merges per local day.
- `<Root>\last-run.json` and stdout: `{ok, stopped, dryRun, merged, worked, skipped, errors}`. `worked` entries carry the issue, PR, `outcome` (`merged`, `needs-human`, `blocked`, `failed`, `deferred`, `closed`, `dry-run`, `stopped`) and the run directory. Per-issue failures are in `errors`; only a run-level failure is a nonzero exit. A start that finds another pass holding the lock writes `<Root>\last-skipped.json` instead, leaving the running pass's summary alone.
- `<Root>\logs\dev-loop-<date>.log`: one line per step. `<Root>\runs\issue-<n>-<timestamp>\`: prompts, issue text, Devin and review logs, `result.json`, `pr-body.md`, comment and commit texts. Run directories and logs older than 30 days are deleted. A worktree is removed only when its issue is finished (merged, blocked, closed); a failed attempt, a guard trip and an issue waiting on a person keep theirs.
- An issue counts an attempt when a run ends without a clean outcome (Devin failed, timed out or left no usable result, or the run crashed). Two attempts without a pull request make it `needs-human`.

## Limits

- A merged change is **agent self-tested**. The checks are the reviewer's: unit tests and e2e on a real Windows host under a standard account. Real provider, desktop interaction and install/update stay `NOT RUN` unless a person does them, and a Windows maintainer still decides `done` for a parity row; the guard stops the runner from claiming it.
- Only one issue is developed at a time, and a failed or deferred step is retried on the next 30-minute run rather than in a loop.
- The guard looks at the pull request's diff, not at what Devin did on the machine.
- A flaky e2e failure that is not worse than base passes the gate; an e2e that fails on both base and pr is not detected as a regression.
