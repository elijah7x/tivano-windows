# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-Audit.ps1 [-ConfigPath <path>] [-PrNumber <n>] [-SinglePr <n>] [-MaxParallel <n>] [-DryRun]
# Independent PR auditor for nyx/* PRs targeting main. Acts solely via GitHub App token through AuditChecks.psm1 (never gh CLI).

param(
  [string]$ConfigPath = 'C:\tivano\audit\config.json',
  [int]$PrNumber = 0,
  [int]$SinglePr = 0,
  [int]$MaxParallel = 3,
  [string]$BaseMainSha = '',
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'AuditChecks.psm1') -Force

$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $script:PowerShellExe -PathType Leaf)) {
  $script:PowerShellExe = 'powershell.exe'
}
$script:ScriptPath = $PSCommandPath
$script:GitPath = $null
$script:WorkRoot = $null
$script:LogPath = $null
$script:LogPrefix = ''
$script:AuditStateMutexName = 'Global\TivanoAuditState'
$script:AuditRepoMutexName = 'Global\TivanoAuditRepo'
$script:AuditMutexTimeoutMs = 120000
$script:Redactions = @()

$script:GuardedPrefixes = @(
  'scripts/dev-loop/',
  'scripts/pr-review/',
  'scripts/windows-acceptance/',
  'scripts/audit/',
  '.github/'
)
$script:GuardedFiles = @(
  'agents.md',
  'contributing.md',
  'license',
  'third_party_notices.md',
  'trademark.md',
  'docs/source-baseline.json',
  'package-lock.json'
)
$script:DependencySections = @(
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'bundleDependencies',
  'overrides'
)

function Write-Text {
  param(
    [string]$Path,
    [AllowEmptyString()][string]$Text
  )
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Read-Text {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Quote-Arg {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function Get-JsonProp {
  param(
    $Object,
    [string]$Name
  )
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -ne $prop) { return $prop.Value }
  return $null
}

function ConvertTo-SingleLine {
  param(
    [AllowEmptyString()][string]$Text,
    [int]$Limit = 240
  )
  if ($null -eq $Text) { return '' }
  $line = [regex]::Replace($Text, '[\x00-\x1f\x7f]+', ' ')
  $line = [regex]::Replace($line, '\s+', ' ').Trim()
  $line = $line.Replace('"', "'").TrimEnd('\')
  if ($line.Length -gt $Limit) { $line = $line.Substring(0, $Limit).Trim() }
  return $line
}

function Escape-MarkdownCell {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $clean = [regex]::Replace($Text, "`r?`n", ' ')
  $clean = [regex]::Replace($clean, '\s+', ' ').Trim()
  return $clean.Replace('|', '\|')
}

function Write-Log {
  param([string]$Message)
  if (-not $script:LogPath) { return }
  $safe = Protect-LogText $Message
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $script:LogPrefix + $safe + "`r`n"
  try {
    [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

function Assert-OutsideGitCheckout {
  param([string]$Path)
  $part = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  while ($part) {
    if (Test-Path -LiteralPath (Join-Path $part '.git')) {
      throw ($Path + ' is inside a git checkout (' + $part + '). Keep audit state and worktrees outside any checkout.')
    }
    $parent = Split-Path -Parent $part
    if (-not $parent -or $parent -eq $part) { break }
    $part = $parent
  }
}

function Initialize-Redactions {
  param(
    [string[]]$Paths
  )
  $all = New-Object Collections.Generic.List[string]
  $candidates = @($Paths) + @($env:USERPROFILE, 'C:\tivano')
  foreach ($item in $candidates) {
    if ([string]::IsNullOrWhiteSpace($item) -or $item.Length -lt 4) { continue }
    $null = $all.Add($item)
    $null = $all.Add($item.Replace('\', '/'))
  }
  if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Length -ge 4) { $null = $all.Add($env:COMPUTERNAME) }
  if ($env:USERNAME -and $env:USERNAME.Length -ge 4) { $null = $all.Add($env:USERNAME) }
  $script:Redactions = @($all | Sort-Object -Unique | Sort-Object { $_.Length } -Descending)
}

function Protect-LogText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $result = [regex]::Replace($Text, '(?i)AUTHORIZATION:\s*(?:basic|bearer)\s+[A-Za-z0-9+/=_.-]+', 'AUTHORIZATION: <redacted>')
  $result = [regex]::Replace($result, '(?i)\b(?:ghs|ghp|gho|ghu|github_pat)_[A-Za-z0-9_]+\b', '<redacted-token>')
  return $result
}

function Protect-PublicText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $result = Protect-LogText $Text
  foreach ($secret in $script:Redactions) {
    $result = [regex]::Replace($result, [regex]::Escape($secret), '<redacted>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  }
  $result = [regex]::Replace($result, '(?i)(?<![A-Za-z0-9])[A-Za-z]:(?:\\|/)[^\s"''`<>|\)\]]+', '<redacted-path>')
  $result = [regex]::Replace($result, '(?i)(?:\\|/)Users(?:\\|/)[^\\/\s"''`<>|\)\]]+', '<redacted-user>')
  return $result
}

function Invoke-Tool {
  param(
    [string]$FilePath,
    [string]$Arguments,
    [string]$OutPath,
    [string]$ErrPath,
    [string]$WorkingDirectory
  )
  $parameters = @{
    FilePath = $FilePath
    ArgumentList = $Arguments
    RedirectStandardOutput = $OutPath
    RedirectStandardError = $ErrPath
    WindowStyle = 'Hidden'
    Wait = $true
    PassThru = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $parameters['WorkingDirectory'] = $WorkingDirectory
  }
  $process = Start-Process @parameters
  return $process.ExitCode
}

function Test-NetworkFailure {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bEOF\b|handshake|schannel|Could not resolve host|Failed to connect|connection (was )?(reset|refused|closed)|i/o timeout|TLS|unable to access|error connecting to|no such host')
}

function Get-GitAuthArgs {
  param($Config)
  $token = Get-AuditToken -Config $Config
  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('x-access-token:' + $token))
  return '-c credential.helper= -c ' + (Quote-Arg ('http.https://github.com/.extraheader=AUTHORIZATION: basic ' + $basic))
}

function Invoke-Git {
  param(
    [string]$Directory,
    [string]$Arguments,
    $AuthConfig = $null,
    [string]$TempBase = ''
  )
  $baseDir = $script:WorkRoot
  if (-not [string]::IsNullOrWhiteSpace($TempBase)) { $baseDir = $TempBase }
  $tag = $PID.ToString() + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $out = Join-Path $baseDir ('.git-' + $tag + '.out.tmp')
  $err = Join-Path $baseDir ('.git-' + $tag + '.err.tmp')
  try {
    for ($try = 1; ; $try++) {
      $prefix = ''
      if (-not [string]::IsNullOrWhiteSpace($Directory)) {
        $prefix = '-C ' + (Quote-Arg $Directory) + ' '
      }
      if ($null -ne $AuthConfig) {
        $prefix += (Get-GitAuthArgs $AuthConfig) + ' '
      }
      $code = Invoke-Tool $script:GitPath ($prefix + $Arguments) $out $err $script:WorkRoot
      $result = [pscustomobject]@{
        exitCode = $code
        text = (Read-Text $out)
        error = (Protect-LogText ([string](Read-Text $err)))
      }
      if ($code -eq 0 -or $try -ge 3 -or -not (Test-NetworkFailure $result.error)) {
        return $result
      }
      Write-Log ('git network failure, retry ' + $try + '/2: ' + (ConvertTo-SingleLine $result.error 160))
      Start-Sleep -Seconds (10 * $try)
    }
  } finally {
    try { if (Test-Path -LiteralPath $out -PathType Leaf) { [IO.File]::Delete($out) } } catch { }
    try { if (Test-Path -LiteralPath $err -PathType Leaf) { [IO.File]::Delete($err) } } catch { }
  }
}

function Stop-WorktreeProcesses {
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
      $exeHit = $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($Worktree, [StringComparison]::OrdinalIgnoreCase)
      $cmdHit = $proc.CommandLine -and $proc.CommandLine.IndexOf($Worktree, [StringComparison]::OrdinalIgnoreCase) -ge 0
      if ($exeHit -or $cmdHit) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}

function Read-PrState {
  param(
    [string]$Path,
    [int]$Number
  )
  $default = [ordered]@{
    prNumber = $Number
    headSha = ''
    attempts = 0
    lastAttemptAt = ''
    lastErrorKind = ''
    round = 0
    lastCommentId = [long]0
    lastCommentCreatedAt = ''
    lastRebuttalCommentId = [long]0
    pendingRebuttalCommentId = [long]0
    verdict = ''
    baseSha = ''
    priorFindings = @()
    arbiterState = ''
    arbiterDone = $false
    arbiterPending = $null
    updatedAt = ''
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]$default }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]$default }
  try {
    $data = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
  } catch {
    return [pscustomobject]$default
  }
  if ($data -isnot [pscustomobject]) { return [pscustomobject]$default }

  $default['headSha'] = [string](Get-JsonProp $data 'headSha')
  $att = Get-JsonProp $data 'attempts'
  if ($null -ne $att) { $default['attempts'] = [int]$att }
  $lat = Get-JsonProp $data 'lastAttemptAt'
  if ($null -ne $lat) { $default['lastAttemptAt'] = [string]$lat }
  $lek = Get-JsonProp $data 'lastErrorKind'
  if ($null -ne $lek) { $default['lastErrorKind'] = [string]$lek }
  $rnd = Get-JsonProp $data 'round'
  if ($null -ne $rnd) { $default['round'] = [int]$rnd }
  $cid = Get-JsonProp $data 'lastCommentId'
  if ($null -ne $cid) { $default['lastCommentId'] = [long]$cid }
  $cat = Get-JsonProp $data 'lastCommentCreatedAt'
  if ($null -ne $cat) { $default['lastCommentCreatedAt'] = [string]$cat }
  $rid = Get-JsonProp $data 'lastRebuttalCommentId'
  if ($null -ne $rid) { $default['lastRebuttalCommentId'] = [long]$rid }
  $prid = Get-JsonProp $data 'pendingRebuttalCommentId'
  if ($null -ne $prid) { $default['pendingRebuttalCommentId'] = [long]$prid }
  $bs = Get-JsonProp $data 'baseSha'
  if ($null -ne $bs) { $default['baseSha'] = [string]$bs }
  $v = Get-JsonProp $data 'verdict'
  if ($null -ne $v) { $default['verdict'] = [string]$v }
  $pf = Get-JsonProp $data 'priorFindings'
  if ($null -ne $pf) { $default['priorFindings'] = @($pf | ForEach-Object { $_ }) }
  $as = Get-JsonProp $data 'arbiterState'
  if ($null -ne $as) { $default['arbiterState'] = [string]$as }
  $ad = Get-JsonProp $data 'arbiterDone'
  if ($null -ne $ad) { $default['arbiterDone'] = [bool]$ad }
  $ap = Get-JsonProp $data 'arbiterPending'
  if ($null -ne $ap -and $ap -is [pscustomobject]) {
    $apIssue = Get-JsonProp $ap 'issueNumber'
    $apIssueNum = 0
    if ($null -ne $apIssue) { $apIssueNum = [int]$apIssue }
    $apFindings = @()
    $apFindingsRaw = Get-JsonProp $ap 'blockingFindings'
    if ($null -ne $apFindingsRaw) { $apFindings = @($apFindingsRaw | Where-Object { $null -ne $_ }) }
    $apAcc = @()
    $apAccRaw = Get-JsonProp $ap 'failedAcceptance'
    if ($null -ne $apAccRaw) { $apAcc = @($apAccRaw | Where-Object { $null -ne $_ }) }
    $apClaims = @()
    $apClaimsRaw = Get-JsonProp $ap 'falseClaims'
    if ($null -ne $apClaimsRaw) { $apClaims = @($apClaimsRaw | Where-Object { $null -ne $_ }) }
    $default['arbiterPending'] = [pscustomobject]@{
      issueNumber = $apIssueNum
      commentUrl = [string](Get-JsonProp $ap 'commentUrl')
      rebuttal = [string](Get-JsonProp $ap 'rebuttal')
      blockingFindings = $apFindings
      failedAcceptance = $apAcc
      falseClaims = $apClaims
    }
  }
  $upd = Get-JsonProp $data 'updatedAt'
  if ($null -ne $upd) { $default['updatedAt'] = [string]$upd }

  return [pscustomobject]$default
}

function Move-TempFileAtomic {
  param(
    [string]$TempPath,
    [string]$DestinationPath
  )
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        # PowerShell turns $null into an empty string for a string parameter; File.Replace needs a real null.
        [IO.File]::Replace($TempPath, $DestinationPath, [NullString]::Value)
      } else {
        [IO.File]::Move($TempPath, $DestinationPath)
      }
      return
    } catch {
      if ($attempt -lt 8) {
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    }
  }
  try {
    [IO.File]::Copy($TempPath, $DestinationPath, $true)
    try {
      if (Test-Path -LiteralPath $TempPath -PathType Leaf) {
        [IO.File]::Delete($TempPath)
      }
    } catch { }
    return
  } catch {
    $fallbackErr = $_
    try {
      if (Test-Path -LiteralPath $TempPath -PathType Leaf) {
        [IO.File]::Delete($TempPath)
      }
    } catch { }
    throw $fallbackErr
  }
}

function Save-PrState {
  param(
    [string]$Path,
    $State
  )
  $State.updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $tmp = $Path + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.tmp'
  Write-Text $tmp ((ConvertTo-Json -InputObject $State -Depth 8) + "`n")
  Move-TempFileAtomic -TempPath $tmp -DestinationPath $Path
}

function Get-ArbiterDailyPath {
  param([string]$StateDir)
  return (Join-Path $StateDir ('arbiter-' + [DateTime]::Now.ToString('yyyy-MM-dd') + '.json'))
}

function Read-ArbiterDailyState {
  param([string]$Path)
  $today = [DateTime]::Now.ToString('yyyy-MM-dd')
  $default = [ordered]@{
    date = $today
    count = 0
    runs = @()
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]$default }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]$default }
  try {
    $data = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
  } catch {
    return [pscustomobject]$default
  }
  if ($data -isnot [pscustomobject]) { return [pscustomobject]$default }
  $d = Get-JsonProp $data 'date'
  if ($null -ne $d -and -not [string]::IsNullOrWhiteSpace([string]$d)) { $default['date'] = [string]$d }
  $cnt = Get-JsonProp $data 'count'
  if ($null -ne $cnt) { $default['count'] = [int]$cnt }
  $runsRaw = Get-JsonProp $data 'runs'
  if ($null -ne $runsRaw) { $default['runs'] = @($runsRaw | Where-Object { $null -ne $_ }) }
  return [pscustomobject]$default
}

function Save-ArbiterDailyState {
  param(
    [string]$Path,
    $DailyState
  )
  $tmp = $Path + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.tmp'
  Write-Text $tmp ((ConvertTo-Json -InputObject $DailyState -Depth 6) + "`n")
  Move-TempFileAtomic -TempPath $tmp -DestinationPath $Path
}

function Invoke-WithNamedMutex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$MutexName,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action,
    [int]$TimeoutMs = 120000
  )
  $mutex = New-Object Threading.Mutex($false, $MutexName)
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne($TimeoutMs)
    } catch [Threading.AbandonedMutexException] {
      # A previous holder exited without releasing the mutex; this thread now owns it.
      $acquired = $true
    }
    if (-not $acquired) {
      throw ('Timed out after ' + [int]($TimeoutMs / 1000) + 's waiting for mutex ' + $MutexName)
    }
    $result = & $Action
    return $result
  } finally {
    if ($acquired) {
      try { $mutex.ReleaseMutex() } catch { }
    }
    $mutex.Dispose()
  }
}

function Invoke-WithAuditStateLock {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action,
    [int]$TimeoutMs = 120000
  )
  return (Invoke-WithNamedMutex -MutexName $script:AuditStateMutexName -TimeoutMs $TimeoutMs -Action $Action)
}

function Set-PrStateFields {
  param(
    $Target,
    $Source
  )
  $Target.headSha = [string](Get-JsonProp $Source 'headSha')
  $att = Get-JsonProp $Source 'attempts'
  $Target.attempts = 0
  if ($null -ne $att) { $Target.attempts = [int]$att }
  $lat = Get-JsonProp $Source 'lastAttemptAt'
  $Target.lastAttemptAt = ''
  if ($null -ne $lat) { $Target.lastAttemptAt = [string]$lat }
  $lek = Get-JsonProp $Source 'lastErrorKind'
  $Target.lastErrorKind = ''
  if ($null -ne $lek) { $Target.lastErrorKind = [string]$lek }
  $rnd = Get-JsonProp $Source 'round'
  $Target.round = 0
  if ($null -ne $rnd) { $Target.round = [int]$rnd }
  $cid = Get-JsonProp $Source 'lastCommentId'
  $Target.lastCommentId = [long]0
  if ($null -ne $cid) { $Target.lastCommentId = [long]$cid }
  $cat = Get-JsonProp $Source 'lastCommentCreatedAt'
  $Target.lastCommentCreatedAt = ''
  if ($null -ne $cat) { $Target.lastCommentCreatedAt = [string]$cat }
  $rid = Get-JsonProp $Source 'lastRebuttalCommentId'
  $Target.lastRebuttalCommentId = [long]0
  if ($null -ne $rid) { $Target.lastRebuttalCommentId = [long]$rid }
  $prid = Get-JsonProp $Source 'pendingRebuttalCommentId'
  $Target.pendingRebuttalCommentId = [long]0
  if ($null -ne $prid) { $Target.pendingRebuttalCommentId = [long]$prid }
  $v = Get-JsonProp $Source 'verdict'
  $Target.verdict = ''
  if ($null -ne $v) { $Target.verdict = [string]$v }
  $bs = Get-JsonProp $Source 'baseSha'
  $Target.baseSha = ''
  if ($null -ne $bs) { $Target.baseSha = [string]$bs }
  $pf = Get-JsonProp $Source 'priorFindings'
  $Target.priorFindings = @()
  if ($null -ne $pf) { $Target.priorFindings = @($pf | ForEach-Object { $_ }) }
  $as = Get-JsonProp $Source 'arbiterState'
  $Target.arbiterState = ''
  if ($null -ne $as) { $Target.arbiterState = [string]$as }
  $ad = Get-JsonProp $Source 'arbiterDone'
  $Target.arbiterDone = $false
  if ($null -ne $ad) { $Target.arbiterDone = [bool]$ad }
  $Target.arbiterPending = Get-JsonProp $Source 'arbiterPending'
}

function Read-PrStateLocked {
  param(
    [string]$Path,
    [int]$Number
  )
  return (Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    return (Read-PrState -Path $Path -Number $Number)
  })
}

function Update-PrStateLocked {
  param(
    [string]$Path,
    [int]$Number,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Mutate
  )
  return (Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    $fresh = Read-PrState -Path $Path -Number $Number
    & $Mutate $fresh
    Save-PrState -Path $Path -State $fresh
    return $fresh
  })
}

function Read-ArbiterDailyStateLocked {
  param([string]$Path)
  return (Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    return (Read-ArbiterDailyState -Path $Path)
  })
}

function Get-CurrentProcessStartUtc {
  try {
    $cur = [Diagnostics.Process]::GetCurrentProcess()
    return $cur.StartTime.ToUniversalTime().ToString('o')
  } catch {
    return ''
  }
}

