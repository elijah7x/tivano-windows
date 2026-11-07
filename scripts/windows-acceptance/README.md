# Windows desktop acceptance helpers

Run a built Tivano Windows app on the logged-on console user's desktop from a local PowerShell prompt or SSH, capture that desktop, and run noninteractive commands under a separate standard local account. These helpers do not build the app, create accounts, or change security policy.

## Prerequisites

- Windows PowerShell 5.1 or PowerShell 7 on Windows, with the built-in ScheduledTasks and CIM commands. Microsoft.PowerShell.LocalAccounts is not required. Generated tasks use the OS's `powershell.exe` for consistent 5.1 behavior.
- An operating account allowed to register tasks for the target account, normally an elevated administrator. A console user must be logged on with `explorer.exe` running. Keep the console unlocked for screenshots and UI operation; an SSH session alone is not a desktop session. The console user needs access to the app and read/write access to the evidence directory and its parent. The helper refuses an absent or ambiguous console owner, and checks the task entered that console session.
- For development launch, installed dependencies and an already built bundle: `dist/main/index.cjs`, `dist/main/ptyHost.cjs`, `dist/preload/index.cjs`, and the renderer outputs produced by `scripts/build.mjs`. Alternatively, supply a packaged executable with `-Exe`; this does not require development `dist` files.
- For standard-user commands, an enabled local account outside Administrators, a DPAPI credential file exported by the operating account on this machine, and **Log on as a batch job** (`SeBatchLogonRight`). No interactive sign-in or desktop switch is needed for this account. It has its own profile, app-data paths, environment and per-user installation scope; it does not inherit the console user's desktop configuration.

## Evidence and examples

Use synthetic data only. Never commit screenshots, transcripts, credential files or other evidence, and never include real provider credentials or production data in commands, arguments, logs or screenshots. The local acceptance account's credential file stays private, outside the repository and outside the shareable evidence directory; its password is passed only to Task Scheduler, never written to the generated scripts or logs.

All paths come from the caller or the local Windows environment. Use local filesystem paths without junctions, symlinks, short-name aliases or device/UNC paths. Each operation requires an absent or empty directory outside the repository, including hidden files. Missing/unsafe/nonempty evidence arguments are rejected before creating files or registering tasks. Each operation prints a compact JSON summary and saves `summary.json`; a rejected evidence argument produces stdout only because writing there would violate the refusal. Runtime failures also produce nonzero exit status.

**Stop is the necessary exception to the fresh-directory rule:** its only input is the launch directory containing `app.pid`. It accepts only a recorded launch, preserves the launch summary as `start-summary.json`, and writes the stop result to `summary.json`. It refuses to overwrite previous stop evidence. Screenshots use their own fresh directories, not the launch directory.

Set these caller-owned values in PowerShell; substitute your own paths when prompted:

```powershell
$Repo = (Resolve-Path -LiteralPath .).Path
$EvidenceRoot = Read-Host 'Existing evidence parent outside the repository'
$Helpers = Join-Path $Repo 'scripts\windows-acceptance'
$Run = [Guid]::NewGuid().ToString('N')
$LaunchEvidence = Join-Path $EvidenceRoot "$Run-launch"
```

Launch the development bundle (add `-Exe $PackagedExe` for an already packaged executable):

```powershell
& (Join-Path $Helpers 'Start-DesktopApp.ps1') -Repo $Repo -Evidence $LaunchEvidence
```

The default `TIVANO_DATA_ROOT` is `<evidence>\data-root`; `-DataRoot` may select another synthetic directory outside the repo. `TIVANO_PROVIDER` defaults to `mock`, which explicitly selects `MockProvider` in `src/main/index.ts` and prevents saved Codex settings from taking over. The packaged smoke launcher removes provider variables and relies on the same default mock branch; it does not itself set a literal provider value. `scripts/lib/smoke-flow.mjs` consumes that environment and checks the mock badge. `-Provider` overrides the value only in the child; the helper also removes `ELECTRON_RUN_AS_NODE` there. Launch waits up to 30 seconds for a main window on the new PID or its descendants and records the PID, creation time and window title. A visible window alone does not prove functional acceptance.

