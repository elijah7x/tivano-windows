# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Register-HydrogenTask.ps1 [-ScriptDir <synced dev-loop dir>] [-LaneRoot <dir>] [-Lanes h1,h2,h3] [-GateRoot <dir>] [-ReferenceRoot <dir>] [-Repo <owner/name>] [-Model <id>] [-Label <label>] [-IntervalMinutes 15] [-MaxOpenPrs 2] [-DailyMergeCap 150] [-PrintTimeoutMinutes 150] [-HardKillMinutes 170] [-CooldownHours 6] [-AgyPath <exe>] [-Unregister]
# Registers or removes the scheduled tasks \TivanoDevLoop\hydrogen-<lane> under the current user with an Interactive principal.

param(
  [string]$ScriptDir = 'C:\tivano\audit\tool\scripts\dev-loop',
  [string]$LaneRoot = 'C:\tivano\dev-loop\hydrogen',
  [string[]]$Lanes = @('h1', 'h2', 'h3'),
  [string]$GateRoot = 'C:\tivano\dev-loop\autopilot\gate',
  [string]$ReferenceRoot = 'C:\tivano\reference\tivano-v3.0.26',
  [string]$Repo = 'elijah7x/tivano-windows',
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$Model = 'gemini-4-hydrogen-high',
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Label = 'nyx-auto',
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [ValidateRange(5, 240)][int]$ExecutionLimitMinutes = 30,
  [ValidateRange(1, 10)][int]$MaxOpenPrs = 2,
  [ValidateRange(1, 500)][int]$DailyMergeCap = 150,
  [ValidateRange(5, 480)][int]$PrintTimeoutMinutes = 150,
  [ValidateRange(10, 600)][int]$HardKillMinutes = 170,
  [ValidateRange(1, 48)][int]$CooldownHours = 6,
  [string]$AgyPath = '',
  [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskPath = '\TivanoDevLoop\'
$script:LegacyTaskName = 'hydrogen'
$script:TaskPrefix = 'hydrogen-'
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

function Resolve-LaneIds {
  param([string[]]$RawLanes)
  $result = New-Object Collections.Generic.List[string]
  $seen = @{}
  foreach ($entry in @($RawLanes)) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    foreach ($part in ($entry -split ',')) {
      $trimmed = $part.Trim().ToLowerInvariant()
      if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
      if ($trimmed -notmatch '^[a-z0-9][a-z0-9_-]{0,15}$') {
        throw ('Invalid lane id: ' + $trimmed + ' (expected ^[a-z0-9][a-z0-9_-]{0,15}$).')
      }
      if ($seen.ContainsKey($trimmed)) {
        throw ('Duplicate lane id: ' + $trimmed)
      }
      $seen[$trimmed] = $true
      $null = $result.Add($trimmed)
    }
  }
  if ($result.Count -eq 0) {
    throw 'At least one lane id is required in -Lanes.'
  }
  return [string[]]$result.ToArray()
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }

  $laneRootPath = Resolve-FullPath $LaneRoot

  if ($Unregister) {
    $matching = @(Get-ScheduledTask -TaskPath $script:TaskPath -ErrorAction SilentlyContinue |
      Where-Object {
        $_.TaskName.Equals($script:LegacyTaskName, [StringComparison]::OrdinalIgnoreCase) -or
        $_.TaskName.StartsWith($script:TaskPrefix, [StringComparison]::OrdinalIgnoreCase)
      } | Sort-Object TaskName)
    if ($matching.Count -eq 0) {
      [Console]::Out.WriteLine('No scheduled tasks matching ' + $script:TaskPath + $script:LegacyTaskName + ' or ' + $script:TaskPath + $script:TaskPrefix + '* are registered.')
      exit 0
    }
    $removed = New-Object Collections.Generic.List[string]
    foreach ($t in $matching) {
      Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $script:TaskPath -Confirm:$false
      $null = $removed.Add($script:TaskPath + $t.TaskName)
    }
    [Console]::Out.WriteLine('Removed scheduled tasks: ' + ($removed.ToArray() -join ', ') + '; clones, worktrees, state, claims and logs under ' + $laneRootPath + ' are left in place.')
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw '-Repo must be owner/name.'
  }

  $resolvedLanes = @(Resolve-LaneIds -RawLanes $Lanes)

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

  $claimsDir = Join-Path $laneRootPath 'claims'
  $lanesRoot = Join-Path $laneRootPath 'lanes'
  [IO.Directory]::CreateDirectory($laneRootPath) | Out-Null
  [IO.Directory]::CreateDirectory((Join-Path $laneRootPath 'state')) | Out-Null
  [IO.Directory]::CreateDirectory($claimsDir) | Out-Null
  [IO.Directory]::CreateDirectory($lanesRoot) | Out-Null
  foreach ($laneId in $resolvedLanes) {
    [IO.Directory]::CreateDirectory((Join-Path $lanesRoot $laneId)) | Out-Null
  }

  $resolvedAgy = ''
  if (-not [string]::IsNullOrWhiteSpace($AgyPath)) {
    $resolvedAgy = Resolve-FullPath $AgyPath
  }

  Initialize-TaskFolder

  $legacyTask = Get-ScheduledTask -TaskName $script:LegacyTaskName -TaskPath $script:TaskPath -ErrorAction SilentlyContinue
  if ($null -ne $legacyTask) {
    Unregister-ScheduledTask -TaskName $script:LegacyTaskName -TaskPath $script:TaskPath -Confirm:$false
    [Console]::Out.WriteLine('Removed legacy scheduled task ' + $script:TaskPath + $script:LegacyTaskName + '.')
  }

  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $ExecutionLimitMinutes)

  $staggerMinutes = [int][Math]::Floor($IntervalMinutes / $resolvedLanes.Count)
  $baseStart = (Get-Date).AddMinutes(1)

  for ($i = 0; $i -lt $resolvedLanes.Count; $i++) {
    $laneId = $resolvedLanes[$i]
    $taskName = $script:TaskPrefix + $laneId
    $startAt = $baseStart.AddMinutes($i * $staggerMinutes)

    $argList = New-Object Collections.Generic.List[string]
    foreach ($item in @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', (Quote-Argument $workerScript),
      '-Repo', (Quote-Argument $Repo),
      '-LaneId', (Quote-Argument $laneId),
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
    if (-not [string]::IsNullOrWhiteSpace($resolvedAgy)) {
      $null = $argList.Add('-AgyPath')
      $null = $argList.Add((Quote-Argument $resolvedAgy))
    }

    $action = New-ScheduledTaskAction -Execute $script:PowerShellExe `
      -WorkingDirectory $laneRootPath `
      -Argument ($argList.ToArray() -join ' ')
    $trigger = New-ScheduledTaskTrigger -Once -At $startAt `
      -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $task = New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings
    Register-ScheduledTask -TaskName $taskName -TaskPath $script:TaskPath -InputObject $task -Force | Out-Null

    $registered = Get-ScheduledTask -TaskName $taskName -TaskPath $script:TaskPath
    $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $script:TaskPath
    [Console]::Out.WriteLine('Registered ' + $script:TaskPath + $taskName + ' for ' + $registered.Principal.UserId + ' (lane ' + $laneId + ').')
    [Console]::Out.WriteLine('  action:    ' + $registered.Actions[0].Execute + ' ' + $registered.Actions[0].Arguments)
    [Console]::Out.WriteLine('  trigger:   every ' + $IntervalMinutes + ' minutes (stagger ' + $staggerMinutes + 'm), first run ' + $registered.Triggers[0].StartBoundary)
    [Console]::Out.WriteLine('  next run:  ' + $info.NextRunTime)
  }

  [Console]::Out.WriteLine('  principal: LogonType Interactive, RunLevel Limited (runs while signed in; required for agy auth)')
  [Console]::Out.WriteLine('  limit:     ' + $ExecutionLimitMinutes + ' minutes per tick, MultipleInstances IgnoreNew, StartWhenAvailable')
  [Console]::Out.WriteLine('  fleet root:' + ' ' + $laneRootPath)
  [Console]::Out.WriteLine('  claims:    ' + $claimsDir)
  [Console]::Out.WriteLine('  stop:      create ' + (Join-Path $laneRootPath 'STOP') + ' to pause all lanes, or ' + (Join-Path $lanesRoot '<lane>\STOP') + ' to pause one lane')
  exit 0
} catch {
  [Console]::Error.WriteLine('Register-HydrogenTask failed: ' + $_.Exception.Message)
  exit 1
}
