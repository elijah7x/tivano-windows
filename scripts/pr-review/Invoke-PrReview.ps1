# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-PrReview.ps1 -Root <state root outside any git checkout> -Checkout <clone used only for worktrees> -StandardCredentialFile <file> [-TokenFile <file>] [-Reference <macOS baseline clone>] [-BaseCacheRoot <cache dir>] [-DryRun] [-PrNumber <n> [-Force]]
# One polling pass. Writes a one-line JSON summary to stdout and <Root>\last-run.json, and <run dir>\gate.json per reviewed PR.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root,
  [string]$Checkout,
  [string]$StandardCredentialFile,
  [string]$TokenFile,
  [string]$Reference,
  [string]$BaseCacheRoot = 'C:\tivano\dev-loop\autopilot\base-cache',
  [string]$DevinModel = 'swe-2-high',
  [ValidateRange(1, 20)][int]$MaxPerRun = 1,
  [switch]$DryRun,
  [int]$PrNumber = 0,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Shared path validation: rejects UNC/device paths, junctions and short-name aliases.
. (Join-Path $PSScriptRoot '..\windows-acceptance\Invoke-InteractiveSession.ps1')

$script:GitPath = $null
$script:GhPath = $null
$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:StandardScript = Join-Path $PSScriptRoot '..\windows-acceptance\Invoke-AsStandardUser.ps1'
$script:RunChecks = Join-Path $PSScriptRoot 'run-checks.cmd'
$script:PromptTemplate = Join-Path $PSScriptRoot 'review-prompt.md'
$script:RunInstanceId = ([string]$PID) + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)

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

# Raw-byte redirection: git and gh write UTF-8, which PowerShell 5.1 would otherwise decode with the console code page.
function Invoke-Tool {
  param([string]$FilePath, [string]$Arguments, [string]$OutPath, [string]$ErrPath)
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -RedirectStandardOutput $OutPath `
    -RedirectStandardError $ErrPath -WindowStyle Hidden -Wait -PassThru
  return $process.ExitCode
}

function Invoke-Git {
  param([string]$Arguments)
  $out = Join-Path $script:WorkRoot ('.git.' + $script:RunInstanceId + '.out.tmp')
  $err = Join-Path $script:WorkRoot ('.git.' + $script:RunInstanceId + '.err.tmp')
  try {
    $code = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Checkout) + ' ' + $Arguments) $out $err
    return [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
  } finally {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $err -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Gh {
  param([string]$Arguments, [string]$OutPath, [string]$ErrPath)
  return Invoke-Tool $script:GhPath $Arguments $OutPath $ErrPath
}

function Assert-OutsideGitCheckout {
  param([string]$Path)
  $part = $Path
  while ($part) {
    if (Test-Path -LiteralPath (Join-Path $part '.git')) {
      throw "$Path is inside a git checkout ($part). Keep state and worktrees outside any checkout."
    }
    $parent = Split-Path -Parent $part
    if (-not $parent -or $parent -eq $part) { break }
    $part = $parent
  }
}

function Read-State {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ prs = @{} } }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return @{ prs = @{} } }
  $state = @{ prs = @{} }
  try { $data = $text | ConvertFrom-Json } catch { return $state }
  if (-not $data -or -not $data.PSObject.Properties['prs']) { return $state }
  foreach ($entry in $data.prs.PSObject.Properties) {
    $reviewed = @()
    $attempts = @{}
    if ($entry.Value.PSObject.Properties['reviewed']) { $reviewed = @($entry.Value.reviewed | ForEach-Object { [string]$_ }) }
    if ($entry.Value.PSObject.Properties['attempts']) {
      foreach ($attempt in $entry.Value.attempts.PSObject.Properties) { $attempts[$attempt.Name] = [int]$attempt.Value }
    }
    $state.prs[$entry.Name] = @{ reviewed = $reviewed; attempts = $attempts }
  }
  return $state
}

function Invoke-WithNamedMutex {
  param([string]$Name, [int]$TimeoutMs, [scriptblock]$Action)
  $mutex = New-Object System.Threading.Mutex($false, $Name)
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne($TimeoutMs)
    } catch [System.Threading.AbandonedMutexException] {
      # Previous holder terminated abnormally; ownership now belongs to this process.
      $acquired = $true
    }
    if (-not $acquired) {
      throw ('Timed out waiting for mutex ' + $Name + ' after ' + [string]([int]($TimeoutMs / 1000)) + 's.')
    }
    return (& $Action)
  } finally {
    if ($acquired) {
      try { $mutex.ReleaseMutex() } catch { }
    }
    $mutex.Dispose()
  }
}

function Test-BaseStepsReliable {
  # Reuse a baseline when install, build, typecheck and e2e all passed and unit completed without timeout (124),
  # even if unit exited non-zero, provided vitest.json parses with entries.
  param($Steps, [bool]$AllowSkippedE2e = $false)
  if ($null -eq $Steps) { return $false }
  if (-not $AllowSkippedE2e -and $Steps.PSObject.Properties['e2eSkipped'] -and $Steps.e2eSkipped -eq $true) {
    return $false
  }
  foreach ($name in @('install', 'build', 'typecheck', 'e2e')) {
    $prop = $Steps.PSObject.Properties[$name]
    if (-not $prop -or $null -eq $prop.Value) { return $false }
    if ([int]$prop.Value -ne 0) { return $false }
  }
  $unitProp = $Steps.PSObject.Properties['unit']
  if (-not $unitProp -or $null -eq $unitProp.Value) { return $false }
  try {
    $unitCode = [int]$unitProp.Value
  } catch {
    return $false
  }
  if ($unitCode -eq 124) { return $false }
  return $true
}

function Test-BaseSummaryReliable {
  param($Summary)
  if ($null -eq $Summary) { return $false }
  $exitProp = $Summary.PSObject.Properties['exitCode']
  if (-not $exitProp -or $null -eq $exitProp.Value) { return $false }
  try {
    if ([int]$exitProp.Value -ne 0) { return $false }
  } catch {
    return $false
  }
  $errProp = $Summary.PSObject.Properties['error']
  if ($errProp -and -not [string]::IsNullOrWhiteSpace([string]$errProp.Value)) { return $false }
  return $true
}

function Invoke-WithCheckSlot {
  param([scriptblock]$Action, [int]$TimeoutMs = 7200000)
  $slotCount = 2
  $rawSlots = $env:TIVANO_GATE_CHECK_SLOTS
  if (-not [string]::IsNullOrWhiteSpace($rawSlots)) {
    $parsedSlots = 0
    if ([int]::TryParse($rawSlots.Trim(), [ref]$parsedSlots) -and ($parsedSlots -eq 1 -or $parsedSlots -eq 2)) {
      $slotCount = $parsedSlots
    }
  }
  $mutexes = New-Object Collections.Generic.List[System.Threading.Mutex]
  $acquiredIndex = -1
  try {
    for ($slot = 1; $slot -le $slotCount; $slot++) {
      $null = $mutexes.Add((New-Object System.Threading.Mutex($false, ('Global\TivanoUntrustedChecks-' + $slot))))
    }
    for ($i = 0; $i -lt $mutexes.Count; $i++) {
      try {
        if ($mutexes[$i].WaitOne(0)) {
          $acquiredIndex = $i
          break
        }
      } catch [System.Threading.AbandonedMutexException] {
        # Previous holder terminated abnormally; ownership now belongs to this process.
        $acquiredIndex = $i
        break
      }
    }
    if ($acquiredIndex -lt 0) {
      [System.Threading.WaitHandle[]]$handles = $mutexes.ToArray()
      try {
        $waitIndex = [System.Threading.WaitHandle]::WaitAny($handles, $TimeoutMs)
        if ($waitIndex -ne [System.Threading.WaitHandle]::WaitTimeout -and $waitIndex -ge 0 -and $waitIndex -lt $handles.Length) {
          $acquiredIndex = $waitIndex
        }
      } catch [System.Threading.AbandonedMutexException] {
        # Previous holder terminated abnormally; ownership of the abandoned slot now belongs to this process.
        $abandoned = $_.Exception
        while ($null -ne $abandoned -and $abandoned -isnot [System.Threading.AbandonedMutexException]) {
          $abandoned = $abandoned.InnerException
        }
        if ($null -ne $abandoned -and $abandoned.MutexIndex -ge 0 -and $abandoned.MutexIndex -lt $handles.Length) {
          $acquiredIndex = $abandoned.MutexIndex
        } elseif ($null -ne $abandoned -and $null -ne $abandoned.Mutex) {
          for ($j = 0; $j -lt $handles.Length; $j++) {
            if ([object]::ReferenceEquals($handles[$j], $abandoned.Mutex)) {
              $acquiredIndex = $j
              break
            }
          }
        }
      }
    }
    if ($acquiredIndex -lt 0) {
      throw ('Timed out waiting for a check slot (slots=' + $slotCount + ') after ' + [string]([int]($TimeoutMs / 1000)) + 's.')
    }
    return (& $Action)
  } finally {
    if ($acquiredIndex -ge 0 -and $acquiredIndex -lt $mutexes.Count) {
      try { $mutexes[$acquiredIndex].ReleaseMutex() } catch { }
    }
    foreach ($m in $mutexes) {
      if ($null -ne $m) {
        try { $m.Dispose() } catch { }
      }
    }
  }
}

function Invoke-WithUntrustedChecksLock {
  # Cap concurrent untrusted check runs via named slot mutexes (default 2, configurable via TIVANO_GATE_CHECK_SLOTS).
  param([scriptblock]$Action)
  return (Invoke-WithCheckSlot -Action $Action -TimeoutMs 7200000)
}

function Invoke-WithStateLock {
  param([scriptblock]$Action)
  return (Invoke-WithNamedMutex 'Global\TivanoPrReviewState' 120000 $Action)
}

function Invoke-WithGitLock {
  param([scriptblock]$Action)
  return (Invoke-WithNamedMutex 'Global\TivanoPrReviewGit' 120000 $Action)
}

function Save-State {
  param([string]$Path, $State)
  $temporary = $Path + '.' + $script:RunInstanceId + '.tmp'
  Write-Text $temporary ((ConvertTo-Json -InputObject $State -Depth 8) + "`n")
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (Test-Path -LiteralPath $Path -PathType Leaf) {
        # PowerShell turns $null into an empty string for a string parameter; File.Replace needs a real null.
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
      if (Test-Path -LiteralPath $temporary -PathType Leaf) {
        [IO.File]::Delete($temporary)
      }
    } catch { }
    return
  } catch {
    $fallbackErr = $_
    try {
      if (Test-Path -LiteralPath $temporary -PathType Leaf) {
        [IO.File]::Delete($temporary)
      }
    } catch { }
    throw $fallbackErr
  }
}

