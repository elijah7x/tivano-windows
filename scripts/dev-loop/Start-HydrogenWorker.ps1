# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Start-HydrogenWorker.ps1 [-Repo <owner/name>] [-LaneId <id>] [-LaneRoot <dir>] [-GateRoot <dir>] [-ReferenceRoot <dir>] [-Model <id>] [-Label <label>] [-MaxOpenPrs <n>] [-DailyMergeCap <n>] [-PrintTimeoutMinutes <min>] [-HardKillMinutes <min>] [-CooldownHours <hrs>] [-ShortCooldownMinutes <min>] [-AgyPath <exe>] [-PromptPath <file>]
# Scheduled worker tick for a Gemini 4 Hydrogen implementer lane. Per-lane single-instance via named mutex; coordinates issues across lanes via atomic claim locks and launches at most one detached agy session at a time per lane.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,15}$')][string]$LaneId = 'h1',
  [string]$LaneRoot = 'C:\tivano\dev-loop\hydrogen',
  [string]$GateRoot = 'C:\tivano\dev-loop\autopilot\gate',
  [string]$ReferenceRoot = 'C:\tivano\reference\tivano-v3.0.26',
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$Model = 'gemini-4-hydrogen-high',
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Label = 'nyx-auto',
  [ValidateRange(1, 10)][int]$MaxOpenPrs = 2,
  [ValidateRange(1, 500)][int]$DailyMergeCap = 150,
  [ValidateRange(5, 480)][int]$PrintTimeoutMinutes = 150,
  [ValidateRange(10, 600)][int]$HardKillMinutes = 170,
  [ValidateRange(1, 48)][int]$CooldownHours = 6,
  [ValidateRange(1, 1440)][int]$ShortCooldownMinutes = 30,
  [string]$AgyPath = '',
  [string]$PromptPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LaneId = $LaneId.ToLowerInvariant()
$script:MutexName = 'Local\TivanoDevLoop-HydrogenWorker-' + $script:LaneId
$script:TaskkillExe = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
$script:AcceptanceRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')

$script:ExcludedIssueLabels = @(
  'needs-human',
  'lane-devin',
  'lane-hydrogen',
  'lane-cloud',
  'audit-parked',
  'parked',
  'audit-followup'
)
$script:ParkedPrLabels = @(
  'audit-parked',
  'parked'
)
$script:ParkedIssueLabels = @(
  'parked',
  'needs-human'
)

$script:LaneRootPath = $null
$script:SharedStateDir = $null
$script:ClaimsDir = $null
$script:SharedStopPath = $null
$script:LanesRootPath = $null
$script:LaneDir = $null
$script:GateRootPath = $null
$script:RepoPath = $null
$script:WorktreeRoot = $null
$script:StateDir = $null
$script:LogsDir = $null
$script:SessionsDir = $null
$script:RunsDir = $null
$script:NeonDir = $null
$script:LaneStopPath = $null
$script:WorkerStatePath = $null
$script:ProgressPath = $null
$script:HealthPath = $null
$script:LogPath = $null
$script:GhPath = $null
$script:GitPath = $null

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

