# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Register-HydrogenTask.ps1 [-ScriptDir <synced dev-loop dir>] [-LaneRoot <dir>] [-GateRoot <dir>] [-ReferenceRoot <dir>] [-Repo <owner/name>] [-Model <id>] [-Label <label>] [-IntervalMinutes 15] [-MaxOpenPrs 2] [-DailyMergeCap 20] [-PrintTimeoutMinutes 150] [-HardKillMinutes 170] [-CooldownHours 6] [-AgyPath <exe>] [-Unregister]
# Registers or removes the scheduled task \TivanoDevLoop\hydrogen under the current user with an Interactive principal.

param(
  [string]$ScriptDir = 'C:\tivano\audit\tool\scripts\dev-loop',
  [string]$LaneRoot = 'C:\tivano\dev-loop\hydrogen',
  [string]$GateRoot = 'C:\tivano\dev-loop\autopilot\gate',
  [string]$ReferenceRoot = 'C:\tivano\reference\tivano-v3.0.0',
  [string]$Repo = 'elijah7x/tivano-windows',
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$Model = 'gemini-4-hydrogen-high',
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Label = 'nyx-auto',
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [ValidateRange(5, 240)][int]$ExecutionLimitMinutes = 30,
  [ValidateRange(1, 10)][int]$MaxOpenPrs = 2,
  [ValidateRange(1, 200)][int]$DailyMergeCap = 20,
  [ValidateRange(5, 480)][int]$PrintTimeoutMinutes = 150,
  [ValidateRange(10, 600)][int]$HardKillMinutes = 170,
  [ValidateRange(1, 48)][int]$CooldownHours = 6,
  [string]$AgyPath = '',
  [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskPath = '\TivanoDevLoop\'
$script:TaskName = 'hydrogen'
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'

function Initialize-TaskFolder {
  $service = New-Object -ComObject 'Schedule.Service'
  $rootFolder = $null
  try {
    $service.Connect()
    $rootFolder = $service.GetFolder('\')
    try { $null = $service.GetFolder('\TivanoDevLoop') }
    catch {
      try { $null = $rootFolder.CreateFolder('TivanoDevLoop') }
      catch { $null = $service.GetFolder('\TivanoDevLoop') }
    }
  } finally {
    if ($rootFolder) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rootFolder) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($service)
  }
}

function Quote-Argument {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function Resolve-FullPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A non-empty path is required.' }
  return [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)).TrimEnd('\')
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }

  $laneRootPath = Resolve-FullPath $LaneRoot

  if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction SilentlyContinue
    if (-not $existing) {
      [Console]::Out.WriteLine('No scheduled task ' + $script:TaskPath + $script:TaskName + ' is registered.')
      exit 0
    }
    Unregister-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -Confirm:$false
    [Console]::Out.WriteLine('Removed scheduled task ' + $script:TaskPath + $script:TaskName + '; clone, worktrees, state and logs under ' + $laneRootPath + ' are left in place.')
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw '-Repo must be owner/name.'
  }

  $scriptDirPath = Resolve-FullPath $ScriptDir
  $workerScript = Join-Path $scriptDirPath 'Start-HydrogenWorker.ps1'
  $promptFile = Join-Path $scriptDirPath 'hydrogen.md'
  if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) {
    throw ('Start-HydrogenWorker.ps1 not found at ' + $workerScript)
  }
  if (-not (Test-Path -LiteralPath $promptFile -PathType Leaf)) {
    throw ('hydrogen.md not found at ' + $promptFile)
  }

  $gateRootPath = Resolve-FullPath $GateRoot
  $referencePath = Resolve-FullPath $ReferenceRoot

  $repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDirPath '..\..')).TrimEnd('\')
  if ($laneRootPath.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $laneRootPath.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '-LaneRoot must be outside the synced scripts repository.'
  }

  [IO.Directory]::CreateDirectory($laneRootPath) | Out-Null
  [IO.Directory]::CreateDirectory((Join-Path $laneRootPath 'state')) | Out-Null

  $argList = New-Object Collections.Generic.List[string]
  foreach ($item in @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', (Quote-Argument $workerScript),
    '-Repo', (Quote-Argument $Repo),
    '-LaneRoot', (Quote-Argument $laneRootPath),
    '-GateRoot', (Quote-Argument $gateRootPath),
    '-ReferenceRoot', (Quote-Argument $referencePath),
    '-Model', (Quote-Argument $Model),
    '-Label', (Quote-Argument $Label),
    '-MaxOpenPrs', [string]$MaxOpenPrs,
    '-DailyMergeCap', [string]$DailyMergeCap,
    '-PrintTimeoutMinutes', [string]$PrintTimeoutMinutes,
    '-HardKillMinutes', [string]$HardKillMinutes,
    '-CooldownHours', [string]$CooldownHours
  )) {
    $null = $argList.Add($item)
  }
  if (-not [string]::IsNullOrWhiteSpace($AgyPath)) {
    $resolvedAgy = Resolve-FullPath $AgyPath
    $null = $argList.Add('-AgyPath')
    $null = $argList.Add((Quote-Argument $resolvedAgy))
  }

  Initialize-TaskFolder
  $action = New-ScheduledTaskAction -Execute $script:PowerShellExe `
    -WorkingDirectory $laneRootPath `
    -Argument ($argList.ToArray() -join ' ')
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $ExecutionLimitMinutes)
  $task = New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings
  Register-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -InputObject $task -Force | Out-Null

  $registered = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath
  $info = Get-ScheduledTaskInfo -TaskName $script:TaskName -TaskPath $script:TaskPath
  [Console]::Out.WriteLine('Registered ' + $script:TaskPath + $script:TaskName + ' for ' + $registered.Principal.UserId + '.')
  [Console]::Out.WriteLine('  action:    ' + $registered.Actions[0].Execute + ' ' + $registered.Actions[0].Arguments)
  [Console]::Out.WriteLine('  trigger:   every ' + $IntervalMinutes + ' minutes, first run ' + $registered.Triggers[0].StartBoundary)
  [Console]::Out.WriteLine('  principal: LogonType Interactive, RunLevel Limited (runs while signed in; required for agy auth)')
  [Console]::Out.WriteLine('  limit:     ' + $ExecutionLimitMinutes + ' minutes per tick, MultipleInstances IgnoreNew, StartWhenAvailable')
  [Console]::Out.WriteLine('  lane root: ' + $laneRootPath)
  [Console]::Out.WriteLine('  stop:      create ' + (Join-Path $laneRootPath 'STOP') + ' to pause new sessions; delete it to resume')
  [Console]::Out.WriteLine('  next run:  ' + $info.NextRunTime)
  exit 0
} catch {
  [Console]::Error.WriteLine('Register-HydrogenTask failed: ' + $_.Exception.Message)
  exit 1
}
