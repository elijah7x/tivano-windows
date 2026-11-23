# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-NeonFix.ps1 -PrNumber <n> -WorktreeDir <worktree> -FailuresFile <file> [-IssueNumber <n>] [-Model <model>] [-TimeoutMinutes <min>] [-RunRoot <dir>] [-ReferenceRoot <dir>] [-AgyPath <exe>] [-ShortCooldownMinutes <min>]
# Runs Gemini 4 Neon via Antigravity CLI (agy.exe) inside an existing PR worktree, reverts disallowed edits, and emits one compact JSON summary line to stdout.

param(
  [int]$PrNumber = 0,
  [string]$WorktreeDir = '',
  [string]$FailuresFile = '',
  [int]$IssueNumber = 0,
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$Model = 'gemini-4-neon-high',
  [ValidateRange(1, 240)][int]$TimeoutMinutes = 45,
  [string]$RunRoot = 'C:\tivano\dev-loop\autopilot\neon',
  [string]$ReferenceRoot = 'C:\tivano\reference\tivano-v3.0.0',
  [string]$AgyPath = '',
  [ValidateRange(1, 1440)][int]$ShortCooldownMinutes = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskkillExe = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
$script:PromptTemplate = Join-Path $PSScriptRoot 'neon-fix-prompt.md'
$script:AcceptanceRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$script:CooldownHours = 6

$script:GuardedPrefixes = @(
  'scripts/audit/',
  'scripts/dev-loop/',
  'scripts/pr-review/',
  'scripts/windows-acceptance/',
  '.github/'
)
$script:GuardedFiles = @(
  'package-lock.json',
  'agents.md',
  'contributing.md',
  'license',
  'third_party_notices.md',
  'trademark.md',
  'docs/source-baseline.json'
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
$script:AllowedTrackedFiles = @(
  'docs/parity.md',
  'index.html',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.mjs',
  'vite.config.ts',
  'vite.config.mjs'
)

$script:GitPath = $null
$script:NeonRoot = $null
$script:RunDir = $null
$script:LogPath = $null

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

function Save-JsonAtomic {
  param(
    [string]$Path,
    $Object
  )
  $parentDir = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parentDir)) {
    [IO.Directory]::CreateDirectory($parentDir) | Out-Null
  }
  $tmp = $Path + '.tmp'
  $jsonText = (ConvertTo-Json -InputObject $Object -Depth 6) + "`n"
  Write-Text $tmp $jsonText
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (Test-Path -LiteralPath $Path -PathType Leaf) {
        # PowerShell turns $null into an empty string for a string parameter; File.Replace needs a real null.
        [IO.File]::Replace($tmp, $Path, [NullString]::Value)
      } else {
        [IO.File]::Move($tmp, $Path)
      }
      return
    } catch {
      if ($attempt -lt 8) {
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    }
  }
  try {
    [IO.File]::Copy($tmp, $Path, $true)
    try {
      if (Test-Path -LiteralPath $tmp -PathType Leaf) {
        [IO.File]::Delete($tmp)
      }
    } catch { }
    return
  } catch {
    $fallbackErr = $_
    try {
      if (Test-Path -LiteralPath $tmp -PathType Leaf) {
        [IO.File]::Delete($tmp)
      }
    } catch { }
    throw $fallbackErr
  }
}

