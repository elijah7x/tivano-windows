# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-21.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Register-AuditTasks.ps1 [-ConfigPath <path>] [-RunAsUser <user>] [-Unregister]
# Idempotently registers or removes \TivanoAudit\pr (every 10 minutes) and \TivanoAudit\postmerge (daily 03:00).

param(
  [string]$ConfigPath = 'C:\tivano\audit\config.json',
  [string]$RunAsUser = '',
  [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskPath = '\TivanoAudit\'
$PrTaskName = 'pr'
$PostMergeTaskName = 'postmerge'

function Initialize-TaskFolder {
  $service = New-Object -ComObject 'Schedule.Service'
  $root = $null
  try {
    $service.Connect()
    $root = $service.GetFolder('\')
    try { $null = $service.GetFolder('\TivanoAudit') }
    catch {
      try { $null = $root.CreateFolder('TivanoAudit') }
      catch { $null = $service.GetFolder('\TivanoAudit') }
    }
  } finally {
    if ($root) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($root) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($service)
  }
}

function Resolve-FullPath {
  param([string]$Path)
  return [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)).TrimEnd('\')
}

function Remove-TaskIfPresent {
  param([string]$Name)
  $existing = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if (-not $existing) {
    [Console]::Out.WriteLine('No scheduled task ' + $TaskPath + $Name + ' is registered.')
    return
  }
  Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false
  [Console]::Out.WriteLine('Removed scheduled task ' + $TaskPath + $Name + '.')
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows is required.'
  }

  if ($Unregister) {
    Remove-TaskIfPresent $PrTaskName
    Remove-TaskIfPresent $PostMergeTaskName
    [Console]::Out.WriteLine('Config, key, state and logs were left in place.')
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    throw '-ConfigPath is required.'
  }
  $configFullPath = Resolve-FullPath $ConfigPath
  if (-not (Test-Path -LiteralPath $configFullPath -PathType Leaf)) {
    throw ('Config file does not exist: ' + $configFullPath)
  }

  $prScriptPath = Join-Path $PSScriptRoot 'Invoke-Audit.ps1'
  $postScriptPath = Join-Path $PSScriptRoot 'Invoke-PostMergeAudit.ps1'
  if (-not (Test-Path -LiteralPath $prScriptPath -PathType Leaf)) {
    throw ('Invoke-Audit.ps1 is missing next to this script: ' + $prScriptPath)
  }
  if (-not (Test-Path -LiteralPath $postScriptPath -PathType Leaf)) {
    throw ('Invoke-PostMergeAudit.ps1 is missing next to this script: ' + $postScriptPath)
  }

  $configObj = $null
  try {
    $configObj = [IO.File]::ReadAllText($configFullPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw ('Failed to parse JSON in ' + $configFullPath + ': ' + $_.Exception.Message)
  }

  $workRoot = $null
  if ($configObj.PSObject.Properties['workRoot'] -and -not [string]::IsNullOrWhiteSpace([string]$configObj.workRoot)) {
    $workRoot = Resolve-FullPath ([string]$configObj.workRoot)
    if (-not (Test-Path -LiteralPath $workRoot -PathType Container)) {
      [IO.Directory]::CreateDirectory($workRoot) | Out-Null
    }
  } else {
    $workRoot = $PSScriptRoot
  }

  $keyPath = '<keyPath>'
  if ($configObj.PSObject.Properties['keyPath'] -and -not [string]::IsNullOrWhiteSpace([string]$configObj.keyPath)) {
    $keyPath = [string]$configObj.keyPath
  }

  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $targetUser = if ([string]::IsNullOrWhiteSpace($RunAsUser)) { $currentUser } else { $RunAsUser.Trim() }
  $logonType = if ($targetUser.Equals($currentUser, [StringComparison]::OrdinalIgnoreCase)) { 'Interactive' } else { 'S4U' }

  $powershellPath = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'

  Initialize-TaskFolder

  $principal = New-ScheduledTaskPrincipal -UserId $targetUser -LogonType $logonType -RunLevel Limited

  # 1. \TivanoAudit\pr -- every 10 minutes
  $prArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $prScriptPath + '" -ConfigPath "' + $configFullPath + '"'
  $prAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $prArgs -WorkingDirectory $workRoot
  $prTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
  $prSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  $prTask = New-ScheduledTask -Action $prAction -Principal $principal -Trigger $prTrigger -Settings $prSettings
  Register-ScheduledTask -TaskName $PrTaskName -TaskPath $TaskPath -InputObject $prTask -Force | Out-Null

  # 2. \TivanoAudit\postmerge -- daily at 03:00. A day of merges takes several hours to audit
  # (about 10 minutes each), so the limit only has to stop a run before the next day's start.
  $postArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $postScriptPath + '" -ConfigPath "' + $configFullPath + '"'
  $postAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $postArgs -WorkingDirectory $workRoot
  $postTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
  $postSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 20)
  $postTask = New-ScheduledTask -Action $postAction -Principal $principal -Trigger $postTrigger -Settings $postSettings
  Register-ScheduledTask -TaskName $PostMergeTaskName -TaskPath $TaskPath -InputObject $postTask -Force | Out-Null

  $prReg = Get-ScheduledTask -TaskName $PrTaskName -TaskPath $TaskPath
  $prInfo = Get-ScheduledTaskInfo -TaskName $PrTaskName -TaskPath $TaskPath
  $postReg = Get-ScheduledTask -TaskName $PostMergeTaskName -TaskPath $TaskPath
  $postInfo = Get-ScheduledTaskInfo -TaskName $PostMergeTaskName -TaskPath $TaskPath

  [Console]::Out.WriteLine('Registered ' + $TaskPath + $PrTaskName + ' for ' + $prReg.Principal.UserId + ' (' + $logonType + ', Limited):')
  [Console]::Out.WriteLine('  action:   ' + $prReg.Actions[0].Execute + ' ' + $prReg.Actions[0].Arguments)
  [Console]::Out.WriteLine('  trigger:  every 10 minutes, next run ' + $prInfo.NextRunTime)
  [Console]::Out.WriteLine('Registered ' + $TaskPath + $PostMergeTaskName + ' for ' + $postReg.Principal.UserId + ' (' + $logonType + ', Limited):')
  [Console]::Out.WriteLine('  action:   ' + $postReg.Actions[0].Execute + ' ' + $postReg.Actions[0].Arguments)
  [Console]::Out.WriteLine('  trigger:  daily at 03:00, next run ' + $postInfo.NextRunTime)
  [Console]::Out.WriteLine('')
  [Console]::Out.WriteLine('SECURITY REMINDER: Restrict NTFS permissions on the GitHub App private key file so only the audit user (and SYSTEM/Administrators) can read it:')
  [Console]::Out.WriteLine('  icacls "' + $keyPath + '" /inheritance:r /grant:r "' + $targetUser + ':R" "*S-1-5-18:F" "*S-1-5-32-544:F"')
  exit 0
} catch {
  [Console]::Error.WriteLine('Register-AuditTasks failed: ' + $_.Exception.Message)
  exit 1
}
