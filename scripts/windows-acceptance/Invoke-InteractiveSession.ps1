# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Dot-source this file, then Invoke-InInteractiveSession -Evidence $dir -Name probe -ScriptBlockText 'Get-Date'.

$ErrorActionPreference = 'Stop'
$script:AcceptanceRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:AcceptanceEvidence = $null
$script:AcceptanceCommand = 'Invoke-InInteractiveSession'

function Get-AcceptancePath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A non-empty path is required.' }
  $providerInfo = $null
  $driveInfo = $null
  $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$providerInfo, [ref]$driveInfo)
  if ($providerInfo.Name -ne 'FileSystem') { throw 'A filesystem path is required.' }
  $full = [IO.Path]::GetFullPath($full)
  # Reject aliases instead of allowing a junction/short name to bypass the repository boundary.
  if ($full.StartsWith('\\') -or $full -match '~[0-9]' -or $full.Substring(2).Contains(':')) {
    throw 'Use a local filesystem path without device paths, short-name aliases or alternate streams.'
  }
  $part = $full
  while ($part) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -LiteralPath $part -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Paths through symbolic links or junctions are not supported.'
      }
    }
    $parent = Split-Path -Parent $part
    if ($parent -eq $part) { break }
    $part = $parent
  }
  if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
  return $full.TrimEnd('\')
}

function Assert-AcceptanceOutsideRepo {
  param([string]$Path, [string[]]$Repositories = @($script:AcceptanceRepo))
  foreach ($repository in $Repositories) {
    $root = Get-AcceptancePath $repository
    if ($Path.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Evidence and data roots must be outside the repository.'
    }
  }
}

function Test-AcceptanceEvidence {
  param([string]$Evidence, [string[]]$Repositories = @($script:AcceptanceRepo))
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows is required.'
  }
  if ([string]::IsNullOrWhiteSpace($Evidence)) { throw '-Evidence is required.' }
  $path = Get-AcceptancePath $Evidence
  Assert-AcceptanceOutsideRepo $path $Repositories
  if (Test-Path -LiteralPath $path) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw '-Evidence must be a directory.' }
    if (@(Get-ChildItem -LiteralPath $path -Force).Count -ne 0) { throw '-Evidence must be fresh or empty.' }
  }
  return $path
}

function Initialize-AcceptanceEvidence {
  param([string]$Evidence)
  $path = Test-AcceptanceEvidence $Evidence
  [IO.Directory]::CreateDirectory($path) | Out-Null
  $script:AcceptanceEvidence = $path
  return $path
}

function Write-AcceptanceSummary {
  param([System.Collections.IDictionary]$Summary)
  $Summary['script'] = $script:AcceptanceCommand
  $Summary['recordedAtUtc'] = [DateTime]::UtcNow.ToString('o')
  $json = ConvertTo-Json -InputObject $Summary -Depth 6 -Compress
  if ($script:AcceptanceEvidence) {
    [IO.File]::WriteAllText((Join-Path $script:AcceptanceEvidence 'summary.json'), $json + [Environment]::NewLine)
  }
  [Console]::Out.WriteLine($json)
}