function Quote-Argument {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function Write-Log {
  param([string]$Message)
  if (-not $script:LogPath) { return }
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $Message + "`r`n"
  try {
    [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

function ConvertTo-SingleLine {
  param(
    [AllowEmptyString()][string]$Text,
    [int]$Limit = 300
  )
  if ($null -eq $Text) { return '' }
  $line = [regex]::Replace($Text, '[\x00-\x1f\x7f]+', ' ')
  $line = [regex]::Replace($line, '\s+', ' ').Trim()
  $line = $line.Replace('"', "'").TrimEnd('\')
  if ($line.Length -gt $Limit) { $line = $line.Substring(0, $Limit).Trim() }
  return $line
}

function Get-Tail {
  param(
    [string]$Path,
    [int]$Count
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return '' }
  $lines = @($text.TrimEnd() -split "`r?`n")
  if ($lines.Count -le $Count) { return ($lines -join "`n") }
  return (($lines[($lines.Count - $Count)..($lines.Count - 1)]) -join "`n")
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
      throw ($Path + ' is inside a git checkout (' + $part + '). Keep Neon state and logs outside any checkout.')
    }
    $parent = Split-Path -Parent $part
    if (-not $parent -or $parent -eq $part) { break }
    $part = $parent
  }
}

function Assert-AcceptanceOutsideRepo {
  param([string]$Path)
  $repoFull = Get-AcceptancePath $script:AcceptanceRepo
  if ($Path.Equals($repoFull, [StringComparison]::OrdinalIgnoreCase) -or
      $Path.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Neon state and logs must be outside the repository.'
  }
}

function Assert-CmdSafePath {
  param(
    [string]$Name,
    [string]$Path
  )
  if ($Path.Contains('%') -or $Path.Contains('"') -or $Path.Contains("`r") -or $Path.Contains("`n")) {
    throw ($Name + ' cannot contain percent signs, quotes or newlines.')
  }
}

function Invoke-Tool {
  param(
    [string]$FilePath,
    [string]$Arguments,
    [string]$OutPath,
    [string]$ErrPath,
    [string]$WorkingDirectory = ''
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

function Invoke-Git {
  param(
    [string]$Directory,
    [string]$Arguments
  )
  $tmpBase = $script:NeonRoot
  if ($script:RunDir) { $tmpBase = $script:RunDir }
  $out = Join-Path $tmpBase '.git.out.tmp'
  $err = Join-Path $tmpBase '.git.err.tmp'
  $code = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Directory) + ' ' + $Arguments) $out $err $tmpBase
  return [pscustomobject]@{
    exitCode = $code
    text = (Read-Text $out)
    error = (Read-Text $err)
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
      $exeHit = $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($Worktree, [StringComparison]::OrdinalIgnoreCase)
      $cmdHit = $proc.CommandLine -and $proc.CommandLine.IndexOf($Worktree, [StringComparison]::OrdinalIgnoreCase) -ge 0
      if ($exeHit -or $cmdHit) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}

function Parse-TimestampOffset {
  param([AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse(
    $Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$parsed
  )) {
    return $parsed
  }
  return $null
}

function Test-AuthQuotaErrorText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bauth(?:entication|enticate|enticated)?\b|\blogin\b|log\s+in|logged\s+in|UNAUTHENTICATED|PERMISSION_DENIED|quota|RESOURCE_EXHAUSTED|\b429\b|usage limit|rate limit exceeded|too many requests')
}

function Test-RegionNetworkErrorText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)location is not supported|FAILED_PRECONDITION|UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|socket hang up|schannel|TLS|network|(?<![0-9])(502|503|504)(?![0-9])')
}

function Get-CooldownClassification {
  param(
    [AllowEmptyString()][string]$ErrorText = '',
    [AllowEmptyString()][string]$ErrorCode = '',
    [bool]$Retryable = $false
  )
  $combined = ($ErrorCode + ' ' + $ErrorText).Trim()
  $isAuthQuota = Test-AuthQuotaErrorText $combined
  $isRegionNetwork = (Test-RegionNetworkErrorText $combined) -or $Retryable
  $defaultMinutes = $script:CooldownHours * 60

  if ($isAuthQuota) {
    return [pscustomobject]@{
      cooldownClass = 'auth-quota'
      durationMinutes = $defaultMinutes
    }
  }
  if ($isRegionNetwork) {
    return [pscustomobject]@{
      cooldownClass = 'region-network'
      durationMinutes = $script:ShortCooldownMinutes
    }
  }
  return [pscustomobject]@{
    cooldownClass = 'unknown'
    durationMinutes = $script:ShortCooldownMinutes
  }
}

function Get-ActiveCooldown {
  param([string]$HealthPath)
  if (-not (Test-Path -LiteralPath $HealthPath -PathType Leaf)) { return $null }
  $raw = Read-Text $HealthPath
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $data = $null
  try {
    $data = $raw.TrimStart([char]0xFEFF) | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($data -isnot [pscustomobject]) { return $null }
  $statusVal = [string](Get-JsonProp $data 'status')
  if ($statusVal -ne 'unavailable') { return $null }
  $retryVal = Get-JsonProp $data 'retryable'
  if ($null -ne $retryVal -and [bool]$retryVal) { return $null }

  $storedClass = ([string](Get-JsonProp $data 'cooldownClass')).Trim()
  $storedErrorRaw = [string](Get-JsonProp $data 'error')
  $storedErrorCode = [string](Get-JsonProp $data 'errorCode')

  $until = Parse-TimestampOffset ([string](Get-JsonProp $data 'cooldownUntil'))
  $setAt = Parse-TimestampOffset ([string](Get-JsonProp $data 'cooldownSetAt'))
  if ($null -eq $setAt) {
    $setAt = Parse-TimestampOffset ([string](Get-JsonProp $data 'recordedAt'))
  }

  $storedDurationMin = 0
  $rawDuration = Get-JsonProp $data 'cooldownMinutes'
  if ($null -ne $rawDuration -and -not [string]::IsNullOrWhiteSpace([string]$rawDuration)) {
    try { $storedDurationMin = [int]$rawDuration } catch { $storedDurationMin = 0 }
  }

  if ($null -eq $until -and $null -ne $setAt) {
    if ($storedDurationMin -gt 0) {
      $until = $setAt.AddMinutes($storedDurationMin)
    } elseif (-not [string]::IsNullOrWhiteSpace($storedClass) -and $storedClass -ne 'auth-quota') {
      $until = $setAt.AddMinutes($script:ShortCooldownMinutes)
    } else {
      $until = $setAt.AddHours($script:CooldownHours)
    }
  }
  if ($null -eq $until) { return $null }

  if ($null -eq $setAt) {
    if ($storedDurationMin -gt 0) {
      $setAt = $until.AddMinutes(-$storedDurationMin)
    } else {
      $setAt = $until.AddHours(-$script:CooldownHours)
    }
  }

  $effectiveClass = $storedClass
  if ([string]::IsNullOrWhiteSpace($storedClass)) {
    $legacyClass = Get-CooldownClassification -ErrorText $storedErrorRaw -ErrorCode $storedErrorCode -Retryable $false
    $effectiveClass = $legacyClass.cooldownClass
    if ($legacyClass.cooldownClass -eq 'region-network') {
      $cappedUntil = $setAt.AddMinutes($script:ShortCooldownMinutes)
      if ($until -gt $cappedUntil) {
        $until = $cappedUntil
      }
    }
  }

  if ([DateTimeOffset]::UtcNow -ge $until) { return $null }

  $durationMinutes = [int][Math]::Round(($until - $setAt).TotalMinutes)
  $storedError = ConvertTo-SingleLine $storedErrorRaw 300
  if ([string]::IsNullOrWhiteSpace($storedError)) {
    $storedError = 'agy unavailable (cooldown active until ' + $until.UtcDateTime.ToString('o') + ')'
  }
  return [pscustomobject]@{
    error = $storedError
    cooldownUntil = $until.UtcDateTime.ToString('o')
    cooldownSetAt = $setAt.UtcDateTime.ToString('o')
    cooldownClass = $effectiveClass
    durationMinutes = $durationMinutes
  }
}

function Write-HealthCooldown {
  param(
    [string]$HealthPath,
    [string]$ErrorText,
    [string]$ErrorCode,
    [string]$ModelName,
    [bool]$Retryable = $false
  )
  $classification = Get-CooldownClassification -ErrorText $ErrorText -ErrorCode $ErrorCode -Retryable $Retryable
  $durationMinutes = [int]$classification.durationMinutes
  $nowUtc = [DateTimeOffset]::UtcNow
  $untilUtc = $nowUtc.AddMinutes($durationMinutes)
  $setAtIso = $nowUtc.UtcDateTime.ToString('o')
  $untilIso = $untilUtc.UtcDateTime.ToString('o')
  $payload = [ordered]@{
    status = 'unavailable'
    retryable = $false
    error = (ConvertTo-SingleLine $ErrorText 300)
    errorCode = $ErrorCode
    cooldownClass = $classification.cooldownClass
    cooldownMinutes = $durationMinutes
    cooldownSetAt = $setAtIso
    recordedAt = $setAtIso
    cooldownUntil = $untilIso
    model = $ModelName
  }
  try {
    Save-JsonAtomic -Path $HealthPath -Object $payload
    Write-Log ('cooldown set: class=' + $classification.cooldownClass + ' duration=' + $durationMinutes + 'm setAt=' + $setAtIso + ' until=' + $untilIso)
  } catch {
    Write-Log ('failed to write health.json: ' + $_.Exception.Message)
  }
  return [pscustomobject]@{
    cooldownClass = $classification.cooldownClass
    durationMinutes = $durationMinutes
    cooldownSetAt = $setAtIso
    cooldownUntil = $untilIso
  }
}

function Write-HealthOk {
  param(
    [string]$HealthPath,
    [string]$ModelName
  )
  if (-not (Test-Path -LiteralPath $HealthPath -PathType Leaf)) { return }
  $nowUtc = [DateTimeOffset]::UtcNow
  $payload = [ordered]@{
    status = 'ok'
    retryable = $true
    error = ''
    errorCode = ''
    cooldownClass = ''
    cooldownMinutes = 0
    cooldownSetAt = ''
    recordedAt = $nowUtc.UtcDateTime.ToString('o')
    cooldownUntil = ''
    model = $ModelName
  }
  try {
    Save-JsonAtomic -Path $HealthPath -Object $payload
  } catch {
    Write-Log ('failed to clear health.json: ' + $_.Exception.Message)
  }
}

function Test-NonRetryableErrorText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)FAILED_PRECONDITION|User location is not supported|UNAUTHENTICATED|PERMISSION_DENIED|not logged in|not authenticated')
}

function Parse-AgyError {
  param(
    [AllowEmptyString()][string]$StderrText,
    [AllowEmptyString()][string]$StdoutText = ''
  )
  $sources = @($StderrText, $StdoutText)
  $matchedJson = $null
  foreach ($src in $sources) {
    if ([string]::IsNullOrWhiteSpace($src)) { continue }
    $lines = @($src -split "`r?`n")
    foreach ($line in $lines) {
      $cleanLine = [regex]::Replace($line, '\x1b\[[0-9;]*[A-Za-z]', '')
      if ($cleanLine -match '^\s*AGY_ERROR:\s*(\{.*\})\s*$') {
        $matchedJson = $Matches[1]
      }
    }
    if ($null -ne $matchedJson) { break }
  }
  if ($null -eq $matchedJson) { return $null }

  $parsed = $null
  try {
    $parsed = $matchedJson | ConvertFrom-Json
  } catch {
    $fallbackMsg = ConvertTo-SingleLine ('AGY_ERROR: ' + $matchedJson) 300
    $isNonRetry = Test-NonRetryableErrorText $fallbackMsg
    return [pscustomobject]@{
      message = $fallbackMsg
      errorCode = ''
      retryable = (-not $isNonRetry)
    }
  }

  $shortErr = ConvertTo-SingleLine ([string](Get-JsonProp $parsed 'short_error')) 260
  $errCode = ConvertTo-SingleLine ([string](Get-JsonProp $parsed 'error_code')) 80
  $retryProp = Get-JsonProp $parsed 'retryable'
  $retryable = $true
  if ($null -ne $retryProp) {
    $retryable = [bool]$retryProp
  } elseif (Test-NonRetryableErrorText ($errCode + ' ' + $shortErr)) {
    $retryable = $false
  }

  $msg = $shortErr
  if (-not [string]::IsNullOrWhiteSpace($errCode)) {
    if ([string]::IsNullOrWhiteSpace($msg)) {
      $msg = $errCode
    } elseif ($msg.IndexOf($errCode, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      $msg = $errCode + ': ' + $msg
    }
  }
  if ([string]::IsNullOrWhiteSpace($msg)) {
    $msg = ConvertTo-SingleLine ('AGY_ERROR: ' + $matchedJson) 300
  }

  return [pscustomobject]@{
    message = (ConvertTo-SingleLine $msg 300)
    errorCode = $errCode
    retryable = $retryable
  }
}

function Resolve-AgyExecutable {
  param([string]$RequestedPath)
  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    $resolved = Get-AcceptancePath $RequestedPath
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw ('agy.exe not found at ' + $resolved)
    }
    return $resolved
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $defaultExe = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    if (Test-Path -LiteralPath $defaultExe -PathType Leaf) {
      return (Get-AcceptancePath $defaultExe)
    }
  }
  $cmd = Get-Command -Name 'agy' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
    return (Get-AcceptancePath $cmd.Source)
  }
  throw 'agy.exe not found at %LOCALAPPDATA%\agy\bin\agy.exe or on PATH.'
}