function Test-ClaimOwnerAlive {
  param(
    [int]$OwnerPid,
    [string]$RecordedStartUtc = ''
  )
  if ($OwnerPid -le 0) { return $false }
  $proc = $null
  try {
    $proc = [Diagnostics.Process]::GetProcessById($OwnerPid)
  } catch {
    return $false
  }
  try {
    if ($proc.HasExited) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($RecordedStartUtc)) {
      try {
        $actualStart = $proc.StartTime.ToUniversalTime()
        $expectedStart = [DateTimeOffset]::Parse($RecordedStartUtc).UtcDateTime
        if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 5) {
          return $false
        }
      } catch {
        # Access denied on StartTime means the PID belongs to another user or system process.
        return $false
      }
    }
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $proc) {
      try { $proc.Dispose() } catch { }
    }
  }
}

function Read-PrClaimFile {
  param([string]$LockPath)
  if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { return $null }
  $text = Read-Text $LockPath
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try {
    $data = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($data -is [pscustomobject]) { return $data }
  } catch { }
  return $null
}

function Get-LivePrClaim {
  param(
    [string]$ClaimsDir,
    [int]$PrNumber
  )
  $lockPath = Join-Path $ClaimsDir ('pr-' + $PrNumber + '.lock')
  return (Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
    $existing = Read-PrClaimFile -LockPath $lockPath
    if ($null -eq $existing) { return $null }
    $ownerPid = 0
    $rawPid = Get-JsonProp $existing 'pid'
    if ($null -ne $rawPid) {
      $parsedPid = 0
      if ([int]::TryParse([string]$rawPid, [ref]$parsedPid)) { $ownerPid = $parsedPid }
    }
    $startUtc = [string](Get-JsonProp $existing 'processStartUtc')
    if (Test-ClaimOwnerAlive -OwnerPid $ownerPid -RecordedStartUtc $startUtc) {
      return [pscustomobject]@{
        prNumber = $PrNumber
        pid = $ownerPid
        lockPath = $lockPath
        claimedAt = [string](Get-JsonProp $existing 'claimedAt')
      }
    }
    return $null
  })
}

function Try-AcquirePrClaim {
  param(
    [string]$ClaimsDir,
    [int]$PrNumber
  )
  $lockPath = Join-Path $ClaimsDir ('pr-' + $PrNumber + '.lock')
  $myStartUtc = Get-CurrentProcessStartUtc
  return (Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    [IO.Directory]::CreateDirectory($ClaimsDir) | Out-Null
    $staleClearedPid = 0
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
      $existing = Read-PrClaimFile -LockPath $lockPath
      $ownerPid = 0
      $startUtc = ''
      if ($null -ne $existing) {
        $rawPid = Get-JsonProp $existing 'pid'
        if ($null -ne $rawPid) {
          $parsedPid = 0
          if ([int]::TryParse([string]$rawPid, [ref]$parsedPid)) { $ownerPid = $parsedPid }
        }
        $startUtc = [string](Get-JsonProp $existing 'processStartUtc')
      }
      if ($ownerPid -gt 0 -and $ownerPid -ne $PID -and (Test-ClaimOwnerAlive -OwnerPid $ownerPid -RecordedStartUtc $startUtc)) {
        return [pscustomobject]@{
          acquired = $false
          lockPath = $lockPath
          ownerPid = $ownerPid
          staleClearedPid = 0
          reason = ('already claimed by live audit process PID ' + $ownerPid)
        }
      }
      $staleClearedPid = $ownerPid
    }
    $claimPayload = [ordered]@{
      prNumber = $PrNumber
      pid = $PID
      processStartUtc = $myStartUtc
      claimedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    $tmp = $lockPath + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.tmp'
    Write-Text $tmp ((ConvertTo-Json -InputObject $claimPayload -Depth 4 -Compress) + "`n")
    Move-TempFileAtomic -TempPath $tmp -DestinationPath $lockPath
    return [pscustomobject]@{
      acquired = $true
      lockPath = $lockPath
      ownerPid = $PID
      staleClearedPid = $staleClearedPid
      reason = ''
    }
  })
}

function Release-PrClaim {
  param(
    [string]$LockPath,
    [int]$OwnerPid
  )
  if ([string]::IsNullOrWhiteSpace($LockPath)) { return }
  $null = Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { return }
    $existing = Read-PrClaimFile -LockPath $LockPath
    if ($null -ne $existing) {
      $rawPid = Get-JsonProp $existing 'pid'
      $filePid = 0
      if ($null -ne $rawPid) {
        $parsedPid = 0
        if ([int]::TryParse([string]$rawPid, [ref]$parsedPid)) { $filePid = $parsedPid }
      }
      if ($filePid -gt 0 -and $filePid -ne $OwnerPid) { return }
    }
    [IO.File]::Delete($LockPath)
  }
}

function Test-RetryBackoffActive {
  param(
    $State,
    [int]$BackoffMinutes = 60
  )
  if ([int]$State.attempts -lt 3) { return $false }
  $lastAtRaw = [string](Get-JsonProp $State 'lastAttemptAt')
  if ([string]::IsNullOrWhiteSpace($lastAtRaw)) { return $false }
  try {
    $lastAt = [DateTimeOffset]::Parse($lastAtRaw)
    return (([DateTimeOffset]::UtcNow - $lastAt).TotalMinutes -lt $BackoffMinutes)
  } catch {
    return $false
  }
}

function Test-RemoteOutageException {
  param(
    $Exception,
    [string]$Message
  )
  $cur = $Exception
  while ($null -ne $cur) {
    if ($cur -is [Net.WebException] -or $cur -is [Net.Sockets.SocketException]) {
      return $true
    }
    if ($cur -is [Exception]) {
      $cur = $cur.InnerException
    } else {
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($Message)) { return $false }
  if ($Message -match '(?i)^(?:GitHub API\b|mint-token\.mjs\b|git (?:fetch|clone)\b)') {
    return $true
  }
  return (Test-NetworkFailure $Message)
}

function Get-OpenNyxPulls {
  param(
    $Config,
    [int]$OnlyPrNumber = 0
  )
  $repo = $Config.repo
  if ($OnlyPrNumber -gt 0) {
    $pr = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $repo + '/pulls/' + $OnlyPrNumber)
    if ($null -eq $pr) { return @() }
    $state = ([string](Get-JsonProp $pr 'state')).ToLowerInvariant()
    $headRef = [string](Get-JsonProp (Get-JsonProp $pr 'head') 'ref')
    $baseRef = [string](Get-JsonProp (Get-JsonProp $pr 'base') 'ref')
    if ($state -ne 'open' -or $baseRef -ne 'main' -or $headRef -notlike 'nyx/*') {
      Write-Log ('skip PR #' + $OnlyPrNumber + ': state=' + $state + ' base=' + $baseRef + ' head=' + $headRef)
      return @()
    }
    return @($pr)
  }

  $all = New-Object Collections.Generic.List[object]
  for ($page = 1; $page -le 20; $page++) {
    $resp = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $repo + '/pulls?state=open&base=main&per_page=100&page=' + $page)
    $items = @($resp | Where-Object { $null -ne $_ })
    foreach ($pr in $items) {
      $state = ([string](Get-JsonProp $pr 'state')).ToLowerInvariant()
      $headRef = [string](Get-JsonProp (Get-JsonProp $pr 'head') 'ref')
      $baseRef = [string](Get-JsonProp (Get-JsonProp $pr 'base') 'ref')
      if ($state -eq 'open' -and $baseRef -eq 'main' -and $headRef -like 'nyx/*') {
        $null = $all.Add($pr)
      }
    }
    if ($items.Count -lt 100) { break }
  }
  return @($all | Sort-Object { [int]$_.number })
}

function Get-PrComments {
  param(
    $Config,
    [int]$Number
  )
  $all = New-Object Collections.Generic.List[object]
  for ($page = 1; $page -le 20; $page++) {
    $resp = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Config.repo + '/issues/' + $Number + '/comments?per_page=100&page=' + $page)
    $items = @($resp | Where-Object { $null -ne $_ })
    foreach ($c in $items) { $null = $all.Add($c) }
    if ($items.Count -lt 100) { break }
  }
  return $all.ToArray()
}

function Get-PrCommits {
  param(
    $Config,
    [int]$Number
  )
  $all = New-Object Collections.Generic.List[object]
  for ($page = 1; $page -le 20; $page++) {
    $resp = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Config.repo + '/pulls/' + $Number + '/commits?per_page=100&page=' + $page)
    $items = @($resp | Where-Object { $null -ne $_ })
    foreach ($c in $items) { $null = $all.Add($c) }
    if ($items.Count -lt 100) { break }
  }
  return $all.ToArray()
}

function Get-MainCompare {
  param(
    $Config,
    [string]$HeadSha
  )
  $all = New-Object Collections.Generic.List[object]
  $seenShas = @{}
  $status = ''
  $aheadBy = 0
  $behindBy = 0
  $totalCommits = 0

  if ([string]::IsNullOrWhiteSpace($HeadSha)) {
    return [pscustomobject]@{
      status = $status
      ahead_by = $aheadBy
      behind_by = $behindBy
      total_commits = $totalCommits
      commits = $all.ToArray()
    }
  }

  $headRefEscaped = [Uri]::EscapeDataString($HeadSha.Trim())
  for ($page = 1; $page -le 10; $page++) {
    $path = '/repos/' + $Config.repo + '/compare/main...' + $headRefEscaped + '?per_page=100&page=' + $page
    $resp = Invoke-AuditApi -Config $Config -Method 'GET' -Path $path
    if ($null -eq $resp) { break }

    if ($page -eq 1) {
      $status = [string](Get-JsonProp $resp 'status')
      $rawAhead = Get-JsonProp $resp 'ahead_by'
      if ($null -ne $rawAhead) { $aheadBy = [int]$rawAhead }
      $rawBehind = Get-JsonProp $resp 'behind_by'
      if ($null -ne $rawBehind) { $behindBy = [int]$rawBehind }
      $rawTotal = Get-JsonProp $resp 'total_commits'
      if ($null -ne $rawTotal) { $totalCommits = [int]$rawTotal }
    }

    $rawCommits = Get-JsonProp $resp 'commits'
    $items = @()
    if ($null -ne $rawCommits) {
      $items = @($rawCommits | Where-Object { $null -ne $_ })
    }
    $addedThisPage = 0
    foreach ($c in $items) {
      $sha = ([string](Get-JsonProp $c 'sha')).Trim().ToLowerInvariant()
      if (-not [string]::IsNullOrWhiteSpace($sha)) {
        if ($seenShas.ContainsKey($sha)) { continue }
        $seenShas[$sha] = $true
      }
      $null = $all.Add($c)
      $addedThisPage++
    }
    if ($items.Count -lt 100 -or $addedThisPage -eq 0) { break }
    if ($totalCommits -gt 0 -and $all.Count -ge $totalCommits) { break }
  }

  return [pscustomobject]@{
    status = $status
    ahead_by = $aheadBy
    behind_by = $behindBy
    total_commits = $totalCommits
    commits = $all.ToArray()
  }
}

function Get-MainRecentCommits {
  param(
    $Config,
    [int]$Limit = 50
  )
  if ($Limit -le 0) { return @() }
  $perPage = $Limit
  if ($perPage -gt 100) { $perPage = 100 }
  $all = New-Object Collections.Generic.List[object]
  $resp = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Config.repo + '/commits?sha=main&per_page=' + $perPage)
  $items = @()
  if ($null -ne $resp) {
    $items = @($resp | Where-Object { $null -ne $_ })
  }
  foreach ($c in $items) {
    $null = $all.Add($c)
    if ($all.Count -ge $Limit) { break }
  }
  return $all.ToArray()
}

function Test-CommentAuthoredByApp {
  param(
    $Comment,
    $Config,
    [string]$KnownAuditBotLogin = ''
  )
  $appObj = Get-JsonProp $Comment 'performed_via_github_app'
  if ($null -ne $appObj) {
    $cAppId = [string](Get-JsonProp $appObj 'id')
    if (-not [string]::IsNullOrWhiteSpace($cAppId) -and $cAppId -eq [string]$Config.appId) {
      return $true
    }
  }
  $userObj = Get-JsonProp $Comment 'user'
  $login = [string](Get-JsonProp $userObj 'login')
  $userType = [string](Get-JsonProp $userObj 'type')
  if (-not [string]::IsNullOrWhiteSpace($KnownAuditBotLogin) -and
      -not [string]::IsNullOrWhiteSpace($login) -and
      $login.Equals($KnownAuditBotLogin, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $body = [string](Get-JsonProp $Comment 'body')
  if ($userType -eq 'Bot' -and $body -match '<!--\s*nyx-audit\b') {
    return $true
  }
  return $false
}

function Find-NewRebuttal {
  param(
    $Comments,
    $State,
    $Config,
    [string]$HeadSha
  )
  $lastAuditId = [long]$State.lastCommentId
  $lastAuditAt = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$State.lastCommentCreatedAt)) {
    try { $lastAuditAt = [DateTimeOffset]::Parse([string]$State.lastCommentCreatedAt) } catch { $lastAuditAt = $null }
  }
  $auditBotLogin = ''
  $lastAuditBody = ''

  $committedRound = [int]$State.round
  $hasCommittedCommentId = ([long]$State.lastCommentId -gt 0)
  $markerPattern = '<!--\s*nyx-audit\s+sha=' + [regex]::Escape($HeadSha) + '\s+round=([0-9]+)\s*-->'
  foreach ($c in @($Comments)) {
    $cid = [long](Get-JsonProp $c 'id')
    $body = [string](Get-JsonProp $c 'body')
    $m = [regex]::Match($body, $markerPattern)
    if ($m.Success -or $cid -eq $lastAuditId) {
      $userObj = Get-JsonProp $c 'user'
      $login = [string](Get-JsonProp $userObj 'login')
      if (-not [string]::IsNullOrWhiteSpace($login)) { $auditBotLogin = $login }
    }
    if ($cid -eq $lastAuditId) {
      $lastAuditBody = $body
      if ($null -eq $lastAuditAt) {
        $created = [string](Get-JsonProp $c 'created_at')
        if (-not [string]::IsNullOrWhiteSpace($created)) {
          try { $lastAuditAt = [DateTimeOffset]::Parse($created) } catch { }
        }
      }
    } elseif (-not $hasCommittedCommentId -and $m.Success) {
      $markerRound = [int]$m.Groups[1].Value
      if (($committedRound -le 0 -or $markerRound -le $committedRound) -and $cid -ge $lastAuditId) {
        $lastAuditId = $cid
        $lastAuditBody = $body
        $created = [string](Get-JsonProp $c 'created_at')
        if (-not [string]::IsNullOrWhiteSpace($created)) {
          try { $lastAuditAt = [DateTimeOffset]::Parse($created) } catch { }
        }
      }
    }
  }

  $matched = New-Object Collections.Generic.List[object]
  foreach ($c in @($Comments)) {
    $cid = [long](Get-JsonProp $c 'id')
    if ($cid -le $lastAuditId) { continue }
    if ($cid -le [long]$State.lastRebuttalCommentId) { continue }
    if (Test-CommentAuthoredByApp -Comment $c -Config $Config -KnownAuditBotLogin $auditBotLogin) { continue }
    if ($null -ne $lastAuditAt) {
      $created = [string](Get-JsonProp $c 'created_at')
      if (-not [string]::IsNullOrWhiteSpace($created)) {
        try {
          if ([DateTimeOffset]::Parse($created) -le $lastAuditAt) { continue }
        } catch { }
      }
    }
    $body = [string](Get-JsonProp $c 'body')
    if ($body.TrimStart() -match '(?i)^Audit rebuttal:') {
      $null = $matched.Add($c)
    }
  }

  if ($matched.Count -eq 0) { return $null }
  $maxId = [long]0
  $parts = New-Object Collections.Generic.List[string]
  foreach ($m in $matched) {
    $mid = [long](Get-JsonProp $m 'id')
    if ($mid -gt $maxId) { $maxId = $mid }
    $author = [string](Get-JsonProp (Get-JsonProp $m 'user') 'login')
    $createdAt = [string](Get-JsonProp $m 'created_at')
    $null = $parts.Add(('Author: ' + $author + ' (' + $createdAt + ')' + "`n" + ([string](Get-JsonProp $m 'body')).Trim()))
  }
  return [pscustomobject]@{
    commentId = $maxId
    text = ($parts -join "`n`n---`n`n")
    lastAuditBody = $lastAuditBody
  }
}

function Set-AuditCommitStatus {
  param(
    $Config,
    [string]$Sha,
    [string]$State,
    [string]$Description,
    [string]$TargetUrl = ''
  )
  $desc = ConvertTo-SingleLine $Description 140
  if ([string]::IsNullOrWhiteSpace($desc)) { $desc = 'Nyx audit: ' + $State }
  $payload = [ordered]@{
    state = $State
    context = $Config.statusContext
    description = $desc
  }
  if (-not [string]::IsNullOrWhiteSpace($TargetUrl)) {
    $payload['target_url'] = $TargetUrl
  }
  $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Config.repo + '/statuses/' + $Sha) -Body $payload
}

function Add-AuditParkedLabel {
  param(
    $Config,
    [int]$Number
  )
  $repo = $Config.repo
  $exists = $false
  try {
    $null = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $repo + '/labels/audit-parked')
    $exists = $true
  } catch {
    $exists = $false
  }
  if (-not $exists) {
    try {
      $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $repo + '/labels') -Body @{
        name = 'audit-parked'
        color = 'b60205'
        description = 'PR parked by automatic audit arbiter'
      }
    } catch {
      Write-Log ('create audit-parked label note: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
    }
  }
  $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $repo + '/issues/' + $Number + '/labels') -Body @{
    labels = @('audit-parked')
  }
}

function Ensure-AuditRepo {
  param(
    $Config,
    [string]$RepoDir
  )
  if (-not (Test-Path -LiteralPath (Join-Path $RepoDir '.git'))) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $RepoDir)) | Out-Null
    $url = 'https://github.com/' + $Config.repo + '.git'
    Write-Log ('cloning repository into ' + $RepoDir)
    $clone = Invoke-Git -Directory '' -Arguments ('clone --no-checkout ' + (Quote-Arg $url) + ' ' + (Quote-Arg $RepoDir)) -AuthConfig $Config
    if ($clone.exitCode -ne 0) {
      throw ('git clone failed: ' + (ConvertTo-SingleLine $clone.error 240))
    }
  }
  $fetchMain = Invoke-Git -Directory $RepoDir -Arguments 'fetch --no-tags --prune origin +refs/heads/main:refs/remotes/origin/main' -AuthConfig $Config
  if ($fetchMain.exitCode -ne 0) {
    throw ('git fetch origin main failed: ' + (ConvertTo-SingleLine $fetchMain.error 240))
  }
}