Capture the virtual screen, or add `-WindowTitle 'Tivano'` to crop the first visible top-level window containing that text:

```powershell
& (Join-Path $Helpers 'Save-Screenshot.ps1') -Evidence (Join-Path $EvidenceRoot "$Run-screen") -Name overview -WindowTitle 'Tivano'
```

The capture runs on the console desktop, requests per-monitor-v2 DPI awareness with a legacy fallback, and uses DWM frame bounds with a window-rectangle fallback. It records the PNG's width and height. A minimized matching window fails; restore it first. This is a screen capture: overlapping windows remain visible in the crop, and it does not operate native dialogs or assert their correctness. Existing PNGs are never overwritten.

Stop the recorded process tree, never a process selected by name:

```powershell
& (Join-Path $Helpers 'Stop-DesktopApp.ps1') -Evidence $LaunchEvidence
```

Stop checks PID, creation time, session and executable before `taskkill /T /PID ... /F`. It refuses a reused or exited root PID; it cannot safely recover orphaned descendants from a stale PID. Force termination can discard unsaved synthetic work.

For a custom interactive probe, dot-source the internal helper:

```powershell
. (Join-Path $Helpers 'Invoke-InteractiveSession.ps1')
$result = Invoke-InInteractiveSession -Evidence (Join-Path $EvidenceRoot "$Run-probe") -Name probe -ScriptBlockText 'Get-Date'
```

The function returns `{ exitCode, stdoutPath, stderrPath }`. `-NoWait` waits only for the wrapper to start, then returns a null exit code if still running; its eventual result is `<name>.exit.json`. The caller owns completion and process cleanup for such a payload. Normal waits default to 120 seconds. Tasks use a run-specific name under `\TivanoAcceptance\`, an Interactive/Limited principal, and are unregistered in `finally`, including failures. Unregistration does not stop an already running program. Wrapper scripts and logs remain in evidence.

Prepare the credential once, from the operating account on the Windows machine. Choose the separate local account, not an administrator. Keep this file private and do not attach it to an acceptance report:

```powershell
$CredentialFile = Read-Host 'Private credential-file path outside the repository and evidence'
$Credential = Get-Credential -Message 'Separate standard local account (machine\user)'
$Credential | Export-Clixml -LiteralPath $CredentialFile
$OperatingSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $CredentialFile /inheritance:r /grant:r "*${OperatingSid}:(F)"
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict credential-file access' }
$Credential = $null
```

An `Export-Clixml` file uses user-scope DPAPI, which often cannot be decrypted in a key-authenticated SSH session (no password is available to unlock the user's keys). For SSH-driven runs, store the credential as a `.json` file protected with machine-scope DPAPI instead, and rely on the file ACL above to keep it private:

```powershell
Add-Type -AssemblyName System.Security
$Credential = Get-Credential -Message 'Separate standard local account (machine\user)'
$Bytes = [Text.Encoding]::UTF8.GetBytes($Credential.GetNetworkCredential().Password)
$Protected = [Security.Cryptography.ProtectedData]::Protect($Bytes, $null, 'LocalMachine')
@{ user = $Credential.UserName; password = [Convert]::ToBase64String($Protected) } |
  ConvertTo-Json | Set-Content -LiteralPath $CredentialFile -Encoding UTF8   # $CredentialFile ends in .json
$Credential = $null
```

Run a silent installer, uninstaller, or the offline packaged smoke command by supplying its executable and arguments. For example, with `$NodeExe`, `$PackagedExe`, and `$SmokeEvidence` set to caller-chosen paths (the smoke directory must also be fresh, outside the repo, and writable by the standard account):

```powershell
$StandardEvidence = Join-Path $EvidenceRoot "$Run-standard"
$SmokeEvidence = Join-Path $StandardEvidence 'packaged-smoke'
& (Join-Path $Helpers 'Invoke-AsStandardUser.ps1') -CredentialFile $CredentialFile `
  -Evidence $StandardEvidence -Command $NodeExe -WorkingDirectory $Repo `
  -Arguments @((Join-Path $Repo 'scripts\windows\packaged-smoke.mjs'), '--exe', $PackagedExe, '--evidence', $SmokeEvidence)
