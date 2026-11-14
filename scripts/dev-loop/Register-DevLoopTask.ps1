# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-14.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Register-DevLoopTask.ps1 -Root <state root> -Checkout <clone> -ReviewRoot <pr-review state root> -StandardCredentialFile <file> [-ReviewCheckout <clone>] [-ReviewTokenFile <file>] [-Reference <path>] [-IntervalMinutes 30] [-Unregister]
# Registers or removes the scheduled task \TivanoDevLoop\run under the current user.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root,
  [string]$Checkout,
  [string]$ReviewRoot,
  [string]$ReviewCheckout,
  [string]$StandardCredentialFile,
  [string]$ReviewTokenFile,
  [string]$Reference,
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$DevinModel = 'swe-2-high',
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Label = 'nyx-auto',
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 30,
  [ValidateRange(1, 720)][int]$ExecutionLimitHours = 72,
  [ValidateRange(1, 200)][int]$MaxIssuesPerRun = 50,
  [ValidateRange(1, 200)][int]$MaxMergesPerDay = 20,
  [ValidateRange(0, 5)][int]$MaxFixRounds = 2,
  [ValidateRange(5, 480)][int]$DevinTimeoutMin = 90,
  [ValidateRange(5, 240)][int]$StallMinutes = 20,
  [int]$TrackingIssue = 0,
  [ValidateSet('gui', 'cli')][string]$DevinFrontEnd = 'gui',
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$TaskPath = '\TivanoDevLoop\'
$TaskName = 'run'

function Initialize-TaskFolder {
  $service = New-Object -ComObject 'Schedule.Service'
  $root = $null
  try {
    $service.Connect()
    $root = $service.GetFolder('\')
    try { $null = $service.GetFolder('\TivanoDevLoop') }
    catch {
      try { $null = $root.CreateFolder('TivanoDevLoop') }
      catch { $null = $service.GetFolder('\TivanoDevLoop') }
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

function Resolve-FullPath {
  param([string]$Path)
  return [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)).TrimEnd('\')
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Root)) { throw '-Root is required.' }
  $rootPath = Resolve-FullPath $Root

  if ($Unregister) {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if (-not $task) {
      [Console]::Out.WriteLine('No scheduled task ' + $TaskPath + $TaskName + ' is registered.')
      exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    [Console]::Out.WriteLine('Removed scheduled task ' + $TaskPath + $TaskName + '; run directories, worktrees and logs under ' + $rootPath + ' are left in place.')
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Checkout)) { throw '-Checkout is required to register.' }
  if ([string]::IsNullOrWhiteSpace($ReviewRoot)) { throw '-ReviewRoot is required to register.' }
  if ([string]::IsNullOrWhiteSpace($StandardCredentialFile)) { throw '-StandardCredentialFile is required to register.' }

  # The runner treats the directory that contains scripts\ as the repository and refuses state inside it.
  $repositoryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
  if ($rootPath.Equals($repositoryPath, [StringComparison]::OrdinalIgnoreCase) -or
      $rootPath.StartsWith($repositoryPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '-Root must be outside the repository that contains these scripts.'
  }
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    $null = [IO.Directory]::CreateDirectory($rootPath)
  }
  $checkoutPath = Resolve-FullPath $Checkout
  if (-not (Test-Path -LiteralPath (Join-Path $checkoutPath '.git'))) { throw '-Checkout must be the root of a git clone.' }
  $reviewRootPath = Resolve-FullPath $ReviewRoot
  if ($reviewRootPath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) { throw '-ReviewRoot must differ from -Root.' }
  $credentialPath = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StandardCredentialFile))
  if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw '-StandardCredentialFile does not exist.' }
  $reviewCheckoutPath = $null
  if ($ReviewCheckout) {
    $reviewCheckoutPath = Resolve-FullPath $ReviewCheckout
    if (-not (Test-Path -LiteralPath (Join-Path $reviewCheckoutPath '.git'))) { throw '-ReviewCheckout must be the root of a git clone.' }
  }
  $referencePath = $null
  if ($Reference) {
    $referencePath = Resolve-FullPath $Reference
    if (-not (Test-Path -LiteralPath $referencePath -PathType Container)) { throw '-Reference must be an existing directory.' }
  }

  $invokePath = Join-Path $PSScriptRoot 'Invoke-DevLoop.ps1'
  if (-not (Test-Path -LiteralPath $invokePath -PathType Leaf)) { throw 'Invoke-DevLoop.ps1 is missing next to this script.' }
  $powershellPath = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $logPath = Join-Path $rootPath 'task.log'
  $wrapperPath = Join-Path $rootPath 'dev-loop-task.ps1'

  $invokeArguments = @(
    '-Repo', (ConvertTo-Literal $Repo), '-Root', (ConvertTo-Literal $rootPath),
    '-Checkout', (ConvertTo-Literal $checkoutPath), '-ReviewRoot', (ConvertTo-Literal $reviewRootPath),
    '-StandardCredentialFile', (ConvertTo-Literal $credentialPath)
  )
  if ($reviewCheckoutPath) { $invokeArguments += @('-ReviewCheckout', (ConvertTo-Literal $reviewCheckoutPath)) }
  if ($ReviewTokenFile) {
    $tokenPath = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ReviewTokenFile))
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw '-ReviewTokenFile does not exist.' }
    $invokeArguments += @('-ReviewTokenFile', (ConvertTo-Literal $tokenPath))
  }
  if ($referencePath) { $invokeArguments += @('-Reference', (ConvertTo-Literal $referencePath)) }
  $invokeArguments += @(
    '-DevinModel', (ConvertTo-Literal $DevinModel), '-Label', (ConvertTo-Literal $Label),
    '-MaxIssuesPerRun', [string]$MaxIssuesPerRun, '-MaxMergesPerDay', [string]$MaxMergesPerDay,
    '-MaxFixRounds', [string]$MaxFixRounds, '-DevinTimeoutMin', [string]$DevinTimeoutMin,
    '-StallMinutes', [string]$StallMinutes, '-TrackingIssue', [string]$TrackingIssue,
    '-DevinFrontEnd', $DevinFrontEnd
  )

  # The wrapper rotates the log before the run starts: the scheduled action cannot redirect
  # its own stdout, and a log file held open by a redirect cannot be renamed.
  $wrapper = @"
# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-14.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Generated by Register-DevLoopTask.ps1; re-run that script instead of editing this file.
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
    -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours $ExecutionLimitHours)
  $task = New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings
  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null

  $registered = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
  [Console]::Out.WriteLine('Registered ' + $TaskPath + $TaskName + ' for ' + $registered.Principal.UserId + '.')
  [Console]::Out.WriteLine('  action:    ' + $registered.Actions[0].Execute + ' ' + $registered.Actions[0].Arguments)
  [Console]::Out.WriteLine('  trigger:   every ' + $IntervalMinutes + ' minutes, first run ' + $registered.Triggers[0].StartBoundary)
  [Console]::Out.WriteLine('  principal: LogonType Interactive, RunLevel Limited (runs while that user is signed in; no password stored)')
  [Console]::Out.WriteLine('  limit:     ' + $ExecutionLimitHours + ' hours, MultipleInstances IgnoreNew')
  [Console]::Out.WriteLine('  pass:      up to ' + $MaxIssuesPerRun + ' issues, ' + $MaxMergesPerDay + ' merges/day, ' + $StallMinutes + 'm stall, tracking #' + $TrackingIssue + ' (0 = auto)')
  [Console]::Out.WriteLine('  wrapper:   ' + $wrapperPath)
  [Console]::Out.WriteLine('  log:       ' + $logPath + ' (rotated to task.log.1 at 5 MB), per-day logs in ' + (Join-Path $rootPath 'logs'))
  [Console]::Out.WriteLine('  state:     ' + (Join-Path $rootPath 'state.json') + ', runs in ' + (Join-Path $rootPath 'runs'))
  [Console]::Out.WriteLine('  stop:      create ' + (Join-Path $rootPath 'STOP') + ' to stop between issues and make new runs exit at once; delete it to resume')
  [Console]::Out.WriteLine('  next run:  ' + $info.NextRunTime)
  exit 0
} catch {
  [Console]::Error.WriteLine('Register-DevLoopTask failed: ' + $_.Exception.Message)
  exit 1
}
