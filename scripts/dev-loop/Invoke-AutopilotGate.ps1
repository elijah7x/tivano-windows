# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-16.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-AutopilotGate.ps1 -PrNumber <n> -ReviewRoot <pr-review state root> -StandardCredentialFile <file> [-ReviewCheckout <clone>] [-ReviewTokenFile <file>] [-Reference <macOS baseline clone>] [-Repo <owner/name>] [-Root <state root>] [-DevinModel <model>] [-ReviewTimeoutMin <min>]
# Runs Invoke-PrReview.ps1 (with posting enabled and -Force) for one PR, evaluates gate.json with the dev-loop merge gate rules, and emits one compact JSON summary line to stdout.

param(
  [int]$PrNumber = 0,
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root = 'C:\tivano\dev-loop',
  [string]$ReviewRoot,
  [string]$ReviewCheckout,
  [string]$StandardCredentialFile,
  [string]$ReviewTokenFile,
  [string]$Reference,
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$DevinModel = 'swe-2-high',
  [ValidateRange(1, 720)][int]$ReviewTimeoutMin = 240
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$script:ReviewScript = Join-Path $PSScriptRoot '..\pr-review\Invoke-PrReview.ps1'
$script:AcceptanceRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')

$script:GhPath = $null
$script:WorkRoot = $null
$script:RunDir = $null
$script:LogPath = $null
$script:ReviewRootPath = $null
$script:ReviewCheckoutPath = $null
$script:CredentialPath = $null
$script:ReviewTokenPath = $null
$script:ReferencePath = $null

function Write-Text {
  param([string]$Path, [AllowEmptyString()][string]$Text)
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Read-Text {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Quote-Argument {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function Write-Log {
  param([string]$Message)
  if (-not $script:LogPath) { return }
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $Message + "`r`n"
  try { [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false))) } catch { }
}

function Get-AcceptancePath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A non-empty path is required.' }
  $providerInfo = $null
  $driveInfo = $null
  $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$providerInfo, [ref]$driveInfo)
  if ($providerInfo.Name -ne 'FileSystem') { throw 'A filesystem path is required.' }
  $full = [IO.Path]::GetFullPath($full)
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

function Assert-OutsideGitCheckout {
  param([string]$Path)
  $part = $Path
  while ($part) {
    if (Test-Path -LiteralPath (Join-Path $part '.git')) {
      throw "$Path is inside a git checkout ($part). Keep state and logs outside any checkout."
    }
    $parent = Split-Path -Parent $part
    if (-not $parent -or $parent -eq $part) { break }
    $part = $parent
  }
}

function Assert-AcceptanceOutsideRepo {
  param([string]$Path, [string[]]$Repositories = @($script:AcceptanceRepo))
  foreach ($repository in $Repositories) {
    $repoFull = Get-AcceptancePath $repository
    if ($Path.Equals($repoFull, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Gate state and logs must be outside the repository.'
    }
  }
}

function Assert-CmdSafePath {
  param([string]$Name, [string]$Path)
  if ($Path.Contains('%') -or $Path.Contains('"') -or $Path.Contains("`r") -or $Path.Contains("`n")) {
    throw "$Name cannot contain percent signs, quotes or newlines."
  }
}

function ConvertTo-SingleLine {
  param([AllowEmptyString()][string]$Text, [int]$Limit)
  if ($null -eq $Text) { return '' }
  $line = [regex]::Replace($Text, '[\x00-\x1f\x7f]+', ' ')
  $line = [regex]::Replace($line, '\s+', ' ').Trim()
  $line = $line.Replace('"', "'").TrimEnd('\')
  if ($line.Length -gt $Limit) { $line = $line.Substring(0, $Limit).Trim() }
  return $line
}

function Get-ErrorSummary {
  param($Result)
  $text = [string]$Result.error
  if ([string]::IsNullOrWhiteSpace($text)) { $text = [string]$Result.text }
  $text = $text.Trim()
  if ($text.Length -gt 300) { $text = $text.Substring(0, 300) }
  return $text
}

function Get-Tail {
  param([string]$Path, [int]$Count)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return '' }
  $lines = @($text.TrimEnd() -split "`r?`n")
  if ($lines.Count -le $Count) { return ($lines -join "`n") }
  return (($lines[($lines.Count - $Count)..($lines.Count - 1)]) -join "`n")
}

function Read-JsonFile {
  param([string]$Path)
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Get-JsonProp {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $null
}

function ConvertTo-StringList {
  param($Value)
  if ($null -eq $Value) { return @() }
  return @($Value | ForEach-Object { [string]$_ } | Where-Object { $_ })
}

function Get-LabelNames {
  param($Labels)
  if ($null -eq $Labels) { return @() }
  return @($Labels | ForEach-Object { [string](Get-JsonProp $_ 'name') } | Where-Object { $_ })
}

# Raw-byte redirection: git and gh write UTF-8, which PowerShell 5.1 would otherwise decode with the console code page.
function Invoke-Tool {
  param([string]$FilePath, [string]$Arguments, [string]$OutPath, [string]$ErrPath, [string]$WorkingDirectory)
  $parameters = @{
    FilePath = $FilePath; ArgumentList = $Arguments; RedirectStandardOutput = $OutPath
    RedirectStandardError = $ErrPath; WindowStyle = 'Hidden'; Wait = $true; PassThru = $true
  }
  if ($WorkingDirectory) { $parameters['WorkingDirectory'] = $WorkingDirectory }
  $process = Start-Process @parameters
  return $process.ExitCode
}

# Connection-level failures only, where the request most likely never reached GitHub.
function Test-NetworkFailure {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bEOF\b|handshake|schannel|Could not resolve host|Failed to connect|connection (was )?(reset|refused|closed)|i/o timeout|TLS|unable to access|error connecting to|no such host')
}

# Runs from the state root, which is never a git checkout, so gh never reads repository context from the cwd.
function Invoke-Gh {
  param([string]$Arguments)
  $tmpBase = if ($script:RunDir) { $script:RunDir } else { $script:WorkRoot }
  $out = Join-Path $tmpBase '.gh.out.tmp'
  $err = Join-Path $tmpBase '.gh.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GhPath $Arguments $out $err $script:WorkRoot
    $result = [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $result.error)) { return $result }
    Write-Log ('gh network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine ([string]$result.error) 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Get-PrInfo {
  param([int]$Number)
  $result = Invoke-Gh ('pr view ' + $Number + ' -R ' + $Repo + ' --json state,headRefOid,headRefName,isDraft,isCrossRepository,mergeable,labels,title,body,author,baseRefName')
  if ($result.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.text)) { return $null }
  try { $data = $result.text | ConvertFrom-Json } catch { return $null }
  $authorObj = Get-JsonProp $data 'author'
  return [pscustomobject]@{
    number = $Number
    state = [string](Get-JsonProp $data 'state')
    headSha = [string](Get-JsonProp $data 'headRefOid')
    branch = [string](Get-JsonProp $data 'headRefName')
    draft = [bool](Get-JsonProp $data 'isDraft')
    cross = [bool](Get-JsonProp $data 'isCrossRepository')
    mergeable = [string](Get-JsonProp $data 'mergeable')
    labels = @(Get-LabelNames (Get-JsonProp $data 'labels'))
    title = [string](Get-JsonProp $data 'title')
    body = [string](Get-JsonProp $data 'body')
    author = [string](Get-JsonProp $authorObj 'login')
    base = [string](Get-JsonProp $data 'baseRefName')
  }
}

function Invoke-Review {
  param([int]$Pr, [string]$Sha, [string]$RunDir, [bool]$NoPost, [string]$Tag)
  $outLog = Join-Path $RunDir ('review-' + $Tag + '.out.log')
  $errLog = Join-Path $RunDir ('review-' + $Tag + '.err.log')
  $inner = (Quote-Argument $script:PowerShellExe) + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $script:ReviewScript) +
    ' -Repo ' + $Repo + ' -Root ' + (Quote-Argument $script:ReviewRootPath) + ' -Checkout ' + (Quote-Argument $script:ReviewCheckoutPath) +
    ' -StandardCredentialFile ' + (Quote-Argument $script:CredentialPath) + ' -DevinModel ' + $DevinModel +
    ' -PrNumber ' + $Pr + ' -Force'
  if ($script:ReviewTokenPath) { $inner += ' -TokenFile ' + (Quote-Argument $script:ReviewTokenPath) }
  if ($script:ReferencePath) { $inner += ' -Reference ' + (Quote-Argument $script:ReferencePath) }
  if ($NoPost) { $inner += ' -DryRun' }
  $inner += ' > ' + (Quote-Argument $outLog) + ' 2> ' + (Quote-Argument $errLog)
  Write-Log ('review pr #' + $Pr + ' head ' + $Sha.Substring(0, 7) + ' (' + $Tag + ')')
  # The review runs in a one-off scheduled task rather than as a child of this process: started from inside a
  # Devin Desktop chat, the reviewer Devin CLI inherits that session's environment and reports "Not logged in".
  $doneFile = Join-Path $RunDir ('review-' + $Tag + '.done')
  $cmdFile = Join-Path $RunDir ('review-' + $Tag + '.cmd')
  Remove-Item -LiteralPath $doneFile -Force -ErrorAction SilentlyContinue
  Write-Text $cmdFile ('@echo off' + "`r`n" + 'cd /d ' + (Quote-Argument $script:WorkRoot) + "`r`n" + $inner + "`r`n" + 'echo %ERRORLEVEL%> ' + (Quote-Argument $doneFile) + "`r`n")
  $taskName = 'gate-pr-' + $Pr + '-' + $Tag
  $action = New-ScheduledTaskAction -Execute $script:CmdExe -Argument ('/d /c "' + $cmdFile + '"') -WorkingDirectory $script:WorkRoot
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ($ReviewTimeoutMin + 5)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  try {
    Start-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddMinutes($ReviewTimeoutMin)
    while (-not (Test-Path -LiteralPath $doneFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Seconds 10 }
    if (-not (Test-Path -LiteralPath $doneFile)) {
      Stop-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName -ErrorAction SilentlyContinue
      return [pscustomobject]@{ status = 'unavailable'; message = 'the review run timed out'; gate = $null; gatePath = $null }
    }
  } finally {
    Unregister-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }

  $summary = $null
  try {
    $tail = Get-Tail $outLog 1
    if (-not [string]::IsNullOrWhiteSpace($tail)) { $summary = $tail | ConvertFrom-Json }
  } catch { }
  if (-not $summary) {
    return [pscustomobject]@{ status = 'unavailable'; message = 'the review run printed no summary'; gate = $null; gatePath = $null }
  }
  $skippedRaw = Get-JsonProp $summary 'skipped'
  $reviewedRaw = Get-JsonProp $summary 'reviewed'
  $errorsRaw = Get-JsonProp $summary 'errors'
  $skippedList = if ($null -ne $skippedRaw) { @($skippedRaw | ForEach-Object { $_ }) } else { @() }
  $reviewedList = if ($null -ne $reviewedRaw) { @($reviewedRaw | ForEach-Object { $_ }) } else { @() }
  $errorList = if ($null -ne $errorsRaw) { @($errorsRaw | ForEach-Object { $_ }) } else { @() }

  foreach ($skipped in $skippedList) {
    $skippedPr = Get-JsonProp $skipped 'pr'
    $skippedReason = [string](Get-JsonProp $skipped 'reason')
    if ($null -eq $skippedPr -and $skippedReason -like '*lock*') {
      return [pscustomobject]@{ status = 'busy'; message = 'another review holds the reviewer lock'; gate = $null; gatePath = $null }
    }
  }
  $gatePath = $null
  $message = ''
  foreach ($entry in $reviewedList) {
    $entryPr = Get-JsonProp $entry 'pr'
    $entryGatePath = Get-JsonProp $entry 'gatePath'
    if ($null -ne $entryPr -and [int]$entryPr -eq $Pr -and $null -ne $entryGatePath) {
      $gatePath = [string]$entryGatePath
    }
  }
  if (-not $gatePath) {
    foreach ($entry in $errorList) {
      $entryPr = Get-JsonProp $entry 'pr'
      if ($null -ne $entryPr -and [int]$entryPr -ne $Pr) { continue }
      $message = [string](Get-JsonProp $entry 'error')
      $entryGatePath = Get-JsonProp $entry 'gatePath'
      if ($null -ne $entryPr -and $null -ne $entryGatePath) { $gatePath = [string]$entryGatePath }
    }
  }
  if (-not $gatePath) {
    foreach ($skipped in $skippedList) {
      $skippedPr = Get-JsonProp $skipped 'pr'
      if ($null -ne $skippedPr -and [int]$skippedPr -eq $Pr) { $message = [string](Get-JsonProp $skipped 'reason') }
    }
    if (-not $message) { $message = 'the review run reported no result for this PR' }
    return [pscustomobject]@{ status = 'unavailable'; message = $message; gate = $null; gatePath = $null }
  }
  $gate = Read-JsonFile $gatePath
  if (-not $gate -or [string](Get-JsonProp $gate 'headSha') -ne $Sha) {
    return [pscustomobject]@{ status = 'unavailable'; message = 'gate.json is missing or is for another head'; gate = $null; gatePath = $null }
  }
  return [pscustomobject]@{ status = 'ok'; message = $message; gate = $gate; gatePath = $gatePath }
}

function Format-Step {
  param($Value)
  if ($null -eq $Value) { return 'not run' }
  return [string]$Value
}

function Test-GateResult {
  param($Gate, [bool]$RequirePosted)
  $infra = New-Object Collections.Generic.List[string]
  $content = New-Object Collections.Generic.List[string]
  $other = New-Object Collections.Generic.List[string]
  $newFailures = @(ConvertTo-StringList (Get-JsonProp $Gate 'newFailures'))

  if ((Get-JsonProp $Gate 'reviewOk') -ne $true) { $null = $infra.Add('the reviewer did not produce a usable review') }
  elseif ($null -eq (Get-JsonProp $Gate 'verdict')) { $null = $infra.Add('the reviewer wrote no usable verdict.json') }
  if ($RequirePosted -and (Get-JsonProp $Gate 'posted') -ne $true) { $null = $infra.Add('the review comment was not posted') }
  $prSteps = Get-JsonProp $Gate 'pr'
  $baseSteps = Get-JsonProp $Gate 'base'
  $prInstall = Get-JsonProp $prSteps 'install'
  $baseInstall = Get-JsonProp $baseSteps 'install'
  if ($null -eq $prSteps -or $null -eq $prInstall) { $null = $infra.Add('the pr checks produced no results') }
  if ($null -eq $baseSteps -or $null -eq $baseInstall) { $null = $infra.Add('the base checks produced no results') }

  if ($null -ne $prSteps -and $null -ne $prInstall) {
    $prBuild = Get-JsonProp $prSteps 'build'
    $prTypecheck = Get-JsonProp $prSteps 'typecheck'
    $prUnit = Get-JsonProp $prSteps 'unit'
    $prE2e = Get-JsonProp $prSteps 'e2e'
    $baseUnit = Get-JsonProp $baseSteps 'unit'
    $baseE2e = Get-JsonProp $baseSteps 'e2e'
    if ([int]$prInstall -ne 0) {
      $text = 'pr install exit ' + $prInstall
      $null = $content.Add($text); $null = $other.Add($text)
    } elseif ($null -eq $prBuild -or [int]$prBuild -ne 0) {
      $text = 'pr build exit ' + (Format-Step $prBuild)
      $null = $content.Add($text); $null = $other.Add($text)
    } else {
      if ($null -eq $prTypecheck -or [int]$prTypecheck -ne 0) {
        $text = 'pr typecheck exit ' + (Format-Step $prTypecheck)
        $null = $content.Add($text); $null = $other.Add($text)
      }
      $baseUnitFailing = $null -ne $baseSteps -and $null -ne $baseUnit -and [int]$baseUnit -ne 0
      if ($null -eq $prUnit) {
        $text = 'pr unit tests did not run'
        $null = $content.Add($text); $null = $other.Add($text)
      } elseif ([int]$prUnit -ne 0) {
        if (-not ($baseUnitFailing -and (Get-JsonProp $Gate 'unitComparison') -eq $true -and $newFailures.Count -eq 0)) {
          $null = $content.Add('pr unit exit ' + $prUnit)
        }
      }
      $baseE2eFailing = $null -ne $baseSteps -and $null -ne $baseE2e -and [int]$baseE2e -ne 0
      if ($null -eq $prE2e) {
        $text = 'pr e2e did not run'
        $null = $content.Add($text); $null = $other.Add($text)
      } elseif ([int]$prE2e -ne 0) {
        $worse = -not $baseE2eFailing -or (([int]$prE2e -eq 124) -ne ([int]$baseE2e -eq 124))
        if ($worse) {
          $text = 'pr e2e exit ' + $prE2e + ' (base ' + (Format-Step $baseE2e) + ')'
          $null = $content.Add($text); $null = $other.Add($text)
        }
      }
    }
  }
  if ($newFailures.Count -gt 0) { $null = $content.Add(([string]$newFailures.Count) + ' unit test(s) fail on the pr and pass on base') }

  $verdict = Get-JsonProp $Gate 'verdict'
  if ($null -ne $verdict) {
    $blocking = @(ConvertTo-StringList (Get-JsonProp $verdict 'blocking'))
    $recommendation = [string](Get-JsonProp $verdict 'recommendation')
    if ($recommendation -ne 'merge') { $null = $content.Add('the reviewer recommends changes') }
    elseif ($blocking.Count -gt 0) { $null = $content.Add('the reviewer says merge but lists blocking points') }
    $shown = 0
    foreach ($point in $blocking) {
      if ($shown -ge 20) { break }
      $null = $content.Add('blocking: ' + $point)
      $shown++
    }
  }
  $flakeCandidate = ($infra.Count -eq 0 -and $other.Count -eq 0 -and $newFailures.Count -gt 0)
  return [pscustomobject]@{ infra = @($infra); content = @($content); newFailures = $newFailures; flakeCandidate = $flakeCandidate }
}

function Write-GateFailures {
  param([string]$Path, $Evaluation, [string[]]$Extra, [string]$Sha)
  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('# Merge gate failures')
  $null = $lines.Add('')
  $shortSha = if ($Sha.Length -ge 7) { $Sha.Substring(0, 7) } else { $Sha }
  $null = $lines.Add('These conditions failed for head ' + $shortSha + '. Fix every one of them.')
  $null = $lines.Add('')
  foreach ($item in @($Extra) + @($Evaluation.content)) { if ($item) { $null = $lines.Add('- ' + $item) } }
  if ($Evaluation.newFailures.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('## New failing unit tests')
    $null = $lines.Add('')
    foreach ($name in @($Evaluation.newFailures | Select-Object -First 50)) { $null = $lines.Add('- ' + $name) }
  }
  Write-Text $Path (($lines -join "`n") + "`n")
}

$headShaOut = ''
$verdictOut = 'unavailable'
$failuresOut = New-Object Collections.Generic.List[string]
$gatePathOut = ''
$exitCode = 2

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ($PrNumber -le 0) { throw '-PrNumber is required and must be positive.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw '-Repo must be owner/name.' }
  if ([string]::IsNullOrWhiteSpace($Root)) { throw '-Root is required.' }
  if ([string]::IsNullOrWhiteSpace($ReviewRoot)) { throw '-ReviewRoot is required.' }
  if ([string]::IsNullOrWhiteSpace($StandardCredentialFile)) { throw '-StandardCredentialFile is required.' }

  $WorkRoot = Get-AcceptancePath $Root
  Assert-OutsideGitCheckout $WorkRoot
  Assert-AcceptanceOutsideRepo $WorkRoot
  Assert-CmdSafePath '-Root' $WorkRoot
  [IO.Directory]::CreateDirectory($WorkRoot) | Out-Null
  $script:WorkRoot = $WorkRoot

  $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
  $script:RunDir = Join-Path $WorkRoot ('autopilot\gate\pr-' + $PrNumber + '-' + $stamp)
  [IO.Directory]::CreateDirectory($script:RunDir) | Out-Null
  $script:LogPath = Join-Path $script:RunDir 'gate.log'

  $script:ReviewRootPath = Get-AcceptancePath $ReviewRoot
  Assert-CmdSafePath '-ReviewRoot' $script:ReviewRootPath
  if ($script:ReviewRootPath.Equals($WorkRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '-ReviewRoot must differ from -Root.' }

  if (-not [string]::IsNullOrWhiteSpace($ReviewCheckout)) {
    $script:ReviewCheckoutPath = Get-AcceptancePath $ReviewCheckout
  } else {
    $repoCandidate = Join-Path $WorkRoot 'repo'
    if (Test-Path -LiteralPath (Join-Path $repoCandidate '.git')) {
      $script:ReviewCheckoutPath = Get-AcceptancePath $repoCandidate
    } elseif (Test-Path -LiteralPath (Join-Path $script:AcceptanceRepo '.git')) {
      $script:ReviewCheckoutPath = Get-AcceptancePath $script:AcceptanceRepo
    } else {
      throw '-ReviewCheckout is required.'
    }
  }
  Assert-CmdSafePath '-ReviewCheckout' $script:ReviewCheckoutPath
  if (-not (Test-Path -LiteralPath (Join-Path $script:ReviewCheckoutPath '.git'))) { throw '-ReviewCheckout must be the root of a git clone.' }

  $script:CredentialPath = Get-AcceptancePath $StandardCredentialFile
  Assert-CmdSafePath '-StandardCredentialFile' $script:CredentialPath
  if (-not (Test-Path -LiteralPath $script:CredentialPath -PathType Leaf)) { throw '-StandardCredentialFile does not exist.' }

  if (-not [string]::IsNullOrWhiteSpace($ReviewTokenFile)) {
    $script:ReviewTokenPath = Get-AcceptancePath $ReviewTokenFile
    Assert-CmdSafePath '-ReviewTokenFile' $script:ReviewTokenPath
    if (-not (Test-Path -LiteralPath $script:ReviewTokenPath -PathType Leaf)) { throw '-ReviewTokenFile does not exist.' }
  }
  if (-not [string]::IsNullOrWhiteSpace($Reference)) {
    $script:ReferencePath = Get-AcceptancePath $Reference
    Assert-CmdSafePath '-Reference' $script:ReferencePath
    if (-not (Test-Path -LiteralPath $script:ReferencePath -PathType Container)) { throw '-Reference must be an existing directory.' }
  }
  if (-not (Test-Path -LiteralPath $script:ReviewScript -PathType Leaf)) {
    throw 'Invoke-PrReview.ps1 is missing; keep scripts\dev-loop next to scripts\pr-review.'
  }
  $script:ReviewScript = Get-AcceptancePath $script:ReviewScript

  $env:GH_PROMPT_DISABLED = '1'
  $env:GH_NO_UPDATE_NOTIFIER = '1'
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'

  $gh = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $gh) { throw 'GitHub CLI (gh) was not found on PATH.' }
  $script:GhPath = $gh.Source

  $info = Get-PrInfo $PrNumber
  if (-not $info -or [string]::IsNullOrWhiteSpace($info.headSha)) {
    $null = $failuresOut.Add('cannot read PR #' + $PrNumber)
    Write-Log ('cannot read PR #' + $PrNumber)
  } elseif ($info.state -ne 'OPEN') {
    $headShaOut = $info.headSha
    $msg = 'PR #' + $PrNumber + ' is not open (state ' + $info.state + ')'
    $null = $failuresOut.Add($msg)
    Write-Log $msg
  } else {
    $headShaOut = $info.headSha
    $review = $null
    for ($lockTry = 0; $lockTry -le 10; $lockTry++) {
      $tag = if ($lockTry -eq 0) { 'g0' } else { 'g' + $lockTry }
      $review = Invoke-Review $PrNumber $headShaOut $script:RunDir $false $tag
      if ($review.status -ne 'busy') { break }
      if ($lockTry -lt 10) {
        Write-Log ('reviewer lock busy; waiting 60s before retry ' + ($lockTry + 1) + '/10')
        Start-Sleep -Seconds 60
      }
    }

    if (-not $review -or $review.status -ne 'ok') {
      $msg = if ($review -and $review.message) { [string]$review.message } else { 'review unavailable' }
      $null = $failuresOut.Add($msg)
      Write-Log ('review unavailable: ' + $msg)
    } else {
      $gatePathOut = [string]$review.gatePath
      $evaluation = Test-GateResult $review.gate $true
      $extra = @()
      if ($info.mergeable -eq 'CONFLICTING') {
        $extra += 'the PR conflicts with main; merge origin/main into the branch and resolve the conflicts'
      }

      if ($evaluation.infra.Count -gt 0) {
        $verdictOut = 'unavailable'
        $exitCode = 2
        foreach ($item in $evaluation.infra) { $null = $failuresOut.Add($item) }
        Write-Log ('gate infra unavailable: ' + ($evaluation.infra -join '; '))
      } elseif ($evaluation.content.Count -gt 0 -or $extra.Count -gt 0) {
        $verdictOut = 'fail'
        $exitCode = 1
        Write-GateFailures (Join-Path $script:RunDir 'failures.md') $evaluation $extra $headShaOut
        foreach ($item in @($extra) + @($evaluation.content)) {
          if ($item) { $null = $failuresOut.Add($item) }
        }
        foreach ($unitName in @($evaluation.newFailures | Select-Object -First 50)) {
          $null = $failuresOut.Add('new failing unit test: ' + $unitName)
        }
        Write-Log ('gate fail for PR #' + $PrNumber + ' (' + $failuresOut.Count + ' failure items)')
      } else {
        $verdictOut = 'pass'
        $exitCode = 0
        Write-Log ('gate pass for PR #' + $PrNumber + ' head ' + $headShaOut.Substring(0, 7))
      }
    }
  }
} catch {
  $verdictOut = 'unavailable'
  $exitCode = 2
  $failuresOut.Clear()
  $null = $failuresOut.Add($_.Exception.Message)
  Write-Log ('gate error: ' + $_.Exception.Message)
}

$summary = [ordered]@{
  pr = $PrNumber
  headSha = $headShaOut
  verdict = $verdictOut
  failures = [string[]]$failuresOut.ToArray()
  gatePath = $gatePathOut
}
$json = ConvertTo-Json -InputObject $summary -Depth 4 -Compress
[Console]::Out.WriteLine($json)
exit $exitCode