function ConvertTo-AcceptanceLiteral {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Assert-AcceptanceSlug {
  param([string]$Name)
  if ($Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' -or
      $Name -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
    throw '-Name must be a filename-safe slug of 1-64 letters, digits, underscores or hyphens.'
  }
}

function Get-AcceptancePowerShell {
  return Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
}

function Initialize-AcceptanceTaskFolder {
  $root = $null
  $service = New-Object -ComObject 'Schedule.Service'
  try {
    $service.Connect()
    $root = $service.GetFolder('\')
    try { $null = $service.GetFolder('\TivanoAcceptance') }
    catch {
      try { $null = $root.CreateFolder('TivanoAcceptance') }
      catch { $null = $service.GetFolder('\TivanoAcceptance') }
    }
  } finally {
    if ($root) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($root) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($service)
  }
}

function Wait-AcceptanceTask {
  param([string]$TaskName, [int]$TimeoutSec, [switch]$NoWait, [string]$StartedPath)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($clock.Elapsed.TotalSeconds -lt $TimeoutSec) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\TivanoAcceptance\'
    $state = (Get-ScheduledTask -TaskName $TaskName -TaskPath '\TivanoAcceptance\').State
    $code = [long]$info.LastTaskResult
    # LastTaskResult alone can still be stale while a newly started task is queued.
    $finished = $info.LastRunTime.Year -gt 2000 -and $state -notin @('Running', 'Queued') -and
      $code -notin @(0x41301, 0x41303)
    if ($finished) { return $code }
    if ($NoWait -and (Test-Path -LiteralPath $StartedPath)) { return $null }
    Start-Sleep -Milliseconds 200
  }
  throw "Scheduled task timed out after $TimeoutSec seconds."
}

function Invoke-InInteractiveSession {
  param(
    [string]$Evidence,
    [string]$Name,
    [string]$ScriptBlockText,
    [ValidateRange(1, 86400)][int]$TimeoutSec = 120,
    [switch]$NoWait
  )
  $script:AcceptanceEvidence = $null
  $registered = $false
  $released = $false
  $taskName = $null
  $operationError = $null
  $oldTemp = $env:TEMP
  $oldTmp = $env:TMP
  try {
    $dir = Test-AcceptanceEvidence $Evidence
    Assert-AcceptanceSlug $Name
    if ([string]::IsNullOrWhiteSpace($ScriptBlockText)) { throw '-ScriptBlockText is required.' }
    $dir = Initialize-AcceptanceEvidence $dir
    $env:TEMP = $dir
    $env:TMP = $dir
    if (-not ('TivanoAcceptance.ConsoleSession' -as [type])) {
      Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace TivanoAcceptance {
  public static class ConsoleSession {
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  }
}
'@
    }
    $sessionId = [TivanoAcceptance.ConsoleSession]::WTSGetActiveConsoleSessionId()
    if ($sessionId -eq [uint32]::MaxValue) { throw 'No active console session.' }
    $owners = @(
      Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe' AND SessionId = $sessionId" |
        ForEach-Object {
          $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
          if ($owner.ReturnValue -ne 0 -or -not $owner.User) { throw 'Cannot resolve the console explorer owner.' }
          "$($owner.Domain)\$($owner.User)"
        } | Select-Object -Unique
    )
    if ($owners.Count -ne 1) { throw 'Exactly one explorer owner in the active console session is required.' }
    $payloadPath = Join-Path $dir "$Name.ps1"
    $wrapperPath = Join-Path $dir "$Name.wrapper.ps1"
    $stdoutPath = Join-Path $dir "$Name.out.log"
    $stderrPath = Join-Path $dir "$Name.err.log"
    $startedPath = Join-Path $dir "$Name.started"
    $exitPath = Join-Path $dir "$Name.exit.json"
    $header = "# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.`r`n# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app`r`n"
    Set-Content -LiteralPath $payloadPath -Value ($header + $ScriptBlockText) -Encoding UTF8
    $wrapper = @'
$ErrorActionPreference = 'Stop'
$env:TEMP = __DIR__
$env:TMP = __DIR__
Set-Location -LiteralPath __DIR__
$global:LASTEXITCODE = 0
$code = 0
try {
  & {
    if ((Get-Process -Id $PID).SessionId -ne __SESSION__) { throw 'Task did not enter the active console session.' }
    [IO.File]::WriteAllText(__STARTED__, [string]$PID)
    & __PAYLOAD__
  } 3>&1 4>&1 5>&1 6>&1 1> __OUT__ 2> __ERR__
  $code = $global:LASTEXITCODE
} catch {
  $_.Exception.Message | Out-File -LiteralPath __ERR__ -Append -Encoding UTF8
  $code = 1
}
[IO.File]::WriteAllText((__EXIT__ + '.pending'), ('{"exitCode":' + $code + '}'))
[IO.File]::Move((__EXIT__ + '.pending'), __EXIT__)
exit $code
'@
    $wrapper = $wrapper.Replace('__DIR__', (ConvertTo-AcceptanceLiteral $dir)).
      Replace('__SESSION__', [string]$sessionId).
      Replace('__STARTED__', (ConvertTo-AcceptanceLiteral $startedPath)).
      Replace('__PAYLOAD__', (ConvertTo-AcceptanceLiteral $payloadPath)).
      Replace('__OUT__', (ConvertTo-AcceptanceLiteral $stdoutPath)).
      Replace('__ERR__', (ConvertTo-AcceptanceLiteral $stderrPath)).
      Replace('__EXIT__', (ConvertTo-AcceptanceLiteral $exitPath))
    Set-Content -LiteralPath $wrapperPath -Value ($header + $wrapper) -Encoding UTF8
    Initialize-AcceptanceTaskFolder
    $taskName = "$Name-$([Guid]::NewGuid().ToString('N'))"
    $action = New-ScheduledTaskAction -Execute (Get-AcceptancePowerShell) -WorkingDirectory $dir `
      -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapperPath + '"')
    $principal = New-ScheduledTaskPrincipal -UserId $owners[0] -LogonType Interactive -RunLevel Limited
    $executionLimit = New-TimeSpan -Seconds $TimeoutSec
    if ($NoWait) { $executionLimit = [TimeSpan]::Zero }
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit $executionLimit
    # No trigger: this task can run only on our explicit Start-ScheduledTask request.
    Register-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\' -Action $action `
      -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\'
    $exitCode = Wait-AcceptanceTask -TaskName $taskName -TimeoutSec $TimeoutSec -NoWait:$NoWait -StartedPath $startedPath
    $released = $true
    $result = [pscustomobject]@{ exitCode = $exitCode; stdoutPath = $stdoutPath; stderrPath = $stderrPath }
  } catch {
    $operationError = $_
  } finally {
    try {
      if ($registered) {
        try {
          if (-not $released) { Stop-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\' }
        } finally {
          # Deleting a task leaves its running program alive, including the NoWait launcher.
          # https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-delete
          Unregister-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\' -Confirm:$false
        }
      }
    } catch {
      $operationError = $_
    } finally {
      $env:TEMP = $oldTemp
      $env:TMP = $oldTmp
    }
  }
  if ($operationError) {
    if ($script:AcceptanceCommand -eq 'Invoke-InInteractiveSession') {
      Write-AcceptanceSummary ([ordered]@{ ok = $false; exitCode = 1; error = $operationError.Exception.Message })
    }
    throw $operationError
  }
  if ($script:AcceptanceCommand -eq 'Invoke-InInteractiveSession') {
    Write-AcceptanceSummary ([ordered]@{ ok = ($null -eq $exitCode -or $exitCode -eq 0); exitCode = $exitCode; stdoutPath = $stdoutPath; stderrPath = $stderrPath })
  }
  return $result
}

if ($MyInvocation.InvocationName -ne '.') {
  Write-AcceptanceSummary ([ordered]@{ ok = $false; exitCode = 1; error = 'Dot-source this helper and call Invoke-InInteractiveSession with -Evidence, -Name and -ScriptBlockText.' })
  exit 1
}
