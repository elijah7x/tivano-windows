# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-AutopilotGate.ps1 -PrNumber <n> -ReviewRoot <pr-review state root> -StandardCredentialFile <file> [-ReviewCheckout <clone>] [-ReviewTokenFile <file>] [-Reference <macOS baseline clone>] [-Repo <owner/name>] [-Root <state root>] [-DevinModel <model>] [-ReviewTimeoutMin <min>] [-GlmTimeoutMin <min>] [-SkipGlm]
# Runs Invoke-PrReview.ps1 (with posting enabled and -Force) for one PR, evaluates gate.json with the dev-loop merge gate rules, optionally runs Invoke-GlmReview.ps1 -Mode review for a second review, and emits one compact JSON summary line to stdout.

param(
  [int]$PrNumber = 0,
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root = 'C:\tivano\dev-loop',
  [string]$ReviewRoot = 'C:\tivano\pr-bot\state',
  [string]$ReviewCheckout = 'C:\tivano\tivano-windows',
  [string]$StandardCredentialFile = 'C:\tivano\secrets\tivano-std.credential.json',
  [string]$ReviewTokenFile,
  [string]$Reference = 'C:\tivano\reference\tivano-v3.0.0',
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$DevinModel = 'swe-2-high',
  [ValidateRange(1, 720)][int]$ReviewTimeoutMin = 240,
  [ValidateRange(1, 240)][int]$GlmTimeoutMin = 20,
  [switch]$SkipGlm,
  [ValidateRange(0, 1000)][int]$MaxBehindMain = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$script:ReviewScript = Join-Path $PSScriptRoot '..\pr-review\Invoke-PrReview.ps1'
$script:GlmScript = Join-Path $PSScriptRoot 'Invoke-GlmReview.ps1'
$script:StandardScript = Join-Path $PSScriptRoot '..\windows-acceptance\Invoke-AsStandardUser.ps1'
$script:AcceptanceRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')

$script:GitPath = $null
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

function ConvertTo-PsLiteral {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
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
function Get-BranchStaleness {
  # Returns a failure message when the PR head conflicts with its base or is more than
  # $MaxBehindMain commits behind it; $null when it is current enough (or GitHub cannot tell).
  param($Info)
  if ([string]$Info.mergeable -eq 'CONFLICTING') {
    return 'the PR conflicts with main; merge origin/main into the branch and resolve the conflicts before running the gate'
  }
  $baseRef = [string]$Info.base
  if ([string]::IsNullOrWhiteSpace($baseRef)) { $baseRef = 'main' }
  $cmp = Invoke-Gh ('api repos/' + $Repo + '/compare/' + $baseRef + '...' + $Info.headSha + ' --jq .behind_by')
  if ($cmp.exitCode -ne 0) { return $null }
  $behind = 0
  if (-not [int]::TryParse(([string]$cmp.text).Trim(), [ref]$behind)) { return $null }
  if ($behind -gt $MaxBehindMain) {
    return ('the branch is ' + $behind + ' commits behind ' + $baseRef + '; merge origin/main into the branch (never rebase), run the self-check, push, then run the gate again')
  }
  return $null
}

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

function Start-ReviewTask {
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
  $taskName = 'gate-pr-' + $Pr + '-' + $Tag + '-' + $PID
  $action = New-ScheduledTaskAction -Execute $script:CmdExe -Argument ('/d /c "' + $cmdFile + '"') -WorkingDirectory $script:WorkRoot
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ($ReviewTimeoutMin + 5)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  try {
    Start-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName
  } catch {
    Unregister-ScheduledTask -TaskPath '\TivanoDevLoop\' -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    throw
  }
  return [pscustomobject]@{
    pr = $Pr
    sha = $Sha
    outLog = $outLog
    errLog = $errLog
    doneFile = $doneFile
    taskName = $taskName
    deadlineUtc = [DateTime]::UtcNow.AddMinutes($ReviewTimeoutMin)
  }
}

function Wait-ReviewTask {
  param($Handle)
  $Pr = [int]$Handle.pr
  $Sha = [string]$Handle.sha
  $outLog = [string]$Handle.outLog
  $doneFile = [string]$Handle.doneFile
  $taskName = [string]$Handle.taskName
  $deadline = [DateTime]$Handle.deadlineUtc
  try {
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
  $skippedList = @()
  if ($null -ne $skippedRaw) { $skippedList = @($skippedRaw | ForEach-Object { $_ }) }
  $reviewedList = @()
  if ($null -ne $reviewedRaw) { $reviewedList = @($reviewedRaw | ForEach-Object { $_ }) }
  $errorList = @()
  if ($null -ne $errorsRaw) { $errorList = @($errorsRaw | ForEach-Object { $_ }) }

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

function Invoke-Review {
  param([int]$Pr, [string]$Sha, [string]$RunDir, [bool]$NoPost, [string]$Tag)
  $handle = Start-ReviewTask -Pr $Pr -Sha $Sha -RunDir $RunDir -NoPost $NoPost -Tag $Tag
  return (Wait-ReviewTask -Handle $handle)
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
  return [pscustomobject]@{ infra = [string[]]$infra.ToArray(); content = [string[]]$content.ToArray(); newFailures = $newFailures; flakeCandidate = $flakeCandidate }
}

function Invoke-Git {
  param([string]$Directory, [string]$Arguments)
  $tmpBase = $script:WorkRoot
  if ($script:RunDir) { $tmpBase = $script:RunDir }
  $out = Join-Path $tmpBase '.git.out.tmp'
  $err = Join-Path $tmpBase '.git.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Directory) + ' ' + $Arguments) $out $err $script:WorkRoot
    $result = [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $result.error)) { return $result }
    Write-Log ('git network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine ([string]$result.error) 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Copy-RunOutput {
  param([string]$From, [string]$To)
  [IO.Directory]::CreateDirectory($To) | Out-Null
  if (Test-Path -LiteralPath $From -PathType Container) {
    Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Stop-TreeProcesses {
  param([string]$Worktree)
  if ([string]::IsNullOrWhiteSpace($Worktree)) { return }
  try {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $keep = @{}
    $id = $PID
    while ($id -and -not $keep.ContainsKey($id)) {
      $keep[$id] = $true
      $proc = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
      if ($proc) { $id = $proc.ParentProcessId } else { $id = 0 }
    }
    foreach ($proc in $all) {
      if ($keep.ContainsKey($proc.ProcessId)) { continue }
      $exeHit = $false
      if ($null -ne $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($Worktree, [StringComparison]::OrdinalIgnoreCase)) { $exeHit = $true }
      $cmdHit = $false
      if ($null -ne $proc.CommandLine -and $proc.CommandLine.IndexOf($Worktree, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $cmdHit = $true }
      if ($exeHit -or $cmdHit) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}

function Resolve-StandardAccountSid {
  param([string]$CredentialFile)
  $path = Get-AcceptancePath $CredentialFile
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '-StandardCredentialFile does not exist.' }
  $name = $null
  if ($path.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) {
    $stored = Read-Text $path | ConvertFrom-Json
    $name = [string](Get-JsonProp $stored 'user')
  } else {
    try {
      $name = (Import-Clixml -LiteralPath $path).UserName
    } catch {
      $match = [regex]::Match((Read-Text $path), '<S N="UserName">([^<]*)</S>')
      if ($match.Success) { $name = [Net.WebUtility]::HtmlDecode($match.Groups[1].Value) }
    }
  }
  if ([string]::IsNullOrWhiteSpace($name)) { throw 'Cannot read the standard account name from -StandardCredentialFile.' }
  $qualified = $name
  if ($name.IndexOf('\') -lt 0) { $qualified = $env:COMPUTERNAME + '\' + $name }
  return [Security.Principal.NTAccount]::new($qualified).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Normalize-RepoPath {
  param([AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $norm = $Path.Trim().Replace('\', '/')
  while ($norm.StartsWith('./', [StringComparison]::Ordinal)) {
    $norm = $norm.Substring(2)
  }
  return $norm
}

function Test-SafeRelativeTestPath {
  param([AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  if ($Path.StartsWith('/', [StringComparison]::Ordinal) -or $Path.StartsWith('-', [StringComparison]::Ordinal)) { return $false }
  if ($Path.Contains(':')) { return $false }
  if ($Path -notmatch '^[A-Za-z0-9._/@ -]+$') { return $false }
  $segments = @($Path -split '/')
  foreach ($seg in $segments) {
    if ($seg -eq '..' -or $seg -eq '' -or $seg -eq '.') { return $false }
  }
  return $true
}

function Get-PrChangedFiles {
  param($Gate, [string]$ReviewDir, [string]$HeadSha)
  $list = New-Object Collections.Generic.List[string]
  $seen = @{}
  if ($script:GitPath -and $script:ReviewCheckoutPath) {
    $baseSha = [string](Get-JsonProp $Gate 'baseSha')
    if ([string]::IsNullOrWhiteSpace($baseSha)) {
      $mbRes = Invoke-Git $script:ReviewCheckoutPath ('merge-base origin/main ' + $HeadSha)
      if ($mbRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($mbRes.text)) {
        $baseSha = $mbRes.text.Trim()
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($baseSha)) {
      $diffRes = Invoke-Git $script:ReviewCheckoutPath ('-c core.quotepath=false diff --no-renames --name-only ' + $baseSha + '..' + $HeadSha)
      if ($diffRes.exitCode -eq 0) {
        $lines = @()
        if ($null -ne $diffRes.text) {
          $lines = @($diffRes.text -split "`r?`n")
        }
        foreach ($line in $lines) {
          $norm = Normalize-RepoPath $line
          if (-not $norm) { continue }
          $key = $norm.ToLowerInvariant()
          if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $null = $list.Add($norm)
          }
        }
        return [pscustomobject]@{ ok = $true; files = [string[]]$list.ToArray(); source = 'git-diff' }
      }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($ReviewDir)) {
    $prData = Read-JsonFile (Join-Path $ReviewDir 'pr.json')
    if ($null -ne $prData) {
      $rawFiles = Get-JsonProp $prData 'files'
      if ($null -ne $rawFiles) {
        $items = @($rawFiles | Where-Object { $null -ne $_ })
        foreach ($item in $items) {
          $norm = Normalize-RepoPath ([string](Get-JsonProp $item 'path'))
          if (-not $norm) { continue }
          $key = $norm.ToLowerInvariant()
          if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $null = $list.Add($norm)
          }
        }
        return [pscustomobject]@{ ok = $true; files = [string[]]$list.ToArray(); source = 'pr-json' }
      }
    }
  }
  return [pscustomobject]@{ ok = $false; files = [string[]]@(); source = '' }
}

function Get-VitestJsonData {
  param([string]$Path)
  $data = Read-JsonFile $Path
  if ($null -eq $data -or $data -isnot [pscustomobject]) { return $null }
  return $data
}

function Test-VitestFileMatches {
  param([string]$VitestFileName, [string]$RelativeFile)
  if ([string]::IsNullOrWhiteSpace($VitestFileName) -or [string]::IsNullOrWhiteSpace($RelativeFile)) { return $false }
  $norm = $VitestFileName.Replace('\', '/')
  if ($norm.Equals($RelativeFile, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $norm.EndsWith('/' + $RelativeFile, [StringComparison]::OrdinalIgnoreCase)
}

function Find-VitestAssertion {
  param($VitestData, [string]$RelativeFile, [string]$TestFullName)
  if ($null -eq $VitestData) { return $null }
  $rawResults = Get-JsonProp $VitestData 'testResults'
  if ($null -eq $rawResults) { return $null }
  $testResults = @($rawResults | Where-Object { $null -ne $_ })
  $trimmedTarget = $TestFullName.Trim()
  foreach ($tr in $testResults) {
    $trName = [string](Get-JsonProp $tr 'name')
    if (-not (Test-VitestFileMatches $trName $RelativeFile)) { continue }
    $rawAssertions = Get-JsonProp $tr 'assertionResults'
    $assertions = @()
    if ($null -ne $rawAssertions) {
      $assertions = @($rawAssertions | Where-Object { $null -ne $_ })
    }
    foreach ($ar in $assertions) {
      $arFullName = [string](Get-JsonProp $ar 'fullName')
      if ($arFullName -eq $TestFullName -or $arFullName.Trim() -eq $trimmedTarget) {
        return [pscustomobject]@{
          status = [string](Get-JsonProp $ar 'status')
          failureMessages = @(ConvertTo-StringList (Get-JsonProp $ar 'failureMessages'))
          fileMessage = [string](Get-JsonProp $tr 'message')
        }
      }
    }
  }
  return $null
}

function Get-VitestResultKey {
  param([AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $norm = $Path.Trim().Replace('\', '/')
  $match = [regex]::Match($norm, '(?i)/sandbox/(?:pr|base)(?:-[^/]+)?/')
  if ($match.Success) { return $norm.Substring($match.Index + $match.Length).ToLowerInvariant() }
  return (Split-Path -Leaf $norm).ToLowerInvariant()
}

function Test-HasUncollectedPrFileFailure {
  param($PrVitest, $BaseVitest)
  if ($null -eq $PrVitest) { return $false }
  $rawPrResults = Get-JsonProp $PrVitest 'testResults'
  if ($null -eq $rawPrResults) { return $false }
  $baseFailedFiles = @{}
  if ($null -ne $BaseVitest) {
    $rawBaseResults = Get-JsonProp $BaseVitest 'testResults'
    if ($null -ne $rawBaseResults) {
      foreach ($btr in @($rawBaseResults | Where-Object { $null -ne $_ })) {
        if ([string](Get-JsonProp $btr 'status') -ne 'failed') { continue }
        # Only a base file that also failed to load (no failed assertions) excuses a PR load failure.
        $bFailedAssertions = 0
        $bAssertions = Get-JsonProp $btr 'assertionResults'
        if ($null -ne $bAssertions) {
          foreach ($bar in @($bAssertions | Where-Object { $null -ne $_ })) {
            if ([string](Get-JsonProp $bar 'status') -eq 'failed') { $bFailedAssertions++ }
          }
        }
        if ($bFailedAssertions -gt 0) { continue }
        $bKey = Get-VitestResultKey ([string](Get-JsonProp $btr 'name'))
        if ($bKey) { $baseFailedFiles[$bKey] = $true }
      }
    }
  }
  foreach ($tr in @($rawPrResults | Where-Object { $null -ne $_ })) {
    if ([string](Get-JsonProp $tr 'status') -ne 'failed') { continue }
    $rawAssertions = Get-JsonProp $tr 'assertionResults'
    $failedAssertions = 0
    if ($null -ne $rawAssertions) {
      foreach ($ar in @($rawAssertions | Where-Object { $null -ne $_ })) {
        if ([string](Get-JsonProp $ar 'status') -eq 'failed') { $failedAssertions++ }
      }
    }
    if ($failedAssertions -eq 0) {
      $prKey = Get-VitestResultKey ([string](Get-JsonProp $tr 'name'))
      if (-not $prKey -or -not $baseFailedFiles.ContainsKey($prKey)) {
        return $true
      }
    }
  }
  return $false
}

function Get-FlakeFailureInfo {
  param([string[]]$NewFailures, [string]$ReviewDir)
  $files = New-Object Collections.Generic.List[string]
  $seenFiles = @{}
  $tests = New-Object Collections.Generic.List[object]
  $firstFailures = New-Object Collections.Generic.List[object]

  $prVitest = $null
  $baseVitest = $null
  if (-not [string]::IsNullOrWhiteSpace($ReviewDir)) {
    $prVitest = Get-VitestJsonData (Join-Path $ReviewDir 'results-pr\vitest.json')
    $baseVitest = Get-VitestJsonData (Join-Path $ReviewDir 'results-base\vitest.json')
  }
  if (Test-HasUncollectedPrFileFailure $prVitest $baseVitest) {
    return [pscustomobject]@{
      ok = $false
      files = [string[]]@()
      tests = [object[]]@()
      firstFailures = [object[]]@()
      reason = 'results-pr vitest.json contains an uncollected test file failure'
    }
  }

  $absentSuffix = ' (absent in base run)'
  foreach ($entry in @($NewFailures)) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    $sep = $entry.IndexOf(' > ', [StringComparison]::Ordinal)
    if ($sep -le 0) {
      return [pscustomobject]@{
        ok = $false
        files = [string[]]@()
        tests = [object[]]@()
        firstFailures = [object[]]@()
        reason = 'cannot parse test file path from newFailures entry'
      }
    }
    $relFile = Normalize-RepoPath ($entry.Substring(0, $sep))
    if (-not (Test-SafeRelativeTestPath $relFile)) {
      return [pscustomobject]@{
        ok = $false
        files = [string[]]@()
        tests = [object[]]@()
        firstFailures = [object[]]@()
        reason = 'unsafe or non-relative test file path: ' + $relFile
      }
    }
    $rawTestName = $entry.Substring($sep + 3)
    if ($rawTestName.EndsWith($absentSuffix, [StringComparison]::Ordinal)) {
      $rawTestName = $rawTestName.Substring(0, $rawTestName.Length - $absentSuffix.Length)
    }
    $fileKey = $relFile.ToLowerInvariant()
    if (-not $seenFiles.ContainsKey($fileKey)) {
      $seenFiles[$fileKey] = $true
      $null = $files.Add($relFile)
    }
    $null = $tests.Add([pscustomobject]@{ file = $relFile; fullName = $rawTestName })

    $firstMsg = ''
    $found = Find-VitestAssertion $prVitest $relFile $rawTestName
    if ($null -ne $found) {
      $msgs = @($found.failureMessages)
      if ($msgs.Count -gt 0) {
        $firstMsg = ConvertTo-SingleLine $msgs[0] 300
      } elseif (-not [string]::IsNullOrWhiteSpace($found.fileMessage)) {
        $firstMsg = ConvertTo-SingleLine $found.fileMessage 300
      }
    }
    if ([string]::IsNullOrWhiteSpace($firstMsg)) {
      $firstMsg = ConvertTo-SingleLine $entry 300
    }
    $null = $firstFailures.Add([ordered]@{
      file = $relFile
      test = $rawTestName.Trim()
      message = $firstMsg
    })
  }

  if ($files.Count -eq 0) {
    return [pscustomobject]@{
      ok = $false
      files = [string[]]@()
      tests = [object[]]@()
      firstFailures = [object[]]@()
      reason = 'no failing test files parsed from newFailures'
    }
  }
  return [pscustomobject]@{
    ok = $true
    files = [string[]]$files.ToArray()
    tests = [object[]]$tests.ToArray()
    firstFailures = [object[]]$firstFailures.ToArray()
    reason = ''
  }
}

function Test-ReviewerBlockingOnlyFlake {
  param($Gate, [string[]]$FailingFiles, [string[]]$ChangedFiles)
  $verdict = Get-JsonProp $Gate 'verdict'
  if ($null -eq $verdict) { return $false }
  $rec = ([string](Get-JsonProp $verdict 'recommendation')).Trim().ToLowerInvariant()
  $blocking = @(ConvertTo-StringList (Get-JsonProp $verdict 'blocking'))
  if ($rec -eq 'merge' -and $blocking.Count -eq 0) { return $true }
  if ($blocking.Count -eq 0) { return $false }

  $failingTokens = New-Object Collections.Generic.List[string]
  foreach ($f in @($FailingFiles)) {
    if ([string]::IsNullOrWhiteSpace($f)) { continue }
    $null = $failingTokens.Add($f)
    $null = $failingTokens.Add($f.Replace('/', '\'))
    $leaf = Split-Path -Leaf $f
    if ($leaf) { $null = $failingTokens.Add($leaf) }
  }
  $failingTokenArr = [string[]]$failingTokens.ToArray()

  $changedTokens = New-Object Collections.Generic.List[string]
  foreach ($c in @($ChangedFiles)) {
    $null = $changedTokens.Add($c)
    $null = $changedTokens.Add($c.Replace('/', '\'))
  }
  $changedTokenArr = [string[]]$changedTokens.ToArray()

  foreach ($point in $blocking) {
    foreach ($ct in $changedTokenArr) {
      if ($ct -and $point.IndexOf($ct, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $false
      }
    }
    $matchesFlake = $false
    foreach ($ft in $failingTokenArr) {
      if ($ft -and $point.IndexOf($ft, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $matchesFlake = $true
        break
      }
    }
    if (-not $matchesFlake) { return $false }
  }
  return $true
}

function Invoke-FlakeRerun {
  param(
    [int]$PrNumber,
    [string]$HeadSha,
    [string[]]$FailingFiles,
    [object[]]$FailingTests,
    [string]$RunDir
  )
  $flakeDir = Join-Path $RunDir 'flake-retry'
  $cmdDir = Join-Path $flakeDir 'bin'
  $sandbox = Join-Path $flakeDir 'sandbox'
  $prTree = Join-Path $sandbox ('flake-pr-' + $PrNumber + '-' + $PID)
  $checksSandbox = Join-Path $sandbox 'checks'
  $resultsSandbox = Join-Path $sandbox 'results'
  $checksDir = Join-Path $flakeDir 'checks'
  $resultsDir = Join-Path $flakeDir 'results'
  $unitLogPath = Join-Path $resultsDir 'unit.log'
  $vitestJsonPath = Join-Path $resultsDir 'vitest.json'

  $fileArgParts = New-Object Collections.Generic.List[string]
  foreach ($relFile in @($FailingFiles)) {
    $null = $fileArgParts.Add((Quote-Argument $relFile))
  }
  $fileArgsJoined = $fileArgParts.ToArray() -join ' '
  $vitestCmdLine = 'node.exe ".\node_modules\vitest\vitest.mjs" run --reporter=default --reporter=json "--outputFile.json=%RES%\vitest.json" ' + $fileArgsJoined

  $treeCreated = $false
  try {
    if (-not $script:GitPath) {
      return [pscustomobject]@{ passed = $false; reason = 'git was not found on PATH'; command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    if (-not (Test-Path -LiteralPath $script:StandardScript -PathType Leaf)) {
      return [pscustomobject]@{ passed = $false; reason = 'Invoke-AsStandardUser.ps1 is missing'; command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    $standardScriptPath = Get-AcceptancePath $script:StandardScript
    Assert-CmdSafePath 'Invoke-AsStandardUser.ps1' $standardScriptPath

    $verifyHead = Invoke-Git $script:ReviewCheckoutPath ('rev-parse --verify --quiet ' + $HeadSha + '^{commit}')
    if ($verifyHead.exitCode -ne 0) {
      $fetchRes = Invoke-Git $script:ReviewCheckoutPath ('fetch --no-tags origin main +refs/pull/' + $PrNumber + '/head:refs/remotes/origin/pr-' + $PrNumber)
      if ($fetchRes.exitCode -ne 0) {
        return [pscustomobject]@{ passed = $false; reason = ('git fetch failed: ' + (Get-ErrorSummary $fetchRes)); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
      }
    }

    [IO.Directory]::CreateDirectory($flakeDir) | Out-Null
    [IO.Directory]::CreateDirectory($cmdDir) | Out-Null
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null

    $treeCreated = $true
    $wtAdd = Invoke-Git $script:ReviewCheckoutPath ('worktree add --detach ' + (Quote-Argument $prTree) + ' ' + $HeadSha)
    if ($wtAdd.exitCode -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('git worktree add failed: ' + (Get-ErrorSummary $wtAdd)); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }

    foreach ($relFile in @($FailingFiles)) {
      $absTest = Join-Path $prTree ($relFile.Replace('/', '\'))
      if (-not (Test-Path -LiteralPath $absTest -PathType Leaf)) {
        return [pscustomobject]@{ passed = $false; reason = ('failing test file not found in PR worktree: ' + $relFile); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
      }
    }

    $rerunCmdPath = Join-Path $cmdDir 'rerun-flake.cmd'
    $cmdLines = New-Object Collections.Generic.List[string]
    $null = $cmdLines.Add('@echo off')
    $null = $cmdLines.Add('rem Generated for one flake rerun by Invoke-AutopilotGate.ps1.')
    $null = $cmdLines.Add('setlocal DisableDelayedExpansion')
    $null = $cmdLines.Add('set "WT=%~1"')
    $null = $cmdLines.Add('set "RES=%~2"')
    $null = $cmdLines.Add('if "%WT%"=="" exit /b 2')
    $null = $cmdLines.Add('if "%RES%"=="" exit /b 2')
    $null = $cmdLines.Add('if not exist "%WT%\" exit /b 2')
    $null = $cmdLines.Add('if not exist "%RES%\" mkdir "%RES%"')
    $null = $cmdLines.Add('if not exist "%RES%\" exit /b 2')
    $null = $cmdLines.Add('set "STEP_INSTALL=null"')
    $null = $cmdLines.Add('set "STEP_BUILD=null"')
    $null = $cmdLines.Add('set "STEP_UNIT=null"')
    $null = $cmdLines.Add('pushd "%WT%"')
    $null = $cmdLines.Add('if errorlevel 1 (')
    $null = $cmdLines.Add('  > "%RES%\steps.json" echo {"error":"cannot enter the worktree","install":null,"build":null,"unit":null}')
    $null = $cmdLines.Add('  exit /b 1')
    $null = $cmdLines.Add(')')
    $null = $cmdLines.Add('call npm.cmd ci --no-audit --no-fund > "%RES%\install.log" 2>&1')
    $null = $cmdLines.Add('set "STEP_INSTALL=%ERRORLEVEL%"')
    $null = $cmdLines.Add('if not "%STEP_INSTALL%"=="0" goto :finish')
    $null = $cmdLines.Add('call npm.cmd run build > "%RES%\build.log" 2>&1')
    $null = $cmdLines.Add('set "STEP_BUILD=%ERRORLEVEL%"')
    $null = $cmdLines.Add('if not "%STEP_BUILD%"=="0" goto :finish')
    $null = $cmdLines.Add('call ' + $vitestCmdLine + ' > "%RES%\unit.log" 2>&1')
    $null = $cmdLines.Add('set "STEP_UNIT=%ERRORLEVEL%"')
    $null = $cmdLines.Add(':finish')
    $null = $cmdLines.Add('popd')
    $null = $cmdLines.Add('if exist "%RES%" (')
    $null = $cmdLines.Add('  > "%RES%\steps.json" echo {"install":%STEP_INSTALL%,"build":%STEP_BUILD%,"unit":%STEP_UNIT%}')
    $null = $cmdLines.Add(')')
    $null = $cmdLines.Add('exit /b 0')
    Write-Text $rerunCmdPath (($cmdLines.ToArray() -join "`r`n") + "`r`n")

    $standardSid = Resolve-StandardAccountSid $script:CredentialPath
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $icacls = Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe'
    $lockCode = Invoke-Tool $icacls ((Quote-Argument $flakeDir) + ' /inheritance:r /grant:r "*' + $operatorSid + ':(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"') `
      (Join-Path $flakeDir 'acl-run.out.log') (Join-Path $flakeDir 'acl-run.err.log') $script:WorkRoot
    if ($lockCode -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('icacls could not restrict flake-retry dir: ' + (Get-Tail (Join-Path $flakeDir 'acl-run.err.log') 5)); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    $listCode = Invoke-Tool $icacls ((Quote-Argument $flakeDir) + ' /grant "*' + $standardSid + ':(RX)"') `
      (Join-Path $flakeDir 'acl-list.out.log') (Join-Path $flakeDir 'acl-list.err.log') $script:WorkRoot
    if ($listCode -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('icacls could not grant list on flake-retry dir: ' + (Get-Tail (Join-Path $flakeDir 'acl-list.err.log') 5)); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    $binCode = Invoke-Tool $icacls ((Quote-Argument $cmdDir) + ' /grant "*' + $standardSid + ':(OI)(CI)RX"') `
      (Join-Path $flakeDir 'acl-bin.out.log') (Join-Path $flakeDir 'acl-bin.err.log') $script:WorkRoot
    if ($binCode -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('icacls could not grant RX on flake-retry bin dir: ' + (Get-Tail (Join-Path $flakeDir 'acl-bin.err.log') 5)); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    $aclCode = Invoke-Tool $icacls ((Quote-Argument $sandbox) + ' /grant "*' + $standardSid + ':(OI)(CI)M"') `
      (Join-Path $flakeDir 'acl.out.log') (Join-Path $flakeDir 'acl.err.log') $script:WorkRoot
    if ($aclCode -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('icacls could not grant Modify on flake-retry sandbox: ' + (Get-Tail (Join-Path $flakeDir 'acl.err.log') 5)); command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }

    $wrapperPath = Join-Path $flakeDir 'standard-flake.ps1'
    $wrapperLines = New-Object Collections.Generic.List[string]
    $null = $wrapperLines.Add('# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.')
    $null = $wrapperLines.Add('# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app')
    $null = $wrapperLines.Add('# Generated for one flake rerun by Invoke-AutopilotGate.ps1.')
    $null = $wrapperLines.Add('$ErrorActionPreference = ''Stop''')
    $null = $wrapperLines.Add('$Code = 0')
    $null = $wrapperLines.Add('try {')
    $null = $wrapperLines.Add('  & ' + (ConvertTo-PsLiteral $standardScriptPath) + ' -CredentialFile ' + (ConvertTo-PsLiteral $script:CredentialPath) + ' -Evidence ' + (ConvertTo-PsLiteral $checksSandbox) + ' -Command ' + (ConvertTo-PsLiteral $script:CmdExe) + ' -Arguments @(''/d'', ''/c'', ' + (ConvertTo-PsLiteral $rerunCmdPath) + ', ' + (ConvertTo-PsLiteral $prTree) + ', ' + (ConvertTo-PsLiteral $resultsSandbox) + ') -WorkingDirectory ' + (ConvertTo-PsLiteral $prTree) + ' -TimeoutSec 900')
    $null = $wrapperLines.Add('  $Code = [int]$LASTEXITCODE')
    $null = $wrapperLines.Add('} catch {')
    $null = $wrapperLines.Add('  [Console]::Error.WriteLine($_.Exception.Message)')
    $null = $wrapperLines.Add('  $Code = 1')
    $null = $wrapperLines.Add('}')
    $null = $wrapperLines.Add('exit $Code')
    [IO.File]::WriteAllText($wrapperPath, (($wrapperLines.ToArray() -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($true)))

    $stdoutPath = Join-Path $flakeDir 'standard-flake.out.log'
    $stderrPath = Join-Path $flakeDir 'standard-flake.err.log'
    $shortHead = $HeadSha
    if ($shortHead.Length -ge 7) { $shortHead = $shortHead.Substring(0, 7) }
    Write-Log ('flake rerun pr #' + $PrNumber + ' head ' + $shortHead + ' files: ' + (@($FailingFiles) -join ', '))
    $process = Start-Process -FilePath $script:PowerShellExe `
      -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $wrapperPath)) `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath `
      -WorkingDirectory $script:WorkRoot -WindowStyle Hidden -PassThru
    if (-not $process) {
      return [pscustomobject]@{ passed = $false; reason = 'could not start standard-account flake rerun'; command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    $null = $process.Handle
    if (-not $process.WaitForExit(1020000)) {
      $taskkill = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
      $null = Invoke-Tool $taskkill ('/T /F /PID ' + $process.Id) (Join-Path $flakeDir 'kill.out.log') (Join-Path $flakeDir 'kill.err.log') $script:WorkRoot
      $null = $process.WaitForExit(5000)
      return [pscustomobject]@{ passed = $false; reason = 'flake rerun timed out'; command = $vitestCmdLine; unitLogPath = ''; vitestJsonPath = '' }
    }
    $process.WaitForExit()

    Copy-RunOutput $resultsSandbox $resultsDir
    Copy-RunOutput $checksSandbox $checksDir

    $steps = Read-JsonFile (Join-Path $resultsDir 'steps.json')
    if ($null -eq $steps) {
      return [pscustomobject]@{ passed = $false; reason = 'flake rerun produced no steps.json'; command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
    }
    $stepInstall = Get-JsonProp $steps 'install'
    $stepBuild = Get-JsonProp $steps 'build'
    $stepUnit = Get-JsonProp $steps 'unit'
    if ($null -eq $stepInstall -or [int]$stepInstall -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('flake rerun install exit ' + (Format-Step $stepInstall)); command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
    }
    if ($null -eq $stepBuild -or [int]$stepBuild -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('flake rerun build exit ' + (Format-Step $stepBuild)); command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
    }
    if ($null -eq $stepUnit -or [int]$stepUnit -ne 0) {
      return [pscustomobject]@{ passed = $false; reason = ('flake rerun unit exit ' + (Format-Step $stepUnit)); command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
    }

    $rerunVitest = Get-VitestJsonData $vitestJsonPath
    if ($null -eq $rerunVitest) {
      return [pscustomobject]@{ passed = $false; reason = 'flake rerun produced no readable vitest.json'; command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
    }
    $numFailed = Get-JsonProp $rerunVitest 'numFailedTests'
    $numPassed = Get-JsonProp $rerunVitest 'numPassedTests'
    if ($null -eq $numFailed -or [int]$numFailed -ne 0 -or $null -eq $numPassed -or [int]$numPassed -le 0) {
      return [pscustomobject]@{ passed = $false; reason = 'flake rerun vitest.json reported failures or zero passed tests'; command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
    }
    $rawRerunResults = Get-JsonProp $rerunVitest 'testResults'
    if ($null -ne $rawRerunResults) {
      foreach ($tr in @($rawRerunResults | Where-Object { $null -ne $_ })) {
        if ([string](Get-JsonProp $tr 'status') -ne 'passed') {
          return [pscustomobject]@{ passed = $false; reason = 'flake rerun vitest.json has a non-passing test file'; command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
        }
      }
    }
    foreach ($expected in @($FailingTests)) {
      $found = Find-VitestAssertion $rerunVitest ([string]$expected.file) ([string]$expected.fullName)
      if ($null -eq $found -or $found.status -ne 'passed') {
        return [pscustomobject]@{ passed = $false; reason = ('originally failing test did not pass on rerun: ' + [string]$expected.file + ' > ' + [string]$expected.fullName); command = $vitestCmdLine; unitLogPath = $unitLogPath; vitestJsonPath = $vitestJsonPath }
      }
    }

    return [pscustomobject]@{
      passed = $true
      reason = ''
      command = $vitestCmdLine
      unitLogPath = $unitLogPath
      vitestJsonPath = $vitestJsonPath
    }
  } catch {
    return [pscustomobject]@{
      passed = $false
      reason = ('flake rerun error: ' + (ConvertTo-SingleLine $_.Exception.Message 240))
      command = $vitestCmdLine
      unitLogPath = $unitLogPath
      vitestJsonPath = $vitestJsonPath
    }
  } finally {
    if ($treeCreated) {
      Stop-TreeProcesses $prTree
      if ($script:GitPath -and $script:ReviewCheckoutPath) {
        if (Test-Path -LiteralPath $prTree) {
          $null = Invoke-Git $script:ReviewCheckoutPath ('worktree remove --force ' + (Quote-Argument $prTree))
        }
        if (Test-Path -LiteralPath $prTree) {
          $null = Invoke-Tool $script:CmdExe ('/d /c rmdir /s /q ' + (Quote-Argument $prTree)) (Join-Path $flakeDir '.rmdir.out.tmp') (Join-Path $flakeDir '.rmdir.err.tmp') $script:WorkRoot
        }
        $null = Invoke-Git $script:ReviewCheckoutPath 'worktree prune'
      }
    }
  }
}

function Invoke-FlakeRetryIfEligible {
  param(
    $Gate,
    [string]$GatePath,
    $Evaluation,
    [string]$HeadSha,
    [int]$PrNumber,
    [string]$RunDir
  )
  $reviewDir = ''
  if (-not [string]::IsNullOrWhiteSpace($GatePath)) {
    $reviewDir = Split-Path -Parent $GatePath
  }
  $failureInfo = Get-FlakeFailureInfo -NewFailures @($Evaluation.newFailures) -ReviewDir $reviewDir
  if (-not $failureInfo.ok) {
    Write-Log ('flake retry skipped: ' + $failureInfo.reason)
    return [pscustomobject]@{ attempted = $false; passed = $false; reason = $failureInfo.reason; files = [string[]]@(); firstFailures = [object[]]@(); command = ''; unitLogPath = ''; vitestJsonPath = '' }
  }
  $changedInfo = Get-PrChangedFiles -Gate $Gate -ReviewDir $reviewDir -HeadSha $HeadSha
  if (-not $changedInfo.ok) {
    Write-Log 'flake retry skipped: could not determine PR changed files'
    return [pscustomobject]@{ attempted = $false; passed = $false; reason = 'could not determine PR changed files'; files = [string[]]@(); firstFailures = [object[]]@(); command = ''; unitLogPath = ''; vitestJsonPath = '' }
  }
  $changedSet = @{}
  foreach ($cf in @($changedInfo.files)) {
    $changedSet[$cf.ToLowerInvariant()] = $true
  }
  $overlap = New-Object Collections.Generic.List[string]
  foreach ($ff in @($failureInfo.files)) {
    if ($changedSet.ContainsKey($ff.ToLowerInvariant())) {
      $null = $overlap.Add($ff)
    }
  }
  if ($overlap.Count -gt 0) {
    $msg = 'failing test file(s) are part of the PR diff: ' + ($overlap.ToArray() -join ', ')
    Write-Log ('flake retry skipped: ' + $msg)
    return [pscustomobject]@{ attempted = $false; passed = $false; reason = $msg; files = [string[]]@(); firstFailures = [object[]]@(); command = ''; unitLogPath = ''; vitestJsonPath = '' }
  }
  if (-not (Test-ReviewerBlockingOnlyFlake -Gate $Gate -FailingFiles @($failureInfo.files) -ChangedFiles @($changedInfo.files))) {
    Write-Log 'flake retry skipped: reviewer verdict has blocking points beyond the unrelated failing unit tests'
    return [pscustomobject]@{ attempted = $false; passed = $false; reason = 'reviewer verdict has non-flake blocking points'; files = [string[]]@(); firstFailures = [object[]]@(); command = ''; unitLogPath = ''; vitestJsonPath = '' }
  }

  # PR code runs under one shared standard account, so the rerun waits for any other PR's checks (same lock as Invoke-PrReview.ps1).
  $checksMutex = New-Object System.Threading.Mutex($false, 'Global\TivanoUntrustedChecks')
  $checksLocked = $false
  try {
    try { $checksLocked = $checksMutex.WaitOne(7200000) } catch [System.Threading.AbandonedMutexException] { $checksLocked = $true }
    if (-not $checksLocked) { throw 'Timed out waiting for the untrusted-checks lock.' }
    $rerun = Invoke-FlakeRerun -PrNumber $PrNumber -HeadSha $HeadSha -FailingFiles @($failureInfo.files) -FailingTests @($failureInfo.tests) -RunDir $RunDir
  } finally {
    if ($checksLocked) { try { $checksMutex.ReleaseMutex() } catch { } }
    $checksMutex.Dispose()
  }
  return [pscustomobject]@{
    attempted = $true
    passed = [bool]$rerun.passed
    reason = [string]$rerun.reason
    files = [string[]]$failureInfo.files
    firstFailures = [object[]]$failureInfo.firstFailures
    command = [string]$rerun.command
    unitLogPath = [string]$rerun.unitLogPath
    vitestJsonPath = [string]$rerun.vitestJsonPath
  }
}

function Write-GateFailures {
  param([string]$Path, $Evaluation, [string[]]$Extra, [string]$Sha, [string[]]$GlmBlocking = @(), [string]$GlmModel = 'GLM-5.4')
  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('# Merge gate failures')
  $null = $lines.Add('')
  $shortSha = $Sha
  if ($Sha.Length -ge 7) { $shortSha = $Sha.Substring(0, 7) }
  $null = $lines.Add('These conditions failed for head ' + $shortSha + '. Fix every one of them.')
  $null = $lines.Add('')
  foreach ($item in @($Extra) + @($Evaluation.content)) { if ($item) { $null = $lines.Add('- ' + $item) } }
  $reviewerPrefix = 'GLM-5.4'
  if (-not [string]::IsNullOrWhiteSpace($GlmModel)) { $reviewerPrefix = $GlmModel }
  foreach ($item in @($GlmBlocking)) { if ($item) { $null = $lines.Add('- ' + $reviewerPrefix + ': ' + $item) } }
  if ($Evaluation.newFailures.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('## New failing unit tests')
    $null = $lines.Add('')
    foreach ($name in @($Evaluation.newFailures | Select-Object -First 50)) { $null = $lines.Add('- ' + $name) }
  }
  Write-Text $Path (($lines.ToArray() -join "`n") + "`n")
}

function Start-GlmSecondReview {
  param([int]$Pr, [string]$Sha, [string]$RunDir)
  $glmOutLog = Join-Path $RunDir 'glm-review.out.log'
  $glmErrLog = Join-Path $RunDir 'glm-review.err.log'
  try {
    if (-not (Test-Path -LiteralPath $script:GlmScript -PathType Leaf)) {
      return [pscustomobject]@{
        started = $false
        process = $null
        deadlineUtc = [DateTime]::UtcNow
        outLog = $glmOutLog
        errLog = $glmErrLog
        runDir = $RunDir
        sha = $Sha
        errorResult = [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = 'Invoke-GlmReview.ps1 is missing' }
      }
    }
    $glmScriptPath = Get-AcceptancePath $script:GlmScript
    Assert-CmdSafePath 'Invoke-GlmReview.ps1' $glmScriptPath
    $glmArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $glmScriptPath) +
      ' -Mode review -PrNumber ' + $Pr + ' -Repo ' + $Repo + ' -Root ' + (Quote-Argument $script:WorkRoot) +
      ' -TimeoutMin ' + $GlmTimeoutMin + ' -HeadSha ' + $Sha
    $defaultRepo = Join-Path $script:WorkRoot 'repo'
    if (-not (Test-Path -LiteralPath (Join-Path $defaultRepo '.git'))) {
      $glmArgs += ' -Checkout ' + (Quote-Argument $script:ReviewCheckoutPath)
    }

    Write-Log ('glm second review pr #' + $Pr + ' head ' + $Sha.Substring(0, 7))
    $process = Start-Process -FilePath $script:PowerShellExe -ArgumentList $glmArgs `
      -RedirectStandardOutput $glmOutLog -RedirectStandardError $glmErrLog `
      -WorkingDirectory $script:WorkRoot -WindowStyle Hidden -PassThru
    if (-not $process) {
      return [pscustomobject]@{
        started = $false
        process = $null
        deadlineUtc = [DateTime]::UtcNow
        outLog = $glmOutLog
        errLog = $glmErrLog
        runDir = $RunDir
        sha = $Sha
        errorResult = [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = 'could not start Invoke-GlmReview.ps1' }
      }
    }
    # Open the handle early so Windows PowerShell populates ExitCode even if the process exits before WaitForExit.
    $null = $process.Handle
    return [pscustomobject]@{
      started = $true
      process = $process
      deadlineUtc = [DateTime]::UtcNow.AddMinutes(($GlmTimeoutMin * 2) + 5)
      outLog = $glmOutLog
      errLog = $glmErrLog
      runDir = $RunDir
      sha = $Sha
      errorResult = $null
    }
  } catch {
    return [pscustomobject]@{
      started = $false
      process = $null
      deadlineUtc = [DateTime]::UtcNow
      outLog = $glmOutLog
      errLog = $glmErrLog
      runDir = $RunDir
      sha = $Sha
      errorResult = [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = (ConvertTo-SingleLine $_.Exception.Message 200) }
    }
  }
}

function Wait-GlmSecondReview {
  param($Handle)
  if ($null -eq $Handle) {
    return [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = 'GLM-5.4 review was not started' }
  }
  if (-not $Handle.started) {
    return $Handle.errorResult
  }
  $process = $Handle.process
  $glmOutLog = [string]$Handle.outLog
  $glmErrLog = [string]$Handle.errLog
  $runDir = [string]$Handle.runDir
  $sha = [string]$Handle.sha
  try {
    $exited = $process.HasExited
    if (-not $exited) {
      $remaining = ($Handle.deadlineUtc - [DateTime]::UtcNow).TotalMilliseconds
      $waitMs = 0
      if ($remaining -gt 0) { $waitMs = [int][Math]::Ceiling($remaining) }
      $exited = $process.WaitForExit($waitMs)
    }
    if (-not $exited) {
      $taskkill = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
      $null = Invoke-Tool $taskkill ('/T /F /PID ' + $process.Id) (Join-Path $runDir 'glm-kill.out.log') (Join-Path $runDir 'glm-kill.err.log') $script:WorkRoot
      $null = $process.WaitForExit(5000)
      return [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = 'Invoke-GlmReview.ps1 timed out' }
    }
    $process.WaitForExit()
  } finally {
    try { $process.Dispose() } catch { }
  }

  $tail = Get-Tail $glmOutLog 1
  if ([string]::IsNullOrWhiteSpace($tail)) {
    $errTail = ConvertTo-SingleLine ([string](Get-Tail $glmErrLog 5)) 200
    $msg = 'GLM-5.4 produced no summary'
    if ($errTail) { $msg = 'GLM-5.4 produced no summary: ' + $errTail }
    return [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = $msg }
  }
  $glmData = $null
  try { $glmData = $tail | ConvertFrom-Json } catch { }
  if ($glmData -isnot [pscustomobject]) {
    return [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = 'GLM-5.4 summary was not valid JSON' }
  }
  $glmModel = [string](Get-JsonProp $glmData 'model')
  if ([string]::IsNullOrWhiteSpace($glmModel)) { $glmModel = 'GLM-5.4' }
  $glmFallbackReason = [string](Get-JsonProp $glmData 'fallbackReason')
  $glmRunDir = [string](Get-JsonProp $glmData 'runDir')
  $glmHead = [string](Get-JsonProp $glmData 'headSha')
  if ($glmHead -and $glmHead -ne $sha) {
    return [pscustomobject]@{ status = 'unavailable'; model = $glmModel; fallbackReason = $glmFallbackReason; verdict = ''; blocking = @(); runDir = $glmRunDir; message = ('PR head moved before ' + $glmModel + ' review completed') }
  }
  $glmStatus = [string](Get-JsonProp $glmData 'status')
  if ($glmStatus -ne 'ok') {
    $msg = [string](Get-JsonProp $glmData 'message')
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = $glmModel + ' review unavailable' }
    return [pscustomobject]@{ status = 'unavailable'; model = $glmModel; fallbackReason = $glmFallbackReason; verdict = ''; blocking = @(); runDir = $glmRunDir; message = $msg }
  }
  $glmVerdict = [string](Get-JsonProp $glmData 'verdict')
  $glmBlocking = @(ConvertTo-StringList (Get-JsonProp $glmData 'blocking'))
  return [pscustomobject]@{ status = 'ok'; model = $glmModel; fallbackReason = $glmFallbackReason; verdict = $glmVerdict; blocking = $glmBlocking; runDir = $glmRunDir; message = '' }
}

function Invoke-GlmSecondReview {
  param([int]$Pr, [string]$Sha, [string]$RunDir)
  $handle = Start-GlmSecondReview -Pr $Pr -Sha $Sha -RunDir $RunDir
  return (Wait-GlmSecondReview -Handle $handle)
}

$headShaOut = ''
$verdictOut = 'unavailable'
$failuresOut = New-Object Collections.Generic.List[string]
$gatePathOut = ''
$flakeRetriedOut = $null
$glmOut = [ordered]@{
  status = 'skipped'
  model = ''
  verdict = ''
  blocking = 0
  runDir = ''
}
$notesOut = New-Object Collections.Generic.List[string]
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
  $runDirCandidate = Join-Path $WorkRoot ('autopilot\gate\pr-' + $PrNumber + '-' + $stamp)
  if (Test-Path -LiteralPath $runDirCandidate) {
    $runDirCandidate = $runDirCandidate + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 4)
  }
  $script:RunDir = $runDirCandidate
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

  $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($git) { $script:GitPath = $git.Source }
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
  } elseif ($null -ne ($staleMsg = Get-BranchStaleness $info)) {
    # Checks and reviews of an out-of-date head fail for reasons unrelated to the PR and cost a full gate run.
    $headShaOut = $info.headSha
    $verdictOut = 'fail'
    $exitCode = 1
    $null = $failuresOut.Add($staleMsg)
    Write-Log ('gate skipped: ' + $staleMsg)
  } else {
    $headShaOut = $info.headSha
    $review = $null
    $glmHandle = $null
    $glmResult = $null
    try {
      for ($lockTry = 0; $lockTry -le 10; $lockTry++) {
        $tag = 'g0'
        if ($lockTry -gt 0) { $tag = 'g' + $lockTry }
        $reviewHandle = Start-ReviewTask -Pr $PrNumber -Sha $headShaOut -RunDir $script:RunDir -NoPost $false -Tag $tag
        if ($lockTry -eq 0 -and -not $SkipGlm) {
          $glmHandle = Start-GlmSecondReview -Pr $PrNumber -Sha $headShaOut -RunDir $script:RunDir
        }
        $review = Wait-ReviewTask -Handle $reviewHandle
        if ($review.status -ne 'busy') { break }
        if ($lockTry -lt 10) {
          Write-Log ('reviewer lock busy; waiting 60s before retry ' + ($lockTry + 1) + '/10')
          Start-Sleep -Seconds 60
        }
      }
      if ($null -ne $glmHandle) {
        try {
          $glmResult = Wait-GlmSecondReview -Handle $glmHandle
        } catch {
          $glmResult = [pscustomobject]@{ status = 'unavailable'; model = 'GLM-5.4'; fallbackReason = ''; verdict = ''; blocking = @(); runDir = ''; message = (ConvertTo-SingleLine $_.Exception.Message 200) }
        }
        $glmHandle = $null
      }
    } finally {
      if ($null -ne $glmHandle) {
        try { $null = Wait-GlmSecondReview -Handle $glmHandle } catch { }
        $glmHandle = $null
      }
    }

    if (-not $review -or $review.status -ne 'ok') {
      $msg = 'review unavailable'
      if ($review -and $review.message) { $msg = [string]$review.message }
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
      } else {
        $flakePassed = $false
        if ($evaluation.content.Count -gt 0 -and $extra.Count -eq 0 -and $evaluation.flakeCandidate) {
          # Any error in the optional flake retry falls back to the ordinary gate failure.
          $flakeRetry = [pscustomobject]@{ passed = $false }
          try {
            $flakeRetry = Invoke-FlakeRetryIfEligible -Gate $review.gate -GatePath $gatePathOut -Evaluation $evaluation -HeadSha $headShaOut -PrNumber $PrNumber -RunDir $script:RunDir
          } catch {
            Write-Log ('flake retry failed, keeping the gate failure: ' + $_.Exception.Message)
            $flakeRetry = [pscustomobject]@{ passed = $false }
          }
          if ($flakeRetry.passed) {
            $flakePassed = $true
            $flakeRetriedOut = [ordered]@{
              files = [string[]]$flakeRetry.files
              firstFailures = [object[]]$flakeRetry.firstFailures
              command = [string]$flakeRetry.command
              rerunVitestJson = [string]$flakeRetry.vitestJsonPath
              rerunUnitLog = [string]$flakeRetry.unitLogPath
            }
            $evaluation = [pscustomobject]@{
              infra = [string[]]@()
              content = [string[]]@()
              newFailures = [string[]]@()
              flakeCandidate = $false
            }
            $flakeNote = 'flakeRetried passed on single rerun for unrelated test file(s): ' + (@($flakeRetry.files) -join ', ')
            $null = $notesOut.Add($flakeNote)
            Write-Log $flakeNote
            foreach ($ff in @($flakeRetry.firstFailures)) {
              Write-Log ('flakeRetried first failure [' + $ff['file'] + '] ' + $ff['test'] + ': ' + $ff['message'])
            }
          } elseif ($flakeRetry.attempted) {
            $flakeFailNote = 'flake retry failed again: ' + $flakeRetry.reason
            $null = $notesOut.Add($flakeFailNote)
            Write-Log $flakeFailNote
          }
        }

        if (-not $flakePassed -and ($evaluation.content.Count -gt 0 -or $extra.Count -gt 0)) {
          $verdictOut = 'fail'
          $exitCode = 1
          foreach ($item in @($extra) + @($evaluation.content)) {
            if ($item) { $null = $failuresOut.Add($item) }
          }
          foreach ($unitName in @($evaluation.newFailures | Select-Object -First 50)) {
            $null = $failuresOut.Add('new failing unit test: ' + $unitName)
          }
        } else {
          $verdictOut = 'pass'
          $exitCode = 0
        }

        $glmBlocking = @()
        $glmModel = 'GLM-5.4'
        if (-not $SkipGlm) {
          if ($glmResult) {
            $rawGlmModel = [string](Get-JsonProp $glmResult 'model')
            if (-not [string]::IsNullOrWhiteSpace($rawGlmModel)) { $glmModel = $rawGlmModel }
          }
          if ($glmResult -and $glmResult.status -eq 'ok') {
            $glmBlocking = @($glmResult.blocking)
            $glmOut = [ordered]@{
              status = 'ok'
              model = $glmModel
              verdict = [string]$glmResult.verdict
              blocking = $glmBlocking.Count
              runDir = [string]$glmResult.runDir
            }
            if ($glmBlocking.Count -gt 0) {
              $verdictOut = 'fail'
              $exitCode = 1
              foreach ($item in $glmBlocking) {
                if ($item) { $null = $failuresOut.Add($glmModel + ': ' + $item) }
              }
            }
            $glmFallbackReason = [string](Get-JsonProp $glmResult 'fallbackReason')
            if (-not [string]::IsNullOrWhiteSpace($glmFallbackReason)) {
              Write-Log ('second review fell back to ' + $glmModel + ': ' + $glmFallbackReason)
            }
            Write-Log ('second review ok: model=' + $glmModel + ' verdict=' + $glmResult.verdict + ' blocking=' + $glmBlocking.Count)
          } else {
            $glmMsg = $glmModel + ' review unavailable'
            if ($glmResult -and $glmResult.message) { $glmMsg = [string]$glmResult.message }
            $glmRunDir = ''
            if ($glmResult -and $glmResult.runDir) { $glmRunDir = [string]$glmResult.runDir }
            $glmOut = [ordered]@{
              status = 'unavailable'
              model = $glmModel
              verdict = ''
              blocking = 0
              runDir = $glmRunDir
            }
            $note = $glmModel + ' review unavailable: ' + $glmMsg
            $null = $notesOut.Add($note)
            Write-Log $note
          }
        }

        if ($verdictOut -eq 'fail') {
          Write-GateFailures (Join-Path $script:RunDir 'failures.md') $evaluation $extra $headShaOut $glmBlocking $glmModel
          Write-Log ('gate fail for PR #' + $PrNumber + ' (' + $failuresOut.Count + ' failure items)')
        } else {
          Write-Log ('gate pass for PR #' + $PrNumber + ' head ' + $headShaOut.Substring(0, 7))
        }
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
  flakeRetried = $flakeRetriedOut
  glm = $glmOut
  notes = [string[]]$notesOut.ToArray()
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
if ($script:RunDir -and (Test-Path -LiteralPath $script:RunDir -PathType Container)) {
  try { Write-Text (Join-Path $script:RunDir 'summary.json') ($json + "`n") } catch { }
}
[Console]::Out.WriteLine($json)
exit $exitCode