function ConvertTo-CanonicalJson {
  param($Value)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) {
    if ($Value) { return 'true' }
    return 'false'
  }
  if ($Value -is [string]) {
    return (ConvertTo-Json -InputObject $Value -Compress)
  }
  if ($Value -is [ValueType]) {
    return [Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Value -is [Collections.IEnumerable] -and -not ($Value -is [Collections.IDictionary])) {
    $items = New-Object Collections.Generic.List[string]
    foreach ($item in $Value) {
      $null = $items.Add((ConvertTo-CanonicalJson $item))
    }
    return ('[' + ($items.ToArray() -join ',') + ']')
  }
  if ($Value -is [Collections.IDictionary]) {
    $dictPairs = New-Object Collections.Generic.List[string]
    $sortedKeys = @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)
    foreach ($key in $sortedKeys) {
      $k = ConvertTo-Json -InputObject $key -Compress
      $v = ConvertTo-CanonicalJson $Value[$key]
      $null = $dictPairs.Add($k + ':' + $v)
    }
    return ('{' + ($dictPairs.ToArray() -join ',') + '}')
  }
  $pairs = New-Object Collections.Generic.List[string]
  $props = @($Value.PSObject.Properties | Sort-Object -Property Name)
  foreach ($prop in $props) {
    $k = ConvertTo-Json -InputObject ([string]$prop.Name) -Compress
    $v = ConvertTo-CanonicalJson $prop.Value
    $null = $pairs.Add($k + ':' + $v)
  }
  return ('{' + ($pairs.ToArray() -join ',') + '}')
}