function Write-Log {
  param([string]$Message)
  if (-not $script:LogPath) { return }
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $Message + "`r`n"
  try {
    [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false)))
  } catch { }
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
  $tmp = $Path + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp'
  $jsonText = (ConvertTo-Json -InputObject $Object -Depth 6) + "`n"
  Write-Text $tmp $jsonText
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (Test-Path -LiteralPath $Path -PathType Leaf) {
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

function Read-JsonFile {
  param([string]$Path)
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try {
    return ($text.TrimStart([char]0xFEFF) | ConvertFrom-Json)
  } catch {
    return $null
  }
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

function Get-LabelNames {
  param($Labels)
  if ($null -eq $Labels) { return @() }
  $list = New-Object Collections.Generic.List[string]
  foreach ($item in @($Labels)) {
    if ($null -eq $item) { continue }
    $name = [string](Get-JsonProp $item 'name')
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $null = $list.Add($name.Trim())
    }
  }
  return [string[]]$list.ToArray()
}

function Test-HasAnyLabel {
  param(
    [string[]]$Labels,
    [string[]]$Targets
  )
  foreach ($lbl in @($Labels)) {
    if ([string]::IsNullOrWhiteSpace($lbl)) { continue }
    foreach ($t in @($Targets)) {
      if ($lbl.Equals($t, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  }
  return $false
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

function Get-ErrorSummary {
  param($Result)
  if ($null -eq $Result) { return '' }
  $text = [string]$Result.error
  if ([string]::IsNullOrWhiteSpace($text)) { $text = [string]$Result.text }
  return (ConvertTo-SingleLine $text 240)
}

function Quote-Argument {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function Quote-Win32Argument {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value) { return '""' }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
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
      throw ($Path + ' is inside a git checkout (' + $part + '). Keep Hydrogen lane state outside any checkout.')
    }
    $parent = Split-Path -Parent $part
    if (-not $parent -or $parent -eq $part) { break }
    $part = $parent
  }
}

function Assert-OutsideAcceptanceRepo {
  param([string]$Path)
  $repoFull = Get-AcceptancePath $script:AcceptanceRepo
  if ($Path.Equals($repoFull, [StringComparison]::OrdinalIgnoreCase) -or
      $Path.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Hydrogen lane state and logs must be outside the tool repository.'
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

function Parse-UtcTimestamp {
  param([AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $parsed = [DateTime]::MinValue
  if ([DateTime]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
    return $parsed
  }
  return $null
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

function Test-NetworkFailure {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bEOF\b|handshake|schannel|Could not resolve host|Failed to connect|connection (was )?(reset|refused|closed)|i/o timeout|TLS|unable to access|error connecting to|no such host')
}

# Runs gh from the lane state directory (outside any git checkout) with transient network retries.
function Invoke-Gh {
  param([string]$Arguments)
  $out = Join-Path $script:StateDir '.gh.out.tmp'
  $err = Join-Path $script:StateDir '.gh.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GhPath $Arguments $out $err $script:StateDir
    $result = [pscustomobject]@{
      exitCode = $code
      text = (Read-Text $out)
      error = (Read-Text $err)
    }
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure ([string]$result.error))) {
      return $result
    }
    Write-Log ('gh network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine ([string]$result.error) 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Invoke-Git {
  param([string]$Arguments)
  $out = Join-Path $script:StateDir '.git.out.tmp'
  $err = Join-Path $script:StateDir '.git.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GitPath $Arguments $out $err $script:StateDir
    $result = [pscustomobject]@{
      exitCode = $code
      text = (Read-Text $out)
      error = (Read-Text $err)
    }
    $combined = [string]$result.error + "`n" + [string]$result.text
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $combined)) {
      return $result
    }
    Write-Log ('git network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine $combined 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Stop-TreeProcesses {
  param([string]$RootPath)
  if ([string]::IsNullOrWhiteSpace($RootPath)) { return }
  $trimmed = $RootPath.TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($trimmed)) { return }
  $prefixBack = $trimmed + '\'
  $trimmedSlash = $trimmed.Replace('\', '/')
  $cmdPattern = '(?i)(?:' + [regex]::Escape($trimmed) + '|' + [regex]::Escape($trimmedSlash) + ')(?=[\\/"''\s]|$)'
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
      if ($null -ne $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($prefixBack, [StringComparison]::OrdinalIgnoreCase)) {
        $exeHit = $true
      }
      $cmdHit = $false
      if ($null -ne $proc.CommandLine -and ($proc.CommandLine -match $cmdPattern)) {
        $cmdHit = $true
      }
      if ($exeHit -or $cmdHit) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}

function Test-AuthQuotaErrorText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bauth(?:entication|enticate|enticated)?\b|\blogin\b|log\s+in|logged\s+in|UNAUTHENTICATED|PERMISSION_DENIED|quota|RESOURCE_EXHAUSTED|\b429\b|usage limit|exhausted your capacity|rate limit exceeded|too many requests')
}

function Test-RegionNetworkErrorText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)location is not supported|FAILED_PRECONDITION|UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|socket hang up|schannel|(?<![A-Za-z])TLS(?![A-Za-z])|network|\b(?:502|503|504)\b')
}

function Test-CooldownErrorText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)FAILED_PRECONDITION|location is not supported|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|socket hang up|schannel|UNAUTHENTICATED|PERMISSION_DENIED|not logged in|not authenticated|RESOURCE_EXHAUSTED|quota exceeded|out of quota|usage limit|exhausted your capacity|rate limit exceeded|too many requests')
}

function Format-CooldownDuration {
  param([int]$Minutes)
  if ($Minutes -gt 0 -and ($Minutes % 60) -eq 0) {
    return ([string]([int]($Minutes / 60)) + 'h')
  }
  return ([string]$Minutes + 'm')
}

function Get-CooldownClassification {
  param(
    [AllowEmptyString()][string]$Text,
    [AllowEmptyString()][string]$CodeKind = '',
    [bool]$AgyRetryable = $false
  )
  if (Test-AuthQuotaErrorText $Text) {
    $mins = $CooldownHours * 60
    return [pscustomobject]@{
      cooldownClass = 'auth-quota'
      cooldownMinutes = $mins
      durationLabel = (Format-CooldownDuration $mins)
    }
  }
  $isHttpRetryable = ($AgyRetryable -and (-not [string]::IsNullOrWhiteSpace($CodeKind)) -and $CodeKind.Equals('http', [StringComparison]::OrdinalIgnoreCase))
  if ($isHttpRetryable -or (Test-RegionNetworkErrorText $Text)) {
    return [pscustomobject]@{
      cooldownClass = 'network'
      cooldownMinutes = $ShortCooldownMinutes
      durationLabel = (Format-CooldownDuration $ShortCooldownMinutes)
    }
  }
  return [pscustomobject]@{
    cooldownClass = 'unknown'
    cooldownMinutes = $ShortCooldownMinutes
    durationLabel = (Format-CooldownDuration $ShortCooldownMinutes)
  }
}

function Parse-DateTimeOffset {
  param([AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse(
      $Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsed)) {
    return $parsed
  }
  return $null
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
    $isCooldown = Test-CooldownErrorText $fallbackMsg
    return [pscustomobject]@{
      message = $fallbackMsg
      errorCode = ''
      codeKind = ''
      retryable = (-not $isCooldown)
    }
  }

  $shortErr = ConvertTo-SingleLine ([string](Get-JsonProp $parsed 'short_error')) 260
  $errCode = ConvertTo-SingleLine ([string](Get-JsonProp $parsed 'error_code')) 80
  $codeKind = ConvertTo-SingleLine ([string](Get-JsonProp $parsed 'code_kind')) 40
  $retryProp = Get-JsonProp $parsed 'retryable'
  $retryable = $true
  if ($null -ne $retryProp) {
    $retryable = [bool]$retryProp
  } elseif (Test-CooldownErrorText ($errCode + ' ' + $shortErr)) {
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
    codeKind = $codeKind
    retryable = $retryable
  }
}

function Get-ActiveCooldown {
  param([string]$HealthPath)
  if (-not (Test-Path -LiteralPath $HealthPath -PathType Leaf)) { return $null }
  $data = Read-JsonFile $HealthPath
  if ($null -eq $data -or $data -isnot [pscustomobject]) { return $null }
  $statusVal = [string](Get-JsonProp $data 'status')
  if ($statusVal -ne 'unavailable') { return $null }
  $retryVal = Get-JsonProp $data 'retryable'
  if ($null -ne $retryVal -and [bool]$retryVal) { return $null }

  $nowUtc = [DateTimeOffset]::UtcNow
  $until = Parse-DateTimeOffset ([string](Get-JsonProp $data 'cooldownUntil'))
  if ($null -ne $until -and $nowUtc -ge $until) { return $null }

  $setAt = Parse-DateTimeOffset ([string](Get-JsonProp $data 'setAtUtc'))
  $recordedRaw = [string](Get-JsonProp $data 'recordedAt')
  if ($null -eq $setAt) {
    $setAt = Parse-DateTimeOffset $recordedRaw
  }
  if ($null -eq $setAt -and $null -ne $until) {
    $setAt = $until.AddHours(-$CooldownHours)
  }

  $storedError = ConvertTo-SingleLine ([string](Get-JsonProp $data 'error')) 300
  $storedCode = ConvertTo-SingleLine ([string](Get-JsonProp $data 'errorCode')) 80
  $storedClass = ([string](Get-JsonProp $data 'cooldownClass')).Trim().ToLowerInvariant()
  $reasonForClass = ($storedCode + ' ' + $storedError).Trim()
  if ([string]::IsNullOrWhiteSpace($storedClass) -and
      $storedCode.Equals('AUTH_OR_QUOTA', [StringComparison]::OrdinalIgnoreCase) -and
      (-not [string]::IsNullOrWhiteSpace($storedError))) {
    $reasonForClass = $storedError
  }
  $classified = Get-CooldownClassification -Text $reasonForClass

  $effectiveClass = $classified.cooldownClass
  if ($effectiveClass -eq 'unknown') {
    if ($storedClass -eq 'network' -or $storedClass -eq 'auth-quota' -or $storedClass -eq 'unknown') {
      $effectiveClass = $storedClass
    }
  }

  $effectiveMinutes = $ShortCooldownMinutes
  if ($effectiveClass -eq 'auth-quota') {
    $effectiveMinutes = $CooldownHours * 60
  }
  $rawMinutes = Get-JsonProp $data 'cooldownMinutes'
  if ($null -ne $rawMinutes) {
    $parsedMins = 0
    try { $parsedMins = [int]$rawMinutes } catch { $parsedMins = 0 }
    if ($parsedMins -gt 0) {
      $effectiveMinutes = $parsedMins
    }
  }

  if ($null -eq $until) {
    if ($null -eq $setAt) { return $null }
    $until = $setAt.AddMinutes($effectiveMinutes)
  }

  if ($effectiveClass -eq 'network' -and $null -ne $setAt) {
    $shortUntil = $setAt.AddMinutes($ShortCooldownMinutes)
    if ($shortUntil -lt $until) {
      $oldUntilStr = $until.UtcDateTime.ToString('o')
      $until = $shortUntil
      $newUntilStr = $until.UtcDateTime.ToString('o')
      $effectiveMinutes = $ShortCooldownMinutes
      $persistRecorded = $recordedRaw
      if ([string]::IsNullOrWhiteSpace($persistRecorded)) {
        $persistRecorded = $setAt.UtcDateTime.ToString('o')
      }
      $storedModel = [string](Get-JsonProp $data 'model')
      if ([string]::IsNullOrWhiteSpace($storedModel)) {
        $storedModel = $Model
      }
      $updatedPayload = [ordered]@{
        status = 'unavailable'
        retryable = $false
        error = $storedError
        errorCode = $storedCode
        cooldownClass = 'network'
        cooldownMinutes = $ShortCooldownMinutes
        recordedAt = $persistRecorded
        setAtUtc = $setAt.UtcDateTime.ToString('o')
        cooldownUntil = $newUntilStr
        model = $storedModel
      }
      try {
        Save-JsonAtomic -Path $HealthPath -Object $updatedPayload
      } catch {
        Write-Log ('failed to update shortened cooldown in health.json: ' + $_.Exception.Message)
      }
      Write-Log ('re-evaluated agy cooldown (network, ' + (Format-CooldownDuration $ShortCooldownMinutes) + ') until ' + $newUntilStr + ' (was ' + $oldUntilStr + ')')
    }
  }

  if ($nowUtc -ge $until) { return $null }

  if ([string]::IsNullOrWhiteSpace($storedError)) {
    $storedError = 'agy unavailable (cooldown active until ' + $until.UtcDateTime.ToString('o') + ')'
  }
  return [pscustomobject]@{
    error = $storedError
    cooldownUntil = $until.UtcDateTime.ToString('o')
    cooldownClass = $effectiveClass
    cooldownMinutes = $effectiveMinutes
    durationLabel = (Format-CooldownDuration $effectiveMinutes)
  }
}

function Write-HealthCooldown {
  param(
    [string]$HealthPath,
    [string]$ErrorText,
    [string]$ErrorCode,
    [string]$ModelName,
    [string]$CodeKind = '',
    [bool]$AgyRetryable = $false
  )
  $combined = ($ErrorCode + ' ' + $ErrorText).Trim()
  $classified = Get-CooldownClassification -Text $combined -CodeKind $CodeKind -AgyRetryable $AgyRetryable
  $resolvedCode = $ErrorCode
  if ([string]::IsNullOrWhiteSpace($resolvedCode)) {
    if ($classified.cooldownClass -eq 'auth-quota') {
      $resolvedCode = 'AUTH_OR_QUOTA'
    } elseif ($classified.cooldownClass -eq 'network') {
      $resolvedCode = 'NETWORK_OR_REGION'
    }
  }
  $nowUtc = [DateTimeOffset]::UtcNow
  $untilUtc = $nowUtc.AddMinutes($classified.cooldownMinutes)
  $nowIso = $nowUtc.UtcDateTime.ToString('o')
  $untilIso = $untilUtc.UtcDateTime.ToString('o')
  $payload = [ordered]@{
    status = 'unavailable'
    retryable = $false
    error = (ConvertTo-SingleLine $ErrorText 300)
    errorCode = $resolvedCode
    cooldownClass = $classified.cooldownClass
    cooldownMinutes = $classified.cooldownMinutes
    recordedAt = $nowIso
    setAtUtc = $nowIso
    cooldownUntil = $untilIso
    model = $ModelName
  }
  try {
    Save-JsonAtomic -Path $HealthPath -Object $payload
  } catch {
    Write-Log ('failed to write health.json: ' + $_.Exception.Message)
  }
  return [pscustomobject]@{
    cooldownClass = $classified.cooldownClass
    cooldownMinutes = $classified.cooldownMinutes
    durationLabel = $classified.durationLabel
    setAtUtc = $nowIso
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
  # health.json is shared by all lanes: one lane's successful session must not cancel a cooldown
  # another lane has just recorded (quota or auth), so an unexpired cooldown is left in place.
  try {
    $current = Get-Content -LiteralPath $HealthPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $activeUntil = Parse-DateTimeOffset ([string](Get-JsonProp $current 'cooldownUntil'))
    if ($null -ne $activeUntil -and $activeUntil -gt $nowUtc) {
      Write-Log ('session ok, but keeping the shared agy cooldown until ' + $activeUntil.UtcDateTime.ToString('o'))
      return
    }
  } catch { }
  $payload = [ordered]@{
    status = 'ok'
    retryable = $true
    error = ''
    errorCode = ''
    cooldownClass = ''
    cooldownMinutes = 0
    recordedAt = $nowUtc.UtcDateTime.ToString('o')
    setAtUtc = ''
    cooldownUntil = ''
    model = $ModelName
  }
  try {
    Save-JsonAtomic -Path $HealthPath -Object $payload
  } catch {
    Write-Log ('failed to clear health.json: ' + $_.Exception.Message)
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

function Read-WorkerState {
  param([string]$Path = '')
  $targetPath = $Path
  if ([string]::IsNullOrWhiteSpace($targetPath)) {
    $targetPath = $script:WorkerStatePath
  }
  $state = [ordered]@{
    activeSession = $null
  }
  $data = Read-JsonFile $targetPath
  if ($null -eq $data) { return $state }
  $sess = Get-JsonProp $data 'activeSession'
  if ($null -ne $sess) {
    $pidVal = 0
    $rawPid = Get-JsonProp $sess 'pid'
    if ($null -ne $rawPid) { $pidVal = [int]$rawPid }
    $issueVal = 0
    $rawIssue = Get-JsonProp $sess 'issue'
    if ($null -ne $rawIssue) { $issueVal = [int]$rawIssue }
    $prVal = 0
    $rawPr = Get-JsonProp $sess 'pr'
    if ($null -ne $rawPr) { $prVal = [int]$rawPr }
    $finalizedVal = $false
    $rawFin = Get-JsonProp $sess 'finalized'
    if ($null -ne $rawFin) { $finalizedVal = [bool]$rawFin }
    $state['activeSession'] = [ordered]@{
      pid = $pidVal
      processStartUtc = [string](Get-JsonProp $sess 'processStartUtc')
      startedAtUtc = [string](Get-JsonProp $sess 'startedAtUtc')
      endedAtUtc = [string](Get-JsonProp $sess 'endedAtUtc')
      endReason = [string](Get-JsonProp $sess 'endReason')
      kind = [string](Get-JsonProp $sess 'kind')
      issue = $issueVal
      pr = $prVal
      headSha = [string](Get-JsonProp $sess 'headSha')
      outLog = [string](Get-JsonProp $sess 'outLog')
      errLog = [string](Get-JsonProp $sess 'errLog')
      agyLog = [string](Get-JsonProp $sess 'agyLog')
      finalized = $finalizedVal
    }
  }
  return $state
}

function Get-LiveTrackedProcess {
  param(
    [int]$ProcessId,
    [string]$ExpectedStartUtc
  )
  if ($ProcessId -le 0) { return $null }
  $proc = $null
  try {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
  } catch {
    return $null
  }
  if ($null -eq $proc) { return $null }
  try {
    if ($proc.HasExited) { return $null }
  } catch { }
  $expectedDt = Parse-UtcTimestamp $ExpectedStartUtc
  if ($null -ne $expectedDt) {
    try {
      $actualDt = $proc.StartTime.ToUniversalTime()
      $diffSec = [Math]::Abs(($actualDt - $expectedDt).TotalSeconds)
      if ($diffSec -gt 5.0) { return $null }
    } catch {
      if ($proc.ProcessName -notmatch '(?i)^agy') { return $null }
    }
  } else {
    if ($proc.ProcessName -notmatch '(?i)^agy') { return $null }
  }
  return $proc
}

function Inspect-SessionLogsForCooldown {
  param($Session)
  if ($null -eq $Session) { return $false }
  $errPath = [string]$Session['errLog']
  $outPath = [string]$Session['outLog']
  $errText = ''
  if (-not [string]::IsNullOrWhiteSpace($errPath)) {
    $rawErr = Read-Text $errPath
    if ($null -ne $rawErr) { $errText = $rawErr }
  }
  $outText = ''
  if (-not [string]::IsNullOrWhiteSpace($outPath)) {
    $rawOut = Read-Text $outPath
    if ($null -ne $rawOut) { $outText = $rawOut }
  }

  $agyErr = Parse-AgyError -StderrText $errText -StdoutText $outText
  if ($null -ne $agyErr -and ([string]$agyErr.message) -match '(?i)\bprint timeout\b' -and -not (Test-AuthQuotaErrorText ([string]$agyErr.message)) -and -not (Test-RegionNetworkErrorText ([string]$agyErr.message))) {
    # The session hit its own wall-clock limit; that says nothing about the shared agy service,
    # so it must not put every lane into a cooldown. The lane continues the issue next tick.
    Write-Log ('previous session ended by its print timeout (session-local, no shared cooldown): ' + (ConvertTo-SingleLine ([string]$agyErr.message) 200))
    return $false
  }
  if ($null -ne $agyErr) {
    $combined = $agyErr.errorCode + ' ' + $agyErr.message
    $isHttpRetryable = ([bool]$agyErr.retryable -and (-not [string]::IsNullOrWhiteSpace($agyErr.codeKind)) -and $agyErr.codeKind.Equals('http', [StringComparison]::OrdinalIgnoreCase))
    if ((-not [bool]$agyErr.retryable) -or $isHttpRetryable -or (Test-CooldownErrorText $combined) -or (Test-AuthQuotaErrorText $combined) -or (Test-RegionNetworkErrorText $combined)) {
      $cd = Write-HealthCooldown -HealthPath $script:HealthPath -ErrorText $agyErr.message -ErrorCode $agyErr.errorCode -ModelName $Model -CodeKind $agyErr.codeKind -AgyRetryable ([bool]$agyErr.retryable)
      Write-Log ('previous session hit agy error; agy cooldown (' + $cd.cooldownClass + ', ' + $cd.durationLabel + ') until ' + $cd.cooldownUntil + ': ' + $agyErr.message)
      return $true
    }
  }

  if ((Test-CooldownErrorText $errText) -or (Test-AuthQuotaErrorText $errText) -or (Test-RegionNetworkErrorText $errText)) {
    $summary = ConvertTo-SingleLine $errText 260
    $cd = Write-HealthCooldown -HealthPath $script:HealthPath -ErrorText $summary -ErrorCode '' -ModelName $Model
    Write-Log ('previous session stderr hit cooldown error; agy cooldown (' + $cd.cooldownClass + ', ' + $cd.durationLabel + ') until ' + $cd.cooldownUntil + ': ' + $summary)
    return $true
  }

  if ([string]::IsNullOrWhiteSpace($errText) -and -not [string]::IsNullOrWhiteSpace($outText) -and $outText.Length -le 4096) {
    if ((Test-CooldownErrorText $outText) -or (Test-AuthQuotaErrorText $outText) -or (Test-RegionNetworkErrorText $outText)) {
      $summary = ConvertTo-SingleLine $outText 260
      $cd = Write-HealthCooldown -HealthPath $script:HealthPath -ErrorText $summary -ErrorCode '' -ModelName $Model
      Write-Log ('previous session short stdout hit cooldown error; agy cooldown (' + $cd.cooldownClass + ', ' + $cd.durationLabel + ') until ' + $cd.cooldownUntil + ': ' + $summary)
      return $true
    }
  }

  Write-HealthOk -HealthPath $script:HealthPath -ModelName $Model
  return $false
}

function Read-ProgressParkedFromFile {
  param(
    [string]$Path,
    [hashtable]$ParkedPrs,
    [hashtable]$ParkedIssues
  )
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $data = Read-JsonFile $Path
  if ($null -eq $data) { return }
  $rawParked = Get-JsonProp $data 'parked'
  if ($null -eq $rawParked) { return }
  foreach ($entry in @($rawParked)) {
    if ($null -eq $entry) { continue }
    if ($entry -is [int] -or $entry -is [long]) {
      $num = [int]$entry
      if ($num -gt 0) { $ParkedIssues[$num] = $true }
      continue
    }
    $pi = 0
    $rawIssue = Get-JsonProp $entry 'issue'
    if ($null -ne $rawIssue) {
      try { $pi = [int]$rawIssue } catch { $pi = 0 }
    }
    $pp = 0
    $rawPr = Get-JsonProp $entry 'pr'
    if ($null -ne $rawPr) {
      try { $pp = [int]$rawPr } catch { $pp = 0 }
    }
    $psha = ''
    $rawSha = Get-JsonProp $entry 'headSha'
    if ($null -ne $rawSha) { $psha = ([string]$rawSha).Trim() }
    if ($pi -gt 0) { $ParkedIssues[$pi] = $true }
    if ($pp -gt 0) {
      if (-not $ParkedPrs.ContainsKey($pp)) {
        $ParkedPrs[$pp] = New-Object Collections.Generic.List[string]
      }
      $null = $ParkedPrs[$pp].Add($psha)
    }
  }
}

function Read-AllLanesProgressParked {
  $parkedPrs = @{}
  $parkedIssues = @{}
  $seenPaths = @{}
  if (-not [string]::IsNullOrWhiteSpace($script:ProgressPath)) {
    $seenPaths[$script:ProgressPath.ToLowerInvariant()] = $true
    Read-ProgressParkedFromFile -Path $script:ProgressPath -ParkedPrs $parkedPrs -ParkedIssues $parkedIssues
  }
  if (-not [string]::IsNullOrWhiteSpace($script:SharedStateDir)) {
    $legacyProgress = Join-Path $script:SharedStateDir 'progress-hydrogen.json'
    $legacyKey = $legacyProgress.ToLowerInvariant()
    if (-not $seenPaths.ContainsKey($legacyKey)) {
      $seenPaths[$legacyKey] = $true
      Read-ProgressParkedFromFile -Path $legacyProgress -ParkedPrs $parkedPrs -ParkedIssues $parkedIssues
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($script:LanesRootPath) -and (Test-Path -LiteralPath $script:LanesRootPath -PathType Container)) {
    $laneDirs = @(Get-ChildItem -LiteralPath $script:LanesRootPath -Directory -ErrorAction SilentlyContinue)
    foreach ($dir in $laneDirs) {
      $candidate = Join-Path (Join-Path $dir.FullName 'state') 'progress-hydrogen.json'
      $key = $candidate.ToLowerInvariant()
      if ($seenPaths.ContainsKey($key)) { continue }
      $seenPaths[$key] = $true
      Read-ProgressParkedFromFile -Path $candidate -ParkedPrs $parkedPrs -ParkedIssues $parkedIssues
    }
  }
  return [pscustomobject]@{ prs = $parkedPrs; issues = $parkedIssues }
}

function Get-IssueLockPath {
  param([int]$IssueNumber)
  return (Join-Path $script:ClaimsDir ('issue-' + $IssueNumber + '.lock'))
}

function Read-IssueLock {
  param(
    [string]$Path = '',
    [int]$IssueNumber = 0
  )
  $lockPath = $Path
  if ([string]::IsNullOrWhiteSpace($lockPath)) {
    if ($IssueNumber -le 0) { return $null }
    $lockPath = Get-IssueLockPath -IssueNumber $IssueNumber
  }
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  $text = $null
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      $text = [IO.File]::ReadAllText($lockPath, [Text.Encoding]::UTF8)
      break
    } catch [IO.FileNotFoundException] {
      return $null
    } catch [IO.DirectoryNotFoundException] {
      return $null
    } catch [IO.IOException] {
      if ($attempt -lt 4) { Start-Sleep -Milliseconds 50 }
    }
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    return [pscustomobject]@{
      path = $lockPath
      valid = $false
      laneId = ''
      issue = $IssueNumber
      pr = 0
      claimedAtUtc = ''
      lastActiveUtc = ''
      workerPid = 0
    }
  }
  try {
    $obj = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
    $laneVal = ([string](Get-JsonProp $obj 'laneId')).Trim()
    $issVal = 0
    $rawIss = Get-JsonProp $obj 'issue'
    if ($null -ne $rawIss) { try { $issVal = [int]$rawIss } catch { $issVal = 0 } }
    $prVal = 0
    $rawPr = Get-JsonProp $obj 'pr'
    if ($null -ne $rawPr) { try { $prVal = [int]$rawPr } catch { $prVal = 0 } }
    $wpidVal = 0
    $rawWpid = Get-JsonProp $obj 'workerPid'
    if ($null -ne $rawWpid) { try { $wpidVal = [int]$rawWpid } catch { $wpidVal = 0 } }
    return [pscustomobject]@{
      path = $lockPath
      valid = (-not [string]::IsNullOrWhiteSpace($laneVal))
      laneId = $laneVal
      issue = $issVal
      pr = $prVal
      claimedAtUtc = ([string](Get-JsonProp $obj 'claimedAtUtc')).Trim()
      lastActiveUtc = ([string](Get-JsonProp $obj 'lastActiveUtc')).Trim()
      workerPid = $wpidVal
    }
  } catch {
    return [pscustomobject]@{
      path = $lockPath
      valid = $false
      laneId = ''
      issue = $IssueNumber
      pr = 0
      claimedAtUtc = ''
      lastActiveUtc = ''
      workerPid = 0
    }
  }
}

function Test-LockOwnedByLane {
  param(
    $Lock,
    [string]$LaneId
  )
  if ($null -eq $Lock -or (-not [bool]$Lock.valid)) { return $false }
  if ([string]::IsNullOrWhiteSpace($Lock.laneId) -or [string]::IsNullOrWhiteSpace($LaneId)) { return $false }
  if ($Lock.laneId.Equals('cloud', [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return $Lock.laneId.Equals($LaneId, [StringComparison]::OrdinalIgnoreCase)
}

function Try-AcquireIssueLock {
  param(
    [int]$IssueNumber,
    [int]$PrNumber = 0
  )
  if ($IssueNumber -le 0) { return $false }
  $lockPath = Get-IssueLockPath -IssueNumber $IssueNumber
  $nowIso = [DateTime]::UtcNow.ToString('o')
  $payload = [ordered]@{
    laneId = $script:LaneId
    issue = [int]$IssueNumber
    pr = [int]$PrNumber
    claimedAtUtc = $nowIso
    lastActiveUtc = $nowIso
    workerPid = [int]$PID
  }
  $jsonText = (ConvertTo-Json -InputObject $payload -Depth 4) + "`n"
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($jsonText)
  $fs = $null
  $created = $false
  try {
    $fs = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
    return $true
  } catch [IO.IOException] {
    if ($created) {
      if ($null -ne $fs) {
        try { $fs.Dispose() } catch { }
        $fs = $null
      }
      try { [IO.File]::Delete($lockPath) } catch { }
    }
    return $false
  } finally {
    if ($null -ne $fs) {
      try { $fs.Dispose() } catch { }
    }
  }
}

function Update-IssueLock {
  param(
    [int]$IssueNumber,
    [int]$PrNumber = 0,
    [int]$WorkerPid = 0,
    [bool]$TouchLastActive = $true
  )
  if ($IssueNumber -le 0) { return $false }
  $lockPath = Get-IssueLockPath -IssueNumber $IssueNumber
  $existing = Read-IssueLock -Path $lockPath
  if (-not (Test-LockOwnedByLane -Lock $existing -LaneId $script:LaneId)) { return $false }
  $nowIso = [DateTime]::UtcNow.ToString('o')
  $claimedAt = $existing.claimedAtUtc
  if ([string]::IsNullOrWhiteSpace($claimedAt)) { $claimedAt = $nowIso }
  $lastActive = $existing.lastActiveUtc
  if ($TouchLastActive -or [string]::IsNullOrWhiteSpace($lastActive)) { $lastActive = $nowIso }
  $resolvedPr = $existing.pr
  if ($PrNumber -gt 0) { $resolvedPr = $PrNumber }
  $resolvedPid = $existing.workerPid
  if ($WorkerPid -gt 0) { $resolvedPid = $WorkerPid }
  $payload = [ordered]@{
    laneId = $script:LaneId
    issue = [int]$IssueNumber
    pr = [int]$resolvedPr
    claimedAtUtc = $claimedAt
    lastActiveUtc = $lastActive
    workerPid = [int]$resolvedPid
  }
  try {
    Save-JsonAtomic -Path $lockPath -Object $payload
    return $true
  } catch {
    Write-Log ('failed to update claim lock for issue #' + $IssueNumber + ': ' + $_.Exception.Message)
    return $false
  }
}

function Remove-IssueLock {
  param(
    [int]$IssueNumber,
    [switch]$RequireOwned
  )
  if ($IssueNumber -le 0) { return }
  $lockPath = Get-IssueLockPath -IssueNumber $IssueNumber
  if ($RequireOwned) {
    $existing = Read-IssueLock -Path $lockPath
    if (-not (Test-LockOwnedByLane -Lock $existing -LaneId $script:LaneId)) { return }
  }
  try {
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
      [IO.File]::Delete($lockPath)
    }
  } catch { }
}

function Remove-LockIfUnchanged {
  param(
    [string]$Path,
    [string]$ExpectedLaneId,
    [string]$ExpectedClaimedAt,
    [string]$ExpectedLastActive
  )
  $cur = Read-IssueLock -Path $Path
  if ($null -eq $cur) { return $false }
  if ([bool]$cur.valid) {
    if (-not $cur.laneId.Equals($ExpectedLaneId, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($cur.claimedAtUtc -ne $ExpectedClaimedAt -or $cur.lastActiveUtc -ne $ExpectedLastActive) { return $false }
  }
  try {
    [IO.File]::Delete($Path)
    return $true
  } catch {
    return $false
  }
}

function Test-LaneHasLiveProcessForIssue {
  param(
    [string]$OwnerLaneId,
    [int]$IssueNumber,
    [int]$PrNumber = 0
  )
  if ([string]::IsNullOrWhiteSpace($OwnerLaneId) -or $OwnerLaneId -notmatch '^[a-z0-9][a-z0-9_-]{0,15}$') {
    return $false
  }
  $ownerWorkerPath = Join-Path (Join-Path (Join-Path $script:LanesRootPath $OwnerLaneId) 'state') 'worker.json'
  if (-not (Test-Path -LiteralPath $ownerWorkerPath -PathType Leaf)) { return $false }
  $ownerState = Read-WorkerState -Path $ownerWorkerPath
  $sess = $ownerState['activeSession']
  if ($null -eq $sess -or [bool]$sess['finalized']) { return $false }
  $sessIssue = [int]$sess['issue']
  $sessPr = [int]$sess['pr']
  $matchesTarget = ($IssueNumber -gt 0 -and $sessIssue -eq $IssueNumber) -or ($PrNumber -gt 0 -and $sessPr -eq $PrNumber)
  if (-not $matchesTarget) { return $false }
  $live = Get-LiveTrackedProcess -ProcessId ([int]$sess['pid']) -ExpectedStartUtc ([string]$sess['processStartUtc'])
  return ($null -ne $live)
}

function Sweep-ClaimLocks {
  param(
    [hashtable]$OpenIssueLabelsByNum,
    [hashtable]$HydrogenPrsByIssue,
    [hashtable]$HydrogenPrsByNumber
  )
  if (-not (Test-Path -LiteralPath $script:ClaimsDir -PathType Container)) { return }
  $lockFiles = @(Get-ChildItem -LiteralPath $script:ClaimsDir -File -Filter 'issue-*.lock' -ErrorAction SilentlyContinue)
  foreach ($file in $lockFiles) {
    $nameMatch = [regex]::Match($file.Name, '^issue-([0-9]+)\.lock$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $nameMatch.Success) { continue }
    $fileIssue = [int]$nameMatch.Groups[1].Value
    if ($fileIssue -le 0) { continue }

    $lock = Read-IssueLock -Path $file.FullName
    if ($null -eq $lock) { continue }

    if (-not [bool]$lock.valid) {
      $corruptAgeHours = ([DateTime]::UtcNow - $file.LastWriteTimeUtc).TotalHours
      if ($corruptAgeHours -gt 4.0) {
        try {
          [IO.File]::Delete($file.FullName)
          Write-Log ('swept corrupt claim lock ' + $file.Name + ' (age ' + [Math]::Round($corruptAgeHours, 1) + 'h)')
        } catch { }
      }
      continue
    }

    $lockIssue = $fileIssue
    if ($lock.issue -gt 0) { $lockIssue = [int]$lock.issue }
    $ownerLane = [string]$lock.laneId

    if ($ownerLane.Equals('cloud', [StringComparison]::OrdinalIgnoreCase)) {
      $cloudLastActiveDt = Parse-UtcTimestamp $lock.lastActiveUtc
      if ($null -eq $cloudLastActiveDt) { $cloudLastActiveDt = Parse-UtcTimestamp $lock.claimedAtUtc }
      if ($null -eq $cloudLastActiveDt) { $cloudLastActiveDt = $file.LastWriteTimeUtc }
      $cloudAgeHours = ([DateTime]::UtcNow - $cloudLastActiveDt).TotalHours
      if ($cloudAgeHours -le 4.0) { continue }
      if (Remove-LockIfUnchanged -Path $file.FullName -ExpectedLaneId $ownerLane -ExpectedClaimedAt $lock.claimedAtUtc -ExpectedLastActive $lock.lastActiveUtc) {
        Write-Log ('swept stale cloud claim lock for issue #' + $lockIssue + ' (lastActive ' + [Math]::Round($cloudAgeHours, 1) + 'h ago)')
      }
      continue
    }

    $issuePrs = @()
    if ($HydrogenPrsByIssue.ContainsKey($lockIssue)) {
      $issuePrs = @($HydrogenPrsByIssue[$lockIssue].ToArray())
    }

    $hasOpenIssueBranchPr = $false
    foreach ($p in $issuePrs) {
      if ([bool]$p.matchesIssueBranch) {
        $hasOpenIssueBranchPr = $true
        break
      }
    }

    if (-not $hasOpenIssueBranchPr -and (-not $OpenIssueLabelsByNum.ContainsKey($lockIssue))) {
      $viewRes = Invoke-Gh ('issue view ' + $lockIssue + ' -R ' + $Repo + ' --json state')
      if ($viewRes.exitCode -eq 0 -and (-not [string]::IsNullOrWhiteSpace([string]$viewRes.text))) {
        try {
          $viewObj = $viewRes.text | ConvertFrom-Json
          $issState = ([string](Get-JsonProp $viewObj 'state')).Trim()
          if ($issState.Equals('CLOSED', [StringComparison]::OrdinalIgnoreCase)) {
            if (Remove-LockIfUnchanged -Path $file.FullName -ExpectedLaneId $ownerLane -ExpectedClaimedAt $lock.claimedAtUtc -ExpectedLastActive $lock.lastActiveUtc) {
              Write-Log ('swept claim lock for closed issue #' + $lockIssue + ' (owner ' + $ownerLane + ')')
            }
            continue
          }
        } catch { }
      }
    }

    $lastActiveDt = Parse-UtcTimestamp $lock.lastActiveUtc
    if ($null -eq $lastActiveDt) { $lastActiveDt = Parse-UtcTimestamp $lock.claimedAtUtc }
    if ($null -eq $lastActiveDt) { $lastActiveDt = $file.LastWriteTimeUtc }
    $ageHours = ([DateTime]::UtcNow - $lastActiveDt).TotalHours
    if ($ageHours -le 4.0) { continue }

    $hasOpenNonParkedPr = $false
    foreach ($p in $issuePrs) {
      if (-not [bool]$p.isParked) {
        $hasOpenNonParkedPr = $true
        break
      }
    }
    if (-not $hasOpenNonParkedPr -and $lock.pr -gt 0 -and $HydrogenPrsByNumber.ContainsKey($lock.pr)) {
      if (-not [bool]$HydrogenPrsByNumber[$lock.pr].isParked) {
        $hasOpenNonParkedPr = $true
      }
    }
    if ($hasOpenNonParkedPr) { continue }

    if (Test-LaneHasLiveProcessForIssue -OwnerLaneId $ownerLane -IssueNumber $lockIssue -PrNumber $lock.pr) {
      continue
    }

    if (Remove-LockIfUnchanged -Path $file.FullName -ExpectedLaneId $ownerLane -ExpectedClaimedAt $lock.claimedAtUtc -ExpectedLastActive $lock.lastActiveUtc) {
      Write-Log ('swept stale claim lock for issue #' + $lockIssue + ' (owner ' + $ownerLane + ', lastActive ' + [Math]::Round($ageHours, 1) + 'h ago)')
    }
  }
}

function Get-LatestPrGateSummary {
  param([int]$PrNumber)
  if (-not (Test-Path -LiteralPath $script:GateRootPath -PathType Container)) { return $null }
  $prefix = 'pr-' + $PrNumber + '-'
  $dirs = @(Get-ChildItem -LiteralPath $script:GateRootPath -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if ($dirs.Count -eq 0) { return $null }

  $newestDir = @($dirs | Sort-Object `
    @{ Expression = { $_.CreationTimeUtc }; Descending = $true }, `
    @{ Expression = { $_.Name }; Descending = $true })[0]
  if (-not (Test-Path -LiteralPath (Join-Path $newestDir.FullName 'summary.json') -PathType Leaf)) {
    return [pscustomobject]@{
      path = ''
      data = [pscustomobject]@{ verdict = 'pending'; headSha = '' }
    }
  }

  $summaryFiles = New-Object Collections.Generic.List[object]
  foreach ($dir in $dirs) {
    $candidate = Join-Path $dir.FullName 'summary.json'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $item = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
      if ($null -ne $item) { $null = $summaryFiles.Add($item) }
    }
  }
  $arr = @($summaryFiles.ToArray())
  if ($arr.Count -eq 0) { return $null }

  $ordered = @($arr | Sort-Object `
    @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true }, `
    @{ Expression = { $_.Directory.Name }; Descending = $true })
  $newest = $ordered[0]
  $data = Read-JsonFile $newest.FullName
  return [pscustomobject]@{
    path = $newest.FullName
    data = $data
  }
}

function Test-GateTaskRunning {
  param([int]$PrNumber)
  try {
    $prefix = 'gate-pr-' + $PrNumber + '-'
    $tasks = @(Get-ScheduledTask -TaskPath '\TivanoDevLoop\' -ErrorAction SilentlyContinue |
      Where-Object { $_.TaskName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $_.State -eq 'Running' })
    return ($tasks.Count -gt 0)
  } catch {
    return $false
  }
}

function Get-AuditCommitStatus {
  param([string]$HeadSha)
  if ([string]::IsNullOrWhiteSpace($HeadSha)) { return '' }
  $statusRes = Invoke-Gh ('api repos/' + $Repo + '/commits/' + $HeadSha + '/status')
  if ($statusRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$statusRes.text)) {
    Write-Log ('commit status query failed for ' + $HeadSha + ': ' + (Get-ErrorSummary $statusRes))
    return ''
  }
  $statusObj = $null
  try {
    $statusObj = $statusRes.text | ConvertFrom-Json
  } catch {
    Write-Log ('could not parse commit status JSON for ' + $HeadSha + ': ' + $_.Exception.Message)
    return ''
  }
  $statusesRaw = Get-JsonProp $statusObj 'statuses'
  if ($null -eq $statusesRaw) { return '' }
  foreach ($st in @($statusesRaw)) {
    if ($null -eq $st) { continue }
    if ([string](Get-JsonProp $st 'context') -ceq 'nyx/audit') {
      return ([string](Get-JsonProp $st 'state')).Trim().ToLowerInvariant()
    }
  }
  return ''
}

function Get-TodayMergedNyxPrCount {
  $today = [DateTime]::Now.ToString('yyyy-MM-dd')
  $sinceDate = [DateTime]::UtcNow.AddDays(-2).ToString('yyyy-MM-dd')
  $res = Invoke-Gh ('pr list -R ' + $Repo + ' --state merged --search ' + (Quote-Argument ('merged:>=' + $sinceDate)) + ' --limit 500 --json number,headRefName,mergedAt')
  if ($res.exitCode -ne 0) {
    Write-Log ('gh pr list --state merged failed: ' + (Get-ErrorSummary $res))
    return $null
  }
  if ([string]::IsNullOrWhiteSpace([string]$res.text)) { return 0 }
  $items = @()
  try {
    $parsed = $res.text | ConvertFrom-Json
    if ($null -ne $parsed) {
      $items = @($parsed | Where-Object { $null -ne $_ })
    }
  } catch {
    Write-Log ('could not parse merged PR list JSON: ' + $_.Exception.Message)
    return $null
  }
  $count = 0
  foreach ($item in $items) {
    $headRef = [string](Get-JsonProp $item 'headRefName')
    if (-not $headRef.StartsWith('nyx/', [StringComparison]::Ordinal)) { continue }
    if ($headRef.StartsWith('nyx/parity-sync-', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $mergedAt = [string](Get-JsonProp $item 'mergedAt')
    if ([string]::IsNullOrWhiteSpace($mergedAt)) { continue }
    $parsedDto = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($mergedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedDto)) {
      if ($parsedDto.LocalDateTime.ToString('yyyy-MM-dd') -eq $today) {
        $count++
      }
    }
  }
  return $count
}

function Ensure-LaneClone {
  if (Test-Path -LiteralPath (Join-Path $script:RepoPath '.git')) {
    $fetchRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoPath) + ' fetch origin --prune')
    if ($fetchRes.exitCode -ne 0) {
      Write-Log ('git fetch origin --prune failed in lane clone: ' + (Get-ErrorSummary $fetchRes))
      return $false
    }
    return $true
  }

  if (Test-Path -LiteralPath $script:RepoPath -PathType Container) {
    $existing = @(Get-ChildItem -LiteralPath $script:RepoPath -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
      throw ('Lane repo path exists and is not empty or a git clone: ' + $script:RepoPath)
    }
  }

  $cloneUrl = 'https://github.com/' + $Repo + '.git'
  Write-Log ('cloning ' + $cloneUrl + ' into ' + $script:RepoPath)
  $cloneRes = Invoke-Git ('clone ' + (Quote-Argument $cloneUrl) + ' ' + (Quote-Argument $script:RepoPath))
  if ($cloneRes.exitCode -ne 0) {
    Write-Log ('git clone failed: ' + (Get-ErrorSummary $cloneRes))
    return $false
  }
  return $true
}

function Invoke-ClaimIssue {
  param([int]$IssueNumber)
  $editRes = Invoke-Gh ('issue edit ' + $IssueNumber + ' -R ' + $Repo + ' --add-label lane-hydrogen')
  if ($editRes.exitCode -ne 0) {
    $null = Invoke-Gh ('label create lane-hydrogen -R ' + $Repo + ' --color 1D76DB --description ' + (Quote-Argument 'Claimed by Gemini Hydrogen lane'))
    $editRes = Invoke-Gh ('issue edit ' + $IssueNumber + ' -R ' + $Repo + ' --add-label lane-hydrogen')
    if ($editRes.exitCode -ne 0) {
      Write-Log ('failed to label issue #' + $IssueNumber + ' with lane-hydrogen: ' + (Get-ErrorSummary $editRes))
      return $false
    }
  }

  $commentFile = Join-Path $script:StateDir ('claim-' + $IssueNumber + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
  try {
    Write-Text $commentFile ("Claimed for implementation on the Hydrogen lane.`n")
    $commentRes = Invoke-Gh ('issue comment ' + $IssueNumber + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $commentFile))
    if ($commentRes.exitCode -ne 0) {
      Write-Log ('warning: labelled issue #' + $IssueNumber + ' lane-hydrogen but claim comment failed: ' + (Get-ErrorSummary $commentRes))
    }
  } finally {
    Remove-Item -LiteralPath $commentFile -Force -ErrorAction SilentlyContinue
  }
  $recheck = Invoke-Gh ('issue view ' + $IssueNumber + ' -R ' + $Repo + ' --json labels')
  if ($recheck.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($recheck.text)) {
    $nowLabels = @()
    try {
      $recheckObj = $recheck.text | ConvertFrom-Json
      $nowLabels = @(Get-LabelNames (Get-JsonProp $recheckObj 'labels'))
    } catch {
      Write-Log ('warning: could not parse recheck labels JSON for issue #' + $IssueNumber + ': ' + $_.Exception.Message)
      $nowLabels = @()
    }
    if ($nowLabels -contains 'lane-devin' -or $nowLabels -contains 'lane-cloud') {
      $otherLane = if ($nowLabels -contains 'lane-cloud') { 'cloud' } else { 'Devin' }
      $null = Invoke-Gh ('issue edit ' + $IssueNumber + ' -R ' + $Repo + ' --remove-label lane-hydrogen')
      Write-Log ('issue #' + $IssueNumber + ' was claimed by the ' + $otherLane + ' lane at the same time; backed off')
      return $false
    }
  }
  Write-Log ('claimed issue #' + $IssueNumber + ' with lane-hydrogen')
  return $true
}

function Undo-ClaimIssue {
  param([int]$IssueNumber)
  if ($IssueNumber -le 0) { return }
  $null = Invoke-Gh ('issue edit ' + $IssueNumber + ' -R ' + $Repo + ' --remove-label lane-hydrogen')
  Write-Log ('released lane-hydrogen label on issue #' + $IssueNumber + ' after launch failure')
}

$mutex = $null
$hasMutex = $false
$claimedIssueNow = $false
$acquiredLockNow = $false
$launched = $false
$targetIssue = 0

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw '-Repo must be owner/name.'
  }

  $script:LaneRootPath = Get-AcceptancePath $LaneRoot
  Assert-OutsideGitCheckout $script:LaneRootPath
  Assert-OutsideAcceptanceRepo $script:LaneRootPath
  Assert-CmdSafePath '-LaneRoot' $script:LaneRootPath

  $script:SharedStateDir = Join-Path $script:LaneRootPath 'state'
  $script:ClaimsDir = Join-Path $script:LaneRootPath 'claims'
  $script:SharedStopPath = Join-Path $script:LaneRootPath 'STOP'
  $script:HealthPath = Join-Path $script:SharedStateDir 'health.json'
  $script:LanesRootPath = Join-Path $script:LaneRootPath 'lanes'
  $script:LaneDir = Join-Path $script:LanesRootPath $script:LaneId
  Assert-CmdSafePath 'LaneDir' $script:LaneDir

  $script:GateRootPath = Get-AcceptancePath $GateRoot
  $script:RepoPath = Join-Path $script:LaneDir 'repo'
  $script:WorktreeRoot = Join-Path $script:LaneDir 'wt'
  $script:StateDir = Join-Path $script:LaneDir 'state'
  $script:LogsDir = Join-Path $script:StateDir 'logs'
  $script:SessionsDir = Join-Path $script:StateDir 'sessions'
  $script:RunsDir = Join-Path $script:StateDir 'runs'
  $script:NeonDir = Join-Path $script:StateDir 'neon'
  $script:LaneStopPath = Join-Path $script:LaneDir 'STOP'
  $script:WorkerStatePath = Join-Path $script:StateDir 'worker.json'
  $script:ProgressPath = Join-Path $script:StateDir 'progress-hydrogen.json'
  $script:LogPath = Join-Path $script:LogsDir ('hydrogen-worker-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')

  $legacyProgressPath = Join-Path $script:SharedStateDir 'progress-hydrogen.json'
  $shouldMigrateH1 = $false
  if ($script:LaneId -eq 'h1' -and (Test-Path -LiteralPath $legacyProgressPath -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $script:LaneDir -PathType Container)) {
      $shouldMigrateH1 = $true
    } elseif ((-not (Test-Path -LiteralPath $script:ProgressPath -PathType Leaf)) -and
              (-not (Test-Path -LiteralPath $script:WorkerStatePath -PathType Leaf)) -and
              (-not (Test-Path -LiteralPath $script:RepoPath -PathType Container))) {
      $shouldMigrateH1 = $true
    }
  }

  [IO.Directory]::CreateDirectory($script:LaneRootPath) | Out-Null
  [IO.Directory]::CreateDirectory($script:SharedStateDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:ClaimsDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:LanesRootPath) | Out-Null
  [IO.Directory]::CreateDirectory($script:LaneDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:WorktreeRoot) | Out-Null
  [IO.Directory]::CreateDirectory($script:StateDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:LogsDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:SessionsDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:RunsDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:NeonDir) | Out-Null

  # Single-instance guard via per-lane named mutex.
  $mutex = New-Object System.Threading.Mutex($false, $script:MutexName)
  try {
    $hasMutex = $mutex.WaitOne(0, $false)
  } catch [System.Threading.AbandonedMutexException] {
    $hasMutex = $true
  }
  if (-not $hasMutex) {
    Write-Log ('another Start-HydrogenWorker instance holds mutex ' + $script:MutexName + '; exiting')
    exit 0
  }

  if ($shouldMigrateH1 -and (-not (Test-Path -LiteralPath $script:ProgressPath -PathType Leaf))) {
    try {
      [IO.File]::Copy($legacyProgressPath, $script:ProgressPath, $false)
      Write-Log ('migrated legacy progress-hydrogen.json into ' + $script:ProgressPath)
    } catch {
      Write-Log ('warning: failed to migrate legacy progress-hydrogen.json: ' + $_.Exception.Message)
    }
  }

  if (Test-Path -LiteralPath $script:SharedStopPath) {
    Write-Log ('shared STOP file present (' + $script:SharedStopPath + '); exiting')
    exit 0
  }
  if (Test-Path -LiteralPath $script:LaneStopPath) {
    Write-Log ('lane STOP file present (' + $script:LaneStopPath + '); exiting')
    exit 0
  }

  $env:GH_PROMPT_DISABLED = '1'
  $env:GH_NO_UPDATE_NOTIFIER = '1'
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'
  $env:GIT_EDITOR = 'true'
  $env:CI = '1'
  $env:npm_config_yes = 'true'

  # Check any recorded agy session PID for this lane.
  $workerState = Read-WorkerState
  $active = $workerState['activeSession']
  if ($null -ne $active -and (-not [bool]$active['finalized'])) {
    $trackedPid = [int]$active['pid']
    $liveProc = Get-LiveTrackedProcess -ProcessId $trackedPid -ExpectedStartUtc ([string]$active['processStartUtc'])
    if ($null -ne $liveProc) {
      $startedDt = Parse-UtcTimestamp ([string]$active['startedAtUtc'])
      if ($null -eq $startedDt) {
        try { $startedDt = $liveProc.StartTime.ToUniversalTime() } catch { $startedDt = [DateTime]::UtcNow }
      }
      $elapsedMin = ([DateTime]::UtcNow - $startedDt).TotalMinutes
      $targetLabel = ''
      if ([string]$active['kind'] -eq 'continue') {
        $targetLabel = 'continue PR #' + [int]$active['pr']
      } else {
        $targetLabel = 'implement issue #' + [int]$active['issue']
      }
      if ($elapsedMin -ge $HardKillMinutes) {
        Write-Log ('session pid=' + $trackedPid + ' (' + $targetLabel + ') exceeded ' + $HardKillMinutes + 'm (' + [Math]::Round($elapsedMin, 1) + 'm); killing process tree')
        $killOut = Join-Path $script:StateDir '.taskkill.out.tmp'
        $killErr = Join-Path $script:StateDir '.taskkill.err.tmp'
        $null = Invoke-Tool $script:TaskkillExe ('/T /F /PID ' + $trackedPid) $killOut $killErr $script:StateDir
        try { $null = $liveProc.WaitForExit(5000) } catch { }
        Stop-TreeProcesses $script:WorktreeRoot
        $null = Inspect-SessionLogsForCooldown -Session $active
        $active['finalized'] = $true
        $active['endedAtUtc'] = [DateTime]::UtcNow.ToString('o')
        $active['endReason'] = 'timeout-killed'
        $workerState['activeSession'] = $active
        Save-JsonAtomic -Path $script:WorkerStatePath -Object $workerState
        exit 0
      }
      Write-Log ('active agy session pid=' + $trackedPid + ' (' + $targetLabel + ') still running (' + [Math]::Round($elapsedMin, 1) + 'm / ' + $HardKillMinutes + 'm); exiting')
      exit 0
    }

    # Previously tracked agy process has exited: inspect its logs for auth/quota errors and clean up.
    Write-Log ('previous agy session pid=' + $trackedPid + ' exited; checking logs')
    $hitCooldown = Inspect-SessionLogsForCooldown -Session $active
    Stop-TreeProcesses $script:WorktreeRoot
    $active['finalized'] = $true
    $active['endedAtUtc'] = [DateTime]::UtcNow.ToString('o')
    $active['endReason'] = 'exited'
    $workerState['activeSession'] = $active
    Save-JsonAtomic -Path $script:WorkerStatePath -Object $workerState
    if ($hitCooldown) {
      exit 0
    }
  }

  # Respect shared agy cooldown after errors.
  $cooldown = Get-ActiveCooldown -HealthPath $script:HealthPath
  if ($null -ne $cooldown) {
    Write-Log ('agy cooldown (' + $cooldown.cooldownClass + ', ' + $cooldown.durationLabel + ') until ' + $cooldown.cooldownUntil + ': ' + $cooldown.error + '; exiting')
    exit 0
  }

  $ghCmd = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ghCmd) { throw 'GitHub CLI (gh) was not found on PATH.' }
  $script:GhPath = $ghCmd.Source

  $gitCmd = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $gitCmd) { throw 'git was not found on PATH.' }
  $script:GitPath = $gitCmd.Source

  # Daily merge cap (default 150 merges per local day across nyx/ PRs excluding nyx/parity-sync-*, same count as watchdog).
  $mergedToday = Get-TodayMergedNyxPrCount
  if ($null -eq $mergedToday) {
    Write-Log 'could not count today merged nyx/ PRs; exiting'
    exit 0
  }
  if ($mergedToday -ge $DailyMergeCap) {
    Write-Log ('daily merge cap reached (' + $mergedToday + '/' + $DailyMergeCap + '); exiting')
    exit 0
  }

  # Resolve prompt and agy executable before touching GitHub or claiming issues.
  $resolvedPrompt = ''
  if (-not [string]::IsNullOrWhiteSpace($PromptPath)) {
    $resolvedPrompt = Get-AcceptancePath $PromptPath
  } else {
    $resolvedPrompt = Get-AcceptancePath (Join-Path $PSScriptRoot 'hydrogen.md')
  }
  if (-not (Test-Path -LiteralPath $resolvedPrompt -PathType Leaf)) {
    throw ('hydrogen.md not found at ' + $resolvedPrompt)
  }
  Assert-CmdSafePath 'hydrogen.md' $resolvedPrompt

  $agyExePath = $null
  try {
    $agyExePath = Resolve-AgyExecutable -RequestedPath $AgyPath
  } catch {
    $missingMsg = ConvertTo-SingleLine $_.Exception.Message 300
    $cd = Write-HealthCooldown -HealthPath $script:HealthPath -ErrorText $missingMsg -ErrorCode 'AGY_NOT_FOUND' -ModelName $Model
    Write-Log ('agy missing; agy cooldown (' + $cd.cooldownClass + ', ' + $cd.durationLabel + ') until ' + $cd.cooldownUntil + ': ' + $missingMsg)
    exit 1
  }
  Assert-CmdSafePath 'agy.exe' $agyExePath

  $referencePath = ''
  $hasReferenceDir = $false
  if (-not [string]::IsNullOrWhiteSpace($ReferenceRoot)) {
    $referencePath = Get-AcceptancePath $ReferenceRoot
    Assert-CmdSafePath '-ReferenceRoot' $referencePath
    if (Test-Path -LiteralPath $referencePath -PathType Container) {
      $hasReferenceDir = $true
    }
  }

  if (-not (Ensure-LaneClone)) {
    Write-Log 'lane clone unavailable; exiting'
    exit 0
  }

  # Query all open PRs and open nyx-auto issues.
  $prListRes = Invoke-Gh ('pr list -R ' + $Repo + ' --state open --limit 200 --json number,headRefName,headRefOid,body,labels,title')
  if ($prListRes.exitCode -ne 0) {
    Write-Log ('gh pr list failed: ' + (Get-ErrorSummary $prListRes))
    exit 0
  }
  $openPrs = @()
  if (-not [string]::IsNullOrWhiteSpace([string]$prListRes.text)) {
    try {
      $parsedPrs = $prListRes.text | ConvertFrom-Json
      if ($null -ne $parsedPrs) {
        $openPrs = @($parsedPrs | Where-Object { $null -ne $_ } | Sort-Object { [int](Get-JsonProp $_ 'number') })
      }
    } catch {
      Write-Log ('could not parse open PR list JSON: ' + $_.Exception.Message)
      exit 0
    }
  }

  $issueListRes = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --label ' + $Label + ' --limit 500 --json number,title,labels')
  if ($issueListRes.exitCode -ne 0) {
    Write-Log ('gh issue list failed: ' + (Get-ErrorSummary $issueListRes))
    exit 0
  }
  $openIssues = @()
  if (-not [string]::IsNullOrWhiteSpace([string]$issueListRes.text)) {
    try {
      $parsedIssues = $issueListRes.text | ConvertFrom-Json
      if ($null -ne $parsedIssues) {
        $openIssues = @($parsedIssues | Where-Object { $null -ne $_ })
      }
    } catch {
      Write-Log ('could not parse open issue list JSON: ' + $_.Exception.Message)
      exit 0
    }
  }

  $openIssueLabelsByNum = @{}
  foreach ($iss in $openIssues) {
    $issNum = 0
    $rawIssNum = Get-JsonProp $iss 'number'
    if ($null -ne $rawIssNum) { $issNum = [int]$rawIssNum }
    if ($issNum -gt 0) {
      $openIssueLabelsByNum[$issNum] = @(Get-LabelNames (Get-JsonProp $iss 'labels'))
    }
  }

  $progressParked = Read-AllLanesProgressParked
  $closingPattern = '(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:' + [regex]::Escape($Repo) + ')?#([0-9]+)\b'
  $issuesWithOpenPr = @{}
  $allHydrogenPrsByIssue = @{}
  $allHydrogenPrsByNumber = @{}
  $activeHydrogenPrs = New-Object Collections.Generic.List[object]

  foreach ($pr in $openPrs) {
    $prNum = 0
    $rawNum = Get-JsonProp $pr 'number'
    if ($null -ne $rawNum) { $prNum = [int]$rawNum }
    $headRef = [string](Get-JsonProp $pr 'headRefName')
    $headSha = ([string](Get-JsonProp $pr 'headRefOid')).Trim()
    $body = [string](Get-JsonProp $pr 'body')

    $firstBodyLinkedIssue = 0
    if (-not [string]::IsNullOrWhiteSpace($body)) {
      $bodyMatches = [regex]::Matches($body, $closingPattern)
      foreach ($m in $bodyMatches) {
        $linked = [int]$m.Groups[1].Value
        if ($linked -gt 0) {
          $issuesWithOpenPr[$linked] = $true
          if ($firstBodyLinkedIssue -eq 0) { $firstBodyLinkedIssue = $linked }
        }
      }
    }

    $cloudBranchMatch = [regex]::Match($headRef, '^nyx/([0-9]+)-cloud-', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($cloudBranchMatch.Success) {
      $cloudIssue = [int]$cloudBranchMatch.Groups[1].Value
      if ($cloudIssue -gt 0) { $issuesWithOpenPr[$cloudIssue] = $true }
      continue
    }

    if ($prNum -le 0 -or -not $headRef.StartsWith('nyx/h-', [StringComparison]::Ordinal)) {
      continue
    }

    $linkedIssue = 0
    $branchMatch = [regex]::Match($headRef, '^nyx/h-([0-9]+)-')
    if ($branchMatch.Success) {
      $linkedIssue = [int]$branchMatch.Groups[1].Value
      if ($linkedIssue -gt 0) { $issuesWithOpenPr[$linkedIssue] = $true }
    } elseif ($firstBodyLinkedIssue -gt 0) {
      $linkedIssue = $firstBodyLinkedIssue
    }

    $prLabels = @(Get-LabelNames (Get-JsonProp $pr 'labels'))
    $isParked = $false
    if (Test-HasAnyLabel -Labels $prLabels -Targets $script:ParkedPrLabels) {
      $isParked = $true
    }
    if (-not $isParked -and $progressParked.prs.ContainsKey($prNum)) {
      foreach ($parkedSha in $progressParked.prs[$prNum]) {
        if ([string]::IsNullOrWhiteSpace($parkedSha) -or $parkedSha.Equals($headSha, [StringComparison]::OrdinalIgnoreCase)) {
          $isParked = $true
          break
        }
      }
    }
    if (-not $isParked -and $linkedIssue -gt 0) {
      if ($progressParked.issues.ContainsKey($linkedIssue)) {
        $isParked = $true
      } else {
        $linkedLabels = @()
        if ($openIssueLabelsByNum.ContainsKey($linkedIssue)) {
          $linkedLabels = @($openIssueLabelsByNum[$linkedIssue])
        } else {
          $viewIss = Invoke-Gh ('issue view ' + $linkedIssue + ' -R ' + $Repo + ' --json labels')
          if ($viewIss.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$viewIss.text)) {
            try {
              $viewObj = $viewIss.text | ConvertFrom-Json
              $linkedLabels = @(Get-LabelNames (Get-JsonProp $viewObj 'labels'))
            } catch { $linkedLabels = @() }
          }
        }
        if (Test-HasAnyLabel -Labels $linkedLabels -Targets $script:ParkedIssueLabels) {
          $isParked = $true
        }
      }
    }

    $prRecord = [pscustomobject]@{
      number = $prNum
      issue = $linkedIssue
      branch = $headRef
      headSha = $headSha
      isParked = $isParked
      matchesIssueBranch = $branchMatch.Success
    }
    $allHydrogenPrsByNumber[$prNum] = $prRecord
    if ($linkedIssue -gt 0) {
      if (-not $allHydrogenPrsByIssue.ContainsKey($linkedIssue)) {
        $allHydrogenPrsByIssue[$linkedIssue] = New-Object Collections.Generic.List[object]
      }
      $null = $allHydrogenPrsByIssue[$linkedIssue].Add($prRecord)
    }

    if (-not $isParked) {
      $null = $activeHydrogenPrs.Add($prRecord)
    }
  }

  # Sweep stale/closed claim locks before evaluating ownership and open PR caps.
  Sweep-ClaimLocks -OpenIssueLabelsByNum $openIssueLabelsByNum -HydrogenPrsByIssue $allHydrogenPrsByIssue -HydrogenPrsByNumber $allHydrogenPrsByNumber

  $ownedActivePrs = New-Object Collections.Generic.List[object]
  $unlockedActivePrs = New-Object Collections.Generic.List[object]
  foreach ($hpr in @($activeHydrogenPrs.ToArray())) {
    if ($hpr.issue -le 0) {
      Write-Log ('skipping open nyx/h- PR #' + $hpr.number + ' (' + $hpr.branch + ') because no linked issue number was found')
      continue
    }
    $lock = Read-IssueLock -IssueNumber $hpr.issue
    if ($null -eq $lock) {
      $null = $unlockedActivePrs.Add($hpr)
    } elseif (Test-LockOwnedByLane -Lock $lock -LaneId $script:LaneId) {
      if ($lock.pr -eq 0 -and $hpr.number -gt 0) {
        $null = Update-IssueLock -IssueNumber $hpr.issue -PrNumber $hpr.number -TouchLastActive $false
      }
      $null = $ownedActivePrs.Add($hpr)
    }
  }

  $ownedActivePrList = @($ownedActivePrs.ToArray())
  $unlockedActivePrList = @($unlockedActivePrs.ToArray())

  # (a) Find any open non-parked nyx/h- PR owned by this lane (or unlocked legacy/stale PR to adopt) needing gate or nyx/audit fix.
  $sessionKind = ''
  $targetPr = 0
  $targetIssue = 0
  $targetBranch = ''
  $targetHeadSha = ''
  $sessionReason = ''

  foreach ($phase in @('owned', 'unlocked')) {
    if (-not [string]::IsNullOrWhiteSpace($sessionKind)) { break }
    $prCandidates = if ($phase -eq 'owned') { $ownedActivePrList } else { $unlockedActivePrList }
    foreach ($hpr in $prCandidates) {
      $gateSummary = Get-LatestPrGateSummary -PrNumber $hpr.number
      $hasPassingGate = $false
      $gatePendingActive = $false

      if ($null -ne $gateSummary -and $null -ne $gateSummary.data) {
        $verdict = ([string](Get-JsonProp $gateSummary.data 'verdict')).Trim().ToLowerInvariant()
        $gateSha = ([string](Get-JsonProp $gateSummary.data 'headSha')).Trim()
        if ($verdict -eq 'pass' -and $gateSha.Equals($hpr.headSha, [StringComparison]::OrdinalIgnoreCase)) {
          $hasPassingGate = $true
        } elseif ($verdict -eq 'pending' -and (Test-GateTaskRunning -PrNumber $hpr.number)) {
          $gatePendingActive = $true
        }
      }

      if ($gatePendingActive) {
        Write-Log ('PR #' + $hpr.number + ' has an active gate task running; skipping for now')
        continue
      }

      $candidateReason = ''
      if (-not $hasPassingGate) {
        $candidateReason = 'current head lacks a passing gate summary'
      } else {
        $auditState = Get-AuditCommitStatus -HeadSha $hpr.headSha
        if ($auditState -eq 'failure' -or $auditState -eq 'error') {
          $candidateReason = 'nyx/audit status is ' + $auditState
        }
      }

      if ([string]::IsNullOrWhiteSpace($candidateReason)) { continue }

      if ($phase -eq 'owned') {
        if (-not (Update-IssueLock -IssueNumber $hpr.issue -PrNumber $hpr.number -WorkerPid ([int]$PID) -TouchLastActive $true)) {
          Write-Log ('lost claim lock ownership for PR #' + $hpr.number + ' (issue #' + $hpr.issue + ') before launch; skipping')
          continue
        }
      } else {
        if (-not (Try-AcquireIssueLock -IssueNumber $hpr.issue -PrNumber $hpr.number)) {
          Write-Log ('open PR #' + $hpr.number + ' (issue #' + $hpr.issue + ') was adopted by another lane; skipping')
          continue
        }
        $targetIssue = $hpr.issue
        $acquiredLockNow = $true
        Write-Log ('lane ' + $script:LaneId + ' adopted unlocked PR #' + $hpr.number + ' (issue #' + $hpr.issue + ')')
      }

      $sessionKind = 'continue'
      $targetPr = $hpr.number
      $targetIssue = $hpr.issue
      $targetBranch = $hpr.branch
      $targetHeadSha = $hpr.headSha
      $sessionReason = $candidateReason
      break
    }
  }

  # (a2) Resume a lane-hydrogen issue owned by this lane (or unlocked legacy/stale issue to adopt) whose session ended before a PR was opened; release it after 3 sessions.
  if ([string]::IsNullOrWhiteSpace($sessionKind)) {
    $ownedOrphanIssues = New-Object Collections.Generic.List[int]
    $unlockedOrphanIssues = New-Object Collections.Generic.List[int]
    foreach ($iss in $openIssues) {
      $orphanNum = 0
      $rawOrphan = Get-JsonProp $iss 'number'
      if ($null -ne $rawOrphan) { $orphanNum = [int]$rawOrphan }
      if ($orphanNum -le 0) { continue }
      $orphanLabels = @(Get-LabelNames (Get-JsonProp $iss 'labels'))
      if ($orphanLabels -notcontains 'lane-hydrogen') { continue }
      if ($orphanLabels -contains 'parked' -or $orphanLabels -contains 'audit-parked' -or $orphanLabels -contains 'needs-human' -or $orphanLabels -contains 'lane-cloud') { continue }
      if ($issuesWithOpenPr.ContainsKey($orphanNum)) { continue }
      if ($progressParked.issues.ContainsKey($orphanNum)) { continue }

      $lock = Read-IssueLock -IssueNumber $orphanNum
      if ($null -eq $lock) {
        $null = $unlockedOrphanIssues.Add($orphanNum)
      } elseif (Test-LockOwnedByLane -Lock $lock -LaneId $script:LaneId) {
        $null = $ownedOrphanIssues.Add($orphanNum)
      }
    }

    foreach ($phase in @('owned', 'unlocked')) {
      if (-not [string]::IsNullOrWhiteSpace($sessionKind)) { break }
      if ($phase -eq 'unlocked' -and $ownedActivePrList.Count -ge $MaxOpenPrs) {
        if ($unlockedOrphanIssues.Count -gt 0) {
          Write-Log ('lane ' + $script:LaneId + ' at open PR cap (' + $ownedActivePrList.Count + '/' + $MaxOpenPrs + '); skipping adoption of unlocked lane-hydrogen issues')
        }
        break
      }
      $orphanCandidates = if ($phase -eq 'owned') { @($ownedOrphanIssues.ToArray()) } else { @($unlockedOrphanIssues.ToArray()) }
      foreach ($orphanNum in $orphanCandidates) {
        if ($phase -eq 'unlocked') {
          if (-not (Try-AcquireIssueLock -IssueNumber $orphanNum -PrNumber 0)) {
            Write-Log ('lane-hydrogen issue #' + $orphanNum + ' was adopted by another lane; skipping')
            continue
          }
          $targetIssue = $orphanNum
          $acquiredLockNow = $true
          Write-Log ('lane ' + $script:LaneId + ' adopted unlocked lane-hydrogen issue #' + $orphanNum)
        }
        $priorSessions = @(Get-ChildItem -LiteralPath $script:SessionsDir -Directory -Filter ('issue-' + $orphanNum + '-*') -ErrorAction SilentlyContinue)
        if ($priorSessions.Count -ge 3) {
          if ($phase -eq 'owned') {
            $curLock = Read-IssueLock -IssueNumber $orphanNum
            if (-not (Test-LockOwnedByLane -Lock $curLock -LaneId $script:LaneId)) {
              Write-Log ('lost claim lock ownership for issue #' + $orphanNum + ' before release; skipping')
              continue
            }
          }
          $null = Invoke-Gh ('issue edit ' + $orphanNum + ' -R ' + $Repo + ' --remove-label lane-hydrogen')
          Remove-IssueLock -IssueNumber $orphanNum -RequireOwned
          if ($phase -eq 'unlocked') {
            $acquiredLockNow = $false
            $targetIssue = 0
          }
          Write-Log ('released lane-hydrogen and claim lock on issue #' + $orphanNum + ' after ' + $priorSessions.Count + ' sessions without a PR')
          continue
        }
        if ($phase -eq 'owned') {
          if (-not (Update-IssueLock -IssueNumber $orphanNum -PrNumber 0 -WorkerPid ([int]$PID) -TouchLastActive $true)) {
            Write-Log ('lost claim lock ownership for issue #' + $orphanNum + ' before launch; skipping')
            continue
          }
        }
        $sessionKind = 'implement'
        $targetIssue = $orphanNum
        $sessionReason = 'resuming claimed issue with no PR (session ' + ($priorSessions.Count + 1) + ' of 3)'
        break
      }
    }
  }

  # (b) Else below this lane's open PR cap, atomically lock and claim the highest-numbered eligible nyx-auto issue.
  if ([string]::IsNullOrWhiteSpace($sessionKind)) {
    if ($ownedActivePrList.Count -ge $MaxOpenPrs) {
      Write-Log ('lane ' + $script:LaneId + ' at open PR cap (' + $ownedActivePrList.Count + '/' + $MaxOpenPrs + '); all owned open nyx/h- PRs are waiting on audit or merge; exiting')
      exit 0
    }

    $eligible = New-Object Collections.Generic.List[object]
    foreach ($iss in $openIssues) {
      $issNum = 0
      $rawIssNum = Get-JsonProp $iss 'number'
      if ($null -ne $rawIssNum) { $issNum = [int]$rawIssNum }
      if ($issNum -le 0) { continue }
      $issLabels = @(Get-LabelNames (Get-JsonProp $iss 'labels'))
      if (Test-HasAnyLabel -Labels $issLabels -Targets $script:ExcludedIssueLabels) { continue }
      if ($issuesWithOpenPr.ContainsKey($issNum)) { continue }
      if ($progressParked.issues.ContainsKey($issNum)) { continue }
      $null = $eligible.Add([pscustomobject]@{
        number = $issNum
        title = [string](Get-JsonProp $iss 'title')
      })
    }

    $sortedEligible = @($eligible.ToArray() | Sort-Object -Property number -Descending)
    if ($sortedEligible.Count -eq 0) {
      Write-Log 'no eligible nyx-auto issues to claim; exiting'
      exit 0
    }

    foreach ($chosen in $sortedEligible) {
      $candNum = [int]$chosen.number
      if (-not (Try-AcquireIssueLock -IssueNumber $candNum -PrNumber 0)) {
        $holderLock = Read-IssueLock -IssueNumber $candNum
        $holder = 'unknown'
        if ($null -ne $holderLock -and (-not [string]::IsNullOrWhiteSpace($holderLock.laneId))) {
          $holder = $holderLock.laneId
        }
        Write-Log ('issue #' + $candNum + ' already locked by lane ' + $holder + '; trying next')
        continue
      }
      $targetIssue = $candNum
      $acquiredLockNow = $true
      $claimedIssueNow = $true
      if (-not (Invoke-ClaimIssue -IssueNumber $candNum)) {
        Remove-IssueLock -IssueNumber $candNum -RequireOwned
        $claimedIssueNow = $false
        $acquiredLockNow = $false
        $targetIssue = 0
        continue
      }
      $sessionKind = 'implement'
      $sessionReason = 'claimed highest eligible nyx-auto issue'
      break
    }

    if ([string]::IsNullOrWhiteSpace($sessionKind)) {
      Write-Log 'no eligible unlocked nyx-auto issues could be claimed; exiting'
      exit 0
    }
  }

  # Launch agy detached in the lane clone.
  $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
  $tag = ''
  if ($sessionKind -eq 'continue') {
    $tag = 'pr-' + $targetPr + '-' + $stamp
  } else {
    $tag = 'issue-' + $targetIssue + '-' + $stamp
  }
  $sessionDir = Join-Path $script:SessionsDir $tag
  if (Test-Path -LiteralPath $sessionDir) {
    $sessionDir = $sessionDir + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 4)
  }
  [IO.Directory]::CreateDirectory($sessionDir) | Out-Null

  $agyOutPath = Join-Path $sessionDir 'agy.out.log'
  $agyErrPath = Join-Path $sessionDir 'agy.err.log'
  $agyLogPath = Join-Path $sessionDir 'agy.log'
  Assert-CmdSafePath 'agyLogPath' $agyLogPath

  $laneContext = ' LaneId: ' + $script:LaneId +
    '. Lane clone: ' + $script:RepoPath +
    '. Worktree root: ' + $script:WorktreeRoot +
    '. Lane state dir: ' + $script:StateDir +
    '. Lane STOP: ' + $script:LaneStopPath +
    '. Shared STOP: ' + $script:SharedStopPath +
    '. Never merge PRs.'
  $promptText = ''
  if ($sessionKind -eq 'continue') {
    $sha7 = $targetHeadSha
    if ($sha7.Length -gt 7) { $sha7 = $sha7.Substring(0, 7) }
    $safeBranch = ConvertTo-SingleLine $targetBranch 120
    $promptText = 'Read and follow every instruction in ' + $resolvedPrompt +
      '. Session: continue PR #' + $targetPr +
      ' (issue #' + $targetIssue + ', branch ' + $safeBranch + ', head ' + $sha7 + ', reason: ' + $sessionReason + ').' +
      $laneContext
  } else {
    $promptText = 'Read and follow every instruction in ' + $resolvedPrompt +
      '. Session: implement issue #' + $targetIssue + '.' +
      ' Worktree: ' + (Join-Path $script:WorktreeRoot ([string]$targetIssue)) + '.' +
      $laneContext
  }

  $scriptsDir = Split-Path -Parent $resolvedPrompt
  $agyArgs = '-p ' + (Quote-Win32Argument $promptText) +
    ' --model ' + (Quote-Argument $Model) +
    ' --dangerously-skip-permissions' +
    ' --print-timeout ' + ([string]$PrintTimeoutMinutes + 'm') +
    ' --output-format text' +
    ' --log-file ' + (Quote-Argument $agyLogPath) +
    ' --add-dir ' + (Quote-Argument $script:LaneDir) +
    ' --add-dir ' + (Quote-Argument $scriptsDir)
  if ($hasReferenceDir) {
    $agyArgs += ' --add-dir ' + (Quote-Argument $referencePath)
  }

  $startedUtc = [DateTime]::UtcNow.ToString('o')
  $proc = $null
  try {
    $proc = Start-Process -FilePath $agyExePath -ArgumentList $agyArgs `
      -RedirectStandardOutput $agyOutPath -RedirectStandardError $agyErrPath `
      -WorkingDirectory $script:RepoPath -WindowStyle Hidden -PassThru
  } catch {
    $launchErr = ConvertTo-SingleLine $_.Exception.Message 260
    Write-Log ('failed to launch agy: ' + $launchErr)
    if ($claimedIssueNow) {
      Undo-ClaimIssue -IssueNumber $targetIssue
    }
    if ($acquiredLockNow) {
      Remove-IssueLock -IssueNumber $targetIssue -RequireOwned
    }
    exit 1
  }

  if ($null -eq $proc) {
    Write-Log 'Start-Process returned null for agy'
    if ($claimedIssueNow) {
      Undo-ClaimIssue -IssueNumber $targetIssue
    }
    if ($acquiredLockNow) {
      Remove-IssueLock -IssueNumber $targetIssue -RequireOwned
    }
    exit 1
  }

  $launched = $true
  $procStartUtc = $startedUtc
  try {
    $procStartUtc = $proc.StartTime.ToUniversalTime().ToString('o')
  } catch { }

  if (-not (Update-IssueLock -IssueNumber $targetIssue -PrNumber $targetPr -WorkerPid ([int]$proc.Id) -TouchLastActive $true)) {
    Write-Log ('warning: claim lock for issue #' + $targetIssue + ' was no longer owned by lane ' + $script:LaneId + ' after launch')
  }

  $workerState['activeSession'] = [ordered]@{
    pid = [int]$proc.Id
    processStartUtc = $procStartUtc
    startedAtUtc = $startedUtc
    endedAtUtc = ''
    endReason = ''
    kind = $sessionKind
    issue = $targetIssue
    pr = $targetPr
    headSha = $targetHeadSha
    outLog = $agyOutPath
    errLog = $agyErrPath
    agyLog = $agyLogPath
    finalized = $false
  }
  Save-JsonAtomic -Path $script:WorkerStatePath -Object $workerState

  $summaryLabel = ''
  if ($sessionKind -eq 'continue') {
    $summaryLabel = 'continue PR #' + $targetPr + ' (' + $sessionReason + ')'
  } else {
    $summaryLabel = 'implement issue #' + $targetIssue
  }
  Write-Log ('started agy lane=' + $script:LaneId + ' pid=' + $proc.Id + ' model=' + $Model + ' session=' + $summaryLabel + ' logs=' + $sessionDir)
  exit 0
} catch {
  if (-not $launched) {
    if ($claimedIssueNow -and $targetIssue -gt 0) {
      try { Undo-ClaimIssue -IssueNumber $targetIssue } catch { }
    }
    if ($acquiredLockNow -and $targetIssue -gt 0) {
      try { Remove-IssueLock -IssueNumber $targetIssue -RequireOwned } catch { }
    }
  }
  $errMsg = ConvertTo-SingleLine $_.Exception.Message 300
  $errWhere = ''
  try { $errWhere = ' [' + $_.Exception.GetType().FullName + ' at line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + (ConvertTo-SingleLine ([string]$_.InvocationInfo.Line) 160) + ']' } catch { }
  Write-Log ('hydrogen worker error: ' + $errMsg + $errWhere)
  [Console]::Error.WriteLine('Start-HydrogenWorker failed: ' + $errMsg)
  exit 1
} finally {
  if ($hasMutex -and $null -ne $mutex) {
    try { $mutex.ReleaseMutex() } catch { }
  }
  if ($null -ne $mutex) {
    try { $mutex.Dispose() } catch { }
  }
}