function Get-StateEntry {
  param($State, [string]$Key)
  if (-not $State.prs.ContainsKey($Key)) { $State.prs[$Key] = @{ reviewed = @(); attempts = @{} } }
  return $State.prs[$Key]
}

function Resolve-StandardAccountSid {
  param([string]$CredentialFile)
  $path = Get-AcceptancePath $CredentialFile
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '-StandardCredentialFile does not exist.' }
  $name = $null
  if ($path.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) {
    $stored = Read-Text $path | ConvertFrom-Json
    $name = [string]$stored.user
  } else {
    try {
      $name = (Import-Clixml -LiteralPath $path).UserName
    } catch {
      # Export-Clixml protects the password with user-scope DPAPI, which a key-authenticated
      # SSH session cannot unlock; the account name itself is plain XML.
      $match = [regex]::Match((Read-Text $path), '<S N="UserName">([^<]*)</S>')
      if ($match.Success) { $name = [Net.WebUtility]::HtmlDecode($match.Groups[1].Value) }
    }
  }
  if ([string]::IsNullOrWhiteSpace($name)) { throw 'Cannot read the standard account name from -StandardCredentialFile.' }
  $qualified = $name
  if ($name.IndexOf('\') -lt 0) { $qualified = "$env:COMPUTERNAME\$name" }
  return [Security.Principal.NTAccount]::new($qualified).Translate([Security.Principal.SecurityIdentifier]).Value
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

function Get-VitestReport {
  param([string]$Path, [string]$Root)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { $data = $text | ConvertFrom-Json } catch { return $null }
  if ($data -isnot [pscustomobject] -or -not $data.PSObject.Properties['testResults']) { return $null }
  $map = @{}
  $prefix = $null
  if (-not [string]::IsNullOrWhiteSpace($Root)) {
    $prefix = ($Root.TrimEnd('\') + '\').Replace('\', '/').ToLowerInvariant()
  }
  foreach ($file in @($data.testResults)) {
    if (-not $file) { continue }
    # Key by worktree-relative file and full name: the same name can occur in several files.
    $fileName = ([string]$file.name).Replace('\', '/')
    if ($prefix -and $fileName.ToLowerInvariant().StartsWith($prefix)) {
      $fileName = $fileName.Substring($prefix.Length)
    } else {
      # Cached base results carry the original run's sandbox worktree path; normalize to repo-relative.
      $sandboxMatch = [regex]::Match($fileName, '(?i)/sandbox/(?:base|pr)(?:-[^/]+)?/')
      if ($sandboxMatch.Success) {
        $fileName = $fileName.Substring($sandboxMatch.Index + $sandboxMatch.Length)
      }
    }
    $failedAssertionCount = 0
    foreach ($result in @($file.assertionResults)) {
      if (-not $result) { continue }
      $fullName = [string]$result.fullName
      $status = [string]$result.status
      if ($fullName) {
        $map[$fileName + ' > ' + $fullName] = $status
        if ($status -eq 'failed') { $failedAssertionCount++ }
      }
    }
    if ($failedAssertionCount -eq 0 -and [string]$file.status -eq 'failed' -and $fileName) {
      $firstLine = ''
      $rawMsg = [string]$file.message
      if (-not [string]::IsNullOrWhiteSpace($rawMsg)) {
        $cleanMsg = [regex]::Replace($rawMsg, '\x1b\[[0-9;]*[A-Za-z]', '')
        foreach ($msgLine in @($cleanMsg -split "`r?`n")) {
          $trimmedLine = $msgLine.Trim()
          if ($trimmedLine) { $firstLine = $trimmedLine; break }
        }
      }
      if ($firstLine) {
        # Normalize worktree/sandbox paths inside the error line so base and pr keys match.
        $firstLine = [regex]::Replace($firstLine, '(?i)[A-Za-z]:[/\\][^"''\s]*[/\\]sandbox[/\\](?:base|pr)(?:-[^/\\]+)?[/\\]', '')
        if ($firstLine.Length -gt 200) { $firstLine = $firstLine.Substring(0, 200).Trim() }
      } else {
        $firstLine = 'unknown error'
      }
      $map[$fileName + ' > (file failed: ' + $firstLine + ')'] = 'failed'
    }
  }
  $passed = 0
  $failed = 0
  $skipped = 0
  if ($null -ne $data.numPassedTests) { $passed = [int]$data.numPassedTests }
  if ($null -ne $data.numFailedTests) { $failed = [int]$data.numFailedTests }
  if ($null -ne $data.numPendingTests) { $skipped = [int]$data.numPendingTests }
  return [pscustomobject]@{ path = $Path; map = $map; passed = $passed; failed = $failed; skipped = $skipped }
}

function Copy-RunOutput {
  param([string]$From, [string]$To)
  [IO.Directory]::CreateDirectory($To) | Out-Null
  if (Test-Path -LiteralPath $From -PathType Container) {
    Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Resolve-BaseCacheRoot {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  try {
    $resolved = Get-AcceptancePath $Path
    Assert-OutsideGitCheckout $resolved
    return $resolved
  } catch {
    return $null
  }
}

function Test-DocsOrTestsOnlyFiles {
  param([string[]]$Files)
  if ($null -eq $Files -or $Files.Count -eq 0) { return $false }
  foreach ($file in $Files) {
    if ([string]::IsNullOrWhiteSpace($file)) { return $false }
    $norm = $file.Trim().Replace('\', '/')
    while ($norm.StartsWith('./', [StringComparison]::Ordinal)) {
      $norm = $norm.Substring(2)
    }
    if ([string]::IsNullOrWhiteSpace($norm) -or $norm.StartsWith('/', [StringComparison]::Ordinal)) { return $false }
    foreach ($seg in @($norm -split '/')) {
      if ($seg -eq '..' -or $seg -eq '') { return $false }
    }
    $isDocs = $norm.StartsWith('docs/', [StringComparison]::OrdinalIgnoreCase)
    $isTests = $norm.StartsWith('tests/', [StringComparison]::OrdinalIgnoreCase)
    $isMarkdown = $norm.EndsWith('.md', [StringComparison]::OrdinalIgnoreCase)
    if (-not ($isDocs -or $isTests -or $isMarkdown)) {
      return $false
    }
  }
  return $true
}

function Get-PrChangedFilesForReview {
  param([string]$MergeBase, [string]$HeadSha)
  if ([string]::IsNullOrWhiteSpace($MergeBase) -or [string]::IsNullOrWhiteSpace($HeadSha)) { return @() }
  $diffRes = Invoke-Git ('-c core.quotepath=false diff --no-renames --name-only ' + $MergeBase + '..' + $HeadSha)
  if ($diffRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($diffRes.text)) { return @() }
  $files = New-Object Collections.Generic.List[string]
  foreach ($line in @($diffRes.text -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed) { $null = $files.Add($trimmed) }
  }
  return [string[]]$files.ToArray()
}

function Prune-BaseCache {
  param([string]$CacheRoot, [int]$KeepCount = 20)
  if ([string]::IsNullOrWhiteSpace($CacheRoot) -or -not (Test-Path -LiteralPath $CacheRoot -PathType Container)) { return }
  try {
    $entries = @(Get-ChildItem -LiteralPath $CacheRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^[0-9a-fA-F]{40}(-noe2e)?$' } |
      Sort-Object -Property LastWriteTimeUtc -Descending)
    if ($entries.Count -le $KeepCount) { return }
    for ($i = $KeepCount; $i -lt $entries.Count; $i++) {
      try {
        Remove-Item -LiteralPath $entries[$i].FullName -Recurse -Force -ErrorAction SilentlyContinue
      } catch { }
    }
  } catch { }
}

function Restore-BaseCacheEntry {
  param([string]$EntryDir, [string]$MergeBase, [string]$ResultsDest, [string]$ChecksDest, [bool]$AllowSkippedE2e)
  $markerPath = Join-Path $EntryDir 'complete.json'
  $cachedResults = Join-Path $EntryDir 'results-base'
  $cachedChecks = Join-Path $EntryDir 'checks-base'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath $cachedResults -PathType Container)) { return $false }
  if (-not (Test-Path -LiteralPath $cachedChecks -PathType Container)) { return $false }
  $markerText = Read-Text $markerPath
  if ([string]::IsNullOrWhiteSpace($markerText)) { return $false }
  $marker = $null
  try { $marker = $markerText | ConvertFrom-Json } catch { return $false }
  if ($null -eq $marker -or -not $marker.PSObject.Properties['sha']) { return $false }
  if ([string]$marker.sha -ne $MergeBase) { return $false }
  $cachedSteps = $null
  try { $cachedSteps = Get-Content -LiteralPath (Join-Path $cachedResults 'steps.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
  $entryE2eSkipped = $false
  if ($marker.PSObject.Properties['e2eSkipped'] -and $marker.e2eSkipped -eq $true) { $entryE2eSkipped = $true }
  if ($cachedSteps -and $cachedSteps.PSObject.Properties['e2eSkipped'] -and $cachedSteps.e2eSkipped -eq $true) { $entryE2eSkipped = $true }
  if ($entryE2eSkipped -and -not $AllowSkippedE2e) { return $false }
  $cachedSummary = Get-StandardSummary $cachedChecks
  $cachedVitest = Get-VitestReport (Join-Path $cachedResults 'vitest.json') ''
  if (-not (Test-BaseStepsReliable $cachedSteps $AllowSkippedE2e) -or -not (Test-BaseSummaryReliable $cachedSummary) -or $null -eq $cachedVitest -or $cachedVitest.map.Count -eq 0) {
    Remove-Item -LiteralPath $EntryDir -Recurse -Force -ErrorAction SilentlyContinue
    return $false
  }

  if (Test-Path -LiteralPath $ResultsDest) { Remove-Item -LiteralPath $ResultsDest -Recurse -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $ChecksDest) { Remove-Item -LiteralPath $ChecksDest -Recurse -Force -ErrorAction Stop }
  [IO.Directory]::CreateDirectory($ResultsDest) | Out-Null
  [IO.Directory]::CreateDirectory($ChecksDest) | Out-Null
  Copy-Item -Path (Join-Path $cachedResults '*') -Destination $ResultsDest -Recurse -Force -ErrorAction Stop
  Copy-Item -Path (Join-Path $cachedChecks '*') -Destination $ChecksDest -Recurse -Force -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $ResultsDest 'steps.json') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ChecksDest 'summary.json') -PathType Leaf)) {
    throw 'cached base entry is missing steps.json or summary.json'
  }
  return $true
}

function Restore-BaseCache {
  param([string]$CacheRoot, [string]$MergeBase, [string]$RunDir, [bool]$AllowSkippedE2e = $false)
  if ([string]::IsNullOrWhiteSpace($CacheRoot)) { return $false }
  if ([string]::IsNullOrWhiteSpace($MergeBase) -or $MergeBase -notmatch '^[0-9a-fA-F]{40}$') { return $false }
  $resultsDest = Join-Path $RunDir 'results-base'
  $checksDest = Join-Path $RunDir 'checks-base'
  $candidates = @((Join-Path $CacheRoot $MergeBase))
  if ($AllowSkippedE2e) {
    $candidates += (Join-Path $CacheRoot ($MergeBase + '-noe2e'))
  }
  foreach ($entryDir in $candidates) {
    try {
      if (Restore-BaseCacheEntry $entryDir $MergeBase $resultsDest $checksDest $AllowSkippedE2e) {
        return $true
      }
    } catch {
      try {
        if (Test-Path -LiteralPath $resultsDest) { Remove-Item -LiteralPath $resultsDest -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $checksDest) { Remove-Item -LiteralPath $checksDest -Recurse -Force -ErrorAction SilentlyContinue }
      } catch { }
    }
  }
  return $false
}

function Publish-BaseCache {
  param([string]$CacheRoot, [string]$MergeBase, [string]$ResultsBaseDir, [string]$ChecksBaseDir, [int]$KeepCount = 20, [bool]$E2eSkipped = $false)
  if ([string]::IsNullOrWhiteSpace($CacheRoot)) { return }
  if ([string]::IsNullOrWhiteSpace($MergeBase) -or $MergeBase -notmatch '^[0-9a-fA-F]{40}$') { return }
  if (-not (Test-Path -LiteralPath $ResultsBaseDir -PathType Container)) { return }
  if (-not (Test-Path -LiteralPath $ChecksBaseDir -PathType Container)) { return }
  $tempDir = $null
  try {
    [IO.Directory]::CreateDirectory($CacheRoot) | Out-Null
    $entryKey = if ($E2eSkipped) { $MergeBase + '-noe2e' } else { $MergeBase }
    $finalDir = Join-Path $CacheRoot $entryKey
    if (-not (Test-Path -LiteralPath $finalDir -PathType Container)) {
      $tempDir = Join-Path $CacheRoot ('.tmp-' + $entryKey + '-' + $script:RunInstanceId)
      $tempResults = Join-Path $tempDir 'results-base'
      $tempChecks = Join-Path $tempDir 'checks-base'
      [IO.Directory]::CreateDirectory($tempResults) | Out-Null
      [IO.Directory]::CreateDirectory($tempChecks) | Out-Null
      Copy-Item -Path (Join-Path $ResultsBaseDir '*') -Destination $tempResults -Recurse -Force -ErrorAction Stop
      Copy-Item -Path (Join-Path $ChecksBaseDir '*') -Destination $tempChecks -Recurse -Force -ErrorAction Stop
      $marker = [ordered]@{
        sha = $MergeBase
        e2eSkipped = $E2eSkipped
        createdAt = [DateTime]::UtcNow.ToString('o')
      }
      Write-Text (Join-Path $tempDir 'complete.json') ((ConvertTo-Json -InputObject $marker -Depth 3 -Compress) + "`n")
      try {
        [IO.Directory]::Move($tempDir, $finalDir)
        $tempDir = $null
      } catch {
        # Another process already published this mergeBase; discard our staging directory.
      }
    }
    Prune-BaseCache $CacheRoot $KeepCount
  } catch {
    # Never let a cache error fail the gate.
  } finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir -PathType Container)) {
      try { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
}

function Get-Steps {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Get-StandardSummary {
  param([string]$ChecksDir)
  $text = Read-Text (Join-Path $ChecksDir 'summary.json')
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Add-BulletList {
  param($Lines, [string]$Title, [string[]]$Items)
  $null = $Lines.Add('## ' + $Title)
  if (-not $Items -or $Items.Count -eq 0) {
    $null = $Lines.Add('none')
    $null = $Lines.Add('')
    return
  }
  $limit = [Math]::Min(50, $Items.Count)
  for ($i = 0; $i -lt $limit; $i++) { $null = $Lines.Add('- ' + $Items[$i]) }
  if ($Items.Count -gt $limit) { $null = $Lines.Add('- ... and ' + ($Items.Count - $limit) + ' more not listed') }
  $null = $Lines.Add('')
}

function Invoke-StandardChecks {
  param(
    [string]$Label,
    [string]$ChecksDir,
    [string]$ResultsDir,
    [string]$Worktree,
    [string]$RunDir,
    [string]$BinDir,
    [bool]$SkipE2e = $false
  )
  # Invoke-AsStandardUser runs via a Scheduled Task under the standard account, so process env vars from
  # Invoke-PrReview.ps1 are not inherited. A read-only per-run cmd wrapper in $BinDir forwards the check env
  # flags into run-checks.cmd, and the PowerShell wrapper passes the argv array to Invoke-AsStandardUser.
  $cmdWrapperPath = Join-Path $BinDir ("run-$Label.cmd")
  $cmdLines = New-Object Collections.Generic.List[string]
  $null = $cmdLines.Add('@echo off')
  $null = $cmdLines.Add('rem Generated for one check run by Invoke-PrReview.ps1.')
  $null = $cmdLines.Add('setlocal DisableDelayedExpansion')
  if ($SkipE2e) {
    $null = $cmdLines.Add('set "TIVANO_GATE_SKIP_E2E=1"')
  } else {
    $null = $cmdLines.Add('set "TIVANO_GATE_SKIP_E2E="')
  }
  $rawWorkers = $env:TIVANO_GATE_VITEST_WORKERS
  if (-not [string]::IsNullOrWhiteSpace($rawWorkers) -and $rawWorkers.Trim() -match '^[1-9][0-9]*$') {
    $null = $cmdLines.Add('set "TIVANO_GATE_VITEST_WORKERS=' + $rawWorkers.Trim() + '"')
  }
  $null = $cmdLines.Add('call ' + (Quote-Argument $script:RunChecks) + ' "%~1" "%~2"')
  $null = $cmdLines.Add('exit /b %ERRORLEVEL%')
  Write-Text $cmdWrapperPath (($cmdLines.ToArray() -join "`r`n") + "`r`n")

  $wrapperPath = Join-Path $RunDir ("standard-$Label.ps1")
  $wrapper = @"
# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Generated for one run by Invoke-PrReview.ps1.
`$ErrorActionPreference = 'Stop'
`$Code = 0
try {
  & $(ConvertTo-PsLiteral $script:StandardScript) -CredentialFile $(ConvertTo-PsLiteral $StandardCredentialFile) -Evidence $(ConvertTo-PsLiteral $ChecksDir) -Command $(ConvertTo-PsLiteral $script:CmdExe) -Arguments @('/d', '/c', $(ConvertTo-PsLiteral $cmdWrapperPath), $(ConvertTo-PsLiteral $Worktree), $(ConvertTo-PsLiteral $ResultsDir)) -WorkingDirectory $(ConvertTo-PsLiteral $Worktree) -TimeoutSec 5400
  `$Code = [int]`$LASTEXITCODE
} catch {
  [Console]::Error.WriteLine(`$_.Exception.Message)
  `$Code = 1
}
exit `$Code
"@
  [IO.File]::WriteAllText($wrapperPath, ($wrapper -replace '\r?\n', "`r`n"), (New-Object Text.UTF8Encoding($true)))

  $stdoutPath = Join-Path $RunDir ("standard-$Label.out.log")
  $stderrPath = Join-Path $RunDir ("standard-$Label.err.log")
  $process = Start-Process -FilePath (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe') `
    -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $wrapperPath)) `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath `
    -WindowStyle Hidden -Wait -PassThru
  return [pscustomobject]@{
    exitCode = $process.ExitCode
    summaryLine = (Get-Tail $stdoutPath 1)
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    summary = (Get-StandardSummary $ChecksDir)
  }
}

function Write-ChecksSummary {
  param([string]$Path, [string]$RunDir, [string]$LabelBase, [string]$LabelPr, $StepsBase, $StepsPr, $ReportBase, $ReportPr, $StandardBase, $StandardPr)
  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('# Check results')
  $null = $lines.Add('')
  $null = $lines.Add('Checks run only under the isolated standard account; nothing here ran as the operating account. A `missing` value means that run did not produce results.')
  $null = $lines.Add('')
  $baseE2eSkipped = [bool]($StepsBase -and $StepsBase.PSObject.Properties['e2eSkipped'] -and $StepsBase.e2eSkipped -eq $true)
  $prE2eSkipped = [bool]($StepsPr -and $StepsPr.PSObject.Properties['e2eSkipped'] -and $StepsPr.e2eSkipped -eq $true)
  if ($baseE2eSkipped -or $prE2eSkipped) {
    $null = $lines.Add('Note: e2e skipped (docs/tests-only change).')
    $null = $lines.Add('')
  }
  $null = $lines.Add('| Step | base | pr |')
  $null = $lines.Add('| --- | --- | --- |')
  foreach ($step in @('install', 'build', 'typecheck', 'unit', 'e2e')) {
    $baseValue = 'missing'
    $prValue = 'missing'
    if ($StepsBase -and $StepsBase.PSObject.Properties[$step]) {
      $baseValue = if ($null -eq $StepsBase.$step) { 'not run' } else { [string]$StepsBase.$step }
      if ($step -eq 'e2e' -and $baseE2eSkipped) { $baseValue += ' (skipped)' }
    }
    if ($StepsPr -and $StepsPr.PSObject.Properties[$step]) {
      $prValue = if ($null -eq $StepsPr.$step) { 'not run' } else { [string]$StepsPr.$step }
      if ($step -eq 'e2e' -and $prE2eSkipped) { $prValue += ' (skipped)' }
    }
    $null = $lines.Add('| ' + $step + ' | ' + $baseValue + ' | ' + $prValue + ' |')
  }
  $null = $lines.Add('')
  $null = $lines.Add('| Suite | passed | failed | skipped |')
  $null = $lines.Add('| --- | --- | --- | --- |')
  foreach ($pair in @(@($LabelBase, $ReportBase), @($LabelPr, $ReportPr))) {
    $label = $pair[0]
    $report = $pair[1]
    if ($report) {
      $null = $lines.Add('| ' + $label + ' | ' + $report.passed + ' | ' + $report.failed + ' | ' + $report.skipped + ' |')
    } else {
      $null = $lines.Add('| ' + $label + ' | missing | missing | missing |')
    }
  }
  $null = $lines.Add('')
  foreach ($pair in @(@($LabelBase, $StandardBase), @($LabelPr, $StandardPr))) {
    $label = $pair[0]
    $standard = $pair[1]
    if ($standard.summary) {
      $detail = 'exitCode ' + $standard.summary.exitCode
      if ($standard.summary.PSObject.Properties['error'] -and $standard.summary.error) { $detail += ' (' + $standard.summary.error + ')' }
      $null = $lines.Add('- Standard-account run ' + $label + ': ' + $detail)
    } else {
      $null = $lines.Add('- Standard-account run ' + $label + ': no summary.json; see ' + (Split-Path -Leaf $standard.stdoutPath))
    }
  }
  $null = $lines.Add('')

  $newFailures = @()
  $fixed = @()
  $absent = @()
  if ($ReportBase -and $ReportPr) {
    foreach ($name in $ReportPr.map.Keys) {
      if ($ReportPr.map[$name] -ne 'failed') { continue }
      if (-not $ReportBase.map.ContainsKey($name)) { $newFailures += ($name + ' (absent in base run)') }
      elseif ($ReportBase.map[$name] -ne 'failed') { $newFailures += $name }
    }
    foreach ($name in $ReportBase.map.Keys) {
      if ($ReportBase.map[$name] -ne 'failed') { continue }
      # Only an explicit pass counts as fixed; a deleted or uncollected test is reported separately.
      if (-not $ReportPr.map.ContainsKey($name)) { $absent += $name }
      elseif ($ReportPr.map[$name] -eq 'passed') { $fixed += $name }
    }
  } elseif (-not $ReportBase -or -not $ReportPr) {
    $missing = @()
    if (-not $ReportBase) { $missing += (Join-Path $RunDir 'results-base\vitest.json') }
    if (-not $ReportPr) { $missing += (Join-Path $RunDir 'results-pr\vitest.json') }
    $null = $lines.Add('Unit-test comparison unavailable: missing ' + ($missing -join ', ') + '.')
    $null = $lines.Add('')
  }
  Add-BulletList $lines 'New failures (fail on pr, pass on base)' $newFailures
  Add-BulletList $lines 'Fixed (fail on base, pass on pr)' $fixed
  Add-BulletList $lines 'Failing on base, absent from the pr run (deleted, renamed or not collected)' $absent

  foreach ($pair in @(@($LabelBase, 'results-base'), @($LabelPr, 'results-pr'))) {
    $label = $pair[0]
    $tail = Get-Tail (Join-Path $RunDir ($pair[1] + '\e2e.log')) 40
    $null = $lines.Add('## e2e log tail (' + $label + ')')
    if ($null -eq $tail) {
      $null = $lines.Add('missing ' + $pair[1] + '\e2e.log')
    } else {
      $null = $lines.Add('```text')
      foreach ($line in ($tail -split "`n")) { $null = $lines.Add($line) }
      $null = $lines.Add('```')
    }
    $null = $lines.Add('')
  }
  Write-Text $Path (($lines -join "`n") + "`n")
  return [pscustomobject]@{
    comparison = [bool]($ReportBase -and $ReportPr)
    newFailures = $newFailures
    fixed = $fixed
    absent = $absent
  }
}

function Get-StepRecord {
  param($Steps)
  $values = @{}
  foreach ($step in @('install', 'build', 'typecheck', 'unit', 'e2e')) {
    $values[$step] = $null
    if ($Steps -and $Steps.PSObject.Properties[$step] -and $null -ne $Steps.$step) { $values[$step] = [int]$Steps.$step }
  }
  $rec = [ordered]@{
    install = $values['install']; build = $values['build']; typecheck = $values['typecheck']
    unit = $values['unit']; e2e = $values['e2e']
  }
  if ($Steps -and $Steps.PSObject.Properties['e2eSkipped'] -and $Steps.e2eSkipped -eq $true) {
    $rec['e2eSkipped'] = $true
  }
  return [pscustomobject]$rec
}

# Loose check of the agent's verdict.json: anything missing, stale or malformed gives $null,
# which a caller must treat as "no usable verdict".
function Get-Verdict {
  param([string]$Path, [DateTime]$NotBefore)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  if ((Get-Item -LiteralPath $Path).LastWriteTimeUtc -lt $NotBefore) { return $null }
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { $data = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { return $null }
  if ($data -isnot [pscustomobject]) { return $null }
  if (-not $data.PSObject.Properties['recommendation'] -or -not $data.PSObject.Properties['blocking']) { return $null }
  $recommendation = ([string]$data.recommendation).Trim().ToLowerInvariant()
  if ($recommendation -ne 'merge' -and $recommendation -ne 'changes') { return $null }
  if ($null -eq $data.blocking) { return $null }
  # A single string is accepted for either list; blank entries are dropped.
  $blocking = @($data.blocking | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  $nonBlocking = @()
  if ($data.PSObject.Properties['nonBlocking'] -and $null -ne $data.nonBlocking) {
    $nonBlocking = @($data.nonBlocking | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  }
  return [pscustomobject]@{ recommendation = $recommendation; blocking = $blocking; nonBlocking = $nonBlocking }
}

function Get-ObjectProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -ne $prop) { return $prop.Value }
  return $null
}

function Test-NonBlockingFindingLine {
  param(
    [string]$Line,
    [string]$SubSection,
    [bool]$IsMerge
  )
  $trimmed = [regex]::Replace($Line, '^\s*[-*]\s+', '')
  # Standard format: "file:line - severity - concrete suggestion" (supports -, --, en-dash, em-dash, |).
  $sevMatch = [regex]::Match(
    $trimmed,
    '^.+?(?:\s+(?:-{1,2}|\u2013|\u2014|\|)\s+|\s*\u2014\s*)(.+?)(?:\s+(?:-{1,2}|\u2013|\u2014|\|)\s+|\s*\u2014\s*)'
  )
  if ($sevMatch.Success) {
    $sev = [regex]::Replace($sevMatch.Groups[1].Value, '[\*\x60\[\]\(\)]', '').Trim()
    if ([regex]::IsMatch($sev, '(?i)\bnon[-\s]?blocking\b')) { return $true }
    if ([regex]::IsMatch($sev, '(?i)\bblocking\b')) { return $false }
    if ([regex]::IsMatch($sev, '(?i)^(low|minor|nit|nitpick|optional|info|informational|advisory|suggestion)\b')) { return $true }
    if ([regex]::IsMatch($sev, '(?i)^(high|critical|major|medium|blocker|error)\b')) { return $false }
  }
  # Prefix format: "[non-blocking] ...", "**non-blocking**: ...", "non-blocking - ..."
  $prefixMatch = [regex]::Match(
    $trimmed,
    '^[\s\*\x60\[\(]*(non[-\s]?blocking|blocking|low|minor|nit|nitpick|optional|info|informational|advisory|suggestion|high|critical|major|medium|blocker)[\s\*\x60\]\)]*(?:[:\-\u2013\u2014]|\s+\()'
  )
  if ($prefixMatch.Success) {
    $tag = $prefixMatch.Groups[1].Value.Trim()
    if ([regex]::IsMatch($tag, '(?i)^non[-\s]?blocking$')) { return $true }
    if ([regex]::IsMatch($tag, '(?i)^blocking$')) { return $false }
    if ([regex]::IsMatch($tag, '(?i)^(low|minor|nit|nitpick|optional|info|informational|advisory|suggestion)$')) { return $true }
    return $false
  }
  # Colon-after-location format: "`file:line`: non-blocking - ..."
  $colonMatch = [regex]::Match(
    $trimmed,
    '^\x60?[^\s\x60]+\x60?:\s*[\*\x60\[\(]*(non[-\s]?blocking|blocking|low|minor|nit|nitpick|optional|info|informational|advisory|suggestion|high|critical|major|medium|blocker)[\s\*\x60\]\)]*(?:[:\-\u2013\u2014]|\s)'
  )
  if ($colonMatch.Success) {
    $tag = $colonMatch.Groups[1].Value.Trim()
    if ([regex]::IsMatch($tag, '(?i)^non[-\s]?blocking$')) { return $true }
    if ([regex]::IsMatch($tag, '(?i)^blocking$')) { return $false }
    if ([regex]::IsMatch($tag, '(?i)^(low|minor|nit|nitpick|optional|info|informational|advisory|suggestion)$')) { return $true }
    return $false
  }
  if ($SubSection -eq 'non-blocking') { return $true }
  if ($SubSection -eq 'blocking') { return $false }
  if ($IsMerge) { return $true }
  return $false
}

function Format-ReviewForPost {
  param([string]$Review, $Verdict = $null)
  $mergeNote = 'Merge as is; the notes below are optional.'
  $detailsOpen = '<details><summary>Non-blocking notes (optional, do not fix before merge)</summary>'
  $isMerge = $false
  $verdictNonBlocking = New-Object Collections.Generic.List[string]
  if ($null -ne $Verdict) {
    $recValue = Get-ObjectProperty $Verdict 'recommendation'
    if ($null -ne $recValue -and ([string]$recValue).Trim().ToLowerInvariant() -eq 'merge') {
      $isMerge = $true
    }
    $nbValue = Get-ObjectProperty $Verdict 'nonBlocking'
    if ($null -ne $nbValue) {
      foreach ($note in @($nbValue)) {
        $noteText = ([string]$note).Trim()
        if ($noteText) { $null = $verdictNonBlocking.Add($noteText) }
      }
    }
  }

  $normalized = ($Review.TrimEnd() -replace "`r`n", "`n") -replace "`r", "`n"
  $rawLines = @($normalized -split "`n")
  $preamble = New-Object Collections.Generic.List[string]
  $sections = New-Object Collections.Generic.List[object]
  $currentSection = $null
  $inFence = $false

  foreach ($line in $rawLines) {
    if ([regex]::IsMatch($line, '^\s*\x60{3}')) {
      $inFence = -not $inFence
    }
    if (-not $inFence -and [regex]::IsMatch($line, '^##\s+\S')) {
      $title = [regex]::Replace($line, '^##\s+', '').Trim()
      $bodyLines = New-Object Collections.Generic.List[string]
      $currentSection = [pscustomobject]@{
        heading = $line
        title = $title
        lines = $bodyLines
      }
      $null = $sections.Add($currentSection)
    } elseif ($null -eq $currentSection) {
      $null = $preamble.Add($line)
    } else {
      $null = $currentSection.lines.Add($line)
    }
  }

  $hasVerdictSection = $false
  $hasFindingsSection = $false
  $sectionArray = $sections.ToArray()
  for ($s = 0; $s -lt $sectionArray.Count; $s++) {
    $sec = $sectionArray[$s]
    $isLastSection = ($s -eq ($sectionArray.Count - 1))
    $titleKey = $sec.title.ToLowerInvariant()

    if ($titleKey -eq 'verdict') {
      $hasVerdictSection = $true
      if ($isMerge) {
        $secLines = $sec.lines.ToArray()
        $alreadyHasNote = $false
        foreach ($l in $secLines) {
          if ($l.Trim() -eq $mergeNote) { $alreadyHasNote = $true; break }
        }
        if (-not $alreadyHasNote) {
          $lastNonBlank = -1
          for ($i = $secLines.Count - 1; $i -ge 0; $i--) {
            if (-not [string]::IsNullOrWhiteSpace($secLines[$i])) {
              $lastNonBlank = $i
              break
            }
          }
          $updatedVerdict = New-Object Collections.Generic.List[string]
          for ($i = 0; $i -le $lastNonBlank; $i++) {
            $null = $updatedVerdict.Add($secLines[$i])
          }
          $null = $updatedVerdict.Add('')
          $null = $updatedVerdict.Add($mergeNote)
          if (-not $isLastSection) {
            $null = $updatedVerdict.Add('')
          }
          $sec.lines = $updatedVerdict
        }
      }
    } elseif ($titleKey -eq 'code findings') {
      $hasFindingsSection = $true
      $secLines = $sec.lines.ToArray()
      $proseLines = New-Object Collections.Generic.List[string]
      $blockingItems = New-Object Collections.Generic.List[string]
      $nonBlockingItems = New-Object Collections.Generic.List[string]
      $pendingBlanks = New-Object Collections.Generic.List[string]
      $currentItem = $null
      $currentIsNonBlocking = $false
      $subSection = ''
      $sawNone = $false
      $noneText = 'none'
      $inFindingsFence = $false

      foreach ($l in $secLines) {
        if ([regex]::IsMatch($l, '^\s*\x60{3}')) {
          $inFindingsFence = -not $inFindingsFence
          if ($null -ne $currentItem) {
            foreach ($b in $pendingBlanks.ToArray()) { $null = $currentItem.Add($b) }
            $pendingBlanks.Clear()
            $null = $currentItem.Add($l)
          } else {
            $null = $proseLines.Add($l)
          }
          continue
        }
        if ($inFindingsFence) {
          if ($null -ne $currentItem) {
            $null = $currentItem.Add($l)
          } else {
            $null = $proseLines.Add($l)
          }
          continue
        }
        if ([string]::IsNullOrWhiteSpace($l)) {
          if ($null -ne $currentItem) {
            $null = $pendingBlanks.Add($l)
          } elseif ($proseLines.Count -gt 0) {
            $null = $proseLines.Add($l)
          }
          continue
        }
        if ([regex]::IsMatch($l, '^#{3,}\s+')) {
          if ($null -ne $currentItem) {
            $entry = ($currentItem.ToArray()) -join "`n"
            if ($currentIsNonBlocking) { $null = $nonBlockingItems.Add($entry) } else { $null = $blockingItems.Add($entry) }
            $currentItem = $null
            $pendingBlanks.Clear()
          }
          if ([regex]::IsMatch($l, '(?i)^#{3,}\s+.*non[-\s]?blocking')) {
            $subSection = 'non-blocking'
          } elseif ([regex]::IsMatch($l, '(?i)^#{3,}\s+.*blocking')) {
            $subSection = 'blocking'
          } else {
            $subSection = ''
            $null = $proseLines.Add($l)
          }
          continue
        }
        if ([regex]::IsMatch($l, '^[-*]\s+')) {
          if ($null -ne $currentItem) {
            $entry = ($currentItem.ToArray()) -join "`n"
            if ($currentIsNonBlocking) { $null = $nonBlockingItems.Add($entry) } else { $null = $blockingItems.Add($entry) }
            $currentItem = $null
            $pendingBlanks.Clear()
          }
          if ([regex]::IsMatch($l, '(?i)^[-*]\s+none\.?\s*$')) {
            $sawNone = $true
            continue
          }
          $currentItem = New-Object Collections.Generic.List[string]
          $null = $currentItem.Add($l)
          $currentIsNonBlocking = Test-NonBlockingFindingLine $l $subSection $isMerge
          continue
        }
        if ($null -ne $currentItem -and [regex]::IsMatch($l, '^\s+\S')) {
          foreach ($b in $pendingBlanks.ToArray()) { $null = $currentItem.Add($b) }
          $pendingBlanks.Clear()
          $null = $currentItem.Add($l)
          continue
        }
        if ($null -eq $currentItem -and [regex]::IsMatch($l, '^\s+[-*]\s+')) {
          if ([regex]::IsMatch($l, '(?i)^\s+[-*]\s+none\.?\s*$')) {
            $sawNone = $true
            continue
          }
          $currentItem = New-Object Collections.Generic.List[string]
          $null = $currentItem.Add($l.TrimStart())
          $currentIsNonBlocking = Test-NonBlockingFindingLine $l $subSection $isMerge
          continue
        }
        if ($null -ne $currentItem) {
          $entry = ($currentItem.ToArray()) -join "`n"
          if ($currentIsNonBlocking) { $null = $nonBlockingItems.Add($entry) } else { $null = $blockingItems.Add($entry) }
          $currentItem = $null
          $pendingBlanks.Clear()
        }
        if ([regex]::IsMatch($l, '(?i)^\s*(?:none|no\s+(?:code\s+)?findings)\.?\s*$')) {
          $sawNone = $true
          $noneText = $l.Trim()
          continue
        }
        $null = $proseLines.Add($l)
      }
      if ($null -ne $currentItem) {
        $entry = ($currentItem.ToArray()) -join "`n"
        if ($currentIsNonBlocking) { $null = $nonBlockingItems.Add($entry) } else { $null = $blockingItems.Add($entry) }
        $currentItem = $null
        $pendingBlanks.Clear()
      }

      if ($nonBlockingItems.Count -eq 0 -and $verdictNonBlocking.Count -gt 0) {
        foreach ($note in $verdictNonBlocking.ToArray()) {
          $null = $nonBlockingItems.Add('- ' + $note)
        }
      }

      while ($proseLines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($proseLines[$proseLines.Count - 1])) {
        $proseLines.RemoveAt($proseLines.Count - 1)
      }

      $updatedFindings = New-Object Collections.Generic.List[string]
      $null = $updatedFindings.Add('')
      if ($proseLines.Count -gt 0) {
        foreach ($pl in $proseLines.ToArray()) { $null = $updatedFindings.Add($pl) }
      }
      if ($blockingItems.Count -gt 0) {
        if ($proseLines.Count -gt 0) { $null = $updatedFindings.Add('') }
        foreach ($item in $blockingItems.ToArray()) {
          foreach ($il in @($item -split "`n")) { $null = $updatedFindings.Add($il) }
        }
      }
      if ($nonBlockingItems.Count -gt 0) {
        if ($proseLines.Count -gt 0 -or $blockingItems.Count -gt 0) { $null = $updatedFindings.Add('') }
        $null = $updatedFindings.Add($detailsOpen)
        $null = $updatedFindings.Add('')
        foreach ($item in $nonBlockingItems.ToArray()) {
          foreach ($il in @($item -split "`n")) { $null = $updatedFindings.Add($il) }
        }
        $null = $updatedFindings.Add('')
        $null = $updatedFindings.Add('</details>')
      }
      if ($proseLines.Count -eq 0 -and $blockingItems.Count -eq 0 -and $nonBlockingItems.Count -eq 0) {
        if ($sawNone) {
          $null = $updatedFindings.Add($noneText)
        } else {
          $null = $updatedFindings.Add('none')
        }
      }
      if (-not $isLastSection) {
        $null = $updatedFindings.Add('')
      }
      $sec.lines = $updatedFindings
    }
  }

  $outLines = New-Object Collections.Generic.List[string]
  if ($isMerge -and -not $hasVerdictSection) {
    $null = $outLines.Add($mergeNote)
    $null = $outLines.Add('')
  }
  foreach ($pl in $preamble.ToArray()) { $null = $outLines.Add($pl) }
  foreach ($sec in $sectionArray) {
    $null = $outLines.Add($sec.heading)
    foreach ($sl in $sec.lines.ToArray()) { $null = $outLines.Add($sl) }
  }
  if (-not $hasFindingsSection -and $verdictNonBlocking.Count -gt 0) {
    if ($outLines.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($outLines[$outLines.Count - 1])) {
      $null = $outLines.Add('')
    }
    $null = $outLines.Add($detailsOpen)
    $null = $outLines.Add('')
    foreach ($note in $verdictNonBlocking.ToArray()) {
      $null = $outLines.Add('- ' + $note)
    }
    $null = $outLines.Add('')
    $null = $outLines.Add('</details>')
  }

  return (($outLines.ToArray()) -join "`n").TrimEnd()
}

function Build-PostBody {
  param([string]$Path, [string]$Sha7, [string]$Review, [string]$ChecksSummary, $Verdict = $null)
  $header = '> Automated review by a coding agent (Devin CLI) on a Windows test machine, for head ' + $Sha7 +
    '. Agent self-tested; not a maintainer approval; the maintainers and the product owner decide on merging.'
  $formattedReview = Format-ReviewForPost $Review $Verdict
  $body = $header + "`n`n" + $formattedReview + "`n`n" +
    '<details><summary>Check results (standard-account run)</summary>' + "`n`n" +
    $ChecksSummary.TrimEnd() + "`n`n</details>`n"
  Write-Text $Path $body
}

function Invoke-Devin {
  param([string]$RunDir, [string]$Worktree, [string]$PromptPath, [string]$LogPath)
  $inner = (Quote-Argument $script:DevinPath) + ' --model ' + $DevinModel +
    ' --permission-mode accept-edits --respect-workspace-trust false --prompt-file ' + (Quote-Argument $PromptPath) +
    ' -p > ' + (Quote-Argument $LogPath) + ' 2>&1'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $process = $null
  try {
    # The run dir is the agent's workspace: accept-edits lets it write review.md there,
    # while command execution still needs an approval that print mode never grants.
    $process = Start-Process -FilePath $script:CmdExe -ArgumentList ('/d /c "' + $inner + '"') `
      -WorkingDirectory $RunDir -PassThru -WindowStyle Hidden
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not $process) { throw 'Could not start the Devin CLI.' }
  # The 45-minute cap also covers the agent's own retries; taskkill ends the whole tree.
  if (-not $process.WaitForExit(2700000)) {
    $null = Invoke-Tool (Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe') ('/T /F /PID ' + $process.Id) `
      (Join-Path $RunDir 'devin-kill.out.log') (Join-Path $RunDir 'devin-kill.err.log')
    return 'timeout'
  }
  return ('exitCode ' + $process.ExitCode)
}

function Remove-OldRuns {
  param([string]$RunsDir)
  $failed = @()
  $cutoff = (Get-Date).AddDays(-30)
  foreach ($old in @(Get-ChildItem -LiteralPath $RunsDir -Directory -ErrorAction SilentlyContinue)) {
    if ($old.LastWriteTime -ge $cutoff) { continue }
    try { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction Stop } catch {
      if (Test-Path -LiteralPath $old.FullName) { $failed += ('cannot delete old run ' + $old.Name) }
    }
  }
  return $failed
}

$reviewedOut = @()
$skippedOut = @()
$errorsOut = @()
$lock = $null
$WorkRoot = $null
$ok = $true

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Root)) { throw '-Root is required.' }
  if ([string]::IsNullOrWhiteSpace($Checkout)) { throw '-Checkout is required.' }
  if ([string]::IsNullOrWhiteSpace($StandardCredentialFile)) { throw '-StandardCredentialFile is required.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw '-Repo must be owner/name.' }
  if ($Force -and $PrNumber -le 0) { throw '-Force requires -PrNumber.' }

  $WorkRoot = Get-AcceptancePath $Root
  Assert-OutsideGitCheckout $WorkRoot
  [IO.Directory]::CreateDirectory($WorkRoot) | Out-Null
  $script:WorkRoot = $WorkRoot

  # One pass at a time per PR (or globally for polling runs without -PrNumber).
  # A conflicting start writes a skipped summary and leaves the active run alone.
  $lockName = 'lock'
  if ($PrNumber -gt 0) { $lockName = 'lock-pr-' + $PrNumber }
  try {
    $lock = [IO.File]::Open((Join-Path $WorkRoot $lockName), [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    $skippedOut += [ordered]@{ pr = $null; reason = 'another run holds the lock' }
    $ok = $true
  }

  if ($lock) {
    $resolvedBaseCacheRoot = Resolve-BaseCacheRoot $BaseCacheRoot
    $Checkout = Get-AcceptancePath $Checkout
    if (-not (Test-Path -LiteralPath (Join-Path $Checkout '.git'))) { throw '-Checkout must be the root of a git clone.' }
    $standardPath = Get-AcceptancePath $script:StandardScript
    if (-not (Test-Path -LiteralPath $standardPath -PathType Leaf)) { throw 'Invoke-AsStandardUser.ps1 is missing; keep scripts\pr-review next to scripts\windows-acceptance.' }
    if (-not (Test-Path -LiteralPath $script:RunChecks -PathType Leaf)) { throw 'run-checks.cmd is missing.' }
    $script:RunChecks = Get-AcceptancePath $script:RunChecks
    if ($script:RunChecks.Contains('%') -or $script:RunChecks.Contains('"') -or $script:RunChecks.Contains("`r") -or $script:RunChecks.Contains("`n")) {
      throw 'run-checks.cmd path cannot contain percent signs, quotes or newlines.'
    }
    $referencePath = $null
    if ($Reference) {
      $referencePath = Get-AcceptancePath $Reference
      if (-not (Test-Path -LiteralPath $referencePath -PathType Container)) { throw '-Reference must be an existing directory.' }
    }

    if ($TokenFile) {
      # Machine-scope DPAPI: the scheduled task has no user key material, and the file ACL is the boundary.
      Add-Type -AssemblyName System.Security
      $stored = Read-Text (Get-AcceptancePath $TokenFile)
      if ([string]::IsNullOrWhiteSpace($stored)) { throw '-TokenFile is empty.' }
      $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
        [Convert]::FromBase64String([string](($stored | ConvertFrom-Json).token)),
        $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
      $env:GH_TOKEN = [Text.Encoding]::UTF8.GetString($bytes)
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
    # A hidden task must never wait for an interactive gh prompt.
    $env:GH_PROMPT_DISABLED = '1'
    $env:GH_NO_UPDATE_NOTIFIER = '1'

    $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { throw 'git was not found on PATH.' }
    $script:GitPath = $git.Source
    $gh = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { throw 'GitHub CLI (gh) was not found on PATH.' }
    $script:GhPath = $gh.Source
    $devin = Get-Command -Name 'devin' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $devin) { throw 'Devin CLI was not found on PATH; install it and sign in as the operating account.' }
    $script:DevinPath = $devin.Source

    $statePath = Join-Path $WorkRoot 'state.json'
    $state = Invoke-WithStateLock {
      $loaded = Read-State $statePath
      Save-State $statePath $loaded
      return $loaded
    }

    $listPath = Join-Path $WorkRoot ('.pr-list.' + $script:RunInstanceId + '.json')
    $listErrPath = Join-Path $WorkRoot ('.pr-list.' + $script:RunInstanceId + '.err.json')
    $pulls = @()
    try {
      $listCode = Invoke-Gh ('pr list -R ' + $Repo + ' --state open --limit 1000 --json number,headRefOid,isDraft,author,title,baseRefName') `
        $listPath $listErrPath
      if ($listCode -ne 0) { throw ('gh pr list failed: ' + (Get-Tail $listErrPath 5)) }
      # Windows PowerShell 5.1 emits a JSON array as one Object[]; unroll it.
      $pulls = @((Read-Text $listPath) | ConvertFrom-Json | ForEach-Object { $_ })
    } finally {
      Remove-Item -LiteralPath $listPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $listErrPath -Force -ErrorAction SilentlyContinue
    }

    $targets = @()
    foreach ($pull in $pulls) {
      $number = [int]$pull.number
      if ($PrNumber -gt 0 -and $number -ne $PrNumber) { continue }
      if ([string]$pull.baseRefName -ne 'main') {
        $skippedOut += [ordered]@{ pr = $number; reason = 'base is ' + $pull.baseRefName + ', not main' }
        continue
      }
      $sha = [string]$pull.headRefOid
      if ([string]::IsNullOrWhiteSpace($sha)) {
        $skippedOut += [ordered]@{ pr = $number; reason = 'no head SHA in gh output' }
        continue
      }
      $entry = Get-StateEntry $state ([string]$number)
      # -PrNumber and -Force both re-review a head already recorded as reviewed; the attempts limit below still applies.
      if ($PrNumber -eq 0 -and -not $Force -and ($entry.reviewed -contains $sha)) {
        $skippedOut += [ordered]@{ pr = $number; reason = 'head ' + $sha.Substring(0, 7) + ' already reviewed' }
        continue
      }
      $attempts = 0
      if ($entry.attempts.ContainsKey($sha)) { $attempts = [int]$entry.attempts[$sha] }
      if ($attempts -ge 3) {
        $skippedOut += [ordered]@{ pr = $number; reason = 'head ' + $sha.Substring(0, 7) + ' attempted ' + $attempts + ' times' }
        continue
      }
      $targets += $pull
    }

    $targets = @($targets | Sort-Object { [int]$_.number } | Select-Object -First $MaxPerRun)
    $runsDir = Join-Path $WorkRoot 'runs'
    [IO.Directory]::CreateDirectory($runsDir) | Out-Null
    $standardSid = $null
    foreach ($pull in $targets) {
      $number = [int]$pull.number
      $sha = [string]$pull.headRefOid
      $sha7 = $sha.Substring(0, 7)
      $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
      $runDir = Join-Path $runsDir ("pr-$number-$sha7-$stamp")
      if (Test-Path -LiteralPath $runDir) {
        $runDir = $runDir + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 4)
      }
      $gatePath = Join-Path $runDir 'gate.json'
      [IO.Directory]::CreateDirectory($runDir) | Out-Null
      $worktrees = @()
      $prTree = $null
      try {
        $fetch = Invoke-WithGitLock {
          Invoke-Git ('fetch origin main +refs/pull/' + $number + '/head:refs/remotes/origin/pr-' + $number)
        }
        if ($fetch.exitCode -ne 0) { throw ('git fetch failed: ' + $fetch.error) }
        $fetched = (Invoke-Git ('rev-parse refs/remotes/origin/pr-' + $number)).text
        if ($fetched) { $fetched = $fetched.Trim() }
        if ($fetched -ne $sha) {
          $skippedOut += [ordered]@{ pr = $number; reason = 'fetched ' + ([string]$fetched) + ' but GitHub reports head ' + $sha }
          continue
        }
        $mergeBase = (Invoke-Git ('merge-base origin/main ' + $sha)).text
        if ($mergeBase) { $mergeBase = $mergeBase.Trim() }
        if (-not $mergeBase) { throw ('no merge-base with origin/main for ' + $sha) }

        # Only <run>\sandbox is writable by the standard account. Review inputs, wrappers,
        # copied results and the agent's output stay in the operator-only run dir.
        $sandbox = Join-Path $runDir 'sandbox'
        $binDir = Join-Path $runDir 'bin'
        [IO.Directory]::CreateDirectory($sandbox) | Out-Null
        [IO.Directory]::CreateDirectory($binDir) | Out-Null
        $prTree = Join-Path $sandbox ('pr-' + $number + '-' + $script:RunInstanceId)
        $baseTree = Join-Path $sandbox ('base-' + $number + '-' + $script:RunInstanceId)
        $addPr = Invoke-WithGitLock {
          Invoke-Git ('worktree add --detach ' + (Quote-Argument $prTree) + ' ' + $sha)
        }
        if ($addPr.exitCode -ne 0) { throw ('git worktree add (pr) failed: ' + $addPr.error) }
        $worktrees += $prTree

        $changedFiles = @(Get-PrChangedFilesForReview $mergeBase $sha | Where-Object { $_ })
        $skipE2e = Test-DocsOrTestsOnlyFiles $changedFiles

        $diffOut = Join-Path $runDir 'diff.patch'
        $diffErr = Join-Path $runDir 'diff.err.log'
        $null = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Checkout) + ' diff ' + $mergeBase + ' ' + $sha) $diffOut $diffErr
        $statOut = Join-Path $runDir 'diff.stat.txt'
        $null = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Checkout) + ' diff --stat ' + $mergeBase + ' ' + $sha) $statOut (Join-Path $runDir 'diff-stat.err.log')

        $prJson = Join-Path $runDir 'pr.json'
        $viewCode = Invoke-Gh ('pr view ' + $number + ' -R ' + $Repo + ' --json title,body,author,files,commits,isDraft') `
          $prJson (Join-Path $runDir 'pr-view.err.log')
        if ($viewCode -ne 0) { throw ('gh pr view failed: ' + (Get-Tail (Join-Path $runDir 'pr-view.err.log') 5)) }

        # Record the attempt before any agent work, so a crash still counts against this head.
        $null = Invoke-WithStateLock {
          $freshState = Read-State $statePath
          $entry = Get-StateEntry $freshState ([string]$number)
          $previousAttempts = 0
          if ($entry.attempts.ContainsKey($sha)) { $previousAttempts = [int]$entry.attempts[$sha] }
          $entry.attempts[$sha] = $previousAttempts + 1
          Save-State $statePath $freshState
        }

        if (-not $standardSid) { $standardSid = Resolve-StandardAccountSid $StandardCredentialFile }
        $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $icacls = Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe'
        $lockCode = Invoke-Tool $icacls ((Quote-Argument $runDir) + ' /inheritance:r /grant:r "*' + $operatorSid + ':(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"') `
          (Join-Path $runDir 'acl-run.out.log') (Join-Path $runDir 'acl-run.err.log')
        if ($lockCode -ne 0) { throw ('icacls could not restrict the run directory: ' + (Get-Tail (Join-Path $runDir 'acl-run.err.log') 5)) }
        # Tools such as esbuild list parent directories, so the standard account may list the run
        # dir itself (no inheritance: it still cannot open the files in it).
        $listCode = Invoke-Tool $icacls ((Quote-Argument $runDir) + ' /grant "*' + $standardSid + ':(RX)"') `
          (Join-Path $runDir 'acl-list.out.log') (Join-Path $runDir 'acl-list.err.log')
        if ($listCode -ne 0) { throw ('icacls could not let the standard account list the run directory: ' + (Get-Tail (Join-Path $runDir 'acl-list.err.log') 5)) }
        $binAclCode = Invoke-Tool $icacls ((Quote-Argument $binDir) + ' /grant "*' + $standardSid + ':(OI)(CI)RX"') `
          (Join-Path $runDir 'acl-bin.out.log') (Join-Path $runDir 'acl-bin.err.log')
        if ($binAclCode -ne 0) { throw ('icacls could not grant the standard account Read/Execute on the run bin directory: ' + (Get-Tail (Join-Path $runDir 'acl-bin.err.log') 5)) }
        $aclCode = Invoke-Tool $icacls `
          ((Quote-Argument $sandbox) + ' /grant "*' + $standardSid + ':(OI)(CI)M"') `
          (Join-Path $runDir 'acl.out.log') (Join-Path $runDir 'acl.err.log')
        if ($aclCode -ne 0) { throw ('icacls could not grant the standard account Modify on the run directory: ' + (Get-Tail (Join-Path $runDir 'acl.err.log') 5)) }

        $checksBase = Join-Path $sandbox 'checks-base'
        $checksPr = Join-Path $sandbox 'checks-pr'
        $resultsBase = Join-Path $runDir 'results-base'
        $resultsPr = Join-Path $runDir 'results-pr'
        $checksBaseOut = Join-Path $runDir 'checks-base'

        $baseCacheHit = Restore-BaseCache $resolvedBaseCacheRoot $mergeBase $runDir $skipE2e
        if ($baseCacheHit) {
          $mergeBase7 = $mergeBase
          if ($mergeBase7.Length -ge 7) { $mergeBase7 = $mergeBase7.Substring(0, 7) }
          [Console]::Error.WriteLine('base cache hit ' + $mergeBase7)
          $standardBase = [pscustomobject]@{
            exitCode = 0
            summaryLine = $null
            stdoutPath = (Join-Path $runDir 'standard-base.out.log')
            stderrPath = (Join-Path $runDir 'standard-base.err.log')
            summary = $null
          }
        } else {
          $addBase = Invoke-WithGitLock {
            Invoke-Git ('worktree add --detach ' + (Quote-Argument $baseTree) + ' ' + $mergeBase)
          }
          if ($addBase.exitCode -ne 0) { throw ('git worktree add (base) failed: ' + $addBase.error) }
          $worktrees += $baseTree
          # Base runs first and its results are copied out before any PR code runs.
          $standardBase = Invoke-WithUntrustedChecksLock {
            $r = Invoke-StandardChecks 'base' $checksBase (Join-Path $sandbox 'results-base') $baseTree $runDir $binDir $skipE2e
            Copy-RunOutput (Join-Path $sandbox 'results-base') $resultsBase | Out-Null
            Copy-RunOutput $checksBase $checksBaseOut | Out-Null
            $r
          }
        }
        $standardBase.summary = Get-StandardSummary $checksBaseOut
        $stepsBase = Get-Steps (Join-Path $resultsBase 'steps.json')
        $reportBase = Get-VitestReport (Join-Path $resultsBase 'vitest.json') $baseTree
        $baseE2eSkipped = [bool]($stepsBase -and $stepsBase.PSObject.Properties['e2eSkipped'] -and $stepsBase.e2eSkipped -eq $true)
        if (-not $baseCacheHit -and (Test-BaseSummaryReliable $standardBase.summary) -and $null -ne $stepsBase -and
            (Test-BaseStepsReliable $stepsBase $baseE2eSkipped) -and $null -ne $reportBase -and $reportBase.map.Count -gt 0) {
          Publish-BaseCache $resolvedBaseCacheRoot $mergeBase $resultsBase $checksBaseOut 20 $baseE2eSkipped
        }

        $standardPr = Invoke-WithUntrustedChecksLock {
          $r = Invoke-StandardChecks 'pr' $checksPr (Join-Path $sandbox 'results-pr') $prTree $runDir $binDir $skipE2e
          Copy-RunOutput (Join-Path $sandbox 'results-pr') $resultsPr | Out-Null
          Copy-RunOutput $checksPr (Join-Path $runDir 'checks-pr') | Out-Null
          $r
        }
        $standardPr.summary = Get-StandardSummary (Join-Path $runDir 'checks-pr')

        $stepsPr = Get-Steps (Join-Path $resultsPr 'steps.json')
        $reportPr = Get-VitestReport (Join-Path $resultsPr 'vitest.json') $prTree
        $checksSummaryPath = Join-Path $runDir 'checks-summary.md'
        $comparison = Write-ChecksSummary $checksSummaryPath $runDir 'base' 'pr' $stepsBase $stepsPr $reportBase $reportPr $standardBase $standardPr

        $template = Read-Text $script:PromptTemplate
        if ($null -eq $template) { throw 'review-prompt.md is missing.' }
        $referenceText = 'not available'
        if ($referencePath) { $referenceText = $referencePath }
        $values = @{
          REPO = $Repo; PR = [string]$number; RUN = $runDir
          PR_WORKTREE = $prTree; REFERENCE = $referenceText
        }
        # One pass, so a placeholder-like substring inside a substituted path is never rewritten.
        $prompt = [regex]::Replace($template, '\{\{(REPO|PR|RUN|PR_WORKTREE|REFERENCE)\}\}',
          [Text.RegularExpressions.MatchEvaluator]{ param($match) [string]$values[$match.Groups[1].Value] })
        $promptPath = Join-Path $runDir 'prompt.md'
        Write-Text $promptPath $prompt

        $devinLog = Join-Path $runDir 'devin.log'
        $reviewPath = Join-Path $runDir 'review.md'
        $verdictPath = Join-Path $runDir 'verdict.json'
        foreach ($stale in @($reviewPath, (Join-Path $runDir 'review.zh.md'), $verdictPath)) { Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue }
        $agentStart = [DateTime]::UtcNow
        $devinResult = Invoke-Devin $runDir $prTree $promptPath $devinLog

        # A timed-out or failed agent may leave a partial review; it is never posted and gate.json says reviewOk false.
        $reviewOk = $false
        $reviewText = $null
        $reviewProblem = $null
        if ($devinResult -ne 'exitCode 0') {
          $reviewProblem = 'Devin CLI ' + $devinResult + '; nothing posted'
        } elseif (-not (Test-Path -LiteralPath $reviewPath -PathType Leaf) -or
            (Get-Item -LiteralPath $reviewPath).LastWriteTimeUtc -lt $agentStart) {
          $reviewProblem = 'no fresh review.md was written; nothing posted'
        } else {
          $reviewText = Read-Text $reviewPath
          if ([string]::IsNullOrWhiteSpace($reviewText)) { $reviewProblem = 'no review.md was written; nothing posted' } else { $reviewOk = $true }
        }
        $verdict = $null
        if ($reviewOk) { $verdict = Get-Verdict $verdictPath $agentStart }

        # DryRun is the "do not post" switch: it also leaves the head unrecorded, so a later pass reviews it again.
        $posted = $false
        $postProblem = $null
        if ($reviewOk) {
          $bodyPath = Join-Path $runDir 'post-body.md'
          Build-PostBody $bodyPath $sha7 $reviewText (Read-Text $checksSummaryPath) $verdict
          if (-not $DryRun) {
            $postDelays = @(15, 45, 90)
            $postMaxAttempts = 4
            $postCode = -1
            $postAttempts = 0
            $postErrPath = Join-Path $runDir 'post.err.log'
            for ($postAttempt = 1; $postAttempt -le $postMaxAttempts; $postAttempt++) {
              if ($postAttempt -gt 1) {
                Start-Sleep -Seconds $postDelays[$postAttempt - 2]
              }
              $postSuffix = ''
              if ($postAttempt -gt 1) { $postSuffix = '-' + [string]$postAttempt }
              $postOutPath = Join-Path $runDir ('post' + $postSuffix + '.out.log')
              $postErrPath = Join-Path $runDir ('post' + $postSuffix + '.err.log')
              $postAttempts = $postAttempt
              $postCode = Invoke-Gh ('pr review ' + $number + ' -R ' + $Repo + ' --comment --body-file ' + (Quote-Argument $bodyPath)) `
                $postOutPath $postErrPath
              if ($postCode -eq 0) { break }
            }
            if ($postCode -ne 0) {
              $postProblem = 'gh pr review failed after ' + [string]$postAttempts + ' attempts: ' + (Get-Tail $postErrPath 5)
            } else {
              $posted = $true
              $null = Invoke-WithStateLock {
                $freshState = Read-State $statePath
                $entry = Get-StateEntry $freshState ([string]$number)
                $reviewed = @($entry.reviewed)
                if ($reviewed -notcontains $sha) { $reviewed += $sha }
                $entry.reviewed = $reviewed
                Save-State $statePath $freshState
              }
            }
          }
        }

        $prE2eSkipped = [bool]($stepsPr -and $stepsPr.PSObject.Properties['e2eSkipped'] -and $stepsPr.e2eSkipped -eq $true)
        $gate = [ordered]@{
          prNumber = $number
          headSha = $sha
          baseSha = $mergeBase
          pr = (Get-StepRecord $stepsPr)
          base = (Get-StepRecord $stepsBase)
          e2eSkipped = $prE2eSkipped
          unitComparison = $comparison.comparison
          newFailures = @($comparison.newFailures)
          fixed = @($comparison.fixed)
          absent = @($comparison.absent)
          verdict = $verdict
          reviewOk = $reviewOk
          posted = $posted
        }
        Write-Text $gatePath ((ConvertTo-Json -InputObject $gate -Depth 6) + "`n")

        if ($reviewProblem) {
          $errorsOut += [ordered]@{ pr = $number; error = $reviewProblem; runDir = $runDir; gatePath = $gatePath }
          continue
        }
        if ($postProblem) {
          $errorsOut += [ordered]@{ pr = $number; error = $postProblem; runDir = $runDir; gatePath = $gatePath }
          continue
        }
        $reviewedOut += [ordered]@{ pr = $number; sha = $sha; posted = $posted; runDir = $runDir; gatePath = $gatePath }
      } catch {
        $failure = [ordered]@{ pr = $number; error = $_.Exception.Message; runDir = $runDir }
        if (Test-Path -LiteralPath $gatePath -PathType Leaf) { $failure['gatePath'] = $gatePath }
        $errorsOut += $failure
      } finally {
        if ($script:GitPath -and $worktrees.Count -gt 0) {
          $null = Invoke-WithGitLock {
            foreach ($tree in $worktrees) { $null = Invoke-Git ('worktree remove --force ' + (Quote-Argument $tree)) }
            $null = Invoke-Git 'worktree prune'
          }
        }
      }
    }
  }
} catch {
  $ok = $false
  $errorsOut += [ordered]@{ pr = $null; error = $_.Exception.Message }
} finally {
  if ($lock -and $WorkRoot -and (Test-Path -LiteralPath (Join-Path $WorkRoot 'runs'))) {
    foreach ($retentionError in (Remove-OldRuns (Join-Path $WorkRoot 'runs'))) {
      $errorsOut += [ordered]@{ pr = $null; error = $retentionError }
    }
  }
  if ($lock) { $lock.Dispose() }
}

$summary = [ordered]@{
  ok = ($ok -and $errorsOut.Count -eq 0)
  reviewed = $reviewedOut
  skipped = $skippedOut
  errors = $errorsOut
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
$lastRunTarget = $null
if ($WorkRoot -and (Test-Path -LiteralPath $WorkRoot)) {
  $lastRunTarget = Join-Path $WorkRoot 'last-run.json'
} elseif ($Root) {
  try {
    $fallback = Get-AcceptancePath $Root
    [IO.Directory]::CreateDirectory($fallback) | Out-Null
    $lastRunTarget = Join-Path $fallback 'last-run.json'
  } catch { }
}
if ($lastRunTarget) {
  $lastRunTmp = $lastRunTarget + '.' + $script:RunInstanceId + '.tmp'
  try {
    Write-Text $lastRunTmp ($json + "`n")
    if (Test-Path -LiteralPath $lastRunTarget -PathType Leaf) {
      [IO.File]::Replace($lastRunTmp, $lastRunTarget, [NullString]::Value)
    } else {
      [IO.File]::Move($lastRunTmp, $lastRunTarget)
    }
  } catch {
    try { Write-Text $lastRunTarget ($json + "`n") } catch { }
  } finally {
    Remove-Item -LiteralPath $lastRunTmp -Force -ErrorAction SilentlyContinue
  }
}
[Console]::Out.WriteLine($json)
# Per-PR failures are recorded in errors; only a run-level failure is a nonzero exit.
if ($ok) { exit 0 }
exit 1
