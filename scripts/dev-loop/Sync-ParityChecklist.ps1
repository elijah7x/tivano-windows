# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Sync-ParityChecklist.ps1 [-Repo <owner/name>] [-Root <dir>] [-MinBatch <n>] [-MaxAgeMinutes <min>] [-DryRun]
# Batch-syncs pending Parity status lines recorded from merged feature PRs into docs/parity.md via a dedicated PR.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root = 'C:\tivano\dev-loop',
  [ValidateRange(1, 1000)][int]$MinBatch = 5,
  [ValidateRange(1, 10080)][int]$MaxAgeMinutes = 60,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:WorkRoot = $null
$script:StateDir = $null
$script:LogsDir = $null
$script:AutopilotDir = $null
$script:StopPath = $null
$script:PendingPath = $null
$script:SyncRoot = $null
$script:RepoDir = $null
$script:LogPath = $null
$script:GhPath = $null
$script:GitPath = $null
$script:MutexName = 'Local\TivanoDevLoop-ParitySync'
$script:AllowedParityStatusPattern = '(?i)^(?:partial|not started|blocked\s*\([^)\r\n]+\)|n/a\s*\([^)\r\n]+\))$'

function Write-Text {
  param([string]$Path, [AllowEmptyString()][string]$Text)
  $parentDir = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parentDir)) {
    [IO.Directory]::CreateDirectory($parentDir) | Out-Null
  }
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

function ConvertTo-SingleLine {
  param([AllowEmptyString()][string]$Text, [int]$Limit = 240)
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

function Get-JsonProp {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $null
}

function Read-JsonFileChecked {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [pscustomobject]@{ ok = $true; exists = $false; data = $null; error = '' }
  }
  $text = $null
  try {
    $text = Read-Text $Path
  } catch {
    return [pscustomobject]@{ ok = $false; exists = $true; data = $null; error = $_.Exception.Message }
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    return [pscustomobject]@{ ok = $true; exists = $true; data = $null; error = '' }
  }
  try {
    $parsed = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
    return [pscustomobject]@{ ok = $true; exists = $true; data = $parsed; error = '' }
  } catch {
    return [pscustomobject]@{ ok = $false; exists = $true; data = $null; error = $_.Exception.Message }
  }
}

function Save-JsonAtomic {
  param(
    [string]$Path,
    $Object,
    [int]$Depth = 8
  )
  $parentDir = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parentDir)) {
    [IO.Directory]::CreateDirectory($parentDir) | Out-Null
  }
  $temporary = $Path + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.tmp'
  $json = ConvertTo-Json -InputObject $Object -Depth $Depth
  Write-Text $temporary ($json + "`n")
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (Test-Path -LiteralPath $Path -PathType Leaf) {
        [IO.File]::Replace($temporary, $Path, [NullString]::Value)
      } else {
        [IO.File]::Move($temporary, $Path)
      }
      return
    } catch {
      if ($attempt -lt 8) {
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    }
  }
  try {
    [IO.File]::Copy($temporary, $Path, $true)
    try {
      if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) }
    } catch { }
    return
  } catch {
    $fallbackErr = $_
    try {
      if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) }
    } catch { }
    throw $fallbackErr
  }
}

