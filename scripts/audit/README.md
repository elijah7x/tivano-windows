# Independent PR and post-merge auditor

This directory holds an independent auditor for Devin's autopilot pull requests in `elijah7x/tivano-windows`. It runs on the Windows host (Nyx) from its own scheduled tasks (`\TivanoAudit\pr` and `\TivanoAudit\postmerge`) and talks to GitHub **only** through a dedicated GitHub App installation token — never through the `gh` CLI account that Devin uses.

## Purpose

- **Pre-merge audit (`Invoke-Audit.ps1`)**: polls open `nyx/*` pull requests every 10 minutes, runs deterministic checks plus an independent read-only model audit against the exact head SHA, posts structured findings, and sets the commit status context `nyx/audit` (`success`, `failure`, or `pending`).
- **Post-merge audit (`Invoke-PostMergeAudit.ps1`)**: runs daily at 03:00 (or in backlog mode via `-PrNumbers`), checks merged `nyx/*` PRs on `main` for default-settings Codex-path acceptance, Windows-skipped tests, PR-body claims, and cross-PR wiring seams. On `block`, it reopens or comments on the linked issue and creates deduplicated `nyx-auto` + `audit-followup` issues. On every run it also checks `main` ruleset integrity.

## Independence model

1. **Separate GitHub App identity**: `mint-token.mjs` signs an RS256 JWT with the App's PEM private key and mints a short-lived installation token via `POST /app/installations/<id>/access_tokens`. All status updates, PR comments, labels, and issue edits happen under the App's identity.
2. **Source-pinned required status check**: A GitHub repository ruleset on `main` requires commit status `nyx/audit` **specifically from this GitHub App (`integration_id == appId`)**. Because Devin runs with the user's `gh` login, Devin cannot post, overwrite, or spoof a `nyx/audit` status accepted by the ruleset.
3. **Fail closed**:
   - Pre-merge: if the audit model is unavailable, times out, or crashes, the auditor never sets `nyx/audit` to `success`. `gh pr merge` remains blocked by the ruleset until a clean `pass` runs on the exact head SHA.
   - Post-merge: if the audit model is unavailable, the PR is **never** marked done in `workRoot\state\post-<n>.json` and is retried on the next run.
4. **Separate model and read-only inspection**: The auditor runs an independent model via `zcode.cjs` in read-only mode against a detached worktree, alongside deterministic checks in `AuditChecks.psm1`.

## Rebuttal protocol

When `nyx/audit` fails on a PR head:

1. **Fix in a new commit** (default): Devin fixes every blocking finding, runs `npm run verify`, pushes a new commit on the same branch (never force-pushing), and re-runs its own gate. The pre-merge auditor picks up the new head SHA on the next poll.
2. **One structured rebuttal**: If Devin believes a blocking finding is factually wrong, it may post **one** PR comment starting with `Audit rebuttal:` citing concrete `file:line` or test-output evidence for each disputed finding `id`. On the next poll, the auditor evaluates the rebuttal and moves verified false positives into `withdrawn`.
3. **No self-downgrading**: Devin may never ignore, downgrade, or relabel `nyx/audit` findings as advisory. (The advisory carve-out in `scripts/dev-loop/autopilot.md` applies only to the `GLM-5.3:` reviewer inside Devin's own gate.)
4. **Escalation to `needs-human`**: If a dispute remains unresolved or the PR hits the auditor's retry/rebuttal cap, the auditor labels the PR `needs-human`. Devin parks the issue under its existing `needs-human` protocol and moves on to the next issue.

## Setup steps

1. **Create the GitHub App**:
   - In GitHub Settings -> Developer settings -> GitHub Apps -> **New GitHub App**.
   - Disable **Webhook -> Active** (the auditor polls from Nyx).
   - Set **Repository permissions**:
     - **Commit statuses**: Read and write
     - **Contents**: Read-only
     - **Issues**: Read and write
     - **Pull requests**: Read and write
     - **Metadata**: Read-only
   - Record the **App ID**.

2. **Install the App on this repository only**:
   - Install the App selecting **Only select repositories** -> `elijah7x/tivano-windows`.
   - Record the **Installation ID** from the installation URL (`.../installations/<installationId>`).

3. **Store the private key outside the repository and restrict its ACL**:
   - Generate and download a private key (`.pem`) in the GitHub App settings.
   - Save it outside any git checkout, for example `C:\tivano\secrets\audit\app.pem`.
   - Restrict NTFS permissions so only the audit account (plus `SYSTEM` and `Administrators`) can read it:
     ```powershell
     icacls "C:\tivano\secrets\audit\app.pem" /inheritance:r /grant:r "<AuditUser>:R" "*S-1-5-18:F" "*S-1-5-32-544:F"
     ```

4. **Write `config.json`**:
   - Copy `scripts/audit/config.example.json` to `C:\tivano\audit\config.json` (outside the repository).
   - Fill in `appId`, `installationId`, `keyPath`, `zcode`, `model`, `referenceRoot`, `workRoot`, `statusContext`, and `timeoutMinutes`.

5. **Register the scheduled tasks**:
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\audit\Register-AuditTasks.ps1 `
     -ConfigPath C:\tivano\audit\config.json
   ```
   Pass `-RunAsUser <DOMAIN\User>` (from an elevated PowerShell prompt) to run the tasks under a dedicated Windows account instead of the current user. Pass `-Unregister` to remove `\TivanoAudit\pr` and `\TivanoAudit\postmerge`.

6. **Add the `main` branch ruleset**:
   - In `elijah7x/tivano-windows` -> Settings -> Rules -> Rulesets -> **New branch ruleset**.
   - Set enforcement to **Active** and target **Default branch** (`~DEFAULT_BRANCH` / `main`).
   - Enable **Require status checks to pass**, add required check context `nyx/audit`, and pick this Audit GitHub App as the expected source (`integration_id`).
   - Save the ruleset. Do not grant bypass to the account Devin uses.

7. **Run a backlog post-merge audit**:
   Audit already-merged PRs once with `-PrNumbers`:
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\audit\Invoke-PostMergeAudit.ps1 `
     -ConfigPath C:\tivano\audit\config.json -PrNumbers 94,95,96,97,98,99,100
   ```
   Add `-DryRun` first to inspect verdicts without reopening issues or creating follow-ups.

## Residual risks

- **Same Windows user can read the key file**: If `\TivanoAudit\*` runs under the same Windows account as Devin Desktop, an unrestricted agent running as that user has filesystem access to `keyPath` and could mint App tokens itself. **Mitigation**: run the audit scheduled tasks under a separate Windows user account (`-RunAsUser`) and lock down `app.pem` (and `config.json` / `workRoot`) with `icacls` so Devin's account has no read permission.
- **Admin token can edit or disable rulesets**: Any token or user with repository Admin access could disable the `main` ruleset or unbind `nyx/audit` from `appId`. **Mitigation**: keep Devin's `gh` token non-admin/minimum-scope where possible, and rely on `Invoke-PostMergeAudit.ps1`'s ruleset integrity check, which inspects `GET /repos/<repo>/rulesets` on every run and opens or updates a `needs-human` issue titled `Audit ruleset missing or disabled` if no active default-branch ruleset requires `nyx/audit` from `appId`.