function Test-PackageDepsChanged {
  param([string]$Worktree)
  $pkgPath = Join-Path $Worktree 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
    return $true
  }
  $curText = Read-Text $pkgPath
  if ([string]::IsNullOrWhiteSpace($curText)) { return $true }

  $headRes = Invoke-Git $Worktree 'show HEAD:package.json'
  if ($headRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($headRes.text)) {
    return $true
  }

  $headObj = $null
  $curObj = $null
  try {
    $headObj = $headRes.text.TrimStart([char]0xFEFF) | ConvertFrom-Json
    $curObj = $curText.TrimStart([char]0xFEFF) | ConvertFrom-Json
  } catch {
    return $true
  }
  if ($headObj -isnot [pscustomobject] -or $curObj -isnot [pscustomobject]) {
    return $true
  }

  foreach ($section in $script:DependencySections) {
    $headVal = Get-JsonProp $headObj $section
    $curVal = Get-JsonProp $curObj $section
    $headCanon = ConvertTo-CanonicalJson $headVal
    $curCanon = ConvertTo-CanonicalJson $curVal
    if ($headCanon -cne $curCanon) {
      return $true
    }
  }
  return $false
}

function ConvertFrom-GitPorcelainPath {
  param([string]$RawPath)
  $p = $RawPath
  if ($p.Length -ge 2 -and $p.StartsWith('"') -and $p.EndsWith('"')) {
    $p = $p.Substring(1, $p.Length - 2).Replace('\"', '"').Replace('\\', '\')
  }
  $p = $p.Replace('\', '/')
  while ($p.StartsWith('./')) { $p = $p.Substring(2) }
  return $p
}

function Get-PorcelainEntries {
  param([string]$Worktree)
  $entries = New-Object Collections.Generic.List[object]
  $res = Invoke-Git $Worktree '-c core.quotepath=false status --porcelain -uall'
  if ($res.exitCode -ne 0 -or $null -eq $res.text) {
    return $entries.ToArray()
  }
  $lines = @($res.text -split "`r?`n")
  foreach ($line in $lines) {
    if ([string]::IsNullOrEmpty($line) -or $line.Length -lt 4) { continue }
    $xy = $line.Substring(0, 2)
    $rest = $line.Substring(3)
    $origPath = ''
    $path = ''
    $isRenameOrCopy = ($xy[0] -eq 'R' -or $xy[0] -eq 'C' -or $xy[1] -eq 'R' -or $xy[1] -eq 'C')
    if ($isRenameOrCopy -and $rest.Contains(' -> ')) {
      $idx = $rest.IndexOf(' -> ')
      $origPath = ConvertFrom-GitPorcelainPath $rest.Substring(0, $idx)
      $path = ConvertFrom-GitPorcelainPath $rest.Substring($idx + 4)
    } else {
      $path = ConvertFrom-GitPorcelainPath $rest
    }
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    $null = $entries.Add([pscustomobject]@{
      xy = $xy
      path = $path
      origPath = $origPath
      untracked = ($xy -eq '??')
    })
  }
  return $entries.ToArray()
}

function Test-PathInHead {
  param(
    [string]$Worktree,
    [string]$RelPath
  )
  $res = Invoke-Git $Worktree ('cat-file -e ' + (Quote-Argument ('HEAD:' + $RelPath)))
  return ($res.exitCode -eq 0)
}

function Test-AllowedWorktreeChange {
  param(
    [string]$Worktree,
    [string]$RelPath,
    [bool]$IsUntracked,
    [bool]$PackageDepsChanged
  )
  $norm = $RelPath.Replace('\', '/').TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($norm)) { return $false }
  if ($norm.StartsWith('../') -or $norm.Contains('/../') -or $norm -eq '..') { return $false }
  $lower = $norm.ToLowerInvariant()

  foreach ($prefix in $script:GuardedPrefixes) {
    if ($lower.StartsWith($prefix)) { return $false }
  }
  if ($script:GuardedFiles -contains $lower) { return $false }

  if ($lower -eq 'package.json') {
    if ($PackageDepsChanged) { return $false }
    return $true
  }

  if ($lower.StartsWith('src/') -or $lower.StartsWith('tests/')) {
    return $true
  }

  if ($IsUntracked) { return $false }

  if (-not (Test-PathInHead -Worktree $Worktree -RelPath $norm)) {
    return $false
  }

  if ($lower.StartsWith('scripts/')) { return $true }
  if ($script:AllowedTrackedFiles -contains $lower) { return $true }

  return $false
}

function Undo-SingleWorktreePath {
  param(
    [string]$Worktree,
    [string]$RelPath
  )
  if ([string]::IsNullOrWhiteSpace($RelPath)) { return }
  $inHead = Test-PathInHead -Worktree $Worktree -RelPath $RelPath
  if ($inHead) {
    $null = Invoke-Git $Worktree ('checkout HEAD -- ' + (Quote-Argument $RelPath))
  } else {
    $null = Invoke-Git $Worktree ('reset -q HEAD -- ' + (Quote-Argument $RelPath))
    $null = Invoke-Git $Worktree ('clean -fd -- ' + (Quote-Argument $RelPath))
  }
}

function Invoke-EnforceWorktreeBoundary {
  param(
    [string]$Worktree,
    [Collections.Generic.List[string]]$RevertedList
  )
  $entries = @(Get-PorcelainEntries -Worktree $Worktree)
  if ($entries.Count -eq 0) { return }

  $pkgTouched = $false
  foreach ($entry in $entries) {
    if ($entry.path.ToLowerInvariant() -eq 'package.json' -or $entry.origPath.ToLowerInvariant() -eq 'package.json') {
      $pkgTouched = $true
      break
    }
  }
  $pkgDepsChanged = $false
  if ($pkgTouched) {
    $pkgDepsChanged = Test-PackageDepsChanged -Worktree $Worktree
  }

  $revertedSeen = @{}
  foreach ($entry in $entries) {
    $destAllowed = Test-AllowedWorktreeChange -Worktree $Worktree -RelPath $entry.path -IsUntracked ([bool]$entry.untracked) -PackageDepsChanged $pkgDepsChanged
    $origAllowed = $true
    if (-not [string]::IsNullOrWhiteSpace($entry.origPath)) {
      $origAllowed = Test-AllowedWorktreeChange -Worktree $Worktree -RelPath $entry.origPath -IsUntracked $false -PackageDepsChanged $pkgDepsChanged
    }

    if (-not $destAllowed -or -not $origAllowed) {
      Undo-SingleWorktreePath -Worktree $Worktree -RelPath $entry.path
      if (-not $revertedSeen.ContainsKey($entry.path)) {
        $revertedSeen[$entry.path] = $true
        $null = $RevertedList.Add($entry.path)
      }
      if (-not [string]::IsNullOrWhiteSpace($entry.origPath)) {
        Undo-SingleWorktreePath -Worktree $Worktree -RelPath $entry.origPath
        if (-not $revertedSeen.ContainsKey($entry.origPath)) {
          $revertedSeen[$entry.origPath] = $true
          $null = $RevertedList.Add($entry.origPath)
        }
      }
    }
  }
}

$statusOut = 'unavailable'
$changedFilesOut = New-Object Collections.Generic.List[string]
$revertedOut = New-Object Collections.Generic.List[string]
$errorOut = ''
$retryableOut = $false
$runDirOut = ''
$cooldownClassOut = ''
$exitCode = 2

$healthPath = $null
$worktreePath = $null

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ($PrNumber -le 0) { throw '-PrNumber is required and must be positive.' }
  if ([string]::IsNullOrWhiteSpace($WorktreeDir)) { throw '-WorktreeDir is required.' }
  if ([string]::IsNullOrWhiteSpace($FailuresFile)) { throw '-FailuresFile is required.' }
  if ([string]::IsNullOrWhiteSpace($RunRoot)) { throw '-RunRoot is required.' }

  $script:NeonRoot = Get-AcceptancePath $RunRoot
  Assert-OutsideGitCheckout $script:NeonRoot
  Assert-AcceptanceOutsideRepo $script:NeonRoot
  Assert-CmdSafePath '-RunRoot' $script:NeonRoot
  [IO.Directory]::CreateDirectory($script:NeonRoot) | Out-Null
  $healthPath = Join-Path $script:NeonRoot 'health.json'

  # Check unavailability cooldown before invoking agy.
  $cooldown = Get-ActiveCooldown -HealthPath $healthPath
  if ($null -ne $cooldown) {
    $statusOut = 'unavailable'
    $errorOut = $cooldown.error
    $retryableOut = $false
    $cooldownClassOut = [string]$cooldown.cooldownClass
    $exitCode = 2
  } else {
    $worktreePath = Get-AcceptancePath $WorktreeDir
    Assert-CmdSafePath '-WorktreeDir' $worktreePath
    if (-not (Test-Path -LiteralPath $worktreePath -PathType Container)) {
      throw ('-WorktreeDir does not exist: ' + $worktreePath)
    }
    if (-not (Test-Path -LiteralPath (Join-Path $worktreePath '.git'))) {
      throw ('-WorktreeDir is not a git worktree: ' + $worktreePath)
    }

    $failuresSourcePath = Get-AcceptancePath $FailuresFile
    if (-not (Test-Path -LiteralPath $failuresSourcePath -PathType Leaf)) {
      throw ('-FailuresFile does not exist: ' + $failuresSourcePath)
    }
    $failuresText = Read-Text $failuresSourcePath
    if ([string]::IsNullOrWhiteSpace($failuresText)) {
      throw ('-FailuresFile is empty: ' + $failuresSourcePath)
    }

    if (-not (Test-Path -LiteralPath $script:PromptTemplate -PathType Leaf)) {
      throw ('neon-fix-prompt.md is missing at ' + $script:PromptTemplate)
    }

    $referencePath = ''
    $hasReferenceDir = $false
    if (-not [string]::IsNullOrWhiteSpace($ReferenceRoot)) {
      $referencePath = Get-AcceptancePath $ReferenceRoot
      Assert-CmdSafePath '-ReferenceRoot' $referencePath
      if (Test-Path -LiteralPath $referencePath -PathType Container) {
        $hasReferenceDir = $true
      }
    }

    $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { throw 'git was not found on PATH.' }
    $script:GitPath = $git.Source

    $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
    $runDirCandidate = Join-Path $script:NeonRoot ('pr-' + $PrNumber + '-' + $stamp)
    if (Test-Path -LiteralPath $runDirCandidate) {
      $runDirCandidate += '-' + [Guid]::NewGuid().ToString('N').Substring(0, 4)
    }
    [IO.Directory]::CreateDirectory($runDirCandidate) | Out-Null
    $script:RunDir = $runDirCandidate
    $runDirOut = $runDirCandidate
    $script:LogPath = Join-Path $script:RunDir 'neon.log'
    Assert-CmdSafePath 'RunDir' $script:RunDir

    $agyExePath = $null
    try {
      $agyExePath = Resolve-AgyExecutable -RequestedPath $AgyPath
    } catch {
      $missingMsg = ConvertTo-SingleLine $_.Exception.Message 300
      Write-Log ('agy missing: ' + $missingMsg)
      $cooldownInfo = Write-HealthCooldown -HealthPath $healthPath -ErrorText $missingMsg -ErrorCode 'AGY_NOT_FOUND' -ModelName $Model -Retryable $false
      $cooldownClassOut = $cooldownInfo.cooldownClass
      $statusOut = 'unavailable'
      $errorOut = $missingMsg
      $retryableOut = $false
      $exitCode = 2
    }

    if ($null -ne $agyExePath) {
      Assert-CmdSafePath 'agy.exe' $agyExePath
      Write-Log ('start pr=#' + $PrNumber + ' issue=' + $IssueNumber + ' model=' + $Model + ' timeoutMin=' + $TimeoutMinutes)

      $headBeforeRes = Invoke-Git $worktreePath 'rev-parse HEAD'
      $headBefore = ''
      if ($headBeforeRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($headBeforeRes.text)) {
        $headBefore = $headBeforeRes.text.Trim()
      }

      $failuresCopyPath = Join-Path $script:RunDir 'failures-input.md'
      Write-Text $failuresCopyPath $failuresText

      $cappedFailures = $failuresText.TrimEnd()
      if ($cappedFailures.Length -gt 65536) {
        $cappedFailures = $cappedFailures.Substring(0, 65536) + "`n(Truncated above at 64KB; read full file at " + $failuresCopyPath + '.)'
      }

      $issueDisplay = 'not specified'
      if ($IssueNumber -gt 0) {
        $issueDisplay = '#' + [string]$IssueNumber
      }
      $referenceDisplay = 'not available'
      if ($hasReferenceDir) {
        $referenceDisplay = $referencePath
      } elseif (-not [string]::IsNullOrWhiteSpace($referencePath)) {
        $referenceDisplay = $referencePath + ' (not present on disk)'
      }

      $template = Read-Text $script:PromptTemplate
      $values = @{
        PR_NUMBER = [string]$PrNumber
        ISSUE_NUMBER = $issueDisplay
        WORKTREE_DIR = $worktreePath
        REFERENCE_ROOT = $referenceDisplay
        FAILURES_FILE = $failuresCopyPath
        FAILURES_TEXT = $cappedFailures
      }
      $promptText = [regex]::Replace(
        $template,
        '\{\{(PR_NUMBER|ISSUE_NUMBER|WORKTREE_DIR|REFERENCE_ROOT|FAILURES_FILE|FAILURES_TEXT)\}\}',
        [Text.RegularExpressions.MatchEvaluator]{ param($m) [string]$values[$m.Groups[1].Value] }
      )
      $promptPath = Join-Path $script:RunDir 'prompt.md'
      Write-Text $promptPath $promptText
      Assert-CmdSafePath 'promptPath' $promptPath

      $agyLogPath = Join-Path $script:RunDir 'agy.log'
      $agyOutPath = Join-Path $script:RunDir 'agy.out.log'
      $agyErrPath = Join-Path $script:RunDir 'agy.err.log'
      Assert-CmdSafePath 'agyLogPath' $agyLogPath

      $shortPrompt = 'Read and follow every instruction in ' + $promptPath + '. Work inside the current PR worktree ' + $worktreePath + '.'
      $agyArgs = '-p ' + (Quote-Argument $shortPrompt) +
        ' --model ' + (Quote-Argument $Model) +
        ' --mode accept-edits' +
        ' --add-dir ' + (Quote-Argument $script:RunDir)
      if ($hasReferenceDir) {
        $agyArgs += ' --add-dir ' + (Quote-Argument $referencePath)
      }
      $agyArgs += ' --print-timeout ' + ([string]$TimeoutMinutes + 'm') +
        ' --output-format text' +
        ' --log-file ' + (Quote-Argument $agyLogPath)

      $env:GIT_TERMINAL_PROMPT = '0'
      $env:GH_PROMPT_DISABLED = '1'
      $env:CI = '1'

      Write-Log ('invoking agy: ' + $agyExePath)
      $process = Start-Process -FilePath $agyExePath -ArgumentList $agyArgs `
        -RedirectStandardOutput $agyOutPath -RedirectStandardError $agyErrPath `
        -WorkingDirectory $worktreePath -WindowStyle Hidden -PassThru
      if (-not $process) {
        $statusOut = 'unavailable'
        $errorOut = 'Could not start agy.exe.'
        $retryableOut = $true
        $exitCode = 2
      } else {
        # Windows PowerShell 5.1 only populates ExitCode when Handle is accessed before exit.
        $null = $process.Handle
        $timedOut = -not $process.WaitForExit($TimeoutMinutes * 60000)
        if ($timedOut) {
          Write-Log ('agy timed out after ' + $TimeoutMinutes + ' minutes; killing process tree pid=' + $process.Id)
          $null = Invoke-Tool $script:TaskkillExe ('/T /F /PID ' + $process.Id) (Join-Path $script:RunDir 'agy-kill.out.log') (Join-Path $script:RunDir 'agy-kill.err.log') $script:NeonRoot
          $null = $process.WaitForExit(5000)
          Stop-TreeProcesses $worktreePath
        } else {
          $process.WaitForExit()
          Stop-TreeProcesses $worktreePath
        }

        $agyExitCode = $null
        if (-not $timedOut) {
          $agyExitCode = $process.ExitCode
        }

        # Never allow Neon to leave behind commits: unwind any accidental commit to working tree before boundary checks.
        if (-not [string]::IsNullOrWhiteSpace($headBefore)) {
          $headAfterRes = Invoke-Git $worktreePath 'rev-parse HEAD'
          if ($headAfterRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($headAfterRes.text)) {
            $headAfter = $headAfterRes.text.Trim()
            if ($headAfter -ne $headBefore) {
              Write-Log ('agy moved HEAD from ' + $headBefore + ' to ' + $headAfter + '; soft-resetting to keep changes uncommitted')
              $null = Invoke-Git $worktreePath ('reset --soft ' + $headBefore)
            }
          }
        }

        $statusBeforeRes = Invoke-Git $worktreePath 'status --porcelain'
        $statusBeforeText = ''
        if ($null -ne $statusBeforeRes.text) { $statusBeforeText = $statusBeforeRes.text }
        Write-Text (Join-Path $script:RunDir 'git-status-before.txt') $statusBeforeText

        Invoke-EnforceWorktreeBoundary -Worktree $worktreePath -RevertedList $revertedOut

        $statusAfterRes = Invoke-Git $worktreePath 'status --porcelain'
        $statusAfterText = ''
        if ($null -ne $statusAfterRes.text) { $statusAfterText = $statusAfterRes.text }
        Write-Text (Join-Path $script:RunDir 'git-status.txt') $statusAfterText

        $diffStatRes = Invoke-Git $worktreePath 'diff --stat'
        $diffStatText = ''
        if ($null -ne $diffStatRes.text) { $diffStatText = $diffStatRes.text }
        Write-Text (Join-Path $script:RunDir 'git-diff-stat.txt') $diffStatText

        $remainingEntries = @(Get-PorcelainEntries -Worktree $worktreePath)
        $changedSeen = @{}
        foreach ($entry in $remainingEntries) {
          if (-not $changedSeen.ContainsKey($entry.path)) {
            $changedSeen[$entry.path] = $true
            $null = $changedFilesOut.Add($entry.path)
          }
        }

        $stderrText = Read-Text $agyErrPath
        $stdoutText = Read-Text $agyOutPath
        $agyErrInfo = Parse-AgyError -StderrText ([string]$stderrText) -StdoutText ([string]$stdoutText)

        if ($timedOut) {
          $statusOut = 'unavailable'
          $errorOut = 'agy timed out after ' + $TimeoutMinutes + ' minutes.'
          $retryableOut = $true
          $exitCode = 2
          Write-Log ('timeout: ' + $errorOut)
        } elseif (($null -ne $agyExitCode -and $agyExitCode -ne 0) -or ($null -ne $agyErrInfo -and $changedFilesOut.Count -eq 0)) {
          $statusOut = 'unavailable'
          $exitCode = 2
          $errCode = ''
          if ($null -ne $agyErrInfo) {
            $errorOut = $agyErrInfo.message
            $errCode = $agyErrInfo.errorCode
            $retryableOut = [bool]$agyErrInfo.retryable
          } else {
            $errTail = ConvertTo-SingleLine ([string](Get-Tail $agyErrPath 10)) 240
            if ([string]::IsNullOrWhiteSpace($errTail)) {
              $errTail = ConvertTo-SingleLine ([string](Get-Tail $agyOutPath 5)) 240
            }
            $codeText = 'unknown'
            if ($null -ne $agyExitCode) { $codeText = [string]$agyExitCode }
            $errorOut = 'agy exited with code ' + $codeText
            if (-not [string]::IsNullOrWhiteSpace($errTail)) {
              $errorOut += ': ' + $errTail
            }
            $retryableOut = (-not (Test-NonRetryableErrorText $errorOut))
          }
          Write-Log ('agy failed (retryable=' + $retryableOut + '): ' + $errorOut)
          # Retryable network or quota errors still pause agy (short or long by class) so the next escalation does not hit the same failure at once.
          if ((-not $retryableOut) -or (Test-AuthQuotaErrorText $errorOut) -or (Test-RegionNetworkErrorText $errorOut)) {
            $cooldownInfo = Write-HealthCooldown -HealthPath $healthPath -ErrorText $errorOut -ErrorCode $errCode -ModelName $Model -Retryable $retryableOut
            $cooldownClassOut = $cooldownInfo.cooldownClass
          }
        } elseif ($changedFilesOut.Count -gt 0) {
          $statusOut = 'ok'
          $errorOut = ''
          $retryableOut = $false
          $exitCode = 0
          Write-HealthOk -HealthPath $healthPath -ModelName $Model
          Write-Log ('completed status=ok changed=' + $changedFilesOut.Count + ' reverted=' + $revertedOut.Count)
        } else {
          $statusOut = 'no-change'
          $errorOut = ''
          $retryableOut = $false
          $exitCode = 3
          Write-HealthOk -HealthPath $healthPath -ModelName $Model
          Write-Log ('completed status=no-change reverted=' + $revertedOut.Count)
        }
      }
    }
  }
} catch {
  $statusOut = 'unavailable'
  $errorOut = ConvertTo-SingleLine $_.Exception.Message 300
  $retryableOut = $false
  $exitCode = 2
  Write-Log ('error: ' + $errorOut)
}

$summary = [ordered]@{
  status = $statusOut
  changedFiles = [string[]]$changedFilesOut.ToArray()
  reverted = [string[]]$revertedOut.ToArray()
  error = $errorOut
  retryable = [bool]$retryableOut
  runDir = $runDirOut
  cooldownClass = $cooldownClassOut
}

if (-not [string]::IsNullOrWhiteSpace($runDirOut) -and (Test-Path -LiteralPath $runDirOut -PathType Container)) {
  try {
    Save-JsonAtomic -Path (Join-Path $runDirOut 'result.json') -Object $summary
  } catch { }
}

try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
$json = ConvertTo-Json -InputObject $summary -Depth 4 -Compress
[Console]::Out.WriteLine($json)
exit $exitCode
