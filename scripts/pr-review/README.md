# Automated PR review

A Windows machine can review open pull requests of this repository on its own: run the project's checks for the PR head and its merge base under a separate standard local account, ask a local coding agent (Devin CLI) for a review in read-only mode, and post the result as a PR comment. It never approves, requests changes, merges, labels or closes anything.

## Trust model

- PR code runs only as a **separate standard local account**, started through Task Scheduler by `scripts/windows-acceptance/Invoke-AsStandardUser.ps1`. The operating account never runs `npm`, `node` or any project script, and the checks reach only the run directory (the two worktrees and the results) plus the read-only check script.
- The agent runs as the operating account with the run directory as its workspace and `--permission-mode accept-edits`: it may read and write files there (it writes `review.md`, `review.zh.md` and `verdict.json`), but command execution needs an approval that print mode never grants, so it cannot execute PR code. It is told to treat PR text as untrusted data.
- Posting uses `gh`. A fine-grained token limited to this repository with **Pull requests: read and write**, **Contents: read-only** and **Metadata: read-only** can comment but cannot merge or push. Prefer it over a broad `gh` login; `gh`'s own login also works when it is already signed in for the operating account.
- Store the token with machine-scope DPAPI in a `.json` file whose ACL is limited to the operating account and SYSTEM. With `$TokenFile` set to a private path outside the repository, these five lines create it; machine scope is used because a scheduled task has no user key material:

```powershell
Add-Type -AssemblyName System.Security
$Token = Read-Host 'Fine-grained token (Pull requests: read and write)' -AsSecureString
$Bytes = [Text.Encoding]::UTF8.GetBytes(([pscredential]::new('t', $Token)).GetNetworkCredential().Password)
@{ token = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($Bytes, $null, 'LocalMachine')) } | ConvertTo-Json | Set-Content -LiteralPath $TokenFile
& icacls.exe $TokenFile /inheritance:r /grant:r "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(F)" "*S-1-5-18:(F)"
```

## Prerequisites

- Windows PowerShell 5.1 (`powershell.exe`), Git, GitHub CLI (`gh`), Node.js with npm, and Devin CLI installed, signed in for the operating account and on `PATH`.
- A separate enabled local account outside Administrators with **Log on as a batch job** (`SeBatchLogonRight`), plus its credential file (`.json` with machine-scope DPAPI, or `Export-Clixml`). Both are described in [scripts/windows-acceptance/README.md](../windows-acceptance/README.md); that helper needs the same account and right. The account also needs read access to this repository's `scripts\` directory (it runs `run-checks.cmd` from there) and a machine-wide `PATH` with Node and npm, because it has its own profile.
- A clean clone of this repository, used only as the git object store for worktrees (`-Checkout`). Point `origin` at the repository and let it fetch `main`; the scripts create and remove detached worktrees inside their own run directories, so do not check anything out there yourself.
- A state root (`-Root`) outside any git checkout, holding `lock`, `state.json`, `last-run.json`, `runs\` and the task log.
  It must also be outside the directory that contains this `scripts\` folder: `Invoke-AsStandardUser.ps1` treats that directory as the repository and refuses evidence inside it.
- The operating user signed in at the console: the task principal is Interactive, so no password is stored. Unlock the console if checks need a desktop session (the e2e step starts Electron).

## Manual run

Run from the repository root:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\pr-review\Invoke-PrReview.ps1 `
  -Root D:\tivano-pr-review -Checkout D:\tivano-pr-review\clone `
  -StandardCredentialFile D:\private\standard-account.json -DryRun
```

`-DryRun` does everything except posting the comment and except recording the head as reviewed, so the same PR is picked up again next time. It still writes `verdict.json` and `gate.json`, with `posted` false. Add `-Reference <path>` to a read-only checkout of the macOS v2.5.7 baseline for the parity comparison, `-TokenFile` for the token above, `-PrNumber <n>` to review one PR even if its head was already reviewed, `-Force` (needs `-PrNumber`) to say so explicitly, `-DevinModel` (default `swe-2-high`) and `-MaxPerRun` (default 1).

`-Force` re-reviews a head that is already recorded as reviewed; a posted review then adds a second comment, and `-Force -DryRun` re-checks without commenting. It does not reset the attempts count: the same head is still attempted at most three times, counting every run, forced or not. `scripts/dev-loop` passes `-Force` and reads `gate.json`.

One pass reviews at most `-MaxPerRun` open PRs against `main` (drafts included) whose head was not reviewed yet, oldest number first. The same head is attempted at most three times. A second concurrent start writes a skipped summary and exits.