function Get-LinkedIssueNumber {
  param(
    [string]$PrBody,
    [string]$HeadRef
  )
  if (-not [string]::IsNullOrWhiteSpace($PrBody)) {
    $m = [regex]::Match($PrBody, '(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#([0-9]+)\b')
    if ($m.Success) {
      $n = [int]$m.Groups[1].Value
      if ($n -gt 0) { return $n }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($HeadRef) -and $HeadRef -match '^nyx/([0-9]+)-') {
    $n = [int]$Matches[1]
    if ($n -gt 0) { return $n }
  }
  return 0
}

function Get-IssueMarkdown {
  param(
    $Config,
    [int]$IssueNumber
  )
  $issue = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Config.repo + '/issues/' + $IssueNumber)
  $comments = @(Get-PrComments -Config $Config -Number $IssueNumber)
  $labelNames = @()
  $rawLabels = Get-JsonProp $issue 'labels'
  if ($null -ne $rawLabels) {
    $labelNames = @($rawLabels | ForEach-Object { [string](Get-JsonProp $_ 'name') } | Where-Object { $_ })
  }

  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('# Issue #' + $IssueNumber + ': ' + [string](Get-JsonProp $issue 'title'))
  $null = $lines.Add('')
  $null = $lines.Add('- State: ' + [string](Get-JsonProp $issue 'state'))
  $null = $lines.Add('- Labels: ' + $(if ($labelNames.Count -gt 0) { $labelNames -join ', ' } else { 'none' }))
  $null = $lines.Add('')
  $null = $lines.Add('## Description')
  $null = $lines.Add('')
  $body = [string](Get-JsonProp $issue 'body')
  if ([string]::IsNullOrWhiteSpace($body)) { $null = $lines.Add('(empty)') } else { $null = $lines.Add($body.TrimEnd()) }

  if ($comments.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('## Issue comments')
    $null = $lines.Add('')
    foreach ($c in $comments) {
      $author = [string](Get-JsonProp (Get-JsonProp $c 'user') 'login')
      $created = [string](Get-JsonProp $c 'created_at')
      $cBody = [string](Get-JsonProp $c 'body')
      $null = $lines.Add('### ' + $author + ' (' + $created + ')')
      $null = $lines.Add('')
      $null = $lines.Add($cBody.TrimEnd())
      $null = $lines.Add('')
    }
  }
  return ($lines -join "`n")
}

function Get-DependencySignature {
  param([string]$Json)
  if ([string]::IsNullOrWhiteSpace($Json)) { return $null }
  try { $data = $Json | ConvertFrom-Json } catch { return $null }
  $parts = @()
  foreach ($section in $script:DependencySections) {
    if ($null -ne $data.PSObject.Properties[$section]) {
      $parts += ($section + '=' + (ConvertTo-Json -InputObject $data.$section -Depth 10 -Compress))
    }
  }
  return ($parts -join "`n")
}

function Get-ParityStatus {
  param([string]$Text)
  $map = @{}
  if ([string]::IsNullOrWhiteSpace($Text)) { return $map }
  foreach ($line in ($Text -split "`r?`n")) {
    $match = [regex]::Match($line, '^\|\s*([A-Z]+[0-9]*-[0-9]+)\s*\|')
    if (-not $match.Success) { continue }
    # Split on unescaped pipes only: notes contain \| inside table cells.
    $cells = [regex]::Split($line, '(?<!\\)\|')
    if ($cells.Count -lt 5) { continue }
    $map[$match.Groups[1].Value] = $cells[3].Trim().Trim('`').Trim().ToLowerInvariant()
  }
  return $map
}

function Test-DevinAttribution {
  param(
    [AllowEmptyString()][string]$Text
  )
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  if ([regex]::IsMatch($Text, '(?im)^\s*(?:[>*+-]\s*)?co-authored-by\s*:[^\r\n]*devin')) { return $true }
  if ([regex]::IsMatch($Text, '(?i)devin-ai-integration')) { return $true }
  if ([regex]::IsMatch($Text, '(?i)\bgenerated\s+(?:with|by)\s+\[devin\]')) { return $true }
  return $false
}

function Get-CommitMessageText {
  param($CommitItem)
  if ($null -eq $CommitItem) { return '' }
  if ($CommitItem -is [string]) { return $CommitItem }
  $commitObj = Get-JsonProp $CommitItem 'commit'
  if ($null -ne $commitObj) {
    return [string](Get-JsonProp $commitObj 'message')
  }
  return [string](Get-JsonProp $CommitItem 'message')
}

function Get-CommitSubject {
  param([AllowEmptyString()][string]$Message)
  if ([string]::IsNullOrWhiteSpace($Message)) { return '' }
  $lines = @($Message -split "`r?`n")
  if ($lines.Count -eq 0) { return '' }
  return $lines[0].Trim()
}

