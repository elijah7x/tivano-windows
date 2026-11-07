# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Stop-DesktopApp.ps1 -Evidence $launchEvidence (the directory containing app.pid).

param([string]$Evidence)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Invoke-InteractiveSession.ps1')
$script:AcceptanceCommand = 'Stop-DesktopApp'
$status = 1
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Evidence)) { throw '-Evidence is required.' }
  $dir = Get-AcceptancePath $Evidence
  Assert-AcceptanceOutsideRepo $dir
  # Stop necessarily consumes an existing launch directory; all other entry points require a fresh directory.
  foreach ($name in @('app.pid', 'app-process.json', 'summary.json')) {
    $path = Get-AcceptancePath (Join-Path $dir $name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Launch evidence is missing $name." }
  }
  foreach ($name in @('start-summary.json', 'stop.out.log', 'stop.err.log')) {
    if (Test-Path -LiteralPath (Join-Path $dir $name)) { throw 'This launch directory already has stop evidence; it will not be overwritten.' }
  }
  $launchSummary = Get-Content -LiteralPath (Join-Path $dir 'summary.json') -Raw | ConvertFrom-Json
  if ($launchSummary.script -ne 'Start-DesktopApp') { throw 'Evidence must come from Start-DesktopApp.' }
  $record = Get-Content -LiteralPath (Join-Path $dir 'app-process.json') -Raw | ConvertFrom-Json
  $pidText = (Get-Content -LiteralPath (Join-Path $dir 'app.pid') -Raw).Trim()
  if ($pidText -notmatch '^[1-9][0-9]*$') { throw 'app.pid must contain one positive PID.' }
  $appId = [int]$pidText
  if ($appId -ne $record.pid -or $appId -eq $PID) { throw 'Process identity does not match app.pid.' }
  $process = Get-Process -Id $appId -ErrorAction SilentlyContinue
  if (-not $process) { throw 'The recorded root process has exited; no process was killed. Orphaned descendants cannot be identified safely from a stale PID.' }
  if ($process.StartTime.ToUniversalTime().ToString('o') -ne $record.startedAtUtc -or
      $process.SessionId -ne $record.sessionId -or
      -not $process.Path.Equals([string]$record.executable, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The recorded PID was reused or its identity cannot be established; no process was killed.'
  }
  Copy-Item -LiteralPath (Join-Path $dir 'summary.json') -Destination (Join-Path $dir 'start-summary.json')
  $script:AcceptanceEvidence = $dir
  $killer = Start-Process -FilePath (Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe') `
    -ArgumentList @('/T', '/PID', [string]$appId, '/F') -Wait -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'stop.out.log') -RedirectStandardError (Join-Path $dir 'stop.err.log')
  if ($killer.ExitCode -ne 0) { throw "taskkill failed with exit code $($killer.ExitCode); see stop.err.log." }
  if (-not $process.WaitForExit(15000)) { throw 'Recorded root process did not exit within 15 seconds.' }
  $summary = [ordered]@{ ok = $true; exitCode = 0; pid = $appId; taskkillExitCode = $killer.ExitCode }
  $status = 0
} catch {
  $summary = [ordered]@{ ok = $false; exitCode = 1; error = $_.Exception.Message }
}
Write-AcceptanceSummary $summary
exit $status
