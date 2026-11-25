# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-25.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Get-LoopHealth.ps1 [-Root <state root>] [-Hours <window hours>]
# Summarizes watchdog health samples, autopilot gate outcomes, and watchdog log events over the trailing window as one compact JSON object.

param(
  [string]$Root = 'C:\tivano\dev-loop',
  [int]$Hours = 24
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-TextSafe {
  param([string]$Path)
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  } catch {
    return $null
  }
}

function Get-JsonProp {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $null
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

$windowHours = $Hours
if ($windowHours -lt 0) { $windowHours = 0 }

$nowUtc = [DateTime]::UtcNow
$cutoffUtc = $nowUtc.AddHours(-$windowHours)
$nowLocal = [DateTime]::Now
$cutoffLocal = $nowLocal.AddHours(-$windowHours)

$healthSamples = 0
$freeRamMBMin = 0
$freeRamMBMedian = 0
$commitPctMax = 0
$desktopMBMax = 0
$hungSamples = 0
$dialogSamples = 0
$orphanMax = 0

$gateRuns = 0
$gatePass = 0
$gateFail = 0
$gateOther = 0
$gateTimeoutFails = 0

$watchdogRestarts = 0
$watchdogKickoffs = 0
$watchdogUserDeferred = 0
$watchdogSessionRotations = 0
$watchdogRotationUnconfirmed = 0
$watchdogHangRestarts = 0
$watchdogStrayClosed = 0

if (-not [string]::IsNullOrWhiteSpace($Root)) {
  # 1. Health samples from <Root>\state\health.jsonl
  try {
    $healthPath = Join-Path (Join-Path $Root 'state') 'health.jsonl'
    $healthText = Read-TextSafe $healthPath
    if (-not [string]::IsNullOrWhiteSpace($healthText)) {
      $freeRamValues = New-Object Collections.Generic.List[double]
      $lines = @($healthText -split "`r?`n")
      foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $obj = $null
        try { $obj = $line | ConvertFrom-Json } catch { continue }
        if ($null -eq $obj) { continue }

        $tsRaw = [string](Get-JsonProp $obj 'utc')
        if ([string]::IsNullOrWhiteSpace($tsRaw)) { $tsRaw = [string](Get-JsonProp $obj 'tsUtc') }
        if ([string]::IsNullOrWhiteSpace($tsRaw)) { $tsRaw = [string](Get-JsonProp $obj 'timestamp') }
        $tsUtc = Parse-UtcTimestamp $tsRaw
        if ($null -eq $tsUtc -or $tsUtc -lt $cutoffUtc) { continue }

        try {
          $freeVal = 0.0
          $rawFree = Get-JsonProp $obj 'freeRamMB'
          if ($null -ne $rawFree) { $freeVal = [double]$rawFree }

          $commitVal = 0
          $rawCommit = Get-JsonProp $obj 'commitPct'
          if ($null -ne $rawCommit) { $commitVal = [int][Math]::Round([double]$rawCommit) }

          $desktopVal = 0
          $rawDesktop = Get-JsonProp $obj 'desktopMB'
          if ($null -ne $rawDesktop) { $desktopVal = [int][Math]::Round([double]$rawDesktop) }

          $hungVal = 0
          $rawHung = Get-JsonProp $obj 'hungWindows'
          if ($null -eq $rawHung) { $rawHung = Get-JsonProp $obj 'hung' }
          if ($null -ne $rawHung) { $hungVal = [int]$rawHung }

          $dialogVal = 0
          $rawDialog = Get-JsonProp $obj 'notRespondingDialogs'
          if ($null -eq $rawDialog) { $rawDialog = Get-JsonProp $obj 'dialog' }
          if ($null -ne $rawDialog) { $dialogVal = [int]$rawDialog }

          $orphanVal = 0
          $rawOrphan = Get-JsonProp $obj 'orphanCandidates'
          if ($null -ne $rawOrphan) { $orphanVal = [int]$rawOrphan }

          $healthSamples++
          $null = $freeRamValues.Add($freeVal)
          if ($healthSamples -eq 1 -or $commitVal -gt $commitPctMax) { $commitPctMax = $commitVal }
          if ($healthSamples -eq 1 -or $desktopVal -gt $desktopMBMax) { $desktopMBMax = $desktopVal }
          if ($hungVal -gt 0) { $hungSamples++ }
          if ($dialogVal -gt 0) { $dialogSamples++ }
          if ($healthSamples -eq 1 -or $orphanVal -gt $orphanMax) { $orphanMax = $orphanVal }
        } catch { continue }
      }

      if ($freeRamValues.Count -gt 0) {
        [double[]]$sorted = $freeRamValues.ToArray()
        [Array]::Sort($sorted)
        $n = $sorted.Length
        $freeRamMBMin = [int][Math]::Round($sorted[0])
        if (($n % 2) -eq 1) {
          $freeRamMBMedian = [int][Math]::Round($sorted[[int][Math]::Floor($n / 2)])
        } else {
          $mid = [int]($n / 2)
          $freeRamMBMedian = [int][Math]::Round(($sorted[$mid - 1] + $sorted[$mid]) / 2.0)
        }
      }
    }
  } catch { }

  # 2. Gate summaries from <Root>\autopilot\gate\*\summary.json
  try {
    $gateRoot = Join-Path (Join-Path $Root 'autopilot') 'gate'
    if (Test-Path -LiteralPath $gateRoot -PathType Container) {
      $timeoutPattern = '(?i)timed out|ETIMEDOUT'
      $gateDirs = @(Get-ChildItem -LiteralPath $gateRoot -Directory -ErrorAction SilentlyContinue)
      foreach ($dir in $gateDirs) {
        if ($dir.LastWriteTimeUtc -lt $cutoffUtc) { continue }
        $summaryPath = Join-Path $dir.FullName 'summary.json'
        if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) { continue }
        $gateRuns++

        $summaryText = Read-TextSafe $summaryPath
        $verdict = ''
        if (-not [string]::IsNullOrWhiteSpace($summaryText)) {
          try {
            $summaryObj = $summaryText | ConvertFrom-Json
            $verdict = ([string](Get-JsonProp $summaryObj 'verdict')).Trim().ToLowerInvariant()
          } catch { }
        }

        if ($verdict -eq 'pass') {
          $gatePass++
        } else {
          if ($verdict -eq 'fail') { $gateFail++ } else { $gateOther++ }
          # A timeout counts for any non-pass outcome (fail or unavailable), judged from the
          # gate's own reported outcome in summary.json rather than the noisy full gate.log.
          if (-not [string]::IsNullOrEmpty($summaryText) -and $summaryText -match $timeoutPattern) { $gateTimeoutFails++ }
        }
      }
    }
  } catch { }

  # 3. Watchdog events from <Root>\state\logs\autopilot-*.log
  try {
    $logsDir = Join-Path (Join-Path $Root 'state') 'logs'
    if (Test-Path -LiteralPath $logsDir -PathType Container) {
      $logFiles = @(Get-ChildItem -LiteralPath $logsDir -Filter 'autopilot-*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -ge $cutoffUtc.AddHours(-1) })
      foreach ($logFile in $logFiles) {
        $logText = Read-TextSafe $logFile.FullName
        if ([string]::IsNullOrWhiteSpace($logText)) { continue }
        $logLines = @($logText -split "`r?`n")
        foreach ($logLine in $logLines) {
          if ($logLine -notmatch '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\s+(.*)$') { continue }
          $parsedLocal = [DateTime]::MinValue
          if (-not [DateTime]::TryParseExact($Matches[1], 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$parsedLocal)) {
            continue
          }
          if ($parsedLocal -lt $cutoffLocal) { continue }
          $msg = $Matches[2]
          if ($msg -match '; restarting Devin Desktop|performing full reset of Devin Desktop before relaunch') {
            $watchdogRestarts++
          }
          if ($msg -match 'kickoff sent autopilot prompt') {
            $watchdogKickoffs++
          }
          if ($msg -match 'user active, deferred') {
            $watchdogUserDeferred++
          }
          if ($msg -match 'session rotated') {
            $watchdogSessionRotations++
          }
          if ($msg -match 'session rotation unconfirmed') {
            $watchdogRotationUnconfirmed++
          }
          if ($msg -match 'Devin Desktop hung for \d+ samples; restarting') {
            $watchdogHangRestarts++
          }
          if ($msg -match 'stray app closed:') {
            $watchdogStrayClosed++
          }
        }
      }
    }
  } catch { }
}

$report = [ordered]@{
  windowHours = $windowHours
  health = [ordered]@{
    samples = $healthSamples
    freeRamMBMin = $freeRamMBMin
    freeRamMBMedian = $freeRamMBMedian
    commitPctMax = $commitPctMax
    desktopMBMax = $desktopMBMax
    hungSamples = $hungSamples
    dialogSamples = $dialogSamples
    orphanMax = $orphanMax
  }
  gates = [ordered]@{
    runs = $gateRuns
    pass = $gatePass
    fail = $gateFail
    other = $gateOther
    timeoutFails = $gateTimeoutFails
  }
  watchdog = [ordered]@{
    restarts = $watchdogRestarts
    kickoffs = $watchdogKickoffs
    userDeferred = $watchdogUserDeferred
    sessionRotations = $watchdogSessionRotations
    rotationUnconfirmed = $watchdogRotationUnconfirmed
    hangRestarts = $watchdogHangRestarts
    strayClosed = $watchdogStrayClosed
  }
}

[Console]::Out.WriteLine((ConvertTo-Json -InputObject $report -Compress -Depth 5))
exit 0