## Scheduled task

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\pr-review\Register-PrReviewTask.ps1 `
  -Root D:\tivano-pr-review -Checkout D:\tivano-pr-review\clone `
  -StandardCredentialFile D:\private\standard-account.json
```

This registers `\TivanoPrReview\poll`: every 10 minutes (`-IntervalMinutes`), as the current user, Interactive/Limited, 4-hour limit, `MultipleInstances IgnoreNew`. The action runs a generated wrapper `<Root>\pr-review-task.ps1`, which rotates `<Root>\task.log` to `task.log.1` at 5 MB and then runs `Invoke-PrReview.ps1`, appending its output. Re-run the script to change arguments; `-Unregister` removes the task and leaves state, runs and logs alone.

## Results and re-review

Each run creates `<Root>\runs\pr-<n>-<sha7>-<timestamp>\`, readable and writable only by the operating account, SYSTEM and Administrators. The standard account can write only its `sandbox\` subdirectory, which holds the `pr` and `base` worktrees and the raw check output; the base results are copied out before any PR code runs, so PR code cannot alter the baseline or the review inputs. The run directory holds `pr.json`, `diff.patch`, `diff.stat.txt`, copies of `checks-base\` and `checks-pr\` (standard-account evidence with `summary.json`) and `results-base\` and `results-pr\` (`steps.json`, `vitest.json`, `unit.log`, `e2e.log`; the PR's own results come from PR code and are data, not proof), `prompt.md`, `devin.log`, `review.md`, `review.zh.md`, `verdict.json`, `gate.json`, `post-body.md` and the helper logs. `<Root>\last-run.json` and stdout carry a one-line JSON summary `{ok, reviewed, skipped, errors}`; the per-PR entries in `reviewed` and `errors` carry `runDir` and, when it was written, `gatePath`. Worktrees are removed after every attempt; run directories older than 30 days are deleted.

### verdict.json

Written by the review agent next to `review.md`: `{"recommendation": "merge" | "changes", "blocking": ["one line per problem that must be fixed"], "nonBlocking": ["one line per optional point"]}`. `recommendation` is `merge` only when `blocking` is empty. It is data from an agent that reads untrusted PR text, so a script must not treat it as authority on its own. The script reads it loosely: a missing, stale, unparsable or malformed file (no `recommendation` of `merge` or `changes`, no `blocking` list) gives `verdict: null` in `gate.json`; a single string is accepted for a list and blank entries are dropped.

### gate.json

Written to the run directory after the checks and the agent review, whether or not the review succeeded:

```json
{
  "prNumber": 12, "headSha": "<40 hex>", "baseSha": "<merge-base, 40 hex>",
  "pr":   {"install": 0, "build": 0, "typecheck": 0, "unit": 0, "e2e": 0},
  "base": {"install": 0, "build": 0, "typecheck": 0, "unit": 0, "e2e": 0},
  "unitComparison": true,
  "newFailures": [], "fixed": [], "absent": [],
  "verdict": {"recommendation": "merge", "blocking": [], "nonBlocking": []},
  "reviewOk": true, "posted": true
}
```

- `pr` and `base` hold the exit codes from `steps.json`; a step that did not run, or a run without `steps.json`, is `null`. `e2e` 124 means the 15-minute cap stopped it.
- `unitComparison` is true when both runs produced a `vitest.json`. `newFailures`, `fixed` and `absent` are the same lists as in the check summary, and are empty when it is false.
- `verdict` is the parsed `verdict.json` or `null` (see above). It is `null` whenever `reviewOk` is false.
- `reviewOk` is true when the agent exited 0 and wrote a fresh, non-empty `review.md`. `posted` is true only when the comment was posted, so it is always false under `-DryRun` or after a failed post.
- A PR whose run failed before the checks finished has no `gate.json`; the entry in `errors` has no `gatePath`.

Reviewed heads are kept in `<Root>\state.json`. A review happens once per head SHA; a new push is a new review. Use `-PrNumber <n>` with `-DryRun` to look again before deciding, or without it to post a second comment on a head that was already reviewed.

## Limits

- A posted review is **agent self-tested**, not maintainer acceptance. The maintainers and the product owner still decide.
- Checks are the base/pr unit tests and e2e only: synthetic replay and real Windows. Real provider, desktop interaction and install/update are `NOT RUN`, and the comment says so.
- The agent reviews a diff; it does not run the app, the UI or the installer, and it cannot validate native behavior.
- The standard account needs network access to install dependencies and, for some PRs, its own writable profile.