```

This uses a Password/Limited task without a desktop, grants that account inheritable Modify on **only** `$StandardEvidence`, and records `whoami /groups` (including integrity level), stdout, stderr and the command exit code. It neither grants access to the repository/executable nor changes permissions on parent directories. Default timeout is 900 seconds; timed-out tasks are stopped and unregistered. Exit codes such as installer reboot-required codes remain visible in JSON and are not silently treated as success. Arguments are executable argv, not shell syntax; pass a shell explicitly when needed, and do not put secrets in arguments.

## Grant batch logon to one account

Windows Home does not give the Users group `SeBatchLogonRight` by default. Grant it to the one acceptance account rather than the entire Users group. Run the following deliberately in an elevated PowerShell prompt; **the scripts above never run it**. Set `$AccountName` to the qualified local account and `$PolicyEvidence` to a new external directory. This exports existing assignments and adds the account to the existing batch-logon list without replacing other user rights:

```powershell
$AccountName = Read-Host 'Qualified local acceptance account'
$PolicyEvidence = Join-Path $EvidenceRoot ([Guid]::NewGuid().ToString('N') + '-batch-right')
New-Item -ItemType Directory -Path $PolicyEvidence -ErrorAction Stop | Out-Null
$Before = Join-Path $PolicyEvidence 'before.inf'
& secedit.exe /export /cfg $Before /areas USER_RIGHTS /log (Join-Path $PolicyEvidence 'export.log') /quiet
if ($LASTEXITCODE -ne 0) { throw 'Policy export failed' }
$Sid = ([Security.Principal.NTAccount]::new($AccountName)).Translate([Security.Principal.SecurityIdentifier]).Value
$Line = Get-Content -LiteralPath $Before | Where-Object { $_ -match '^SeBatchLogonRight\s*=' } | Select-Object -First 1
$Existing = @()
if ($Line) { $Existing = @(($Line -split '=', 2)[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Assignment = (@($Existing) + "*$Sid" | Select-Object -Unique) -join ','
$Template = @'
[Unicode]
Unicode=yes
[Version]
signature="$CHICAGO$"
Revision=1
[Privilege Rights]
'@
$Grant = Join-Path $PolicyEvidence 'grant.inf'
($Template + "`r`nSeBatchLogonRight = $Assignment`r`n") | Set-Content -LiteralPath $Grant -Encoding Unicode
# Review grant.inf and before.inf before applying this account-specific addition.
& secedit.exe /configure /db (Join-Path $PolicyEvidence 'grant.sdb') /cfg $Grant `
  /areas USER_RIGHTS /log (Join-Path $PolicyEvidence 'configure.log') /quiet
if ($LASTEXITCODE -ne 0) { throw 'Policy update failed' }
```

`SeDenyBatchLogonRight` takes precedence, and domain policy may override local assignments. Resolve those explicitly with the administrator; do not remove deny entries as a workaround. Keep the export as the change record.

## What the evidence establishes

Report all five categories separately, with `NOT RUN` for anything not executed. Agent results are **agent self-tested** until a Windows maintainer reviews them.

| Helper or action | Verification categories |
| --- | --- |
| `Invoke-InInteractiveSession` / `Start-DesktopApp` | Real Windows execution and launch evidence; synthetic replay only if a mock/fixture scenario is actually exercised. Launch alone does not complete a desktop-interaction check. |
| `Save-Screenshot` with UI actions | Real Windows and supporting desktop-interaction evidence. Agent-driven screenshots/actions are **agent self-tested desktop interaction**, not a person operating the UI. Record the operator and actual actions. |
| `Stop-DesktopApp` | Real Windows process-cleanup evidence only. |
| `Invoke-AsStandardUser` | Real Windows for that account type; install/update only when installing, upgrading or uninstalling is actually exercised. Offline packaged smoke adds synthetic replay; it does not establish installation or a real provider by itself. |
| Real provider | `NOT RUN` for the default mock/offline workflows. No helper by itself proves real authentication or inference. |

API references: [task principals](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal), [task deletion](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-delete), [DPI awareness](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext), [DWM bounds](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmgetwindowattribute), [batch-logon policy](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/log-on-as-a-batch-job), [secedit export](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/secedit-export), [secedit configure](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/secedit-configure).