function Test-IsMergeCommit {
  param(
    $CommitItem,
    [AllowEmptyString()][string]$Subject = ''
  )
  if ($null -ne $CommitItem -and $CommitItem -isnot [string]) {
    $parentsRaw = Get-JsonProp $CommitItem 'parents'
    if ($null -ne $parentsRaw) {
      $parentsArr = @($parentsRaw | Where-Object { $null -ne $_ })
      if ($parentsArr.Count -gt 1) { return $true }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($Subject)) {
    if ($Subject -cmatch '^Merge (?:branch |pull request |remote-tracking branch |tag )') { return $true }
  }
  return $false
}

function Get-DeterministicFindings {
  param(
    [string]$Worktree,
    [string]$HeadRef,
    [string[]]$ChangedFiles,
    [int]$IssueNumber,
    [string]$IssueError = '',
    [string]$TempBase = '',
    [string]$PrBody = '',
    $PrCommits = @(),
    $MainCompare = $null,
    $MainCommits = @(),
    [string]$BaseRef = 'origin/main'
  )
  $findings = New-Object Collections.Generic.List[object]
  $seq = 1
  $isRebaselinePr = ($HeadRef -like 'nyx/rebaseline-v*')

  if ($IssueNumber -le 0 -and -not $isRebaselinePr) {
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'blocking'
      title = 'no linked issue'
      evidence = ('branch ' + $HeadRef)
      why = 'PR body has no Closes/Fixes/Resolves #N reference and branch name does not start with nyx/<N>-.'
    })
    $seq++
  } elseif (-not [string]::IsNullOrWhiteSpace($IssueError)) {
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'blocking'
      title = ('linked issue #' + $IssueNumber + ' unavailable')
      evidence = ('issue #' + $IssueNumber)
      why = $IssueError
    })
    $seq++
  }

  $branchIssueNumber = 0
  if (-not [string]::IsNullOrWhiteSpace($HeadRef)) {
    $branchMatch = [regex]::Match($HeadRef, '(?i)^nyx/([0-9]+)-')
    if ($branchMatch.Success) {
      $parsedBranchIssue = 0
      if ([int]::TryParse($branchMatch.Groups[1].Value, [ref]$parsedBranchIssue) -and $parsedBranchIssue -gt 0) {
        $branchIssueNumber = $parsedBranchIssue
      }
    }
  }
  if (-not $isRebaselinePr -and $IssueNumber -gt 0 -and $branchIssueNumber -gt 0) {
    $closingPattern = '(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#' + $branchIssueNumber + '\b'
    $hasClosingKeyword = (-not [string]::IsNullOrWhiteSpace($PrBody)) -and [regex]::IsMatch($PrBody, $closingPattern)
    if (-not $hasClosingKeyword) {
      $null = $findings.Add([pscustomobject]@{
        id = ('D' + $seq)
        severity = 'blocking'
        title = ('missing closing keyword for #' + $branchIssueNumber)
        evidence = ('PR body (branch ' + $HeadRef + ')')
        why = ('PR body has no Closes, Fixes, or Resolves #' + $branchIssueNumber + " keyword. Add 'Closes #" + $branchIssueNumber + "' to the PR body; no code change is needed.")
      })
      $seq++
    }
  }

  if (Test-DevinAttribution -Text $PrBody) {
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'blocking'
      title = 'Devin attribution in PR body'
      evidence = ('PR body (branch ' + $HeadRef + ')')
      why = "PR body contains Devin attribution ('Co-authored-by:', 'devin-ai-integration', or 'Generated with/by [Devin]'). Remove those lines from the PR body (via gh pr edit; no code change is needed) and reword any affected branch commits or rely on gh pr merge --squash with an explicit --subject and --body without attribution."
    })
    $seq++
  }


  $mainShaSet = @{}
  $mainSubjectToSha = New-Object Collections.Hashtable ([StringComparer]::Ordinal)
  foreach ($mainItem in @($MainCommits)) {
    if ($null -eq $mainItem -or $mainItem -is [string]) { continue }
    $mSha = ([string](Get-JsonProp $mainItem 'sha')).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($mSha)) { continue }
    $mainShaSet[$mSha] = $true
    $mMsg = Get-CommitMessageText -CommitItem $mainItem
    $mSubj = Get-CommitSubject -Message $mMsg
    if ([string]::IsNullOrWhiteSpace($mSubj)) { continue }
    if (Test-IsMergeCommit -CommitItem $mainItem -Subject $mSubj) { continue }
    if (-not $mainSubjectToSha.ContainsKey($mSubj)) {
      $mainSubjectToSha[$mSubj] = $mSha
    }
  }

  $compareAheadBy = -1
  $compareCommits = @()
  if ($null -ne $MainCompare) {
    $rawAhead = Get-JsonProp $MainCompare 'ahead_by'
    if ($null -eq $rawAhead) { $rawAhead = Get-JsonProp $MainCompare 'aheadBy' }
    if ($null -ne $rawAhead) {
      $parsedAhead = 0
      if ([int]::TryParse([string]$rawAhead, [ref]$parsedAhead)) {
        $compareAheadBy = $parsedAhead
      }
    }
    $rawCompareCommits = Get-JsonProp $MainCompare 'commits'
    if ($null -ne $rawCompareCommits) {
      $compareCommits = @($rawCompareCommits | Where-Object { $null -ne $_ })
    }
  }

  $branchCommits = New-Object Collections.Generic.List[object]
  $seenBranchShas = @{}
  foreach ($cItem in $compareCommits) {
    if ($null -eq $cItem) { continue }
    $cSha = ''
    if ($cItem -isnot [string]) {
      $cSha = ([string](Get-JsonProp $cItem 'sha')).Trim().ToLowerInvariant()
    }
    if (-not [string]::IsNullOrWhiteSpace($cSha)) {
      if ($seenBranchShas.ContainsKey($cSha)) { continue }
      $seenBranchShas[$cSha] = $true
    }
    $null = $branchCommits.Add($cItem)
  }
  if ($null -eq $MainCompare -or $compareAheadBy -ne 0) {
    foreach ($pItem in @($PrCommits)) {
      if ($null -eq $pItem) { continue }
      $pSha = ''
      if ($pItem -isnot [string]) {
        $pSha = ([string](Get-JsonProp $pItem 'sha')).Trim().ToLowerInvariant()
      }
      if (-not [string]::IsNullOrWhiteSpace($pSha)) {
        if ($seenBranchShas.ContainsKey($pSha)) { continue }
        if ($mainShaSet.ContainsKey($pSha)) { continue }
        $seenBranchShas[$pSha] = $true
      }
      $null = $branchCommits.Add($pItem)
    }
  }

  $attributedCommits = New-Object Collections.Generic.List[string]
  foreach ($commitItem in $branchCommits.ToArray()) {
    if ($null -eq $commitItem) { continue }
    $commitSha = ''
    if ($commitItem -isnot [string]) {
      $commitSha = ([string](Get-JsonProp $commitItem 'sha')).Trim()
    }
    $commitMsg = Get-CommitMessageText -CommitItem $commitItem
    if (Test-DevinAttribution -Text $commitMsg) {
      $label = 'commit'
      if (-not [string]::IsNullOrWhiteSpace($commitSha)) {
        if ($commitSha.Length -ge 7) {
          $label = $commitSha.Substring(0, 7)
        } else {
          $label = $commitSha
        }
      }
      $null = $attributedCommits.Add($label)
    }
  }
  if ($attributedCommits.Count -gt 0) {
    $shownCommits = @($attributedCommits.ToArray() | Select-Object -First 8)
    $moreCommits = ''
    if ($attributedCommits.Count -gt $shownCommits.Count) {
      $moreCommits = ' and ' + ($attributedCommits.Count - $shownCommits.Count) + ' more'
    }
    $aheadSuffix = ''
    if ($compareAheadBy -ge 0) {
      $aheadSuffix = ' (ahead_by=' + $compareAheadBy + ')'
    }
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'advisory'
      title = 'Devin attribution in branch commit message(s)'
      evidence = ('commits: ' + ($shownCommits -join ', ') + $moreCommits + $aheadSuffix)
      why = "Branch commit message(s) contain Devin attribution. No branch rewrite is needed (the workflow forbids rebasing and force-pushing): the watchdog squash-merges with its own explicit message, so branch messages never reach main. Keep attribution out of new commits and the PR body."
    })
    $seq++
  }

  $replayedCommits = New-Object Collections.Generic.List[string]
  if ($mainSubjectToSha.Count -gt 0) {
    foreach ($commitItem in $branchCommits.ToArray()) {
      if ($null -eq $commitItem -or $commitItem -is [string]) { continue }
      $commitSha = ([string](Get-JsonProp $commitItem 'sha')).Trim()
      if ([string]::IsNullOrWhiteSpace($commitSha)) { continue }
      $commitShaLower = $commitSha.ToLowerInvariant()
      if ($mainShaSet.ContainsKey($commitShaLower)) { continue }
      $commitMsg = Get-CommitMessageText -CommitItem $commitItem
      $commitSubj = Get-CommitSubject -Message $commitMsg
      if ([string]::IsNullOrWhiteSpace($commitSubj)) { continue }
      if (Test-IsMergeCommit -CommitItem $commitItem -Subject $commitSubj) { continue }
      if ($mainSubjectToSha.ContainsKey($commitSubj)) {
        $mainMatchSha = [string]$mainSubjectToSha[$commitSubj]
        if ($mainMatchSha -eq $commitShaLower) { continue }
        $prShort = $commitSha
        if ($prShort.Length -ge 7) { $prShort = $prShort.Substring(0, 7) }
        $mainShort = $mainMatchSha
        if ($mainShort.Length -ge 7) { $mainShort = $mainShort.Substring(0, 7) }
        $subjPreview = (ConvertTo-SingleLine $commitSubj 80).Replace('`', "'")
        $null = $replayedCommits.Add(($prShort + ' matches main ' + $mainShort + ' (' + $subjPreview + ')'))
      }
    }
  }
  if ($replayedCommits.Count -gt 0) {
    $shownReplayed = @($replayedCommits.ToArray() | Select-Object -First 8)
    $moreReplayed = ''
    if ($replayedCommits.Count -gt $shownReplayed.Count) {
      $moreReplayed = ' and ' + ($replayedCommits.Count - $shownReplayed.Count) + ' more'
    }
    $aheadSuffix = ''
    if ($compareAheadBy -ge 0) {
      $aheadSuffix = ' (ahead_by=' + $compareAheadBy + ')'
    }
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'advisory'
      title = 'branch contains commit(s) already on main under different SHA(s)'
      evidence = (($shownReplayed -join '; ') + $moreReplayed + $aheadSuffix)
      why = 'Branch commit list contains commit(s) whose exact subject matches recent commit(s) on main under different SHAs, likely history from before a main rewrite. A subject match alone does not prove the same change, so this is informational; the squash merge carries only the tree, and its message is written by the watchdog.'
    })
    $seq++
  }

  $guarded = @()
  foreach ($file in @($ChangedFiles)) {
    if ([string]::IsNullOrWhiteSpace($file)) { continue }
    $normal = $file.Replace('\', '/').ToLowerInvariant()
    if ($isRebaselinePr -and $normal -eq 'docs/source-baseline.json') { continue }
    $hit = ($script:GuardedFiles -contains $normal)
    if (-not $hit) {
      foreach ($prefix in $script:GuardedPrefixes) {
        if ($normal.StartsWith($prefix)) {
          $hit = $true
          break
        }
      }
    }
    if ($hit) { $guarded += $file }
  }
  if ($guarded.Count -gt 0) {
    $shown = @($guarded | Select-Object -First 8)
    $more = if ($guarded.Count -gt $shown.Count) { ' and ' + ($guarded.Count - $shown.Count) + ' more' } else { '' }
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'blocking'
      title = 'changes guarded paths'
      evidence = (($shown -join ', ') + $more)
      why = 'Autopilot PRs must not modify guarded governance, audit, workflow, license, baseline, or lockfile paths.'
    })
    $seq++
  }

  $hasPackageJson = $false
  $hasParityMd = $false
  foreach ($file in @($ChangedFiles)) {
    $normal = $file.Replace('\', '/').ToLowerInvariant()
    if ($normal -eq 'package.json') { $hasPackageJson = $true }
    if ($normal -eq 'docs/parity.md') { $hasParityMd = $true }
  }

  if ($hasPackageJson) {
    $beforeRes = Invoke-Git -Directory $Worktree -Arguments ('show ' + $BaseRef + ':package.json') -TempBase $TempBase
    $beforeSig = $null
    if ($beforeRes.exitCode -eq 0) { $beforeSig = Get-DependencySignature ([string]$beforeRes.text) }
    $afterSig = Get-DependencySignature (Read-Text (Join-Path $Worktree 'package.json'))
    if ($null -eq $beforeSig -or $null -eq $afterSig -or $beforeSig -ne $afterSig) {
      $null = $findings.Add([pscustomobject]@{
        id = ('D' + $seq)
        severity = 'blocking'
        title = 'changes dependencies in package.json'
        evidence = 'package.json'
        why = 'Autopilot PRs must not add, remove, or change dependency sections in package.json.'
      })
      $seq++
    }
  }

  if ($hasParityMd -and -not $isRebaselinePr) {
    $beforeRes = Invoke-Git -Directory $Worktree -Arguments ('show ' + $BaseRef + ':docs/parity.md') -TempBase $TempBase
    $beforeMap = @{}
    if ($beforeRes.exitCode -eq 0) { $beforeMap = Get-ParityStatus ([string]$beforeRes.text) }
    $afterMap = Get-ParityStatus (Read-Text (Join-Path $Worktree 'docs\parity.md'))
    $promoted = @()
    foreach ($id in @($afterMap.Keys | Sort-Object)) {
      $wasDone = $beforeMap.ContainsKey($id) -and ($beforeMap[$id] -match '^done\b')
      if (($afterMap[$id] -match '^done\b') -and -not $wasDone) {
        $promoted += $id
      }
    }
    if ($promoted.Count -gt 0) {
      $null = $findings.Add([pscustomobject]@{
        id = ('D' + $seq)
        severity = 'blocking'
        title = ('sets docs/parity.md row(s) to done: ' + ($promoted -join ', '))
        evidence = 'docs/parity.md'
        why = 'Autopilot PRs must not set docs/parity.md rows to done; only maintainers mark parity rows done.'
      })
      $seq++
    }
  }

  $testsDiffFailed = $false
  $testsDiffRes = Invoke-Git -Directory $Worktree -Arguments ('-c core.quotepath=false diff --cached --no-renames -U0 ' + $BaseRef + ' -- tests') -TempBase $TempBase
  if ($testsDiffRes.exitCode -ne 0) {
    $testsDiffFailed = $true
    $null = $findings.Add([pscustomobject]@{
      id = ('D' + $seq)
      severity = 'blocking'
      title = 'could not diff tests'
      evidence = 'tests/'
      why = ('Failed to diff staged trial merge under tests/: ' + (ConvertTo-SingleLine $testsDiffRes.error 200))
    })
    $seq++
  } else {
    $addedTestDecls = 0
    $removedTestDecls = 0
    $declFileList = New-Object Collections.Generic.List[string]
    $declFileSeen = @{}
    $onlyHits = New-Object Collections.Generic.List[string]

    $currentFile = ''
    $newLine = 0
    $remOld = 0
    $remNew = 0
    $testsText = [string]$testsDiffRes.text
    if (-not [string]::IsNullOrEmpty($testsText)) {
      foreach ($line in ($testsText -split "`r?`n")) {
        if ($remOld -gt 0 -or $remNew -gt 0) {
          if ($line.StartsWith('\')) { continue }
          if ($line.StartsWith('+')) {
            $lineNo = $newLine
            $newLine++
            if ($remNew -gt 0) { $remNew-- }
            $content = $line.Substring(1)
            if ($content -cmatch '\b(it|test|describe)(\.each)?\s*\(') {
              $addedTestDecls++
              if (-not [string]::IsNullOrWhiteSpace($currentFile) -and -not $declFileSeen.ContainsKey($currentFile)) {
                $declFileSeen[$currentFile] = $true
                $null = $declFileList.Add($currentFile)
              }
            }
            if ($content -cmatch '\.(only)\s*\(') {
              $null = $onlyHits.Add(($currentFile + ':' + $lineNo))
            }
            continue
          }
          if ($line.StartsWith('-')) {
            if ($remOld -gt 0) { $remOld-- }
            $content = $line.Substring(1)
            if ($content -cmatch '\b(it|test|describe)(\.each)?\s*\(') {
              $removedTestDecls++
              if (-not [string]::IsNullOrWhiteSpace($currentFile) -and -not $declFileSeen.ContainsKey($currentFile)) {
                $declFileSeen[$currentFile] = $true
                $null = $declFileList.Add($currentFile)
              }
            }
            continue
          }
          if ($line.StartsWith(' ')) {
            $newLine++
            if ($remOld -gt 0) { $remOld-- }
            if ($remNew -gt 0) { $remNew-- }
            continue
          }
          $remOld = 0
          $remNew = 0
        }

        if ($line.StartsWith('diff --git ')) {
          $currentFile = ''
          $newLine = 0
          $remOld = 0
          $remNew = 0
        } elseif ($line -match '^--- a/(.+)$') {
          $currentFile = $Matches[1].Trim()
        } elseif ($line -match '^\+\+\+ b/(.+)$') {
          $currentFile = $Matches[1].Trim()
        } else {
          $hm = [regex]::Match($line, '^@@ -[0-9]+(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@')
          if ($hm.Success) {
            $remOld = if ($hm.Groups[1].Success) { [int]$hm.Groups[1].Value } else { 1 }
            $newLine = [int]$hm.Groups[2].Value
            $remNew = if ($hm.Groups[3].Success) { [int]$hm.Groups[3].Value } else { 1 }
          }
        }
      }
    }

    if ($removedTestDecls -gt $addedTestDecls) {
      $shownDeclFiles = @($declFileList.ToArray() | Select-Object -First 5)
      $moreDeclFiles = if ($declFileList.Count -gt $shownDeclFiles.Count) { ' and ' + ($declFileList.Count - $shownDeclFiles.Count) + ' more' } else { '' }
      $filesPart = if ($shownDeclFiles.Count -gt 0) { ' (' + ($shownDeclFiles -join ', ') + $moreDeclFiles + ')' } else { '' }
      $null = $findings.Add([pscustomobject]@{
        id = ('D' + $seq)
        severity = 'blocking'
        title = 'reduces test declarations'
        evidence = ('removed ' + $removedTestDecls + ', added ' + $addedTestDecls + $filesPart)
        why = 'Trial merge removes more test declarations under tests/ than it adds.'
      })
      $seq++
    }

    if ($onlyHits.Count -gt 0) {
      $shownOnly = @($onlyHits.ToArray() | Select-Object -First 5)
      $moreOnly = if ($onlyHits.Count -gt $shownOnly.Count) { ' and ' + ($onlyHits.Count - $shownOnly.Count) + ' more' } else { '' }
      $null = $findings.Add([pscustomobject]@{
        id = ('D' + $seq)
        severity = 'blocking'
        title = 'adds .only'
        evidence = (($shownOnly -join ', ') + $moreOnly)
        why = 'Added lines contain .only(...) which restricts test execution.'
      })
      $seq++
    }
  }

  $fullDiffRes = Invoke-Git -Directory $Worktree -Arguments ('-c core.quotepath=false diff --cached --no-renames -U0 ' + $BaseRef) -TempBase $TempBase
  if ($fullDiffRes.exitCode -ne 0) {
    if (-not $testsDiffFailed) {
      $null = $findings.Add([pscustomobject]@{
        id = ('D' + $seq)
        severity = 'blocking'
        title = 'could not diff tests'
        evidence = 'origin/main'
        why = ('Failed to diff staged trial merge across the tree: ' + (ConvertTo-SingleLine $fullDiffRes.error 200))
      })
      $seq++
    }
  } else {
    $advisoryPatterns = @(
      @{ label = '.skip'; regex = '\.skip\s*\('; why = 'Added lines introduce .skip(...) which skips test execution.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = 'skipIf'; regex = 'skipIf\s*\('; why = 'Added lines introduce skipIf(...) which conditionally skips tests.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = 'it.todo'; regex = 'it\.todo'; why = 'Added lines introduce it.todo placeholder tests.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = '@ts-ignore'; regex = '@ts-ignore'; why = 'Added lines introduce @ts-ignore type-check suppressions.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = '@ts-expect-error'; regex = '@ts-expect-error'; why = 'Added lines introduce @ts-expect-error type-check suppressions.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = 'eslint-disable'; regex = 'eslint-disable'; why = 'Added lines introduce eslint-disable lint suppressions.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = 'as any'; regex = 'as any\b'; why = 'Added lines introduce as any type-safety escapes.'; hits = (New-Object Collections.Generic.List[string]) },
      @{ label = 'as unknown as'; regex = 'as unknown as'; why = 'Added lines introduce as unknown as double-cast escapes.'; hits = (New-Object Collections.Generic.List[string]) }
    )

    $currentFile = ''
    $newLine = 0
    $remOld = 0
    $remNew = 0
    $fullText = [string]$fullDiffRes.text
    if (-not [string]::IsNullOrEmpty($fullText)) {
      foreach ($line in ($fullText -split "`r?`n")) {
        if ($remOld -gt 0 -or $remNew -gt 0) {
          if ($line.StartsWith('\')) { continue }
          if ($line.StartsWith('+')) {
            $lineNo = $newLine
            $newLine++
            if ($remNew -gt 0) { $remNew-- }
            $content = $line.Substring(1)
            foreach ($pat in $advisoryPatterns) {
              if ($content -cmatch $pat.regex) {
                $null = $pat.hits.Add(($currentFile + ':' + $lineNo))
              }
            }
            continue
          }
          if ($line.StartsWith('-')) {
            if ($remOld -gt 0) { $remOld-- }
            continue
          }
          if ($line.StartsWith(' ')) {
            $newLine++
            if ($remOld -gt 0) { $remOld-- }
            if ($remNew -gt 0) { $remNew-- }
            continue
          }
          $remOld = 0
          $remNew = 0
        }

        if ($line.StartsWith('diff --git ')) {
          $currentFile = ''
          $newLine = 0
          $remOld = 0
          $remNew = 0
        } elseif ($line -match '^--- a/(.+)$') {
          $currentFile = $Matches[1].Trim()
        } elseif ($line -match '^\+\+\+ b/(.+)$') {
          $currentFile = $Matches[1].Trim()
        } else {
          $hm = [regex]::Match($line, '^@@ -[0-9]+(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@')
          if ($hm.Success) {
            $remOld = if ($hm.Groups[1].Success) { [int]$hm.Groups[1].Value } else { 1 }
            $newLine = [int]$hm.Groups[2].Value
            $remNew = if ($hm.Groups[3].Success) { [int]$hm.Groups[3].Value } else { 1 }
          }
        }
      }
    }

    foreach ($pat in $advisoryPatterns) {
      if ($pat.hits.Count -gt 0) {
        $shownHits = @($pat.hits.ToArray() | Select-Object -First 5)
        $moreHits = if ($pat.hits.Count -gt $shownHits.Count) { ' and ' + ($pat.hits.Count - $shownHits.Count) + ' more' } else { '' }
        $null = $findings.Add([pscustomobject]@{
          id = ('D' + $seq)
          severity = 'advisory'
          title = ('adds ' + $pat.label)
          evidence = (($shownHits -join ', ') + $moreHits)
          why = $pat.why
        })
        $seq++
      }
    }
  }

  return $findings.ToArray()
}

function Format-FindingsForPrompt {
  param($Findings)
  $items = @($Findings | Where-Object { $null -ne $_ })
  if ($items.Count -eq 0) { return 'none' }
  $lines = New-Object Collections.Generic.List[string]
  foreach ($f in $items) {
    $fid = [string](Get-JsonProp $f 'id')
    $sev = [string](Get-JsonProp $f 'severity')
    $title = [string](Get-JsonProp $f 'title')
    $ev = [string](Get-JsonProp $f 'evidence')
    $why = [string](Get-JsonProp $f 'why')
    $null = $lines.Add('- [' + $fid + '] (' + $sev + ') ' + $title + ' | evidence: ' + $ev + ' | why: ' + $why)
  }
  return ($lines -join "`n")
}

function Build-AuditCommentBody {
  param(
    [string]$HeadSha,
    [int]$Round,
    [string]$Verdict,
    [int]$IssueNumber,
    $Acceptance,
    $Findings,
    $Claims,
    $Withdrawn,
    [bool]$ArbiterFollows = $false
  )
  $sha7 = if ($HeadSha.Length -ge 7) { $HeadSha.Substring(0, 7) } else { $HeadSha }
  $verdictLabel = if ($Verdict -eq 'pass') { 'PASS' } else { 'BLOCK' }

  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('## Nyx audit - ' + $sha7 + ' - ' + $verdictLabel)
  $null = $lines.Add('')
  $issueLabel = if ($IssueNumber -gt 0) { '#' + $IssueNumber } else { 'none' }
  $null = $lines.Add('Round: ' + $Round + ' | Linked issue: ' + $issueLabel)
  if ($ArbiterFollows) {
    $null = $lines.Add('')
    $null = $lines.Add('> Still blocking after rebuttal round ' + $Round + '; invoking automatic arbitration.')
  }

  $null = $lines.Add('')
  $null = $lines.Add('### Acceptance')
  $accList = @($Acceptance | Where-Object { $null -ne $_ })
  if ($accList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    $null = $lines.Add('| Item | Status | Evidence |')
    $null = $lines.Add('| --- | --- | --- |')
    foreach ($a in $accList) {
      $item = Escape-MarkdownCell (Protect-PublicText ([string](Get-JsonProp $a 'item')))
      $st = Escape-MarkdownCell ([string](Get-JsonProp $a 'status'))
      $ev = Escape-MarkdownCell (Protect-PublicText ([string](Get-JsonProp $a 'evidence')))
      $null = $lines.Add('| ' + $item + ' | ' + $st + ' | ' + $ev + ' |')
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('### Findings')
  $findList = @($Findings | Where-Object { $null -ne $_ })
  if ($findList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    foreach ($f in $findList) {
      $fid = Protect-PublicText ([string](Get-JsonProp $f 'id'))
      $sev = ([string](Get-JsonProp $f 'severity')).Trim().ToLowerInvariant()
      $title = Protect-PublicText ([string](Get-JsonProp $f 'title'))
      $ev = Protect-PublicText ([string](Get-JsonProp $f 'evidence'))
      $why = Protect-PublicText ([string](Get-JsonProp $f 'why'))
      $null = $lines.Add('- **[' + $fid + '] (' + $sev + ')** ' + $title + ' (`' + $ev + '`): ' + $why)
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('### Claims')
  $claimList = @($Claims | Where-Object { $null -ne $_ })
  if ($claimList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    $null = $lines.Add('| Claim | Holds | Evidence |')
    $null = $lines.Add('| --- | --- | --- |')
    foreach ($cl in $claimList) {
      $claimText = Escape-MarkdownCell (Protect-PublicText ([string](Get-JsonProp $cl 'claim')))
      $holdsRaw = Get-JsonProp $cl 'holds'
      $holdsText = if ($holdsRaw -is [bool]) { if ($holdsRaw) { 'true' } else { 'false' } } else { [string]$holdsRaw }
      $ev = Escape-MarkdownCell (Protect-PublicText ([string](Get-JsonProp $cl 'evidence')))
      $null = $lines.Add('| ' + $claimText + ' | ' + $holdsText + ' | ' + $ev + ' |')
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('### Withdrawn')
  $wdList = @($Withdrawn | Where-Object { $null -ne $_ })
  if ($wdList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    foreach ($w in $wdList) {
      $wid = Protect-PublicText ([string](Get-JsonProp $w 'id'))
      $reason = Protect-PublicText ([string](Get-JsonProp $w 'reason'))
      $null = $lines.Add('- **[' + $wid + ']**: ' + $reason)
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('<!-- nyx-audit sha=' + $HeadSha + ' round=' + $Round + ' -->')
  return (Protect-PublicText (($lines.ToArray() -join "`n") + "`n"))
}

function Normalize-ArbiterKey {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  return ([regex]::Replace($Text.Trim(), '\s+', ' ')).ToLowerInvariant()
}

function Format-BlockingItemsForArbiter {
  param(
    $BlockingFindings,
    $FailedAcceptance,
    $FalseClaims
  )
  $lines = New-Object Collections.Generic.List[string]
  $bfList = @($BlockingFindings | Where-Object { $null -ne $_ })
  $faList = @($FailedAcceptance | Where-Object { $null -ne $_ })
  $fcList = @($FalseClaims | Where-Object { $null -ne $_ })

  $null = $lines.Add('#### Blocking findings')
  if ($bfList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    foreach ($f in $bfList) {
      $fid = [string](Get-JsonProp $f 'id')
      $title = [string](Get-JsonProp $f 'title')
      $ev = [string](Get-JsonProp $f 'evidence')
      $why = [string](Get-JsonProp $f 'why')
      $null = $lines.Add('- [' + $fid + '] ' + $title + ' | evidence: ' + $ev + ' | why: ' + $why)
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('#### Failed acceptance criteria')
  if ($faList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    foreach ($a in $faList) {
      $item = [string](Get-JsonProp $a 'item')
      $st = [string](Get-JsonProp $a 'status')
      $ev = [string](Get-JsonProp $a 'evidence')
      $null = $lines.Add('- [' + $st + '] ' + $item + ' | evidence: ' + $ev)
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('#### False claims')
  if ($fcList.Count -eq 0) {
    $null = $lines.Add('none')
  } else {
    foreach ($c in $fcList) {
      $claim = [string](Get-JsonProp $c 'claim')
      $ev = [string](Get-JsonProp $c 'evidence')
      $null = $lines.Add('- ' + $claim + ' | evidence: ' + $ev)
    }
  }

  return ($lines.ToArray() -join "`n")
}

function Evaluate-ArbiterRulings {
  param(
    $BlockingFindings,
    $FailedAcceptance,
    $FalseClaims,
    $ArbiterResult
  )
  $bfList = @($BlockingFindings | Where-Object { $null -ne $_ })
  $faList = @($FailedAcceptance | Where-Object { $null -ne $_ })
  $fcList = @($FalseClaims | Where-Object { $null -ne $_ })

  $findingMap = @{}
  foreach ($r in @(Get-JsonProp $ArbiterResult 'rulings' | Where-Object { $null -ne $_ })) {
    $key = Normalize-ArbiterKey ([string](Get-JsonProp $r 'id'))
    if (-not [string]::IsNullOrWhiteSpace($key)) { $findingMap[$key] = $r }
  }

  $accMap = @{}
  foreach ($a in @(Get-JsonProp $ArbiterResult 'acceptance' | Where-Object { $null -ne $_ })) {
    $key = Normalize-ArbiterKey ([string](Get-JsonProp $a 'item'))
    if (-not [string]::IsNullOrWhiteSpace($key)) { $accMap[$key] = $a }
  }

  $claimMap = @{}
  foreach ($c in @(Get-JsonProp $ArbiterResult 'claims' | Where-Object { $null -ne $_ })) {
    $key = Normalize-ArbiterKey ([string](Get-JsonProp $c 'claim'))
    if (-not [string]::IsNullOrWhiteSpace($key)) { $claimMap[$key] = $c }
  }

  $upheldFindings = New-Object Collections.Generic.List[object]
  $overturnedFindings = New-Object Collections.Generic.List[object]
  foreach ($bf in $bfList) {
    $fid = ([string](Get-JsonProp $bf 'id')).Trim()
    $title = ([string](Get-JsonProp $bf 'title')).Trim()
    $key = Normalize-ArbiterKey $fid
    $matched = if ($findingMap.ContainsKey($key)) { $findingMap[$key] } else { $null }
    $ruling = if ($null -ne $matched) { ([string](Get-JsonProp $matched 'ruling')).Trim().ToLowerInvariant() } else { 'uphold' }
    $reason = if ($null -ne $matched -and -not [string]::IsNullOrWhiteSpace([string](Get-JsonProp $matched 'reason'))) {
      ([string](Get-JsonProp $matched 'reason')).Trim()
    } else {
      'Not overturned by arbiter.'
    }
    $entry = [pscustomobject]@{
      id = $fid
      title = $title
      ruling = $(if ($ruling -eq 'overturn') { 'overturn' } else { 'uphold' })
      reason = $reason
    }
    if ($ruling -eq 'overturn') {
      $null = $overturnedFindings.Add($entry)
    } else {
      $null = $upheldFindings.Add($entry)
    }
  }

  $upheldAcceptance = New-Object Collections.Generic.List[object]
  $overturnedAcceptance = New-Object Collections.Generic.List[object]
  foreach ($fa in $faList) {
    $itemText = ([string](Get-JsonProp $fa 'item')).Trim()
    $statusText = ([string](Get-JsonProp $fa 'status')).Trim()
    $key = Normalize-ArbiterKey $itemText
    $matched = if ($accMap.ContainsKey($key)) { $accMap[$key] } else { $null }
    $ruling = if ($null -ne $matched) { ([string](Get-JsonProp $matched 'ruling')).Trim().ToLowerInvariant() } else { 'uphold' }
    $reason = if ($null -ne $matched -and -not [string]::IsNullOrWhiteSpace([string](Get-JsonProp $matched 'reason'))) {
      ([string](Get-JsonProp $matched 'reason')).Trim()
    } else {
      'Not overturned by arbiter.'
    }
    $entry = [pscustomobject]@{
      item = $itemText
      status = $statusText
      ruling = $(if ($ruling -eq 'overturn') { 'overturn' } else { 'uphold' })
      reason = $reason
    }
    if ($ruling -eq 'overturn') {
      $null = $overturnedAcceptance.Add($entry)
    } else {
      $null = $upheldAcceptance.Add($entry)
    }
  }

  $upheldClaims = New-Object Collections.Generic.List[object]
  $overturnedClaims = New-Object Collections.Generic.List[object]
  foreach ($fc in $fcList) {
    $claimText = ([string](Get-JsonProp $fc 'claim')).Trim()
    $key = Normalize-ArbiterKey $claimText
    $matched = if ($claimMap.ContainsKey($key)) { $claimMap[$key] } else { $null }
    $ruling = if ($null -ne $matched) { ([string](Get-JsonProp $matched 'ruling')).Trim().ToLowerInvariant() } else { 'uphold' }
    $reason = if ($null -ne $matched -and -not [string]::IsNullOrWhiteSpace([string](Get-JsonProp $matched 'reason'))) {
      ([string](Get-JsonProp $matched 'reason')).Trim()
    } else {
      'Not overturned by arbiter.'
    }
    $entry = [pscustomobject]@{
      claim = $claimText
      ruling = $(if ($ruling -eq 'overturn') { 'overturn' } else { 'uphold' })
      reason = $reason
    }
    if ($ruling -eq 'overturn') {
      $null = $overturnedClaims.Add($entry)
    } else {
      $null = $upheldClaims.Add($entry)
    }
  }

  $totalItems = $bfList.Count + $faList.Count + $fcList.Count
  $allOverturned = (
    $totalItems -gt 0 -and
    $upheldFindings.Count -eq 0 -and
    $upheldAcceptance.Count -eq 0 -and
    $upheldClaims.Count -eq 0
  )

  return [pscustomobject]@{
    allOverturned = $allOverturned
    upheldFindings = $upheldFindings.ToArray()
    upheldAcceptance = $upheldAcceptance.ToArray()
    upheldClaims = $upheldClaims.ToArray()
    overturnedFindings = $overturnedFindings.ToArray()
    overturnedAcceptance = $overturnedAcceptance.ToArray()
    overturnedClaims = $overturnedClaims.ToArray()
  }
}

function Build-ArbiterPassCommentBody {
  param(
    [string]$HeadSha,
    [int]$IssueNumber,
    $Evaluation
  )
  $sha7 = if ($HeadSha.Length -ge 7) { $HeadSha.Substring(0, 7) } else { $HeadSha }
  $issueLabel = if ($IssueNumber -gt 0) { '#' + $IssueNumber } else { 'none' }

  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('## Nyx audit - ' + $sha7 + ' - PASS (arbiter)')
  $null = $lines.Add('')
  $null = $lines.Add('Linked issue: ' + $issueLabel + ' | Automatic arbitration overturned every blocking item.')

  $ovFindings = @($Evaluation.overturnedFindings)
  if ($ovFindings.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Finding rulings')
    foreach ($r in $ovFindings) {
      $titlePart = if (-not [string]::IsNullOrWhiteSpace($r.title)) { ' ' + (Protect-PublicText $r.title) } else { '' }
      $null = $lines.Add('- **[' + (Protect-PublicText $r.id) + '] overturn**' + $titlePart + ': ' + (Protect-PublicText $r.reason))
    }
  }

  $ovAcc = @($Evaluation.overturnedAcceptance)
  if ($ovAcc.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Acceptance rulings')
    foreach ($a in $ovAcc) {
      $null = $lines.Add('- **overturn** `' + (Protect-PublicText $a.item) + '`: ' + (Protect-PublicText $a.reason))
    }
  }

  $ovClaims = @($Evaluation.overturnedClaims)
  if ($ovClaims.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Claim rulings')
    foreach ($c in $ovClaims) {
      $null = $lines.Add('- **overturn** `' + (Protect-PublicText $c.claim) + '`: ' + (Protect-PublicText $c.reason))
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('<!-- nyx-audit sha=' + $HeadSha + ' round=arbiter -->')
  return (Protect-PublicText (($lines.ToArray() -join "`n") + "`n"))
}

function Build-ArbiterParkedCommentBody {
  param(
    [string]$HeadSha,
    [int]$IssueNumber,
    $Evaluation,
    [string]$Note = ''
  )
  $sha7 = if ($HeadSha.Length -ge 7) { $HeadSha.Substring(0, 7) } else { $HeadSha }
  $issueLabel = if ($IssueNumber -gt 0) { '#' + $IssueNumber } else { 'none' }

  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('## Nyx audit - ' + $sha7 + ' - PARKED')
  $null = $lines.Add('')
  $null = $lines.Add('Linked issue: ' + $issueLabel + ' | Added label `audit-parked`. Push a new commit to re-run audit.')
  if (-not [string]::IsNullOrWhiteSpace($Note)) {
    $null = $lines.Add('')
    $null = $lines.Add('> ' + (Protect-PublicText $Note))
  }

  $upFindings = @($Evaluation.upheldFindings)
  if ($upFindings.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Upheld blocking findings')
    foreach ($r in $upFindings) {
      $titlePart = if (-not [string]::IsNullOrWhiteSpace($r.title)) { ' ' + (Protect-PublicText $r.title) } else { '' }
      $null = $lines.Add('- **[' + (Protect-PublicText $r.id) + '] uphold**' + $titlePart + ': ' + (Protect-PublicText $r.reason))
    }
  }

  $upAcc = @($Evaluation.upheldAcceptance)
  if ($upAcc.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Upheld failed acceptance criteria')
    foreach ($a in $upAcc) {
      $stPart = if (-not [string]::IsNullOrWhiteSpace($a.status)) { ' (' + (Protect-PublicText $a.status) + ')' } else { '' }
      $null = $lines.Add('- **uphold**' + $stPart + ' `' + (Protect-PublicText $a.item) + '`: ' + (Protect-PublicText $a.reason))
    }
  }

  $upClaims = @($Evaluation.upheldClaims)
  if ($upClaims.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Upheld false claims')
    foreach ($c in $upClaims) {
      $null = $lines.Add('- **uphold** `' + (Protect-PublicText $c.claim) + '`: ' + (Protect-PublicText $c.reason))
    }
  }

  $ovFindings = @($Evaluation.overturnedFindings)
  $ovAcc = @($Evaluation.overturnedAcceptance)
  $ovClaims = @($Evaluation.overturnedClaims)
  if ($ovFindings.Count -gt 0 -or $ovAcc.Count -gt 0 -or $ovClaims.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Overturned items')
    foreach ($r in $ovFindings) {
      $null = $lines.Add('- **[' + (Protect-PublicText $r.id) + '] overturn**: ' + (Protect-PublicText $r.reason))
    }
    foreach ($a in $ovAcc) {
      $null = $lines.Add('- **overturn** `' + (Protect-PublicText $a.item) + '`: ' + (Protect-PublicText $a.reason))
    }
    foreach ($c in $ovClaims) {
      $null = $lines.Add('- **overturn** `' + (Protect-PublicText $c.claim) + '`: ' + (Protect-PublicText $c.reason))
    }
  }

  $null = $lines.Add('')
  $null = $lines.Add('<!-- nyx-audit sha=' + $HeadSha + ' round=arbiter -->')
  return (Protect-PublicText (($lines.ToArray() -join "`n") + "`n"))
}

function Invoke-ArbiterPass {
  param(
    $Config,
    [string]$StateDir,
    [string]$StatePath,
    $State,
    [int]$PrNumber,
    [string]$HeadSha,
    [string]$MainSha,
    [int]$IssueNumber,
    [string]$IssueBody,
    [string]$DiffStat,
    [string]$RebuttalText,
    $BlockingFindings,
    $FailedAcceptance,
    $FalseClaims,
    [string]$PriorCommentUrl,
    [string]$WorktreeDir,
    [string]$RunDir,
    [string]$ArbiterTemplate,
    [switch]$IsDryRun
  )
  $sha7 = if ($HeadSha.Length -ge 7) { $HeadSha.Substring(0, 7) } else { $HeadSha }
  $bfArr = @($BlockingFindings | Where-Object { $null -ne $_ })
  $faArr = @($FailedAcceptance | Where-Object { $null -ne $_ })
  $fcArr = @($FalseClaims | Where-Object { $null -ne $_ })

  $pendingPayload = [pscustomobject]@{
    issueNumber = $IssueNumber
    commentUrl = $PriorCommentUrl
    rebuttal = $RebuttalText
    blockingFindings = $bfArr
    failedAcceptance = $faArr
    falseClaims = $fcArr
  }

  $dailyCap = 6
  $cfgCap = Get-JsonProp $Config 'arbiterDailyCap'
  if ($null -ne $cfgCap) {
    $parsedCap = 0
    if ([int]::TryParse([string]$cfgCap, [ref]$parsedCap) -and $parsedCap -ge 0) {
      $dailyCap = $parsedCap
    }
  }

  $dailyPath = Get-ArbiterDailyPath -StateDir $StateDir
  $dailyReservation = Invoke-WithAuditStateLock -TimeoutMs $script:AuditMutexTimeoutMs -Action {
    $ds = Read-ArbiterDailyState -Path $dailyPath
    $curCount = [int]$ds.count
    if ($curCount -ge $dailyCap) {
      return [pscustomobject]@{
        allowed = $false
        count = $curCount
      }
    }
    $newCount = $curCount
    if (-not $IsDryRun) {
      $newCount = $curCount + 1
      $ds.count = $newCount
      $runsList = New-Object Collections.Generic.List[object]
      foreach ($r in @($ds.runs)) {
        if ($null -ne $r) { $null = $runsList.Add($r) }
      }
      $null = $runsList.Add([pscustomobject]@{
        pr = $PrNumber
        headSha = $HeadSha
        at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
      })
      $ds.runs = $runsList.ToArray()
      Save-ArbiterDailyState -Path $dailyPath -DailyState $ds
    }
    return [pscustomobject]@{
      allowed = $true
      count = $newCount
    }
  }
  $dailyCount = [int]$dailyReservation.count
  if (-not $dailyReservation.allowed) {
    Write-Log ('PR #' + $PrNumber + ' head ' + $sha7 + ': arbiter daily cap reached (' + $dailyCount + '/' + $dailyCap + '); leaving status failure (arbitration pending)')
    if (-not $IsDryRun) {
      Set-AuditCommitStatus -Config $Config -Sha $HeadSha -State 'failure' -Description 'arbitration pending' -TargetUrl $PriorCommentUrl
      $updated = Update-PrStateLocked -Path $StatePath -Number $PrNumber -Mutate {
        param($st)
        $st.arbiterState = 'pending'
        $st.arbiterDone = $false
        $st.arbiterPending = $pendingPayload
      }
      Set-PrStateFields -Target $State -Source $updated
    }
    $capRecord = [ordered]@{
      pr = $PrNumber
      headSha = $HeadSha
      status = 'arbitration-pending'
      verdict = 'block'
      commitStatus = 'failure'
      description = 'arbitration pending'
      reason = ('daily arbiter cap reached (' + $dailyCount + '/' + $dailyCap + ')')
      runDir = $RunDir
    }
    Write-Text (Join-Path $RunDir 'result.json') ((ConvertTo-Json -InputObject $capRecord -Depth 6) + "`n")
    return $capRecord
  }

  $blockingText = Format-BlockingItemsForArbiter -BlockingFindings $bfArr -FailedAcceptance $faArr -FalseClaims $fcArr
  $arbValues = @{
    PR_NUMBER = [string]$PrNumber
    ISSUE_BODY = $IssueBody
    DIFF_STAT = $DiffStat
    BLOCKING_ITEMS = $blockingText
    REBUTTAL = $(if ([string]::IsNullOrWhiteSpace($RebuttalText)) { 'none' } else { $RebuttalText })
    REFERENCE_ROOT = [string]$Config.referenceRoot
  }
  $filledArbiterPrompt = [regex]::Replace(
    $ArbiterTemplate,
    '\{\{(PR_NUMBER|ISSUE_BODY|DIFF_STAT|BLOCKING_ITEMS|REBUTTAL|REFERENCE_ROOT)\}\}',
    [Text.RegularExpressions.MatchEvaluator]{ param($m) [string]$arbValues[$m.Groups[1].Value] }
  )

  Write-Log ('PR #' + $PrNumber + ' head ' + $sha7 + ': invoking automatic arbiter (daily count ' + $dailyCount + '/' + $dailyCap + ')')
  $arbRes = Invoke-ArbiterModel -Config $Config -PromptText $filledArbiterPrompt -WorkDir $WorktreeDir -RunDir $RunDir

  if ($null -eq $arbRes -or ([string]$arbRes.status) -ne 'ok' -or $null -eq $arbRes.result) {
    $arbErr = 'arbiter unavailable'
    if ($null -ne $arbRes -and -not [string]::IsNullOrWhiteSpace([string]$arbRes.error)) {
      $arbErr = [string]$arbRes.error
    }
    Write-Log ('PR #' + $PrNumber + ' head ' + $sha7 + ': arbiter unavailable (' + $arbErr + '); leaving status failure (arbitration pending)')
    if (-not $IsDryRun) {
      Set-AuditCommitStatus -Config $Config -Sha $HeadSha -State 'failure' -Description 'arbitration pending' -TargetUrl $PriorCommentUrl
      $updated = Update-PrStateLocked -Path $StatePath -Number $PrNumber -Mutate {
        param($st)
        $st.arbiterState = 'pending'
        $st.arbiterDone = $false
        $st.arbiterPending = $pendingPayload
      }
      Set-PrStateFields -Target $State -Source $updated
    }
    $unavailArbRecord = [ordered]@{
      pr = $PrNumber
      headSha = $HeadSha
      status = 'arbitration-pending'
      verdict = 'block'
      commitStatus = 'failure'
      description = 'arbitration pending'
      error = $arbErr
      runDir = $RunDir
    }
    Write-Text (Join-Path $RunDir 'result.json') ((ConvertTo-Json -InputObject $unavailArbRecord -Depth 6) + "`n")
    return $unavailArbRecord
  }

  $eval = Evaluate-ArbiterRulings -BlockingFindings $bfArr -FailedAcceptance $faArr -FalseClaims $fcArr -ArbiterResult $arbRes.result
  $arbCommentId = [long]0
  $arbCommentUrl = ''

  if ($eval.allOverturned) {
    $arbCommentBody = Build-ArbiterPassCommentBody -HeadSha $HeadSha -IssueNumber $IssueNumber -Evaluation $eval
    Write-Text (Join-Path $RunDir 'arbiter-comment.md') $arbCommentBody
    $statusDesc = 'Nyx audit passed (arbiter)'
    if (-not $IsDryRun) {
      $posted = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Config.repo + '/issues/' + $PrNumber + '/comments') -Body @{ body = $arbCommentBody }
      $arbCommentId = [long](Get-JsonProp $posted 'id')
      $arbCommentUrl = [string](Get-JsonProp $posted 'html_url')
      $arbCommentCreated = [string](Get-JsonProp $posted 'created_at')

      Set-AuditCommitStatus -Config $Config -Sha $HeadSha -State 'success' -Description $statusDesc -TargetUrl $arbCommentUrl

      $updated = Update-PrStateLocked -Path $StatePath -Number $PrNumber -Mutate {
        param($st)
        $st.headSha = $HeadSha
        $st.verdict = 'pass'
        $st.baseSha = $MainSha
        $st.arbiterState = 'passed'
        $st.arbiterDone = $true
        $st.arbiterPending = $null
        $st.lastCommentId = $arbCommentId
        $st.lastCommentCreatedAt = $arbCommentCreated
        $st.attempts = 0
        $st.lastAttemptAt = ''
        $st.lastErrorKind = ''
      }
      Set-PrStateFields -Target $State -Source $updated
    }

    $passRecord = [ordered]@{
      pr = $PrNumber
      headSha = $HeadSha
      status = 'ok'
      verdict = 'pass'
      arbiter = 'pass'
      commitStatus = 'success'
      description = $statusDesc
      commentId = $arbCommentId
      commentUrl = $arbCommentUrl
      evaluation = $eval
      runDir = $RunDir
    }
    Write-Text (Join-Path $RunDir 'result.json') ((ConvertTo-Json -InputObject $passRecord -Depth 8) + "`n")
    Write-Log ('PR #' + $PrNumber + ' head ' + $sha7 + ' arbiter=pass status=success')
    return $passRecord
  } else {
    $arbCommentBody = Build-ArbiterParkedCommentBody -HeadSha $HeadSha -IssueNumber $IssueNumber -Evaluation $eval
    Write-Text (Join-Path $RunDir 'arbiter-comment.md') $arbCommentBody
    $upCount = @($eval.upheldFindings).Count + @($eval.upheldAcceptance).Count + @($eval.upheldClaims).Count
    $statusDesc = ConvertTo-SingleLine ('Nyx audit parked (arbiter upheld ' + $upCount + ' item(s))') 140
    if (-not $IsDryRun) {
      $posted = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Config.repo + '/issues/' + $PrNumber + '/comments') -Body @{ body = $arbCommentBody }
      $arbCommentId = [long](Get-JsonProp $posted 'id')
      $arbCommentUrl = [string](Get-JsonProp $posted 'html_url')
      $arbCommentCreated = [string](Get-JsonProp $posted 'created_at')

      Set-AuditCommitStatus -Config $Config -Sha $HeadSha -State 'failure' -Description $statusDesc -TargetUrl $arbCommentUrl
      Add-AuditParkedLabel -Config $Config -Number $PrNumber

      $updated = Update-PrStateLocked -Path $StatePath -Number $PrNumber -Mutate {
        param($st)
        $st.headSha = $HeadSha
        $st.verdict = 'parked'
        $st.baseSha = $MainSha
        $st.arbiterState = 'parked'
        $st.arbiterDone = $true
        $st.arbiterPending = $null
        $st.lastCommentId = $arbCommentId
        $st.lastCommentCreatedAt = $arbCommentCreated
        $st.attempts = 0
        $st.lastAttemptAt = ''
        $st.lastErrorKind = ''
      }
      Set-PrStateFields -Target $State -Source $updated
    }

    $parkedRecord = [ordered]@{
      pr = $PrNumber
      headSha = $HeadSha
      status = 'ok'
      verdict = 'parked'
      arbiter = 'parked'
      commitStatus = 'failure'
      description = $statusDesc
      commentId = $arbCommentId
      commentUrl = $arbCommentUrl
      evaluation = $eval
      runDir = $RunDir
    }
    Write-Text (Join-Path $RunDir 'result.json') ((ConvertTo-Json -InputObject $parkedRecord -Depth 8) + "`n")
    Write-Log ('PR #' + $PrNumber + ' head ' + $sha7 + ' arbiter=parked upheld=' + $upCount + ' status=failure')
    return $parkedRecord
  }
}

function Remove-ExcessRuns {
  param(
    [string]$RunsDir,
    [int]$Keep = 20
  )
  if (-not (Test-Path -LiteralPath $RunsDir -PathType Container)) { return }
  $dirs = @(Get-ChildItem -LiteralPath $RunsDir -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
  if ($dirs.Count -le $Keep) { return }
  for ($i = $Keep; $i -lt $dirs.Count; $i++) {
    try {
      Remove-Item -LiteralPath $dirs[$i].FullName -Recurse -Force -ErrorAction Stop
    } catch {
      Write-Log ('failed to prune old run dir ' + $dirs[$i].Name + ': ' + (ConvertTo-SingleLine $_.Exception.Message 160))
    }
  }
}

function Get-PrAuditDecision {
  param(
    $Config,
    $Pr,
    [string]$StateDir,
    [string]$MainSha,
    [int]$ArbiterDailyCap
  )
  $num = [int]$Pr.number
  $headObj = Get-JsonProp $Pr 'head'
  $headSha = [string](Get-JsonProp $headObj 'sha')
  $headRef = [string](Get-JsonProp $headObj 'ref')
  $prTitle = [string](Get-JsonProp $Pr 'title')
  $prBody = [string](Get-JsonProp $Pr 'body')
  if ([string]::IsNullOrWhiteSpace($headSha) -or $headSha.Length -lt 7) {
    return [pscustomobject]@{
      action = 'skip'
      skipRecord = [ordered]@{ pr = $num; reason = 'missing head SHA' }
    }
  }
  $sha7 = $headSha.Substring(0, 7)
  $statePath = Join-Path $StateDir ('pr-' + $num + '.json')
  $state = Read-PrStateLocked -Path $statePath -Number $num

  $isNewHead = ($state.headSha -ne $headSha)
  if ($isNewHead) {
    $state.headSha = $headSha
    $state.attempts = 0
    $state.lastAttemptAt = ''
    $state.lastErrorKind = ''
    $state.round = 0
    $state.lastCommentId = [long]0
    $state.lastCommentCreatedAt = ''
    $state.lastRebuttalCommentId = [long]0
    $state.pendingRebuttalCommentId = [long]0
    $state.verdict = ''
    $state.baseSha = ''
    $state.priorFindings = @()
    $state.arbiterState = ''
    $state.arbiterDone = $false
    $state.arbiterPending = $null
  }

  $rebuttalText = 'none'
  $priorFindingsText = 'none'
  $rebuttalCommentId = [long]0
  $arbiterRetryOnly = $false
  $logMessage = ''

  if (-not $isNewHead) {
    # A pass holds only for the main it was trial-merged onto; re-audit when main moves.
    if ($state.verdict -eq 'pass') {
      # A body edit does not move the head, so recheck the body for agent attribution before reusing a pass.
      if (-not [string]::IsNullOrWhiteSpace($MainSha) -and $state.baseSha -eq $MainSha -and -not (Test-DevinAttribution $prBody)) {
        return [pscustomobject]@{
          action = 'skip'
          skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'already passed for head ' + $sha7 }
        }
      }
      # main moved since pass: start a fresh audit against new main while preserving arbiterDone for this head SHA.
      $state.round = 0
      $state.attempts = 0
      $state.lastAttemptAt = ''
      $state.lastErrorKind = ''
      $state.verdict = ''
      $state.priorFindings = @()
    } elseif ($state.verdict -eq 'parked') {
      return [pscustomobject]@{
        action = 'skip'
        skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'already parked by arbiter for head ' + $sha7 }
      }
    } elseif ($state.verdict -eq 'block') {
      if ([int]$state.round -ge 2) {
        if ($state.arbiterState -eq 'pending' -and -not [string]::IsNullOrWhiteSpace($MainSha) -and $state.baseSha -ne $MainSha) {
          # main moved while arbitration waited: the pending findings came from a stale trial merge, so audit afresh.
          $logMessage = 'PR #' + $num + ' head ' + $sha7 + ': main moved during pending arbitration; restarting the audit'
          $state.round = 0
          $state.attempts = 0
          $state.lastAttemptAt = ''
          $state.lastErrorKind = ''
          $state.verdict = ''
          $state.priorFindings = @()
          $state.arbiterState = ''
          $state.arbiterPending = $null
        } elseif ($state.arbiterState -eq 'pending' -and -not [bool]$state.arbiterDone -and $null -ne $state.arbiterPending) {
          $dailyCheck = Read-ArbiterDailyStateLocked -Path (Get-ArbiterDailyPath -StateDir $StateDir)
          if ([int]$dailyCheck.count -ge $ArbiterDailyCap) {
            return [pscustomobject]@{
              action = 'skip'
              skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'arbitration pending for head ' + $sha7 + ' (daily cap reached)' }
            }
          }
          $arbiterRetryOnly = $true
          $logMessage = 'PR #' + $num + ' head ' + $sha7 + ': retrying pending arbitration'
        } else {
          return [pscustomobject]@{
            action = 'skip'
            skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'already completed rebuttal round for head ' + $sha7 }
          }
        }
      } else {
        $comments = @(Get-PrComments -Config $Config -Number $num)
        $rebuttal = Find-NewRebuttal -Comments $comments -State $state -Config $Config -HeadSha $headSha
        if ($null -eq $rebuttal) {
          return [pscustomobject]@{
            action = 'skip'
            skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'already blocked for head ' + $sha7 + ' with no new rebuttal' }
          }
        }
        $rebuttalText = $rebuttal.text
        $rebuttalCommentId = [long]$rebuttal.commentId
        $priorFindingsText = Format-FindingsForPrompt $state.priorFindings
        if ($priorFindingsText -eq 'none' -and -not [string]::IsNullOrWhiteSpace($rebuttal.lastAuditBody)) {
          $priorFindingsText = $rebuttal.lastAuditBody
        }
        if ([long]$state.pendingRebuttalCommentId -ne $rebuttalCommentId) {
          $state.pendingRebuttalCommentId = $rebuttalCommentId
          $state.attempts = 0
          $state.lastAttemptAt = ''
          $state.lastErrorKind = ''
        }
        if (Test-RetryBackoffActive -State $state -BackoffMinutes 60) {
          return [pscustomobject]@{
            action = 'skip'
            skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'backing off after ' + $state.attempts + ' failed audit attempts for head ' + $sha7 + ' (retry after 60m)' }
          }
        }
        $logMessage = 'PR #' + $num + ' head ' + $sha7 + ': detected new rebuttal comment ' + $rebuttalCommentId + ', starting round ' + ([int]$state.round + 1)
      }
    } else {
      if (Test-RetryBackoffActive -State $state -BackoffMinutes 60) {
        return [pscustomobject]@{
          action = 'skip'
          skipRecord = [ordered]@{ pr = $num; sha = $sha7; reason = 'backing off after ' + $state.attempts + ' failed audit attempts for head ' + $sha7 + ' (retry after 60m)' }
        }
      }
    }
  }

  $nextRound = [int]$state.round + 1
  if ($arbiterRetryOnly) { $nextRound = [int]$state.round }

  return [pscustomobject]@{
    action = 'audit'
    skipRecord = $null
    prNumber = $num
    headSha = $headSha
    sha7 = $sha7
    headRef = $headRef
    prTitle = $prTitle
    prBody = $prBody
    statePath = $statePath
    state = $state
    rebuttalText = $rebuttalText
    priorFindingsText = $priorFindingsText
    rebuttalCommentId = $rebuttalCommentId
    arbiterRetryOnly = $arbiterRetryOnly
    nextRound = $nextRound
    logMessage = $logMessage
  }
}

function Invoke-SinglePrAudit {
  param(
    $Decision,
    $Config,
    [string]$StateDir,
    [string]$RunsDir,
    [string]$ClaimsDir,
    [string]$RepoDir,
    [string]$MainSha,
    [string]$PromptTemplate,
    [string]$ArbiterTemplate,
    $MainCommitsCache,
    $ResultsOut,
    $SkippedOut,
    $ErrorsOut,
    [switch]$IsDryRun
  )
  $num = [int]$Decision.prNumber
  $headSha = [string]$Decision.headSha
  $sha7 = [string]$Decision.sha7
  $headRef = [string]$Decision.headRef
  $prTitle = [string]$Decision.prTitle
  $prBody = [string]$Decision.prBody
  $statePath = [string]$Decision.statePath
  $state = $Decision.state
  $rebuttalText = [string]$Decision.rebuttalText
  $priorFindingsText = [string]$Decision.priorFindingsText
  $rebuttalCommentId = [long]$Decision.rebuttalCommentId
  $arbiterRetryOnly = [bool]$Decision.arbiterRetryOnly
  $nextRound = [int]$Decision.nextRound

  $claim = Try-AcquirePrClaim -ClaimsDir $ClaimsDir -PrNumber $num
  if ($claim.staleClearedPid -gt 0) {
    Write-Log ('PR #' + $num + ' head ' + $sha7 + ': cleared stale claim lock from dead PID ' + $claim.staleClearedPid)
  }
  if (-not $claim.acquired) {
    Write-Log ('PR #' + $num + ' head ' + $sha7 + ': ' + $claim.reason + '; skipping')
    $null = $SkippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = $claim.reason })
    return
  }

  try {
    $runDirName = 'pr-' + $num + '-' + $sha7
    if ($arbiterRetryOnly) { $runDirName = 'pr-' + $num + '-' + $sha7 + '-arbiter' }
    $runDir = Join-Path $RunsDir $runDirName
    if (Test-Path -LiteralPath $runDir) {
      $runDir = Join-Path $RunsDir ($runDirName + '-r' + $nextRound + '-' + [DateTime]::Now.ToString('yyyyMMddTHHmmss'))
    }
    if (Test-Path -LiteralPath $runDir) {
      $runDir = Join-Path $RunsDir ($runDirName + '-r' + $nextRound + '-p' + $PID + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 4))
    }
    [IO.Directory]::CreateDirectory($runDir) | Out-Null

    $worktreeDir = Join-Path $runDir ('worktree-pr-' + $num + '-' + $PID)
    $worktreeCreated = $false
    $pendingSet = $false
    $arbiterStateSaved = $false
    $finalStateSaved = $false
    $preRunState = @{
      headSha = [string]$state.headSha
      attempts = [int]$state.attempts
      lastAttemptAt = [string]$state.lastAttemptAt
      lastErrorKind = [string]$state.lastErrorKind
      round = [int]$state.round
      lastCommentId = [long]$state.lastCommentId
      lastCommentCreatedAt = [string]$state.lastCommentCreatedAt
      lastRebuttalCommentId = [long]$state.lastRebuttalCommentId
      pendingRebuttalCommentId = [long]$state.pendingRebuttalCommentId
      verdict = [string]$state.verdict
      baseSha = [string]$state.baseSha
      priorFindings = @($state.priorFindings)
      arbiterState = [string]$state.arbiterState
      arbiterDone = [bool]$state.arbiterDone
      arbiterPending = $state.arbiterPending
    }

    $baseRef = 'origin/main'
    if (-not [string]::IsNullOrWhiteSpace($MainSha)) { $baseRef = $MainSha }

    try {
    if ($arbiterRetryOnly) {
      Write-Log ('arbitrating PR #' + $num + ' head ' + $sha7)
      if (-not $IsDryRun) {
        Set-AuditCommitStatus -Config $Config -Sha $headSha -State 'pending' -Description 'Nyx audit arbitration running'
        $pendingSet = $true
      }
    } else {
      Write-Log ('auditing PR #' + $num + ' head ' + $sha7 + ' round ' + $nextRound)
      if (-not $IsDryRun) {
        Set-AuditCommitStatus -Config $Config -Sha $headSha -State 'pending' -Description ('Nyx audit running (round ' + $nextRound + ')')
        $pendingSet = $true
      }
    }

    $prepRes = Invoke-WithNamedMutex -MutexName $script:AuditRepoMutexName -TimeoutMs $script:AuditMutexTimeoutMs -Action {
      $fetchPr = Invoke-Git -Directory $RepoDir -Arguments ('fetch --no-tags origin +refs/pull/' + $num + '/head:refs/audit/pr-' + $num) -AuthConfig $Config -TempBase $runDir
      if ($fetchPr.exitCode -ne 0) {
        throw ('git fetch PR #' + $num + ' failed: ' + (ConvertTo-SingleLine $fetchPr.error 240))
      }
      $revCheck = Invoke-Git -Directory $RepoDir -Arguments ('rev-parse --verify refs/audit/pr-' + $num) -TempBase $runDir
      $fetchedShaLocal = ''
      if ($revCheck.exitCode -eq 0 -and $revCheck.text) { $fetchedShaLocal = $revCheck.text.Trim() }
      if ($fetchedShaLocal -ne $headSha) {
        return [pscustomobject]@{
          headMoved = $true
          fetchedSha = $fetchedShaLocal
        }
      }
      $wtAdd = Invoke-Git -Directory $RepoDir -Arguments ('worktree add --detach ' + (Quote-Arg $worktreeDir) + ' ' + $baseRef) -TempBase $runDir
      if ($wtAdd.exitCode -ne 0) {
        throw ('git worktree add failed: ' + (ConvertTo-SingleLine $wtAdd.error 240))
      }
      return [pscustomobject]@{
        headMoved = $false
        fetchedSha = $fetchedShaLocal
      }
    }
    if ($prepRes.headMoved) {
      Write-Log ('PR #' + $num + ' head moved during fetch (expected ' + $sha7 + ', got ' + $prepRes.fetchedSha + '); skipping')
      $null = $SkippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = 'head moved during fetch' })
      return
    }
    $worktreeCreated = $true

    $mergeRes = Invoke-Git -Directory $worktreeDir -Arguments ('-c user.name=nyx-audit -c user.email=nyx-audit@localhost merge --no-commit --no-ff ' + $headSha) -TempBase $runDir
    $hasMergeConflict = $false
    if ($mergeRes.exitCode -ne 0) {
      $combinedMergeOut = ([string]$mergeRes.text) + "`n" + ([string]$mergeRes.error)
      $porcelain = Invoke-Git -Directory $worktreeDir -Arguments 'status --porcelain' -TempBase $runDir
      $hasUnmerged = ($porcelain.exitCode -eq 0 -and ([string]$porcelain.text) -match '(?m)^(?:UU|AA|DD|AU|UA|DU|UD)\s')
      if ($hasUnmerged -or $combinedMergeOut -match '(?i)CONFLICT|Automatic merge failed') {
        $hasMergeConflict = $true
        $null = Invoke-Git -Directory $worktreeDir -Arguments 'merge --abort' -TempBase $runDir
      } else {
        throw ('git trial merge failed: ' + (ConvertTo-SingleLine $combinedMergeOut 240))
      }
    }

    $issueNumber = Get-LinkedIssueNumber -PrBody $prBody -HeadRef $headRef
    if ($arbiterRetryOnly -and $issueNumber -le 0 -and $null -ne $state.arbiterPending) {
      $savedIssue = Get-JsonProp $state.arbiterPending 'issueNumber'
      if ($null -ne $savedIssue) { $issueNumber = [int]$savedIssue }
    }
    $issueBody = 'No linked issue found.'
    $issueError = ''
    if ($issueNumber -gt 0) {
      try {
        $issueBody = Get-IssueMarkdown -Config $Config -IssueNumber $issueNumber
      } catch {
        $issueError = ConvertTo-SingleLine $_.Exception.Message 240
        $issueBody = 'Failed to fetch linked issue #' + $issueNumber + ': ' + $issueError
      }
    }

    if ($arbiterRetryOnly) {
      $diffStat = '(merge conflict with origin/main)'
      if (-not $hasMergeConflict) {
        $statRes = Invoke-Git -Directory $worktreeDir -Arguments ('diff --cached --stat ' + $baseRef) -TempBase $runDir
        $diffStat = '(empty diff against origin/main)'
        if ($statRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($statRes.text)) {
          $diffStat = $statRes.text.TrimEnd()
        }
      }
      $ap = $state.arbiterPending
      $arbRecord = Invoke-ArbiterPass `
        -Config $Config `
        -StateDir $StateDir `
        -StatePath $statePath `
        -State $state `
        -PrNumber $num `
        -HeadSha $headSha `
        -MainSha $MainSha `
        -IssueNumber $issueNumber `
        -IssueBody $issueBody `
        -DiffStat $diffStat `
        -RebuttalText ([string](Get-JsonProp $ap 'rebuttal')) `
        -BlockingFindings @(Get-JsonProp $ap 'blockingFindings' | Where-Object { $null -ne $_ }) `
        -FailedAcceptance @(Get-JsonProp $ap 'failedAcceptance' | Where-Object { $null -ne $_ }) `
        -FalseClaims @(Get-JsonProp $ap 'falseClaims' | Where-Object { $null -ne $_ }) `
        -PriorCommentUrl ([string](Get-JsonProp $ap 'commentUrl')) `
        -WorktreeDir $worktreeDir `
        -RunDir $runDir `
        -ArbiterTemplate $ArbiterTemplate `
        -IsDryRun:$IsDryRun
      $null = $ResultsOut.Add($arbRecord)
      return
    }

    $acceptance = @()
    $claims = @()
    $withdrawn = @()
    $allFindings = New-Object Collections.Generic.List[object]
    $modelVerdict = ''
    $finalVerdict = 'block'
    $diffStat = '(merge conflict with origin/main)'

    if ($hasMergeConflict) {
      $null = $allFindings.Add([pscustomobject]@{
        id = 'D1'
        severity = 'blocking'
        title = 'conflicts with current main'
        evidence = ('merge origin/main + ' + $sha7)
        why = 'Trial merge of PR head onto origin/main produced merge conflicts.'
      })
      if ($issueNumber -le 0) {
        $null = $allFindings.Add([pscustomobject]@{
          id = 'D2'
          severity = 'blocking'
          title = 'no linked issue'
          evidence = ('branch ' + $headRef)
          why = 'PR body has no Closes/Fixes/Resolves #N reference and branch name does not start with nyx/<N>-.'
        })
      }
      $finalVerdict = 'block'
    } else {
      $namesRes = Invoke-Git -Directory $worktreeDir -Arguments ('-c core.quotepath=false diff --cached --no-renames --name-only -z ' + $baseRef) -TempBase $runDir
      if ($namesRes.exitCode -ne 0) {
        throw ('git diff --name-only failed: ' + (ConvertTo-SingleLine $namesRes.error 240))
      }
      $changedFiles = @(([string]$namesRes.text) -split "`0" | Where-Object { $_ })

      $statRes = Invoke-Git -Directory $worktreeDir -Arguments ('diff --cached --stat ' + $baseRef) -TempBase $runDir
      $diffStat = '(empty diff against origin/main)'
      if ($statRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($statRes.text)) {
        $diffStat = $statRes.text.TrimEnd()
      }
      Write-Text (Join-Path $runDir 'diff.stat.txt') ($diffStat + "`n")

      $diffOutPath = Join-Path $runDir 'diff.patch'
      $diffErrPath = Join-Path $runDir 'diff.err.log'
      $null = Invoke-Tool $script:GitPath ('-C ' + (Quote-Arg $worktreeDir) + ' diff --cached ' + $baseRef) $diffOutPath $diffErrPath $script:WorkRoot

      $prCommits = @(Get-PrCommits -Config $Config -Number $num)
      $mainCompare = Get-MainCompare -Config $Config -HeadSha $headSha
      if (-not $MainCommitsCache['loaded']) {
        $MainCommitsCache['commits'] = @(Get-MainRecentCommits -Config $Config -Limit 50)
        $MainCommitsCache['loaded'] = $true
      }
      $detFindings = @(Get-DeterministicFindings -Worktree $worktreeDir -HeadRef $headRef -ChangedFiles $changedFiles -IssueNumber $issueNumber -IssueError $issueError -TempBase $runDir -PrBody $prBody -PrCommits $prCommits -MainCompare $mainCompare -MainCommits $MainCommitsCache['commits'] -BaseRef $baseRef)
      foreach ($df in $detFindings) { $null = $allFindings.Add($df) }

      $values = @{
        PR_NUMBER = [string]$num
        PR_TITLE = $prTitle
        PR_BODY = $(if ([string]::IsNullOrWhiteSpace($prBody)) { '(empty)' } else { $prBody })
        ISSUE_NUMBER = $(if ($issueNumber -gt 0) { '#' + $issueNumber } else { 'none' })
        ISSUE_BODY = $issueBody
        DIFF_STAT = $diffStat
        DETERMINISTIC_FINDINGS = (Format-FindingsForPrompt $detFindings)
        REFERENCE_ROOT = [string]$Config.referenceRoot
        PRIOR_FINDINGS = $priorFindingsText
        REBUTTAL = $rebuttalText
      }
      $filledPrompt = [regex]::Replace(
        $PromptTemplate,
        '\{\{(PR_NUMBER|PR_TITLE|PR_BODY|ISSUE_NUMBER|ISSUE_BODY|DIFF_STAT|DETERMINISTIC_FINDINGS|REFERENCE_ROOT|PRIOR_FINDINGS|REBUTTAL)\}\}',
        [Text.RegularExpressions.MatchEvaluator]{ param($m) [string]$values[$m.Groups[1].Value] }
      )

      $extraReadDirs = @()
      if (-not [string]::IsNullOrWhiteSpace([string]$Config.referenceRoot)) {
        $extraReadDirs = @([string]$Config.referenceRoot)
      }

      $modelRes = $null
      for ($modelTry = 1; $modelTry -le 2; $modelTry++) {
        $modelRes = Invoke-AuditModel -Config $Config -PromptText $filledPrompt -WorkDir $worktreeDir -ExtraReadDirs $extraReadDirs -RunDir $runDir
        if ($modelRes.status -eq 'ok') {
          $mv = ([string](Get-JsonProp $modelRes.result 'verdict')).Trim().ToLowerInvariant()
          if ($mv -ne 'pass' -and $mv -ne 'block') {
            $modelRes = @{
              status = 'unavailable'
              result = $null
              raw = $modelRes.raw
              error = ('Unexpected PR audit verdict from model: ' + $mv)
            }
          }
        }
        if ($modelRes.status -eq 'ok') { break }
        Write-Log ('PR #' + $num + ' head ' + $sha7 + ' model attempt ' + $modelTry + '/2 unavailable: ' + [string]$modelRes.error)
        if ($modelTry -lt 2) { Start-Sleep -Seconds 5 }
      }

      if ($null -eq $modelRes -or $modelRes.status -ne 'ok') {
        $errReason = 'audit model unavailable'
        if ($null -ne $modelRes -and -not [string]::IsNullOrWhiteSpace([string]$modelRes.error)) {
          $errReason = [string]$modelRes.error
        }
        $newAttempts = [int]$state.attempts + 1
        $attemptAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $state.attempts = $newAttempts
        $state.lastAttemptAt = $attemptAt
        $state.lastErrorKind = 'outage'
        if ($state.verdict -eq 'unavailable-failed') { $state.verdict = '' }
        $inBackoff = ($newAttempts -ge 3)
        $unavailCommitStatus = 'error'
        $unavailDesc = 'audit unavailable, will retry'
        if ($inBackoff) {
          $unavailCommitStatus = 'failure'
          $unavailDesc = 'audit unavailable (backoff 60m), will retry'
        }
        if (-not $IsDryRun) {
          $updated = Update-PrStateLocked -Path $statePath -Number $num -Mutate {
            param($st)
            Set-PrStateFields -Target $st -Source $state
            $st.attempts = $newAttempts
            $st.lastAttemptAt = $attemptAt
            $st.lastErrorKind = 'outage'
            if ($st.verdict -eq 'unavailable-failed') { $st.verdict = '' }
          }
          Set-PrStateFields -Target $state -Source $updated
          Set-AuditCommitStatus -Config $Config -Sha $headSha -State $unavailCommitStatus -Description $unavailDesc
        }
        $unavailRecord = [ordered]@{
          pr = $num
          headSha = $headSha
          round = $nextRound
          status = 'unavailable'
          attempts = $newAttempts
          lastAttemptAt = $attemptAt
          backoffMinutes = $(if ($inBackoff) { 60 } else { 0 })
          commitStatus = $unavailCommitStatus
          error = $errReason
          runDir = $runDir
        }
        Write-Text (Join-Path $runDir 'result.json') ((ConvertTo-Json -InputObject $unavailRecord -Depth 6) + "`n")
        $null = $ResultsOut.Add($unavailRecord)
        Write-Log ('PR #' + $num + ' head ' + $sha7 + ' failed closed (attempts=' + $newAttempts + ', backoff=' + $inBackoff + '): ' + $errReason)
        return
      }

      $parsed = $modelRes.result
      $modelVerdict = ([string](Get-JsonProp $parsed 'verdict')).Trim().ToLowerInvariant()
      $accRaw = Get-JsonProp $parsed 'acceptance'
      if ($null -ne $accRaw) { $acceptance = @($accRaw | ForEach-Object { $_ }) }
      $claimsRaw = Get-JsonProp $parsed 'claims'
      if ($null -ne $claimsRaw) { $claims = @($claimsRaw | ForEach-Object { $_ }) }
      $wdRaw = Get-JsonProp $parsed 'withdrawn'
      if ($null -ne $wdRaw) { $withdrawn = @($wdRaw | ForEach-Object { $_ }) }
      $modelFindingsRaw = Get-JsonProp $parsed 'findings'
      if ($null -ne $modelFindingsRaw) {
        foreach ($mf in @($modelFindingsRaw)) { $null = $allFindings.Add($mf) }
      }

      $hasBlocking = ($modelVerdict -eq 'block')
      foreach ($f in $allFindings.ToArray()) {
        if (([string](Get-JsonProp $f 'severity')).Trim().ToLowerInvariant() -eq 'blocking') { $hasBlocking = $true }
      }
      foreach ($a in $acceptance) {
        $ast = ([string](Get-JsonProp $a 'status')).Trim().ToLowerInvariant()
        if ($ast -eq 'missing' -or $ast -eq 'substituted') { $hasBlocking = $true }
      }
      foreach ($cl in $claims) {
        $hv = Get-JsonProp $cl 'holds'
        if ($hv -is [bool] -and -not $hv) { $hasBlocking = $true }
      }

      if ($hasBlocking) {
        $finalVerdict = 'block'
      } else {
        $finalVerdict = 'pass'
      }
    }

    $findingsArray = @($allFindings.ToArray())
    $blockingFindings = @($findingsArray | Where-Object { ([string](Get-JsonProp $_ 'severity')).Trim().ToLowerInvariant() -eq 'blocking' })
    $failedAcceptance = @($acceptance | Where-Object {
      $ast = ([string](Get-JsonProp $_ 'status')).Trim().ToLowerInvariant()
      $ast -eq 'missing' -or $ast -eq 'substituted'
    })
    $falseClaims = @($claims | Where-Object {
      $hv = Get-JsonProp $_ 'holds'
      ($hv -is [bool]) -and (-not $hv)
    })

    $needsArbitration = ($finalVerdict -eq 'block' -and $nextRound -ge 2)
    $commentBody = Build-AuditCommentBody `
      -HeadSha $headSha `
      -Round $nextRound `
      -Verdict $finalVerdict `
      -IssueNumber $issueNumber `
      -Acceptance $acceptance `
      -Findings $findingsArray `
      -Claims $claims `
      -Withdrawn $withdrawn `
      -ArbiterFollows ($needsArbitration -and -not [bool]$state.arbiterDone)
    Write-Text (Join-Path $runDir 'comment.md') $commentBody

    $blockingCount = $blockingFindings.Count
    $advisoryCount = $findingsArray.Count - $blockingCount
    $failingAccCount = $failedAcceptance.Count
    $failingClaimsCount = $falseClaims.Count

    $commentUrl = ''
    $commentId = [long]0
    $commentCreated = ''
    if (-not $IsDryRun) {
      $posted = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Config.repo + '/issues/' + $num + '/comments') -Body @{ body = $commentBody }
      $commentId = [long](Get-JsonProp $posted 'id')
      $commentUrl = [string](Get-JsonProp $posted 'html_url')
      $commentCreated = [string](Get-JsonProp $posted 'created_at')
    }

    if ($needsArbitration) {
      if ([bool]$state.arbiterDone) {
        # Enforce at most one arbitration per head SHA: park directly without re-invoking the arbiter.
        $emptyEval = Evaluate-ArbiterRulings -BlockingFindings $blockingFindings -FailedAcceptance $failedAcceptance -FalseClaims $falseClaims -ArbiterResult ([pscustomobject]@{ rulings = @(); acceptance = @(); claims = @() })
        $parkBody = Build-ArbiterParkedCommentBody -HeadSha $headSha -IssueNumber $issueNumber -Evaluation $emptyEval -Note 'Arbitration was already used once for this head SHA; parking PR.'
        Write-Text (Join-Path $runDir 'arbiter-comment.md') $parkBody
        $parkDesc = 'Nyx audit parked (arbiter already ran for this head)'
        $parkCommentId = [long]0
        $parkCommentUrl = ''
        if (-not $IsDryRun) {
          $pPost = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Config.repo + '/issues/' + $num + '/comments') -Body @{ body = $parkBody }
          $parkCommentId = [long](Get-JsonProp $pPost 'id')
          $parkCommentUrl = [string](Get-JsonProp $pPost 'html_url')
          $parkCommentCreated = [string](Get-JsonProp $pPost 'created_at')
          Set-AuditCommitStatus -Config $Config -Sha $headSha -State 'failure' -Description $parkDesc -TargetUrl $parkCommentUrl
          Add-AuditParkedLabel -Config $Config -Number $num
          $updated = Update-PrStateLocked -Path $statePath -Number $num -Mutate {
            param($st)
            $st.headSha = $headSha
            $st.round = $nextRound
            $st.lastCommentId = $parkCommentId
            $st.lastCommentCreatedAt = $parkCommentCreated
            $st.lastRebuttalCommentId = [long]$state.lastRebuttalCommentId
            if ($rebuttalCommentId -gt 0) { $st.lastRebuttalCommentId = $rebuttalCommentId }
            $st.pendingRebuttalCommentId = [long]0
            $st.verdict = 'parked'
            $st.baseSha = $MainSha
            $st.priorFindings = $findingsArray
            $st.attempts = 0
            $st.lastAttemptAt = ''
            $st.lastErrorKind = ''
            $st.arbiterState = 'parked'
            $st.arbiterDone = $true
            $st.arbiterPending = $null
          }
          Set-PrStateFields -Target $state -Source $updated
          $finalStateSaved = $true
        }
        $parkRecord = [ordered]@{
          pr = $num
          headSha = $headSha
          round = $nextRound
          status = 'ok'
          verdict = 'parked'
          arbiter = 'skipped-already-ran'
          commitStatus = 'failure'
          description = $parkDesc
          commentId = $parkCommentId
          commentUrl = $parkCommentUrl
          runDir = $runDir
        }
        Write-Text (Join-Path $runDir 'result.json') ((ConvertTo-Json -InputObject $parkRecord -Depth 6) + "`n")
        $null = $ResultsOut.Add($parkRecord)
        Write-Log ('PR #' + $num + ' head ' + $sha7 + ' round ' + $nextRound + ' parked (arbiter already ran for this head)')
        return
      }

      if (-not $IsDryRun) {
        $pendingObj = [pscustomobject]@{
          issueNumber = $issueNumber
          commentUrl = $commentUrl
          rebuttal = $rebuttalText
          blockingFindings = $blockingFindings
          failedAcceptance = $failedAcceptance
          falseClaims = $falseClaims
        }
        $updated = Update-PrStateLocked -Path $statePath -Number $num -Mutate {
          param($st)
          $st.headSha = $headSha
          $st.round = $nextRound
          $st.lastCommentId = $commentId
          $st.lastCommentCreatedAt = $commentCreated
          $st.lastRebuttalCommentId = [long]$state.lastRebuttalCommentId
          if ($rebuttalCommentId -gt 0) { $st.lastRebuttalCommentId = $rebuttalCommentId }
          $st.pendingRebuttalCommentId = [long]0
          $st.verdict = 'block'
          $st.baseSha = $MainSha
          $st.priorFindings = $findingsArray
          $st.attempts = 0
          $st.lastAttemptAt = ''
          $st.lastErrorKind = ''
          $st.arbiterState = 'pending'
          $st.arbiterDone = [bool]$state.arbiterDone
          $st.arbiterPending = $pendingObj
        }
        Set-PrStateFields -Target $state -Source $updated
        $arbiterStateSaved = $true
      }

      $arbRecord = Invoke-ArbiterPass `
        -Config $Config `
        -StateDir $StateDir `
        -StatePath $statePath `
        -State $state `
        -PrNumber $num `
        -HeadSha $headSha `
        -MainSha $MainSha `
        -IssueNumber $issueNumber `
        -IssueBody $issueBody `
        -DiffStat $diffStat `
        -RebuttalText $rebuttalText `
        -BlockingFindings $blockingFindings `
        -FailedAcceptance $failedAcceptance `
        -FalseClaims $falseClaims `
        -PriorCommentUrl $commentUrl `
        -WorktreeDir $worktreeDir `
        -RunDir $runDir `
        -ArbiterTemplate $ArbiterTemplate `
        -IsDryRun:$IsDryRun
      $null = $ResultsOut.Add($arbRecord)
      return
    }

    $ghStatus = 'failure'
    if ($finalVerdict -eq 'pass') { $ghStatus = 'success' }
    if ($finalVerdict -eq 'pass') {
      $statusDesc = 'Nyx audit passed (round ' + $nextRound + ', ' + $advisoryCount + ' advisory)'
    } else {
      $parts = @()
      if ($blockingCount -gt 0) { $parts += ($blockingCount.ToString() + ' blocking') }
      if ($failingAccCount -gt 0) { $parts += ($failingAccCount.ToString() + ' missing/substituted') }
      if ($failingClaimsCount -gt 0) { $parts += ($failingClaimsCount.ToString() + ' false claim(s)') }
      $detail = 'blocked'
      if ($parts.Count -gt 0) { $detail = ($parts -join ', ') }
      $statusDesc = 'Nyx audit blocked (round ' + $nextRound + '): ' + $detail
    }
    $statusDesc = ConvertTo-SingleLine $statusDesc 140

    if (-not $IsDryRun) {
      Set-AuditCommitStatus -Config $Config -Sha $headSha -State $ghStatus -Description $statusDesc -TargetUrl $commentUrl

      $updated = Update-PrStateLocked -Path $statePath -Number $num -Mutate {
        param($st)
        $st.headSha = $headSha
        $st.round = $nextRound
        $st.lastCommentId = $commentId
        $st.lastCommentCreatedAt = $commentCreated
        $st.lastRebuttalCommentId = [long]$state.lastRebuttalCommentId
        if ($rebuttalCommentId -gt 0) { $st.lastRebuttalCommentId = $rebuttalCommentId }
        $st.pendingRebuttalCommentId = [long]0
        $st.verdict = $finalVerdict
        $st.baseSha = $MainSha
        $st.priorFindings = $findingsArray
        $st.attempts = 0
        $st.lastAttemptAt = ''
        $st.lastErrorKind = ''
        $st.arbiterState = ''
        $st.arbiterDone = [bool]$state.arbiterDone
        $st.arbiterPending = $null
      }
      Set-PrStateFields -Target $state -Source $updated
      $finalStateSaved = $true
    }

    $prRecord = [ordered]@{
      pr = $num
      headSha = $headSha
      round = $nextRound
      status = 'ok'
      verdict = $finalVerdict
      commitStatus = $ghStatus
      description = $statusDesc
      commentId = $commentId
      commentUrl = $commentUrl
      issueNumber = $issueNumber
      acceptance = @($acceptance)
      findings = @($findingsArray)
      claims = @($claims)
      withdrawn = @($withdrawn)
      runDir = $runDir
    }
    Write-Text (Join-Path $runDir 'result.json') ((ConvertTo-Json -InputObject $prRecord -Depth 8) + "`n")
    $null = $ResultsOut.Add($prRecord)
    Write-Log ('PR #' + $num + ' head ' + $sha7 + ' round ' + $nextRound + ' verdict=' + $finalVerdict + ' status=' + $ghStatus)
  } catch {
    $caughtException = $_.Exception
    $errMsg = ConvertTo-SingleLine (Protect-LogText $caughtException.Message) 300
    Write-Log ('PR #' + $num + ' head ' + $sha7 + ' error: ' + $errMsg)
    if ($finalStateSaved) {
      # The verdict, its status and the state are already committed; a later reporting
      # failure (result.json, logs) must not revert them or rewrite the published status.
      Write-Log ('PR #' + $num + ' head ' + $sha7 + ' verdict already committed; keeping it despite the reporting error')
    } elseif ($arbiterRetryOnly -or $arbiterStateSaved) {
      if ($pendingSet -and -not $IsDryRun) {
        try { Set-AuditCommitStatus -Config $Config -Sha $headSha -State 'failure' -Description 'arbitration pending' } catch { }
      }
    } else {
      $restoredAttempts = [int]$preRunState['attempts']
      $restoredLastAttemptAt = [string]$preRunState['lastAttemptAt']
      $restoredLastErrorKind = [string]$preRunState['lastErrorKind']

      $isRemoteOutage = Test-RemoteOutageException -Exception $caughtException -Message $errMsg
      if ($isRemoteOutage) {
        $restoredAttempts = $restoredAttempts + 1
        $restoredLastAttemptAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $restoredLastErrorKind = 'outage'
      } else {
        if ($restoredLastErrorKind -eq 'local') {
          $restoredAttempts = $restoredAttempts + 1
        } else {
          $restoredAttempts = 1
        }
        $restoredLastErrorKind = 'local'
        if ($restoredAttempts -lt 3) {
          $restoredLastAttemptAt = ''
        } else {
          $restoredLastAttemptAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
      }

      Set-PrStateFields -Target $state -Source $preRunState
      $state.attempts = $restoredAttempts
      $state.lastAttemptAt = $restoredLastAttemptAt
      $state.lastErrorKind = $restoredLastErrorKind

      if (-not $IsDryRun) {
        try {
          $updated = Update-PrStateLocked -Path $statePath -Number $num -Mutate {
            param($st)
            Set-PrStateFields -Target $st -Source $preRunState
            $st.attempts = $restoredAttempts
            $st.lastAttemptAt = $restoredLastAttemptAt
            $st.lastErrorKind = $restoredLastErrorKind
          }
          Set-PrStateFields -Target $state -Source $updated
        } catch {
          Write-Log ('PR #' + $num + ' head ' + $sha7 + ' failed to save error state: ' + (ConvertTo-SingleLine (Protect-LogText $_.Exception.Message) 200))
        }
        if ($pendingSet) {
          $inBackoff = ([int]$state.attempts -ge 3 -and -not [string]::IsNullOrWhiteSpace([string]$state.lastAttemptAt))
          $errStatus = 'error'
          $errDesc = 'audit unavailable, will retry'
          if ($inBackoff) {
            $errStatus = 'failure'
            $errDesc = 'audit unavailable (backoff 60m), will retry'
          }
          try { Set-AuditCommitStatus -Config $Config -Sha $headSha -State $errStatus -Description $errDesc } catch { }
        }
      }
    }
    $null = $ErrorsOut.Add([ordered]@{ pr = $num; headSha = $headSha; error = $errMsg; runDir = $runDir })
    } finally {
      if (($worktreeCreated -or (Test-Path -LiteralPath $worktreeDir)) -and -not [string]::IsNullOrWhiteSpace($worktreeDir)) {
        Stop-WorktreeProcesses $worktreeDir
        if ($script:GitPath -and (Test-Path -LiteralPath (Join-Path $RepoDir '.git'))) {
          try {
            $null = Invoke-WithNamedMutex -MutexName $script:AuditRepoMutexName -TimeoutMs $script:AuditMutexTimeoutMs -Action {
              if (Test-Path -LiteralPath $worktreeDir) {
                $null = Invoke-Git -Directory $RepoDir -Arguments ('worktree remove --force ' + (Quote-Arg $worktreeDir)) -TempBase $runDir
              }
              if (Test-Path -LiteralPath $worktreeDir) {
                $null = Invoke-Tool $script:CmdExe ('/d /c rmdir /s /q ' + (Quote-Arg $worktreeDir)) (Join-Path $runDir '.rmdir.out.tmp') (Join-Path $runDir '.rmdir.err.tmp') $script:WorkRoot
              }
              $null = Invoke-Git -Directory $RepoDir -Arguments 'worktree prune' -TempBase $runDir
            }
          } catch {
            Write-Log ('PR #' + $num + ' worktree cleanup error: ' + (ConvertTo-SingleLine (Protect-LogText $_.Exception.Message) 200))
          }
        }
      }
    }
  } finally {
    if ($null -ne $claim -and $claim.acquired) {
      try {
        Release-PrClaim -LockPath $claim.lockPath -OwnerPid $PID
      } catch {
        Write-Log ('PR #' + $num + ' failed to release claim lock: ' + (ConvertTo-SingleLine (Protect-LogText $_.Exception.Message) 200))
      }
    }
  }
}

function ConvertFrom-ChildSummaryJson {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $trimmed = $Text.TrimStart([char]0xFEFF).Trim()
  if ($trimmed.StartsWith('{')) {
    try {
      $parsed = $trimmed | ConvertFrom-Json
      if ($parsed -is [pscustomobject]) { return $parsed }
    } catch { }
  }
  $lines = @($trimmed -split "`r?`n")
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = $lines[$i].Trim()
    if ($line.StartsWith('{')) {
      try {
        $parsed = $line | ConvertFrom-Json
        if ($parsed -is [pscustomobject]) { return $parsed }
      } catch { }
    }
  }
  $braceIdx = $trimmed.IndexOf('{')
  if ($braceIdx -ge 0) {
    try {
      $parsed = $trimmed.Substring($braceIdx) | ConvertFrom-Json
      if ($parsed -is [pscustomobject]) { return $parsed }
    } catch { }
  }
  return $null
}

function Start-AuditChildProcess {
  param(
    [int]$PrNumber,
    [string]$HeadSha,
    [string]$Sha7,
    [string]$ConfigFullPath,
    [string]$BaseMainSha,
    [string]$LogsDir,
    [switch]$IsDryRun
  )
  $tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $stdoutPath = Join-Path $LogsDir ('.child-pr-' + $PrNumber + '-' + $tag + '.out.tmp')
  $stderrPath = Join-Path $LogsDir ('.child-pr-' + $PrNumber + '-' + $tag + '.err.tmp')

  $childArgs = New-Object Collections.Generic.List[string]
  $null = $childArgs.Add('-NoProfile')
  $null = $childArgs.Add('-NonInteractive')
  $null = $childArgs.Add('-ExecutionPolicy')
  $null = $childArgs.Add('Bypass')
  $null = $childArgs.Add('-File')
  $null = $childArgs.Add((Quote-Arg $script:ScriptPath))
  $null = $childArgs.Add('-ConfigPath')
  $null = $childArgs.Add((Quote-Arg $ConfigFullPath))
  $null = $childArgs.Add('-SinglePr')
  $null = $childArgs.Add([string]$PrNumber)
  if (-not [string]::IsNullOrWhiteSpace($BaseMainSha)) {
    $null = $childArgs.Add('-BaseMainSha')
    $null = $childArgs.Add((Quote-Arg $BaseMainSha))
  }
  if ($IsDryRun) {
    $null = $childArgs.Add('-DryRun')
  }
  $argString = ($childArgs.ToArray() -join ' ')

  $proc = Start-Process -FilePath $script:PowerShellExe `
    -ArgumentList $argString `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WorkingDirectory $script:WorkRoot `
    -WindowStyle Hidden `
    -PassThru
  if (-not $proc) {
    throw ('Failed to start child PowerShell process for PR #' + $PrNumber)
  }
  # Windows PowerShell 5.1 only fills ExitCode for a -PassThru process whose handle was opened before it exited.
  $null = $proc.Handle

  return [pscustomobject]@{
    pr = $PrNumber
    headSha = $HeadSha
    sha7 = $Sha7
    pid = [int]$proc.Id
    process = $proc
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    startedAt = [DateTime]::UtcNow
  }
}

function Complete-AuditChildProcess {
  param(
    $Job,
    $ResultsOut,
    $SkippedOut,
    $ErrorsOut
  )
  $childExit = -1
  try {
    $Job.process.WaitForExit()
    if ($null -ne $Job.process.ExitCode) { $childExit = [int]$Job.process.ExitCode }
  } finally {
    try { $Job.process.Dispose() } catch { }
  }

  $elapsedSec = [int][Math]::Round(([DateTime]::UtcNow - $Job.startedAt).TotalSeconds)
  $stdoutText = Read-Text $Job.stdoutPath
  $stderrText = Read-Text $Job.stderrPath
  $summaryObj = ConvertFrom-ChildSummaryJson -Text $stdoutText

  $auditedCount = 0
  $skippedCount = 0
  $errorCount = 0

  if ($null -ne $summaryObj) {
    $childAudited = @(Get-JsonProp $summaryObj 'audited' | Where-Object { $null -ne $_ })
    $childSkipped = @(Get-JsonProp $summaryObj 'skipped' | Where-Object { $null -ne $_ })
    $childErrors = @(Get-JsonProp $summaryObj 'errors' | Where-Object { $null -ne $_ })
    foreach ($item in $childAudited) {
      $null = $ResultsOut.Add($item)
      $auditedCount++
    }
    foreach ($item in $childSkipped) {
      $null = $SkippedOut.Add($item)
      $skippedCount++
    }
    foreach ($item in $childErrors) {
      $null = $ErrorsOut.Add($item)
      $errorCount++
    }
    if ($childExit -ne 0 -and $errorCount -eq 0) {
      $errTail = ConvertTo-SingleLine (Protect-LogText ([string]$stderrText)) 240
      $msg = 'child audit process exited with code ' + $childExit
      if (-not [string]::IsNullOrWhiteSpace($errTail)) { $msg = $msg + ': ' + $errTail }
      $null = $ErrorsOut.Add([ordered]@{ pr = $Job.pr; headSha = $Job.headSha; error = $msg })
      $errorCount++
    }
  } else {
    $errTail = ConvertTo-SingleLine (Protect-LogText ([string]$stderrText)) 240
    if ([string]::IsNullOrWhiteSpace($errTail)) {
      $errTail = ConvertTo-SingleLine (Protect-LogText ([string]$stdoutText)) 240
    }
    $msg = 'child audit process produced no parseable summary (exitCode=' + $childExit + ')'
    if (-not [string]::IsNullOrWhiteSpace($errTail)) { $msg = $msg + ': ' + $errTail }
    $null = $ErrorsOut.Add([ordered]@{ pr = $Job.pr; headSha = $Job.headSha; error = $msg })
    $errorCount++
  }

  try { if (Test-Path -LiteralPath $Job.stdoutPath -PathType Leaf) { [IO.File]::Delete($Job.stdoutPath) } } catch { }
  try { if (Test-Path -LiteralPath $Job.stderrPath -PathType Leaf) { [IO.File]::Delete($Job.stderrPath) } } catch { }

  Write-Log ('child finished for PR #' + $Job.pr + ' head ' + $Job.sha7 + ' pid=' + $Job.pid + ' exitCode=' + $childExit + ' elapsed=' + $elapsedSec + 's audited=' + $auditedCount + ' skipped=' + $skippedCount + ' errors=' + $errorCount)
}

$lock = $null
$resultsOut = New-Object Collections.Generic.List[object]
$skippedOut = New-Object Collections.Generic.List[object]
$errorsOut = New-Object Collections.Generic.List[object]
$exitCode = 0

try {
  if ($SinglePr -lt 0) { throw '-SinglePr must be a non-negative integer.' }
  if ($PrNumber -lt 0) { throw '-PrNumber must be a non-negative integer.' }
  if ($MaxParallel -lt 1) { throw '-MaxParallel must be at least 1.' }

  $isChildMode = ($SinglePr -gt 0)
  $resolvedConfigPath = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ConfigPath))
  $config = Get-AuditConfig -Path $resolvedConfigPath
  $script:WorkRoot = [IO.Path]::GetFullPath([string]$config.workRoot).TrimEnd('\')
  Assert-OutsideGitCheckout $script:WorkRoot

  $stateDir = Join-Path $script:WorkRoot 'state'
  $runsDir = Join-Path $script:WorkRoot 'runs'
  $logsDir = Join-Path $script:WorkRoot 'logs'
  $claimsDir = Join-Path $script:WorkRoot 'claims'
  $repoDir = Join-Path $script:WorkRoot 'repo'

  [IO.Directory]::CreateDirectory($script:WorkRoot) | Out-Null
  [IO.Directory]::CreateDirectory($stateDir) | Out-Null
  [IO.Directory]::CreateDirectory($runsDir) | Out-Null
  [IO.Directory]::CreateDirectory($logsDir) | Out-Null
  [IO.Directory]::CreateDirectory($claimsDir) | Out-Null

  if ($isChildMode) {
    $script:LogPath = Join-Path $logsDir ('audit-' + [DateTime]::Now.ToString('yyyyMMdd') + '-pr-' + $SinglePr + '-pid-' + $PID + '.log')
    $script:LogPrefix = '[pr#' + $SinglePr + ' pid=' + $PID + '] '
  } else {
    $script:LogPath = Join-Path $logsDir ('audit-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')
    $script:LogPrefix = ''
  }
  Initialize-Redactions @($script:WorkRoot, [string]$config.referenceRoot, [string]$config.keyPath, [string](Get-JsonProp $config 'devinCli'))

  $canRun = $true
  if (-not $isChildMode) {
    $lockPath = Join-Path $script:WorkRoot 'audit.lock'
    try {
      $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
      Write-Log 'another audit run holds audit.lock; exiting'
      $null = $skippedOut.Add([ordered]@{ pr = $null; reason = 'another audit run holds the lock' })
      $lock = $null
      $canRun = $false
    }
  }

  if ($canRun) {
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'

    $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { throw 'git was not found on PATH.' }
    $script:GitPath = $git.Source

    $promptTemplatePath = Join-Path $PSScriptRoot 'audit-prompt.md'
    $promptTemplate = Read-Text $promptTemplatePath
    if ([string]::IsNullOrWhiteSpace($promptTemplate)) {
      throw ('audit-prompt.md not found or empty at ' + $promptTemplatePath)
    }

    $arbiterTemplatePath = Join-Path $PSScriptRoot 'arbiter-prompt.md'
    $arbiterTemplate = Read-Text $arbiterTemplatePath
    if ([string]::IsNullOrWhiteSpace($arbiterTemplate)) {
      throw ('arbiter-prompt.md not found or empty at ' + $arbiterTemplatePath)
    }

    $arbiterDailyCap = 6
    $cfgDailyCap = Get-JsonProp $config 'arbiterDailyCap'
    if ($null -ne $cfgDailyCap) {
      $parsedDailyCap = 0
      if ([int]::TryParse([string]$cfgDailyCap, [ref]$parsedDailyCap) -and $parsedDailyCap -ge 0) {
        $arbiterDailyCap = $parsedDailyCap
      }
    }

    $mainCommitsCache = @{
      loaded = $false
      commits = @()
    }

    if ($isChildMode) {
      Write-Log ('child audit started: repo=' + $config.repo + ' pr=' + $SinglePr + ' dryRun=' + [bool]$DryRun)
      $pulls = @(Get-OpenNyxPulls -Config $config -OnlyPrNumber $SinglePr)
      if ($pulls.Count -gt 0) {
        $mainSha = Invoke-WithNamedMutex -MutexName $script:AuditRepoMutexName -TimeoutMs $script:AuditMutexTimeoutMs -Action {
          if (-not [string]::IsNullOrWhiteSpace($BaseMainSha) -and (Test-Path -LiteralPath (Join-Path $repoDir '.git'))) {
            $verifyRes = Invoke-Git -Directory $repoDir -Arguments ('rev-parse --verify ' + $BaseMainSha + '^{commit}')
            if ($verifyRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$verifyRes.text)) {
              return ([string]$verifyRes.text).Trim()
            }
          }
          Ensure-AuditRepo -Config $config -RepoDir $repoDir
          $mainShaRes = Invoke-Git -Directory $repoDir -Arguments 'rev-parse origin/main'
          if ($mainShaRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$mainShaRes.text)) {
            return ([string]$mainShaRes.text).Trim()
          }
          return ''
        }

        $decision = Get-PrAuditDecision -Config $config -Pr $pulls[0] -StateDir $stateDir -MainSha $mainSha -ArbiterDailyCap $arbiterDailyCap
        if ($decision.action -eq 'skip') {
          $null = $skippedOut.Add($decision.skipRecord)
        } else {
          if (-not [string]::IsNullOrWhiteSpace($decision.logMessage)) {
            Write-Log $decision.logMessage
          }
          Invoke-SinglePrAudit `
            -Decision $decision `
            -Config $config `
            -StateDir $stateDir `
            -RunsDir $runsDir `
            -ClaimsDir $claimsDir `
            -RepoDir $repoDir `
            -MainSha $mainSha `
            -PromptTemplate $promptTemplate `
            -ArbiterTemplate $arbiterTemplate `
            -MainCommitsCache $mainCommitsCache `
            -ResultsOut $resultsOut `
            -SkippedOut $skippedOut `
            -ErrorsOut $errorsOut `
            -IsDryRun:$DryRun
        }
      } else {
        $null = $skippedOut.Add([ordered]@{ pr = $SinglePr; reason = 'PR is not an open nyx/* pull request targeting main' })
      }
      Write-Log ('child audit finished: pr=' + $SinglePr + ' audited=' + $resultsOut.Count + ' skipped=' + $skippedOut.Count + ' errors=' + $errorsOut.Count)
    } else {
      $pulls = @(Get-OpenNyxPulls -Config $config -OnlyPrNumber $PrNumber)
      Write-Log ('audit pass started: repo=' + $config.repo + ' openNyxPrs=' + $pulls.Count + ' maxParallel=' + $MaxParallel + ' dryRun=' + [bool]$DryRun)

      $mainSha = ''
      if ($pulls.Count -gt 0) {
        $mainSha = Invoke-WithNamedMutex -MutexName $script:AuditRepoMutexName -TimeoutMs $script:AuditMutexTimeoutMs -Action {
          Ensure-AuditRepo -Config $config -RepoDir $repoDir
          $mainShaRes = Invoke-Git -Directory $repoDir -Arguments 'rev-parse origin/main'
          if ($mainShaRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$mainShaRes.text)) {
            return ([string]$mainShaRes.text).Trim()
          }
          return ''
        }
      }

      if ($MaxParallel -eq 1) {
        foreach ($pr in $pulls) {
          $decision = Get-PrAuditDecision -Config $config -Pr $pr -StateDir $stateDir -MainSha $mainSha -ArbiterDailyCap $arbiterDailyCap
          if ($decision.action -eq 'skip') {
            $null = $skippedOut.Add($decision.skipRecord)
            continue
          }
          if (-not [string]::IsNullOrWhiteSpace($decision.logMessage)) {
            Write-Log $decision.logMessage
          }
          Invoke-SinglePrAudit `
            -Decision $decision `
            -Config $config `
            -StateDir $stateDir `
            -RunsDir $runsDir `
            -ClaimsDir $claimsDir `
            -RepoDir $repoDir `
            -MainSha $mainSha `
            -PromptTemplate $promptTemplate `
            -ArbiterTemplate $arbiterTemplate `
            -MainCommitsCache $mainCommitsCache `
            -ResultsOut $resultsOut `
            -SkippedOut $skippedOut `
            -ErrorsOut $errorsOut `
            -IsDryRun:$DryRun
        }
      } else {
        $toAudit = New-Object Collections.Generic.List[object]
        foreach ($pr in $pulls) {
          $decision = Get-PrAuditDecision -Config $config -Pr $pr -StateDir $stateDir -MainSha $mainSha -ArbiterDailyCap $arbiterDailyCap
          if ($decision.action -eq 'skip') {
            $null = $skippedOut.Add($decision.skipRecord)
            continue
          }
          $liveClaim = Get-LivePrClaim -ClaimsDir $claimsDir -PrNumber $decision.prNumber
          if ($null -ne $liveClaim) {
            $claimReason = 'already claimed by live audit process PID ' + $liveClaim.pid
            Write-Log ('PR #' + $decision.prNumber + ' head ' + $decision.sha7 + ': ' + $claimReason + '; skipping')
            $null = $skippedOut.Add([ordered]@{ pr = $decision.prNumber; sha = $decision.sha7; reason = $claimReason })
            continue
          }
          if (-not [string]::IsNullOrWhiteSpace($decision.logMessage)) {
            Write-Log $decision.logMessage
          }
          $null = $toAudit.Add($decision)
        }

        if ($toAudit.Count -gt 0) {
          $prLabels = New-Object Collections.Generic.List[string]
          foreach ($item in $toAudit.ToArray()) {
            $null = $prLabels.Add(('#' + $item.prNumber))
          }
          Write-Log ('audit pass dispatching ' + $toAudit.Count + ' PR(s) with maxParallel=' + $MaxParallel + ': ' + ($prLabels.ToArray() -join ', '))

          $activeChildren = New-Object Collections.Generic.List[object]
          $nextIdx = 0
          $queueItems = @($toAudit.ToArray())
          $totalToAudit = $queueItems.Count

          try {
            while ($nextIdx -lt $totalToAudit -or $activeChildren.Count -gt 0) {
              while ($activeChildren.Count -lt $MaxParallel -and $nextIdx -lt $totalToAudit) {
                $target = $queueItems[$nextIdx]
                $nextIdx++
                try {
                  $job = Start-AuditChildProcess `
                    -PrNumber $target.prNumber `
                    -HeadSha $target.headSha `
                    -Sha7 $target.sha7 `
                    -ConfigFullPath $resolvedConfigPath `
                    -BaseMainSha $mainSha `
                    -LogsDir $logsDir `
                    -IsDryRun:$DryRun
                  $null = $activeChildren.Add($job)
                  Write-Log ('launched child for PR #' + $job.pr + ' head ' + $job.sha7 + ' pid=' + $job.pid + ' (active=' + $activeChildren.Count + '/' + $MaxParallel + ')')
                } catch {
                  $launchErr = ConvertTo-SingleLine (Protect-LogText $_.Exception.Message) 300
                  Write-Log ('failed to launch child for PR #' + $target.prNumber + ' head ' + $target.sha7 + ': ' + $launchErr)
                  $null = $errorsOut.Add([ordered]@{ pr = $target.prNumber; headSha = $target.headSha; error = $launchErr })
                }
              }

              if ($activeChildren.Count -eq 0) { break }

              $completedJobs = New-Object Collections.Generic.List[object]
              foreach ($job in $activeChildren.ToArray()) {
                if ($job.process.HasExited) {
                  $null = $completedJobs.Add($job)
                }
              }

              if ($completedJobs.Count -eq 0) {
                Start-Sleep -Milliseconds 500
                continue
              }

              foreach ($doneJob in $completedJobs.ToArray()) {
                $null = $activeChildren.Remove($doneJob)
                Complete-AuditChildProcess -Job $doneJob -ResultsOut $resultsOut -SkippedOut $skippedOut -ErrorsOut $errorsOut
              }
            }
          } finally {
            foreach ($remJob in $activeChildren.ToArray()) {
              try {
                if ($null -ne $remJob.process) { $remJob.process.Dispose() }
              } catch { }
            }
          }
        }
      }

      Remove-ExcessRuns -RunsDir $runsDir -Keep 20
      Write-Log ('audit pass finished: audited=' + $resultsOut.Count + ' skipped=' + $skippedOut.Count + ' errors=' + $errorsOut.Count)
    }
  }
} catch {
  $exitCode = 1
  $errMsg = ConvertTo-SingleLine (Protect-LogText $_.Exception.Message) 300
  Write-Log ('fatal error: ' + $errMsg)
  $null = $errorsOut.Add([ordered]@{ pr = $null; error = $errMsg })
} finally {
  if ($null -ne $lock) { $lock.Dispose() }
}

$summary = [ordered]@{
  dryRun = [bool]$DryRun
  audited = [object[]]$resultsOut.ToArray()
  skipped = [object[]]$skippedOut.ToArray()
  errors = [object[]]$errorsOut.ToArray()
}

try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
if ($DryRun) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $summary -Depth 10))
} else {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $summary -Depth 8 -Compress))
}
exit $exitCode
