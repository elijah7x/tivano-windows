# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-10.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Register-PrReviewTask.ps1 -Root <state root> -Checkout <clone> -StandardCredentialFile <file> [-TokenFile <file>] [-Reference <path>] [-IntervalMinutes 10] [-Unregister]
# Registers or removes the scheduled task \TivanoPrReview\poll under the current user.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root,
  [string]$Checkout,
  [string]$StandardCredentialFile,
  [string]$TokenFile,
  [string]$Reference,
  [string]$DevinModel = 'swe-2-high',
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 10,
  [ValidateRange(1, 20)][int]$MaxPerRun = 1,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$TaskPath = '\TivanoPrReview\'
$TaskName = 'poll'

function Initialize-TaskFolder {
  $service = New-Object -ComObject 'Schedule.Service'
  $root = $null
  try {
    $service.Connect()
    $root = $service.GetFolder('\')
    try { $null = $service.GetFolder('\TivanoPrReview') }
    catch {
      try { $null = $root.CreateFolder('TivanoPrReview') }
      catch { $null = $service.GetFolder('\TivanoPrReview') }
    }
  } finally {
    if ($root) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($root) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($service)
  }
}

function ConvertTo-Literal {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Root)) { throw '-Root is required.' }
  $rootPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Root)
  $rootPath = [IO.Path]::GetFullPath($rootPath).TrimEnd('\')

  if ($Unregister) {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if (-not $task) {
      [Console]::Out.WriteLine('No scheduled task ' + $TaskPath + $TaskName + ' is registered.')
      exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    [Console]::Out.WriteLine('Removed scheduled task ' + $TaskPath + $TaskName + '; run directories and logs under ' + (Join-Path $rootPath 'runs') + ' are left in place.')
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Checkout)) { throw '-Checkout is required to register.' }
  if ([string]::IsNullOrWhiteSpace($StandardCredentialFile)) { throw '-StandardCredentialFile is required to register.' }
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    $null = [IO.Directory]::CreateDirectory($rootPath)
  }
  $checkoutPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Checkout)
  $checkoutPath = [IO.Path]::GetFullPath($checkoutPath).TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $checkoutPath '.git'))) { throw '-Checkout must be the root of a git clone.' }
  $credentialPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StandardCredentialFile)
  $credentialPath = [IO.Path]::GetFullPath($credentialPath)
  if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw '-StandardCredentialFile does not exist.' }
  $referencePath = $null
  if ($Reference) {
    $referencePath = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Reference)).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $referencePath -PathType Container)) { throw '-Reference must be an existing directory.' }
  }

  $invokePath = Join-Path $PSScriptRoot 'Invoke-PrReview.ps1'
  if (-not (Test-Path -LiteralPath $invokePath -PathType Leaf)) { throw 'Invoke-PrReview.ps1 is missing next to this script.' }
  $powershellPath = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $logPath = Join-Path $rootPath 'task.log'
  $wrapperPath = Join-Path $rootPath 'pr-review-task.ps1'

  $invokeArguments = @(
    '-Repo', (ConvertTo-Literal $Repo), '-Root', (ConvertTo-Literal $rootPath),
    '-Checkout', (ConvertTo-Literal $checkoutPath), '-StandardCredentialFile', (ConvertTo-Literal $credentialPath)
  )
  if ($TokenFile) {
    $tokenPath = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($TokenFile))
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw '-TokenFile does not exist.' }
    $invokeArguments += @('-TokenFile', (ConvertTo-Literal $tokenPath))
  }
  if ($referencePath) { $invokeArguments += @('-Reference', (ConvertTo-Literal $referencePath)) }
  $invokeArguments += @('-DevinModel', (ConvertTo-Literal $DevinModel), '-MaxPerRun', [string]$MaxPerRun)

  # The wrapper rotates the log before the run starts: the scheduled action cannot redirect
  # its own stdout, and a log file held open by a redirect cannot be renamed.
  $wrapper = @"
# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-10.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Generated by Register-PrReviewTask.ps1; re-run that script instead of editing this file.
`$ErrorActionPreference = 'Continue'
`$Log = $(ConvertTo-Literal $logPath)
if ((Test-Path -LiteralPath `$Log) -and ((Get-Item -LiteralPath `$Log).Length -ge 5MB)) {
  Move-Item -LiteralPath `$Log -Destination (`$Log + '.1') -Force
}
& $(ConvertTo-Literal $powershellPath) -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $(ConvertTo-Literal $invokePath) $($invokeArguments -join ' ') 2>&1 |
  Out-File -LiteralPath `$Log -Append -Encoding UTF8
exit `$LASTEXITCODE
"@
  [IO.File]::WriteAllText($wrapperPath, ($wrapper -replace '\r?\n', "`r`n"), (New-Object Text.UTF8Encoding($true)))

  Initialize-TaskFolder
  $action = New-ScheduledTaskAction -Execute $powershellPath -WorkingDirectory $rootPath `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapperPath + '"')
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
  # An omitted repetition duration means the repetition never expires.
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4)
  $task = New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings
  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null

  $registered = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
  [Console]::Out.WriteLine('Registered ' + $TaskPath + $TaskName + ' for ' + $registered.Principal.UserId + '.')
  [Console]::Out.WriteLine('  action:    ' + $registered.Actions[0].Execute + ' ' + $registered.Actions[0].Arguments)
  [Console]::Out.WriteLine('  trigger:   every ' + $IntervalMinutes + ' minutes, first run ' + $registered.Triggers[0].StartBoundary)
  [Console]::Out.WriteLine('  principal: LogonType Interactive, RunLevel Limited (runs while that user is signed in; no password stored)')
  [Console]::Out.WriteLine('  limit:     4 hours, MultipleInstances IgnoreNew')
  [Console]::Out.WriteLine('  wrapper:   ' + $wrapperPath)
  [Console]::Out.WriteLine('  log:       ' + $logPath + ' (rotated to task.log.1 at 5 MB)')
  [Console]::Out.WriteLine('  state:     ' + (Join-Path $rootPath 'state.json') + ', runs in ' + (Join-Path $rootPath 'runs'))
  [Console]::Out.WriteLine('  next run:  ' + $info.NextRunTime)
  exit 0
} catch {
  [Console]::Error.WriteLine('Register-PrReviewTask failed: ' + $_.Exception.Message)
  exit 1
}