function Parse-UtcTimestamp {
  param([AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
    return $parsed.UtcDateTime
  }
  return $null
}

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

function Test-NetworkFailure {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bEOF\b|handshake|schannel|Could not resolve host|Failed to connect|connection (was )?(reset|refused|closed)|i/o timeout|TLS|unable to access|error connecting to|no such host')
}

function Invoke-Gh {
  param([string]$Arguments)
  $out = Join-Path $script:SyncRoot '.gh.out.tmp'
  $err = Join-Path $script:SyncRoot '.gh.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GhPath $Arguments $out $err $script:SyncRoot
    $result = [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $result.error)) { return $result }
    Write-Log ('gh network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine ([string]$result.error) 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Invoke-Git {
  param([string]$Arguments)
  $out = Join-Path $script:SyncRoot '.git.out.tmp'
  $err = Join-Path $script:SyncRoot '.git.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GitPath $Arguments $out $err $script:SyncRoot
    $result = [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
    $combined = [string]$result.error + "`n" + [string]$result.text
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $combined)) { return $result }
    Write-Log ('git network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine $combined 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Normalize-ParityStatus {
  param([AllowEmptyString()][string]$Status)
  $trimmed = ([string]$Status).Trim()
  if ($trimmed -match '(?i)^partial$') { return 'partial' }
  if ($trimmed -match '(?i)^not\s+started$') { return 'not started' }
  $bm = [regex]::Match($trimmed, '(?i)^blocked\s*(\([^)\r\n]+\))$')
  if ($bm.Success) { return ('blocked ' + $bm.Groups[1].Value.Trim()) }
  $nm = [regex]::Match($trimmed, '(?i)^n/a\s*(\([^)\r\n]+\))$')
  if ($nm.Success) { return ('n/a ' + $nm.Groups[1].Value.Trim()) }
  return $trimmed
}

function Get-EntryKey {
  param($Entry)
  $pr = 0
  try { $pr = [int](Get-JsonProp $Entry 'pr') } catch { $pr = 0 }
  $id = ([string](Get-JsonProp $Entry 'id')).Trim().ToUpperInvariant()
  $st = ([string](Get-JsonProp $Entry 'status')).Trim()
  $sha = ([string](Get-JsonProp $Entry 'sha')).Trim()
  $at = ([string](Get-JsonProp $Entry 'mergedAtUtc')).Trim()
  return ($pr.ToString() + '|' + $id + '|' + $st + '|' + $sha + '|' + $at)
}

function Convert-PendingEntryToOrdered {
  param($Entry, [int]$AssignSyncPr = 0, [string]$SkipReason = '', [switch]$ClearSyncPr)
  $pr = 0
  try { $pr = [int](Get-JsonProp $Entry 'pr') } catch { $pr = 0 }
  $out = [ordered]@{
    pr = $pr
    sha = ([string](Get-JsonProp $Entry 'sha')).Trim()
    id = ([string](Get-JsonProp $Entry 'id')).Trim().ToUpperInvariant()
    status = ([string](Get-JsonProp $Entry 'status')).Trim()
    notes = ([string](Get-JsonProp $Entry 'notes')).Trim()
    mergedAtUtc = ([string](Get-JsonProp $Entry 'mergedAtUtc')).Trim()
  }
  $existingSyncPr = 0
  $rawSyncPr = Get-JsonProp $Entry 'syncPr'
  if ($null -ne $rawSyncPr) {
    try { $existingSyncPr = [int]$rawSyncPr } catch { $existingSyncPr = 0 }
  }
  if ($AssignSyncPr -gt 0) {
    $out['syncPr'] = $AssignSyncPr
  } elseif (-not $ClearSyncPr -and $existingSyncPr -gt 0) {
    $out['syncPr'] = $existingSyncPr
  }
  $existingSkipped = [bool](Get-JsonProp $Entry 'skipped')
  $existingSkipReason = [string](Get-JsonProp $Entry 'skipReason')
  if (-not [string]::IsNullOrWhiteSpace($SkipReason)) {
    $out['skipped'] = $true
    $out['skipReason'] = $SkipReason
  } elseif ($existingSkipped) {
    $out['skipped'] = $true
    if (-not [string]::IsNullOrWhiteSpace($existingSkipReason)) {
      $out['skipReason'] = $existingSkipReason
    }
  }
  return $out
}

function Update-PendingFileState {
  param(
    [hashtable]$AppliedKeys,
    [int]$SyncPrNumber,
    [hashtable]$SkippedReasons,
    [hashtable]$RemoveKeys = @{}
  )
  $read = Read-JsonFileChecked $script:PendingPath
  if (-not $read.ok) {
    throw ('cannot re-read parity-pending.json for update: ' + $read.error)
  }
  $updated = New-Object Collections.Generic.List[object]
  foreach ($item in @($read.data | Where-Object { $null -ne $_ })) {
    $key = Get-EntryKey $item
    $rawSyncPr = Get-JsonProp $item 'syncPr'
    $hasSyncPr = $false
    if ($null -ne $rawSyncPr) {
      try { $hasSyncPr = ([int]$rawSyncPr -gt 0) } catch { $hasSyncPr = $false }
    }
    if (-not $hasSyncPr -and $RemoveKeys.ContainsKey($key)) {
      continue
    }
    if (-not $hasSyncPr -and $SyncPrNumber -gt 0 -and $AppliedKeys.ContainsKey($key)) {
      $null = $updated.Add((Convert-PendingEntryToOrdered -Entry $item -AssignSyncPr $SyncPrNumber))
    } elseif (-not $hasSyncPr -and $SkippedReasons.ContainsKey($key)) {
      $null = $updated.Add((Convert-PendingEntryToOrdered -Entry $item -SkipReason ([string]$SkippedReasons[$key])))
    } else {
      $null = $updated.Add((Convert-PendingEntryToOrdered -Entry $item))
    }
  }
  Save-JsonAtomic -Path $script:PendingPath -Object ([object[]]$updated.ToArray()) -Depth 6
}

function Invoke-ReconcilePendingSyncPrs {
  param($Entries, [switch]$IsDryRun)
  $items = @($Entries | Where-Object { $null -ne $_ })
  $syncPrSet = @{}
  foreach ($entry in $items) {
    $rawSp = Get-JsonProp $entry 'syncPr'
    $sp = 0
    if ($null -ne $rawSp) {
      try { $sp = [int]$rawSp } catch { $sp = 0 }
    }
    if ($sp -gt 0) { $syncPrSet[$sp] = $true }
  }
  if ($syncPrSet.Count -eq 0) { return $items }

  $disposition = @{}
  foreach ($spNum in @($syncPrSet.Keys | Sort-Object)) {
    $viewRes = Invoke-Gh ('pr view ' + $spNum + ' -R ' + $Repo + ' --json state,mergedAt')
    if ($viewRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$viewRes.text)) {
      Write-Log ('reconcile: could not inspect syncPr #' + $spNum + ': ' + (ConvertTo-SingleLine (Get-ErrorSummary $viewRes) 180))
      continue
    }
    try {
      $prObj = $viewRes.text | ConvertFrom-Json
      $prState = ([string](Get-JsonProp $prObj 'state')).Trim().ToUpperInvariant()
      $mergedAt = [string](Get-JsonProp $prObj 'mergedAt')
      if ($prState -eq 'MERGED' -or -not [string]::IsNullOrWhiteSpace($mergedAt)) {
        $disposition[$spNum] = 'MERGED'
      } elseif ($prState -eq 'CLOSED') {
        $disposition[$spNum] = 'CLOSED'
      }
    } catch {
      Write-Log ('reconcile: could not parse syncPr #' + $spNum + ' JSON: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
    }
  }
  if ($disposition.Count -eq 0) { return $items }

  $reconciled = New-Object Collections.Generic.List[object]
  $removedMerged = 0
  $clearedClosed = 0
  foreach ($entry in $items) {
    $rawSp = Get-JsonProp $entry 'syncPr'
    $sp = 0
    if ($null -ne $rawSp) {
      try { $sp = [int]$rawSp } catch { $sp = 0 }
    }
    if ($sp -gt 0 -and $disposition.ContainsKey($sp)) {
      if ($disposition[$sp] -eq 'MERGED') {
        $removedMerged++
        continue
      }
      if ($disposition[$sp] -eq 'CLOSED') {
        $clearedClosed++
        $null = $reconciled.Add((Convert-PendingEntryToOrdered -Entry $entry -ClearSyncPr))
        continue
      }
    }
    $null = $reconciled.Add((Convert-PendingEntryToOrdered -Entry $entry))
  }

  if ($removedMerged -gt 0 -or $clearedClosed -gt 0) {
    if ($IsDryRun) {
      Write-Log ('dry-run: would reconcile parity-pending.json (remove ' + $removedMerged + ' merged, clear syncPr on ' + $clearedClosed + ' closed unmerged)')
    } else {
      Save-JsonAtomic -Path $script:PendingPath -Object ([object[]]$reconciled.ToArray()) -Depth 6
      Write-Log ('reconciled parity-pending.json: removed ' + $removedMerged + ' merged entry(s), cleared syncPr on ' + $clearedClosed + ' closed unmerged entry(s)')
    }
    return @($reconciled.ToArray())
  }
  return $items
}

function Add-MissedMergedParityEntries {
  # Backfill: a crash or write failure between a merge and the watchdog recording its Parity lines
  # would lose them, so re-read recently merged nyx/ PR bodies and add any line that is neither
  # pending nor already applied on main (row Notes already carry the '(#<pr>)' tag).
  param([switch]$IsDryRun)
  $sinceDate = [DateTime]::UtcNow.AddDays(-3).ToString('yyyy-MM-dd')
  $res = Invoke-Gh ('pr list -R ' + $Repo + ' --state merged --search ' + (Quote-Argument ('merged:>=' + $sinceDate)) + ' --limit 300 --json number,headRefName,body,mergedAt,mergeCommit')
  if ($res.exitCode -ne 0) { Write-Log ('backfill: gh pr list failed: ' + (ConvertTo-SingleLine ([string]$res.error) 160)); return }
  $prs = @()
  try { $prs = @($res.text | ConvertFrom-Json) } catch { Write-Log 'backfill: unparseable pr list'; return }
  $parityRes = Invoke-Gh ('api repos/' + $Repo + '/contents/docs/parity.md --jq .content')
  if ($parityRes.exitCode -ne 0) { Write-Log 'backfill: cannot read docs/parity.md on main; skipping'; return }
  $parityText = ''
  try { $parityText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((([string]$parityRes.text) -replace '\s', ''))) } catch { Write-Log 'backfill: cannot decode docs/parity.md'; return }
  $rowById = @{}
  foreach ($line in ($parityText -split "`r?`n")) {
    $m = [regex]::Match($line, '^\s*\|\s*([A-Za-z]+[0-9]*-[0-9]+)\s*\|')
    if ($m.Success) { $rowById[$m.Groups[1].Value.ToUpperInvariant()] = $line }
  }
  $read = Read-JsonFileChecked $script:PendingPath
  if (-not $read.ok) { Write-Log ('backfill: unreadable parity-pending.json: ' + $read.error); return }
  $existing = @()
  if ($read.exists -and $null -ne $read.data) { $existing = @($read.data | Where-Object { $null -ne $_ }) }
  $known = @{}
  foreach ($e in $existing) {
    $k = ([string](Get-JsonProp $e 'pr')) + '|' + ([string](Get-JsonProp $e 'id')).Trim().ToUpperInvariant()
    $known[$k] = $true
  }
  $added = New-Object Collections.Generic.List[object]
  $allowed = '(?i)^Parity:\s*(P\d+-\d+|W-\d+)\s*->\s*(partial|not started|blocked\s*\([^)\r\n]+\)|n/a\s*\([^)\r\n]+\))\s*$'
  foreach ($pr in $prs) {
    $head = [string](Get-JsonProp $pr 'headRefName')
    if (-not $head.StartsWith('nyx/') -or $head -like 'nyx/parity-sync-*' -or $head -like 'nyx/rebaseline-v*') { continue }
    $num = 0; try { $num = [int](Get-JsonProp $pr 'number') } catch { continue }
    $sha = ''; $mc = Get-JsonProp $pr 'mergeCommit'; if ($null -ne $mc) { $sha = [string](Get-JsonProp $mc 'oid') }
    $mergedAt = [string](Get-JsonProp $pr 'mergedAt')
    $last = $null
    foreach ($raw in (([string](Get-JsonProp $pr 'body')) -split "`r?`n")) {
      $line = $raw.Trim()
      $m = [regex]::Match($line, $allowed)
      if ($m.Success) {
        $id = $m.Groups[1].Value.ToUpperInvariant()
        $last = $null
        if ($known.ContainsKey(([string]$num) + '|' + $id)) { continue }
        if ($rowById.ContainsKey($id) -and $rowById[$id].Contains('(#' + $num + ')')) { continue }
        $last = [ordered]@{ pr = $num; sha = $sha; id = $id; status = (Normalize-ParityStatus $m.Groups[2].Value); notes = ''; mergedAtUtc = $mergedAt }
        $null = $added.Add($last)
        $known[([string]$num) + '|' + $id] = $true
        continue
      }
      $n = [regex]::Match($line, '(?i)^Parity-Notes:\s*(.+?)\s*$')
      if ($n.Success -and $null -ne $last) { $last['notes'] = $n.Groups[1].Value.Trim(); $last = $null }
    }
  }
  if ($added.Count -eq 0) { return }
  Write-Log ('backfill: adding ' + $added.Count + ' parity entry(s) from merged PR bodies not yet recorded')
  if ($IsDryRun) { return }
  $all = New-Object Collections.Generic.List[object]
  foreach ($e in $existing) { $null = $all.Add((Convert-PendingEntryToOrdered -Entry $e)) }
  foreach ($e in $added) { $null = $all.Add($e) }
  Save-JsonAtomic -Path $script:PendingPath -Object ([object[]]$all.ToArray()) -Depth 6
}

function Ensure-ParitySyncClone {
  if (-not (Test-Path -LiteralPath (Join-Path $script:RepoDir '.git'))) {
    if ((Test-Path -LiteralPath $script:RepoDir) -and @(Get-ChildItem -LiteralPath $script:RepoDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
      throw ('refusing to clone into non-empty directory without .git: ' + $script:RepoDir)
    }
    Write-Log ('cloning ' + $Repo + ' into ' + $script:RepoDir)
    $cloneRes = Invoke-Gh ('repo clone ' + $Repo + ' ' + (Quote-Argument $script:RepoDir))
    if ($cloneRes.exitCode -ne 0) {
      throw ('gh repo clone failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $cloneRes) 220))
    }
  }
  $fetchRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' fetch origin --prune')
  if ($fetchRes.exitCode -ne 0) {
    throw ('git fetch origin failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $fetchRes) 220))
  }
}

$mutex = $null
$mutexHeld = $false

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw '-Repo must be owner/name.'
  }

  $script:WorkRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $script:StateDir = Join-Path $script:WorkRoot 'state'
  $script:LogsDir = Join-Path $script:StateDir 'logs'
  $script:AutopilotDir = Join-Path $script:WorkRoot 'autopilot'
  $script:StopPath = Join-Path $script:StateDir 'STOP'
  $script:PendingPath = Join-Path $script:AutopilotDir 'parity-pending.json'
  $script:SyncRoot = Join-Path $script:WorkRoot 'parity-sync'
  $script:RepoDir = Join-Path $script:SyncRoot 'repo'
  $script:LogPath = Join-Path $script:LogsDir ('parity-sync-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')

  [IO.Directory]::CreateDirectory($script:LogsDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:AutopilotDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:SyncRoot) | Out-Null

  if (Test-Path -LiteralPath $script:StopPath) {
    Write-Log 'STOP file present; skipping parity sync'
    exit 0
  }

  $createdNew = $false
  $mutex = New-Object Threading.Mutex($false, $script:MutexName, [ref]$createdNew)
  try {
    $mutexHeld = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $mutexHeld = $true
  }
  if (-not $mutexHeld) {
    Write-Log 'another parity-sync instance holds the mutex; skipping'
    exit 0
  }

  $env:GH_PROMPT_DISABLED = '1'
  $env:GH_NO_UPDATE_NOTIFIER = '1'
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'

  $ghCmd = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ghCmd) { throw 'gh CLI was not found on PATH.' }
  $script:GhPath = $ghCmd.Source

  $gitCmd = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $gitCmd) { throw 'git was not found on PATH.' }
  $script:GitPath = $gitCmd.Source

  Add-MissedMergedParityEntries -IsDryRun:$DryRun

  $pendingRead = Read-JsonFileChecked $script:PendingPath
  if (-not $pendingRead.ok) {
    throw ('unreadable parity-pending.json: ' + $pendingRead.error)
  }
  if (-not $pendingRead.exists -or $null -eq $pendingRead.data) {
    exit 0
  }

  $allEntries = @(Invoke-ReconcilePendingSyncPrs -Entries @($pendingRead.data | Where-Object { $null -ne $_ }) -IsDryRun:$DryRun)
  $unsynced = New-Object Collections.Generic.List[object]
  foreach ($entry in $allEntries) {
    $rawSyncPr = Get-JsonProp $entry 'syncPr'
    $syncPrVal = 0
    if ($null -ne $rawSyncPr) {
      try { $syncPrVal = [int]$rawSyncPr } catch { $syncPrVal = 0 }
    }
    if ($syncPrVal -gt 0) { continue }
    if ([bool](Get-JsonProp $entry 'skipped')) { continue }
    $null = $unsynced.Add($entry)
  }
  if ($unsynced.Count -eq 0) {
    exit 0
  }

  $nowUtc = [DateTime]::UtcNow
  $oldestUtc = $null
  foreach ($entry in $unsynced) {
    $ts = Parse-UtcTimestamp ([string](Get-JsonProp $entry 'mergedAtUtc'))
    if ($null -ne $ts -and ($null -eq $oldestUtc -or $ts -lt $oldestUtc)) {
      $oldestUtc = $ts
    }
  }
  $oldestAgeMinutes = $null
  if ($null -ne $oldestUtc) {
    $oldestAgeMinutes = ($nowUtc - $oldestUtc).TotalMinutes
  }

  $countReady = ($unsynced.Count -ge $MinBatch)
  $ageReady = ($null -ne $oldestAgeMinutes -and $oldestAgeMinutes -ge [double]$MaxAgeMinutes)
  if (-not $countReady -and -not $ageReady) {
    $ageText = if ($null -ne $oldestAgeMinutes) { ([Math]::Round($oldestAgeMinutes, 1)).ToString('0.#', [Globalization.CultureInfo]::InvariantCulture) + 'm' } else { 'unknown' }
    Write-Log ('waiting for batch threshold: pending=' + $unsynced.Count + '/' + $MinBatch + ', oldest=' + $ageText + '/' + $MaxAgeMinutes + 'm')
    exit 0
  }

  $openRes = Invoke-Gh ('pr list -R ' + $Repo + ' --state open --limit 100 --json number,headRefName')
  if ($openRes.exitCode -ne 0) {
    throw ('gh pr list failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $openRes) 220))
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$openRes.text)) {
    $openPrs = @($openRes.text | ConvertFrom-Json | Where-Object { $null -ne $_ })
    foreach ($pr in $openPrs) {
      $href = [string](Get-JsonProp $pr 'headRefName')
      if ($href -like 'nyx/parity-sync-*') {
        $openNum = [int](Get-JsonProp $pr 'number')
        Write-Log ('open parity-sync PR #' + $openNum + ' (' + $href + ') already exists; skipping')
        exit 0
      }
    }
  }

  if ($DryRun -and -not (Test-Path -LiteralPath (Join-Path $script:RepoDir '.git'))) {
    Write-Log ('dry-run: would clone ' + $Repo + ' into ' + $script:RepoDir + ' and process ' + $unsynced.Count + ' pending parity entry(s)')
    exit 0
  }

  Ensure-ParitySyncClone

  $baseParityText = $null
  if ($DryRun) {
    $showRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' show origin/main:docs/parity.md')
    if ($showRes.exitCode -ne 0 -or [string]::IsNullOrEmpty([string]$showRes.text)) {
      throw ('failed to read origin/main:docs/parity.md: ' + (ConvertTo-SingleLine (Get-ErrorSummary $showRes) 220))
    }
    $baseParityText = [string]$showRes.text
  } else {
    $resetRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' reset --hard')
    if ($resetRes.exitCode -ne 0) {
      throw ('git reset --hard failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $resetRes) 220))
    }
    $cleanRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' clean -fd')
    if ($cleanRes.exitCode -ne 0) {
      throw ('git clean -fd failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $cleanRes) 220))
    }

    $branchName = 'nyx/parity-sync-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmm')
    $remoteRefCheck = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' show-ref --verify --quiet refs/remotes/origin/' + $branchName)
    if ($remoteRefCheck.exitCode -eq 0) {
      $branchName = $branchName + '-' + [DateTime]::UtcNow.ToString('ss')
    }

    $coRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' checkout -B ' + $branchName + ' origin/main')
    if ($coRes.exitCode -ne 0) {
      throw ('git checkout -B ' + $branchName + ' origin/main failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $coRes) 220))
    }

    $parityPath = Join-Path $script:RepoDir 'docs\parity.md'
    $baseParityText = Read-Text $parityPath
    if ([string]::IsNullOrEmpty($baseParityText)) {
      throw ('docs/parity.md not found or empty in ' + $script:RepoDir)
    }
  }

  $newline = "`n"
  if ($baseParityText.IndexOf("`r`n", [StringComparison]::Ordinal) -ge 0) {
    $newline = "`r`n"
  }
  $endsWithNewline = $baseParityText.EndsWith("`n", [StringComparison]::Ordinal)
  $lines = [string[]]($baseParityText -split "`r?`n")
  if ($endsWithNewline -and $lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
    $lines = [string[]]$lines[0..($lines.Count - 2)]
  }

  $rowIndexById = @{}
  $initialStatusById = @{}
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $m = [regex]::Match($lines[$i], '^\|\s*(P\d+-\d+|W-\d+)\s*\|')
    if (-not $m.Success) { continue }
    $cells = [regex]::Split($lines[$i], '(?<!\\)\|')
    if ($cells.Count -lt 6) { continue }
    $rowId = $m.Groups[1].Value.Trim().ToUpperInvariant()
    $rowIndexById[$rowId] = $i
    $initialStatusById[$rowId] = $cells[3].Trim().Trim('`').Trim().ToLowerInvariant()
  }

  $appliedKeys = @{}
  $skippedReasons = @{}
  $removeKeys = @{}
  $appliedSummaryLines = New-Object Collections.Generic.List[string]
  $appliedCount = 0

  foreach ($entry in $unsynced) {
    $key = Get-EntryKey $entry
    $prNum = 0
    try { $prNum = [int](Get-JsonProp $entry 'pr') } catch { $prNum = 0 }
    $sha = ([string](Get-JsonProp $entry 'sha')).Trim()
    $sha7 = if ($sha.Length -gt 7) { $sha.Substring(0, 7) } elseif (-not [string]::IsNullOrWhiteSpace($sha)) { $sha } else { 'unknown' }
    $id = ([string](Get-JsonProp $entry 'id')).Trim().ToUpperInvariant()
    $rawStatus = ([string](Get-JsonProp $entry 'status')).Trim()
    $notes = ([string](Get-JsonProp $entry 'notes')).Trim()

    if ($id -notmatch '^(?:P\d+-\d+|W-\d+)$' -or -not $rowIndexById.ContainsKey($id)) {
      Write-Log ('skipping unknown parity ID "' + $id + '" from PR #' + $prNum)
      $skippedReasons[$key] = 'unknown id'
      continue
    }

    $origStatus = [string]$initialStatusById[$id]
    if ($origStatus -match '^(?:done|deferred)\b') {
      Write-Log ('skipping parity ID ' + $id + ' from PR #' + $prNum + ' (row status is already "' + $origStatus + '")')
      $skippedReasons[$key] = ('protected row status: ' + $origStatus)
      continue
    }

    if ($rawStatus -match '(?i)^(?:done|deferred)\b' -or $rawStatus -notmatch $script:AllowedParityStatusPattern) {
      Write-Log ('skipping parity ID ' + $id + ' from PR #' + $prNum + ' (disallowed status "' + (ConvertTo-SingleLine $rawStatus 80) + '")')
      $skippedReasons[$key] = ('disallowed status: ' + (ConvertTo-SingleLine $rawStatus 60))
      continue
    }

    $normStatus = Normalize-ParityStatus $rawStatus
    if ($normStatus -match '(?i)^(?:done|deferred)\b') {
      Write-Log ('skipping parity ID ' + $id + ' from PR #' + $prNum + ' (disallowed normalized status "' + $normStatus + '")')
      $skippedReasons[$key] = 'disallowed status'
      continue
    }

    $rowIdx = [int]$rowIndexById[$id]
    $cells = [regex]::Split($lines[$rowIdx], '(?<!\\)\|')
    if ($cells.Count -lt 6) {
      Write-Log ('skipping parity ID ' + $id + ' from PR #' + $prNum + ' (unexpected table column count)')
      $skippedReasons[$key] = 'unexpected row format'
      continue
    }

    $notesIdx = $cells.Count - 2
    $existingNotes = $cells[$notesIdx].Trim()
    $prTag = ''
    if ($prNum -gt 0) { $prTag = '(#' + $prNum + ')' }
    if (-not [string]::IsNullOrWhiteSpace($prTag) -and $existingNotes.IndexOf($prTag, [StringComparison]::Ordinal) -ge 0) {
      Write-Log ('skipping parity ID ' + $id + ' from PR #' + $prNum + ' (tag ' + $prTag + ' already present in Notes)')
      $removeKeys[$key] = $true
      continue
    }

    $cells[3] = ' `' + $normStatus + '` '

    $cleanNotes = [regex]::Replace($notes, '[\r\n]+', ' ')
    $cleanNotes = [regex]::Replace($cleanNotes, '\s+', ' ').Trim()
    $cleanNotes = [regex]::Replace($cleanNotes, '(?<!\\)\|', '\|')

    $addition = $prTag
    if (-not [string]::IsNullOrWhiteSpace($cleanNotes)) {
      if ([string]::IsNullOrWhiteSpace($addition)) {
        $addition = $cleanNotes
      } else {
        $addition = $addition + ' ' + $cleanNotes
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($addition)) {
      if ([string]::IsNullOrWhiteSpace($existingNotes)) {
        $cells[$notesIdx] = ' ' + $addition + ' '
      } else {
        $cells[$notesIdx] = ' ' + $existingNotes + ' ' + $addition + ' '
      }
    }

    $lines[$rowIdx] = ($cells -join '|')
    $appliedKeys[$key] = $true
    $appliedCount++
    if ($prNum -gt 0) {
      $null = $appliedSummaryLines.Add('- #' + $prNum + ' (`' + $sha7 + '`): `Parity: ' + $id + ' -> ' + $normStatus + '`')
    } else {
      $null = $appliedSummaryLines.Add('- (`' + $sha7 + '`): `Parity: ' + $id + ' -> ' + $normStatus + '`')
    }
  }

  if ($appliedCount -eq 0) {
    Write-Log ('no applicable parity updates out of ' + $unsynced.Count + ' pending entry(s); nothing to commit')
    if (-not $DryRun -and ($skippedReasons.Count -gt 0 -or $removeKeys.Count -gt 0)) {
      Update-PendingFileState -AppliedKeys @{} -SyncPrNumber 0 -SkippedReasons $skippedReasons -RemoveKeys $removeKeys
    }
    exit 0
  }

  $prBodyLines = New-Object Collections.Generic.List[string]
  $null = $prBodyLines.Add('Batch sync of `docs/parity.md` statuses from merged feature PRs.')
  $null = $prBodyLines.Add('')
  $null = $prBodyLines.Add('### Applied updates')
  $null = $prBodyLines.Add('')
  foreach ($sLine in $appliedSummaryLines) {
    $null = $prBodyLines.Add($sLine)
  }
  $prBodyText = ($prBodyLines.ToArray() -join "`n") + "`n"

  if ($DryRun) {
    Write-Log ('dry-run: would sync ' + $appliedCount + ' parity entry(s) (' + $skippedReasons.Count + ' skipped, ' + $removeKeys.Count + ' already in Notes): ' + (ConvertTo-SingleLine ($appliedSummaryLines.ToArray() -join '; ') 400))
    exit 0
  }

  $updatedText = ($lines -join $newline)
  if ($endsWithNewline) { $updatedText += $newline }
  $parityPath = Join-Path $script:RepoDir 'docs\parity.md'
  Write-Text $parityPath $updatedText

  $diffNames = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' diff --name-only')
  if ($diffNames.exitCode -ne 0) {
    throw ('git diff --name-only failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $diffNames) 220))
  }
  $changed = @(([string]$diffNames.text) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($changed.Count -eq 0) {
    Write-Log 'docs/parity.md had no net diff after applying entries; nothing to commit'
    if ($skippedReasons.Count -gt 0 -or $removeKeys.Count -gt 0) {
      Update-PendingFileState -AppliedKeys @{} -SyncPrNumber 0 -SkippedReasons $skippedReasons -RemoveKeys $removeKeys
    }
    exit 0
  }

  $addRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' add -- docs/parity.md')
  if ($addRes.exitCode -ne 0) {
    throw ('git add docs/parity.md failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $addRes) 220))
  }

  $gitIdentityArgs = ''
  $nameCheck = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' config user.name')
  $emailCheck = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' config user.email')
  if ($nameCheck.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$nameCheck.text)) {
    $gitIdentityArgs += ' -c user.name="Tivano Parity Sync"'
  }
  if ($emailCheck.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$emailCheck.text)) {
    $gitIdentityArgs += ' -c user.email="noreply@users.noreply.github.com"'
  }

  $commitMsg = 'Parity: sync statuses from merged PRs'
  $commitRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + $gitIdentityArgs + ' commit -m ' + (Quote-Argument $commitMsg))
  if ($commitRes.exitCode -ne 0) {
    throw ('git commit failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $commitRes) 220))
  }

  $pushRes = Invoke-Git ('-C ' + (Quote-Argument $script:RepoDir) + ' push -u origin ' + $branchName)
  if ($pushRes.exitCode -ne 0) {
    throw ('git push failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $pushRes) 220))
  }

  $bodyFile = Join-Path $script:SyncRoot ('pr-body-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
  $createdPrNum = 0
  try {
    Write-Text $bodyFile $prBodyText
    $createArgs = 'pr create -R ' + $Repo + ' --base main --head ' + $branchName +
      ' --title ' + (Quote-Argument 'Parity: sync statuses from merged PRs') +
      ' --body-file ' + (Quote-Argument $bodyFile)
    $createRes = Invoke-Gh $createArgs
    if ($createRes.exitCode -ne 0) {
      throw ('gh pr create failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $createRes) 240))
    }
    $urlMatch = [regex]::Match(([string]$createRes.text), '/pull/([0-9]+)')
    if ($urlMatch.Success) {
      $createdPrNum = [int]$urlMatch.Groups[1].Value
    } else {
      $lookupRes = Invoke-Gh ('pr list -R ' + $Repo + ' --head ' + $branchName + ' --state open --limit 5 --json number')
      if ($lookupRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$lookupRes.text)) {
        try {
          $found = @($lookupRes.text | ConvertFrom-Json | Where-Object { $null -ne $_ })
          if ($found.Count -gt 0) { $createdPrNum = [int](Get-JsonProp $found[0] 'number') }
        } catch { }
      }
    }
  } finally {
    Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
  }

  if ($createdPrNum -le 0) {
    throw ('created parity-sync PR on branch ' + $branchName + ' but could not resolve its PR number')
  }

  Update-PendingFileState -AppliedKeys $appliedKeys -SyncPrNumber $createdPrNum -SkippedReasons $skippedReasons -RemoveKeys $removeKeys
  Write-Log ('opened parity-sync PR #' + $createdPrNum + ' (' + $branchName + ') with ' + $appliedCount + ' applied entry(s), ' + $skippedReasons.Count + ' skipped, ' + $removeKeys.Count + ' already in Notes')
  exit 0
} catch {
  Write-Log ('parity-sync error: ' + (ConvertTo-SingleLine $_.Exception.Message 260))
  [Console]::Error.WriteLine('Sync-ParityChecklist failed: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($mutexHeld -and $null -ne $mutex) {
    try { $mutex.ReleaseMutex() } catch { }
  }
  if ($null -ne $mutex) {
    try { $mutex.Dispose() } catch { }
  }
}
